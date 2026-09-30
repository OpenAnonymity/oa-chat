package server

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

func waitForRequests(t *testing.T, condition func() bool) {
	t.Helper()
	deadline := time.After(3 * time.Second)
	ticker := time.NewTicker(time.Millisecond)
	defer ticker.Stop()
	for !condition() {
		select {
		case <-deadline:
			t.Fatal("request state did not converge")
		case <-ticker.C:
		}
	}
}

func TestConcurrentBurstWaitsInsteadOfRejecting(t *testing.T) {
	release := make(chan struct{})
	var once sync.Once
	defer once.Do(func() { close(release) })
	backend := &fakeBackend{complete: func(ctx context.Context, body json.RawMessage) (*http.Response, error) {
		select {
		case <-release:
			return successfulCompletion(ctx, body)
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}}
	api, err := New(backend, testKey, 1)
	if err != nil {
		t.Fatal(err)
	}
	s := httptest.NewServer(api)
	defer s.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	const burst = 8
	results := make(chan int, burst)
	for range burst {
		r := request(t, s.URL, `{"model":"x","messages":[{"role":"user"}]}`).WithContext(ctx)
		r.Header.Del("Authorization")
		go func() {
			resp, err := s.Client().Do(r)
			if err != nil {
				results <- 0
				return
			}
			defer resp.Body.Close()
			_, _ = io.Copy(io.Discard, resp.Body)
			results <- resp.StatusCode
		}()
	}
	waitForRequests(t, func() bool { return len(api.pending) == burst })
	if backend.calls.Load() != 1 {
		t.Fatal("waiting request started backend work")
	}
	once.Do(func() { close(release) })
	for range burst {
		if status := <-results; status != http.StatusOK {
			t.Fatalf("queued request status %d, want 200", status)
		}
	}
	if backend.calls.Load() != burst {
		t.Fatal("queued inference was lost or repeated")
	}
}

func TestQueuedDisconnectDoesNotSpendAndStreamHoldsItsSlot(t *testing.T) {
	finish := make(chan struct{})
	var once sync.Once
	defer once.Do(func() { close(finish) })
	var backend *fakeBackend
	backend = &fakeBackend{complete: func(ctx context.Context, body json.RawMessage) (*http.Response, error) {
		if backend.calls.Load() > 1 {
			return successfulCompletion(ctx, body)
		}
		reader, writer := io.Pipe()
		go func() {
			defer writer.Close()
			_, _ = io.WriteString(writer, "data: first\n\n")
			select {
			case <-finish:
				_, _ = io.WriteString(writer, "data: [DONE]\n\n")
			case <-ctx.Done():
			}
		}()
		return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": {"text/event-stream"}}, Body: reader}, nil
	}}
	api, err := New(backend, testKey, 1)
	if err != nil {
		t.Fatal(err)
	}
	s := httptest.NewServer(api)
	defer s.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	first, err := s.Client().Do(request(t, s.URL, `{"model":"x","messages":[{"role":"user"}],"stream":true}`).WithContext(ctx))
	if err != nil {
		t.Fatal(err)
	}
	defer first.Body.Close()
	reader := bufio.NewReader(first.Body)
	if line, err := reader.ReadString('\n'); err != nil || line != "data: first\n" {
		t.Fatal("initial stream frame did not arrive", err)
	}
	secondCtx, cancelSecond := context.WithCancel(ctx)
	defer cancelSecond()
	secondDone := make(chan struct{})
	secondRequest := request(t, s.URL, `{"model":"x","messages":[{"role":"user"}]}`).WithContext(secondCtx)
	go func() {
		defer close(secondDone)
		resp, err := s.Client().Do(secondRequest)
		if err == nil {
			resp.Body.Close()
		}
	}()
	waitForRequests(t, func() bool { return len(api.pending) == 2 })
	if backend.calls.Load() != 1 {
		t.Fatal("inference started before the preceding stream completed")
	}
	cancelSecond()
	<-secondDone
	waitForRequests(t, func() bool { return len(api.pending) == 1 })
	if backend.calls.Load() != 1 {
		t.Fatal("canceled queued request spent access")
	}
	thirdDone := make(chan int, 1)
	thirdRequest := request(t, s.URL, `{"model":"x","messages":[{"role":"user"}]}`).WithContext(ctx)
	go func() {
		resp, err := s.Client().Do(thirdRequest)
		if err != nil {
			thirdDone <- 0
			return
		}
		defer resp.Body.Close()
		_, _ = io.Copy(io.Discard, resp.Body)
		thirdDone <- resp.StatusCode
	}()
	waitForRequests(t, func() bool { return len(api.pending) == 2 })
	once.Do(func() { close(finish) })
	if data, err := io.ReadAll(reader); err != nil || !strings.Contains(string(data), "[DONE]") {
		t.Fatal("first stream failed", err)
	}
	if status := <-thirdDone; status != http.StatusOK || backend.calls.Load() != 2 {
		t.Fatalf("next queued request failed: status %d, backend calls %d", status, backend.calls.Load())
	}
}

func TestCanceledRequestCannotSpendEvenWhenSlotIsFree(t *testing.T) {
	backend := &fakeBackend{complete: successfulCompletion}
	api, err := New(backend, testKey, 1)
	if err != nil {
		t.Fatal(err)
	}
	api.RequireAPIKey = true
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	r := request(t, "http://localhost", `{"model":"x","messages":[{"role":"user"}]}`).WithContext(ctx)
	w := httptest.NewRecorder()
	api.ServeHTTP(w, r)
	if w.Code != http.StatusRequestTimeout || backend.calls.Load() != 0 {
		t.Fatal("already-canceled request spent access")
	}
}

func TestBackendCancellationAndDeadlineHaveSafeTimeoutResponse(t *testing.T) {
	for _, err := range []error{context.Canceled, context.DeadlineExceeded} {
		t.Run(err.Error(), func(t *testing.T) {
			api, newErr := New(&fakeBackend{complete: func(context.Context, json.RawMessage) (*http.Response, error) {
				return nil, err
			}}, testKey, 1)
			if newErr != nil {
				t.Fatal(newErr)
			}
			api.RequireAPIKey = true
			r := request(t, "http://localhost", `{"model":"x","messages":[{"role":"user"}]}`)
			w := httptest.NewRecorder()
			api.ServeHTTP(w, r)
			if w.Code != http.StatusRequestTimeout || !strings.Contains(w.Body.String(), "request_cancelled") || strings.Contains(w.Body.String(), "anonymous_access_failed") {
				t.Fatal("cancellation became an unrelated anonymous access error", w.Code, w.Body.String())
			}
		})
	}
}
