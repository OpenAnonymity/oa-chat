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
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

var queuedTestPrompt = json.RawMessage(`{"model":"example/model","messages":[{"role":"user","content":"private content"}],"stream":true}`)

func writeQueuedTestLease(w http.ResponseWriter, upstream string, number int32) {
	_ = json.NewEncoder(w).Encode(map[string]any{"api_key": fmt.Sprintf("independent-key-%d", number), "base_url": upstream, "expires_at": time.Now().Unix() + 60, "verified": true, "verification_status": "verified"})
}

func TestCompleteSerializesConcurrentProviderStreams(t *testing.T) {
	const requests = 5
	var leases, active, maximum atomic.Int32
	arrived := make(chan struct{}, requests)
	proceed := make(chan struct{})
	upstream := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		current := active.Add(1)
		for previous := maximum.Load(); current > previous; previous = maximum.Load() {
			if maximum.CompareAndSwap(previous, current) {
				break
			}
		}
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
	client := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		writeQueuedTestLease(w, upstream.URL, leases.Add(1))
	}, upstream)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	results := make(chan error, requests)
	start := make(chan struct{})
	for range requests {
		go func() {
			<-start
			response, err := client.Complete(ctx, queuedTestPrompt)
			if err == nil {
				_, err = io.Copy(io.Discard, response.Body)
				_ = response.Body.Close()
			}
			results <- err
		}()
	}
	close(start)
	for n := int32(1); n <= requests; n++ {
		select {
		case <-arrived:
		case <-ctx.Done():
			t.Fatal("queued inference did not reach provider")
		}
		// Headers and the first SSE event have already arrived. Other calls
		// must stay queued while this response body is still streaming.
		select {
		case <-arrived:
			t.Fatal("another provider stream overlapped the active response")
		case <-time.After(20 * time.Millisecond):
		}
		if leases.Load() != n {
			t.Fatalf("acquired %d leases while only %d responses had their turn", leases.Load(), n)
		}
		proceed <- struct{}{}
	}
	for range requests {
		if err := <-results; err != nil {
			t.Fatal(err)
		}
	}
	if maximum.Load() != 1 || leases.Load() != requests {
		t.Fatalf("provider concurrency=%d leases=%d", maximum.Load(), leases.Load())
	}
}

func TestCompleteWaitsOnlyForExplicitSettlementAndAcquiresFreshKeys(t *testing.T) {
	for _, code := range []string{"lease_pending", "pending_settlement"} {
		t.Run(code, func(t *testing.T) {
			var leases, calls atomic.Int32
			keys := make(chan string, 2)
			upstream := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				keys <- r.Header.Get("Authorization")
				_, _ = io.WriteString(w, `{}`)
			}))
			defer upstream.Close()
			client := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
				n := leases.Add(1)
				body, _ := io.ReadAll(r.Body)
				if string(body) != `{"request_limit_micro_usd":1000000}` {
					t.Error("model or prompt crossed the companion boundary while waiting")
				}
				if n%3 != 0 {
					w.WriteHeader(http.StatusConflict)
					_ = json.NewEncoder(w).Encode(map[string]any{"error": map[string]string{"code": code, "message": "private companion diagnostics"}})
					return
				}
				writeQueuedTestLease(w, upstream.URL, n)
			}, upstream)
			client.settlementPoll = time.Millisecond
			ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
			defer cancel()
			for range 2 {
				response, err := client.Complete(ctx, queuedTestPrompt)
				if err != nil {
					t.Fatal(err)
				}
				response.Body.Close()
			}
			if leases.Load() != 6 || calls.Load() != 2 || <-keys == <-keys {
				t.Fatalf("settlement retry reused access or repeated inference: leases=%d calls=%d", leases.Load(), calls.Load())
			}
		})
	}
}

func TestCompleteNeverRetriesOtherLeaseFailures(t *testing.T) {
	for _, failure := range []struct {
		name   string
		status int
		body   string
	}{
		{"generic_conflict", 409, `{"error":{"code":"unknown"}}`},
		{"pending_request", 409, `{"error":{"code":"pending_request"}}`},
		{"used_lease", 409, `{"error":{"code":"lease_already_used"}}`},
		{"withdrawal_pending", 409, `{"error":{"code":"withdrawal_pending"}}`},
		{"withdrawal_conflict", 409, `{"error":{"code":"withdrawal_conflict"}}`},
		{"settlement_wrong_status", 500, `{"error":{"code":"lease_pending"}}`},
		{"rate_limited", 429, `{"error":{"code":"lease_pending"}}`},
		{"lost_reply", 0, ""},
		{"malformed_reply", 200, "{"},
		{"invalid_lease", 200, `{}`},
	} {
		t.Run(failure.name, func(t *testing.T) {
			var leases, calls atomic.Int32
			upstream := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { calls.Add(1) }))
			defer upstream.Close()
			client := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
				leases.Add(1)
				if failure.status == 0 {
					connection, _, err := w.(http.Hijacker).Hijack()
					if err != nil {
						t.Error(err)
						return
					}
					connection.Close()
					return
				}
				w.WriteHeader(failure.status)
				_, _ = io.WriteString(w, failure.body)
			}, upstream)
			client.settlementPoll = time.Millisecond
			ctx, cancel := context.WithTimeout(context.Background(), 500*time.Millisecond)
			defer cancel()
			_, err := client.Complete(ctx, queuedTestPrompt)
			if err == nil || errors.Is(err, context.DeadlineExceeded) || leases.Load() != 1 || calls.Load() != 0 {
				t.Fatalf("retried an unsafe acquisition: error=%v leases=%d provider=%d", err, leases.Load(), calls.Load())
			}
		})
	}
}

func TestQueuedCancellationNeverAcquiresOrSendsInference(t *testing.T) {
	var leases, calls atomic.Int32
	upstream := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		_, _ = io.WriteString(w, `{}`)
	}))
	defer upstream.Close()
	client := newTestClient(t, func(w http.ResponseWriter, r *http.Request) { writeQueuedTestLease(w, upstream.URL, leases.Add(1)) }, upstream)
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	first, err := client.Complete(ctx, queuedTestPrompt)
	if err != nil {
		t.Fatal(err)
	}
	defer first.Body.Close()
	queued, stop := context.WithTimeout(ctx, 30*time.Millisecond)
	defer stop()
	if _, err := client.Complete(queued, queuedTestPrompt); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("queued caller did not cancel: %v", err)
	}
	if leases.Load() != 1 || calls.Load() != 1 {
		t.Fatal("canceled queued request spent access")
	}
	first.Body.Close()
	// A canceled request must also fail when its slot is immediately free.
	if _, err := client.Complete(queued, queuedTestPrompt); !errors.Is(err, context.DeadlineExceeded) || leases.Load() != 1 {
		t.Fatalf("already canceled request spent access: %v", err)
	}
	last, err := client.Complete(ctx, queuedTestPrompt)
	if err != nil {
		t.Fatal(err)
	}
	last.Body.Close()
	if leases.Load() != 2 || calls.Load() != 2 {
		t.Fatal("cancellation stranded the queue")
	}
}

func TestSettlementWaitCancellationReleasesQueueWithoutAnotherAcquisition(t *testing.T) {
	var leases, calls atomic.Int32
	settled := atomic.Bool{}
	firstPoll := make(chan struct{})
	upstream := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { calls.Add(1); _, _ = io.WriteString(w, `{}`) }))
	defer upstream.Close()
	client := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		n := leases.Add(1)
		if !settled.Load() {
			w.WriteHeader(409)
			_, _ = io.WriteString(w, `{"error":{"code":"lease_pending"}}`)
			close(firstPoll)
			return
		}
		writeQueuedTestLease(w, upstream.URL, n)
	}, upstream)
	client.settlementPoll = time.Hour
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	result := make(chan error, 1)
	go func() { _, err := client.Complete(ctx, queuedTestPrompt); result <- err }()
	select {
	case <-firstPoll:
	case <-time.After(time.Second):
		t.Fatal("no settlement poll")
	}
	cancel()
	select {
	case err := <-result:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("cancellation error=%v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("settlement wait ignored cancellation")
	}
	if leases.Load() != 1 || calls.Load() != 0 {
		t.Fatal("canceled settlement wait spent a lease")
	}
	settled.Store(true)
	next, stop := context.WithTimeout(context.Background(), time.Second)
	defer stop()
	response, err := client.Complete(next, queuedTestPrompt)
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
}

func TestResponseOwnershipEndsOnEOFOrCloseOrCancellation(t *testing.T) {
	for _, end := range []string{"eof", "close", "cancel"} {
		t.Run(end, func(t *testing.T) {
			var leases atomic.Int32
			upstream := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = io.WriteString(w, `{}`) }))
			defer upstream.Close()
			client := newTestClient(t, func(w http.ResponseWriter, r *http.Request) { writeQueuedTestLease(w, upstream.URL, leases.Add(1)) }, upstream)
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			first, err := client.Complete(ctx, queuedTestPrompt)
			if err != nil {
				t.Fatal(err)
			}
			defer first.Body.Close()
			next, stop := context.WithTimeout(context.Background(), time.Second)
			defer stop()
			result := make(chan error, 1)
			go func() {
				response, err := client.Complete(next, queuedTestPrompt)
				if err == nil {
					response.Body.Close()
				}
				result <- err
			}()
			select {
			case err := <-result:
				t.Fatalf("released an unread response body: %v", err)
			case <-time.After(20 * time.Millisecond):
			}
			switch end {
			case "eof":
				_, _ = io.Copy(io.Discard, first.Body)
			case "close":
				first.Body.Close()
			case "cancel":
				cancel()
			}
			if err := <-result; err != nil {
				t.Fatal(err)
			}
			if leases.Load() != 2 {
				t.Fatal("body termination did not release request slot")
			}
		})
	}
}

func TestSettlementWaitRefreshesModelPolicyBeforeSpending(t *testing.T) {
	for _, disabled := range []bool{false, true} {
		t.Run(fmt.Sprintf("disabled=%v", disabled), func(t *testing.T) {
			var leases atomic.Int32
			upstream := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = io.WriteString(w, `{}`) }))
			defer upstream.Close()
			client := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
				n := leases.Add(1)
				if n == 1 {
					w.WriteHeader(409)
					_, _ = io.WriteString(w, `{"error":{"code":"lease_pending"}}`)
					return
				}
				body, _ := io.ReadAll(r.Body)
				if string(body) != `{"request_limit_micro_usd":6000000}` {
					t.Error("used stale request cap after settlement")
				}
				writeQueuedTestLease(w, upstream.URL, n)
			}, upstream)
			previous := client.inference.Transport
			client.inference.Transport = budgetTransport(func(r *http.Request) (*http.Response, error) {
				if leases.Load() > 0 && r.URL.Host == "org-staging.openanonymity.ai" {
					body := `{"example/model":100}`
					if r.URL.Path == "/chat/pinned-models" {
						body = `{"disabled_models":[]}`
						if disabled {
							body = `{"disabled_models":["example/model"]}`
						}
					}
					return &http.Response{StatusCode: 200, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(body)), Request: r}, nil
				}
				return previous.RoundTrip(r)
			})
			client.settlementPoll = time.Millisecond
			ctx, cancel := context.WithTimeout(context.Background(), time.Second)
			defer cancel()
			response, err := client.Complete(ctx, queuedTestPrompt)
			if disabled {
				if err == nil || leases.Load() != 1 {
					t.Fatal("disabled queued model spent another lease")
				}
			} else {
				if err != nil {
					t.Fatal(err)
				}
				response.Body.Close()
				if leases.Load() != 2 {
					t.Fatal("changed model cap did not acquire fresh lease")
				}
			}
		})
	}
}

func TestCompleteNeverRetriesProviderFailure(t *testing.T) {
	for _, transportFailure := range []bool{false, true} {
		t.Run(fmt.Sprintf("transport=%v", transportFailure), func(t *testing.T) {
			var leases, calls atomic.Int32
			upstream := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { calls.Add(1); w.WriteHeader(503) }))
			defer upstream.Close()
			client := newTestClient(t, func(w http.ResponseWriter, r *http.Request) { writeQueuedTestLease(w, upstream.URL, leases.Add(1)) }, upstream)
			if transportFailure {
				previous := client.inference.Transport
				client.inference.Transport = budgetTransport(func(r *http.Request) (*http.Response, error) {
					if strings.HasSuffix(r.URL.Path, "/chat/completions") {
						calls.Add(1)
						return nil, errors.New("ambiguous provider response")
					}
					return previous.RoundTrip(r)
				})
			}
			ctx, cancel := context.WithTimeout(context.Background(), time.Second)
			defer cancel()
			for range 2 {
				response, err := client.Complete(ctx, queuedTestPrompt)
				if transportFailure {
					if err == nil {
						t.Fatal("provider transport failure was hidden")
					}
				} else {
					if err != nil || response.StatusCode != 503 {
						t.Fatalf("provider failure changed: %v", err)
					}
					response.Body.Close()
				}
			}
			if leases.Load() != 2 || calls.Load() != 2 {
				t.Fatalf("inference retried: leases=%d calls=%d", leases.Load(), calls.Load())
			}
		})
	}
}

func TestResponseCloseAndCancellationReleaseSlotExactlyOnce(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	var releases atomic.Int32
	body := holdResponseSlot(ctx, io.NopCloser(strings.NewReader("")), func() { releases.Add(1) })
	var group sync.WaitGroup
	for range 10 {
		group.Go(func() { cancel(); _ = body.Close() })
	}
	group.Wait()
	if releases.Load() != 1 {
		t.Fatalf("released slot %d times", releases.Load())
	}
}
