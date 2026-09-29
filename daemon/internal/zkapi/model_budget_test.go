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

type budgetTransport func(*http.Request) (*http.Response, error)

func (f budgetTransport) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func addTestModelPolicy(c *Client, prices map[string]uint64, disabled []string) {
	transport := c.inference.Transport
	if disabled == nil {
		disabled = []string{}
	}
	c.inference.Transport = budgetTransport(func(r *http.Request) (*http.Response, error) {
		if r.URL.Host == "org-staging.openanonymity.ai" {
			var value any = prices
			if r.URL.Path == "/chat/pinned-models" {
				value = map[string]any{"disabled_models": disabled}
			}
			data, _ := json.Marshal(value)
			return &http.Response{StatusCode: 200, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(string(data))), Request: r}, nil
		}
		if transport == nil {
			return &http.Response{StatusCode: 503, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(`{}`)), Request: r}, nil
		}
		return transport.RoundTrip(r)
	})
}

func TestPerModelBudgetsMatchWebReviewedBuckets(t *testing.T) {
	for tier, want := range map[uint64]uint64{1: 1_000_000, 2: 1_000_000, 3: 2_000_000, 5: 3_000_000, 8: 2_000_000, 25: 4_500_000, 100: 6_000_000} {
		got, ok := modelBudget(tier)
		if !ok || got != want {
			t.Errorf("tier %d = %d %v", tier, got, ok)
		}
	}
	for _, tier := range []uint64{0, 4, 6, 10, 99, 101, ^uint64(0)} {
		if _, ok := modelBudget(tier); ok {
			t.Errorf("unreviewed tier %d accepted", tier)
		}
	}
}

func TestModelBudgetUsesExactLiveAssignmentAndOnlyOnlineNormalization(t *testing.T) {
	c := &Client{config: Config{Network: "mainnet"}, inference: &http.Client{}}
	addTestModelPolicy(c, map[string]uint64{"test/model": 3, "test/model:free": 1, "test/premium": 100, "test/disabled": 1, "test/unreviewed": 10, "test/search-disabled": 1}, []string{"test/disabled", "test/search-disabled:online"})
	for model, want := range map[string]uint64{"test/model": 2_000_000, "test/model:online": 2_000_000, "test/model:free": 1_000_000, "test/model:free:online": 1_000_000, "test/premium": 6_000_000, "test/search-disabled": 1_000_000} {
		body, _ := json.Marshal(map[string]any{"model": model, "reasoning": map[string]any{"enabled": true}})
		got, err := c.requestBudget(context.Background(), body)
		if err != nil || got != want {
			t.Errorf("%s: %d %v", model, got, err)
		}
	}
	for _, body := range []string{`{}`, `null`, `{"model":42}`, `{"model":" test/model"}`, `{"model":"test/model:batch"}`, `{"model":"test/model:online:online"}`, `{"model":"test/unknown-mini"}`, `{"model":"test/unreviewed"}`, `{"model":"test/disabled:online"}`, `{"model":"test/search-disabled:online"}`} {
		if _, err := c.requestBudget(context.Background(), json.RawMessage(body)); err == nil {
			t.Errorf("unsafe request %s accepted", body)
		}
	}
}

func TestSelectedBudgetOnlyCrossesBridgeAndRefreshesEachRequest(t *testing.T) {
	var leases, inference atomic.Int32
	upstream := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { inference.Add(1); io.WriteString(w, `{}`) }))
	defer upstream.Close()
	want := uint64(1_000_000)
	c := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		leases.Add(1)
		raw, _ := io.ReadAll(r.Body)
		var request map[string]uint64
		if json.Unmarshal(raw, &request) != nil || len(request) != 1 || request["request_limit_micro_usd"] != want {
			t.Errorf("unexpected lease request %s", raw)
		}
		json.NewEncoder(w).Encode(map[string]any{"api_key": string(raw), "base_url": upstream.URL, "expires_at": time.Now().Unix() + 60, "verified": true, "verification_status": "verified"})
	}, upstream)
	prices := map[string]uint64{"test/model": 1}
	addTestModelPolicy(c, prices, nil)
	for _, tier := range []uint64{1, 100} {
		prices["test/model"] = tier
		want, _ = modelBudget(tier)
		res, err := c.Complete(context.Background(), json.RawMessage(`{"model":"test/model","messages":[{"role":"user","content":"never-to-org-or-bridge"}]}`))
		if err != nil {
			t.Fatal(err)
		}
		res.Body.Close()
	}
	prices["test/model"] = 10
	if _, err := c.Complete(context.Background(), json.RawMessage(`{"model":"test/model"}`)); err == nil {
		t.Fatal("unreviewed changed pricing accepted")
	}
	if leases.Load() != 2 || inference.Load() != 2 {
		t.Fatalf("blocked request spent lease: %d %d", leases.Load(), inference.Load())
	}
}

func TestModelsUsePinnedAnonymousPolicyAndHideDisabledOrUnreviewedModels(t *testing.T) {
	for _, network := range []string{"mainnet", "sepolia"} {
		t.Run(network, func(t *testing.T) {
			var calls atomic.Int32
			jar, _ := cookiejar.New(nil)
			origin, _ := url.Parse("https://org-staging.openanonymity.ai")
			jar.SetCookies(origin, []*http.Cookie{{Name: "identity", Value: "private-account"}})
			remote := &http.Client{Jar: jar, Transport: budgetTransport(func(r *http.Request) (*http.Response, error) {
				calls.Add(1)
				if r.URL.Scheme != "https" || (r.URL.Host != "org-staging.openanonymity.ai" && r.URL.Host != "openrouter.ai") || r.Method != "GET" || r.URL.RawQuery != "" || r.Body != nil {
					t.Errorf("unexpected public policy request %s", r.URL)
				}
				for _, header := range []string{"Authorization", "Cookie", "Proxy-Authorization", "HTTP-Referer", "X-Title"} {
					if r.Header.Get(header) != "" {
						t.Errorf("identity leaked via %s", header)
					}
				}
				body := `{"test/basic":1,"test/premium":100,"test/unreviewed":10,"test/disabled":3}`
				if r.URL.Path == "/chat/pinned-models" {
					body = `{"disabled_models":["test/disabled"]}`
				} else if r.URL.Path == "/api/v1/models" {
					body = `{"data":[{"id":"test/basic"},{"id":"test/premium"},{"id":"test/unreviewed"},{"id":"test/disabled"}]}`
				} else if r.URL.Path != "/chat/model-tickets" {
					t.Error("unexpected policy path")
				}
				return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(body)), Header: make(http.Header)}, nil
			})}
			local := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path != "/oa/v1/status" {
					t.Error("catalog used private bridge")
				}
				json.NewEncoder(w).Encode(testPolicy(network))
			}))
			defer local.Close()
			c, err := New(Config{ClientURL: local.URL, BridgeToken: testBridgeToken, Network: network, HTTPClient: remote})
			if err != nil {
				t.Fatal(err)
			}
			raw, err := c.Models(context.Background())
			if err != nil {
				t.Fatal(err)
			}
			var catalog struct {
				Data []struct {
					ID    string `json:"id"`
					Limit uint64 `json:"oa_request_limit_micro_usd"`
				} `json:"data"`
			}
			json.Unmarshal(raw, &catalog)
			if calls.Load() != 3 || len(catalog.Data) != 2 || catalog.Data[0].ID != "test/basic" || catalog.Data[0].Limit != 1_000_000 || catalog.Data[1].Limit != 6_000_000 {
				t.Fatalf("invalid catalog %s", raw)
			}
		})
	}
}

func TestModelPolicyFailsClosedBeforeLease(t *testing.T) {
	for _, scenario := range []struct {
		prices, availability string
		status               int
	}{
		{`{}`, `{"disabled_models":[]}`, 200}, {`null`, `{"disabled_models":[]}`, 200}, {`{"test/model":0}`, `{"disabled_models":[]}`, 200},
		{`{"test/model":1.5}`, `{"disabled_models":[]}`, 200}, {`{"test/model":-1}`, `{"disabled_models":[]}`, 200}, {`{"test/model":9007199254740992}`, `{"disabled_models":[]}`, 200},
		{`{"test/model":1}`, `{}`, 200}, {`{"test/model":1}`, `{"disabled_models":null}`, 200}, {`{"test/model":1}`, `{"disabled_models":[42]}`, 200},
		{`{"test/model":1}`, `{"disabled_models":[]}`, 503}, {`{"test/model":1}`, `{"disabled_models":[]}`, 307},
	} {
		c := &Client{config: Config{Network: "mainnet"}, inference: &http.Client{CheckRedirect: noRedirect, Transport: budgetTransport(func(r *http.Request) (*http.Response, error) {
			body := scenario.prices
			if r.URL.Path == "/chat/pinned-models" {
				body = scenario.availability
			}
			return &http.Response{StatusCode: scenario.status, Body: io.NopCloser(strings.NewReader(body)), Header: make(http.Header)}, nil
		})}}
		if _, err := c.requestBudget(context.Background(), json.RawMessage(`{"model":"test/model"}`)); err == nil {
			t.Errorf("unsafe policy accepted: %+v", scenario)
		}
	}
}

func TestUntieredCatalogModelsUseWebFallbackWithoutOverridingLiveAssignments(t *testing.T) {
	c := &Client{config: Config{Network: "mainnet", InferenceBaseURL: "https://openrouter.ai/api/v1"}, inference: &http.Client{}}
	c.inference.Transport = budgetTransport(func(r *http.Request) (*http.Response, error) {
		if r.URL.String() != "https://openrouter.ai/api/v1/models" || r.Header.Get("Authorization") != "" || r.URL.RawQuery != "" || r.Body != nil {
			t.Errorf("model selection leaked in public catalog request: %s", r.URL)
		}
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(`{"data":[{"id":"new/opus"},{"id":"new/image:free"},{"id":"new/thinking"},{"id":"new/mini"},{"id":"new/ordinary"},{"id":"new/unreviewed-opus"},{"id":"new/disabled-opus"},{"id":"new/assigned-opus"}]}`)), Header: make(http.Header)}, nil
	})
	addTestModelPolicy(c, map[string]uint64{"new/assigned-opus": 100, "new/unreviewed-opus": 10, "test/basic": 1}, []string{"new/disabled-opus", "new/ordinary:online"})
	for model, want := range map[string]uint64{"new/opus": 2000000, "new/opus:online": 2000000, "new/image:free": 2000000, "new/thinking": 1000000, "new/mini": 1000000, "new/ordinary": 1000000, "new/assigned-opus": 6000000} {
		for _, reasoning := range []bool{false, true} {
			body, _ := json.Marshal(map[string]any{"model": model, "reasoning": map[string]bool{"enabled": reasoning}})
			got, err := c.requestBudget(context.Background(), body)
			if err != nil || got != want {
				t.Fatalf("%s reasoning=%v: %d %v", model, reasoning, got, err)
			}
		}
	}
	for _, model := range []string{"new/unknown-opus", "new/unreviewed-opus", "new/disabled-opus", "new/ordinary:online", "new/mini:free"} {
		body, _ := json.Marshal(map[string]string{"model": model})
		if _, err := c.requestBudget(context.Background(), body); err == nil {
			t.Fatalf("unknown or explicitly blocked model accepted: %s", model)
		}
	}
}
