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

const testBridgeToken = "unit-test-companion-token-32-characters"

func newTestClient(t *testing.T, handler http.HandlerFunc, inference *httptest.Server) *Client {
	t.Helper()
	local := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer "+testBridgeToken {
			t.Error("bridge request did not authenticate")
			w.WriteHeader(401)
			return
		}
		if r.URL.Path == "/oa/v1/status" {
			_, _ = io.WriteString(w, `{"bridge_version":1,"chain_id":1,"mode":"direct_openrouter","require_oa_org_key_source":true}`)
			return
		}
		handler(w, r)
	}))
	t.Cleanup(local.Close)
	c, err := New(Config{ClientURL: local.URL, BridgeToken: testBridgeToken, InferenceBaseURL: inference.URL, HTTPClient: inference.Client()})
	if err != nil {
		t.Fatal(err)
	}
	return c
}

func TestCompleteReturnsLiveSSEAndSendsNoPromptToCompanion(t *testing.T) {
	release := make(chan struct{})
	first := make(chan struct{})
	prompt := json.RawMessage(`{"model":"example/model","messages":[{"role":"user","content":"private prompt"}],"stream":true,"tools":[{"type":"function"}]}`)
	upstream := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		data, _ := io.ReadAll(r.Body)
		if string(data) != string(prompt) {
			t.Error("request body changed")
		}
		if r.Header.Get("Authorization") != "Bearer ephemeral-test-key" {
			t.Error("wrong inference credential")
		}
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = io.WriteString(w, "data: {\"choices\":[{\"delta\":{\"content\":\"first\"}}]}\n\n")
		w.(http.Flusher).Flush()
		close(first)
		select {
		case <-release:
		case <-r.Context().Done():
			return
		}
		_, _ = io.WriteString(w, "data: [DONE]\n\n")
	}))
	defer upstream.Close()
	defer close(release)
	client := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/oa/v1/lease" {
			t.Errorf("unexpected bridge path %s", r.URL.Path)
		}
		data, _ := io.ReadAll(r.Body)
		if string(data) != "{}" {
			t.Error("inference payload crossed wallet bridge")
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"api_key": "ephemeral-test-key", "base_url": upstream.URL, "expires_at": time.Now().Unix() + 60, "verified": true})
	}, upstream)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	response, err := client.Complete(ctx, prompt)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	<-first
	data := make([]byte, 200)
	n, err := response.Body.Read(data)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(data[:n]), "first") {
		t.Fatal("first token was buffered")
	}
}

func TestLeasePolicyFailureNeverSendsPrompt(t *testing.T) {
	for _, kind := range []string{"unverified", "origin", "expired", "header"} {
		t.Run(kind, func(t *testing.T) {
			var called atomic.Bool
			upstream := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { called.Store(true) }))
			defer upstream.Close()
			client := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
				lease := map[string]any{"api_key": "secret", "base_url": upstream.URL, "expires_at": time.Now().Unix() + 60, "verified": true}
				switch kind {
				case "unverified":
					lease["verified"] = false
				case "origin":
					lease["base_url"] = "https://attacker.invalid"
				case "expired":
					lease["expires_at"] = time.Now().Unix() - 1
				case "header":
					lease["api_key"] = "bad\r\nsecret"
				}
				_ = json.NewEncoder(w).Encode(lease)
			}, upstream)
			if _, err := client.Complete(context.Background(), json.RawMessage(`{}`)); err == nil {
				t.Fatal("unsafe lease accepted")
			}
			if called.Load() {
				t.Fatal("prompt sent under unsafe lease")
			}
		})
	}
}

func TestRejectsCompanionPolicyMismatch(t *testing.T) {
	for _, policy := range []string{
		`{"bridge_version":1,"chain_id":11155111,"mode":"direct_openrouter","require_oa_org_key_source":true}`,
		`{"bridge_version":1,"chain_id":1,"mode":"proxy","require_oa_org_key_source":true}`,
		`{"bridge_version":1,"chain_id":1,"mode":"direct_openrouter","require_oa_org_key_source":false}`,
	} {
		local := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = io.WriteString(w, policy) }))
		c, err := New(Config{ClientURL: local.URL, BridgeToken: testBridgeToken, HTTPClient: http.DefaultClient})
		if err != nil {
			t.Fatal(err)
		}
		if err := c.Check(context.Background()); err == nil {
			t.Fatal("unsafe companion policy accepted")
		}
		local.Close()
	}
}

func TestRejectsUnsafeLocalOrigins(t *testing.T) {
	for _, base := range []string{"http://localhost:12", "http://127.0.0.1.attacker.invalid:12", "http://192.168.1.2:12", "http://127.0.0.1:12/path", "http://user:secret@127.0.0.1:12", "http://127.0.0.1:12?x=1", "https://127.0.0.1:12"} {
		if _, err := New(Config{ClientURL: base, BridgeToken: testBridgeToken, HTTPClient: http.DefaultClient}); err == nil {
			t.Errorf("accepted %s", base)
		}
	}
	if _, err := New(Config{BridgeToken: testBridgeToken}); err == nil {
		t.Fatal("missing anonymous transport accepted")
	}
}

func TestNoRedirectOfCredentialOrPrompt(t *testing.T) {
	var received atomic.Bool
	attacker := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { received.Store(true) }))
	defer attacker.Close()
	upstream := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Location", attacker.URL)
		w.WriteHeader(http.StatusTemporaryRedirect)
	}))
	defer upstream.Close()
	client := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"api_key": "secret", "base_url": upstream.URL, "expires_at": time.Now().Unix() + 60, "verified": true})
	}, upstream)
	response, err := client.Complete(context.Background(), json.RawMessage(`{"messages":[]}`))
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != 307 || received.Load() {
		t.Fatal("followed inference redirect")
	}
}

func TestCompanionErrorRedactsUpstreamBody(t *testing.T) {
	local := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(502)
		_, _ = io.WriteString(w, `{"error":"secret private-key note"}`)
	}))
	defer local.Close()
	c, err := New(Config{ClientURL: local.URL, BridgeToken: testBridgeToken, HTTPClient: http.DefaultClient})
	if err != nil {
		t.Fatal(err)
	}
	err = c.Check(context.Background())
	if err == nil || strings.Contains(err.Error(), "secret") {
		t.Fatal("raw companion error leaked")
	}
}

func TestProviderLeaseNeverReusedAcrossAPIRequests(t *testing.T) {
	var calls atomic.Int32
	upstream := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { calls.Add(1); _, _ = io.WriteString(w, `{}`) }))
	defer upstream.Close()
	client := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"api_key": "one-private-session-only", "base_url": upstream.URL, "expires_at": time.Now().Unix() + 60, "verified": true})
	}, upstream)
	response, err := client.Complete(context.Background(), json.RawMessage(`{"messages":[]}`))
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if _, err = client.Complete(context.Background(), json.RawMessage(`{"messages":[]}`)); err == nil {
		t.Fatal("reused provider key across unrelated requests")
	}
	if calls.Load() != 1 {
		t.Fatal("second request reached provider")
	}
}

func TestInferenceNeverInheritsCookieJar(t *testing.T) {
	upstream := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Cookie") != "" {
			t.Error("identity cookie reached inference provider")
		}
		_, _ = io.WriteString(w, `{}`)
	}))
	defer upstream.Close()
	jar, _ := cookiejar.New(nil)
	origin, _ := url.Parse(upstream.URL)
	jar.SetCookies(origin, []*http.Cookie{{Name: "identity", Value: "should-not-leave-client"}})
	upstream.Client().Jar = jar
	client := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"api_key": "cookie-free-key", "base_url": upstream.URL, "expires_at": time.Now().Unix() + 60, "verified": true})
	}, upstream)
	response, err := client.Complete(context.Background(), json.RawMessage(`{}`))
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
}
