package zkapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func drainReuseResponse(t *testing.T, c *Client, ctx context.Context, body json.RawMessage) {
	t.Helper()
	response, err := c.Complete(ctx, body)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if _, err := io.Copy(io.Discard, response.Body); err != nil {
		t.Fatal(err)
	}
}

func TestKeyReuseWindowDoesNotSlideAndHonorsProviderExpiry(t *testing.T) {
	for _, test := range []struct {
		name                     string
		window, expires, advance time.Duration
		wantLeases               int32
	}{
		{"within_window", time.Minute, time.Hour, 20 * time.Second, 1},
		{"fixed_window_boundary", time.Minute, time.Hour, 30 * time.Second, 2},
		{"provider_expiry_guard", time.Minute, 41 * time.Second, 20 * time.Second, 2},
		{"disabled", 0, time.Hour, time.Second, 3},
	} {
		t.Run(test.name, func(t *testing.T) {
			var leases, calls atomic.Int32
			clock := time.Now().Truncate(time.Second)
			var offset atomic.Int64
			now := func() time.Time { return clock.Add(time.Duration(offset.Load())) }
			upstream := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				_, _ = io.WriteString(w, `{}`)
			}))
			defer upstream.Close()
			client := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
				_ = json.NewEncoder(w).Encode(map[string]any{"api_key": fmt.Sprintf("window-key-%d", leases.Add(1)), "base_url": upstream.URL, "expires_at": now().Add(test.expires).Unix(), "verified": true, "verification_status": "verified"})
			}, upstream)
			client.config.KeyReuseWindow, client.now = test.window, now
			for n := range 3 {
				offset.Store(int64(time.Duration(n) * test.advance))
				drainReuseResponse(t, client, context.Background(), queuedTestPrompt)
			}
			if leases.Load() != test.wantLeases || calls.Load() != 3 {
				t.Fatalf("leases=%d want=%d calls=%d", leases.Load(), test.wantLeases, calls.Load())
			}
		})
	}
}

func TestCachedKeyRevalidatesModelPolicyAndKeepsExactBudget(t *testing.T) {
	for _, mode := range []string{"same_coarse_budget", "higher_budget", "lower_budget", "disabled", "policy_failure"} {
		t.Run(mode, func(t *testing.T) {
			var leases, calls atomic.Int32
			var changed atomic.Bool
			var acquired []uint64
			upstream := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { calls.Add(1); _, _ = io.WriteString(w, `{}`) }))
			defer upstream.Close()
			client := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
				var body struct {
					Limit uint64 `json:"request_limit_micro_usd"`
				}
				_ = json.NewDecoder(r.Body).Decode(&body)
				acquired = append(acquired, body.Limit)
				writeQueuedTestLease(w, upstream.URL, leases.Add(1))
			}, upstream)
			client.config.KeyReuseWindow = time.Minute
			previous := client.inference.Transport
			client.inference.Transport = budgetTransport(func(r *http.Request) (*http.Response, error) {
				if r.URL.Host != "org-staging.openanonymity.ai" {
					return previous.RoundTrip(r)
				}
				cost := 1
				if mode == "lower_budget" {
					cost = 3
				}
				if changed.Load() {
					switch mode {
					case "same_coarse_budget":
						cost = 2
					case "higher_budget":
						cost = 100
					case "lower_budget":
						cost = 1
					case "policy_failure":
						return nil, errors.New("policy unavailable")
					}
				}
				body := fmt.Sprintf(`{"example/model":%d,"other/model":%d}`, cost, cost)
				if r.URL.Path == "/chat/pinned-models" {
					body = `{"disabled_models":[]}`
					if changed.Load() && mode == "disabled" {
						body = `{"disabled_models":["other/model"]}`
					}
				}
				return &http.Response{StatusCode: 200, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(body)), Request: r}, nil
			})
			drainReuseResponse(t, client, context.Background(), queuedTestPrompt)
			changed.Store(true)
			response, err := client.Complete(context.Background(), json.RawMessage(`{"model":"other/model","messages":[]}`))
			if mode == "disabled" || mode == "policy_failure" {
				if err == nil || calls.Load() != 1 || leases.Load() != 1 {
					t.Fatal("cached access bypassed current policy")
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			_, _ = io.Copy(io.Discard, response.Body)
			_ = response.Body.Close()
			if mode == "same_coarse_budget" {
				if leases.Load() != 1 {
					t.Fatal("compatible model redeemed another key")
				}
			} else {
				want := uint64(6_000_000)
				if mode == "lower_budget" {
					want = 1_000_000
				}
				if leases.Load() != 2 || len(acquired) != 2 || acquired[1] != want {
					t.Fatalf("incompatible cap reused: acquired=%v", acquired)
				}
			}
		})
	}
}

func TestKeyReuseDoesNotTrustRepeatedCompanionHandoff(t *testing.T) {
	var leases, calls atomic.Int32
	upstream := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { calls.Add(1); _, _ = io.WriteString(w, `{}`) }))
	defer upstream.Close()
	client := newTestClient(t, func(w http.ResponseWriter, r *http.Request) { leases.Add(1); writeQueuedTestLease(w, upstream.URL, 1) }, upstream)
	client.config.KeyReuseWindow = time.Minute
	clock := time.Now()
	client.now = func() time.Time { return clock }
	drainReuseResponse(t, client, context.Background(), queuedTestPrompt)
	// Evict an otherwise unexpired key by changing the configured reuse window.
	client.config.KeyReuseWindow = 0
	_, err := client.Complete(context.Background(), queuedTestPrompt)
	var failure *Error
	if !errors.As(err, &failure) || failure.Code != "lease_already_used" || calls.Load() != 1 || leases.Load() != 2 {
		t.Fatalf("repeated handoff accepted: err=%v calls=%d leases=%d", err, calls.Load(), leases.Load())
	}
}

func TestCachedKeyFailureNeverRetriesInferenceAndEvictsKey(t *testing.T) {
	for _, failure := range []string{"status", "transport", "body", "close", "cancel"} {
		t.Run(failure, func(t *testing.T) {
			var leases, calls atomic.Int32
			upstream := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { t.Error("unexpected real transport request") }))
			defer upstream.Close()
			client := newTestClient(t, func(w http.ResponseWriter, r *http.Request) { writeQueuedTestLease(w, upstream.URL, leases.Add(1)) }, upstream)
			client.config.KeyReuseWindow = time.Minute
			previous := client.inference.Transport
			client.inference.Transport = budgetTransport(func(r *http.Request) (*http.Response, error) {
				if !strings.HasSuffix(r.URL.Path, "/chat/completions") {
					return previous.RoundTrip(r)
				}
				n := calls.Add(1)
				response := &http.Response{StatusCode: 200, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(`{}`)), Request: r}
				if n == 2 {
					switch failure {
					case "status":
						response.StatusCode = 402
					case "transport":
						return nil, errors.New("ambiguous transport failure")
					case "body":
						response.Body = io.NopCloser(reuseErrorReader{})
					}
				}
				return response, nil
			})
			drainReuseResponse(t, client, context.Background(), queuedTestPrompt)
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			response, err := client.Complete(ctx, queuedTestPrompt)
			if failure == "transport" {
				if err == nil {
					t.Fatal("transport error hidden")
				}
			} else {
				if err != nil {
					t.Fatal(err)
				}
				switch failure {
				case "cancel":
					cancel()
				case "close":
				default:
					_, _ = io.Copy(io.Discard, response.Body)
				}
				_ = response.Body.Close()
			}
			if calls.Load() != 2 || leases.Load() != 1 {
				t.Fatalf("failed request retried: calls=%d leases=%d", calls.Load(), leases.Load())
			}
			drainReuseResponse(t, client, context.Background(), queuedTestPrompt)
			if calls.Load() != 3 || leases.Load() != 2 {
				t.Fatalf("failed key reused: calls=%d leases=%d", calls.Load(), leases.Load())
			}
		})
	}
}

type reuseErrorReader struct{}

func (reuseErrorReader) Read([]byte) (int, error) { return 0, errors.New("response truncated") }

func TestConcurrentOpenWebUIBurstUsesOneKeyAndSerializedStreams(t *testing.T) {
	const count = 4
	var leases, active, maximum atomic.Int32
	keys := make(chan string, count)
	arrived := make(chan struct{}, count)
	proceed := make(chan struct{})
	upstream := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		current := active.Add(1)
		for previous := maximum.Load(); current > previous; previous = maximum.Load() {
			if maximum.CompareAndSwap(previous, current) {
				break
			}
		}
		keys <- r.Header.Get("Authorization")
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = io.WriteString(w, "data: first\n\n")
		w.(http.Flusher).Flush()
		arrived <- struct{}{}
		select {
		case <-proceed:
		case <-r.Context().Done():
		}
		active.Add(-1)
		_, _ = io.WriteString(w, "data: [DONE]\n\n")
	}))
	defer upstream.Close()
	client := newTestClient(t, func(w http.ResponseWriter, r *http.Request) { writeQueuedTestLease(w, upstream.URL, leases.Add(1)) }, upstream)
	client.config.KeyReuseWindow = time.Minute
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	results := make(chan error, count)
	for range count {
		go func() {
			response, err := client.Complete(ctx, queuedTestPrompt)
			if err == nil {
				_, err = io.Copy(io.Discard, response.Body)
				_ = response.Body.Close()
			}
			results <- err
		}()
	}
	for range count {
		select {
		case <-arrived:
		case <-ctx.Done():
			t.Fatal("burst request stranded")
		}
		select {
		case <-arrived:
			t.Fatal("provider streams overlapped")
		case <-time.After(10 * time.Millisecond):
		}
		if leases.Load() != 1 {
			t.Fatal("burst acquired another lease")
		}
		proceed <- struct{}{}
	}
	for range count {
		if err := <-results; err != nil {
			t.Fatal(err)
		}
	}
	key := <-keys
	for range count - 1 {
		if other := <-keys; other != key {
			t.Fatal("burst keys differed")
		}
	}
	if maximum.Load() != 1 {
		t.Fatalf("provider concurrency=%d", maximum.Load())
	}
}

func TestKeyReuseWindowValidation(t *testing.T) {
	for _, window := range []time.Duration{-1, 5*time.Minute + 1} {
		if _, err := New(Config{BridgeToken: testBridgeToken, HTTPClient: http.DefaultClient, KeyReuseWindow: window}); err == nil {
			t.Fatal("unbounded reuse accepted")
		}
	}
}
