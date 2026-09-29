package zkapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func quoteFixture(t *testing.T, network string) NativeUSDQuote {
	t.Helper()
	_, manifest, err := pinnedDeployment(network)
	if err != nil {
		t.Fatal(err)
	}
	var pinned struct {
		Chain uint64 `json:"chain_id"`
		Feed  string `json:"native_price_feed_address"`
		Age   uint64 `json:"native_price_max_age_seconds"`
	}
	json.Unmarshal(manifest, &pinned)
	now := uint64(time.Now().Unix())
	return NativeUSDQuote{Asset: "native_eth", UnitsPerETH: 1_000_000_000, ChainID: pinned.Chain, FeedAddress: pinned.Feed, RoundID: "123", Answer: "250000000000", Decimals: 8, UpdatedAt: now - 60, ExpiresAt: now - 60 + pinned.Age}
}

func TestNativeUSDQuoteRequiresPinnedFreshMetadataAndNeverRequestsLease(t *testing.T) {
	for _, network := range []string{"mainnet", "sepolia"} {
		quote := quoteFixture(t, network)
		local := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.Header.Get("Authorization") != "Bearer "+testBridgeToken || r.Method != "GET" {
				t.Error("quote read was not authenticated/read-only")
			}
			switch r.URL.Path {
			case "/oa/v1/status":
				json.NewEncoder(w).Encode(testPolicy(network))
			case "/oa/v1/billing/quote":
				json.NewEncoder(w).Encode(quote)
			default:
				t.Errorf("quote created wallet action %s", r.URL.Path)
			}
		}))
		defer local.Close()
		c, err := New(Config{ClientURL: local.URL, BridgeToken: testBridgeToken, Network: network, HTTPClient: http.DefaultClient})
		if err != nil {
			t.Fatal(err)
		}
		got, err := c.NativeUSDQuote(context.Background())
		if err != nil || got != quote {
			t.Fatalf("quote failed: %+v %v", got, err)
		}
		for _, mutate := range []func(*NativeUSDQuote){
			func(q *NativeUSDQuote) { q.ChainID = 42 }, func(q *NativeUSDQuote) { q.FeedAddress = "0x123" }, func(q *NativeUSDQuote) { q.Asset = "erc20" },
			func(q *NativeUSDQuote) { q.UnitsPerETH = 1_000_000 }, func(q *NativeUSDQuote) { q.Decimals = 9 }, func(q *NativeUSDQuote) { q.RoundID = "0123" },
			func(q *NativeUSDQuote) { q.RoundID = "1208925819614629174706176" }, func(q *NativeUSDQuote) { q.Answer = "0" }, func(q *NativeUSDQuote) { q.Answer = "1000000000000000001" },
			func(q *NativeUSDQuote) { q.UpdatedAt = uint64(time.Now().Unix()) + 1 }, func(q *NativeUSDQuote) { q.ExpiresAt = uint64(time.Now().Unix()) - 1 }, func(q *NativeUSDQuote) { q.ExpiresAt++ },
		} {
			quote = quoteFixture(t, network)
			mutate(&quote)
			if _, err := c.NativeUSDQuote(context.Background()); err == nil {
				t.Errorf("untrusted quote accepted: %+v", quote)
			}
		}
	}
}

func TestNativeUSDDepositConversionIsExactAndBounded(t *testing.T) {
	quote := quoteFixture(t, "sepolia")
	for usd, want := range map[uint64]uint64{1: 1, 1_000_000: 400_000, 2_000_000: 800_000, 4_500_000: 1_800_000, 2_500_000_000_000: 1_000_000_000_000} {
		got, err := quote.GweiForUSD(usd)
		if err != nil || got != want {
			t.Errorf("microUSD %d = %d %v", usd, got, err)
		}
	}
	for _, usd := range []uint64{0, 2_500_000_000_001, ^uint64(0)} {
		if _, err := quote.GweiForUSD(usd); err == nil {
			t.Errorf("unsafe principal %d accepted", usd)
		}
	}
	quote.Answer = "300000000001"
	got, err := quote.GweiForUSD(1_000_000)
	if err != nil || got != 333334 {
		t.Fatalf("ceil conversion %d %v", got, err)
	}
	quote.ExpiresAt = uint64(time.Now().Unix()) - 1
	if _, err := quote.GweiForUSD(1_000_000); err == nil {
		t.Fatal("expired conversion accepted")
	}
}
