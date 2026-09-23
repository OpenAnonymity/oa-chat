package zkapi

import (
	"bytes"
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/big"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/core/types"
	"github.com/ethereum/go-ethereum/crypto"
)

// AddressFundingStatus exposes only public funding data, never signing keys,
// signed bytes, private-note secrets, or inference credentials.
type AddressFundingStatus struct {
	Address         string `json:"address"`
	ChainID         uint64 `json:"chain_id"`
	TokenAddress    string `json:"token_address"`
	TokenDecimals   int    `json:"token_decimals"`
	TokenBalance    string `json:"token_balance"`
	ETHBalance      string `json:"eth_balance"`
	Amount          uint64 `json:"amount,omitempty"`
	Phase           string `json:"phase"`
	TransactionHash string `json:"transaction_hash,omitempty"`
	Message         string `json:"message"`
}

var errAddressNeedsETH = errors.New("send more ETH to the payment address for Ethereum network fees")

func (h *FundingHandler) Address(ctx context.Context) (AddressFundingStatus, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.addressLocked(ctx)
}

func (h *FundingHandler) FundAddress(ctx context.Context, amount uint64) (AddressFundingStatus, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.fundAddressLocked(ctx, amount)
}

func (h *FundingHandler) addressLocked(ctx context.Context) (AddressFundingStatus, error) {
	_, _, status, err := h.addressSnapshot(ctx)
	return status, err
}

func (h *FundingHandler) addressSnapshot(ctx context.Context) (fundingConfig, *addressFundingRecord, AddressFundingStatus, error) {
	config, err := h.config(ctx)
	if err != nil {
		return config, nil, AddressFundingStatus{}, err
	}
	if err := h.assertAddressChain(ctx, config); err != nil {
		return config, nil, AddressFundingStatus{}, err
	}
	decimals, err := h.addressUintCall(ctx, config, config.Token, "0x313ce567", "latest")
	if err != nil || decimals.Cmp(big.NewInt(6)) != 0 {
		return config, nil, AddressFundingStatus{}, errors.New("the payment token must use exactly six decimals")
	}
	record, err := h.loadAddress(config)
	if err != nil {
		return config, nil, AddressFundingStatus{}, err
	}
	status := addressPublicStatus(record)
	token, err := h.addressUintCall(ctx, config, config.Token, "0x70a08231"+addressABIWord(record.Address), "latest")
	if err != nil {
		return config, record, status, err
	}
	eth, err := h.addressQuantity(ctx, config, "eth_getBalance", []any{record.Address, "pending"})
	if err != nil {
		return config, record, status, err
	}
	status.TokenBalance, status.ETHBalance = token.String(), eth.String()
	if record.Phase == "active" {
		hasNote, err := h.addressHasNote(ctx)
		if err != nil {
			return config, record, status, err
		}
		if !hasNote {
			status.Phase = "recovery_required"
			status.Message = "The saved private note is missing from the companion. Restore its state before further funding; no new deposit will be sent."
		}
	}
	return config, record, status, nil
}

func (h *FundingHandler) addressHasNote(ctx context.Context) (bool, error) {
	raw, err := h.client.WalletStatus(ctx)
	if err != nil {
		return false, err
	}
	var wallet struct {
		HasNote *bool `json:"has_note"`
	}
	if json.Unmarshal(raw, &wallet) != nil || wallet.HasNote == nil {
		return false, errors.New("invalid companion note status")
	}
	return *wallet.HasNote, nil
}

func addressPublicStatus(record *addressFundingRecord) AddressFundingStatus {
	status := AddressFundingStatus{Address: record.Address, ChainID: record.ChainID, TokenAddress: record.Token, TokenDecimals: 6, TokenBalance: "0", ETHBalance: "0", Amount: record.Amount, Phase: record.Phase}
	if record.Pending != nil {
		status.TransactionHash = record.Pending.Hash
	}
	switch record.Phase {
	case "ready":
		status.Message = "Send the configured token and ETH for network fees to this address, then choose a deposit amount."
	case "waiting_funds":
		status.Message = "Waiting for the selected token amount and enough ETH for network fees."
	case "approval_pending":
		status.Message = "The token approval is pending Ethereum confirmation. Checking again reuses the same transaction."
	case "deposit_pending":
		status.Message = "The deposit is pending Ethereum finality. Checking again reuses the same transaction."
	case "confirming":
		status.Message = "The deposit is confirmed. Retry to activate its saved private note."
	case "active":
		status.Message = "Your private balance is ready."
	case "reverted":
		status.Message = "The saved transaction reverted. Retry explicitly to reuse the private note with a fresh transaction after finality."
	case "legacy_recovery":
		status.Message = "An earlier browser-funded deposit needs recovery. Resume its saved transaction before starting another deposit."
	default:
		status.Message = "Payment recovery is required. Preserve the local funding files."
	}
	return status
}

func (h *FundingHandler) fundAddressLocked(ctx context.Context, amount uint64) (AddressFundingStatus, error) {
	if amount == 0 || amount > 1_000_000_000_000 {
		return AddressFundingStatus{}, errors.New("invalid deposit amount")
	}
	config, record, status, err := h.addressSnapshot(ctx)
	if err != nil {
		return status, err
	}
	update := func() AddressFundingStatus {
		next := addressPublicStatus(record)
		next.TokenBalance, next.ETHBalance = status.TokenBalance, status.ETHBalance
		return next
	}
	if record.Phase == "active" {
		hasNote, err := h.addressHasNote(ctx)
		if err != nil {
			return update(), err
		}
		if hasNote {
			if record.Amount != amount {
				return update(), errors.New("a private note is already active; close it before funding a new amount")
			}
			return update(), nil
		}
		return status, nil
	}
	if record.Amount != 0 && record.Amount != amount {
		return update(), errors.New("a different deposit amount is already saved; resume the saved amount")
	}
	if record.Phase == "reverted" {
		if record.Pending == nil {
			return update(), errors.New("reverted transaction journal is missing; preserve the funding files")
		}
		receipt, final, err := h.addressFinalReceipt(ctx, config, record.Pending.Hash, true)
		if err != nil {
			return update(), err
		}
		if !final {
			return update(), nil
		}
		if receipt.Status != "0x0" {
			return update(), errors.New("the saved transaction no longer has a reverted receipt; check its status")
		}
		deposit, err := h.readAddressDeposit(config)
		if err != nil {
			return update(), err
		}
		if deposit != nil && strings.EqualFold(deposit.TransactionHash, record.Pending.Hash) {
			if deposit.Active {
				return update(), errors.New("an active private note cannot be replaced")
			}
			deposit.TransactionHash = ""
			if err := h.save(*deposit); err != nil {
				return update(), err
			}
		}
		failed := *record.Pending
		failed.FinalizedRevert = true
		record.History = append(record.History, failed)
		record.Pending, record.Phase = nil, "waiting_funds"
		if err := h.saveAddress(record); err != nil {
			return update(), err
		}
	}

	if record.Amount == 0 {
		// Old wallet dialogs may have broadcast a deposit without returning its
		// hash. Never adopt their note and send another deposit from this key.
		previous, readErr := h.readAddressDeposit(config)
		if readErr != nil {
			return status, readErr
		}
		if previous != nil {
			record.Phase, record.Amount = "legacy_recovery", previous.Amount
			if previous.Active {
				record.Phase = "active"
			}
			if err := h.saveAddress(record); err != nil {
				return status, err
			}
			return update(), nil
		}
		record.Amount, record.Phase = amount, "waiting_funds"
		if err := h.saveAddress(record); err != nil {
			return status, err
		}
	}
	if record.Phase == "legacy_recovery" {
		return update(), nil
	}
	if record.Pending == nil && len(record.History) != 0 {
		previous := record.History[len(record.History)-1]
		if !previous.FinalizedRevert && (previous.Kind == "approval" || previous.Kind == "approval_reset") {
			// The approval may have been archived just before an interruption
			// or a failed deposit simulation. No successor was then signed to
			// drive normal pending recovery. Restore that exact approval if
			// its provisional receipt disappeared or changed after a reorg.
			receipt, _, err := h.addressFinalReceipt(ctx, config, previous.Hash, false)
			if err != nil {
				return update(), err
			}
			if receipt == nil || receipt.Status == "0x0" {
				record.History = record.History[:len(record.History)-1]
				record.Pending, record.Phase = &previous, "approval_pending"
				if err := h.saveAddress(record); err != nil {
					return update(), err
				}
			}
		}
	}
	if record.Pending != nil {
		receipt, final, receiptErr := h.addressFinalReceipt(ctx, config, record.Pending.Hash, record.Pending.Kind == "deposit")
		if receiptErr != nil {
			return update(), receiptErr
		}
		if !final {
			// A missing receipt is uncertainty, not permission to choose a new
			// nonce. Replaying identical EIP-155 bytes is safe after any restart.
			if receipt == nil {
				// Approval confirmation does not wait for finality. If it is
				// reorganized away, the dependent deposit cannot use its nonce
				// until that exact prior approval is replayed. Never sign a
				// replacement, nor replay an older deposit under this policy.
				for i := range record.History {
					previous := &record.History[i]
					if !previous.FinalizedRevert && (previous.Kind == "approval" || previous.Kind == "approval_reset") {
						h.broadcastAddress(ctx, config, previous)
					}
				}
				h.broadcastAddress(ctx, config, record.Pending)
			}
			return update(), nil
		}
		if receipt.Status == "0x0" {
			record.Phase = "reverted"
			if err := h.saveAddress(record); err != nil {
				return update(), err
			}
			return update(), nil
		}
		if record.Pending.Kind == "deposit" {
			record.Phase = "confirming"
			if err := h.saveAddress(record); err != nil {
				return update(), err
			}
			if _, err := h.confirm(ctx, record.Pending.Hash); err != nil {
				return update(), err
			}
			record.Phase = "active"
			if err := h.saveAddress(record); err != nil {
				return update(), err
			}
			return update(), nil
		}
		expected := new(big.Int).SetUint64(amount)
		if record.Pending.Kind == "approval_reset" {
			expected.SetUint64(0)
		}
		allowance, err := h.addressAllowance(ctx, config, record.Address, receipt.BlockNumber)
		if err != nil || allowance.Cmp(expected) != 0 {
			return update(), errors.New("the confirmed token approval has not been verified; retry without sending a replacement")
		}
		record.History = append(record.History, *record.Pending)
		record.Pending = nil
		record.Phase = "waiting_funds"
		if err := h.saveAddress(record); err != nil {
			return update(), err
		}
	}
	tokenBalance, _ := new(big.Int).SetString(status.TokenBalance, 10)
	ethBalance, _ := new(big.Int).SetString(status.ETHBalance, 10)
	if tokenBalance.Cmp(new(big.Int).SetUint64(amount)) < 0 || ethBalance.Sign() == 0 {
		return update(), nil
	}
	if _, err := h.prepare(ctx, amount); err != nil {
		return update(), err
	}
	deposit, err := h.readAddressDeposit(config)
	if err != nil || deposit == nil {
		return update(), errors.New("the private deposit recovery record is unavailable")
	}
	if deposit.Amount != amount || (record.Commitment != "" && record.Commitment != deposit.Commitment) {
		return update(), errors.New("the saved private deposit does not match this funding attempt")
	}
	if deposit.Active {
		record.Phase = "active"
		if err := h.saveAddress(record); err != nil {
			return update(), err
		}
		return update(), nil
	}
	if deposit.TransactionHash != "" {
		return update(), errors.New("a submitted deposit is missing its local transaction journal; recover its saved hash before continuing")
	}
	record.Commitment = deposit.Commitment
	if err := h.saveAddress(record); err != nil {
		return update(), err
	}
	allowance, err := h.addressAllowance(ctx, config, record.Address, "latest")
	if err != nil {
		return update(), err
	}
	kind, to, data := "approval", config.Token, "0x095ea7b3"+addressABIWord(config.Contract)+fmt.Sprintf("%064x", amount)
	if allowance.Cmp(new(big.Int).SetUint64(amount)) < 0 {
		if allowance.Sign() != 0 {
			kind, data = "approval_reset", "0x095ea7b3"+addressABIWord(config.Contract)+strings.Repeat("0", 64)
		}
	} else {
		// Approval may take minutes. Obtain the current empty-leaf witness
		// immediately before simulating/signing the deposit.
		path, pathErr := h.depositPath(ctx)
		if pathErr != nil {
			return update(), pathErr
		}
		encoded, _ := json.Marshal(path)
		var refreshed struct {
			ZeroPath []string `json:"zero_path"`
		}
		if json.Unmarshal(encoded, &refreshed) != nil || len(refreshed.ZeroPath) != 32 {
			return update(), errors.New("invalid refreshed deposit path")
		}
		deposit.ZeroPath = refreshed.ZeroPath
		if err := h.save(*deposit); err != nil {
			return update(), err
		}
		kind, to = "deposit", config.Contract
		data = "0xc588341c" + addressABIWord(deposit.Commitment) + fmt.Sprintf("%064x", amount)
		for _, sibling := range refreshed.ZeroPath {
			data += addressABIWord(sibling)
		}
	}
	if err := h.signAddressTransaction(ctx, config, record, kind, to, data); err != nil {
		if errors.Is(err, errAddressNeedsETH) {
			next := update()
			next.Message = err.Error()
			return next, nil
		}
		return update(), err
	}
	return update(), nil
}

func (h *FundingHandler) readAddressDeposit(config fundingConfig) (*depositRecord, error) {
	raw, err := os.ReadFile(h.statePath)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, errors.New("cannot read the pending private deposit")
	}
	var record depositRecord
	if json.Unmarshal(raw, &record) != nil || record.ChainID != config.ChainID || !strings.EqualFold(record.Contract, config.Contract) {
		return nil, errors.New("pending private deposit belongs to another deployment or is invalid; preserve it for recovery")
	}
	return &record, nil
}

func addressABIWord(value string) string {
	value = strings.TrimPrefix(value, "0x")
	if len(value) > 64 {
		return ""
	}
	return strings.Repeat("0", 64-len(value)) + value
}

func (h *FundingHandler) addressRPC(ctx context.Context, config fundingConfig, method string, params []any, result any) error {
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	body, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": 1, "method": method, "params": params})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, config.RPC, bytes.NewReader(body))
	if err != nil {
		return errors.New("invalid payment RPC request")
	}
	req.Header.Set("Content-Type", "application/json")
	// This is the existing mandatory Wisp client. Never use http.DefaultClient
	// and never reflect RPC errors, request bodies, or signed bytes to callers.
	response, err := h.client.inference.Do(req)
	if err != nil {
		return errors.New("payment RPC unavailable; retry the saved funding attempt")
	}
	defer response.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(response.Body, (1<<20)+1))
	if err != nil || len(raw) > 1<<20 || response.StatusCode != http.StatusOK {
		return errors.New("payment RPC unavailable; retry the saved funding attempt")
	}
	var envelope struct {
		Version string          `json:"jsonrpc"`
		ID      int             `json:"id"`
		Result  json.RawMessage `json:"result"`
		Error   json.RawMessage `json:"error"`
	}
	if json.Unmarshal(raw, &envelope) != nil || envelope.Version != "2.0" || envelope.ID != 1 || len(envelope.Error) != 0 || len(envelope.Result) == 0 || json.Unmarshal(envelope.Result, result) != nil {
		return errors.New("invalid payment RPC response; retry the saved funding attempt")
	}
	return nil
}

func (h *FundingHandler) addressQuantity(ctx context.Context, config fundingConfig, method string, params []any) (*big.Int, error) {
	var encoded string
	if err := h.addressRPC(ctx, config, method, params, &encoded); err != nil {
		return nil, err
	}
	return addressHexUint(encoded)
}

func addressHexUint(encoded string) (*big.Int, error) {
	if !isField(encoded) {
		return nil, errors.New("invalid Ethereum quantity")
	}
	value, ok := new(big.Int).SetString(encoded[2:], 16)
	if !ok || value.Sign() < 0 || value.BitLen() > 256 {
		return nil, errors.New("invalid Ethereum quantity")
	}
	return value, nil
}

func (h *FundingHandler) assertAddressChain(ctx context.Context, config fundingConfig) error {
	chain, err := h.addressQuantity(ctx, config, "eth_chainId", []any{})
	if err != nil {
		return err
	}
	if !chain.IsUint64() || chain.Uint64() != config.ChainID {
		return errors.New("payment RPC is on the wrong Ethereum network; no transaction was sent")
	}
	return nil
}

func (h *FundingHandler) addressUintCall(ctx context.Context, config fundingConfig, contract, data, block string) (*big.Int, error) {
	return h.addressQuantity(ctx, config, "eth_call", []any{map[string]string{"to": contract, "data": data}, block})
}

func (h *FundingHandler) addressAllowance(ctx context.Context, config fundingConfig, owner, block string) (*big.Int, error) {
	return h.addressUintCall(ctx, config, config.Token, "0xdd62ed3e"+addressABIWord(owner)+addressABIWord(config.Contract), block)
}

func (h *FundingHandler) signAddressTransaction(ctx context.Context, config fundingConfig, record *addressFundingRecord, kind, to, data string) error {
	if record.Pending != nil {
		return errors.New("a signed payment is still pending; no replacement was sent")
	}
	if err := h.assertAddressChain(ctx, config); err != nil {
		return err
	}
	nonce, err := h.addressQuantity(ctx, config, "eth_getTransactionCount", []any{record.Address, "pending"})
	if err != nil {
		return err
	}
	if !nonce.IsUint64() || nonce.BitLen() > 53 {
		return errors.New("invalid payment nonce")
	}
	for _, previous := range record.History {
		if previous.Nonce >= nonce.Uint64() {
			return errors.New("the payment RPC has not caught up with saved transactions; no new transaction was sent")
		}
	}
	gas, err := h.addressQuantity(ctx, config, "eth_estimateGas", []any{map[string]string{"from": record.Address, "to": to, "data": data, "value": "0x0"}})
	if err != nil {
		return errors.New("payment simulation failed; check token and ETH balances before retrying")
	}
	if !gas.IsUint64() || gas.Uint64() < 21000 || gas.Uint64() > 16_777_216 {
		return errors.New("invalid payment gas estimate")
	}
	gasLimit := (gas.Uint64()*120+99)/100 + 50_000
	if gasLimit > 16_777_216 {
		return errors.New("payment gas limit exceeds Ethereum's transaction cap")
	}
	price, err := h.addressQuantity(ctx, config, "eth_gasPrice", []any{})
	if err != nil {
		return err
	}
	fee := new(big.Int).Mul(new(big.Int).SetUint64(gasLimit), price)
	if price.Sign() <= 0 || price.Cmp(big.NewInt(300_000_000_000)) > 0 || fee.Cmp(big.NewInt(20_000_000_000_000_000)) > 0 {
		return errors.New("Ethereum fees exceed the safe payment limit; try again when fees are lower")
	}
	balance, err := h.addressQuantity(ctx, config, "eth_getBalance", []any{record.Address, "pending"})
	if err != nil {
		return err
	}
	if balance.Cmp(fee) < 0 {
		return errAddressNeedsETH
	}
	if err := h.assertAddressChain(ctx, config); err != nil {
		return err
	}
	key, err := crypto.HexToECDSA(record.PrivateKey)
	if err != nil {
		return errors.New("invalid saved payment key; preserve its recovery file")
	}
	calldata, err := hex.DecodeString(strings.TrimPrefix(data, "0x"))
	if err != nil {
		return errors.New("invalid payment call data")
	}
	unsigned := types.NewTransaction(nonce.Uint64(), common.HexToAddress(to), big.NewInt(0), gasLimit, price, calldata)
	signed, err := types.SignTx(unsigned, types.NewEIP155Signer(new(big.Int).SetUint64(config.ChainID)), key)
	if err != nil {
		return errors.New("cannot sign payment transaction")
	}
	raw, err := signed.MarshalBinary()
	if err != nil {
		return errors.New("cannot encode payment transaction")
	}
	record.Pending = &addressTransaction{Kind: kind, Raw: "0x" + hex.EncodeToString(raw), Hash: signed.Hash().Hex(), Nonce: nonce.Uint64()}
	record.Phase = "approval_pending"
	if kind == "deposit" {
		record.Phase = "deposit_pending"
	}
	// From this point every retry uses these exact bytes, even if a broadcast
	// fails or the daemon crashes before the RPC responds.
	if err := h.saveAddress(record); err != nil {
		return err
	}
	h.broadcastAddress(ctx, config, record.Pending)
	return nil
}

func (h *FundingHandler) broadcastAddress(ctx context.Context, config fundingConfig, tx *addressTransaction) {
	if h.assertAddressChain(ctx, config) != nil {
		return
	}
	var hash string
	// A missing or wrong hash is ambiguous: the locally derived hash is the
	// only transaction identity. Never recover by choosing another nonce.
	_ = h.addressRPC(ctx, config, "eth_sendRawTransaction", []any{tx.Raw}, &hash)
}

type addressReceipt struct {
	Status          string `json:"status"`
	TransactionHash string `json:"transactionHash"`
	BlockHash       string `json:"blockHash"`
	BlockNumber     string `json:"blockNumber"`
}

func (h *FundingHandler) addressFinalReceipt(ctx context.Context, config fundingConfig, hash string, requireFinality bool) (*addressReceipt, bool, error) {
	var receipt *addressReceipt
	if err := h.addressRPC(ctx, config, "eth_getTransactionReceipt", []any{hash}, &receipt); err != nil {
		return nil, false, err
	}
	if receipt == nil {
		return nil, false, nil
	}
	if !strings.EqualFold(receipt.TransactionHash, hash) || !isHex(receipt.BlockHash, 32) || (receipt.Status != "0x0" && receipt.Status != "0x1") {
		return nil, false, errors.New("invalid payment receipt; preserve its saved transaction")
	}
	number, err := addressHexUint(receipt.BlockNumber)
	if err != nil {
		return nil, false, err
	}
	var finalized struct {
		Number string `json:"number"`
		Hash   string `json:"hash"`
	}
	blockTag := "latest"
	// A provisional failure can disappear or become successful in a reorg.
	// Persisting "reverted" grants a later explicit retry a fresh nonce, so
	// failure always needs finality even when successful approvals do not.
	if requireFinality || receipt.Status == "0x0" {
		blockTag = "finalized"
	}
	if err := h.addressRPC(ctx, config, "eth_getBlockByNumber", []any{blockTag, false}, &finalized); err != nil {
		return receipt, false, err
	}
	finalizedNumber, err := addressHexUint(finalized.Number)
	if err != nil {
		return receipt, false, err
	}
	if finalizedNumber.Cmp(number) < 0 {
		return receipt, false, nil
	}
	var canonical struct {
		Number string `json:"number"`
		Hash   string `json:"hash"`
	}
	if err := h.addressRPC(ctx, config, "eth_getBlockByNumber", []any{receipt.BlockNumber, false}, &canonical); err != nil {
		return receipt, false, err
	}
	if canonical.Number != receipt.BlockNumber || !strings.EqualFold(canonical.Hash, receipt.BlockHash) {
		return receipt, false, errors.New("payment receipt is not canonical; retry its saved transaction")
	}
	if err := h.assertAddressChain(ctx, config); err != nil {
		return receipt, false, err
	}
	return receipt, true, nil
}

// The manual legacy recovery endpoint shares confirm(), so locally signed
// deposits must retain the same finality policy there as in FundAddress.
func (h *FundingHandler) confirmAddressFinality(ctx context.Context, config fundingConfig, hash string) error {
	if _, err := os.Lstat(h.addressStatePath()); errors.Is(err, os.ErrNotExist) {
		return nil
	} else if err != nil {
		return errors.New("cannot read payment address recovery data")
	}
	record, err := h.loadAddress(config)
	if err != nil {
		return err
	}
	for _, entry := range append(append([]addressTransaction{}, record.History...), pendingAddressTransaction(record.Pending)...) {
		if entry.Kind != "deposit" || !strings.EqualFold(entry.Hash, hash) {
			continue
		}
		_, final, err := h.addressFinalReceipt(ctx, config, hash, true)
		if err != nil {
			return err
		}
		if !final {
			return errors.New("the saved deposit is awaiting Ethereum finality; retry confirmation later")
		}
	}
	return nil
}
