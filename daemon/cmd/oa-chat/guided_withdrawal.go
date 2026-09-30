package main

import (
	"context"
	"errors"
	"math/big"
	"net/http"
	"strconv"
	"strings"

	"github.com/OpenAnonymity/oa-chat/daemon/internal/config"
	"github.com/OpenAnonymity/oa-chat/daemon/internal/zkapi"
)

// Quoting reserves the selected note and destination, but cannot sign. Resume
// is used only after the journal has an identified signed transaction.
type guidedWithdrawalService interface {
	Status(context.Context) (zkapi.AddressWithdrawalStatus, error)
	Quote(context.Context, string, uint64, string) (zkapi.AddressPaymentQuote, error)
	Approve(context.Context, string) (zkapi.AddressWithdrawalStatus, error)
	Resume(context.Context, string, uint64) (zkapi.AddressWithdrawalStatus, error)
	Confirm(context.Context, string, uint64, string) (zkapi.AddressWithdrawalStatus, error)
}

type localGuidedWithdrawal struct{ config config.Config }

func (s localGuidedWithdrawal) Status(ctx context.Context) (zkapi.AddressWithdrawalStatus, error) {
	return requestWithdrawal(ctx, s.config, http.MethodGet, nil)
}
func (s localGuidedWithdrawal) Quote(ctx context.Context, destination string, note uint64, retry string) (zkapi.AddressPaymentQuote, error) {
	body := map[string]any{"destination": destination, "note_id": note}
	if retry != "" {
		body["retry_transaction_hash"] = retry
	}
	return requestPaymentQuote(ctx, s.config, http.MethodPost, "/admin/withdrawal/quote", "withdrawal", body)
}
func (s localGuidedWithdrawal) Approve(ctx context.Context, id string) (zkapi.AddressWithdrawalStatus, error) {
	return requestWithdrawalPath(ctx, s.config, http.MethodPost, "/admin/withdrawal/approve", map[string]string{"quote_id": id})
}
func (s localGuidedWithdrawal) Resume(ctx context.Context, destination string, note uint64) (zkapi.AddressWithdrawalStatus, error) {
	return requestWithdrawal(ctx, s.config, http.MethodPost, map[string]any{"destination": destination, "note_id": note})
}
func (s localGuidedWithdrawal) Confirm(ctx context.Context, destination string, note uint64, hash string) (zkapi.AddressWithdrawalStatus, error) {
	return requestWithdrawal(ctx, s.config, http.MethodPost, map[string]any{"destination": destination, "note_id": note, "confirmation_transaction_hash": hash})
}

func runGuidedWithdrawal(ctx context.Context, c config.Config, ui setupPrompter) error {
	return guidedWithdrawal(ctx, localGuidedWithdrawal{c}, ui, waitFundingPoll)
}

func guidedWithdrawal(ctx context.Context, service guidedWithdrawalService, ui setupPrompter, wait func(context.Context) error) error {
	initial, err := service.Status(ctx)
	if err != nil {
		return err
	}
	if initial.BillingAsset != "native_eth" {
		return errors.New("guided withdrawal requires the native ETH deployment; preserve legacy wallet recovery files")
	}
	switch initial.Phase {
	case "no_note":
		ui.Printf("There is no open private balance to withdraw.\n")
		return nil
	case "complete", "withdrawal_pending", "confirming":
		return finishGuidedWithdrawal(ctx, service, initial, ui, wait)
	case "ready", "quoted", "waiting_funds", "waiting_settlement", "reverted":
	default:
		return errors.New("withdrawal needs recovery; preserve the wallet files and run oa-chat config --menu")
	}
	destination := initial.Destination
	if destination == "" {
		for {
			answer, err := ui.Ask(ctx, "Withdraw the full private balance to Ethereum address", "")
			if err != nil {
				return err
			}
			destination, err = zkapi.NormalizeWithdrawalDestination(strings.TrimSpace(answer))
			if err == nil {
				break
			}
			ui.Printf("%s. Please enter the destination address.\n", err)
		}
	} else if _, err := zkapi.NormalizeWithdrawalDestination(destination); err != nil {
		return errors.New("the saved withdrawal destination is invalid; preserve recovery files")
	}

	retryHash := ""
	if initial.Phase == "reverted" {
		if !validWithdrawalTransactionHash(initial.TransactionHash) {
			return errors.New("the reverted withdrawal has no valid saved transaction; preserve recovery files")
		}
		choice, err := ui.Ask(ctx, "The previous withdrawal reverted. Choose retry, or confirm a payout submitted separately", "retry")
		if err != nil {
			return err
		}
		switch choice {
		case "retry":
			retryHash = initial.TransactionHash
		case "confirm":
			hash, err := ui.Ask(ctx, "Matching withdrawal transaction hash", "")
			if err != nil {
				return err
			}
			if !validWithdrawalTransactionHash(hash) || strings.EqualFold(hash, initial.TransactionHash) {
				return errors.New("enter a valid, separately submitted withdrawal transaction hash")
			}
			state, err := service.Confirm(ctx, destination, initial.NoteID, hash)
			if err != nil {
				return errors.New("payout confirmation did not complete; run oa-chat config --menu to recover saved progress")
			}
			if !sameGuidedWithdrawalWallet(initial, state) || initial.Amount != state.Amount || !strings.EqualFold(destination, state.Destination) || !strings.EqualFold(hash, state.TransactionHash) {
				return errors.New("payout confirmation changed the saved withdrawal; preserve recovery files")
			}
			return finishGuidedWithdrawal(ctx, service, state, ui, wait)
		default:
			return errors.New("choose retry or confirm; no transaction was authorized")
		}
	} else if initial.TransactionHash != "" {
		return errors.New("saved withdrawal transaction needs recovery before preparing another quote")
	}
	ui.Printf("Preparing withdrawal; this can take a few minutes.\n")
	return waitAndWithdraw(ctx, service, initial, destination, retryHash, ui, wait)
}

func sameGuidedWithdrawalWallet(a, b zkapi.AddressWithdrawalStatus) bool {
	return a.BillingAsset == "native_eth" && b.BillingAsset == a.BillingAsset && a.ChainID == b.ChainID && a.DeploymentID == b.DeploymentID && strings.EqualFold(a.Address, b.Address) && a.NoteID == b.NoteID
}

func sameGuidedWithdrawalQuote(a, b zkapi.AddressPaymentQuote) bool {
	return a.Kind == "withdrawal" && b.Kind == a.Kind && a.ChainID == b.ChainID && a.DeploymentID == b.DeploymentID && strings.EqualFold(a.Contract, b.Contract) && strings.EqualFold(a.Address, b.Address) && a.NoteID == b.NoteID && strings.EqualFold(a.Destination, b.Destination) && a.Amount == b.Amount && a.PrincipalWei == "0" && b.PrincipalWei == a.PrincipalWei && a.Binding != "" && a.Binding == b.Binding && a.Commitment == "" && b.Commitment == "" && a.Nonce == b.Nonce && a.RetryHash == b.RetryHash
}

func withdrawalStateMatchesQuote(state zkapi.AddressWithdrawalStatus, quote zkapi.AddressPaymentQuote) bool {
	return state.BillingAsset == "native_eth" && state.ChainID == quote.ChainID && state.DeploymentID == quote.DeploymentID && strings.EqualFold(state.Address, quote.Address) && state.NoteID == quote.NoteID && state.Amount == quote.Amount && strings.EqualFold(state.Destination, quote.Destination)
}

func waitAndWithdraw(ctx context.Context, service guidedWithdrawalService, initial zkapi.AddressWithdrawalStatus, destination, retryHash string, ui setupPrompter, wait func(context.Context) error) error {
	var frozen *zkapi.AddressPaymentQuote
	var displayedPayment *zkapi.AddressPaymentQuote
	approved, retrying, settling := false, false, false
	ceiling, lastProgress := "", ""
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		quote, err := service.Quote(ctx, destination, initial.NoteID, retryHash)
		if err != nil {
			state, statusErr := service.Status(ctx)
			if statusErr == nil {
				if !sameGuidedWithdrawalWallet(initial, state) || (state.Destination != "" && !strings.EqualFold(destination, state.Destination)) || (frozen != nil && !withdrawalStateMatchesQuote(state, *frozen)) {
					return errors.New("saved withdrawal changed while waiting; stopped without authorizing another transaction")
				}
				switch state.Phase {
				case "withdrawal_pending", "confirming", "complete":
					return finishGuidedWithdrawal(ctx, service, state, ui, wait)
				case "waiting_settlement":
					if !settling {
						ui.Printf("Waiting for your previous inference to settle; checking automatically.\n")
						settling = true
					}
				case "ready", "quoted", "waiting_funds":
					if state.TransactionHash != "" {
						return errors.New("saved withdrawal transaction needs recovery; no replacement was authorized")
					}
				case "reverted":
					if retryHash == "" || !strings.EqualFold(state.TransactionHash, retryHash) {
						return errors.New("withdrawal reverted; run oa-chat config --menu to review recovery; no retry was authorized")
					}
				default:
					return errors.New("saved withdrawal needs recovery; run oa-chat config --menu")
				}
			}
			if !retrying && (statusErr != nil || state.Phase != "waiting_settlement") {
				ui.Printf("Could not refresh withdrawal fees; checking again.\n")
				retrying = true
			}
			if err := wait(ctx); err != nil {
				return err
			}
			continue
		}
		retrying = false
		if quote.ChainID != initial.ChainID || quote.DeploymentID != initial.DeploymentID || !strings.EqualFold(quote.Address, initial.Address) || quote.NoteID != initial.NoteID || !strings.EqualFold(quote.Destination, destination) || quote.RetryHash != retryHash || !sameGuidedWithdrawalQuote(quote, quote) || (frozen != nil && !sameGuidedWithdrawalQuote(*frozen, quote)) || (initial.Phase == "reverted" && quote.Amount != initial.Amount) {
			return errors.New("withdrawal quote changed the selected wallet, note, destination, amount, or transaction; stopped without approving")
		}
		if _, err := paymentRequestURI(quote); err != nil {
			return err
		}
		if frozen == nil {
			copy := quote
			frozen = &copy
			ui.Printf("\nWithdraw %s ETH on %s\nDestination: %s\n", fundingUnits(strconv.FormatUint(quote.Amount, 10), 9), fundingNetwork(quote.ChainID), quote.Destination)
		}
		if quote.ShortfallWei != "0" {
			if approved {
				ui.Printf("The receiving balance no longer covers fees. Waiting for ETH again.\n")
				approved, ceiling = false, ""
			}
			if displayedPayment == nil || withdrawalPaymentNeedsRefresh(quote, *displayedPayment) {
				ui.Printf("Add ETH for network fees to the receiving account below.\n")
				if err := printSetupPaymentQR(setupUIWriter{ui}, quote); err != nil {
					return err
				}
				copy := quote
				displayedPayment = &copy
			}
			progress := quote.BalanceWei + ":" + quote.ShortfallWei
			if progress != lastProgress {
				showSetupFundingProgress(ui, quote)
				lastProgress = progress
			}
			if err := wait(ctx); err != nil {
				return err
			}
			continue
		}
		displayedPayment = nil
		if !approved || !setupFeeWithin(quote, ceiling) {
			if approved {
				ui.Printf("Network fees increased; review the updated maximum.\n")
			}
			ui.Printf("Fees funded. Maximum network fee: %s ETH.\n", fundingUnits(quote.FeeReserveWei, 18))
			proceed, err := ui.Continue(ctx, "Press Enter to withdraw, or type cancel")
			if err != nil {
				return err
			}
			if !proceed {
				return errors.New("withdrawal declined; no transaction was authorized")
			}
			approved, ceiling = true, quote.FeeReserveWei
			continue // The terminal pause must not authorize stale fees or balance.
		}
		ui.Printf("Submitting withdrawal...\n")
		state, err := service.Approve(ctx, quote.ID)
		if err != nil {
			// A lost response may follow a durable signature. Do not approve a
			// different quote: only inspect and resume that saved transaction.
			ui.Printf("Checking saved withdrawal progress after an interrupted response.\n")
			state, err = readGuidedWithdrawal(ctx, service, ui, wait)
			if err != nil {
				return err
			}
			if state.Phase != "withdrawal_pending" && state.Phase != "confirming" && state.Phase != "complete" {
				return errors.New("withdrawal was not confirmed; run oa-chat config --menu to inspect saved progress before approving again")
			}
		}
		if !withdrawalStateMatchesQuote(state, quote) {
			return errors.New("saved withdrawal no longer matches the approved operation; preserve recovery files")
		}
		// A balance change during approval can leave an unsigned reservation.
		// Return to funding and require a new Enter; never call Resume on it.
		if state.Phase == "waiting_funds" && state.TransactionHash == "" {
			approved, ceiling = false, ""
			continue
		}
		return finishGuidedWithdrawal(ctx, service, state, ui, wait)
	}
}

func withdrawalPaymentNeedsRefresh(current, displayed zkapi.AddressPaymentQuote) bool {
	if current.BalanceWei != displayed.BalanceWei {
		return true
	}
	required, _ := new(big.Int).SetString(current.RequiredTotalWei, 10)
	buffered, _ := new(big.Int).SetString(displayed.RecommendedTotalWei, 10)
	return required.Cmp(buffered) > 0
}

func readGuidedWithdrawal(ctx context.Context, service guidedWithdrawalService, ui setupPrompter, wait func(context.Context) error) (zkapi.AddressWithdrawalStatus, error) {
	warned := false
	for {
		state, err := service.Status(ctx)
		if err == nil {
			return state, nil
		}
		if !warned {
			ui.Printf("Withdrawal status is temporarily unavailable; checking saved progress again.\n")
			warned = true
		}
		if err := wait(ctx); err != nil {
			return state, err
		}
	}
}

func finishGuidedWithdrawal(ctx context.Context, service guidedWithdrawalService, initial zkapi.AddressWithdrawalStatus, ui setupPrompter, wait func(context.Context) error) error {
	if !validWithdrawalTransactionHash(initial.TransactionHash) || initial.Destination == "" {
		return errors.New("saved withdrawal transaction is missing; preserve recovery files")
	}
	state, announced := initial, false
	for {
		if !sameGuidedWithdrawalWallet(initial, state) || state.Amount != initial.Amount || !strings.EqualFold(state.Destination, initial.Destination) || !strings.EqualFold(state.TransactionHash, initial.TransactionHash) {
			return errors.New("saved withdrawal changed during recovery; preserve recovery files")
		}
		switch state.Phase {
		case "complete":
			ui.Printf("Withdrawal complete: %s ETH sent to %s.\n", fundingUnits(strconv.FormatUint(state.Amount, 10), 9), state.Destination)
			if state.ActualFeeWei != "" {
				ui.Printf("Network fee: %s ETH.\n", fundingUnits(state.ActualFeeWei, 18))
			}
			return nil
		case "withdrawal_pending", "confirming":
			if !announced {
				ui.Printf("Withdrawal submitted; waiting for Ethereum finality (usually about 15 minutes). Ctrl+C preserves progress.\n")
				announced = true
			}
		default:
			return errors.New("withdrawal needs attention; run oa-chat config --menu to recover it; a reverted transaction is never retried automatically")
		}
		if err := wait(ctx); err != nil {
			return err
		}
		next, err := service.Resume(ctx, initial.Destination, initial.NoteID)
		if err != nil {
			next, err = readGuidedWithdrawal(ctx, service, ui, wait)
			if err != nil {
				return err
			}
		}
		state = next
	}
}
