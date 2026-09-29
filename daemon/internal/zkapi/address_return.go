package zkapi

import (
	"context"
	"encoding/json"
	"errors"
	"math/big"
	"os"
	"strings"
)

type addressReturnRecord struct {
	Destination     string `json:"destination"`
	AmountWei       string `json:"amount_wei"`
	Sweep           bool   `json:"sweep"`
	Phase           string `json:"phase"`
	TransactionHash string `json:"transaction_hash,omitempty"`
}
type AddressReturnStatus struct {
	ActualFeeWei    string `json:"actual_fee_wei,omitempty"`
	Address         string `json:"address"`
	ChainID         uint64 `json:"chain_id"`
	ETHBalance      string `json:"eth_balance"`
	Phase           string `json:"phase"`
	Destination     string `json:"destination,omitempty"`
	AmountWei       string `json:"amount_wei,omitempty"`
	TransactionHash string `json:"transaction_hash,omitempty"`
	Message         string `json:"message"`
}

func returnPublicStatus(record *addressFundingRecord, balance string) AddressReturnStatus {
	status := AddressReturnStatus{Address: record.Address, ChainID: record.ChainID, ETHBalance: balance, Phase: "ready", Message: "Return public ETH to an explicit destination after closing the private note."}
	if r := record.Return; r != nil {
		status.Phase = r.Phase
		status.Destination = r.Destination
		status.AmountWei = r.AmountWei
		status.TransactionHash = r.TransactionHash
	}
	if record.Return != nil {
		for _, entry := range append(append([]addressTransaction{}, record.History...), pendingAddressTransaction(record.Pending)...) {
			if strings.EqualFold(entry.Hash, record.Return.TransactionHash) {
				status.ActualFeeWei = entry.ActualFeeWei
			}
		}
	}
	switch status.Phase {
	case "quoted":
		status.Message = "Review the exact public ETH amount and maximum network fee, then approve this quote."
	case "return_pending":
		status.Message = "Return transaction is saved; explicit resume replays only its original signed bytes."
	case "complete":
		status.Message = "The public ETH return is finalized; unused fee allowance remains at the funding address."
	case "reverted":
		status.Message = "The public return reverted with Ethereum finality. Review a new quote to authorize another transaction."
	}
	return status
}
func (h *FundingHandler) returnSnapshot(ctx context.Context) (fundingConfig, *addressFundingRecord, AddressReturnStatus, error) {
	if _, err := os.Lstat(h.addressStatePath()); err != nil {
		return fundingConfig{}, nil, AddressReturnStatus{}, errors.New("no saved funding address is available for a public return")
	}
	config, record, payment, err := h.addressSnapshot(ctx)
	if err != nil {
		return config, record, AddressReturnStatus{}, err
	}
	return config, record, returnPublicStatus(record, payment.ETHBalance), nil
}
func (h *FundingHandler) AddressReturn(ctx context.Context) (AddressReturnStatus, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	_, _, status, err := h.returnSnapshot(ctx)
	return status, err
}
func (h *FundingHandler) ensureAddressReturnAllowed(ctx context.Context, record *addressFundingRecord) error {
	if record.Pending != nil {
		return errors.New("recover the saved transaction before returning public ETH")
	}
	if record.Withdrawal != nil && record.Withdrawal.Phase != "complete" {
		return errors.New("complete the private withdrawal before returning public ETH")
	}
	raw, err := h.client.WalletStatus(ctx)
	if err != nil {
		return err
	}
	var wallet struct {
		HasNote *bool `json:"has_note"`
		Pending bool  `json:"pending_request"`
	}
	if json.Unmarshal(raw, &wallet) != nil || wallet.HasNote == nil {
		return errors.New("invalid private wallet status")
	}
	if *wallet.HasNote || wallet.Pending {
		return errors.New("withdraw the private balance and finish settlement before returning public ETH")
	}
	return nil
}
func (h *FundingHandler) QuoteAddressReturn(ctx context.Context, destination, amountWei string) (AddressPaymentQuote, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	var quote AddressPaymentQuote
	destination, err := NormalizeWithdrawalDestination(destination)
	if err != nil {
		return quote, err
	}
	config, record, _, err := h.returnSnapshot(ctx)
	if err != nil {
		return quote, err
	}
	if !config.nativeETH() {
		return quote, errors.New("native ETH deployment required for public returns")
	}
	if strings.EqualFold(destination, record.Address) {
		return quote, errors.New("return destination must differ from the funding address")
	}
	if err = h.ensureAddressReturnAllowed(ctx, record); err != nil {
		return quote, err
	}
	sweep := amountWei == ""
	if sweep {
		amountWei = "0"
	}
	amount, ok := new(big.Int).SetString(amountWei, 10)
	if !ok || amount.Sign() < 0 || (!sweep && amount.Sign() == 0) || amount.BitLen() > 256 || amount.String() != amountWei {
		return quote, errors.New("invalid exact public ETH return amount")
	}
	record.Return = &addressReturnRecord{Destination: destination, AmountWei: amountWei, Sweep: sweep, Phase: "quoted"}
	if err = h.saveAddress(record); err != nil {
		return quote, err
	}
	err = h.signAddressTransaction(context.WithValue(ctx, addressQuoteContextKey{}, &addressQuoteMode{Capture: &quote}), config, record, "return", destination, "0x")
	return quote, err
}
func (h *FundingHandler) ApproveAddressReturn(ctx context.Context, id string) (AddressReturnStatus, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	config, record, status, err := h.returnSnapshot(ctx)
	if err != nil {
		return status, err
	}
	quote, err := checkedAddressQuote(record, id, "return")
	if err != nil {
		return status, err
	}
	if err = h.ensureAddressReturnAllowed(ctx, record); err != nil {
		return status, err
	}
	if record.Return == nil || record.Return.AmountWei != quote.PrincipalWei || !strings.EqualFold(record.Return.Destination, quote.Destination) {
		return status, errAddressQuoteChanged
	}
	err = h.signAddressTransaction(context.WithValue(ctx, addressQuoteContextKey{}, &addressQuoteMode{Approval: quote}), config, record, "return", quote.Destination, "0x")
	return returnPublicStatus(record, status.ETHBalance), err
}
func (h *FundingHandler) ResumeAddressReturn(ctx context.Context) (AddressReturnStatus, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	config, record, status, err := h.returnSnapshot(ctx)
	if err != nil {
		return status, err
	}
	if record.Return == nil || record.Return.Phase == "quoted" || record.Return.Phase == "complete" || record.Return.Phase == "reverted" {
		return status, nil
	}
	if record.Pending == nil || record.Pending.Kind != "return" || !strings.EqualFold(record.Pending.Hash, record.Return.TransactionHash) {
		return status, errors.New("saved return transaction is missing; preserve recovery files")
	}
	receipt, final, err := h.addressFinalReceipt(ctx, config, record.Pending.Hash, true)
	if err != nil {
		return status, err
	}
	if !final {
		if receipt == nil {
			h.broadcastAddress(ctx, config, record.Pending)
		}
		return status, nil
	}
	if !strings.EqualFold(receipt.To, record.Return.Destination) {
		return status, errors.New("return receipt destination differs from the signed authorization")
	}
	if err := recordAddressActualFee(record.Pending, receipt); err != nil {
		return status, err
	}
	done := *record.Pending
	done.FinalizedRevert = receipt.Status == "0x0"
	record.Return.Phase = "complete"
	if done.FinalizedRevert {
		record.Return.Phase = "reverted"
	}
	record.History = append(record.History, done)
	record.Pending = nil
	if record.Amount != 0 {
		record.Phase = "waiting_funds"
	} else {
		record.Phase = "ready"
	}
	err = h.saveAddress(record)
	return returnPublicStatus(record, status.ETHBalance), err
}
