package server

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

const testKey = "local-test-key-with-at-least-32-characters"

type fakeBackend struct {
	complete func(context.Context, json.RawMessage) (*http.Response, error)
	calls    atomic.Int32
}

func (b *fakeBackend) Models(context.Context) (json.RawMessage, error) {
	return json.RawMessage(`{"object":"list","data":[{"id":"test/model","object":"model","owned_by":"test"}]}`), nil
}
func (b *fakeBackend) Complete(ctx context.Context, body json.RawMessage) (*http.Response, error) {
	b.calls.Add(1)
	return b.complete(ctx, body)
}
func apiServer(t *testing.T, b Backend) *httptest.Server {
	t.Helper()
	a, err := New(b, testKey, 2)
	if err != nil {
		t.Fatal(err)
	}
	s := httptest.NewServer(a)
	t.Cleanup(s.Close)
	return s
}
func request(t *testing.T, url, body string) *http.Request {
	t.Helper()
	r, err := http.NewRequest("POST", url+"/v1/chat/completions", strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	r.Header.Set("Authorization", "Bearer "+testKey)
	r.Header.Set("Content-Type", "application/json")
	return r
}

func TestStreamingFlushesPartialFrameBeforeUpstreamFinishes(t *testing.T) {
	finish := make(chan struct{})
	firstWritten := make(chan struct{})
	defer close(finish)
	b := &fakeBackend{complete: func(ctx context.Context, raw json.RawMessage) (*http.Response, error) {
		reader, writer := io.Pipe()
		go func() {
			defer writer.Close()
			_, _ = writer.Write([]byte("data: {\"choices\":[{\"delta\":{\"content\":\"first\"}}]}\n\n"))
			close(firstWritten)
			select {
			case <-finish:
				_, _ = writer.Write([]byte("data: [DONE]\n\n"))
			case <-ctx.Done():
			}
		}()
		return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": {"text/event-stream"}}, Body: reader}, nil
	}}
	s := apiServer(t, b)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	r := request(t, s.URL, `{"model":"test/model","messages":[{"role":"user","content":"hi"}],"stream":true}`)
	resp, err := http.DefaultClient.Do(r.WithContext(ctx))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	line, err := bufio.NewReader(resp.Body).ReadString('\n')
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(line, "first") {
		t.Fatalf("first token missing: %q", line)
	}
	select {
	case <-firstWritten:
	case <-ctx.Done():
		t.Fatal("upstream write did not reach client before completion")
	}
	if resp.Header.Get("X-Accel-Buffering") != "no" {
		t.Fatal("stream buffering protection missing")
	}
}

func TestDisconnectCancelsInference(t *testing.T) {
	cancelled := make(chan struct{})
	b := &fakeBackend{complete: func(ctx context.Context, raw json.RawMessage) (*http.Response, error) {
		r, w := io.Pipe()
		go func() { defer w.Close(); _, _ = w.Write([]byte("data: first\n\n")); <-ctx.Done(); close(cancelled) }()
		return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": {"text/event-stream"}}, Body: r}, nil
	}}
	s := apiServer(t, b)
	ctx, cancel := context.WithCancel(context.Background())
	resp, err := http.DefaultClient.Do(request(t, s.URL, `{"model":"test/model","messages":[{"role":"user"}],"stream":true}`).WithContext(ctx))
	if err != nil {
		t.Fatal(err)
	}
	_, _ = bufio.NewReader(resp.Body).ReadString('\n')
	cancel()
	resp.Body.Close()
	select {
	case <-cancelled:
	case <-time.After(3 * time.Second):
		t.Fatal("disconnect did not cancel upstream")
	}
}

func TestIdentityMetadataIsRemovedAndInferenceExtensionsSurvive(t *testing.T) {
	b := &fakeBackend{complete: func(ctx context.Context, raw json.RawMessage) (*http.Response, error) {
		var body map[string]json.RawMessage
		_ = json.Unmarshal(raw, &body)
		for _, key := range []string{"user", "metadata", "safety_identifier", "prompt_cache_key", "store", "extra_headers", "provider"} {
			if _, ok := body[key]; ok {
				t.Errorf("identity field %s forwarded", key)
			}
		}
		for _, key := range []string{"tools", "response_format", "reasoning", "stream_options"} {
			if _, ok := body[key]; !ok {
				t.Errorf("inference field %s missing", key)
			}
		}
		return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": {"application/json"}, "Set-Cookie": {"secret=do-not-forward"}}, Body: io.NopCloser(strings.NewReader(`{"choices":[]}`))}, nil
	}}
	s := apiServer(t, b)
	resp, err := http.DefaultClient.Do(request(t, s.URL, `{"model":"test/model","messages":[{"role":"user","content":"hi"}],"user":"alice","metadata":{"email":"alice@example.com"},"safety_identifier":"alice","prompt_cache_key":"alice","store":true,"extra_headers":{"Authorization":"identity"},"provider":{},"tools":[],"response_format":{"type":"json_object"},"reasoning":{},"stream_options":{"include_usage":true}}`))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 || resp.Header.Get("Set-Cookie") != "" {
		t.Fatal("unexpected response or upstream cookie forwarded")
	}
}

func TestUnauthorizedMalformedAndBrowserRequestsNeverSpend(t *testing.T) {
	b := &fakeBackend{complete: func(context.Context, json.RawMessage) (*http.Response, error) {
		t.Fatal("unexpected inference")
		return nil, nil
	}}
	s := apiServer(t, b)
	for _, tc := range []struct {
		name, body, key, origin string
		status                  int
	}{
		{"missing key", `{}`, "", "", 401},
		{"browser", `{}`, testKey, "https://evil.example", 403},
		{"invalid json", `{`, testKey, "", 400},
		{"invalid messages", `{"model":"test/model","messages":[]}`, testKey, "", 400},
		{"invalid stream", `{"model":"test/model","messages":[{"role":"user"}],"stream":null}`, testKey, "", 400},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r := request(t, s.URL, tc.body)
			r.Header.Set("Authorization", "Bearer "+tc.key)
			r.Header.Set("Origin", tc.origin)
			resp, err := http.DefaultClient.Do(r)
			if err != nil {
				t.Fatal(err)
			}
			resp.Body.Close()
			if resp.StatusCode != tc.status {
				t.Fatalf("status %d want %d", resp.StatusCode, tc.status)
			}
		})
	}
	if b.calls.Load() != 0 {
		t.Fatal("invalid request spent access")
	}
}

func TestErrorsCannotExposeCredentials(t *testing.T) {
	b := &fakeBackend{complete: func(context.Context, json.RawMessage) (*http.Response, error) {
		return nil, errors.New("Authorization: Bearer provider-secret prompt=private")
	}}
	s := apiServer(t, b)
	resp, err := http.DefaultClient.Do(request(t, s.URL, `{"model":"x","messages":[{"role":"user"}]}`))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 502 || strings.Contains(string(body), "provider-secret") || strings.Contains(string(body), "prompt=private") {
		t.Fatalf("unsafe error %s", body)
	}
}

func TestSafeSettlementErrorIsActionable(t *testing.T) {
	b := &fakeBackend{complete: func(context.Context, json.RawMessage) (*http.Response, error) {
		return nil, &BackendError{Status: 409, Code: "settlement_pending", Message: "Wait for the prior lease to settle."}
	}}
	s := apiServer(t, b)
	response, err := http.DefaultClient.Do(request(t, s.URL, `{"model":"x","messages":[{"role":"user"}]}`))
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	data, _ := io.ReadAll(response.Body)
	if response.StatusCode != 409 || !strings.Contains(string(data), "settlement_pending") {
		t.Fatalf("wrong settlement error: %d %s", response.StatusCode, data)
	}
}
