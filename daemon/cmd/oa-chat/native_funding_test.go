package main

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func nativeFundingStatus() map[string]any {
	return map[string]any{
		"address": "0x1111111111111111111111111111111111111111", "chain_id": 1,
		"deployment_id": "native-test", "billing_asset": "native_eth", "billing_unit": "gwei",
		"native_asset_wei_per_unit": "1000000000", "token_address": "", "token_decimals": 9,
		"token_balance": "30000000", "eth_balance": "30000000000000000", "phase": "ready",
	}
}

func TestNativeFundExactGweiAndETHDisplay(t *testing.T) {
	posts := 0
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		state := nativeFundingStatus()
		if r.Method == http.MethodPost {
			posts++
			var body map[string]uint64
			if json.NewDecoder(r.Body).Decode(&body) != nil || body["amount"] != 750001 {
				t.Error("native ETH amount was not converted exactly to gwei")
			}
			state["phase"] = "active"
		}
		_ = json.NewEncoder(w).Encode(state)
	}))
	defer s.Close()
	var out bytes.Buffer
	if err := runFunding(context.Background(), fundingTestConfig(s), []string{"--amount", "0.000750001"}, &out); err != nil {
		t.Fatal(err)
	}
	if posts != 1 || !strings.Contains(out.String(), "Depositing 0.000750001 ETH") || strings.Contains(out.String(), "USDC") || strings.Contains(out.String(), "Token contract:") {
		t.Fatalf("wrong native funding flow: posts=%d output=%s", posts, out.String())
	}
}

func TestNativeAmountAndDenominationFailClosed(t *testing.T) {
	for _, value := range []string{"0.0000000001", "1e-9", "0", "1000.000000001"} {
		if _, err := parseFundingAmountForAsset(value, 9, "ETH"); err == nil {
			t.Fatalf("accepted invalid native amount %q", value)
		}
	}
	if got, err := parseFundingAmountForAsset("0.000000001", 9, "ETH"); err != nil || got != 1 {
		t.Fatal("one gwei did not parse exactly")
	}
	for _, mutate := range []func(map[string]any){
		func(s map[string]any) { s["token_decimals"] = 6 },
		func(s map[string]any) { s["native_asset_wei_per_unit"] = "1000000" },
		func(s map[string]any) { s["token_address"] = "0x2222222222222222222222222222222222222222" },
	} {
		s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.Method != http.MethodGet {
				t.Error("invalid denomination authorized a deposit")
			}
			state := nativeFundingStatus()
			mutate(state)
			_ = json.NewEncoder(w).Encode(state)
		}))
		if err := runFunding(context.Background(), fundingTestConfig(s), []string{"--amount", "0.00075"}, &bytes.Buffer{}); err == nil {
			t.Error("accepted mismatched native denomination")
		}
		s.Close()
	}
}
