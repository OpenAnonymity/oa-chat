package zkapi

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestCheckRequiresExactV2NativeDeploymentIdentity(t *testing.T) {
	mutations := map[string]any{
		"deployment_id": "old-deployment", "contract_address": "0x1111111111111111111111111111111111111111",
		"chain_id": 42, "billing_asset": "erc20", "billing_unit": "micro_usd", "circuit_id": "zkapi-v2",
		"bridge_version": 1, "require_oa_org_key_source": false, "mode": "proxy",
	}
	for _, network := range []string{"mainnet", "sepolia"} {
		for field, replacement := range mutations {
			t.Run(network+"/"+field, func(t *testing.T) {
				policy := testPolicy(network)
				policy[field] = replacement
				local := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					if r.URL.Path != "/oa/v1/status" || r.Header.Get("Authorization") != "Bearer "+testBridgeToken {
						t.Error("invalid companion check request")
					}
					_ = json.NewEncoder(w).Encode(policy)
				}))
				defer local.Close()
				client, err := New(Config{ClientURL: local.URL, BridgeToken: testBridgeToken, Network: network, HTTPClient: &http.Client{}})
				if err != nil {
					t.Fatal(err)
				}
				if err := client.Check(context.Background()); err == nil {
					t.Fatal("mismatched native policy accepted")
				}
				delete(policy, field)
				if err := client.Check(context.Background()); err == nil {
					t.Fatal("missing native policy field accepted")
				}
			})
		}
		t.Run(network+"/valid-checksummed-address", func(t *testing.T) {
			policy := testPolicy(network)
			policy["contract_address"] = strings.ToLower(policy["contract_address"].(string))
			local := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _ = json.NewEncoder(w).Encode(policy) }))
			defer local.Close()
			client, err := New(Config{ClientURL: local.URL, BridgeToken: testBridgeToken, Network: network, HTTPClient: &http.Client{}})
			if err != nil {
				t.Fatal(err)
			}
			if err := client.Check(context.Background()); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestUsableVerificationAcceptsOnlyExactTrustedStates(t *testing.T) {
	for _, verified := range []bool{false, true} {
		for _, status := range []string{"", "verified", "verifier-unavailable", "pending", "unverified", "Verified", "verified ", "bypassed"} {
			for _, detail := range []string{"", "recently_attested_outage", "rate_limited", "ownership_check_error", "recently_attested", "recently_attested_outage ", "server_error", "verified"} {
				want := verified && status == "verified" && detail == ""
				if !verified && status == "verifier-unavailable" && (detail == "recently_attested_outage" || detail == "rate_limited" || detail == "ownership_check_error") {
					want = true
				}
				if got := usableVerification(verified, status, detail); got != want {
					t.Errorf("usableVerification(%v,%q,%q) = %v, want %v", verified, status, detail, got, want)
				}
			}
		}
	}
}

func TestCompleteOverridesProviderVerificationHeadersWithTrustedBridgeState(t *testing.T) {
	for _, detail := range []string{"", "recently_attested_outage", "rate_limited", "ownership_check_error"} {
		t.Run(detail, func(t *testing.T) {
			status, verified := "verified", true
			if detail != "" {
				status, verified = "verifier-unavailable", false
			}
			upstream := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Header.Get("Authorization") != "Bearer bounded-key" || r.Header.Get("Cookie") != "" || r.Header.Get("X-OA-Verification-Status") != "" {
					t.Error("unexpected inference authorization/identity")
				}
				w.Header().Add("X-OA-Verification-Status", "provider-spoof")
				w.Header().Add("X-OA-Verification-Status", "verified")
				w.Header().Add("X-OA-Verification-Detail", "provider-controlled-detail")
				_, _ = io.WriteString(w, `{"choices":[]}`)
			}))
			defer upstream.Close()
			client := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path != "/oa/v1/lease" {
					t.Error("unexpected companion path")
				}
				body, _ := io.ReadAll(r.Body)
				if string(body) != "{}" {
					t.Error("prompt sent to proof companion")
				}
				_ = json.NewEncoder(w).Encode(map[string]any{"api_key": "bounded-key", "base_url": upstream.URL, "expires_at": time.Now().Unix() + 60, "verified": verified, "verification_status": status, "verification_detail": detail})
			}, upstream)
			response, err := client.Complete(context.Background(), json.RawMessage(`{"messages":[{"role":"user","content":"private"}]}`))
			if err != nil {
				t.Fatal(err)
			}
			defer response.Body.Close()
			statuses := response.Header.Values("X-OA-Verification-Status")
			if len(statuses) != 1 || statuses[0] != status || response.Header.Get("X-OA-Verification-Detail") != detail {
				t.Fatal("provider overrode trusted verification state")
			}
			if detail == "" && len(response.Header.Values("X-OA-Verification-Detail")) != 0 {
				t.Fatal("verified response retained provider detail")
			}
		})
	}
}

func TestModelsUsesAnonymousPublicCatalogTransport(t *testing.T) {
	var providerCalls, companionExtraCalls atomic.Int32
	const payload = `{"data":[{"id":"openai/gpt-4o-mini","name":"GPT-4o mini","context_length":128000}]}`
	upstream := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		providerCalls.Add(1)
		body, _ := io.ReadAll(r.Body)
		if r.URL.Path != "/models" || r.Method != http.MethodGet || len(body) != 0 {
			t.Error("catalog request included prompts or wrong route")
		}
		for _, header := range []string{"Authorization", "Cookie", "Proxy-Authorization", "X-OA-Verification-Status", "HTTP-Referer", "X-Title"} {
			if r.Header.Get(header) != "" {
				t.Errorf("identity header %s reached public catalog", header)
			}
		}
		_, _ = io.WriteString(w, payload)
	}))
	defer upstream.Close()
	jar, _ := cookiejar.New(nil)
	origin, _ := url.Parse(upstream.URL)
	jar.SetCookies(origin, []*http.Cookie{{Name: "identity", Value: "private-account"}})
	upstream.Client().Jar = jar
	client := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		companionExtraCalls.Add(1)
		t.Error("model catalog unnecessarily used companion")
	}, upstream)
	raw, err := client.Models(context.Background())
	if err != nil || string(raw) != payload || providerCalls.Load() != 1 || companionExtraCalls.Load() != 0 {
		t.Fatalf("public catalog failed: %s %v", raw, err)
	}
}

func TestModelsRejectsUnavailableOrMalformedCatalog(t *testing.T) {
	for _, scenario := range []struct {
		name   string
		status int
		body   string
	}{
		{"http failure", 503, `{"data":[{"id":"valid"}],"error":"private-provider-detail"}`},
		{"redirect", 307, `{"data":[{"id":"valid"}]}`},
		{"syntax", 200, `{"data":[`},
		{"missing data", 200, `{}`},
		{"empty data", 200, `{"data":[]}`},
		{"wrong type", 200, `{"data":"private-provider-detail"}`},
		{"wrong id type", 200, `{"data":[{"id":42}]}`},
		{"missing id", 200, `{"data":[{}]}`},
		{"empty id", 200, `{"data":[{"id":""}]}`},
		{"whitespace id", 200, `{"data":[{"id":" \t\n"}]}`},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			upstream := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(scenario.status)
				_, _ = io.WriteString(w, scenario.body)
			}))
			defer upstream.Close()
			client := newTestClient(t, func(w http.ResponseWriter, r *http.Request) { t.Error("unexpected bridge catalog call") }, upstream)
			raw, err := client.Models(context.Background())
			if err == nil || raw != nil || strings.Contains(err.Error(), "private-provider-detail") {
				t.Fatal("untrusted malformed catalog accepted or diagnostic leaked")
			}
		})
	}
}
