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

var errWithdrawalWaitStopped = errors.New("stopped waiting; the withdrawal may still be progressing; rerun the same command with the same --config-dir to resume saved progress")

func runWithdrawal(ctx context.Context, c config.Config, args []string, out io.Writer) error {
	flags := flag.NewFlagSet("withdraw", flag.ContinueOnError)
	destinationText := flags.String("to", "", "Ethereum address receiving the full remaining private balance")
	confirmationText := flags.String("confirm", "", "confirm an independently submitted matching withdrawal after a finalized local revert")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if flags.NArg() != 0 {
		return errors.New("unexpected withdraw arguments")
	}
	if c.Backend != "zkapi" {
		return errors.New("withdraw requires the zkapi backend")
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
		return errors.New("--confirm requires --to and a valid 32-byte transaction hash (0x followed by 64 hexadecimal characters)")
	}
	destination := ""
	if destinationSet {
		var err error
		destination, err = zkapi.NormalizeWithdrawalDestination(*destinationText)
		if err != nil {
			return err
		}
	}
	state, err := requestWithdrawal(ctx, c, http.MethodGet, nil)
	if err != nil {
		return err
	}
	// Preserve the note selected by this command even if another process closes
	// it and funds a new note while this command is suspended or polling.
	noteID := state.NoteID
	if confirmationSet {
		resumingConfirmation := (state.Phase == "confirming" || state.Phase == "complete") && strings.EqualFold(*confirmationText, state.TransactionHash)
		if state.Phase != "reverted" && !resumingConfirmation {
			return errors.New("--confirm is available only after the saved local withdrawal transaction has finalized as reverted, or to resume the same saved confirmation transaction; run oa-chat withdraw to inspect saved status")
		}
	}
	network, token := "Ethereum Mainnet", "USDC"
	if state.ChainID == 11155111 {
		network, token = "Ethereum Sepolia (test network)", "test billing tokens"
	}
	fmt.Fprintf(out, "%s withdrawal\nPrivate balance: %s %s\nToken contract: %s\n", network, fundingUnits(strconv.FormatUint(state.PrivateBalance, 10), 6), token, state.TokenAddress)
	fmt.Fprintf(out, "Local signing address: %s\nAvailable for network fees: %s ETH\n", state.Address, fundingUnits(state.ETHBalance, 18))
	printWithdrawalProgress(out, state, token)
	if !destinationSet {
		withdrawalResumeInstructions(out, state)
		return nil
	}
	if state.Phase == "complete" {
		if !strings.EqualFold(destination, state.Destination) {
			return errors.New("the completed withdrawal went to its saved destination; no new private balance is ready to withdraw")
		}
		return nil
	}
	if state.Phase == "no_note" {
		return errors.New("there is no private balance to withdraw")
	}
	if state.Phase == "recovery_required" {
		return errors.New("withdrawal requires recovery; preserve the local funding and companion files and follow the status message")
	}
	// A ready response describes the current note, even if a prior completed
	// withdrawal belonged to a different note. Other saved destinations bind
	// the pending authorization and cannot be replaced by this command.
	if state.Phase != "ready" && state.Destination != "" && !strings.EqualFold(destination, state.Destination) {
		return errors.New("a withdrawal to a different destination is already saved; rerun withdraw --to with the saved destination")
	}
	switch state.Phase {
	case "ready", "waiting_settlement", "waiting_funds", "withdrawal_pending", "confirming", "reverted":
	default:
		return errors.New("unknown withdrawal status; no withdrawal request was submitted")
	}
	if confirmationSet {
		fmt.Fprintf(out, "\nCheck transaction %s for the saved withdrawal to %s on %s. This does not authorize another transaction.\n", *confirmationText, destination, network)
	} else {
		fmt.Fprintf(out, "\nWithdraw the full remaining balance to %s on %s. This closes the private balance.\n", destination, network)
		fmt.Fprintln(out, "The local signer spends ETH network fees, capped at 0.02 ETH per transaction. No wallet connection is needed.")
		fmt.Fprintln(out, "Proof preparation may take several minutes. Press Ctrl+C to stop waiting; a submitted transaction is not canceled.")
	}
	// Only a fresh explicit command that observed this exact finalized revert
	// may authorize its replacement. Polling clients never inherit permission
	// from another client's update to the persisted phase.
	retryHash := ""
	if state.Phase == "reverted" && !confirmationSet {
		if state.TransactionHash == "" {
			return errors.New("the reverted withdrawal has no saved transaction hash; preserve recovery files and check status before retrying")
		}
		retryHash = state.TransactionHash
	}
	confirmationHash := *confirmationText
	previous := ""
	for {
		body := map[string]any{"destination": destination, "note_id": noteID}
		if confirmationHash != "" {
			body["confirmation_transaction_hash"] = confirmationHash
			confirmationHash = "" // Receipt adoption is authorized once, never a resubmission.
		}
		if retryHash != "" {
			body["retry_transaction_hash"] = retryHash
			retryHash = "" // One request only, including when its reply is lost.
		}
		state, err = requestWithdrawal(ctx, c, http.MethodPost, body)
		if err != nil {
			return err
		}
		if state.NoteID != noteID {
			return errors.New("the withdrawal response refers to a different private note; stopped without requesting further progress")
		}
		if state.Destination != "" && !strings.EqualFold(destination, state.Destination) {
			return errors.New("the withdrawal response has a different destination; stopped without requesting further progress")
		}
		progress := state.Phase + ": " + state.Message + "\n" + state.TransactionHash
		if progress != previous {
			printWithdrawalProgress(out, state, token)
			previous = progress
		}
		switch state.Phase {
		case "complete":
			return nil
		case "waiting_settlement":
			fmt.Fprintf(out, "After settlement, rerun oa-chat withdraw --to %s (keep the same --config-dir if used).\n", destination)
			return errors.New("withdrawal is waiting for the active inference lease to settle; rerun the same command afterward")
		case "waiting_funds":
			fmt.Fprintf(out, "Send ETH on %s to the local signing address %s for withdrawal fees.\n", network, state.Address)
			withdrawalResumeInstructions(out, state)
			return errors.New("withdrawal is waiting for ETH network fees; rerun the same command after the funds arrive")
		case "withdrawal_pending", "confirming":
			// Only these defined states authorize continuation of this run.
		case "reverted":
			withdrawalResumeInstructions(out, state)
			return errors.New("the withdrawal transaction reverted; progress is saved; another explicit command is required to retry")
		default:
			return errors.New("withdrawal stopped; preserve saved progress and follow the status message before retrying")
		}
		timer := time.NewTimer(5 * time.Second)
		select {
		case <-ctx.Done():
			timer.Stop()
			return errWithdrawalWaitStopped
		case <-timer.C:
		}
	}
}

func printWithdrawalProgress(out io.Writer, state zkapi.AddressWithdrawalStatus, token string) {
	if state.Destination != "" && state.Phase != "ready" {
		fmt.Fprintf(out, "Saved withdrawal: %s %s to %s\n", fundingUnits(strconv.FormatUint(state.Amount, 10), 6), token, state.Destination)
	}
	fmt.Fprintf(out, "%s: %s\n", state.Phase, state.Message)
	if state.TransactionHash != "" {
		fmt.Fprintln(out, "Transaction:", state.TransactionHash)
	}
}

func withdrawalResumeInstructions(out io.Writer, state zkapi.AddressWithdrawalStatus) {
	switch state.Phase {
	case "complete", "no_note", "recovery_required":
		return
	}
	if state.Destination != "" && state.Phase != "ready" {
		fmt.Fprintf(out, "To continue this saved withdrawal, run oa-chat withdraw --to %s (keep the same --config-dir if used).\n", state.Destination)
	} else {
		fmt.Fprintln(out, "To withdraw the full remaining balance, run oa-chat withdraw --to ADDRESS, replacing ADDRESS with your Ethereum destination (keep the same --config-dir if used).")
	}
	fmt.Fprintln(out, "Showing this status does not authorize a transaction.")
}

func requestWithdrawal(ctx context.Context, c config.Config, method string, body any) (zkapi.AddressWithdrawalStatus, error) {
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
	req, err := http.NewRequestWithContext(ctx, method, "http://"+c.Listen+"/admin/withdrawal", bytes.NewReader(payload))
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
		return state, errors.New("local withdrawal request did not complete; ensure oa-chat serve is running, then rerun the same command to recover saved progress")
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
	if err != nil || json.Unmarshal(raw, &state) != nil || state.ChainID != chain || state.TokenDecimals != 6 || !fundingAddress(state.Address) || !fundingAddress(state.TokenAddress) || !fundingBalance(state.ETHBalance) {
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
