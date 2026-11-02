package server

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

// fakeDelegator is a backend with the strict delegation capability.
type fakeDelegator struct {
	fakeBackend
	delegate  func(context.Context, json.RawMessage) (*http.Response, error)
	delegated atomic.Int32
}

func (b *fakeDelegator) Delegate(ctx context.Context, body json.RawMessage) (*http.Response, error) {
	b.delegated.Add(1)
	return b.delegate(ctx, body)
}

func providerJSON(status int, body string) (*http.Response, error) {
	return &http.Response{StatusCode: status, Header: http.Header{"Content-Type": {"application/json"}, "X-Oa-Verification-Status": {"verified"}}, Body: io.NopCloser(strings.NewReader(body))}, nil
}

func delegationRequest(t *testing.T, api *API, host, payload string, headers map[string]string) *httptest.ResponseRecorder {
	t.Helper()
	r := httptest.NewRequest(http.MethodPost, "http://"+host+DelegatePath, strings.NewReader(payload))
	r.RemoteAddr = "127.0.0.1:12345"
	r.Header.Set("Content-Type", "application/json")
	for key, value := range headers {
		r.Header.Set(key, value)
	}
	w := httptest.NewRecorder()
	api.ServeHTTP(w, r)
	return w
}

func newDelegationAPI(t *testing.T, backend Backend) *API {
	t.Helper()
	api, err := New(backend, testKey, 1)
	if err != nil {
		t.Fatal(err)
	}
	return api
}

func errorCode(t *testing.T, w *httptest.ResponseRecorder) string {
	t.Helper()
	var envelope struct {
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	_ = json.Unmarshal(w.Body.Bytes(), &envelope)
	return envelope.Error.Code
}

func TestDelegationSendsOnlyAMinimalNonStreamingRequest(t *testing.T) {
	for _, test := range []struct {
		name, payload, want string
	}{
		{"defaults", `{"task":"Prove it."}`, `{"max_tokens":4096,"messages":[{"content":"Prove it.","role":"user"}],"model":"saved/default","stream":false}`},
		{"all_fields", `{"task":"Review.","context":"func f() {}","model":"other/model","max_output_tokens":900,"reasoning_effort":"high"}`,
			`{"max_tokens":900,"messages":[{"content":"Review.\n\nContext:\nfunc f() {}","role":"user"}],"model":"other/model","reasoning":{"effort":"high"},"stream":false}`},
	} {
		t.Run(test.name, func(t *testing.T) {
			var sent string
			backend := &fakeDelegator{delegate: func(_ context.Context, body json.RawMessage) (*http.Response, error) {
				sent = string(body)
				return providerJSON(200, `{"choices":[{"message":{"content":"ok"},"finish_reason":"stop"}]}`)
			}}
			api := newDelegationAPI(t, backend)
			// Web search defaults on for chat; delegation never adds the plugin.
			api.WebSearch = true
			api.DefaultModel = "saved/default"
			w := delegationRequest(t, api, "127.0.0.1:8787", test.payload, nil)
			if w.Code != 200 || sent != test.want {
				t.Fatalf("status=%d sent=%s", w.Code, sent)
			}
			if backend.calls.Load() != 0 {
				t.Fatal("delegation used the chat completion path")
			}
		})
	}
}

func TestDelegationRejectsCallerControlledFieldsBeforeBackend(t *testing.T) {
	big := strings.Repeat("x", MaxDelegationTaskBytes+1)
	for name, test := range map[string]struct {
		payload, code string
		status        int
	}{
		"messages":       {`{"task":"t","messages":[{"role":"system","content":"x"}]}`, "invalid_request_error", 400},
		"plugins":        {`{"task":"t","plugins":[{"id":"web"}]}`, "invalid_request_error", 400},
		"metadata":       {`{"task":"t","metadata":{"user":"alice"}}`, "invalid_request_error", 400},
		"user":           {`{"task":"t","user":"stable-id"}`, "invalid_request_error", 400},
		"url":            {`{"task":"t","base_url":"https://evil.example"}`, "invalid_request_error", 400},
		"stream":         {`{"task":"t","stream":true}`, "invalid_request_error", 400},
		"two_objects":    {`{"task":"t"}{"task":"u"}`, "invalid_request_error", 400},
		"blank_task":     {`{"task":"  "}`, "invalid_task", 400},
		"nul_task":       {`{"task":"a\u0000b"}`, "invalid_task", 400},
		"long_task":      {`{"task":"` + big + `"}`, "invalid_task", 400},
		"online":         {`{"task":"t","model":"some/model:online"}`, "web_search_unavailable", 400},
		"bad_model":      {`{"task":"t","model":"a b"}`, "invalid_model", 400},
		"no_model":       {`{"task":"t","model":""}`, "model_required", 400},
		"zero_tokens":    {`{"task":"t","max_output_tokens":-1}`, "invalid_max_output_tokens", 400},
		"too_many":       {`{"task":"t","max_output_tokens":32769}`, "invalid_max_output_tokens", 400},
		"bad_effort":     {`{"task":"t","reasoning_effort":"max"}`, "invalid_reasoning_effort", 400},
		"oversized_body": {`{"task":"t","context":"` + strings.Repeat("y", maxDelegationBody) + `"}`, "invalid_body", 413},
	} {
		t.Run(name, func(t *testing.T) {
			backend := &fakeDelegator{delegate: func(context.Context, json.RawMessage) (*http.Response, error) {
				t.Fatal("backend called")
				return nil, nil
			}}
			api := newDelegationAPI(t, backend)
			if name != "no_model" {
				api.DefaultModel = "saved/default"
			}
			w := delegationRequest(t, api, "127.0.0.1:8787", test.payload, nil)
			if w.Code != test.status || errorCode(t, w) != test.code {
				t.Fatalf("status=%d body=%s", w.Code, w.Body.String())
			}
		})
	}
}

func TestDelegationReturnsAnswerWithoutProviderInternals(t *testing.T) {
	provider := `{"id":"gen-SECRET-ID","provider":"RoutedProvider","model":"routed/actual","system_fingerprint":"fp_x",
		"choices":[{"index":0,"finish_reason":"length","native_finish_reason":"MAX_TOKENS",
		"message":{"role":"assistant","content":"partial answer","reasoning":"PRIVATE CHAIN OF THOUGHT","reasoning_details":[{"text":"PRIVATE"}]}}],
		"usage":{"prompt_tokens":10,"completion_tokens":20,"total_tokens":30,"cost":0.001}}`
	backend := &fakeDelegator{delegate: func(context.Context, json.RawMessage) (*http.Response, error) { return providerJSON(200, provider) }}
	api := newDelegationAPI(t, backend)
	w := delegationRequest(t, api, "localhost:8787", `{"task":"t","model":"chosen/model"}`, nil)
	if w.Code != 200 {
		t.Fatalf("status=%d %s", w.Code, w.Body.String())
	}
	for _, leaked := range []string{"gen-", "RoutedProvider", "routed/actual", "fp_x", "PRIVATE", "MAX_TOKENS", "cost"} {
		if strings.Contains(w.Body.String(), leaked) {
			t.Fatalf("leaked %q: %s", leaked, w.Body.String())
		}
	}
	var result DelegationResult
	if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	want := DelegationResult{Model: "chosen/model", Answer: "partial answer", FinishReason: "length", Truncated: true, Usage: &DelegationUsage{10, 20, 30}, Verification: "verified"}
	if result.Model != want.Model || result.Answer != want.Answer || result.FinishReason != want.FinishReason || !result.Truncated || *result.Usage != *want.Usage || result.Verification != want.Verification {
		t.Fatalf("result = %+v", result)
	}
}

func TestDelegationFailuresAreRedactedAndNotRetried(t *testing.T) {
	for name, test := range map[string]struct {
		respond func() (*http.Response, error)
		status  int
		code    string
	}{
		"safe_backend_error": {func() (*http.Response, error) {
			return nil, &BackendError{Status: 412, Code: "delegation_requires_tor", Message: "Delegation requires daemon-native Tor routing."}
		}, 412, "delegation_requires_tor"},
		"raw_error": {func() (*http.Response, error) {
			return nil, errors.New("dial tcp secret-host.example: key=sk-or-SECRET")
		}, 502, "anonymous_access_failed"},
		"provider_status": {func() (*http.Response, error) { return providerJSON(500, `{"error":{"message":"sk-or-SECRET"}}`) }, 500, "upstream_error"},
		"provider_error_body": {func() (*http.Response, error) {
			return providerJSON(200, `{"error":{"message":"sk-or-SECRET"},"choices":[]}`)
		}, 502, "invalid_upstream_response"},
		"not_json": {func() (*http.Response, error) {
			return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": {"text/html"}}, Body: io.NopCloser(strings.NewReader("sk-or-SECRET"))}, nil
		}, 502, "invalid_upstream_response"},
		"oversized": {func() (*http.Response, error) {
			return providerJSON(200, `{"choices":[{"message":{"content":"`+strings.Repeat("a", maxDelegationResponse)+`"}}]}`)
		}, 502, "invalid_upstream_response"},
		"canceled": {func() (*http.Response, error) { return nil, context.Canceled }, 408, "request_cancelled"},
	} {
		t.Run(name, func(t *testing.T) {
			backend := &fakeDelegator{delegate: func(context.Context, json.RawMessage) (*http.Response, error) { return test.respond() }}
			api := newDelegationAPI(t, backend)
			api.DefaultModel = "saved/default"
			w := delegationRequest(t, api, "127.0.0.1:8787", `{"task":"t"}`, nil)
			if w.Code != test.status || errorCode(t, w) != test.code || backend.delegated.Load() != 1 {
				t.Fatalf("status=%d calls=%d body=%s", w.Code, backend.delegated.Load(), w.Body.String())
			}
			if strings.Contains(w.Body.String(), "SECRET") || strings.Contains(w.Body.String(), "secret-host") {
				t.Fatalf("leaked error detail: %s", w.Body.String())
			}
		})
	}
}

func TestDelegationRequiresLocalCallerAndCapability(t *testing.T) {
	ok := func(context.Context, json.RawMessage) (*http.Response, error) {
		return providerJSON(200, `{"choices":[{"message":{"content":"ok"},"finish_reason":"stop"}]}`)
	}
	for name, test := range map[string]struct {
		host       string
		headers    map[string]string
		requireKey bool
		status     int
	}{
		"rebinding_host":             {"attacker.example:8787", nil, false, 403},
		"browser_origin":             {"127.0.0.1:8787", map[string]string{"Origin": "https://attacker.example"}, false, 403},
		"key_required_missing":       {"127.0.0.1:8787", nil, true, 401},
		"key_required_present":       {"127.0.0.1:8787", map[string]string{"Authorization": "Bearer " + testKey}, true, 200},
		"key_cannot_bypass_locality": {"attacker.example:8787", map[string]string{"Authorization": "Bearer " + testKey}, true, 403},
		"keyless_local":              {"127.0.0.1:8787", nil, false, 200},
	} {
		t.Run(name, func(t *testing.T) {
			backend := &fakeDelegator{delegate: ok}
			api := newDelegationAPI(t, backend)
			api.DefaultModel = "saved/default"
			api.RequireAPIKey = test.requireKey
			w := delegationRequest(t, api, test.host, `{"task":"t"}`, test.headers)
			if w.Code != test.status {
				t.Fatalf("status=%d body=%s", w.Code, w.Body.String())
			}
		})
	}
	t.Run("remote_peer", func(t *testing.T) {
		backend := &fakeDelegator{delegate: ok}
		api := newDelegationAPI(t, backend)
		r := httptest.NewRequest(http.MethodPost, "http://127.0.0.1:8787"+DelegatePath, strings.NewReader(`{"task":"t","model":"m/m"}`))
		r.RemoteAddr = "192.0.2.1:5555"
		r.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		api.ServeHTTP(w, r)
		if w.Code != 403 || backend.delegated.Load() != 0 {
			t.Fatalf("status=%d", w.Code)
		}
	})
	t.Run("backend_without_capability", func(t *testing.T) {
		backend := &fakeBackend{complete: func(context.Context, json.RawMessage) (*http.Response, error) {
			t.Fatal("chat path used for delegation")
			return nil, nil
		}}
		api := newDelegationAPI(t, backend)
		w := delegationRequest(t, api, "127.0.0.1:8787", `{"task":"t","model":"m/m"}`, nil)
		if w.Code != http.StatusNotImplemented || errorCode(t, w) != "delegation_unsupported" {
			t.Fatalf("status=%d body=%s", w.Code, w.Body.String())
		}
	})
	t.Run("get_not_allowed", func(t *testing.T) {
		api := newDelegationAPI(t, &fakeDelegator{delegate: ok})
		r := httptest.NewRequest(http.MethodGet, "http://127.0.0.1:8787"+DelegatePath, nil)
		r.RemoteAddr = "127.0.0.1:1"
		w := httptest.NewRecorder()
		api.ServeHTTP(w, r)
		if w.Code != 405 {
			t.Fatalf("status=%d", w.Code)
		}
	})
}
