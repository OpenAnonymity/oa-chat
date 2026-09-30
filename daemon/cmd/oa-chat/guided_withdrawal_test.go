package main

import (
	"context"
	"errors"
	"fmt"
	"math/big"
	"strings"
	"testing"

	"github.com/OpenAnonymity/oa-chat/daemon/internal/zkapi"
)

type withdrawalWizardFixture struct {
	statusCalls, quoteCalls, approveCalls, resumeCalls, confirmCalls int
	status                                                           func(int) (zkapi.AddressWithdrawalStatus, error)
	quote                                                            func(int, string, uint64, string) (zkapi.AddressPaymentQuote, error)
	approve                                                          func(string) (zkapi.AddressWithdrawalStatus, error)
	resume                                                           func(int, string, uint64) (zkapi.AddressWithdrawalStatus, error)
	confirm                                                          func(string, uint64, string) (zkapi.AddressWithdrawalStatus, error)
}

func withdrawalWizardQuote() zkapi.AddressPaymentQuote {
	q := paymentTestQuote("withdrawal")
	q.Binding = strings.Repeat("b", 64)
	return q
}

func withdrawalWizardState(phase string) zkapi.AddressWithdrawalStatus {
	q := withdrawalWizardQuote()
	s := zkapi.AddressWithdrawalStatus{Phase: phase, BillingAsset: "native_eth", ChainID: q.ChainID, DeploymentID: q.DeploymentID, Address: q.Address, NoteID: q.NoteID, Amount: q.Amount, PrivateBalance: q.Amount, ETHBalance: q.BalanceWei}
	if phase != "ready" && phase != "no_note" {
		s.Destination = q.Destination
	}
	if phase == "withdrawal_pending" || phase == "confirming" || phase == "complete" || phase == "reverted" {
		s.TransactionHash = "0x" + strings.Repeat("a", 64)
	}
	return s
}

func withdrawalQuoteFunds(q *zkapi.AddressPaymentQuote, balance, required, reserve int64) {
	q.BalanceWei, q.RequiredFeeWei, q.FeeReserveWei = fmt.Sprint(balance), fmt.Sprint(required), fmt.Sprint(reserve)
	q.FeeBufferWei = fmt.Sprint(reserve - required)
	q.RequiredTotalWei, q.RecommendedTotalWei = q.RequiredFeeWei, q.FeeReserveWei
	q.ShortfallWei, q.RecommendedTopUpWei = fmt.Sprint(max(0, required-balance)), fmt.Sprint(max(0, reserve-balance))
}

func (f *withdrawalWizardFixture) Status(context.Context) (zkapi.AddressWithdrawalStatus, error) {
	f.statusCalls++
	if f.status != nil {
		return f.status(f.statusCalls)
	}
	return withdrawalWizardState("ready"), nil
}
func (f *withdrawalWizardFixture) Quote(_ context.Context, destination string, note uint64, retry string) (zkapi.AddressPaymentQuote, error) {
	f.quoteCalls++
	if f.quote != nil {
		return f.quote(f.quoteCalls, destination, note, retry)
	}
	q := withdrawalWizardQuote()
	q.ID = fmt.Sprintf("%064x", f.quoteCalls)
	return q, nil
}
func (f *withdrawalWizardFixture) Approve(_ context.Context, id string) (zkapi.AddressWithdrawalStatus, error) {
	f.approveCalls++
	if f.approve != nil {
		return f.approve(id)
	}
	return withdrawalWizardState("withdrawal_pending"), nil
}
func (f *withdrawalWizardFixture) Resume(_ context.Context, destination string, note uint64) (zkapi.AddressWithdrawalStatus, error) {
	f.resumeCalls++
	if f.resume != nil {
		return f.resume(f.resumeCalls, destination, note)
	}
	return withdrawalWizardState("complete"), nil
}
func (f *withdrawalWizardFixture) Confirm(_ context.Context, destination string, note uint64, hash string) (zkapi.AddressWithdrawalStatus, error) {
	f.confirmCalls++
	if f.confirm != nil {
		return f.confirm(destination, note, hash)
	}
	return zkapi.AddressWithdrawalStatus{}, errors.New("unexpected confirmation")
}

func TestGuidedWithdrawalWaitsForFeesAndApprovesFreshQuote(t *testing.T) {
	f := &withdrawalWizardFixture{}
	u := &fundingWizardUI{answers: []string{withdrawalTestDestination}, confirmations: []bool{true}}
	f.quote = func(call int, destination string, note uint64, retry string) (zkapi.AddressPaymentQuote, error) {
		q := withdrawalWizardQuote()
		if destination != q.Destination || note != q.NoteID || retry != "" {
			t.Fatal("changed selected operation")
		}
		q.ID = fmt.Sprintf("%064x", call)
		balance := int64(50000)
		if call == 1 {
			balance = 0
		}
		if call == 2 {
			balance = 10000
		}
		withdrawalQuoteFunds(&q, balance, 25000, 30000)
		if call <= 2 && u.continues != 0 {
			t.Fatal("approval requested before funds")
		}
		return q, nil
	}
	f.approve = func(id string) (zkapi.AddressWithdrawalStatus, error) {
		if id != fmt.Sprintf("%064x", 4) {
			t.Fatal("approved stale quote")
		}
		return withdrawalWizardState("withdrawal_pending"), nil
	}
	if err := guidedWithdrawal(context.Background(), f, u, immediateWizardPoll); err != nil {
		t.Fatal(err)
	}
	if u.asks != 1 || u.continues != 1 || u.confirms != 0 || f.quoteCalls != 4 || f.approveCalls != 1 || f.resumeCalls != 1 {
		t.Fatalf("unexpected calls: ui=%+v service=%+v", u, f)
	}
	output := u.String()
	if strings.Count(output, "Scan with an Ethereum wallet") != 2 || strings.Count(output, "Destination:") != 1 || strings.Count(output, "Waiting for ETH:") != 2 {
		t.Fatal(output)
	}
	for _, forbidden := range []string{"withdrawal quote", "quoted:", "--approve", "Quote expires", "Local signing address"} {
		if strings.Contains(output, forbidden) {
			t.Fatalf("verbose legacy output %q: %s", forbidden, output)
		}
	}
}

func TestGuidedWithdrawalFundedNeedsNoPaymentQR(t *testing.T) {
	f := &withdrawalWizardFixture{}
	u := &fundingWizardUI{answers: []string{withdrawalTestDestination}, confirmations: []bool{true}}
	if err := guidedWithdrawal(context.Background(), f, u, immediateWizardPoll); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(u.String(), "Payment URI") || strings.Contains(u.String(), "receiving account") || f.quoteCalls != 2 || f.approveCalls != 1 {
		t.Fatal(u.String())
	}
}

func TestGuidedWithdrawalDeclineOrCancellationCannotApprove(t *testing.T) {
	for _, cancel := range []bool{false, true} {
		t.Run(fmt.Sprint(cancel), func(t *testing.T) {
			f := &withdrawalWizardFixture{}
			u := &fundingWizardUI{answers: []string{withdrawalTestDestination}, confirmations: []bool{false}}
			ctx, stop := context.WithCancel(context.Background())
			defer stop()
			if cancel {
				f.quote = func(int, string, uint64, string) (zkapi.AddressPaymentQuote, error) {
					q := withdrawalWizardQuote()
					withdrawalQuoteFunds(&q, 0, 25000, 30000)
					return q, nil
				}
			}
			err := guidedWithdrawal(ctx, f, u, func(ctx context.Context) error { stop(); return ctx.Err() })
			if err == nil || f.approveCalls != 0 || f.resumeCalls != 0 {
				t.Fatalf("err=%v approvals=%d resumes=%d", err, f.approveCalls, f.resumeCalls)
			}
			if cancel && u.continues != 0 {
				t.Fatal("asked for approval while waiting")
			}
		})
	}
}

func TestGuidedWithdrawalRejectsQuoteIdentityChangesAfterEnter(t *testing.T) {
	mutations := map[string]func(*zkapi.AddressPaymentQuote){
		"chain":       func(q *zkapi.AddressPaymentQuote) { q.ChainID++ },
		"deployment":  func(q *zkapi.AddressPaymentQuote) { q.DeploymentID += "changed" },
		"address":     func(q *zkapi.AddressPaymentQuote) { q.Address = withdrawalTestDestination },
		"contract":    func(q *zkapi.AddressPaymentQuote) { q.Contract = withdrawalTestDestination },
		"note":        func(q *zkapi.AddressPaymentQuote) { q.NoteID++ },
		"destination": func(q *zkapi.AddressPaymentQuote) { q.Destination = q.Address },
		"amount":      func(q *zkapi.AddressPaymentQuote) { q.Amount++ },
		"principal":   func(q *zkapi.AddressPaymentQuote) { q.PrincipalWei = "1" },
		"binding":     func(q *zkapi.AddressPaymentQuote) { q.Binding += "changed" },
		"nonce":       func(q *zkapi.AddressPaymentQuote) { q.Nonce++ },
		"retry":       func(q *zkapi.AddressPaymentQuote) { q.RetryHash = "0x" + strings.Repeat("c", 64) },
	}
	for name, mutate := range mutations {
		t.Run(name, func(t *testing.T) {
			f := &withdrawalWizardFixture{}
			u := &fundingWizardUI{answers: []string{withdrawalTestDestination}, confirmations: []bool{true}}
			f.quote = func(call int, _ string, _ uint64, _ string) (zkapi.AddressPaymentQuote, error) {
				q := withdrawalWizardQuote()
				if call == 2 {
					mutate(&q)
				}
				return q, nil
			}
			if err := guidedWithdrawal(context.Background(), f, u, immediateWizardPoll); err == nil || f.approveCalls != 0 {
				t.Fatalf("mutation approved: %v", err)
			}
		})
	}
}

func TestGuidedWithdrawalFeeIncreaseOrBalanceLossRequiresNewEnter(t *testing.T) {
	for _, loss := range []bool{false, true} {
		t.Run(fmt.Sprint(loss), func(t *testing.T) {
			f := &withdrawalWizardFixture{}
			u := &fundingWizardUI{answers: []string{withdrawalTestDestination}, confirmations: []bool{true, true}}
			f.quote = func(call int, _ string, _ uint64, _ string) (zkapi.AddressPaymentQuote, error) {
				q := withdrawalWizardQuote()
				q.ID = fmt.Sprintf("%064x", call)
				if call >= 2 {
					withdrawalQuoteFunds(&q, 50000, 35000, 40000)
				}
				if loss && call == 2 {
					withdrawalQuoteFunds(&q, 0, 25000, 30000)
				}
				return q, nil
			}
			if err := guidedWithdrawal(context.Background(), f, u, immediateWizardPoll); err != nil {
				t.Fatal(err)
			}
			if u.continues != 2 || f.approveCalls != 1 {
				t.Fatalf("unexpected approvals: %+v %+v", u, f)
			}
		})
	}
}

func TestGuidedWithdrawalSettlementWaitUsesOnlyUnsignedQuotes(t *testing.T) {
	f := &withdrawalWizardFixture{}
	u := &fundingWizardUI{answers: []string{withdrawalTestDestination}, confirmations: []bool{true}}
	f.status = func(call int) (zkapi.AddressWithdrawalStatus, error) {
		s := withdrawalWizardState("waiting_settlement")
		s.Amount = 0
		if call == 1 {
			s.Destination = ""
		}
		return s, nil
	}
	f.quote = func(call int, _ string, _ uint64, _ string) (zkapi.AddressPaymentQuote, error) {
		if call <= 2 {
			return zkapi.AddressPaymentQuote{}, errors.New("waiting settlement")
		}
		return withdrawalWizardQuote(), nil
	}
	if err := guidedWithdrawal(context.Background(), f, u, immediateWizardPoll); err != nil {
		t.Fatal(err)
	}
	if strings.Count(u.String(), "Waiting for your previous inference") != 1 || f.quoteCalls != 4 || f.resumeCalls != 1 || f.approveCalls != 1 {
		t.Fatal(u.String())
	}
}

func TestGuidedWithdrawalZeroBalanceStillClosesNote(t *testing.T) {
	f := &withdrawalWizardFixture{}
	u := &fundingWizardUI{answers: []string{withdrawalTestDestination}, confirmations: []bool{true}}
	f.quote = func(int, string, uint64, string) (zkapi.AddressPaymentQuote, error) {
		q := withdrawalWizardQuote()
		q.Amount = 0
		return q, nil
	}
	f.approve = func(string) (zkapi.AddressWithdrawalStatus, error) {
		s := withdrawalWizardState("complete")
		s.Amount = 0
		return s, nil
	}
	if err := guidedWithdrawal(context.Background(), f, u, immediateWizardPoll); err != nil {
		t.Fatal(err)
	}
	if f.approveCalls != 1 {
		t.Fatal("zero-balance note was not closed")
	}
}

func TestGuidedWithdrawalLostApprovalReplyResumesOnlySavedTransaction(t *testing.T) {
	f := &withdrawalWizardFixture{}
	u := &fundingWizardUI{answers: []string{withdrawalTestDestination}, confirmations: []bool{true}}
	f.status = func(call int) (zkapi.AddressWithdrawalStatus, error) {
		if call == 1 {
			return withdrawalWizardState("ready"), nil
		}
		return withdrawalWizardState("withdrawal_pending"), nil
	}
	f.approve = func(string) (zkapi.AddressWithdrawalStatus, error) {
		return zkapi.AddressWithdrawalStatus{}, errors.New("lost reply")
	}
	if err := guidedWithdrawal(context.Background(), f, u, immediateWizardPoll); err != nil {
		t.Fatal(err)
	}
	if f.approveCalls != 1 || f.quoteCalls != 2 || f.resumeCalls != 1 {
		t.Fatalf("duplicate authorization: %+v", f)
	}
}

func TestGuidedWithdrawalSignedRecoveryNeverPromptsOrRetriesRevert(t *testing.T) {
	for _, phase := range []string{"complete", "reverted"} {
		t.Run(phase, func(t *testing.T) {
			f := &withdrawalWizardFixture{}
			u := &fundingWizardUI{}
			f.status = func(int) (zkapi.AddressWithdrawalStatus, error) {
				return withdrawalWizardState("withdrawal_pending"), nil
			}
			f.resume = func(int, string, uint64) (zkapi.AddressWithdrawalStatus, error) {
				return withdrawalWizardState(phase), nil
			}
			err := guidedWithdrawal(context.Background(), f, u, immediateWizardPoll)
			if (err != nil) != (phase == "reverted") || u.asks != 0 || u.continues != 0 || f.quoteCalls != 0 || f.approveCalls != 0 || f.resumeCalls != 1 {
				t.Fatalf("unexpected recovery: err=%v service=%+v", err, f)
			}
		})
	}
}

func TestGuidedWithdrawalSignedRecoveryRejectsChangedTransactionOrWallet(t *testing.T) {
	for _, mutate := range []func(*zkapi.AddressWithdrawalStatus){
		func(s *zkapi.AddressWithdrawalStatus) { s.TransactionHash = "0x" + strings.Repeat("b", 64) },
		func(s *zkapi.AddressWithdrawalStatus) { s.NoteID++ },
		func(s *zkapi.AddressWithdrawalStatus) { s.Amount++ },
		func(s *zkapi.AddressWithdrawalStatus) { s.Destination = s.Address },
		func(s *zkapi.AddressWithdrawalStatus) { s.ChainID++ },
		func(s *zkapi.AddressWithdrawalStatus) { s.DeploymentID += "changed" },
	} {
		f := &withdrawalWizardFixture{}
		f.status = func(int) (zkapi.AddressWithdrawalStatus, error) {
			return withdrawalWizardState("withdrawal_pending"), nil
		}
		f.resume = func(int, string, uint64) (zkapi.AddressWithdrawalStatus, error) {
			s := withdrawalWizardState("complete")
			mutate(&s)
			return s, nil
		}
		if err := guidedWithdrawal(context.Background(), f, &fundingWizardUI{}, immediateWizardPoll); err == nil {
			t.Fatal("accepted changed saved operation")
		}
	}
}

func TestGuidedWithdrawalInterruptedUnsignedApprovalStops(t *testing.T) {
	f := &withdrawalWizardFixture{}
	u := &fundingWizardUI{answers: []string{withdrawalTestDestination}, confirmations: []bool{true}}
	f.status = func(call int) (zkapi.AddressWithdrawalStatus, error) {
		if call == 1 {
			return withdrawalWizardState("ready"), nil
		}
		return withdrawalWizardState("waiting_funds"), nil
	}
	f.approve = func(string) (zkapi.AddressWithdrawalStatus, error) {
		return zkapi.AddressWithdrawalStatus{}, errors.New("lost reply")
	}
	if err := guidedWithdrawal(context.Background(), f, u, immediateWizardPoll); err == nil || f.approveCalls != 1 || f.resumeCalls != 0 {
		t.Fatalf("unsafe continuation: err=%v %+v", err, f)
	}
}

func TestGuidedWithdrawalRevertedRetryBindsFailedHashAndCannotRetryAgain(t *testing.T) {
	f := &withdrawalWizardFixture{}
	u := &fundingWizardUI{answers: []string{"retry"}, confirmations: []bool{true}}
	failed := withdrawalWizardState("reverted")
	f.status = func(int) (zkapi.AddressWithdrawalStatus, error) { return failed, nil }
	f.quote = func(_ int, destination string, note uint64, retry string) (zkapi.AddressPaymentQuote, error) {
		if destination != failed.Destination || note != failed.NoteID || retry != failed.TransactionHash {
			t.Fatal("lost failed transaction binding")
		}
		q := withdrawalWizardQuote()
		q.RetryHash = retry
		return q, nil
	}
	f.approve = func(string) (zkapi.AddressWithdrawalStatus, error) {
		s := withdrawalWizardState("withdrawal_pending")
		s.TransactionHash = "0x" + strings.Repeat("c", 64)
		return s, nil
	}
	f.resume = func(int, string, uint64) (zkapi.AddressWithdrawalStatus, error) {
		s := withdrawalWizardState("reverted")
		s.TransactionHash = "0x" + strings.Repeat("c", 64)
		return s, nil
	}
	if err := guidedWithdrawal(context.Background(), f, u, immediateWizardPoll); err == nil || f.approveCalls != 1 || f.quoteCalls != 2 || f.resumeCalls != 1 {
		t.Fatalf("unsafe repeat: err=%v %+v", err, f)
	}
}

func TestGuidedWithdrawalQRRefreshOnlyWhenBufferExhausted(t *testing.T) {
	f := &withdrawalWizardFixture{}
	u := &fundingWizardUI{answers: []string{withdrawalTestDestination}, confirmations: []bool{true}}
	f.quote = func(call int, _ string, _ uint64, _ string) (zkapi.AddressPaymentQuote, error) {
		q := withdrawalWizardQuote()
		switch call {
		case 1:
			withdrawalQuoteFunds(&q, 0, 25000, 30000)
		case 2:
			withdrawalQuoteFunds(&q, 0, 29000, 34000)
		case 3:
			withdrawalQuoteFunds(&q, 0, 31000, 36000)
		default:
			withdrawalQuoteFunds(&q, 50000, 31000, 36000)
		}
		return q, nil
	}
	if err := guidedWithdrawal(context.Background(), f, u, immediateWizardPoll); err != nil {
		t.Fatal(err)
	}
	if strings.Count(u.String(), "Scan with an Ethereum wallet") != 2 || strings.Count(u.String(), "Waiting for ETH:") != 3 {
		t.Fatal(u.String())
	}
}

func TestGuidedWithdrawalRejectsMalformedFeeQuoteWithoutPaymentInstructions(t *testing.T) {
	f := &withdrawalWizardFixture{}
	u := &fundingWizardUI{answers: []string{withdrawalTestDestination}}
	f.quote = func(int, string, uint64, string) (zkapi.AddressPaymentQuote, error) {
		q := withdrawalWizardQuote()
		q.RequiredTotalWei = new(big.Int).Lsh(big.NewInt(1), 257).String()
		return q, nil
	}
	if err := guidedWithdrawal(context.Background(), f, u, immediateWizardPoll); err == nil || strings.Contains(u.String(), "Payment URI") || f.approveCalls != 0 {
		t.Fatalf("malformed payment shown: err=%v %s", err, u.String())
	}
}

func TestGuidedWithdrawalSavedUnsignedDestinationNeedsNoInput(t *testing.T) {
	f := &withdrawalWizardFixture{}
	u := &fundingWizardUI{confirmations: []bool{true}}
	f.status = func(int) (zkapi.AddressWithdrawalStatus, error) {
		return withdrawalWizardState("waiting_funds"), nil
	}
	if err := guidedWithdrawal(context.Background(), f, u, immediateWizardPoll); err != nil {
		t.Fatal(err)
	}
	if u.asks != 0 || u.continues != 1 || f.approveCalls != 1 {
		t.Fatal("saved destination should be reused without another question")
	}
}

func TestGuidedWithdrawalEmptyOrCompletedWalletNeverTransacts(t *testing.T) {
	for _, phase := range []string{"no_note", "complete"} {
		t.Run(phase, func(t *testing.T) {
			f := &withdrawalWizardFixture{}
			u := &fundingWizardUI{}
			f.status = func(int) (zkapi.AddressWithdrawalStatus, error) { return withdrawalWizardState(phase), nil }
			if err := guidedWithdrawal(context.Background(), f, u, immediateWizardPoll); err != nil {
				t.Fatal(err)
			}
			if u.asks != 0 || u.continues != 0 || f.quoteCalls != 0 || f.approveCalls != 0 || f.resumeCalls != 0 {
				t.Fatal("repeated completed action must not send a new transaction")
			}
		})
	}
}

func TestGuidedWithdrawalBalanceLostDuringApprovalWaitsAndNeedsNewEnter(t *testing.T) {
	f := &withdrawalWizardFixture{}
	u := &fundingWizardUI{answers: []string{withdrawalTestDestination}, confirmations: []bool{true, true}}
	f.approve = func(string) (zkapi.AddressWithdrawalStatus, error) {
		if f.approveCalls == 1 {
			return withdrawalWizardState("waiting_funds"), nil
		}
		return withdrawalWizardState("complete"), nil
	}
	f.quote = func(call int, _ string, _ uint64, _ string) (zkapi.AddressPaymentQuote, error) {
		q := withdrawalWizardQuote()
		if call == 3 {
			withdrawalQuoteFunds(&q, 0, 25000, 30000)
		}
		return q, nil
	}
	if err := guidedWithdrawal(context.Background(), f, u, immediateWizardPoll); err != nil {
		t.Fatal(err)
	}
	if u.continues != 2 || f.approveCalls != 2 || f.resumeCalls != 0 {
		t.Fatalf("unsigned failure must wait and ask again: %+v %+v", u, f)
	}
}

func TestGuidedWithdrawalTransientQuoteFailuresPrintOnce(t *testing.T) {
	f := &withdrawalWizardFixture{}
	u := &fundingWizardUI{answers: []string{withdrawalTestDestination}, confirmations: []bool{true}}
	f.quote = func(call int, _ string, _ uint64, _ string) (zkapi.AddressPaymentQuote, error) {
		if call <= 3 {
			return zkapi.AddressPaymentQuote{}, errors.New("temporary error")
		}
		return withdrawalWizardQuote(), nil
	}
	if err := guidedWithdrawal(context.Background(), f, u, immediateWizardPoll); err != nil {
		t.Fatal(err)
	}
	if strings.Count(u.String(), "Could not refresh withdrawal fees") != 1 || f.approveCalls != 1 || f.resumeCalls != 1 {
		t.Fatal(u.String())
	}
}

func TestGuidedWithdrawalInterruptedRecoveryReadsRevertBeforeResume(t *testing.T) {
	f := &withdrawalWizardFixture{}
	f.status = func(call int) (zkapi.AddressWithdrawalStatus, error) {
		if call == 1 {
			return withdrawalWizardState("withdrawal_pending"), nil
		}
		return withdrawalWizardState("reverted"), nil
	}
	f.resume = func(int, string, uint64) (zkapi.AddressWithdrawalStatus, error) {
		return zkapi.AddressWithdrawalStatus{}, errors.New("lost reply")
	}
	if err := guidedWithdrawal(context.Background(), f, &fundingWizardUI{}, immediateWizardPoll); err == nil || f.resumeCalls != 1 || f.quoteCalls != 0 || f.approveCalls != 0 {
		t.Fatalf("must inspect revert before another recovery call: %v %+v", err, f)
	}
}

func TestGuidedWithdrawalConfirmSeparatePayoutPreservesBinding(t *testing.T) {
	f := &withdrawalWizardFixture{}
	hash := "0x" + strings.Repeat("f", 64)
	u := &fundingWizardUI{answers: []string{"confirm", hash}}
	f.status = func(int) (zkapi.AddressWithdrawalStatus, error) {
		return withdrawalWizardState("reverted"), nil
	}
	f.confirm = func(destination string, note uint64, confirmation string) (zkapi.AddressWithdrawalStatus, error) {
		state := withdrawalWizardState("complete")
		if destination != state.Destination || note != state.NoteID || confirmation != hash {
			t.Fatal("confirmation changed operation")
		}
		state.TransactionHash = hash
		return state, nil
	}
	if err := guidedWithdrawal(context.Background(), f, u, immediateWizardPoll); err != nil {
		t.Fatal(err)
	}
	if f.confirmCalls != 1 || f.quoteCalls != 0 || f.approveCalls != 0 || f.resumeCalls != 0 {
		t.Fatal("receipt confirmation must not sign another transaction")
	}
}
