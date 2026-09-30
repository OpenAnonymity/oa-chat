package main

import (
	"context"
	"errors"
	"math/big"
	"net/http"
	"strconv"
	"strings"

	"github.com/OpenAnonymity/oa-chat/daemon/internal/config"
	"github.com/OpenAnonymity/oa-chat/daemon/internal/relay"
	"github.com/OpenAnonymity/oa-chat/daemon/internal/zkapi"
)

// The wizard uses the same owner-authenticated quote/approval endpoints as
// manual funding. It never reads signing keys or signs transactions itself.
type guidedFundingService interface {
	Readiness(context.Context) (zkapi.WalletReadiness, error)
	Address(context.Context) (zkapi.AddressFundingStatus, error)
	Withdrawal(context.Context) (zkapi.AddressWithdrawalStatus, error)
	Quote(context.Context, uint64, uint64) (zkapi.AddressPaymentQuote, error)
	Approve(context.Context, string) (zkapi.AddressFundingStatus, error)
	Resume(context.Context, uint64) (zkapi.AddressFundingStatus, error)
}

type localGuidedFunding struct {
	config config.Config
	wallet *zkapi.Client
}

func (s localGuidedFunding) Readiness(ctx context.Context) (zkapi.WalletReadiness, error) {
	return s.wallet.Readiness(ctx)
}
func (s localGuidedFunding) Address(ctx context.Context) (zkapi.AddressFundingStatus, error) {
	return requestFunding(ctx, s.config, http.MethodGet, "/admin/funding/address", nil)
}
func (s localGuidedFunding) Withdrawal(ctx context.Context) (zkapi.AddressWithdrawalStatus, error) {
	return requestWithdrawal(ctx, s.config, http.MethodGet, nil)
}
func (s localGuidedFunding) Quote(ctx context.Context, amount, usd uint64) (zkapi.AddressPaymentQuote, error) {
	body := map[string]uint64{"amount": amount}
	if usd != 0 {
		body = map[string]uint64{"micro_usd": usd}
	}
	return requestPaymentQuote(ctx, s.config, http.MethodPost, "/admin/funding/quote", "deposit", body)
}
func (s localGuidedFunding) Approve(ctx context.Context, id string) (zkapi.AddressFundingStatus, error) {
	return requestFunding(ctx, s.config, http.MethodPost, "/admin/funding/approve", map[string]string{"quote_id": id})
}
func (s localGuidedFunding) Resume(ctx context.Context, amount uint64) (zkapi.AddressFundingStatus, error) {
	return requestFunding(ctx, s.config, http.MethodPost, "/admin/funding/deposit", map[string]uint64{"amount": amount})
}

func runGuidedFunding(ctx context.Context, c config.Config, usdText, _ string, ui setupPrompter) error {
	transport, err := relay.NewClient(c.RelayURL)
	if err != nil {
		return err
	}
	wallet, err := zkapi.New(zkConfig(c, transport))
	if err != nil {
		return err
	}
	return guidedFunding(ctx, localGuidedFunding{c, wallet}, usdText, ui, waitFundingPoll)
}

func setupUSD(amount uint64) string {
	return strings.TrimRight(strings.TrimRight(fundingUnits(strconv.FormatUint(amount, 10), 6), "0"), ".")
}

const defaultSetupDepositMicroUSD uint64 = 20_000_000

func chooseSetupDepositUSD(ctx context.Context, usdText string, ui setupPrompter) (uint64, error) {
	interactive := usdText == ""
	for {
		if interactive {
			var err error
			usdText, err = ui.Ask(ctx, "Deposit amount in USD (network fees are extra)", setupUSD(defaultSetupDepositMicroUSD))
			if err != nil {
				return 0, err
			}
		}
		usd, err := parseFundingAmountForAsset(usdText, 6, "USD")
		if err == nil || !interactive {
			return usd, err
		}
		ui.Printf("%s. Please enter a deposit amount in USD.\n", err)
	}
}

func guidedFunding(ctx context.Context, service guidedFundingService, usdText string, ui setupPrompter, wait func(context.Context) error) error {
	ui.Printf("Checking wallet status...\n")
	ready, err := waitSetupWallet(ctx, service, ui, wait)
	if err != nil {
		return err
	}
	if ready.HasNote {
		return checkSetupBalance(ready, ui)
	}

	state, err := service.Address(ctx)
	if err != nil {
		return err
	}
	if state.BillingAsset != "native_eth" {
		return errors.New("this setup requires the native ETH deployment; keep legacy wallet recovery separate")
	}
	switch state.Phase {
	case "deposit_pending", "confirming":
		ui.Printf("Resuming your saved deposit; no new deposit will be created.\n")
		if err := finishGuidedDeposit(ctx, service, state, ui, wait); err != nil {
			return err
		}
	case "ready", "waiting_funds":
		if state.TransactionHash != "" {
			return errors.New("a saved transaction needs recovery; run oa-chat config before continuing")
		}
		var usd uint64
		if state.Amount == 0 {
			usd, err = chooseSetupDepositUSD(ctx, usdText, ui)
			if err != nil {
				return err
			}
			ui.Printf("Selected deposit: $%s (network fees are extra).\n", setupUSD(usd))
		} else {
			ui.Printf("Resuming the saved fixed deposit of %s ETH.\n", fundingUnits(strconv.FormatUint(state.Amount, 10), 9))
			if usdText != "" {
				ui.Printf("The --usd option applies only to a new deposit; the saved amount is preserved.\n")
			}
		}
		ui.Printf("Preparing your deposit quote from the current ETH price and network fees...\n")
		quote, err := service.Quote(ctx, state.Amount, usd)
		if err != nil {
			return err
		}
		if (usd != 0 && quote.InputMicroUSD != usd) || (state.Amount != 0 && quote.Amount != state.Amount) || !strings.EqualFold(quote.Address, state.Address) || quote.ChainID != state.ChainID || quote.DeploymentID != state.DeploymentID {
			return errors.New("deposit quote changed the selected wallet or amount; stopped setup")
		}
		if err := waitAndDeposit(ctx, service, quote, ui, wait); err != nil {
			return err
		}
	default:
		return errors.New("saved funding needs attention; run oa-chat config with the same configuration before restarting setup")
	}
	ready, err = waitSetupWallet(ctx, service, ui, wait)
	if err != nil {
		return err
	}
	if !ready.HasNote {
		return errors.New("deposit recovery did not activate the private balance; run oa-chat config with the same configuration")
	}
	return checkSetupBalance(ready, ui)
}

func waitSetupWallet(ctx context.Context, service guidedFundingService, ui setupPrompter, wait func(context.Context) error) (zkapi.WalletReadiness, error) {
	waiting := false
	for {
		state, err := service.Readiness(ctx)
		if err != nil {
			return state, err
		}
		withdrawal, err := service.Withdrawal(ctx)
		if err != nil {
			return state, err
		}
		switch withdrawal.Phase {
		case "no_note", "ready", "waiting_settlement", "complete":
		default:
			return state, errors.New("a withdrawal needs attention; run oa-chat config --menu and choose withdraw before restarting setup")
		}
		if state.WithdrawalPending {
			return state, errors.New("a private withdrawal is reserved; run oa-chat config --menu and choose withdraw to recover it")
		}
		if !state.PendingRequest && withdrawal.Phase != "waiting_settlement" {
			return state, nil
		}
		if !waiting {
			ui.Printf("Waiting for your previous inference to settle; checking automatically.\n")
			waiting = true
		}
		if err := wait(ctx); err != nil {
			return state, err
		}
	}
}

// Wallet setup is independent of model choice. Inference checks the selected
// model's request cap against the current private balance on every request.
func checkSetupBalance(state zkapi.WalletReadiness, ui setupPrompter) error {
	if state.Balance == 0 {
		return errors.New("the private balance is empty; choose withdraw in oa-chat config --menu to close this note before adding funding")
	}
	ui.Printf("Private balance: %s ETH.\n", fundingUnits(strconv.FormatUint(state.Balance, 10), 9))
	return nil
}

func sameSetupDeposit(a, b zkapi.AddressPaymentQuote) bool {
	return a.Kind == "deposit" && b.Kind == a.Kind && a.ChainID == b.ChainID && a.DeploymentID == b.DeploymentID && strings.EqualFold(a.Contract, b.Contract) && strings.EqualFold(a.Address, b.Address) && a.Amount == b.Amount && a.PrincipalWei == b.PrincipalWei && a.Commitment != "" && a.Commitment == b.Commitment && a.Nonce == b.Nonce && a.RetryHash == "" && b.RetryHash == "" && b.Destination == "" && b.NoteID == 0
}

func setupFeeWithin(quote zkapi.AddressPaymentQuote, maximum string) bool {
	fee, ok := new(big.Int).SetString(quote.FeeReserveWei, 10)
	cap, valid := new(big.Int).SetString(maximum, 10)
	return ok && valid && fee.Sign() >= 0 && cap.Sign() >= 0 && fee.Cmp(cap) <= 0
}

func showSetupDeposit(ui setupPrompter, q zkapi.AddressPaymentQuote) error {
	// Validate the payment quantities before displaying even the text address
	// and amount, so an inconsistent quote cannot invite an incorrect transfer.
	if _, err := paymentRequestURI(q); err != nil {
		return err
	}
	ui.Printf("\n%s\nFunding address: %s\nReceiving account balance: %s ETH\nPrivate deposit: %s ETH\nEstimated network fee: %s ETH\nMaximum network fee: %s ETH\n", fundingNetwork(q.ChainID), q.Address, fundingUnits(q.BalanceWei, 18), fundingUnits(q.PrincipalWei, 18), fundingUnits(q.ExpectedFeeWei, 18), fundingUnits(q.FeeReserveWei, 18))
	ui.Printf("Required top-up: %s ETH\nRecommended top-up including fee buffer: %s ETH\n", fundingUnits(q.ShortfallWei, 18), fundingUnits(q.RecommendedTopUpWei, 18))
	return printSetupPaymentQR(setupUIWriter{ui}, q)
}

func waitAndDeposit(ctx context.Context, service guidedFundingService, initial zkapi.AddressPaymentQuote, ui setupPrompter, wait func(context.Context) error) error {
	if !sameSetupDeposit(initial, initial) {
		return errors.New("saved deposit requires explicit recovery; it cannot be automatically funded")
	}
	if err := showSetupDeposit(ui, initial); err != nil {
		return err
	}
	ui.Printf("Watching the receiving account on %s at %s; checking every five seconds. Once enough ETH arrives, press Enter to continue with the deposit. Ctrl+C preserves progress.\n", fundingNetwork(initial.ChainID), initial.Address)
	showSetupFundingProgress(ui, initial)
	lastProgress := initial.BalanceWei + ":" + initial.ShortfallWei
	displayed := initial
	approved, retrying := false, false
	ceiling := ""
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		// Refresh the fixed principal while waiting and again after Enter so a
		// potentially long terminal pause never approves an expired quote.
		quote, err := service.Quote(ctx, initial.Amount, 0)
		if err != nil {
			// Another owner command may have advanced the journal. A failed
			// quote never authorizes a different saved operation.
			state, statusErr := service.Address(ctx)
			if statusErr == nil {
				if !sameSetupFunding(state, initial) {
					return errors.New("saved funding changed while waiting; stopped setup")
				}
				switch state.Phase {
				case "deposit_pending", "confirming", "active":
					return finishGuidedDeposit(ctx, service, state, ui, wait)
				case "ready", "waiting_funds":
				default:
					return errors.New("saved funding needs attention; run oa-chat config before continuing")
				}
			}
			if !retrying {
				ui.Printf("Could not refresh the funding quote; retrying without authorizing a transaction.\n")
				retrying = true
			}
			if err := wait(ctx); err != nil {
				return err
			}
			continue
		}
		retrying = false
		if !sameSetupDeposit(initial, quote) {
			return errors.New("the saved deposit changed while waiting; stopped without approving another transaction")
		}
		if _, err := paymentRequestURI(quote); err != nil {
			return err
		}
		if quote.BalanceWei != displayed.BalanceWei || quote.RequiredTotalWei != displayed.RequiredTotalWei || quote.FeeReserveWei != displayed.FeeReserveWei {
			ui.Printf("\nPayment information updated.\n")
			if err := showSetupDeposit(ui, quote); err != nil {
				return err
			}
			displayed = quote
		}
		progress := quote.BalanceWei + ":" + quote.ShortfallWei
		if progress != lastProgress {
			showSetupFundingProgress(ui, quote)
			lastProgress = progress
		}
		balance, _ := new(big.Int).SetString(quote.BalanceWei, 10)
		required, _ := new(big.Int).SetString(quote.RequiredTotalWei, 10)
		if balance.Cmp(required) >= 0 {
			if !approved || !setupFeeWithin(quote, ceiling) {
				if approved {
					ui.Printf("Network fees increased; review the updated maximum before continuing.\n")
				}
				ui.Printf("Ready to deposit %s ETH. Maximum network fee: %s ETH.\n", fundingUnits(quote.PrincipalWei, 18), fundingUnits(quote.FeeReserveWei, 18))
				proceed, err := ui.Continue(ctx, "Press Enter to continue with this deposit, or type cancel")
				if err != nil {
					return err
				}
				if !proceed {
					return errors.New("deposit declined; no transaction was authorized")
				}
				approved, ceiling = true, quote.FeeReserveWei
				continue // Recheck identity, balance, and fees after terminal input.
			}
			ui.Printf("Depositing %s ETH; waiting for Ethereum finality (usually about 15 minutes).\n", fundingUnits(quote.PrincipalWei, 18))
			state, approveErr := service.Approve(ctx, quote.ID)
			if approveErr != nil {
				// An HTTP error does not tell us whether signing committed.
				// Recover only the durable journal; never approve another ID.
				ui.Printf("Checking saved deposit progress after an interrupted response.\n")
				state, err = readGuidedDeposit(ctx, service, ui, wait)
				if err != nil {
					return err
				}
				if state.Phase != "deposit_pending" && state.Phase != "confirming" && state.Phase != "active" {
					return errors.New("the deposit was not confirmed; run oa-chat config to inspect saved progress before approving again")
				}
			}
			if !sameSetupFunding(state, initial) {
				return errors.New("saved deposit no longer matches the approved amount or wallet; preserve its recovery files")
			}
			return finishGuidedDeposit(ctx, service, state, ui, wait)
		}
		if approved {
			ui.Printf("The receiving balance no longer covers the deposit and fees. Waiting for ETH again; press Enter again once funded.\n")
			approved, ceiling = false, ""
		}
		if err := wait(ctx); err != nil {
			return err
		}
	}
}

func showSetupFundingProgress(ui setupPrompter, quote zkapi.AddressPaymentQuote) {
	if quote.ShortfallWei == "0" {
		ui.Printf("Funds available. Receiving account balance: %s ETH.\n", fundingUnits(quote.BalanceWei, 18))
		return
	}
	ui.Printf("Waiting for ETH: receiving account balance %s ETH; still needed %s ETH.\n", fundingUnits(quote.BalanceWei, 18), fundingUnits(quote.ShortfallWei, 18))
}

func sameSetupFunding(state zkapi.AddressFundingStatus, quote zkapi.AddressPaymentQuote) bool {
	return state.BillingAsset == "native_eth" && state.ChainID == quote.ChainID && state.DeploymentID == quote.DeploymentID && strings.EqualFold(state.Address, quote.Address) && state.Amount == quote.Amount
}

func readGuidedDeposit(ctx context.Context, service guidedFundingService, ui setupPrompter, wait func(context.Context) error) (zkapi.AddressFundingStatus, error) {
	warned := false
	for {
		state, err := service.Address(ctx)
		if err == nil {
			return state, nil
		}
		if !warned {
			ui.Printf("Deposit status is temporarily unavailable; checking saved progress again.\n")
			warned = true
		}
		if err := wait(ctx); err != nil {
			return state, err
		}
	}
}

func finishGuidedDeposit(ctx context.Context, service guidedFundingService, initial zkapi.AddressFundingStatus, ui setupPrompter, wait func(context.Context) error) error {
	if initial.Amount == 0 {
		return errors.New("saved deposit amount is missing; preserve recovery files")
	}
	if initial.Phase != "active" && !validWithdrawalTransactionHash(initial.TransactionHash) {
		return errors.New("saved deposit transaction is missing; preserve recovery files")
	}
	state, previous, retrying := initial, "", false
	for {
		if state.BillingAsset != "native_eth" || state.Amount != initial.Amount || state.Address != initial.Address || state.ChainID != initial.ChainID || state.DeploymentID != initial.DeploymentID || (initial.TransactionHash != "" && state.TransactionHash != initial.TransactionHash) {
			return errors.New("saved deposit changed during recovery; preserve its recovery files")
		}
		progress := state.Phase + state.TransactionHash
		if progress != previous {
			// Fixed labels only; remote messages and recovery internals do not
			// enter the guided session's output.
			switch state.Phase {
			case "active":
				ui.Printf("Deposit finalized. Private inference balance activated.\n")
			case "deposit_pending", "confirming":
				ui.Printf("Deposit submitted; waiting for finalized activation.\n")
			}
			previous = progress
		}
		if state.Phase == "active" {
			return nil
		}
		if state.Phase != "deposit_pending" && state.Phase != "confirming" {
			return errors.New("deposit needs attention; run oa-chat config with this configuration before continuing (a reverted transaction is never retried automatically)")
		}
		if err := wait(ctx); err != nil {
			return err
		}
		next, err := service.Resume(ctx, initial.Amount)
		if err != nil {
			if !retrying {
				ui.Printf("Could not confirm deposit progress; retrying the saved transaction only.\n")
				retrying = true
			}
			// A failed response may have persisted a revert or completion.
			// Inspect it before another recovery call, especially because a
			// reverted transaction must never be retried automatically.
			recovered, readErr := readGuidedDeposit(ctx, service, ui, wait)
			if readErr != nil {
				return readErr
			}
			state = recovered
			continue
		}
		retrying, state = false, next
	}
}
