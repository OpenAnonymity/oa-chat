package main

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/OpenAnonymity/oa-chat/daemon/internal/config"
)

func TestFundingAmountExactUnits(t *testing.T) {
	for value, want := range map[string]uint64{"0.10": 100000, "1": 1000000, "0.000001": 1, "1000000.000000": 1000000000000, "01.02": 1020000} {
		got, err := parseFundingAmount(value)
		if err != nil || got != want {
			t.Fatalf("%s: got %d, %v; want %d", value, got, err, want)
		}
	}
	for _, value := range []string{"", "0", "-1", "+1", "1e3", "1.0000001", "1000000.000001", "1.", ".1", " 1", "1.2.3", "18446744073709551615", "1\n", "１"} {
		if _, err := parseFundingAmount(value); err == nil {
			t.Fatalf("invalid amount %q accepted", value)
		}
	}
}

func fundingTestStatus(phase string) map[string]any {
	return map[string]any{
		"address": "0x1111111111111111111111111111111111111111", "chain_id": 1,
		"token_address": "0x2222222222222222222222222222222222222222", "token_balance": "1230000", "eth_balance": "1000000000000000",
		"phase": phase, "message": "Payment progress saved locally.",
	}
}

func fundingTestConfig(s *httptest.Server) config.Config {
	return config.Config{Backend: "zkapi", Listen: strings.TrimPrefix(s.URL, "http://"), APIKey: strings.Repeat("a", 32), ZKAPI: config.ZKAPI{Network: "mainnet"}}
}

func TestFundDefaultsToAddressWithoutBrowserOrSpending(t *testing.T) {
	requests := 0
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests++
		if r.URL.Path != "/admin/funding/address" || r.Method != "GET" || r.Header.Get("Authorization") != "Bearer "+strings.Repeat("a", 32) {
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
		}
		_ = json.NewEncoder(w).Encode(fundingTestStatus("ready"))
	}))
	defer s.Close()
	var out bytes.Buffer
	if err := runFunding(context.Background(), fundingTestConfig(s), nil, &out); err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"Ethereum Mainnet", "0x1111111111111111111111111111111111111111", "1.230000 USDC", "0.001000000000000000 ETH", "fund --amount", "signing key stays"} {
		if !strings.Contains(out.String(), want) {
			t.Fatalf("missing %q in %s", want, out.String())
		}
	}
	if requests != 1 {
		t.Fatal("showing the address made additional funding requests")
	}
}

func TestFundAmountAuthorizesExactDeposit(t *testing.T) {
	var methods []string
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		methods = append(methods, r.Method+" "+r.URL.Path)
		phase := "ready"
		if r.Method == "POST" {
			var body map[string]uint64
			if json.NewDecoder(r.Body).Decode(&body) != nil || body["amount"] != 100001 || len(body) != 1 {
				t.Error("deposit amount was rounded or not sent exactly")
			}
			phase = "active"
		}
		_ = json.NewEncoder(w).Encode(fundingTestStatus(phase))
	}))
	defer s.Close()
	var out bytes.Buffer
	if err := runFunding(context.Background(), fundingTestConfig(s), []string{"--amount", "0.100001"}, &out); err != nil {
		t.Fatal(err)
	}
	if strings.Join(methods, ",") != "GET /admin/funding/address,POST /admin/funding/deposit" {
		t.Fatalf("wrong funding sequence: %v", methods)
	}
}

func TestFundDisplaysSavedAmountForResumption(t *testing.T) {
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "GET" {
			t.Error("viewing saved progress authorized a transaction")
		}
		state := fundingTestStatus("deposit_pending")
		state["amount"] = 234567
		_ = json.NewEncoder(w).Encode(state)
	}))
	defer s.Close()
	var out bytes.Buffer
	if err := runFunding(context.Background(), fundingTestConfig(s), nil, &out); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), "Saved deposit: 0.234567 USDC") || !strings.Contains(out.String(), "fund --amount 0.234567") {
		t.Fatalf("saved amount was not shown: %s", out.String())
	}
}

func TestFundRejectsNetworkMismatchBeforeDeposit(t *testing.T) {
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "GET" {
			t.Error("wrong network initiated a deposit")
		}
		state := fundingTestStatus("ready")
		state["chain_id"] = 11155111
		_ = json.NewEncoder(w).Encode(state)
	}))
	defer s.Close()
	if err := runFunding(context.Background(), fundingTestConfig(s), []string{"--amount", "1"}, &bytes.Buffer{}); err == nil {
		t.Fatal("mismatched network accepted")
	}
}

func TestFundCancellationRetainsResumptionGuidance(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(fundingTestStatus("waiting_funds"))
		if r.Method == "POST" {
			w.(http.Flusher).Flush()
			cancel()
		}
	}))
	defer s.Close()
	err := runFunding(ctx, fundingTestConfig(s), []string{"--amount", "0.10"}, &bytes.Buffer{})
	if err == nil || !(strings.Contains(err.Error(), "resume") || strings.Contains(err.Error(), "retry")) {
		t.Fatalf("cancellation lost recovery guidance: %v", err)
	}
}

func TestFundStopsOnLegacyRecovery(t *testing.T) {
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(fundingTestStatus("legacy_recovery"))
	}))
	defer s.Close()
	var out bytes.Buffer
	if err := runFunding(context.Background(), fundingTestConfig(s), []string{"--amount", "0.10"}, &out); err == nil {
		t.Fatal("legacy recovery should stop instead of submitting repeatedly")
	}
}

func TestFundInvalidOptionsDoNotReachDaemon(t *testing.T) {
	c := config.Config{Backend: "zkapi", Listen: "127.0.0.1:1"}
	for _, args := range [][]string{{"--amount", "-1"}, {"--amount", "1", "--no-open"}, {"--browser", "--no-open"}, {"extra"}} {
		if err := runFunding(context.Background(), c, args, &bytes.Buffer{}); err == nil || strings.Contains(err.Error(), "unavailable") {
			t.Fatalf("invalid options reached daemon: %v: %v", args, err)
		}
	}
}
