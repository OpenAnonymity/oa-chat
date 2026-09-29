package zkapi

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"strings"
	"time"
)

// AddressPaymentQuote contains public quantities only. A quote durably prepares
// an intent, but never grants permission to sign or replay a transaction.
type AddressPaymentQuote struct {
	InputMicroUSD        uint64 `json:"input_micro_usd,omitempty"`
	ID                   string `json:"id"`
	Kind                 string `json:"kind"`
	Address              string `json:"address"`
	ChainID              uint64 `json:"chain_id"`
	Contract             string `json:"contract_address"`
	DeploymentID         string `json:"deployment_id"`
	Amount               uint64 `json:"amount"`
	Destination          string `json:"destination,omitempty"`
	NoteID               uint64 `json:"note_id,omitempty"`
	PrincipalWei         string `json:"principal_wei"`
	BalanceWei           string `json:"balance_wei"`
	ExpectedFeeWei       string `json:"expected_fee_wei"`
	RequiredFeeWei       string `json:"required_fee_wei"`
	FeeReserveWei        string `json:"fee_reserve_wei"`
	FeeBufferWei         string `json:"fee_buffer_wei"`
	RequiredTotalWei     string `json:"required_total_wei"`
	RecommendedTotalWei  string `json:"recommended_total_wei"`
	ShortfallWei         string `json:"shortfall_wei"`
	RecommendedTopUpWei  string `json:"recommended_top_up_wei"`
	EstimatedGas         uint64 `json:"estimated_gas"`
	GasLimit             uint64 `json:"gas_limit"`
	MaxFeePerGas         string `json:"max_fee_per_gas"`
	MaxPriorityFeePerGas string `json:"max_priority_fee_per_gas"`
	FeePolicy            string `json:"fee_policy"`
	ExpiresAt            int64  `json:"expires_at"`
	// Public operation bindings are persisted with the quote so another
	// management client cannot redirect a displayed approval.
	Commitment string `json:"commitment,omitempty"`
	Binding    string `json:"binding,omitempty"`
	Nonce      uint64 `json:"nonce"`
	RetryHash  string `json:"retry_hash,omitempty"`
}

type addressQuoteContextKey struct{}
type addressQuoteMode struct {
	Capture   *AddressPaymentQuote
	Approval  *AddressPaymentQuote
	RetryHash string
}

func quoteMode(ctx context.Context) *addressQuoteMode {
	mode, _ := ctx.Value(addressQuoteContextKey{}).(*addressQuoteMode)
	return mode
}

func (h *FundingHandler) QuoteAddressDeposit(ctx context.Context, amount uint64) (AddressPaymentQuote, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.quoteAddressDepositLocked(ctx, amount, 0)
}
func (h *FundingHandler) QuoteAddressDepositUSD(ctx context.Context, microUSD uint64) (AddressPaymentQuote, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if microUSD == 0 {
		return AddressPaymentQuote{}, errors.New("invalid USD deposit amount")
	}
	config, err := h.config(ctx)
	if err != nil {
		return AddressPaymentQuote{}, err
	}
	record, err := h.loadAddress(config)
	if err != nil {
		return AddressPaymentQuote{}, err
	}
	amount := record.DepositUSDUnits
	if record.DepositMicroUSD != microUSD || amount == 0 || record.Amount != amount {
		price, err := h.client.NativeUSDQuote(ctx)
		if err != nil {
			return AddressPaymentQuote{}, err
		}
		amount, err = price.GweiForUSD(microUSD)
		if err != nil {
			return AddressPaymentQuote{}, err
		}
	}
	return h.quoteAddressDepositLocked(ctx, amount, microUSD)
}
func (h *FundingHandler) quoteAddressDepositLocked(ctx context.Context, amount, microUSD uint64) (AddressPaymentQuote, error) {
	var quote AddressPaymentQuote
	if amount == 0 || amount > 1_000_000_000_000 {
		return quote, errors.New("invalid deposit amount")
	}
	config, record, _, err := h.addressSnapshot(ctx)
	if err != nil {
		return quote, err
	}
	if !config.nativeETH() {
		return quote, errors.New("native ETH deployment required for a deposit quote")
	}
	if record.Phase == "active" || record.Phase == "legacy_recovery" || (record.Withdrawal != nil && record.Withdrawal.Phase != "complete") {
		return quote, errors.New("recover the saved transaction or close the private note before quoting a deposit")
	}
	retryHash := ""
	if record.Pending != nil {
		if record.Pending.Kind != "deposit" || record.Phase != "reverted" || record.Amount != amount {
			return quote, errors.New("recover the saved transaction before quoting a deposit")
		}
		receipt, final, err := h.addressFinalReceipt(ctx, config, record.Pending.Hash, true)
		if err != nil {
			return quote, err
		}
		if !final || receipt.Status != "0x0" {
			return quote, errors.New("the saved deposit must have a finalized revert before requoting")
		}
		retryHash = record.Pending.Hash
	}
	if _, err = h.prepare(ctx, amount); err != nil {
		return quote, err
	}
	deposit, err := h.readAddressDeposit(config)
	if err != nil || deposit == nil || deposit.Amount != amount || deposit.Active || deposit.TransactionHash != "" {
		return quote, errors.New("the prepared deposit cannot be quoted; preserve its recovery data")
	}
	record.Amount, record.Commitment, record.Phase = amount, deposit.Commitment, "waiting_funds"
	if retryHash != "" {
		record.Phase = "reverted"
	}
	record.DepositMicroUSD = microUSD
	record.DepositUSDUnits = 0
	if microUSD != 0 {
		record.DepositUSDUnits = amount
	}
	record.Withdrawal = nil
	if err = h.saveAddress(record); err != nil {
		return quote, err
	}
	data, err := h.refreshAddressDeposit(ctx, deposit)
	if err != nil {
		return quote, err
	}
	ctx = context.WithValue(ctx, addressQuoteContextKey{}, &addressQuoteMode{Capture: &quote, RetryHash: retryHash})
	err = h.signAddressTransaction(ctx, config, record, "deposit", config.Contract, data)
	return quote, err
}
func (h *FundingHandler) ApproveAddressDeposit(ctx context.Context, id string) (AddressFundingStatus, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	config, err := h.config(ctx)
	if err != nil {
		return AddressFundingStatus{}, err
	}
	record, err := h.loadAddress(config)
	if err != nil {
		return AddressFundingStatus{}, err
	}
	quote, err := checkedAddressQuote(record, id, "deposit")
	if err != nil {
		return addressPublicStatus(record), err
	}
	return h.fundAddressLocked(context.WithValue(ctx, addressQuoteContextKey{}, &addressQuoteMode{Approval: quote}), quote.Amount)
}
func (h *FundingHandler) QuoteAddressWithdrawal(ctx context.Context, destination string, noteID uint64, retryHash string) (AddressPaymentQuote, error) {
	var quote AddressPaymentQuote
	mode := &addressQuoteMode{Capture: &quote, RetryHash: retryHash}
	status, err := h.WithdrawAddress(context.WithValue(ctx, addressQuoteContextKey{}, mode), destination, noteID, retryHash)
	if err == nil && quote.ID == "" {
		err = fmt.Errorf("withdrawal cannot be quoted while its status is %s; resume the saved operation", status.Phase)
	}
	return quote, err
}
func (h *FundingHandler) ApproveAddressWithdrawal(ctx context.Context, id string) (AddressWithdrawalStatus, error) {
	h.mu.Lock()
	config, err := h.config(ctx)
	if err != nil {
		h.mu.Unlock()
		return AddressWithdrawalStatus{}, err
	}
	record, err := h.loadAddress(config)
	if err != nil {
		h.mu.Unlock()
		return AddressWithdrawalStatus{}, err
	}
	quote, err := checkedAddressQuote(record, id, "withdrawal")
	h.mu.Unlock()
	if err != nil {
		return AddressWithdrawalStatus{}, err
	}
	// WithdrawAddress takes the same lock again and the signer rechecks this
	// exact saved ID/binding before any signing; a competing quote fails closed.
	return h.WithdrawAddress(context.WithValue(ctx, addressQuoteContextKey{}, &addressQuoteMode{Approval: quote}), quote.Destination, quote.NoteID, quote.RetryHash)
}
func checkedAddressQuote(record *addressFundingRecord, id, kind string) (*AddressPaymentQuote, error) {
	q := record.Quote
	if q == nil || q.ID != id || q.Kind != kind || len(id) != 64 || q.ExpiresAt <= time.Now().UnixMilli() {
		return nil, errAddressQuoteChanged
	}
	copy := *q
	return &copy, nil
}
func (h *FundingHandler) refreshAddressDeposit(ctx context.Context, deposit *depositRecord) (string, error) {
	path, err := h.depositPath(ctx)
	if err != nil {
		return "", err
	}
	raw, _ := json.Marshal(path)
	var refreshed struct {
		ZeroPath []string `json:"zero_path"`
	}
	if json.Unmarshal(raw, &refreshed) != nil || len(refreshed.ZeroPath) != 32 {
		return "", errors.New("invalid refreshed deposit path")
	}
	data := "0xc588341c" + addressABIWord(deposit.Commitment) + fmt.Sprintf("%064x", deposit.Amount)
	for _, sibling := range refreshed.ZeroPath {
		if !isField(sibling) {
			return "", errors.New("invalid refreshed deposit path")
		}
		data += addressABIWord(sibling)
	}
	deposit.ZeroPath = refreshed.ZeroPath
	if err = h.save(*deposit); err != nil {
		return "", err
	}
	return data, nil
}
func positiveDifference(left, right *big.Int) *big.Int {
	n := new(big.Int).Sub(left, right)
	if n.Sign() < 0 {
		n.SetInt64(0)
	}
	return n
}
func (h *FundingHandler) savePaymentQuote(record *addressFundingRecord, kind, to string, value, balance, estimate *big.Int, gas, nonce uint64, fees addressFees, retryHash string) (AddressPaymentQuote, error) {
	nonceBytes := make([]byte, 32)
	if _, err := rand.Read(nonceBytes); err != nil {
		return AddressPaymentQuote{}, err
	}
	gasInt := new(big.Int).SetUint64(gas)
	required := new(big.Int).Mul(gasInt, fees.Minimum)
	reserve := new(big.Int).Mul(gasInt, fees.Max)
	total := new(big.Int).Add(value, required)
	recommended := new(big.Int).Add(value, reserve)
	if recommended.BitLen() > 256 {
		return AddressPaymentQuote{}, errAddressFeeData
	}
	q := AddressPaymentQuote{ID: hex.EncodeToString(nonceBytes), Kind: kind, Address: record.Address, ChainID: record.ChainID, Contract: record.Contract, DeploymentID: record.DeploymentID, Amount: record.Amount, PrincipalWei: value.String(), BalanceWei: balance.String(), ExpectedFeeWei: new(big.Int).Mul(estimate, fees.Expected).String(), RequiredFeeWei: required.String(), FeeReserveWei: reserve.String(), FeeBufferWei: new(big.Int).Sub(reserve, required).String(), RequiredTotalWei: total.String(), RecommendedTotalWei: recommended.String(), ShortfallWei: positiveDifference(total, balance).String(), RecommendedTopUpWei: positiveDifference(recommended, balance).String(), EstimatedGas: estimate.Uint64(), GasLimit: gas, MaxFeePerGas: fees.Max.String(), MaxPriorityFeePerGas: fees.Tip.String(), FeePolicy: "low", ExpiresAt: time.Now().Add(30 * time.Second).UnixMilli(), Commitment: record.Commitment, Nonce: nonce, RetryHash: retryHash}
	if kind == "deposit" {
		q.InputMicroUSD = record.DepositMicroUSD
	}
	if kind == "withdrawal" && record.Withdrawal != nil {
		q.NoteID = record.Withdrawal.NoteID
		q.Amount = record.Withdrawal.Amount
		q.Destination = record.Withdrawal.Destination
		q.Binding = record.Withdrawal.Binding
		q.Commitment = ""
	}
	if kind == "return" {
		q.Destination = to
		q.Commitment = ""
		q.Amount = 0
	}
	record.Quote = &q
	if err := h.saveAddress(record); err != nil {
		return AddressPaymentQuote{}, err
	}
	return q, nil
}
func validatePaymentApproval(record *addressFundingRecord, q *AddressPaymentQuote, kind, to string, value *big.Int, nonce uint64) error {
	if q == nil || record.Quote == nil || record.Quote.ID != q.ID || q.Kind != kind || q.ExpiresAt <= time.Now().UnixMilli() || q.DeploymentID != record.DeploymentID || q.ChainID != record.ChainID || !strings.EqualFold(q.Address, record.Address) || !strings.EqualFold(q.Contract, record.Contract) || q.Nonce != nonce || q.PrincipalWei != value.String() {
		return errAddressQuoteChanged
	}
	if kind == "deposit" && (q.Amount != record.Amount || q.Commitment != record.Commitment || !strings.EqualFold(to, record.Contract)) {
		return errAddressQuoteChanged
	}
	if kind == "withdrawal" && (record.Withdrawal == nil || q.NoteID != record.Withdrawal.NoteID || q.Amount != record.Withdrawal.Amount || q.Binding != record.Withdrawal.Binding || !strings.EqualFold(q.Destination, record.Withdrawal.Destination) || !strings.EqualFold(to, record.Contract)) {
		return errAddressQuoteChanged
	}
	if kind == "return" && !strings.EqualFold(q.Destination, to) {
		return errAddressQuoteChanged
	}
	return nil
}

// SavedAddressQuote is read-only; an expired quote remains inspectable but can
// never authorize signing. Refresh it explicitly to obtain a new approval ID.
func (h *FundingHandler) SavedAddressQuote(ctx context.Context, kind string) (*AddressPaymentQuote, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	config, err := h.config(ctx)
	if err != nil {
		return nil, err
	}
	record, err := h.loadAddress(config)
	if err != nil {
		return nil, err
	}
	if record.Quote == nil || record.Quote.Kind != kind {
		return nil, nil
	}
	copy := *record.Quote
	return &copy, nil
}
