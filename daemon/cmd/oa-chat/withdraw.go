package main

import (
	"bytes"
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/OpenAnonymity/oa-chat/daemon/internal/config"
	"github.com/OpenAnonymity/oa-chat/daemon/internal/zkapi"
)

var errWithdrawalWaitStopped = errors.New("stopped waiting; the withdrawal may still be progressing; inspect saved status")

func runWithdrawal(ctx context.Context, c config.Config, args []string, out io.Writer) (result error) {
	submitted := false
	defer func() {
		if errors.Is(result, errFundingWaitStopped) {
			result = errWithdrawalWaitStopped
		}
		if result != nil && submitted {
			result = fmt.Errorf("%w; recover saved progress with oa-chat config, choose withdraw, and use the same --config-dir", result)
		}
	}()
	flags := flag.NewFlagSet("withdraw", flag.ContinueOnError)
	destinationText := flags.String("to", "", "destination for a full private-balance withdrawal quote, or saved transaction recovery")
	confirmationText := flags.String("confirm", "", "confirm an independently submitted matching withdrawal after a finalized local revert")
	approval := flags.String("approve", "", "approve the displayed withdrawal quote ID")
	resume := flags.Bool("resume", false, "recover a saved signed withdrawal without authorizing a new transaction")
	if err := flags.Parse(args); err != nil {
		return err
	}
	emptyApproval := false
	flags.Visit(func(f *flag.Flag) {
		if f.Name == "approve" && f.Value.String() == "" {
			emptyApproval = true
		}
	})
	if emptyApproval {
		return errors.New("approval ID cannot be empty")
	}
	if flags.NArg() != 0 || (*approval != "" && (*destinationText != "" || *confirmationText != "" || *resume)) || (*resume && (*destinationText != "" || *confirmationText != "")) {
		return errors.New("use --to ADDRESS, --approve QUOTE_ID, or --resume separately")
	}
	destinationSet, confirmationSet := false, false
	flags.Visit(func(f *flag.Flag) {
		if f.Name == "to" {
			destinationSet = true
		}
		if f.Name == "confirm" {
			confirmationSet = true
		}
	})
	if confirmationSet && (!destinationSet || !validWithdrawalTransactionHash(*confirmationText)) {
		return errors.New("--confirm requires --to and a valid 32-byte transaction hash")
	}
	destination := ""
	var err error
	if destinationSet {
		destination, err = zkapi.NormalizeWithdrawalDestination(*destinationText)
		if err != nil {
			return err
		}
	}
	if *approval != "" && !validQuoteID(*approval) {
		return errors.New("invalid quote ID")
	}
	c, err = activeFundingConfig(ctx, c)
	if err != nil {
		return err
	}
	state, err := requestWithdrawal(ctx, c, http.MethodGet, nil)
	if err != nil {
		return err
	}
	noteID := state.NoteID
	fmt.Fprintf(out, "%s withdrawal\nPrivate balance: %s ETH\nLocal signing address: %s\nAvailable for network fees: %s ETH\n", fundingNetwork(state.ChainID), fundingUnits(strconv.FormatUint(state.PrivateBalance, 10), 9), state.Address, fundingUnits(state.ETHBalance, 18))
	printWithdrawalProgress(out, state, "ETH")
	if !destinationSet && *approval == "" && !*resume {
		withdrawalResumeInstructions(out, state)
		return nil
	}
	if confirmationSet {
		if state.Phase == "confirming" || state.Phase == "complete" {
			if !strings.EqualFold(*confirmationText, state.TransactionHash) {
				return errors.New("resume with the same saved confirmation transaction; existing evidence cannot be replaced")
			}
		} else if state.Phase != "reverted" {
			return errors.New("--confirm is available only after the saved withdrawal finalized as reverted")
		}
	}
	if state.Phase == "complete" {
		if destination != "" && !strings.EqualFold(destination, state.Destination) {
			return errors.New("the completed withdrawal went to its saved destination; no new private balance is ready")
		}
		return nil
	}
	if state.Phase == "no_note" {
		return errors.New("there is no private balance to withdraw")
	}
	if state.Phase == "recovery_required" {
		return errors.New("withdrawal requires recovery; preserve the local funding and companion files")
	}
	if *resume {
		if (state.Phase != "withdrawal_pending" && state.Phase != "confirming") || state.Destination == "" || state.TransactionHash == "" {
			return errors.New("no signed withdrawal to resume; use --to to prepare and approve a quote")
		}
		destination = state.Destination
	}
	expectedAmount := state.Amount
	if *approval != "" {
		quote, err := requestPaymentQuote(ctx, c, http.MethodGet, "/admin/withdrawal/quote", "withdrawal", nil)
		if err != nil {
			return err
		}
		if quote.ID != *approval || quote.NoteID != noteID {
			return errors.New("the saved quote or private note changed; review a fresh quote")
		}
		destination = quote.Destination
		expectedAmount = quote.Amount
		printPaymentQuote(out, quote, "oa-chat withdraw")
		submitted = true
		state, err = requestWithdrawalPath(ctx, c, http.MethodPost, "/admin/withdrawal/approve", map[string]string{"quote_id": *approval})
		if err != nil {
			return err
		}
	} else {
		if state.Phase != "ready" && state.Destination != "" && !strings.EqualFold(destination, state.Destination) {
			return errors.New("a withdrawal to a different destination is already saved; use the saved destination")
		}
		if confirmationSet {
			fmt.Fprintln(out, "Confirming the saved receipt; this does not authorize another transaction.")
			resuming := state.Phase == "confirming" && strings.EqualFold(*confirmationText, state.TransactionHash)
			if state.Phase != "reverted" && !resuming {
				return errors.New("--confirm is available only after the saved withdrawal finalized as reverted, or to resume its saved confirmation")
			}
			submitted = true
			state, err = requestWithdrawal(ctx, c, http.MethodPost, map[string]any{"destination": destination, "note_id": noteID, "confirmation_transaction_hash": *confirmationText})
			if err != nil {
				return err
			}
		} else if state.Phase == "withdrawal_pending" || state.Phase == "confirming" {
			submitted = true
			state, err = requestWithdrawal(ctx, c, http.MethodPost, map[string]any{"destination": destination, "note_id": noteID})
			if err != nil {
				return err
			}
		} else {
			switch state.Phase {
			case "ready", "quoted", "waiting_settlement", "waiting_funds", "reverted":
			default:
				return errors.New("unknown withdrawal status; no request was submitted")
			}
			body := map[string]any{"destination": destination, "note_id": noteID}
			if state.Phase == "reverted" {
				if !validWithdrawalTransactionHash(state.TransactionHash) {
					return errors.New("the reverted withdrawal has no valid saved transaction hash")
				}
				body["retry_transaction_hash"] = state.TransactionHash
			}
			quote, err := requestPaymentQuote(ctx, c, http.MethodPost, "/admin/withdrawal/quote", "withdrawal", body)
			if err != nil {
				return err
			}
			if quote.NoteID != noteID || !strings.EqualFold(quote.Destination, destination) {
				return errors.New("withdrawal quote changed the selected note or destination")
			}
			printPaymentQuote(out, quote, "oa-chat withdraw")
			return nil
		}
	}
	previous := ""
	for {
		if state.NoteID != noteID || state.Amount != expectedAmount || (state.Destination != "" && !strings.EqualFold(destination, state.Destination)) {
			return errors.New("withdrawal response changed the selected note, amount, or destination; stopped polling")
		}
		progress := state.Phase + state.Message + state.TransactionHash
		if progress != previous {
			printWithdrawalProgress(out, state, "ETH")
			previous = progress
		}
		switch state.Phase {
		case "complete":
			return nil
		case "withdrawal_pending", "confirming":
		case "waiting_settlement":
			return errors.New("withdrawal is waiting for the inference lease to settle; rerun --to to prepare a fresh quote afterward")
		case "waiting_funds":
			return errors.New("withdrawal needs ETH for fees; fund the signing address, then rerun --to for a fresh quote")
		case "reverted":
			return errors.New("withdrawal reverted; rerun --to to review and approve a fresh quote before another transaction")
		default:
			return errors.New("withdrawal stopped; preserve saved progress and follow the status message")
		}
		if err := waitFundingPoll(ctx); err != nil {
			return errWithdrawalWaitStopped
		}
		state, err = requestWithdrawal(ctx, c, http.MethodPost, map[string]any{"destination": destination, "note_id": noteID})
		if err != nil {
			return err
		}
	}
}

func printWithdrawalProgress(out io.Writer, state zkapi.AddressWithdrawalStatus, token string) {
	decimals := 6
	if state.BillingAsset == "native_eth" {
		decimals = 9
	}
	if state.Destination != "" && state.Phase != "ready" {
		fmt.Fprintf(out, "Saved withdrawal: %s %s to %s\n", fundingUnits(strconv.FormatUint(state.Amount, 10), decimals), token, state.Destination)
	}
	fmt.Fprintf(out, "%s: %s\n", state.Phase, state.Message)
	if state.TransactionHash != "" {
		fmt.Fprintln(out, "Transaction:", state.TransactionHash)
	}
	if state.ActualFeeWei != "" {
		fmt.Fprintf(out, "Actual network fee: %s ETH\n", fundingUnits(state.ActualFeeWei, 18))
	}
}

func withdrawalResumeInstructions(out io.Writer, state zkapi.AddressWithdrawalStatus) {
	switch state.Phase {
	case "complete", "no_note", "recovery_required":
		return
	}
	if state.Destination != "" && state.Phase != "ready" {
		if state.Phase == "withdrawal_pending" || state.Phase == "confirming" {
			fmt.Fprintln(out, "To recover this signed withdrawal, run oa-chat withdraw --resume (keep the same --config-dir if used).")
		} else {
			fmt.Fprintf(out, "To quote this saved withdrawal again, run oa-chat withdraw --to %s (keep the same --config-dir if used).\n", state.Destination)
		}
	} else {
		fmt.Fprintln(out, "To quote withdrawal of the full remaining balance, run oa-chat withdraw --to ADDRESS, replacing ADDRESS with your Ethereum destination (keep the same --config-dir if used).")
	}
	fmt.Fprintln(out, "Showing this status does not authorize a transaction.")
}

func requestWithdrawal(ctx context.Context, c config.Config, method string, body any) (zkapi.AddressWithdrawalStatus, error) {
	return requestWithdrawalPath(ctx, c, method, "/admin/withdrawal", body)
}

func requestWithdrawalPath(ctx context.Context, c config.Config, method, path string, body any) (zkapi.AddressWithdrawalStatus, error) {
	var state zkapi.AddressWithdrawalStatus
	var payload []byte
	if body != nil {
		var err error
		payload, err = json.Marshal(body)
		if err != nil {
			return state, errors.New("invalid local withdrawal request")
		}
	}
	timeout := 75 * time.Second
	if method == http.MethodPost {
		timeout = 10 * time.Minute
	}
	transport := &http.Transport{Proxy: nil}
	defer transport.CloseIdleConnections()
	client := &http.Client{Transport: transport, Timeout: timeout, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	req, err := http.NewRequestWithContext(ctx, method, "http://"+c.Listen+path, bytes.NewReader(payload))
	if err != nil {
		return state, errors.New("invalid local withdrawal request")
	}
	req.Header.Set("Authorization", "Bearer "+c.APIKey)
	req.Header.Set("X-OA-Management-Token", c.ManagementToken)
	req.Header.Set("Content-Type", "application/json")
	response, err := client.Do(req)
	if err != nil {
		if ctx.Err() != nil {
			return state, errWithdrawalWaitStopped
		}
		return state, errors.New("local withdrawal request did not complete; inspect saved status before continuing")
	}
	defer response.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(response.Body, (16<<10)+1))
	if err != nil && ctx.Err() != nil {
		return state, errWithdrawalWaitStopped
	}
	if err != nil || len(raw) > 16<<10 {
		return state, errors.New("invalid local withdrawal response; check saved status before retrying")
	}
	if response.StatusCode != http.StatusOK {
		var result struct {
			Error string `json:"error"`
		}
		if json.Unmarshal(raw, &result) == nil && result.Error != "" {
			return state, fmt.Errorf("withdrawal: %s", result.Error)
		}
		return state, errors.New("local withdrawal request failed; check saved status before retrying")
	}
	chain, err := zkapi.ChainID(c.ZKAPI.Network)
	if err != nil || json.Unmarshal(raw, &state) != nil || state.ChainID != chain || !validBillingAsset(state.BillingAsset, state.BillingUnit, state.WeiPerUnit, state.TokenAddress, state.TokenDecimals) || !fundingAddress(state.Address) || !fundingBalance(state.ETHBalance) || (state.ActualFeeWei != "" && !fundingBalance(state.ActualFeeWei)) {
		return state, errors.New("invalid local withdrawal address, token, or network")
	}
	if state.Destination != "" {
		if _, err := zkapi.NormalizeWithdrawalDestination(state.Destination); err != nil {
			return state, errors.New("invalid saved withdrawal destination")
		}
	} else if state.Phase == "withdrawal_pending" || state.Phase == "confirming" || state.Phase == "complete" || state.Phase == "reverted" {
		return state, errors.New("saved withdrawal destination is missing")
	}
	if state.TransactionHash != "" && !validWithdrawalTransactionHash(state.TransactionHash) {
		return state, errors.New("invalid saved withdrawal transaction")
	}
	return state, nil
}

func validWithdrawalTransactionHash(value string) bool {
	if len(value) != 66 || !strings.HasPrefix(value, "0x") {
		return false
	}
	_, err := hex.DecodeString(value[2:])
	return err == nil
}
