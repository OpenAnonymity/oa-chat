package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"net/http"
	"sort"
	"strconv"
	"strings"

	"github.com/OpenAnonymity/oa-chat/daemon/internal/config"
	"github.com/OpenAnonymity/oa-chat/daemon/internal/relay"
	"github.com/OpenAnonymity/oa-chat/daemon/internal/zkapi"
)

type setupModel struct {
	ID     string `json:"id"`
	Budget uint64 `json:"oa_request_limit_micro_usd"`
}

// The wizard uses the same owner-authenticated quote/approval endpoints as
// manual funding. It never reads signing keys or signs transactions itself.
type guidedFundingService interface {
	Models(context.Context) ([]setupModel, error)
	Readiness(context.Context) (zkapi.WalletReadiness, error)
	Budget(context.Context, uint64) (uint64, error)
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

func (s localGuidedFunding) Models(ctx context.Context) ([]setupModel, error) {
	// Exercise the same authenticated endpoint inference clients will use.
	raw, err := localRequest(ctx, s.config, http.MethodGet, "/v1/models")
	if err != nil {
		return nil, err
	}
	var result struct {
		Data []setupModel `json:"data"`
	}
	if json.Unmarshal(raw, &result) != nil || len(result.Data) == 0 {
		return nil, errors.New("no available models; retry when the model service is available")
	}
	return result.Data, nil
}
func (s localGuidedFunding) Readiness(ctx context.Context) (zkapi.WalletReadiness, error) {
	return s.wallet.Readiness(ctx)
}
func (s localGuidedFunding) Budget(ctx context.Context, usd uint64) (uint64, error) {
	q, err := s.wallet.NativeUSDQuote(ctx)
	if err != nil {
		return 0, fmt.Errorf("cannot verify a current ETH price for the model cap: %w", err)
	}
	return q.GweiForUSD(usd)
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

func runGuidedFunding(ctx context.Context, c config.Config, usdText, model string, ui setupPrompter) error {
	transport, err := relay.NewClient(c.RelayURL)
	if err != nil {
		return err
	}
	wallet, err := zkapi.New(zkConfig(c, transport))
	if err != nil {
		return err
	}
	return guidedFunding(ctx, localGuidedFunding{c, wallet}, usdText, model, ui, waitFundingPoll)
}

func selectSetupModel(models []setupModel, id string) (setupModel, error) {
	eligible := make([]setupModel, 0, len(models))
	for _, model := range models {
		if model.ID == "" || strings.TrimSpace(model.ID) != model.ID || model.Budget == 0 || model.Budget > 6_000_000 {
			return setupModel{}, errors.New("invalid model budget metadata")
		}
		if id != "" && model.ID == id {
			return model, nil
		}
		eligible = append(eligible, model)
	}
	if id != "" {
		return setupModel{}, errors.New("selected model is unavailable; choose an ID from /v1/models")
	}
	for _, model := range eligible {
		if model.ID == "openai/gpt-4.1-mini" {
			return model, nil
		}
	}
	sort.Slice(eligible, func(i, j int) bool {
		if eligible[i].Budget != eligible[j].Budget {
			return eligible[i].Budget < eligible[j].Budget
		}
		return eligible[i].ID < eligible[j].ID
	})
	if len(eligible) == 0 {
		return setupModel{}, errors.New("no eligible inference models")
	}
	return eligible[0], nil
}

// Readiness needs enough balance for at least one available model. The client
// still chooses a model per request, whose own cap is checked by inference.
func selectReadinessModel(models []setupModel) (setupModel, error) {
	selected, err := selectSetupModel(models, "")
	if err != nil {
		return selected, err
	}
	for _, candidate := range models {
		if candidate.Budget < selected.Budget {
			selected = candidate
		}
	}
	return selected, nil
}

func selectGuidedModel(models []setupModel, id string) (setupModel, error) {
	if id != "" {
		return selectSetupModel(models, id)
	}
	return selectReadinessModel(models)
}

func setupUSD(amount uint64) string {
	return strings.TrimRight(strings.TrimRight(fundingUnits(strconv.FormatUint(amount, 10), 6), "0"), ".")
}

const defaultSetupDepositMicroUSD uint64 = 20_000_000

func chooseSetupDepositUSD(ctx context.Context, usdText string, minimum uint64, ui setupPrompter) (uint64, error) {
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
		if err == nil && usd < minimum {
			err = fmt.Errorf("deposit must be at least $%s for the selected model", setupUSD(minimum))
		}
		if err == nil || !interactive {
			return usd, err
		}
		ui.Printf("%s. Please enter a deposit amount in USD.\n", err)
	}
}

func guidedFunding(ctx context.Context, service guidedFundingService, usdText, modelID string, ui setupPrompter, wait func(context.Context) error) error {
	models, err := service.Models(ctx)
	if err != nil {
		return err
	}
	model, err := selectGuidedModel(models, modelID)
	if err != nil {
		return err
	}
	ui.Printf("Checking private balance for %q (automatic request cap $%s).\n", model.ID, setupUSD(model.Budget))
	ready, err := waitSetupWallet(ctx, service, ui, wait)
	if err != nil {
		return err
	}
	if ready.HasNote {
		return checkSetupBalance(ctx, service, ready, model, ui)
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
			usd, err = chooseSetupDepositUSD(ctx, usdText, model.Budget, ui)
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
		bound, err := service.Budget(ctx, model.Budget)
		if err != nil {
			return err
		}
		if quote.Amount < bound {
			return errors.New("the saved deposit is below this model's current cap; select a lower-budget model or review funding with oa-chat config")
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
	// Finality may take many minutes. Read the live cap again before claiming
	// readiness; no test inference is sent and no anonymous access is consumed.
	models, err = service.Models(ctx)
	if err != nil {
		return err
	}
	model, err = selectSetupModel(models, model.ID)
	if err != nil {
		return err
	}
	return checkSetupBalance(ctx, service, ready, model, ui)
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

func checkSetupBalance(ctx context.Context, service guidedFundingService, state zkapi.WalletReadiness, model setupModel, ui setupPrompter) error {
	bound, err := service.Budget(ctx, model.Budget)
	if err != nil {
		return err
	}
	if state.Balance < bound {
		return fmt.Errorf("the existing private balance is below the $%s cap for %q; choose withdraw in oa-chat config --menu to close this note before adding funding", setupUSD(model.Budget), model.ID)
	}
	ui.Printf("Private balance ready: %s ETH; enough for %q. Request caps are selected automatically for each model.\n", fundingUnits(strconv.FormatUint(state.Balance, 10), 9), model.ID)
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
	ui.Printf("\n%s\nFunding address: %s\nPrivate deposit: %s ETH\nEstimated network fee: %s ETH\nMaximum network fee: %s ETH\n", fundingNetwork(q.ChainID), q.Address, fundingUnits(q.PrincipalWei, 18), fundingUnits(q.ExpectedFeeWei, 18), fundingUnits(q.FeeReserveWei, 18))
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
	approved, err := ui.Confirm(ctx, "Automatically deposit this fixed amount when funds arrive, within the maximum network fee shown above?")
	if err != nil {
		return err
	}
	if !approved {
		return errors.New("automatic deposit declined; no transaction was authorized")
	}
	ceiling := initial.FeeReserveWei
	ui.Printf("Send ETH on %s to %s. Keep this command running; it checks every five seconds, deposits automatically, and waits for finality. Ctrl+C preserves progress.\n", fundingNetwork(initial.ChainID), initial.Address)
	lastProgress, retrying := "", false
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		// A fresh exact-amount quote prevents the 30-second manual approval
		// expiry from turning into repeated prompts while the user sends ETH.
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
		if !setupFeeWithin(quote, ceiling) {
			if err := showSetupDeposit(ui, quote); err != nil {
				return err
			}
			approved, err := ui.Confirm(ctx, "Network fees increased. Allow the new maximum network fee shown above for this same deposit?")
			if err != nil {
				return err
			}
			if !approved {
				return errors.New("increased fee allowance declined; no new transaction was authorized")
			}
			ceiling = quote.FeeReserveWei
			continue // Refresh after a potentially long interactive prompt.
		}
		balance, ok := new(big.Int).SetString(quote.BalanceWei, 10)
		required, valid := new(big.Int).SetString(quote.RequiredTotalWei, 10)
		if !ok || !valid {
			return errors.New("invalid deposit balance or required amount")
		}
		if balance.Cmp(required) >= 0 {
			ui.Printf("Funds received. Depositing %s ETH; waiting for Ethereum finality (usually about 15 minutes).\n", fundingUnits(quote.PrincipalWei, 18))
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
		progress := quote.BalanceWei + ":" + quote.ShortfallWei
		if progress != lastProgress {
			ui.Printf("Waiting for ETH: available %s ETH; still needed %s ETH.\n", fundingUnits(quote.BalanceWei, 18), fundingUnits(quote.ShortfallWei, 18))
			lastProgress = progress
		}
		if err := wait(ctx); err != nil {
			return err
		}
	}
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
