package main

import (
	"bytes"
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/big"
	"net/http"
	"strings"
	"time"

	"github.com/OpenAnonymity/oa-chat/daemon/internal/config"
	"github.com/OpenAnonymity/oa-chat/daemon/internal/zkapi"
)

func activeFundingConfig(ctx context.Context, c config.Config) (config.Config, error) {
	active, err := resolveActiveConfig(ctx, c)
	if err != nil {
		if ctx.Err() != nil {
			return c, errFundingWaitStopped
		}
		return c, err
	}
	if active.Backend != "zkapi" {
		return c, errors.New("wallet commands require the running daemon to use zkapi; start oa-chat serve --backend zkapi")
	}
	return active, nil
}

func validQuoteID(id string) bool {
	if len(id) != 64 {
		return false
	}
	_, err := hex.DecodeString(id)
	return err == nil
}

func fundingNetwork(chain uint64) string {
	if chain == 11155111 {
		return "Ethereum Sepolia (test network)"
	}
	return "Ethereum Mainnet"
}

func requestManagementJSON(ctx context.Context, c config.Config, method, path string, body, result any) error {
	var payload []byte
	var err error
	if body != nil {
		payload, err = json.Marshal(body)
		if err != nil {
			return errors.New("invalid management request")
		}
	}
	transport := &http.Transport{Proxy: nil}
	defer transport.CloseIdleConnections()
	client := &http.Client{Transport: transport, Timeout: 10 * time.Minute, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	req, err := http.NewRequestWithContext(ctx, method, "http://"+c.Listen+path, bytes.NewReader(payload))
	if err != nil {
		return errors.New("invalid local management endpoint")
	}
	req.Header.Set("Authorization", "Bearer "+c.APIKey)
	req.Header.Set("X-OA-Management-Token", c.ManagementToken)
	req.Header.Set("Content-Type", "application/json")
	response, err := client.Do(req)
	if err != nil {
		if ctx.Err() != nil {
			return errFundingWaitStopped
		}
		return errors.New("local wallet request did not complete; check saved status before retrying")
	}
	defer response.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(response.Body, (32<<10)+1))
	if err != nil && ctx.Err() != nil {
		return errFundingWaitStopped
	}
	if err != nil || len(raw) > 32<<10 {
		return errors.New("invalid local wallet response")
	}
	if response.StatusCode != http.StatusOK {
		var failed struct {
			Error string `json:"error"`
		}
		if json.Unmarshal(raw, &failed) == nil && failed.Error != "" {
			return fmt.Errorf("wallet: %s", failed.Error)
		}
		return errors.New("local wallet request failed; check saved status before retrying")
	}
	if json.Unmarshal(raw, result) != nil {
		return errors.New("invalid local wallet response")
	}
	return nil
}

func requestPaymentQuote(ctx context.Context, c config.Config, method, path, kind string, body any) (zkapi.AddressPaymentQuote, error) {
	var q zkapi.AddressPaymentQuote
	if err := requestManagementJSON(ctx, c, method, path, body, &q); err != nil {
		return q, err
	}
	chain, err := zkapi.ChainID(c.ZKAPI.Network)
	if err != nil || q.ChainID != chain || q.Kind != kind || !validQuoteID(q.ID) || !fundingAddress(q.Address) || !fundingAddress(q.Contract) || q.FeePolicy != "low" || q.EstimatedGas == 0 || q.GasLimit < q.EstimatedGas || q.ExpiresAt <= time.Now().UnixMilli() {
		return q, errors.New("invalid payment quote or network")
	}
	if !zkapi.MatchesDeployment(c.ZKAPI.Network, q.DeploymentID, q.Contract) {
		return q, errors.New("payment quote does not match the pinned deployment")
	}
	for _, quantity := range []string{q.PrincipalWei, q.BalanceWei, q.ExpectedFeeWei, q.RequiredFeeWei, q.FeeReserveWei, q.FeeBufferWei, q.RequiredTotalWei, q.RecommendedTotalWei, q.ShortfallWei, q.RecommendedTopUpWei, q.MaxFeePerGas, q.MaxPriorityFeePerGas} {
		if !fundingBalance(quantity) {
			return q, errors.New("invalid payment quote quantity")
		}
	}
	if kind == "deposit" && q.Amount == 0 {
		return q, errors.New("invalid deposit principal")
	}
	if kind != "deposit" {
		if _, err := zkapi.NormalizeWithdrawalDestination(q.Destination); err != nil {
			return q, errors.New("invalid quoted destination")
		}
	}
	if kind == "deposit" && q.PrincipalWei != new(big.Int).Mul(new(big.Int).SetUint64(q.Amount), big.NewInt(1_000_000_000)).String() {
		return q, errors.New("deposit quote principal does not match native units")
	}
	return q, nil
}

func printPaymentQuote(out io.Writer, q zkapi.AddressPaymentQuote, command string) {
	fmt.Fprintf(out, "\n%s %s quote\n", fundingNetwork(q.ChainID), q.Kind)
	if q.InputMicroUSD != 0 {
		fmt.Fprintf(out, "Selected USD value: $%s (converted once to the fixed ETH principal below)\n", fundingUnits(fmt.Sprint(q.InputMicroUSD), 6))
	}
	principal := q.PrincipalWei
	if q.Kind == "withdrawal" {
		principal = new(big.Int).Mul(new(big.Int).SetUint64(q.Amount), big.NewInt(1_000_000_000)).String()
	}
	fmt.Fprintf(out, "Fixed amount: %s ETH\n", fundingUnits(principal, 18))
	if q.Destination != "" {
		fmt.Fprintln(out, "Destination:", q.Destination)
	}
	fmt.Fprintf(out, "Local signing address: %s\nAvailable public balance: %s ETH\n", q.Address, fundingUnits(q.BalanceWei, 18))
	fmt.Fprintf(out, "Estimated network fee: %s ETH\nRequired fee allowance: %s ETH\nMaximum approved fee allowance: %s ETH (Low)\nOptional fee buffer: %s ETH\n", fundingUnits(q.ExpectedFeeWei, 18), fundingUnits(q.RequiredFeeWei, 18), fundingUnits(q.FeeReserveWei, 18), fundingUnits(q.FeeBufferWei, 18))
	if strings.TrimLeft(q.ShortfallWei, "0") != "" {
		fmt.Fprintf(out, "Required top-up: %s ETH\nRecommended top-up including buffer: %s ETH\nSend on %s to %s\nPayment URI: ethereum:%s@%d?value=%s\n", fundingUnits(q.ShortfallWei, 18), fundingUnits(q.RecommendedTopUpWei, 18), fundingNetwork(q.ChainID), q.Address, q.Address, q.ChainID, q.RecommendedTopUpWei)
		fmt.Fprintln(out, "After funds arrive, request a fresh quote. The optional buffer does not block a funded transaction.")
	} else {
		fmt.Fprintln(out, "The existing balance covers the required amount; no top-up is needed.")
	}
	fmt.Fprintf(out, "Quote expires: %s\nTo authorize this exact quote: %s --approve %s\nKeep the same --config-dir if used. Quoting does not sign or broadcast.\n", time.UnixMilli(q.ExpiresAt).Format(time.RFC3339), command, q.ID)
}
