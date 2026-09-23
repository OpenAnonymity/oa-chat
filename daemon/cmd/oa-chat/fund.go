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

var errFundingWaitStopped = errors.New("stopped waiting; rerun the same command to resume saved progress")

func runFunding(ctx context.Context, c config.Config, args []string, out io.Writer) error {
	flags := flag.NewFlagSet("fund", flag.ContinueOnError)
	amountText := flags.String("amount", "", "USDC amount to deposit; waits for incoming funds (up to 6 decimal places)")
	browser := flags.Bool("browser", false, "open the optional funding page")
	noOpen := flags.Bool("no-open", false, "print the optional browser funding URL without opening it")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if flags.NArg() != 0 {
		return errors.New("unexpected fund arguments")
	}
	if c.Backend != "zkapi" {
		return errors.New("fund requires the zkapi backend")
	}
	if (*browser && *noOpen) || (*amountText != "" && (*browser || *noOpen)) {
		return errors.New("choose --amount, --browser, or --no-open separately")
	}
	var amount uint64
	if *amountText != "" {
		var err error
		amount, err = parseFundingAmount(*amountText)
		if err != nil {
			return err
		}
	}
	if *browser || *noOpen {
		data, err := localRequest(ctx, c, "POST", "/admin/fund")
		if err != nil {
			return err
		}
		var result struct {
			URL string `json:"url"`
		}
		if json.Unmarshal(data, &result) != nil || !strings.HasPrefix(result.URL, "http://"+c.Listen+"/funding#") {
			return errors.New("invalid local funding URL")
		}
		if *noOpen {
			fmt.Fprintln(out, result.URL)
			return nil
		}
		if err := openBrowser(result.URL); err != nil {
			return errors.New("could not open browser; use oa-chat fund in the terminal or fund --no-open for the URL")
		}
		fmt.Fprintln(out, "Opened the address funding page. No wallet connection is needed.")
		return nil
	}
	state, err := requestFunding(ctx, c, "GET", "/admin/funding/address", nil)
	if err != nil {
		return err
	}
	network := "Ethereum Mainnet"
	token := "USDC"
	if state.ChainID == 11155111 {
		network, token = "Ethereum Sepolia (test network)", "test USDC"
	}
	fmt.Fprintf(out, "%s funding address:\n%s\n\nSend %s and ETH for network fees to this same address on %s.\nToken contract: %s\n", network, state.Address, token, network, state.TokenAddress)
	fmt.Fprintf(out, "Available: %s %s; %s ETH\n", fundingUnits(state.TokenBalance, 6), token, fundingUnits(state.ETHBalance, 18))
	fmt.Fprintln(out, "No wallet connection is needed. The signing key stays in your private OA Chat config directory; back up that directory.")
	fmt.Fprintln(out, "Deposits also spend ETH network fees, capped at 0.02 ETH per transaction.")
	if amount == 0 {
		if state.Amount != 0 {
			fmt.Fprintf(out, "Saved deposit: %s %s\n%s: %s\n", fundingUnits(strconv.FormatUint(state.Amount, 10), 6), token, state.Phase, state.Message)
			if state.TransactionHash != "" {
				fmt.Fprintln(out, "Transaction:", state.TransactionHash)
			}
		}
		if state.Phase == "active" || state.Phase == "recovery_required" || state.Phase == "legacy_recovery" {
			return nil
		}
		nextAmount := "0.10"
		if state.Amount != 0 {
			nextAmount = fundingUnits(strconv.FormatUint(state.Amount, 10), 6)
		}
		fmt.Fprintf(out, "To deposit or resume, run oa-chat fund --amount %s (keep the same --config-dir if used).\n", nextAmount)
		fmt.Fprintln(out, "Address balances become private credits only after this deposit step.")
		return nil
	}
	fmt.Fprintf(out, "\nDepositing %s %s into your private balance. Press Ctrl+C to stop waiting; saved transactions can be resumed with the same command.\n", fundingUnits(strconv.FormatUint(amount, 10), 6), token)
	previous := ""
	for {
		state, err = requestFunding(ctx, c, "POST", "/admin/funding/deposit", map[string]uint64{"amount": amount})
		if err != nil {
			return err
		}
		progress := state.Phase + ": " + state.Message
		if state.TransactionHash != "" {
			progress += "\nTransaction: " + state.TransactionHash
		}
		if progress != previous {
			fmt.Fprintln(out, progress)
			previous = progress
		}
		if state.Phase == "active" {
			return nil
		}
		switch state.Phase {
		case "waiting_funds", "approval_pending", "deposit_pending", "confirming", "ready":
			// Continue only states defined by the address-funding protocol.
		default:
			return errors.New("funding stopped; preserve saved progress and follow the status message before retrying")
		}
		timer := time.NewTimer(5 * time.Second)
		select {
		case <-ctx.Done():
			timer.Stop()
			return errFundingWaitStopped
		case <-timer.C:
		}
	}
}

func parseFundingAmount(value string) (uint64, error) {
	bad := errors.New("amount must be positive USDC with at most 6 decimal places, up to 1000000")
	parts := strings.Split(value, ".")
	if len(parts) > 2 || parts[0] == "" || len(value) > 24 {
		return 0, bad
	}
	for _, part := range parts {
		if part == "" || strings.IndexFunc(part, func(r rune) bool { return r < '0' || r > '9' }) >= 0 {
			return 0, bad
		}
	}
	fraction := ""
	if len(parts) == 2 {
		fraction = parts[1]
	}
	if len(fraction) > 6 {
		return 0, bad
	}
	units, err := strconv.ParseUint(parts[0]+fraction+strings.Repeat("0", 6-len(fraction)), 10, 64)
	if err != nil || units == 0 || units > 1_000_000_000_000 {
		return 0, bad
	}
	return units, nil
}

func fundingUnits(raw string, decimals int) string {
	if len(raw) <= decimals {
		raw = strings.Repeat("0", decimals+1-len(raw)) + raw
	}
	return raw[:len(raw)-decimals] + "." + raw[len(raw)-decimals:]
}

func requestFunding(ctx context.Context, c config.Config, method, path string, body any) (zkapi.AddressFundingStatus, error) {
	var state zkapi.AddressFundingStatus
	var payload []byte
	if body != nil {
		payload, _ = json.Marshal(body)
	}
	client := &http.Client{Transport: &http.Transport{Proxy: nil}, Timeout: 75 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	req, err := http.NewRequestWithContext(ctx, method, "http://"+c.Listen+path, bytes.NewReader(payload))
	if err != nil {
		return state, errors.New("invalid local funding request")
	}
	req.Header.Set("Authorization", "Bearer "+c.APIKey)
	req.Header.Set("Content-Type", "application/json")
	response, err := client.Do(req)
	if err != nil {
		if ctx.Err() != nil {
			return state, errFundingWaitStopped
		}
		return state, errors.New("local funding service unavailable; start oa-chat serve, then retry the same command to resume saved progress")
	}
	defer response.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(response.Body, (16<<10)+1))
	if err != nil && ctx.Err() != nil {
		return state, errFundingWaitStopped
	}
	if err != nil || len(raw) > 16<<10 {
		return state, errors.New("invalid local funding response")
	}
	if response.StatusCode != http.StatusOK {
		var result struct {
			Error string `json:"error"`
		}
		if json.Unmarshal(raw, &result) == nil && result.Error != "" {
			return state, fmt.Errorf("funding: %s", result.Error)
		}
		return state, errors.New("local funding request failed")
	}
	chain, _ := zkapi.ChainID(c.ZKAPI.Network)
	if json.Unmarshal(raw, &state) != nil || state.ChainID != chain || !fundingAddress(state.Address) || !fundingAddress(state.TokenAddress) || !fundingBalance(state.TokenBalance) || !fundingBalance(state.ETHBalance) {
		return state, errors.New("invalid local funding address or network")
	}
	return state, nil
}

func fundingAddress(value string) bool {
	if len(value) != 42 || !strings.HasPrefix(value, "0x") || value == "0x"+strings.Repeat("0", 40) {
		return false
	}
	_, err := hex.DecodeString(value[2:])
	return err == nil
}

func fundingBalance(value string) bool {
	return value != "" && len(value) <= 78 && strings.IndexFunc(value, func(r rune) bool { return r < '0' || r > '9' }) < 0
}
