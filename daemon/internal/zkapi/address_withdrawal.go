package zkapi

import (
	"context"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/crypto"
)

// AddressWithdrawalStatus contains public progress only. Proofs, raw signed
// transactions, note recovery secrets, and the signing key stay on disk.
type AddressWithdrawalStatus struct {
	Address         string `json:"address"`
	ChainID         uint64 `json:"chain_id"`
	TokenAddress    string `json:"token_address"`
	TokenDecimals   int    `json:"token_decimals"`
	ETHBalance      string `json:"eth_balance"`
	PrivateBalance  uint64 `json:"private_balance"`
	Amount          uint64 `json:"amount"`
	Destination     string `json:"destination,omitempty"`
	NoteID          uint64 `json:"note_id,omitempty"`
	Phase           string `json:"phase"`
	TransactionHash string `json:"transaction_hash,omitempty"`
	Message         string `json:"message"`
}

type addressWithdrawalRecord struct {
	NoteID          uint64 `json:"note_id"`
	Destination     string `json:"destination"`
	Amount          uint64 `json:"amount"`
	Nullifier       string `json:"nullifier,omitempty"`
	Binding         string `json:"binding,omitempty"`
	Phase           string `json:"phase"`
	TransactionHash string `json:"transaction_hash,omitempty"`
	// SettlementHash records an independently relayed payout. TransactionHash
	// remains the locally signed intent whose nonce was consumed by a revert.
	SettlementHash string `json:"settlement_hash,omitempty"`
}

type withdrawalWallet struct {
	HasNote *bool `json:"has_note"`
	Pending bool  `json:"pending_request"`
	Note    *struct {
		NoteID  uint64 `json:"note_id"`
		Balance uint64 `json:"current_balance"`
	} `json:"note"`
}

type withdrawalBridgeStatus struct {
	Phase           string `json:"phase"`
	NoteID          uint64 `json:"note_id"`
	Destination     string `json:"destination"`
	FinalBalance    string `json:"final_balance"`
	Nullifier       string `json:"withdrawal_nullifier"`
	TransactionHash string `json:"transaction_hash"`
}

type withdrawalInputs struct {
	ProtocolVersion uint64  `json:"protocol_version"`
	ChainID         uint64  `json:"chain_id"`
	Contract        string  `json:"contract_address"`
	ActiveRoot      string  `json:"active_root"`
	StateKeyX       string  `json:"state_signing_key_x"`
	StateKeyY       string  `json:"state_signing_key_y"`
	ClearanceKeyX   string  `json:"clearance_signing_key_x"`
	ClearanceKeyY   string  `json:"clearance_signing_key_y"`
	NoteID          uint64  `json:"note_id"`
	FinalBalance    uint64  `json:"final_balance"`
	Destination     []uint8 `json:"destination"`
	Nullifier       string  `json:"withdrawal_nullifier"`
	HasClearance    bool    `json:"has_clearance"`
	WithdrawalTag   string  `json:"withdrawal_tag"`
}

type withdrawalPlan struct {
	Mode         string           `json:"mode"`
	PublicInputs withdrawalInputs `json:"public_inputs"`
	Siblings     []string         `json:"siblings"`
	Proof        struct {
		Backend string `json:"backend"`
		Proof   string `json:"proof"`
	} `json:"proof"`
}

var withdrawalSelector = hex.EncodeToString(crypto.Keccak256([]byte("mutualClose((uint16,uint64,address,uint256,uint256,uint256,uint256,uint256,uint32,uint128,address,uint256,bool,uint256),bytes,uint256[32])"))[:4])
var withdrawalEventTopic = crypto.Keccak256Hash([]byte("MutualClose(uint32,uint256,uint128,address)")).Hex()

// NormalizeWithdrawalDestination rejects zero and bad mixed-case checksums.
// Lower/upper-case addresses remain accepted, as with standard Ethereum tools.
func NormalizeWithdrawalDestination(value string) (string, error) {
	if !isHex(value, 20) || common.HexToAddress(value) == (common.Address{}) {
		return "", errors.New("withdrawal destination must be a nonzero Ethereum address")
	}
	address := common.HexToAddress(value).Hex()
	body := value[2:]
	if body != strings.ToLower(body) && body != strings.ToUpper(body) && value != address {
		return "", errors.New("withdrawal destination has an invalid Ethereum checksum")
	}
	return address, nil
}

func (h *FundingHandler) AddressWithdrawal(ctx context.Context) (AddressWithdrawalStatus, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	_, _, _, status, err := h.withdrawalSnapshot(ctx)
	return status, err
}

func (h *FundingHandler) withdrawalSnapshot(ctx context.Context) (fundingConfig, *addressFundingRecord, withdrawalWallet, AddressWithdrawalStatus, error) {
	config, record, payment, err := h.addressSnapshot(ctx)
	status := AddressWithdrawalStatus{Address: payment.Address, ChainID: payment.ChainID, TokenAddress: payment.TokenAddress, TokenDecimals: 6, ETHBalance: payment.ETHBalance}
	var wallet withdrawalWallet
	if err != nil {
		return config, record, wallet, status, err
	}
	raw, err := h.client.request(ctx, http.MethodGet, "/oa/v1/status", nil)
	var capability struct {
		Version int `json:"withdrawal_bridge_version"`
	}
	if err != nil {
		return config, record, wallet, status, err
	}
	if json.Unmarshal(raw, &capability) != nil || capability.Version != 1 {
		return config, record, wallet, status, errors.New("the companion needs the wallet-independent withdrawal bridge; update the native bundle")
	}
	raw, err = h.client.WalletStatus(ctx)
	if err != nil {
		return config, record, wallet, status, err
	}
	if json.Unmarshal(raw, &wallet) != nil || wallet.HasNote == nil || (*wallet.HasNote && (wallet.Note == nil || wallet.Note.NoteID > 0xffffffff)) {
		return config, record, wallet, status, errors.New("invalid companion withdrawal status")
	}
	status.Phase = "no_note"
	if *wallet.HasNote {
		status.NoteID, status.PrivateBalance, status.Amount = wallet.Note.NoteID, wallet.Note.Balance, wallet.Note.Balance
		status.Phase = "ready"
		if wallet.Pending {
			status.Phase = "waiting_settlement"
		}
	}
	if withdrawal := record.Withdrawal; withdrawal != nil {
		status.NoteID, status.Amount, status.Destination = withdrawal.NoteID, withdrawal.Amount, withdrawal.Destination
		status.Phase, status.TransactionHash = withdrawal.Phase, withdrawal.TransactionHash
		if record.Pending != nil && record.Pending.Kind == "withdrawal" {
			status.TransactionHash = record.Pending.Hash
		}
		if withdrawal.SettlementHash != "" {
			status.TransactionHash = withdrawal.SettlementHash
		}
		if *wallet.HasNote && wallet.Note.NoteID != withdrawal.NoteID {
			status.Phase = "recovery_required"
		}
	} else if !*wallet.HasNote && payment.Phase == "recovery_required" {
		status.Phase = "recovery_required"
	}
	setWithdrawalMessage(&status)
	return config, record, wallet, status, nil
}

func setWithdrawalMessage(status *AddressWithdrawalStatus) {
	switch status.Phase {
	case "ready":
		status.Message = "Withdraw the entire remaining private balance to an explicit Ethereum address. The local payment address pays network fees."
	case "no_note":
		status.Message = "There is no active private balance to withdraw."
	case "waiting_settlement":
		status.Message = "Wait for the outstanding inference to settle, then rerun the same withdrawal command."
	case "waiting_funds":
		status.Message = "Withdrawal is reserved. Send ETH for network fees to the local payment address, then rerun the same command."
	case "withdrawal_pending":
		status.Message = "Withdrawal is reserved or awaiting Ethereum finality. Resume with the same destination; new inference is paused."
	case "confirming":
		status.Message = "Withdrawal is finalized on Ethereum; resume to finish local recovery bookkeeping."
	case "complete":
		status.Message = "The remaining private balance was withdrawn and the private note is closed."
	case "reverted":
		status.Message = "The withdrawal transaction reverted and is finalized. Rerun explicitly to refresh its proof, or use --confirm with the transaction hash if the same payout was already relayed; inference remains paused."
	default:
		status.Message = "Withdrawal recovery is required. Preserve the local payment and private-note files."
	}
}

func (h *FundingHandler) WithdrawAddress(ctx context.Context, destination string, noteID uint64, retryHashes ...string) (AddressWithdrawalStatus, error) {
	destination, err := NormalizeWithdrawalDestination(destination)
	if err != nil {
		return AddressWithdrawalStatus{}, err
	}
	retryHash, confirmationHash := "", ""
	if len(retryHashes) > 2 {
		return AddressWithdrawalStatus{}, errors.New("invalid withdrawal retry authorization")
	}
	if len(retryHashes) >= 1 {
		retryHash = retryHashes[0]
	}
	if len(retryHashes) == 2 {
		confirmationHash = retryHashes[1]
	}
	if retryHash != "" && !isHex(retryHash, 32) {
		return AddressWithdrawalStatus{}, errors.New("invalid withdrawal retry transaction hash")
	}
	if confirmationHash != "" && (!isHex(confirmationHash, 32) || retryHash != "") {
		return AddressWithdrawalStatus{}, errors.New("withdrawal confirmation requires a valid transaction hash and cannot also retry a transaction")
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	config, record, wallet, status, err := h.withdrawalSnapshot(ctx)
	if err != nil {
		return status, err
	}
	if status.NoteID != noteID {
		return status, errors.New("the selected private note has changed; run a new withdrawal command to authorize the current balance")
	}
	update := func() AddressWithdrawalStatus {
		if w := record.Withdrawal; w != nil {
			status.NoteID, status.Amount, status.Destination = w.NoteID, w.Amount, w.Destination
			status.Phase, status.TransactionHash = w.Phase, w.TransactionHash
			if record.Pending != nil && record.Pending.Kind == "withdrawal" {
				status.TransactionHash = record.Pending.Hash
			}
			if w.SettlementHash != "" {
				status.TransactionHash = w.SettlementHash
			}
		}
		setWithdrawalMessage(&status)
		return status
	}
	if status.Phase == "recovery_required" {
		return status, errors.New("the saved withdrawal does not match the active note; preserve recovery files")
	}
	if record.Withdrawal != nil {
		if !strings.EqualFold(record.Withdrawal.Destination, destination) {
			return status, errors.New("a withdrawal destination is already saved; resume with that same destination")
		}
		if record.Withdrawal.Phase == "complete" {
			return status, nil
		}
	} else {
		if retryHash != "" || confirmationHash != "" {
			return status, errors.New("there is no saved withdrawal attempt to retry or confirm")
		}
		if !*wallet.HasNote {
			return status, nil
		}
		if record.Pending != nil && (record.Pending.Kind != "deposit" || record.Phase != "active") {
			return status, errors.New("finish the saved deposit before withdrawing")
		}
		// One atomic save transfers the finalized deposit into nonce history
		// and records intent, before asking the companion to reserve clearance.
		if record.Pending != nil {
			record.History = append(record.History, *record.Pending)
			record.Pending = nil
		}
		record.Withdrawal = &addressWithdrawalRecord{NoteID: wallet.Note.NoteID, Destination: destination, Phase: "withdrawal_pending"}
		record.Phase = "withdrawal_pending"
		if err := h.saveAddress(record); err != nil {
			return update(), err
		}
	}
	w := record.Withdrawal
	var retrying *addressTransaction
	if w.SettlementHash != "" {
		if retryHash != "" || (confirmationHash != "" && !strings.EqualFold(confirmationHash, w.SettlementHash)) {
			return update(), errors.New("a relayed payout is already saved; resume the same withdrawal without changing its transaction")
		}
		confirmationHash = w.SettlementHash
	} else if confirmationHash != "" && w.Phase != "reverted" {
		return update(), errors.New("alternate payout confirmation requires a finalized reverted local withdrawal; check its status first")
	}
	if retryHash != "" && (w.Phase != "reverted" || record.Pending == nil || !strings.EqualFold(retryHash, record.Pending.Hash)) {
		return update(), errors.New("the failed withdrawal attempt has changed; check status before retrying")
	}
	if confirmationHash != "" && (record.Pending == nil || record.Pending.Kind != "withdrawal" || strings.EqualFold(confirmationHash, record.Pending.Hash)) {
		return update(), errors.New("alternate payout confirmation must name a distinct transaction for the saved withdrawal")
	}
	if record.Pending != nil {
		if record.Pending.Kind != "withdrawal" {
			return update(), errors.New("unexpected pending payment during withdrawal; preserve recovery files")
		}
		receipt, final, err := h.addressFinalReceipt(ctx, config, record.Pending.Hash, true)
		if err != nil {
			return update(), err
		}
		if !final {
			if confirmationHash != "" {
				return update(), errors.New("the local withdrawal must have a canonical finalized revert before an alternate payout can be confirmed")
			}
			if receipt == nil {
				h.broadcastAddress(ctx, config, record.Pending)
			}
			return update(), nil
		}
		if confirmationHash != "" {
			// Only a finalized local failure consumes this signer's nonce. An
			// unrelated relayer's success alone cannot retire our signed bytes.
			if receipt.Status != "0x0" {
				return update(), errors.New("the local withdrawal has no finalized revert; an alternate payout cannot replace it")
			}
			alternate, alternateFinal, err := h.addressFinalReceipt(ctx, config, confirmationHash, true)
			if err != nil {
				return update(), err
			}
			if !alternateFinal {
				return update(), errors.New("the alternate payout is missing or not finalized; the saved withdrawal has not changed")
			}
			if err := validateWithdrawalReceipt(alternate, config, w, true); err != nil {
				return update(), err
			}
			if err := h.completeAddressWithdrawal(ctx, config, record, confirmationHash, true); err != nil {
				return update(), err
			}
			status.PrivateBalance = 0
			return update(), nil
		}
		if receipt.Status == "0x0" {
			if w.Phase != "reverted" || retryHash == "" {
				w.Phase = "reverted"
				if err := h.saveAddress(record); err != nil {
					return update(), err
				}
				return update(), nil
			}
			// Continuation polls never carry retry authorization. A fresh CLI
			// invocation must name this exact failed hash, so a second polling
			// client cannot silently turn another client's revert into a retry.
			// Keep the failed attempt eligible for independently relayed
			// payout confirmation until a replacement is durably signed.
			// Proof generation or simulation can fail because it already paid.
			retrying = record.Pending
		} else {
			if err := validateWithdrawalReceipt(receipt, config, w, false); err != nil {
				return update(), err
			}
			if err := h.completeAddressWithdrawal(ctx, config, record, record.Pending.Hash, false); err != nil {
				return update(), err
			}
			status.PrivateBalance = 0
			return update(), nil
		}
	}
	if !*wallet.HasNote {
		return update(), errors.New("the reserved private note is missing; restore its recovery state")
	}
	body, _ := json.Marshal(map[string]string{"destination": destination})
	raw, err := h.client.request(ctx, http.MethodPost, "/oa/v1/withdraw/prepare", body)
	if err != nil {
		var bridge *Error
		if errors.As(err, &bridge) && bridge.Code == "pending_settlement" {
			if retrying != nil {
				return update(), err
			}
			w.Phase = "waiting_settlement"
			if saveErr := h.saveAddress(record); saveErr != nil {
				return update(), saveErr
			}
			return update(), nil
		}
		return update(), err
	}
	var plan withdrawalPlan
	if json.Unmarshal(raw, &plan) != nil {
		return update(), errors.New("invalid withdrawal proof response")
	}
	data, binding, err := withdrawalCalldata(plan, config, w, wallet.Note.Balance)
	if err != nil {
		return update(), err
	}
	// Independently bind the proof to the companion's durable reservation,
	// rather than trusting a pre-prepare balance that may just have settled.
	raw, err = h.client.request(ctx, http.MethodGet, "/oa/v1/withdraw/status", nil)
	if err != nil {
		return update(), err
	}
	var reserved withdrawalBridgeStatus
	expected := *w
	expected.Amount, expected.Nullifier = plan.PublicInputs.FinalBalance, "0x"+addressABIWord(plan.PublicInputs.Nullifier)
	if json.Unmarshal(raw, &reserved) != nil || reserved.Phase != "reserved" || !withdrawalStatusMatches(reserved, &expected) {
		return update(), errors.New("withdrawal proof does not match its saved reservation")
	}
	w.Amount, w.Nullifier, w.Binding, w.Phase = expected.Amount, expected.Nullifier, binding, "withdrawal_pending"
	if retrying != nil {
		w.Phase = "reverted"
	}
	if err := h.saveAddress(record); err != nil {
		return update(), err
	}
	if retrying != nil {
		failed := *retrying
		failed.FinalizedRevert = true
		record.History = append(record.History, failed)
		record.Pending = nil
		// This in-memory transition is committed only with the replacement
		// signed transaction by signAddressTransaction's atomic save.
	}
	if err := h.signAddressTransaction(ctx, config, record, "withdrawal", config.Contract, data); err != nil {
		if retrying != nil && record.Pending == nil {
			record.History = record.History[:len(record.History)-1]
			record.Pending = retrying
			w.Phase = "reverted"
			// No replacement was created. The durable journal still contains
			// this exact reverted attempt, including when gas is insufficient.
			return update(), err
		}
		if errors.Is(err, errAddressNeedsETH) {
			w.Phase = "waiting_funds"
			if saveErr := h.saveAddress(record); saveErr != nil {
				return update(), saveErr
			}
			next := update()
			next.Message = err.Error()
			return next, nil
		}
		return update(), err
	}
	return update(), nil
}

// Call only after checking exact, canonical, finalized payout evidence. Save
// its identity before companion confirmation so an uncertain response resumes
// confirmation rather than signing another withdrawal or releasing the nonce.
func (h *FundingHandler) completeAddressWithdrawal(ctx context.Context, config fundingConfig, record *addressFundingRecord, settlementHash string, localReverted bool) error {
	w := record.Withdrawal
	w.Phase, w.TransactionHash = "confirming", record.Pending.Hash
	if localReverted {
		w.SettlementHash = strings.ToLower(settlementHash)
	}
	if err := h.saveAddress(record); err != nil {
		return err
	}
	body, _ := json.Marshal(map[string]string{"transaction_hash": settlementHash})
	raw, err := h.client.request(ctx, http.MethodPost, "/oa/v1/withdraw/confirm", body)
	if err != nil {
		return err
	}
	var confirmed withdrawalBridgeStatus
	if json.Unmarshal(raw, &confirmed) != nil || !withdrawalStatusMatches(confirmed, w) || confirmed.Phase != "complete" || !strings.EqualFold(confirmed.TransactionHash, settlementHash) {
		return errors.New("invalid withdrawal confirmation; preserve the saved transaction")
	}
	if err := h.archiveWithdrawnDeposit(config, record); err != nil {
		return err
	}
	retired := *record.Pending
	retired.FinalizedRevert = localReverted
	record.History = append(record.History, retired)
	record.Pending, record.Amount, record.Commitment, record.Phase = nil, 0, "", "ready"
	w.Phase = "complete"
	return h.saveAddress(record)
}

func withdrawalStatusMatches(status withdrawalBridgeStatus, record *addressWithdrawalRecord) bool {
	amount, ok := new(big.Int).SetString(status.FinalBalance, 10)
	return ok && amount.IsUint64() && amount.Uint64() == record.Amount && status.NoteID == record.NoteID && strings.EqualFold(status.Destination, record.Destination) && isField(status.Nullifier) && strings.EqualFold(addressABIWord(status.Nullifier), addressABIWord(record.Nullifier))
}

func withdrawalCalldata(plan withdrawalPlan, config fundingConfig, saved *addressWithdrawalRecord, previousBalance uint64) (string, string, error) {
	p := plan.PublicInputs
	invalid := errors.New("withdrawal proof does not match the authorized note, destination, balance, or deployment")
	if plan.Mode != "mutual" || p.ProtocolVersion != 2 || p.ChainID != config.ChainID || !isField(p.Contract) || !strings.EqualFold(addressABIWord(p.Contract), addressABIWord(config.Contract)) || p.NoteID != saved.NoteID || p.NoteID > 0xffffffff || !p.HasClearance || len(p.Destination) != 20 || !strings.EqualFold(common.BytesToAddress(p.Destination).Hex(), saved.Destination) || p.FinalBalance > previousBalance || len(plan.Siblings) != 32 || plan.Proof.Backend != "groth16_bn254" {
		return "", "", invalid
	}
	proof, err := base64.StdEncoding.DecodeString(plan.Proof.Proof)
	if err != nil || len(proof) != 256 {
		return "", "", invalid
	}
	fields := []string{p.ActiveRoot, p.StateKeyX, p.StateKeyY, p.ClearanceKeyX, p.ClearanceKeyY, p.Nullifier, p.WithdrawalTag}
	for _, field := range append(fields, plan.Siblings...) {
		if !isField(field) {
			return "", "", invalid
		}
	}
	words := []string{fmt.Sprintf("%064x", p.ProtocolVersion), fmt.Sprintf("%064x", p.ChainID), addressABIWord(p.Contract), addressABIWord(p.ActiveRoot), addressABIWord(p.StateKeyX), addressABIWord(p.StateKeyY), addressABIWord(p.ClearanceKeyX), addressABIWord(p.ClearanceKeyY), fmt.Sprintf("%064x", p.NoteID), fmt.Sprintf("%064x", p.FinalBalance), addressABIWord(saved.Destination), addressABIWord(p.Nullifier), fmt.Sprintf("%064x", 1), addressABIWord(p.WithdrawalTag)}
	for i := range words {
		words[i] = strings.ToLower(words[i])
	}
	// Roots/path may change while a transaction waits; all other public
	// inputs must remain identical after the first proof was authorized.
	bound := append([]string{}, words...)
	bound[3] = ""
	binding := crypto.Keccak256Hash([]byte(strings.Join(bound, ""))).Hex()
	if saved.Binding != "" && (saved.Binding != binding || saved.Amount != p.FinalBalance || !strings.EqualFold(addressABIWord(saved.Nullifier), addressABIWord(p.Nullifier))) {
		return "", "", invalid
	}
	words = append(words, fmt.Sprintf("%064x", 47*32))
	for _, sibling := range plan.Siblings {
		words = append(words, addressABIWord(sibling))
	}
	words = append(words, fmt.Sprintf("%064x", len(proof)), hex.EncodeToString(proof))
	return "0x" + withdrawalSelector + strings.Join(words, ""), binding, nil
}

func validateWithdrawalReceipt(receipt *addressReceipt, config fundingConfig, saved *addressWithdrawalRecord, relayed bool) error {
	// An independently relayed payout can call the vault through a wrapper.
	// Its exact authenticated vault event is the payout evidence; the outer
	// recipient remains bound to the vault for our own signed transaction.
	if receipt.Status == "0x1" && (relayed || strings.EqualFold(receipt.To, config.Contract)) {
		matches := 0
		for _, log := range receipt.Logs {
			if !strings.EqualFold(log.Address, config.Contract) || len(log.Topics) != 2 || !strings.EqualFold(log.Topics[0], withdrawalEventTopic) {
				continue
			}
			if log.Removed || !strings.EqualFold(log.Topics[1], fmt.Sprintf("0x%064x", saved.NoteID)) || !isHex(log.Data, 96) {
				continue
			}
			expected := "0x" + addressABIWord(saved.Nullifier) + fmt.Sprintf("%064x", saved.Amount) + addressABIWord(saved.Destination)
			if strings.EqualFold(log.Data, expected) {
				matches++
			}
		}
		if matches == 1 {
			return nil
		}
	}
	return errors.New("finalized receipt does not match the saved withdrawal; preserve recovery files")
}

func validateSignedWithdrawal(data []byte, config fundingConfig, saved *addressWithdrawalRecord) error {
	invalid := errors.New("signed withdrawal does not match its saved authorization; preserve recovery files")
	if saved == nil || len(data) != 4+56*32 || hex.EncodeToString(data[:4]) != withdrawalSelector || saved.Binding == "" || !isHex(saved.Nullifier, 32) {
		return invalid
	}
	words := make([]string, 48)
	for i := range words {
		words[i] = hex.EncodeToString(data[4+i*32 : 4+(i+1)*32])
	}
	expected := map[int]string{0: fmt.Sprintf("%064x", 2), 1: fmt.Sprintf("%064x", config.ChainID), 2: addressABIWord(config.Contract), 8: fmt.Sprintf("%064x", saved.NoteID), 9: fmt.Sprintf("%064x", saved.Amount), 10: addressABIWord(saved.Destination), 11: addressABIWord(saved.Nullifier), 12: fmt.Sprintf("%064x", 1), 14: fmt.Sprintf("%064x", 47*32), 47: fmt.Sprintf("%064x", 256)}
	for index, value := range expected {
		if !strings.EqualFold(words[index], value) {
			return invalid
		}
	}
	bound := words[:14]
	bound[3] = ""
	if crypto.Keccak256Hash([]byte(strings.Join(bound, ""))).Hex() != saved.Binding {
		return invalid
	}
	return nil
}

func (h *FundingHandler) archiveWithdrawnDeposit(config fundingConfig, record *addressFundingRecord) error {
	deposit, err := h.readAddressDeposit(config)
	if err != nil {
		return err
	}
	if deposit == nil {
		return nil
	} // A prior confirmation may have archived it.
	if !deposit.Active || (record.Commitment != "" && !strings.EqualFold(record.Commitment, deposit.Commitment)) || (record.Amount != 0 && record.Amount != deposit.Amount) {
		return errors.New("withdrawal cannot archive unrelated deposit recovery data")
	}
	info, err := os.Lstat(h.statePath)
	if err != nil || !info.Mode().IsRegular() || info.Mode().Perm() != 0600 {
		return errors.New("deposit recovery file is not private; preserve it")
	}
	archive := h.statePath + ".withdrawn-" + strings.TrimPrefix(record.Pending.Hash, "0x")
	if _, err := os.Lstat(archive); err == nil || !errors.Is(err, os.ErrNotExist) {
		return errors.New("withdrawn deposit archive already exists; preserve recovery files")
	}
	if err := os.Rename(h.statePath, archive); err != nil {
		return errors.New("cannot archive withdrawn deposit recovery data")
	}
	directory, err := os.Open(filepath.Dir(h.statePath))
	if err != nil {
		return errors.New("cannot sync withdrawn deposit archive")
	}
	defer directory.Close()
	if directory.Sync() != nil {
		return errors.New("cannot sync withdrawn deposit archive")
	}
	return nil
}

// Legacy capability endpoints share the same lifecycle: a companion that has
// already closed its note must not accept a new deposit until Go finishes the
// old withdrawal's bookkeeping, even if that last local write was interrupted.
func (h *FundingHandler) checkWithdrawalFunding(config fundingConfig) error {
	if _, err := os.Lstat(h.addressStatePath()); errors.Is(err, os.ErrNotExist) {
		return nil
	} else if err != nil {
		return errors.New("cannot read withdrawal recovery data")
	}
	record, err := h.loadAddress(config)
	if err != nil {
		return err
	}
	if record.Withdrawal != nil && record.Withdrawal.Phase != "complete" {
		return errors.New("finish the saved withdrawal before funding a new private balance")
	}
	return nil
}

// Called only by deposit confirmation after the exact new note's receipt and
// companion activation have been checked. This also covers legacy deposits.
func (h *FundingHandler) adoptPostWithdrawalDeposit(config fundingConfig, deposit depositRecord, noteID uint32) error {
	if _, err := os.Lstat(h.addressStatePath()); errors.Is(err, os.ErrNotExist) {
		return nil
	} else if err != nil {
		return errors.New("cannot read withdrawal recovery data")
	}
	record, err := h.loadAddress(config)
	if err != nil {
		return err
	}
	if record.Withdrawal == nil {
		return nil
	}
	if record.Withdrawal.Phase != "complete" || record.Withdrawal.NoteID == uint64(noteID) {
		return errors.New("a closed note cannot be activated again")
	}
	if record.Pending != nil {
		return errors.New("a saved transaction must be recovered before adopting a new note")
	}
	record.Withdrawal = nil
	record.Phase, record.Amount, record.Commitment = "active", deposit.Amount, deposit.Commitment
	return h.saveAddress(record)
}
