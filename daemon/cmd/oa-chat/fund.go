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

var errFundingWaitStopped = errors.New("stopped waiting; inspect saved status before continuing")

func runFunding(ctx context.Context, c config.Config, args []string, out io.Writer) (result error) {
	submitted := false
	defer func() {
		if result != nil && submitted {
			result = fmt.Errorf("%w; recover saved progress with oa-chat fund --resume using the same --config-dir", result)
		}
	}()
	if len(args) > 0 && args[0] == "return" {
		return runPublicReturn(ctx, c, args[1:], out)
	}
	flags := flag.NewFlagSet("fund", flag.ContinueOnError)
	amountText := flags.String("amount", "", "fixed ETH principal, up to 9 decimal places; prepare a quote")
	usdText := flags.String("usd", "", "USD amount converted once to a fixed ETH principal; prepare a quote")
	approval := flags.String("approve", "", "approve the displayed quote ID")
	resume := flags.Bool("resume", false, "recover the saved signed deposit without authorizing a new transaction")
	if err := flags.Parse(args); err != nil {
		return err
	}
	emptyValue := false
	flags.Visit(func(f *flag.Flag) {
		if (f.Name == "amount" || f.Name == "usd" || f.Name == "approve") && f.Value.String() == "" {
			emptyValue = true
		}
	})
	if emptyValue {
		return errors.New("amount, USD value, and approval ID cannot be empty")
	}
	selected := 0
	for _, v := range []bool{*amountText != "", *usdText != "", *approval != "", *resume} {
		if v {
			selected++
		}
	}
	if flags.NArg() != 0 || selected > 1 {
		return errors.New("choose --amount, --usd, --approve, or --resume separately")
	}
	var amount, usd uint64
	var err error
	if *amountText != "" {
		amount, err = parseFundingAmountForAsset(*amountText, 9, "ETH")
	}
	if *usdText != "" {
		usd, err = parseFundingAmountForAsset(*usdText, 6, "USD")
	}
	if err != nil {
		return err
	}
	if *approval != "" && !validQuoteID(*approval) {
		return errors.New("invalid quote ID")
	}
	c, err = activeFundingConfig(ctx, c)
	if err != nil {
		return err
	}
	state, err := requestFunding(ctx, c, http.MethodGet, "/admin/funding/address", nil)
	if err != nil {
		return err
	}
	network := fundingNetwork(state.ChainID)
	fmt.Fprintf(out, "%s funding address:\n%s\nAvailable: %s ETH\n", network, state.Address, fundingUnits(state.ETHBalance, 18))
	fmt.Fprintln(out, "The signing key stays in your private OA Chat config directory; back up that directory.")
	if selected == 0 {
		if state.Amount != 0 {
			fmt.Fprintf(out, "Saved deposit: %s ETH\n", fundingUnits(strconv.FormatUint(state.Amount, 10), 9))
		}
		printFundingProgress(out, state)
		fmt.Fprintln(out, "Prepare a quote: oa-chat fund --amount 0.00075 (ETH), or oa-chat fund --usd 5.00.")
		fmt.Fprintln(out, "Recover an already signed deposit: oa-chat fund --resume. Keep the same --config-dir if used.")
		return nil
	}
	if amount != 0 || usd != 0 {
		body := map[string]uint64{"amount": amount}
		if usd != 0 {
			body = map[string]uint64{"micro_usd": usd}
		}
		quote, err := requestPaymentQuote(ctx, c, http.MethodPost, "/admin/funding/quote", "deposit", body)
		if err != nil {
			return err
		}
		if amount != 0 && quote.Amount != amount {
			return errors.New("deposit quote changed the selected principal; request a fresh quote")
		}
		if usd != 0 && quote.InputMicroUSD != usd {
			return errors.New("deposit quote changed the selected USD amount; request a fresh quote")
		}
		printPaymentQuote(out, quote, "oa-chat fund")
		return nil
	}
	if *approval != "" {
		quote, err := requestPaymentQuote(ctx, c, http.MethodGet, "/admin/funding/quote", "deposit", nil)
		if err != nil {
			return err
		}
		if quote.ID != *approval {
			return errors.New("the saved quote changed; review a fresh quote before approving")
		}
		printPaymentQuote(out, quote, "oa-chat fund")
		submitted = true
		state, err = requestFunding(ctx, c, http.MethodPost, "/admin/funding/approve", map[string]string{"quote_id": *approval})
		if err != nil {
			return err
		}
		if state.Amount != quote.Amount {
			return errors.New("deposit response changed the approved principal; inspect saved status")
		}
	} else {
		if state.Amount == 0 {
			return errors.New("no saved deposit to resume; prepare a quote with --amount or --usd")
		}
		submitted = true
		state, err = requestFunding(ctx, c, http.MethodPost, "/admin/funding/deposit", map[string]uint64{"amount": state.Amount})
		if err != nil {
			return err
		}
	}
	amount = state.Amount
	previous := ""
	for {
		progress := state.Phase + state.Message + state.TransactionHash
		if progress != previous {
			printFundingProgress(out, state)
			previous = progress
		}
		if state.Phase == "active" {
			return nil
		}
		switch state.Phase {
		case "deposit_pending", "approval_pending", "confirming":
		case "waiting_funds", "ready":
			return errors.New("no new transaction was authorized; fund the displayed address if needed, then request and approve a fresh quote")
		default:
			return errors.New("funding stopped; preserve saved progress and follow the status message")
		}
		if err := waitFundingPoll(ctx); err != nil {
			return err
		}
		state, err = requestFunding(ctx, c, http.MethodPost, "/admin/funding/deposit", map[string]uint64{"amount": amount})
		if err != nil {
			return err
		}
		if state.Amount != amount {
			return errors.New("saved deposit principal changed; stopped polling")
		}
	}
}

func printFundingProgress(out io.Writer, state zkapi.AddressFundingStatus) {
	fmt.Fprintf(out, "%s: %s\n", state.Phase, state.Message)
	if state.TransactionHash != "" {
		fmt.Fprintln(out, "Transaction:", state.TransactionHash)
	}
	if state.ActualFeeWei != "" {
		fmt.Fprintf(out, "Actual network fee: %s ETH\n", fundingUnits(state.ActualFeeWei, 18))
	}
}

func waitFundingPoll(ctx context.Context) error {
	timer := time.NewTimer(5 * time.Second)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return errFundingWaitStopped
	case <-timer.C:
		return nil
	}
}

func parseFundingAmount(value string) (uint64, error) {
	return parseFundingAmountForAsset(value, 6, "USDC")
}

func parseFundingAmountForAsset(value string, decimals int, asset string) (uint64, error) {
	bad := fmt.Errorf("amount must be positive %s with at most %d decimal places, up to %s", asset, decimals, fundingUnits("1000000000000", decimals))
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
	if len(fraction) > decimals {
		return 0, bad
	}
	units, err := strconv.ParseUint(parts[0]+fraction+strings.Repeat("0", decimals-len(fraction)), 10, 64)
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
	req.Header.Set("X-OA-Management-Token", c.ManagementToken)
	response, err := client.Do(req)
	if err != nil {
		if ctx.Err() != nil {
			return state, errFundingWaitStopped
		}
		return state, errors.New("local funding service unavailable or request interrupted; inspect saved status before continuing")
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
	if json.Unmarshal(raw, &state) != nil || state.ChainID != chain || !fundingAddress(state.Address) || !validBillingAsset(state.BillingAsset, state.BillingUnit, state.WeiPerUnit, state.TokenAddress, state.TokenDecimals) || !fundingBalance(state.TokenBalance) || !fundingBalance(state.ETHBalance) || (state.ActualFeeWei != "" && !fundingBalance(state.ActualFeeWei)) {
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

// Legacy responses remain readable for explicit recovery, while native ETH
// requires its exact gwei scale and cannot masquerade as a six-decimal token.
func validBillingAsset(asset, unit, weiPerUnit, token string, decimals int) bool {
	if asset == "native_eth" {
		return unit == "gwei" && weiPerUnit == "1000000000" && token == "" && decimals == 9
	}
	return (asset == "" || asset == "erc20") && fundingAddress(token) && decimals == 6 && weiPerUnit == ""
}
