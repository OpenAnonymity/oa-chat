package zkapi

import (
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"

	"github.com/ethereum/go-ethereum/core/types"
	"github.com/ethereum/go-ethereum/crypto"
)

// This file is local custody material, separate from both the inference API
// credential and the companion's private-note recovery file. Back up both.
type addressFundingRecord struct {
	Version    int                      `json:"version"`
	ChainID    uint64                   `json:"chain_id"`
	Contract   string                   `json:"contract_address"`
	Token      string                   `json:"token_address"`
	Address    string                   `json:"address"`
	PrivateKey string                   `json:"private_key"`
	Amount     uint64                   `json:"amount,omitempty"`
	Commitment string                   `json:"commitment,omitempty"`
	Phase      string                   `json:"phase"`
	Pending    *addressTransaction      `json:"pending,omitempty"`
	History    []addressTransaction     `json:"history,omitempty"`
	Withdrawal *addressWithdrawalRecord `json:"withdrawal,omitempty"`
}

type addressTransaction struct {
	Kind            string `json:"kind"`
	Raw             string `json:"raw"`
	Hash            string `json:"hash"`
	Nonce           uint64 `json:"nonce"`
	FinalizedRevert bool   `json:"finalized_revert,omitempty"`
}

func (h *FundingHandler) addressStatePath() string {
	return filepath.Join(filepath.Dir(h.statePath), "address-funding.json")
}

func (h *FundingHandler) loadAddress(config fundingConfig) (*addressFundingRecord, error) {
	path := h.addressStatePath()
	info, err := os.Lstat(path)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return nil, errors.New("cannot read the local payment address; preserve its recovery file")
	}
	if err == nil && (!info.Mode().IsRegular() || info.Mode().Perm() != 0600) {
		return nil, errors.New("payment address recovery file must be a regular private mode-0600 file")
	}
	if errors.Is(err, os.ErrNotExist) {
		key, err := crypto.GenerateKey()
		if err != nil {
			return nil, errors.New("cannot generate the local payment address")
		}
		record := &addressFundingRecord{
			Version: 1, ChainID: config.ChainID, Contract: config.Contract, Token: config.Token,
			Address: crypto.PubkeyToAddress(key.PublicKey).Hex(), PrivateKey: hex.EncodeToString(crypto.FromECDSA(key)), Phase: "ready",
		}
		// Never expose an address that has not survived fsync plus atomic rename.
		if err := h.saveAddress(record); err != nil {
			return nil, err
		}
		return record, nil
	}
	raw, err := os.ReadFile(path)
	if err != nil || len(raw) > 8<<20 {
		return nil, errors.New("cannot read the local payment address; preserve its recovery file")
	}
	var record addressFundingRecord
	if json.Unmarshal(raw, &record) != nil || record.Version != 1 {
		return nil, errors.New("payment address recovery data is invalid; preserve the file")
	}
	key, err := crypto.HexToECDSA(record.PrivateKey)
	if err != nil || !strings.EqualFold(crypto.PubkeyToAddress(key.PublicKey).Hex(), record.Address) {
		return nil, errors.New("payment address recovery key is invalid; preserve the file")
	}
	if record.ChainID != config.ChainID || !strings.EqualFold(record.Contract, config.Contract) || !strings.EqualFold(record.Token, config.Token) {
		return nil, errors.New("payment address belongs to another deployment; preserve its recovery file")
	}
	if record.Pending != nil && record.Pending.FinalizedRevert {
		return nil, errors.New("pending payment is incorrectly marked as retired; preserve the recovery file")
	}
	for _, entry := range append(append([]addressTransaction{}, record.History...), pendingAddressTransaction(record.Pending)...) {
		encoded, decodeErr := hex.DecodeString(strings.TrimPrefix(entry.Raw, "0x"))
		var tx types.Transaction
		if decodeErr != nil || tx.UnmarshalBinary(encoded) != nil || !strings.EqualFold(tx.Hash().Hex(), entry.Hash) || tx.Nonce() != entry.Nonce || !tx.ChainId().IsUint64() || tx.ChainId().Uint64() != config.ChainID {
			return nil, errors.New("payment transaction recovery data is invalid; preserve the file")
		}
		from, senderErr := types.Sender(types.NewEIP155Signer(tx.ChainId()), &tx)
		if senderErr != nil || !strings.EqualFold(from.Hex(), record.Address) || tx.Value().Sign() != 0 || tx.To() == nil || (entry.Kind != "deposit" && entry.Kind != "approval" && entry.Kind != "approval_reset" && entry.Kind != "withdrawal") {
			return nil, errors.New("payment transaction recovery signature is invalid; preserve the file")
		}
		expected := config.Token
		if entry.Kind == "deposit" || entry.Kind == "withdrawal" {
			expected = config.Contract
		}
		if !strings.EqualFold(tx.To().Hex(), expected) {
			return nil, errors.New("payment transaction recovery destination is invalid; preserve the file")
		}
		if entry.Kind == "withdrawal" && (len(tx.Data()) != 4+56*32 || hex.EncodeToString(tx.Data()[:4]) != withdrawalSelector) {
			return nil, errors.New("withdrawal transaction recovery call is invalid; preserve the file")
		}
		if entry.Kind == "withdrawal" {
			pending := record.Pending != nil && strings.EqualFold(entry.Hash, record.Pending.Hash)
			if pending && (record.Withdrawal == nil || !strings.EqualFold(entry.Hash, record.Withdrawal.TransactionHash) || record.Withdrawal.Phase == "complete") {
				return nil, errors.New("pending withdrawal authorization is invalid; preserve the file")
			}
			if pending || (record.Withdrawal != nil && strings.EqualFold(entry.Hash, record.Withdrawal.TransactionHash)) {
				if err := validateSignedWithdrawal(tx.Data(), config, record.Withdrawal); err != nil {
					return nil, err
				}
			}
		}
	}
	if w := record.Withdrawal; w != nil {
		if _, err := NormalizeWithdrawalDestination(w.Destination); err != nil || w.NoteID > 0xffffffff || (w.Binding != "" && (!isHex(w.Binding, 32) || !isHex(w.Nullifier, 32))) {
			return nil, errors.New("withdrawal recovery data is invalid; preserve the file")
		}
		switch w.Phase {
		case "withdrawal_pending", "waiting_settlement", "waiting_funds", "confirming", "reverted", "complete":
		default:
			return nil, errors.New("withdrawal recovery phase is invalid; preserve the file")
		}
		if w.Phase == "complete" && (!isHex(w.TransactionHash, 32) || w.Binding == "") {
			return nil, errors.New("completed withdrawal recovery data is invalid; preserve the file")
		}
		if w.SettlementHash != "" {
			if !isHex(w.SettlementHash, 32) || !isHex(w.TransactionHash, 32) || strings.EqualFold(w.SettlementHash, w.TransactionHash) || w.Binding == "" || (w.Phase != "confirming" && w.Phase != "complete") {
				return nil, errors.New("alternate withdrawal settlement is invalid; preserve the file")
			}
			if w.Phase == "confirming" && (record.Pending == nil || record.Pending.Kind != "withdrawal" || !strings.EqualFold(record.Pending.Hash, w.TransactionHash)) {
				return nil, errors.New("alternate withdrawal settlement lost its signed intent; preserve the file")
			}
		}
		if w.Phase == "complete" {
			found := false
			for _, entry := range record.History {
				// A relayer's finalized payout permits retiring the original
				// signed nonce only after its own canonical finalized failure.
				if entry.Kind == "withdrawal" && entry.FinalizedRevert == (w.SettlementHash != "") && strings.EqualFold(entry.Hash, w.TransactionHash) {
					found = true
				}
			}
			if !found {
				return nil, errors.New("completed withdrawal transaction is missing; preserve the file")
			}
		}
	}
	return &record, nil
}

func pendingAddressTransaction(entry *addressTransaction) []addressTransaction {
	if entry == nil {
		return nil
	}
	return []addressTransaction{*entry}
}

func (h *FundingHandler) saveAddress(record *addressFundingRecord) error {
	raw, err := json.Marshal(record)
	if err != nil {
		return errors.New("cannot encode payment address recovery data")
	}
	file, err := os.CreateTemp(filepath.Dir(h.statePath), ".address-funding-*")
	if err != nil {
		return errors.New("cannot persist payment address recovery data; no new transaction was sent")
	}
	defer os.Remove(file.Name())
	if err = file.Chmod(0600); err == nil {
		_, err = file.Write(raw)
	}
	if err == nil {
		err = file.Sync()
	}
	closeErr := file.Close()
	if err == nil {
		err = closeErr
	}
	if err == nil {
		err = os.Rename(file.Name(), h.addressStatePath())
	}
	if err == nil {
		directory, openErr := os.Open(filepath.Dir(h.statePath))
		if openErr == nil {
			err = directory.Sync()
			_ = directory.Close()
		} else {
			err = openErr
		}
	}
	if err != nil {
		return errors.New("cannot persist payment address recovery data; no new transaction was sent")
	}
	return nil
}
