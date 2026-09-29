package zkapi

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"math/big"
	"net/http"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/ethereum/go-ethereum/core/types"
)

func quoteNumber(t *testing.T, value string) *big.Int {
	t.Helper()
	n, ok := new(big.Int).SetString(value, 10)
	if !ok {
		t.Fatal("bad quoted quantity")
	}
	return n
}
func TestNativeDepositQuoteIsUnsignedExactAndUsesExistingETH(t *testing.T) {
	f := newAddressFixture(t, true)
	f.eth = "0x3b9aca00"
	quote, err := f.h.QuoteAddressDeposit(context.Background(), 1234567)
	if err != nil {
		t.Fatal(err)
	}
	if len(f.submitted) != 0 || quote.PrincipalWei != "1234567000000000" || quote.FeePolicy != "low" || quote.BalanceWei != "1000000000" || f.overrideReads != 2 {
		t.Fatalf("invalid readonly quote: %+v", quote)
	}
	expected := new(big.Int).Sub(quoteNumber(t, quote.RequiredTotalWei), big.NewInt(1_000_000_000))
	if quote.ShortfallWei != expected.String() {
		t.Fatal("quote ignored ETH already at funding address")
	}
	config, _ := f.h.config(context.Background())
	record, err := f.h.loadAddress(config)
	if err != nil || record.Pending != nil || record.Amount != quote.Amount || record.Commitment != quote.Commitment || record.Quote.ID != quote.ID {
		t.Fatal("quote did not preserve unsigned fixed intent")
	}
	firstCommitment := quote.Commitment
	f.h = &FundingHandler{client: f.h.client, statePath: f.h.statePath}
	again, err := f.h.QuoteAddressDeposit(context.Background(), quote.Amount)
	if err != nil || again.Commitment != firstCommitment || again.ID == quote.ID || f.prepared != 1 {
		t.Fatal("repeated quote replaced note draft or approval identity")
	}
	if _, err = f.h.ApproveAddressDeposit(context.Background(), quote.ID); err == nil || len(f.submitted) != 0 {
		t.Fatal("superseded quote signed")
	}
	encoded, _ := json.Marshal(again)
	if strings.Contains(string(encoded), record.PrivateKey) || strings.Contains(string(encoded), "0xabcdef") {
		t.Fatal("public quote exposed secrets")
	}
}
func TestNativeDepositApprovalRequiresOnlyRequiredAllowanceAndClampsBuffer(t *testing.T) {
	f := newAddressFixture(t, true)
	q, err := f.h.QuoteAddressDeposit(context.Background(), 100000)
	if err != nil {
		t.Fatal(err)
	}
	f.eth = "0x" + quoteNumber(t, q.RequiredTotalWei).Text(16)
	status, err := f.h.ApproveAddressDeposit(context.Background(), q.ID)
	if err != nil || status.Phase != "deposit_pending" {
		t.Fatalf("optional buffer incorrectly required: %+v %v", status, err)
	}
	tx := f.accepted[status.TransactionHash]
	liability := new(big.Int).Mul(new(big.Int).SetUint64(tx.Gas()), tx.GasFeeCap())
	if liability.Cmp(quoteNumber(t, q.FeeReserveWei)) > 0 || liability.Cmp(quoteNumber(t, q.RequiredFeeWei)) != 0 || tx.Type() != types.DynamicFeeTxType {
		t.Fatal("signed liability exceeded approval or did not fit exact required funding")
	}
}
func TestNativeDepositRevalidatesApprovalCeilingAndExpiry(t *testing.T) {
	for _, scenario := range []string{"buffer", "fee jump", "expiry", "nonce", "amount", "no approval"} {
		t.Run(scenario, func(t *testing.T) {
			f := newAddressFixture(t, true)
			q, err := f.h.QuoteAddressDeposit(context.Background(), 100000)
			if err != nil {
				t.Fatal(err)
			}
			switch scenario {
			case "buffer":
				f.gasPrice = "0x4190ab00"
			case "fee jump":
				f.gasPrice = "0x77359400"
			case "nonce":
				f.nonce = "0x1"
			case "expiry":
				config, _ := f.h.config(context.Background())
				record, _ := f.h.loadAddress(config)
				record.Quote.ExpiresAt = time.Now().Add(-time.Second).UnixMilli()
				if err = f.h.saveAddress(record); err != nil {
					t.Fatal(err)
				}
			case "amount":
				_, err = f.h.QuoteAddressDeposit(context.Background(), 100001)
				if err != nil {
					t.Fatal(err)
				}
			}
			var status AddressFundingStatus
			if scenario == "no approval" {
				status, err = f.h.FundAddress(context.Background(), q.Amount)
			} else {
				status, err = f.h.ApproveAddressDeposit(context.Background(), q.ID)
			}
			if scenario == "buffer" {
				if err != nil {
					t.Fatal(err)
				}
				tx := f.accepted[status.TransactionHash]
				liability := new(big.Int).Mul(new(big.Int).SetUint64(tx.Gas()), tx.GasFeeCap())
				if liability.Cmp(quoteNumber(t, q.FeeReserveWei)) > 0 {
					t.Fatal("fee clamp exceeded approval")
				}
			} else if err == nil || len(f.submitted) != 0 {
				t.Fatalf("unsafe approval accepted: %s %+v %v", scenario, status, err)
			}
		})
	}
}
func TestNativeHighMarketFeeQuoteHasNoFixedETHCeiling(t *testing.T) {
	f := newAddressFixture(t, true)
	f.gas = "0x7a1200"
	f.gasPrice = "0x5d21dba000"
	f.eth = "0x56bc75e2d63100000"
	q, err := f.h.QuoteAddressDeposit(context.Background(), 100000)
	if err != nil {
		t.Fatal(err)
	}
	if quoteNumber(t, q.FeeReserveWei).Cmp(big.NewInt(20_000_000_000_000_000)) <= 0 {
		t.Fatal("fixture did not exceed old hard fee limit")
	}
	if _, err = f.h.ApproveAddressDeposit(context.Background(), q.ID); err != nil {
		t.Fatal("explicitly approved affordable high market fee was rejected", err)
	}
}
func TestNativeDepositSimulationUnsupportedOverrideFailsClosed(t *testing.T) {
	f := newAddressFixture(t, true)
	base := f.h.client.inference.Transport
	f.h.client.inference.Transport = withdrawalRoundTripper(func(r *http.Request) (*http.Response, error) {
		raw, err := ioReadAndRestore(r)
		if err != nil {
			return nil, err
		}
		var req struct {
			Method string            `json:"method"`
			Params []json.RawMessage `json:"params"`
		}
		_ = json.Unmarshal(raw, &req)
		if req.Method == "eth_call" && len(req.Params) == 3 {
			return withdrawalJSONResponse(r, 200, map[string]any{"jsonrpc": "2.0", "id": 1, "error": map[string]any{"message": "unsupported state overrides"}}), nil
		}
		return base.RoundTrip(r)
	})
	if _, err := f.h.QuoteAddressDeposit(context.Background(), 100000); err == nil || len(f.submitted) != 0 {
		t.Fatal("unsupported state override produced quote or broadcast")
	}
}
func TestNativeUSDIntentSurvivesRefreshWithoutRepricing(t *testing.T) {
	f := newAddressFixture(t, true)
	q, err := f.h.QuoteAddressDeposit(context.Background(), 100000)
	if err != nil {
		t.Fatal(err)
	}
	config, _ := f.h.config(context.Background())
	record, _ := f.h.loadAddress(config)
	record.DepositMicroUSD = 2_000_000
	record.DepositUSDUnits = q.Amount
	if err = f.h.saveAddress(record); err != nil {
		t.Fatal(err)
	}
	f.h = &FundingHandler{client: f.h.client, statePath: f.h.statePath}
	fresh, err := f.h.QuoteAddressDepositUSD(context.Background(), 2_000_000)
	if err != nil || fresh.Amount != q.Amount || fresh.InputMicroUSD != 2_000_000 {
		t.Fatalf("saved USD principal repriced: %+v %v", fresh, err)
	}
	fresh, err = f.h.QuoteAddressDeposit(context.Background(), q.Amount)
	if err != nil || fresh.InputMicroUSD != 0 {
		t.Fatal("explicit ETH entry did not clear USD intent")
	}
}
func TestNativeWithdrawalQuoteDoesNotSignAndBindsDestination(t *testing.T) {
	f := newWithdrawalFixture(t, true)
	q, err := f.h.QuoteAddressWithdrawal(context.Background(), withdrawalTestDestination, 12, "")
	if err != nil {
		t.Fatal(err)
	}
	if len(f.submitted) != 1 || q.Amount != 99999 || q.Destination != withdrawalTestDestination || q.PrincipalWei != "0" || f.journal(t).Pending != nil {
		t.Fatal("withdrawal quote signed or lost full balance binding")
	}
	status, err := f.h.ApproveAddressWithdrawal(context.Background(), q.ID)
	if err != nil || status.Phase != "withdrawal_pending" {
		t.Fatalf("withdrawal approval failed: %+v %v", status, err)
	}
	before := len(f.submitted)
	if _, err = f.h.QuoteAddressWithdrawal(context.Background(), withdrawalTestDestination, 12, ""); err == nil || len(f.submitted) != before {
		t.Fatal("readonly withdrawal quote replayed pending signed bytes")
	}
}
func TestNativePublicReturnRequiresClosedWalletAndExactApproval(t *testing.T) {
	f := newAddressFixture(t, true)
	if _, err := f.h.Address(context.Background()); err != nil {
		t.Fatal(err)
	}
	f.active = true
	if _, err := f.h.QuoteAddressReturn(context.Background(), withdrawalTestDestination, "100000000000000000"); err == nil {
		t.Fatal("return could consume active note gas")
	}
	f.active = false
	q, err := f.h.QuoteAddressReturn(context.Background(), withdrawalTestDestination, "100000000000000001")
	if err != nil {
		t.Fatal(err)
	}
	if q.PrincipalWei != "100000000000000001" || len(f.submitted) != 0 {
		t.Fatal("return quote rounded or signed")
	}
	status, err := f.h.ApproveAddressReturn(context.Background(), q.ID)
	if err != nil {
		t.Fatal(err)
	}
	tx := f.accepted[status.TransactionHash]
	if tx.Value().String() != q.PrincipalWei || !strings.EqualFold(tx.To().Hex(), withdrawalTestDestination) {
		t.Fatal("return changed value/destination")
	}
	f.h = &FundingHandler{client: f.h.client, statePath: f.h.statePath}
	again, err := f.h.ResumeAddressReturn(context.Background())
	if err != nil || again.TransactionHash != status.TransactionHash || len(f.submitted) != 2 || f.submitted[0] != f.submitted[1] {
		t.Fatal("return replay changed signed bytes")
	}
	f.receipts[status.TransactionHash] = map[string]any{"transactionHash": status.TransactionHash, "status": "0x1", "blockNumber": "0x10", "blockHash": addressTestBlock, "to": withdrawalTestDestination}
	f.nonce = "0x1"
	f.finalized = "0x1"
	if status, err = f.h.ResumeAddressReturn(context.Background()); err != nil || status.Phase != "return_pending" {
		t.Fatal("return completed before finality")
	}
	f.finalized = "0x20"
	status, err = f.h.ResumeAddressReturn(context.Background())
	if err != nil || status.Phase != "complete" {
		t.Fatalf("final return did not finish: %+v %v", status, err)
	}
	if _, err = f.h.AddressReturn(context.Background()); err != nil {
		t.Fatal("return journal did not survive completion", err)
	}
}
func TestNativePublicEOASweepUsesOneQuoteAndBlocksContract(t *testing.T) {
	f := newAddressFixture(t, true)
	f.gas = "0x5208"
	_, _ = f.h.Address(context.Background())
	q, err := f.h.QuoteAddressReturn(context.Background(), withdrawalTestDestination, "")
	if err != nil {
		t.Fatal(err)
	}
	if q.GasLimit != 21000 || new(big.Int).Add(quoteNumber(t, q.PrincipalWei), quoteNumber(t, q.FeeReserveWei)).Cmp(quoteNumber(t, q.BalanceWei)) != 0 {
		t.Fatal("sweep quote used a different fee reserve")
	}
	status, err := f.h.ApproveAddressReturn(context.Background(), q.ID)
	if err != nil {
		t.Fatal(err)
	}
	tx := f.accepted[status.TransactionHash]
	if tx.Value().String() != q.PrincipalWei || tx.Gas() != 21000 {
		t.Fatal("sweep signed different amount or gas")
	}
}
func TestPaymentQuoteGetterNeverSigns(t *testing.T) {
	f := newAddressFixture(t, true)
	q, err := f.h.QuoteAddressDeposit(context.Background(), 100000)
	if err != nil {
		t.Fatal(err)
	}
	before, _ := os.ReadFile(f.h.addressStatePath())
	got, err := f.h.SavedAddressQuote(context.Background(), "deposit")
	after, _ := os.ReadFile(f.h.addressStatePath())
	if err != nil || got.ID != q.ID || string(before) != string(after) || len(f.submitted) != 0 {
		t.Fatal("quote getter changed state")
	}
}
func ioReadAndRestore(r *http.Request) ([]byte, error) {
	raw, err := io.ReadAll(r.Body)
	r.Body = io.NopCloser(bytes.NewReader(raw))
	return raw, err
}

func TestFundingResumeCannotRetirePublicReturn(t *testing.T) {
	f := newAddressFixture(t, true)
	if _, err := f.h.QuoteAddressDeposit(context.Background(), 100000); err != nil {
		t.Fatal(err)
	}
	q, err := f.h.QuoteAddressReturn(context.Background(), withdrawalTestDestination, "1000000000")
	if err != nil {
		t.Fatal(err)
	}
	status, err := f.h.ApproveAddressReturn(context.Background(), q.ID)
	if err != nil {
		t.Fatal(err)
	}
	f.mine(t, status.TransactionHash, true)
	before, _ := os.ReadFile(f.h.addressStatePath())
	for i := 0; i < 2; i++ {
		if _, err = f.h.FundAddress(context.Background(), 100000); err == nil {
			t.Fatal("funding accepted return recovery")
		}
	}
	after, _ := os.ReadFile(f.h.addressStatePath())
	if string(before) != string(after) {
		t.Fatal("funding mutated return journal")
	}
	returned, err := f.h.ResumeAddressReturn(context.Background())
	if err != nil || returned.Phase != "reverted" {
		t.Fatalf("return recovery was damaged: %+v %v", returned, err)
	}
	if _, err = f.h.Address(context.Background()); err != nil {
		t.Fatal("custody journal invalid after return recovery", err)
	}
}
func TestCanonicalActualFeeRecordedOnlyAfterFinality(t *testing.T) {
	f := newAddressFixture(t, true)
	q, err := f.h.QuoteAddressDeposit(context.Background(), 100000)
	if err != nil {
		t.Fatal(err)
	}
	status, err := f.h.ApproveAddressDeposit(context.Background(), q.ID)
	if err != nil {
		t.Fatal(err)
	}
	f.mine(t, status.TransactionHash, false)
	f.receipts[status.TransactionHash]["gasUsed"] = "0x10000"
	f.receipts[status.TransactionHash]["effectiveGasPrice"] = "0x3b9aca00"
	f.finalized = "0x1"
	pending, err := f.h.FundAddress(context.Background(), 100000)
	if err != nil || pending.ActualFeeWei != "" {
		t.Fatal("unfinalized actual fee persisted")
	}
	f.finalized = "0x20"
	active, err := f.h.FundAddress(context.Background(), 100000)
	if err != nil || active.ActualFeeWei != "65536000000000" {
		t.Fatalf("canonical fee missing: %+v %v", active, err)
	}
	f.h = &FundingHandler{client: f.h.client, statePath: f.h.statePath}
	again, err := f.h.Address(context.Background())
	if err != nil || again.ActualFeeWei != active.ActualFeeWei {
		t.Fatal("actual fee lost on restart")
	}
}
func TestCanonicalFeeMetadataCannotExceedSignedLiability(t *testing.T) {
	for _, scenario := range []string{"gas", "price", "partial"} {
		t.Run(scenario, func(t *testing.T) {
			f := newAddressFixture(t, true)
			q, err := f.h.QuoteAddressDeposit(context.Background(), 100000)
			if err != nil {
				t.Fatal(err)
			}
			status, err := f.h.ApproveAddressDeposit(context.Background(), q.ID)
			if err != nil {
				t.Fatal(err)
			}
			f.mine(t, status.TransactionHash, false)
			tx := f.accepted[status.TransactionHash]
			receipt := f.receipts[status.TransactionHash]
			receipt["gasUsed"] = "0x10000"
			receipt["effectiveGasPrice"] = "0x3b9aca00"
			switch scenario {
			case "gas":
				receipt["gasUsed"] = "0x" + new(big.Int).SetUint64(tx.Gas()+1).Text(16)
			case "price":
				receipt["effectiveGasPrice"] = "0x" + new(big.Int).Add(tx.GasFeeCap(), big.NewInt(1)).Text(16)
			case "partial":
				delete(receipt, "gasUsed")
			}
			if _, err = f.h.FundAddress(context.Background(), 100000); err == nil || f.activated != 0 {
				t.Fatal("invalid actual fee metadata activated note")
			}
		})
	}
}

func TestNativeWithdrawalQuoteReservesSyntheticBalanceForSelfPayout(t *testing.T) {
	f := newWithdrawalFixture(t, true)
	address, err := f.h.Address(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	payout := new(big.Int).Mul(new(big.Int).SetUint64(f.walletBalance), big.NewInt(1_000_000_000))
	expectedOverride := new(big.Int).Sub(new(big.Int).Set(addressUint256Max), payout)
	upstream := f.h.client.inference.Transport
	quotedCalls := 0
	f.h.client.inference.Transport = withdrawalRoundTripper(func(r *http.Request) (*http.Response, error) {
		raw, err := ioReadAndRestore(r)
		if err != nil {
			return nil, err
		}
		var req struct {
			Method string            `json:"method"`
			Params []json.RawMessage `json:"params"`
		}
		_ = json.Unmarshal(raw, &req)
		if (req.Method == "eth_call" || req.Method == "eth_estimateGas") && len(req.Params) == 3 {
			quotedCalls++
			var call map[string]string
			var overrides map[string]map[string]string
			_ = json.Unmarshal(req.Params[0], &call)
			_ = json.Unmarshal(req.Params[2], &overrides)
			balance, e := feeQuantity(overrides[address.Address]["balance"])
			if e != nil || len(overrides) != 1 || len(overrides[address.Address]) != 1 || call["from"] != address.Address || call["value"] != "0x0" {
				t.Fatal("withdrawal quote changed more than sender balance")
			}
			// Model the live RPC's uint256 overflow when mutualClose credits
			// the sender. A UINT256_MAX override must fail this simulation.
			if new(big.Int).Add(balance, payout).BitLen() > 256 {
				return withdrawalJSONResponse(r, 200, map[string]any{"jsonrpc": "2.0", "id": 1, "error": map[string]any{"message": "balance overflow"}}), nil
			}
			if balance.Cmp(expectedOverride) != 0 {
				t.Fatal("quote did not reserve exactly the authorized payout")
			}
		}
		return upstream.RoundTrip(r)
	})
	before := len(f.submitted)
	quote, err := f.h.QuoteAddressWithdrawal(context.Background(), address.Address, f.noteID, "")
	if err != nil || quote.Destination != address.Address || quote.Amount != f.walletBalance || quotedCalls != 2 || len(f.submitted) != before {
		t.Fatalf("self-withdrawal quote failed or signed: %+v %v", quote, err)
	}
	status, err := f.h.ApproveAddressWithdrawal(context.Background(), quote.ID)
	if err != nil || status.Phase != "withdrawal_pending" || quotedCalls != 2 || len(f.submitted) != before+1 {
		t.Fatalf("approval did not use real balance without overrides: %+v %v", status, err)
	}
}
