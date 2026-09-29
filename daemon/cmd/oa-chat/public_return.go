package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"math/big"
	"net/http"
	"strings"

	"github.com/OpenAnonymity/oa-chat/daemon/internal/config"
	"github.com/OpenAnonymity/oa-chat/daemon/internal/zkapi"
)

// Public returns have 18-decimal precision; private deposits use integer gwei.
func parseReturnAmount(value string) (string, error) {
	parts := strings.Split(value, ".")
	if len(parts) > 2 || parts[0] == "" || len(value) > 80 {
		return "", errors.New("return amount must be positive ETH with at most 18 decimal places")
	}
	for _, p := range parts {
		if p == "" || strings.IndexFunc(p, func(r rune) bool { return r < '0' || r > '9' }) >= 0 {
			return "", errors.New("invalid return amount")
		}
	}
	fraction := ""
	if len(parts) == 2 {
		fraction = parts[1]
	}
	if len(fraction) > 18 {
		return "", errors.New("return amount has more than 18 decimal places")
	}
	n, ok := new(big.Int).SetString(parts[0]+fraction+strings.Repeat("0", 18-len(fraction)), 10)
	if !ok || n.Sign() <= 0 || n.BitLen() > 256 {
		return "", errors.New("invalid return amount")
	}
	return n.String(), nil
}

func runPublicReturn(ctx context.Context, c config.Config, args []string, out io.Writer) (result error) {
	submitted := false
	defer func() {
		if result != nil && submitted {
			result = fmt.Errorf("%w; recover saved progress with oa-chat config, choose return, and use the same --config-dir", result)
		}
	}()
	flags := flag.NewFlagSet("fund return", flag.ContinueOnError)
	to := flags.String("to", "", "explicit recipient for public ETH")
	amountText := flags.String("amount", "", "exact ETH amount (up to 18 decimals); omit to sweep an EOA after reserving fees")
	approve := flags.String("approve", "", "approve the displayed return quote ID")
	resume := flags.Bool("resume", false, "recover the saved signed public return")
	if err := flags.Parse(args); err != nil {
		return err
	}
	emptyValue := false
	flags.Visit(func(f *flag.Flag) {
		if (f.Name == "to" || f.Name == "amount" || f.Name == "approve") && f.Value.String() == "" {
			emptyValue = true
		}
	})
	if emptyValue {
		return errors.New("destination, amount, and approval ID cannot be empty")
	}
	if flags.NArg() != 0 || (*amountText != "" && *to == "") || (*approve != "" && (*to != "" || *resume)) || (*resume && *to != "") {
		return errors.New("use --to ADDRESS [--amount ETH], --approve QUOTE_ID, or --resume separately")
	}
	var err error
	destination, amount := "", ""
	if *to != "" {
		destination, err = zkapi.NormalizeWithdrawalDestination(*to)
		if err != nil {
			return err
		}
	}
	if *amountText != "" {
		amount, err = parseReturnAmount(*amountText)
		if err != nil {
			return err
		}
	}
	if *approve != "" && !validQuoteID(*approve) {
		return errors.New("invalid quote ID")
	}
	c, err = activeFundingConfig(ctx, c)
	if err != nil {
		return err
	}
	if destination != "" {
		q, err := requestPaymentQuote(ctx, c, http.MethodPost, "/admin/return/quote", "return", map[string]string{"destination": destination, "amount_wei": amount})
		if err != nil {
			return err
		}
		if !strings.EqualFold(q.Destination, destination) || (amount != "" && q.PrincipalWei != amount) {
			return errors.New("return quote changed the destination or amount")
		}
		printPaymentQuote(out, q, "oa-chat fund return")
		return nil
	}
	path, method := "/admin/return", http.MethodGet
	var body any
	if *approve != "" {
		q, err := requestPaymentQuote(ctx, c, http.MethodGet, "/admin/return/quote", "return", nil)
		if err != nil {
			return err
		}
		if q.ID != *approve {
			return errors.New("the saved return quote changed; review a fresh quote")
		}
		printPaymentQuote(out, q, "oa-chat fund return")
		destination, amount = q.Destination, q.PrincipalWei
		path, method, body = "/admin/return/approve", http.MethodPost, map[string]string{"quote_id": *approve}
	}
	previous := ""
	for {
		var state zkapi.AddressReturnStatus
		if method == http.MethodPost {
			submitted = true
		}
		if err = requestManagementJSON(ctx, c, method, path, body, &state); err != nil {
			return err
		}
		chain, _ := zkapi.ChainID(c.ZKAPI.Network)
		if state.ChainID != chain || !fundingAddress(state.Address) || !fundingBalance(state.ETHBalance) || (state.Destination != "" && !fundingAddress(state.Destination)) || (state.AmountWei != "" && !fundingBalance(state.AmountWei)) || (state.ActualFeeWei != "" && !fundingBalance(state.ActualFeeWei)) || (state.TransactionHash != "" && !validWithdrawalTransactionHash(state.TransactionHash)) {
			return errors.New("invalid public return status")
		}
		if destination != "" && (!strings.EqualFold(destination, state.Destination) || amount != state.AmountWei) {
			return errors.New("public return response changed the approved amount or destination; stopped polling")
		}
		progress := state.Phase + state.Message + state.TransactionHash
		if progress != previous {
			fmt.Fprintf(out, "%s public ETH return\nSigning address: %s\nAvailable: %s ETH\n%s: %s\n", fundingNetwork(chain), state.Address, fundingUnits(state.ETHBalance, 18), state.Phase, state.Message)
			if state.TransactionHash != "" {
				fmt.Fprintln(out, "Transaction:", state.TransactionHash)
			}
			if state.ActualFeeWei != "" {
				fmt.Fprintf(out, "Actual network fee: %s ETH\n", fundingUnits(state.ActualFeeWei, 18))
			}
			previous = progress
		}
		if method == http.MethodGet {
			if *resume {
				if state.Phase == "complete" {
					return nil
				}
				if (state.Phase != "return_pending" && state.Phase != "confirming") || state.Destination == "" || state.AmountWei == "" || state.TransactionHash == "" {
					return errors.New("no signed public return to resume; prepare and approve a quote first")
				}
				destination, amount = state.Destination, state.AmountWei
				method, path, body = http.MethodPost, "/admin/return", nil
				continue
			}
			fmt.Fprintln(out, "Prepare a quote: oa-chat fund return --to ADDRESS [--amount ETH]. Close any private balance before returning its fee funds.")
			return nil
		}
		switch state.Phase {
		case "complete":
			return nil
		case "return_pending", "confirming":
		default:
			return errors.New("return stopped; inspect saved status before preparing another quote")
		}
		if err = waitFundingPoll(ctx); err != nil {
			return err
		}
		method, path, body = http.MethodPost, "/admin/return", nil
	}
}
