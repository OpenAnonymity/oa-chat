package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/OpenAnonymity/oa-chat/daemon/internal/config"
	"github.com/OpenAnonymity/oa-chat/daemon/internal/relay"
	"github.com/OpenAnonymity/oa-chat/daemon/internal/zkapi"
)

func configurationRequired(err error) error {
	return fmt.Errorf("%w. Run oa-chat config to review and complete configuration (use the same --config-dir if set)", err)
}

func configuredRuntime(expected config.Config) startRuntime {
	return startRuntime{
		testnet: prepareSepoliaAccess,
		probe:   probeSetupService, companion: checkSetupCompanion,
		serve: func(ctx context.Context, dir string, c config.Config, out io.Writer) error {
			return serveSnapshot(ctx, dir, c, expected, out)
		},
		fund: runGuidedFunding, tickets: runGuidedTickets,
		interval: 500 * time.Millisecond, timeout: 90 * time.Second,
	}
}

// Serve never reads the terminal, imports tickets, or authorizes funding.
// It uses the same authenticated startup checks as config, then stays running.
func runConfiguredServe(ctx context.Context, dir string, c, expected config.Config, out io.Writer) error {
	ui := &noninteractiveSetup{out: out}
	runtime := configuredRuntime(expected)
	runtime.testnet = checkSepoliaAccess
	runtime.fund = checkConfiguredZKAPI
	runtime.tickets = checkConfiguredTickets
	if c.Backend == "ticket" {
		// An empty wallet does not need a service or a network request to explain
		// what is missing. This also makes first-run failures immediate.
		if err := requireTickets(ctx, dir, c); err != nil {
			return configurationRequired(err)
		}
	}
	err := guidedStart(ctx, dir, startOptions{prepared: &c, checkOnly: true}, ui, out, runtime)
	if ctx.Err() != nil {
		return nil
	}
	if err != nil {
		return configurationRequired(err)
	}
	return nil
}

type noninteractiveSetup struct{ out io.Writer }

func (p *noninteractiveSetup) Ask(context.Context, string, string) (string, error) {
	return "", errors.New("configuration needs interactive input; run oa-chat config")
}
func (p *noninteractiveSetup) Confirm(context.Context, string) (bool, error) {
	return false, errors.New("funding needs your approval; run oa-chat config")
}
func (p *noninteractiveSetup) Printf(format string, args ...any) {
	fmt.Fprintf(p.out, format, args...)
}

func requireTickets(ctx context.Context, dir string, c config.Config) error {
	client, err := relay.NewClient(c.RelayURL)
	if err != nil {
		return err
	}
	defer client.CloseIdleConnections()
	wallet, err := ticketBackend(dir, c, client)
	if err != nil {
		return err
	}
	count, err := wallet.CountContext(ctx)
	if err != nil {
		return err
	}
	if count == 0 {
		return errors.New("the ticket wallet is empty; import or redeem tickets")
	}
	return nil
}

func checkConfiguredTickets(ctx context.Context, dir string, c config.Config, ui setupPrompter) error {
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	if err := requireTickets(ctx, dir, c); err != nil {
		return err
	}
	// If another process spends the final ticket between the count and this
	// check, the noninteractive prompter fails rather than asking for input.
	return runGuidedTickets(ctx, dir, c, &noninteractiveSetup{out: setupUIWriter{ui}})
}

type setupUIWriter struct{ ui setupPrompter }

func (w setupUIWriter) Write(p []byte) (int, error) {
	w.ui.Printf("%s", p)
	return len(p), nil
}

func checkConfiguredZKAPI(ctx context.Context, c config.Config, _, _ string, ui setupPrompter) error {
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	client, err := relay.NewClient(c.RelayURL)
	if err != nil {
		return err
	}
	defer client.CloseIdleConnections()
	wallet, err := zkapi.New(zkConfig(c, client))
	if err != nil {
		return err
	}
	return configuredWalletReady(ctx, localGuidedFunding{c, wallet}, ui)
}

// Deliberately does not call Address, Quote, Approve, Resume, or Withdrawal:
// even generating an unused local signing address belongs in config.
func configuredWalletReady(ctx context.Context, service guidedFundingService, ui setupPrompter) error {
	state, err := service.Readiness(ctx)
	if err != nil {
		return err
	}
	if state.PendingRequest {
		return errors.New("a previous inference is awaiting settlement; complete wallet recovery")
	}
	if state.WithdrawalPending {
		return errors.New("a private withdrawal is reserved; complete wallet recovery")
	}
	if !state.HasNote {
		return errors.New("the zkAPI wallet has no private balance; configure funding")
	}
	return checkSetupBalance(state, ui)
}

// Config owns a temporary runtime only for the selected wallet operation. It
// returns after readiness/recovery, leaving a foreign compatible service alone.
func runConfigAction(ctx context.Context, dir string, c config.Config, action string, ui setupPrompter, out io.Writer) error {
	return runConfigActionWithUSD(ctx, dir, c, action, "", ui, out)
}

func runConfigActionWithUSD(ctx context.Context, dir string, c config.Config, action, usd string, ui setupPrompter, out io.Writer) error {
	if action == "password" {
		if c.Backend != "zkapi" || c.ZKAPI.Network != "sepolia" {
			return errors.New("password configuration applies only to Sepolia zkAPI")
		}
		if err := changeSepoliaAccess(ctx, dir, c, ui); err != nil {
			return err
		}
		ui.Printf("Sepolia password saved. Restart any running daemon to use it. Run oa-chat config to check readiness.\n")
		return nil
	}
	savedBackend := c.Backend
	runtime := configuredRuntime(c)
	switch action {
	case "setup":
	case "tickets":
		c.Backend = "ticket"
		runtime.tickets = addGuidedTickets
	case "withdraw", "return":
		c.Backend = "zkapi"
		runtime.fund = func(ctx context.Context, c config.Config, _, _ string, ui setupPrompter) error {
			return configurePayment(ctx, c, action, ui)
		}
	case "status":
		runtime.fund = checkConfiguredZKAPI
		runtime.tickets = checkConfiguredTickets
	default:
		return errors.New("unknown configuration action")
	}
	err := guidedStart(ctx, dir, startOptions{prepared: &c, setupOnly: true, usd: usd}, ui, out, runtime)
	if err != nil {
		return err
	}
	if action == "setup" || action == "tickets" || action == "status" {
		suffix := ""
		label := "Configuration ready."
		if c.Backend != savedBackend {
			suffix = " --backend " + c.Backend
			label = "Ticket mode ready. Your saved default mode is unchanged."
		}
		ui.Printf("\n%s\nOpenAI base URL: http://%s/v1\nGet your local API key: %s --config-dir %s config --api-key\nRun %s --config-dir %s serve%s to serve inference.\n", label, c.Listen, setupExecutable(), shellQuoteSetup(dir), setupExecutable(), shellQuoteSetup(dir), suffix)
	} else {
		ui.Printf("\nWallet operation complete. Run oa-chat config to check readiness before serving.\n")
	}
	return nil
}

func configurePayment(ctx context.Context, c config.Config, action string, ui setupPrompter) error {
	out := setupUIWriter{ui}
	var selectedDestination, selectedAmount string
	var selectedNote *uint64
	if action == "withdraw" {
		state, err := requestWithdrawal(ctx, c, http.MethodGet, nil)
		if err != nil {
			return err
		}
		ui.Printf("%s: private withdrawal status: %s.\n", fundingNetwork(state.ChainID), state.Phase)
		if state.Phase == "withdrawal_pending" || state.Phase == "confirming" {
			ui.Printf("Resuming the saved signed withdrawal.\n")
			return runWithdrawal(ctx, c, []string{"--resume"}, out)
		}
		if state.Phase == "no_note" || state.Phase == "complete" {
			ui.Printf("There is no open private balance to withdraw.\n")
			return nil
		}
		destination, err := ui.Ask(ctx, "Withdraw the full private balance to Ethereum address", state.Destination)
		if err != nil {
			return err
		}
		selectedDestination, selectedNote = destination, &state.NoteID
		if state.Phase == "reverted" {
			choice, err := ui.Ask(ctx, "Recovery: retry with a new reviewed quote, or confirm an independently submitted transaction", "retry")
			if err != nil {
				return err
			}
			if choice == "confirm" {
				hash, err := ui.Ask(ctx, "Matching withdrawal transaction hash", "")
				if err != nil {
					return err
				}
				return runWithdrawal(ctx, c, []string{"--to", destination, "--confirm", hash}, out)
			}
			if choice != "retry" {
				return errors.New("choose retry or confirm; no transaction authorized")
			}
		}
		if err := runWithdrawal(ctx, c, []string{"--to", destination}, out); err != nil {
			return err
		}
	} else {
		var state zkapi.AddressReturnStatus
		if err := requestManagementJSON(ctx, c, http.MethodGet, "/admin/return", nil, &state); err != nil {
			return err
		}
		if state.Phase == "return_pending" || state.Phase == "confirming" {
			ui.Printf("Resuming the saved signed public ETH return.\n")
			return runPublicReturn(ctx, c, []string{"--resume"}, out)
		}
		destination, err := ui.Ask(ctx, "Return public ETH to Ethereum address", "")
		if err != nil {
			return err
		}
		amount, err := ui.Ask(ctx, "Amount in ETH, or all to return the available balance after fees", "all")
		if err != nil {
			return err
		}
		selectedDestination = destination
		args := []string{"--to", destination}
		if strings.ToLower(amount) != "all" {
			selectedAmount, err = parseReturnAmount(amount)
			if err != nil {
				return err
			}
			args = append(args, "--amount", amount)
		}
		if err := runPublicReturn(ctx, c, args, out); err != nil {
			return err
		}
	}
	path, kind := "/admin/withdrawal/quote", "withdrawal"
	if action == "return" {
		path, kind = "/admin/return/quote", "return"
	}
	quote, err := requestPaymentQuote(ctx, c, http.MethodGet, path, kind, nil)
	if err != nil {
		return err
	}
	if !strings.EqualFold(quote.Destination, selectedDestination) || (selectedNote != nil && quote.NoteID != *selectedNote) || (selectedAmount != "" && quote.PrincipalWei != selectedAmount) {
		return errors.New("the saved payment quote changed your selected destination, note, or amount; no transaction authorized")
	}
	// Display the very quote whose ID is authorized, even if an earlier quote
	// was replaced concurrently. Approval endpoints re-check its exact binding.
	printPaymentQuote(out, quote, "")
	approved, err := ui.Confirm(ctx, "Authorize this destination, fixed amount, and maximum network fee")
	if err != nil {
		return err
	}
	if !approved {
		return errors.New("payment was not authorized; saved progress is preserved")
	}
	if action == "withdraw" {
		return runWithdrawal(ctx, c, []string{"--approve", quote.ID}, out)
	}
	return runPublicReturn(ctx, c, []string{"--approve", quote.ID}, out)
}
