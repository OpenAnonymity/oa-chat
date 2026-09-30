package main

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"

	"github.com/OpenAnonymity/oa-chat/daemon/internal/zkapi"
)

type fundingWizardUI struct {
	bytes.Buffer
	answers        []string
	confirmations  []bool
	asks, confirms int
}

func (u *fundingWizardUI) Printf(format string, args ...any) { fmt.Fprintf(&u.Buffer, format, args...) }
func (u *fundingWizardUI) Ask(context.Context, string, string) (string, error) {
	u.asks++
	if len(u.answers) == 0 {
		return "", errors.New("unexpected input request")
	}
	answer := u.answers[0]
	u.answers = u.answers[1:]
	return answer, nil
}
func (u *fundingWizardUI) Confirm(context.Context, string) (bool, error) {
	u.confirms++
	if len(u.confirmations) == 0 {
		return false, errors.New("unexpected approval request")
	}
	result := u.confirmations[0]
	u.confirmations = u.confirmations[1:]
	return result, nil
}

type wizardFundingFixture struct {
	quoteCalls, approveCalls, resumeCalls, readinessCalls int
	ready                                                 func(int) zkapi.WalletReadiness
	address                                               func() zkapi.AddressFundingStatus
	addressResult                                         func() (zkapi.AddressFundingStatus, error)
	quote                                                 func(int, uint64, uint64) (zkapi.AddressPaymentQuote, error)
	approve                                               func(string) (zkapi.AddressFundingStatus, error)
	resume                                                func(uint64) (zkapi.AddressFundingStatus, error)
	withdrawal                                            string
}

func wizardState(phase string) zkapi.AddressFundingStatus {
	q := wizardQuote()
	return zkapi.AddressFundingStatus{Phase: phase, Address: q.Address, ChainID: q.ChainID, DeploymentID: q.DeploymentID, BillingAsset: "native_eth", Amount: q.Amount, ETHBalance: q.BalanceWei, TransactionHash: "0x" + strings.Repeat("a", 64)}
}
func wizardQuote() zkapi.AddressPaymentQuote {
	q := paymentTestQuote("deposit")
	q.Commitment = "0x1234"
	return q
}
func newWizardFixture() *wizardFundingFixture {
	return &wizardFundingFixture{}
}
func (f *wizardFundingFixture) Readiness(context.Context) (zkapi.WalletReadiness, error) {
	f.readinessCalls++
	if f.ready != nil {
		return f.ready(f.readinessCalls), nil
	}
	return zkapi.WalletReadiness{HasNote: f.readinessCalls > 1, Balance: 750001}, nil
}
func (f *wizardFundingFixture) Address(context.Context) (zkapi.AddressFundingStatus, error) {
	if f.addressResult != nil {
		return f.addressResult()
	}
	if f.address != nil {
		return f.address(), nil
	}
	s := wizardState("ready")
	s.Amount = 0
	s.TransactionHash = ""
	return s, nil
}
func (f *wizardFundingFixture) Withdrawal(context.Context) (zkapi.AddressWithdrawalStatus, error) {
	phase := f.withdrawal
	if phase == "" {
		phase = "no_note"
	}
	return zkapi.AddressWithdrawalStatus{Phase: phase}, nil
}
func (f *wizardFundingFixture) Quote(_ context.Context, amount, usd uint64) (zkapi.AddressPaymentQuote, error) {
	f.quoteCalls++
	if f.quote != nil {
		return f.quote(f.quoteCalls, amount, usd)
	}
	q := wizardQuote()
	q.ID = fmt.Sprintf("%064x", f.quoteCalls)
	q.InputMicroUSD = usd
	return q, nil
}
func (f *wizardFundingFixture) Approve(_ context.Context, id string) (zkapi.AddressFundingStatus, error) {
	f.approveCalls++
	if f.approve != nil {
		return f.approve(id)
	}
	return wizardState("active"), nil
}
func (f *wizardFundingFixture) Resume(_ context.Context, amount uint64) (zkapi.AddressFundingStatus, error) {
	f.resumeCalls++
	if f.resume != nil {
		return f.resume(amount)
	}
	return wizardState("active"), nil
}
func immediateWizardPoll(ctx context.Context) error { return ctx.Err() }

func TestGuidedFundingWaitsForMoneyThenApprovesFreshFixedQuote(t *testing.T) {
	f := newWizardFixture()
	u := &fundingWizardUI{answers: []string{"20"}, confirmations: []bool{true}}
	f.quote = func(call int, amount, usd uint64) (zkapi.AddressPaymentQuote, error) {
		if call == 1 {
			if usd != 20_000_000 || amount != 0 {
				t.Fatal("initial USD selection changed")
			}
		} else if amount != 750001 || usd != 0 {
			t.Fatal("refresh repriced or changed the fixed principal")
		}
		q := wizardQuote()
		q.InputMicroUSD = usd
		q.ID = fmt.Sprintf("%064x", call)
		if call < 4 {
			q.BalanceWei = "0"
			q.ShortfallWei = q.RequiredTotalWei
			q.RecommendedTopUpWei = q.RecommendedTotalWei
		}
		return q, nil
	}
	f.approve = func(id string) (zkapi.AddressFundingStatus, error) {
		if id != fmt.Sprintf("%064x", 4) {
			t.Fatal("approved a stale quote")
		}
		return wizardState("deposit_pending"), nil
	}
	polls := 0
	err := guidedFunding(context.Background(), f, "", u, func(context.Context) error { polls++; return nil })
	if err != nil {
		t.Fatal(err)
	}
	if f.approveCalls != 1 || f.resumeCalls != 1 || f.quoteCalls != 4 || polls != 3 || u.confirms != 1 || u.asks != 1 {
		t.Fatalf("unexpected flow: %+v polls=%d UI=%+v", f, polls, u)
	}
	for _, want := range []string{"Funding address:", "Waiting for ETH:", "Funds received.", "Deposit finalized.", "Private balance:"} {
		if !strings.Contains(u.String(), want) {
			t.Fatalf("missing %q", want)
		}
	}
}

func TestGuidedFundingReadyWalletDoesNotAskOrDeposit(t *testing.T) {
	f := newWizardFixture()
	f.ready = func(int) zkapi.WalletReadiness { return zkapi.WalletReadiness{HasNote: true, Balance: 1} }
	u := &fundingWizardUI{}
	if err := guidedFunding(context.Background(), f, "", u, immediateWizardPoll); err != nil {
		t.Fatal(err)
	}
	if u.asks+u.confirms+f.quoteCalls+f.approveCalls != 0 {
		t.Fatal("ready wallet triggered funding")
	}
	if !strings.Contains(u.String(), "Private balance: 0.000000001 ETH.") || strings.Contains(u.String(), "model") {
		t.Fatal("wallet status depended on a model or omitted its positive balance")
	}
}

func TestGuidedFundingAmountPromptAndExplicitAmount(t *testing.T) {
	for _, test := range []struct {
		name, explicit, input string
		want                  uint64
		prompts               int
	}{
		{"enter accepts default", "", "\n", 20_000_000, 1},
		{"small deposit", "", "0.50\n", 500_000, 1},
		{"custom", "", " 12.50 \n", 12_500_000, 1},
		{"invalid then custom", "", "abc\n0\n-5\n1.0000001\n1000001\n3.000001\n", 3_000_001, 6},
		{"explicit", "0.50", "", 500_000, 0},
	} {
		t.Run(test.name, func(t *testing.T) {
			f := newWizardFixture()
			f.quote = func(_ int, amount, usd uint64) (zkapi.AddressPaymentQuote, error) {
				if amount != 0 || usd != test.want {
					t.Fatal("wrong selected deposit")
				}
				q := wizardQuote()
				q.InputMicroUSD = usd
				return q, nil
			}
			var output bytes.Buffer
			u := &terminalSetupPrompter{out: &output, input: bufio.NewReader(strings.NewReader(test.input + "no\n"))}
			err := guidedFunding(context.Background(), f, test.explicit, u, immediateWizardPoll)
			if err == nil || !strings.Contains(err.Error(), "declined") || f.quoteCalls != 1 || f.approveCalls+f.resumeCalls != 0 {
				t.Fatal("amount selection did not stop at declined consent", err)
			}
			if strings.Count(output.String(), "Deposit amount in USD (network fees are extra) [20]: ") != test.prompts {
				t.Fatal("incorrect amount prompt or default")
			}
		})
	}
}

func TestGuidedFundingAmountInputEndsBeforeQuoting(t *testing.T) {
	for _, input := range []string{"", "invalid\n"} {
		f := newWizardFixture()
		var output bytes.Buffer
		u := &terminalSetupPrompter{out: &output, input: bufio.NewReader(strings.NewReader(input))}
		err := guidedFunding(context.Background(), f, "", u, immediateWizardPoll)
		if err == nil || !strings.Contains(err.Error(), "input ended") || f.quoteCalls+f.approveCalls+f.resumeCalls != 0 {
			t.Fatal("ended amount input prepared or authorized a deposit", err)
		}
	}
}

func TestGuidedFundingRejectsEmptyOrReservedWallet(t *testing.T) {
	for _, kind := range []string{"empty balance", "companion reservation", "local reservation"} {
		t.Run(kind, func(t *testing.T) {
			f := newWizardFixture()
			balance := uint64(1)
			want := "a private withdrawal is reserved"
			if kind == "empty balance" {
				balance, want = 0, "the private balance is empty"
			}
			f.ready = func(int) zkapi.WalletReadiness {
				return zkapi.WalletReadiness{HasNote: true, Balance: balance, WithdrawalPending: kind == "companion reservation"}
			}
			if kind == "local reservation" {
				f.withdrawal = "quoted"
				want = "a withdrawal needs attention"
			}
			err := guidedFunding(context.Background(), f, "", &fundingWizardUI{}, immediateWizardPoll)
			if err == nil || !strings.Contains(err.Error(), want) || f.quoteCalls+f.approveCalls != 0 {
				t.Fatal("wallet guard failed or silently topped up", err)
			}
		})
	}
}

func TestGuidedFundingWaitsForSettlement(t *testing.T) {
	f := newWizardFixture()
	f.ready = func(n int) zkapi.WalletReadiness {
		return zkapi.WalletReadiness{HasNote: true, Balance: 750001, PendingRequest: n < 3}
	}
	polls := 0
	if err := guidedFunding(context.Background(), f, "", &fundingWizardUI{}, func(context.Context) error { polls++; return nil }); err != nil {
		t.Fatal(err)
	}
	if polls != 2 || f.approveCalls != 0 {
		t.Fatal("pending settlement was not waited out")
	}
}

func TestGuidedFundingDeclineNeverApproves(t *testing.T) {
	f := newWizardFixture()
	u := &fundingWizardUI{confirmations: []bool{false}}
	if err := guidedFunding(context.Background(), f, "2", u, immediateWizardPoll); err == nil {
		t.Fatal("decline did not stop")
	}
	if f.approveCalls != 0 || f.quoteCalls != 1 {
		t.Fatal("decline authorized funding")
	}
}

func TestSetupDepositDoesNotDisplayInconsistentPayment(t *testing.T) {
	q := wizardQuote()
	q.RecommendedTopUpWei = "1"
	ui := &fundingWizardUI{}
	if err := showSetupDeposit(ui, q); err == nil || ui.Len() != 0 {
		t.Fatal("inconsistent quote displayed payment instructions")
	}
}

func TestGuidedFundingFeeIncreaseNeedsNewConsent(t *testing.T) {
	for _, accept := range []bool{false, true} {
		t.Run(fmt.Sprint(accept), func(t *testing.T) {
			f := newWizardFixture()
			u := &fundingWizardUI{confirmations: []bool{true, accept}}
			f.quote = func(n int, amount, usd uint64) (zkapi.AddressPaymentQuote, error) {
				q := wizardQuote()
				q.InputMicroUSD = usd
				if n > 1 {
					q.FeeReserveWei = "31000"
					q.FeeBufferWei = "6000"
					q.RecommendedTotalWei = "750001000031000"
				}
				return q, nil
			}
			err := guidedFunding(context.Background(), f, "2", u, immediateWizardPoll)
			if (err == nil) != accept || u.confirms != 2 {
				t.Fatalf("wrong increased fee approval: %v", err)
			}
			expected := 0
			if accept {
				expected = 1
			}
			if f.approveCalls != expected {
				t.Fatal("increased fee signed without approval")
			}
			if accept && f.quoteCalls != 3 {
				t.Fatal("quote not refreshed after renewed consent")
			}
		})
	}
}

func TestGuidedFundingRejectsChangedOperation(t *testing.T) {
	changes := map[string]func(*zkapi.AddressPaymentQuote){
		"principal":   func(q *zkapi.AddressPaymentQuote) { q.Amount++ },
		"network":     func(q *zkapi.AddressPaymentQuote) { q.ChainID++ },
		"deployment":  func(q *zkapi.AddressPaymentQuote) { q.DeploymentID = "other" },
		"contract":    func(q *zkapi.AddressPaymentQuote) { q.Contract = q.Address },
		"address":     func(q *zkapi.AddressPaymentQuote) { q.Address = q.Contract },
		"commitment":  func(q *zkapi.AddressPaymentQuote) { q.Commitment = "0xabcd" },
		"nonce":       func(q *zkapi.AddressPaymentQuote) { q.Nonce++ },
		"revert":      func(q *zkapi.AddressPaymentQuote) { q.RetryHash = "0x" + strings.Repeat("b", 64) },
		"destination": func(q *zkapi.AddressPaymentQuote) { q.Destination = q.Address },
	}
	for name, change := range changes {
		t.Run(name, func(t *testing.T) {
			f := newWizardFixture()
			u := &fundingWizardUI{confirmations: []bool{true}}
			f.quote = func(n int, amount, usd uint64) (zkapi.AddressPaymentQuote, error) {
				q := wizardQuote()
				q.InputMicroUSD = usd
				if n > 1 {
					change(&q)
				}
				return q, nil
			}
			if err := guidedFunding(context.Background(), f, "2", u, immediateWizardPoll); err == nil || f.approveCalls != 0 {
				t.Fatal("changed deposit was authorized")
			}
		})
	}
}

func TestGuidedFundingCancellationLeavesUnsignedIntent(t *testing.T) {
	f := newWizardFixture()
	u := &fundingWizardUI{confirmations: []bool{true}}
	f.quote = func(n int, amount, usd uint64) (zkapi.AddressPaymentQuote, error) {
		q := wizardQuote()
		q.InputMicroUSD = usd
		q.BalanceWei = "1"
		q.ShortfallWei = "750001000024999"
		q.RecommendedTopUpWei = "750001000029999"
		return q, nil
	}
	err := guidedFunding(context.Background(), f, "2", u, func(context.Context) error { return context.Canceled })
	if !errors.Is(err, context.Canceled) || f.approveCalls != 0 {
		t.Fatal("cancellation authorized an unsigned deposit")
	}
}

func TestGuidedFundingRestartRecoversOnlySavedTransaction(t *testing.T) {
	f := newWizardFixture()
	f.address = func() zkapi.AddressFundingStatus { return wizardState("deposit_pending") }
	u := &fundingWizardUI{}
	if err := guidedFunding(context.Background(), f, "2", u, immediateWizardPoll); err != nil {
		t.Fatal(err)
	}
	if f.resumeCalls != 1 || f.quoteCalls+f.approveCalls+u.confirms+u.asks != 0 {
		t.Fatal("restart created a new deposit")
	}
}

func TestGuidedFundingSavedUnsignedPrincipalIsPreserved(t *testing.T) {
	f := newWizardFixture()
	f.address = func() zkapi.AddressFundingStatus { s := wizardState("waiting_funds"); s.TransactionHash = ""; return s }
	f.quote = func(n int, amount, usd uint64) (zkapi.AddressPaymentQuote, error) {
		if amount != 750001 || usd != 0 {
			t.Fatal("saved principal changed")
		}
		return wizardQuote(), nil
	}
	u := &fundingWizardUI{confirmations: []bool{true}}
	if err := guidedFunding(context.Background(), f, "3", u, immediateWizardPoll); err != nil {
		t.Fatal(err)
	}
	if u.asks != 0 || u.confirms != 1 {
		t.Fatal("saved intent did not require fresh consent")
	}
}

func TestGuidedFundingAmbiguousApprovalInspectsDurableState(t *testing.T) {
	for _, signed := range []bool{false, true} {
		t.Run(fmt.Sprint(signed), func(t *testing.T) {
			f := newWizardFixture()
			u := &fundingWizardUI{confirmations: []bool{true}}
			f.approve = func(string) (zkapi.AddressFundingStatus, error) {
				return zkapi.AddressFundingStatus{}, errors.New("lost reply")
			}
			f.address = func() zkapi.AddressFundingStatus {
				s := wizardState("waiting_funds")
				s.TransactionHash = ""
				if f.approveCalls == 0 {
					s.Amount = 0
					s.Phase = "ready"
				} else if signed {
					s = wizardState("deposit_pending")
				}
				return s
			}
			err := guidedFunding(context.Background(), f, "2", u, immediateWizardPoll)
			if (err == nil) != signed || f.approveCalls != 1 {
				t.Fatalf("ambiguous approval repeated or lost recovery: %v", err)
			}
			if signed && f.resumeCalls != 1 {
				t.Fatal("signed transaction not recovered")
			}
		})
	}
}

func TestGuidedFundingNeverRetriesRevertAfterLostResumeReply(t *testing.T) {
	f := newWizardFixture()
	f.address = func() zkapi.AddressFundingStatus {
		if f.resumeCalls > 0 {
			return wizardState("reverted")
		}
		return wizardState("deposit_pending")
	}
	f.resume = func(uint64) (zkapi.AddressFundingStatus, error) {
		return zkapi.AddressFundingStatus{}, errors.New("lost reply after persisting revert")
	}
	if err := guidedFunding(context.Background(), f, "", &fundingWizardUI{}, immediateWizardPoll); err == nil {
		t.Fatal("revert automatically retried")
	}
	if f.resumeCalls != 1 || f.approveCalls != 0 {
		t.Fatal("revert was replayed or reapproved")
	}
}

func TestGuidedFundingLostResumeAndStatusRepliesDoNotRepeatRecovery(t *testing.T) {
	f := newWizardFixture()
	reads := 0
	f.addressResult = func() (zkapi.AddressFundingStatus, error) {
		reads++
		if reads == 1 {
			return wizardState("deposit_pending"), nil
		}
		if reads == 2 {
			return zkapi.AddressFundingStatus{}, errors.New("status unavailable")
		}
		return wizardState("reverted"), nil
	}
	f.resume = func(uint64) (zkapi.AddressFundingStatus, error) {
		return zkapi.AddressFundingStatus{}, errors.New("lost reply after persisting revert")
	}
	if err := guidedFunding(context.Background(), f, "", &fundingWizardUI{}, immediateWizardPoll); err == nil {
		t.Fatal("revert automatically retried")
	}
	if f.resumeCalls != 1 || f.approveCalls != 0 || reads != 3 {
		t.Fatal("failed status read allowed another transaction recovery call")
	}
}
