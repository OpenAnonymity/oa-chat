package server

import (
	"context"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func successfulCompletion(context.Context, json.RawMessage) (*http.Response, error) {
	return &http.Response{StatusCode: http.StatusOK, Header: http.Header{"Content-Type": {"application/json"}}, Body: io.NopCloser(strings.NewReader(`{"choices":[]}`))}, nil
}

func TestDefaultInferenceNeedsNoAPIKeyButManagementStaysAuthenticated(t *testing.T) {
	backend := &fakeBackend{complete: successfulCompletion}
	api, err := New(backend, testKey, 1)
	if err != nil {
		t.Fatal(err)
	}
	api.Admin = http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		t.Error("keyless request reached wallet management")
	})
	s := httptest.NewServer(api)
	defer s.Close()
	for _, auth := range []string{"", "Bearer unused-open-webui-placeholder"} {
		for _, path := range []string{"/v1/models", "/v1/chat/completions", "/admin/status", "/admin/funding/address"} {
			t.Run(path+"/"+auth, func(t *testing.T) {
				method, body := http.MethodGet, ""
				if path == "/v1/chat/completions" {
					method, body = http.MethodPost, `{"model":"x","messages":[{"role":"user","content":"hello"}]}`
				}
				r, err := http.NewRequest(method, s.URL+path, strings.NewReader(body))
				if err != nil {
					t.Fatal(err)
				}
				r.Header.Set("Content-Type", "application/json")
				r.Header.Set("Authorization", auth)
				resp, err := s.Client().Do(r)
				if err != nil {
					t.Fatal(err)
				}
				resp.Body.Close()
				want := http.StatusOK
				if strings.HasPrefix(path, "/admin/") {
					want = http.StatusUnauthorized
				}
				if resp.StatusCode != want {
					t.Fatalf("status %d, want %d", resp.StatusCode, want)
				}
			})
		}
	}
	if backend.calls.Load() != 2 {
		t.Fatal("unexpected inference count")
	}
}

func TestOptionalInferenceAuthenticationRequiresRealKey(t *testing.T) {
	api, err := New(&fakeBackend{complete: successfulCompletion}, testKey, 1)
	if err != nil {
		t.Fatal(err)
	}
	api.RequireAPIKey = true
	s := httptest.NewServer(api)
	defer s.Close()
	for _, auth := range []string{"", "Bearer dummy", "Bearer " + testKey} {
		for _, path := range []string{"/v1/models", "/v1/chat/completions"} {
			method := http.MethodGet
			if path == "/v1/chat/completions" {
				method = http.MethodPost
			}
			r, err := http.NewRequest(method, s.URL+path, strings.NewReader(`{"model":"x","messages":[{"role":"user"}]}`))
			if err != nil {
				t.Fatal(err)
			}
			r.Header.Set("Content-Type", "application/json")
			r.Header.Set("Authorization", auth)
			resp, err := s.Client().Do(r)
			if err != nil {
				t.Fatal(err)
			}
			resp.Body.Close()
			want := http.StatusUnauthorized
			if auth == "Bearer "+testKey {
				want = http.StatusOK
			}
			if resp.StatusCode != want {
				t.Fatalf("%s status %d, want %d", path, resp.StatusCode, want)
			}
		}
	}
}

func TestKeylessInferenceRejectsBrowserRebindingAndNonlocalPeers(t *testing.T) {
	for _, test := range []struct {
		name, peer, host, origin, site string
		want                           int
	}{
		{"ipv4 loopback", "127.0.0.1:5000", "127.0.0.1:8787", "", "", 200},
		{"localhost", "127.0.0.1:5000", "localhost:8787", "", "", 200},
		{"ipv6 loopback", "[::1]:5000", "[::1]:8787", "", "", 200},
		{"mapped loopback", "[::ffff:127.0.0.1]:5000", "localhost:8787", "", "", 200},
		{"remote peer", "192.0.2.3:5000", "localhost:8787", "", "", 403},
		{"missing peer", "", "localhost:8787", "", "", 403},
		{"remote host", "127.0.0.1:5000", "192.0.2.3:8787", "", "", 403},
		{"rebound host", "127.0.0.1:5000", "attacker.example:8787", "", "", 403},
		{"localhost suffix", "127.0.0.1:5000", "localhost.attacker.example:8787", "", "", 403},
		{"wrong port", "127.0.0.1:5000", "localhost:8788", "", "", 403},
		{"missing port", "127.0.0.1:5000", "localhost", "", "", 403},
		{"origin", "127.0.0.1:5000", "localhost:8787", "https://attacker.example", "", 403},
		{"null origin", "127.0.0.1:5000", "localhost:8787", "null", "", 403},
		{"cross site", "127.0.0.1:5000", "localhost:8787", "", "cross-site", 403},
	} {
		t.Run(test.name, func(t *testing.T) {
			backend := &fakeBackend{complete: successfulCompletion}
			api, err := New(backend, testKey, 1)
			if err != nil {
				t.Fatal(err)
			}
			for _, path := range []string{"/v1/models", "/v1/chat/completions"} {
				method := http.MethodGet
				if path == "/v1/chat/completions" {
					method = http.MethodPost
				}
				r := httptest.NewRequest(method, path, strings.NewReader(`{"model":"x","messages":[{"role":"user"}]}`))
				r.RemoteAddr, r.Host = test.peer, test.host
				r.Header.Set("Content-Type", "application/json")
				r.Header.Set("Origin", test.origin)
				r.Header.Set("Sec-Fetch-Site", test.site)
				// A correct key and forged forwarding headers never override the
				// actual local boundary when inference is configured keyless.
				r.Header.Set("Authorization", "Bearer "+testKey)
				r.Header.Set("X-Forwarded-For", "127.0.0.1")
				r.Header.Set("X-Forwarded-Host", "localhost:8787")
				r.Header.Set("Forwarded", "for=127.0.0.1;host=localhost:8787")
				r = r.WithContext(context.WithValue(r.Context(), http.LocalAddrContextKey, &net.TCPAddr{IP: net.IPv4(127, 0, 0, 1), Port: 8787}))
				w := httptest.NewRecorder()
				api.ServeHTTP(w, r)
				if w.Code != test.want {
					t.Fatalf("%s status %d, want %d", path, w.Code, test.want)
				}
			}
			if test.want != 200 && backend.calls.Load() != 0 {
				t.Fatal("rejected client spent access")
			}
		})
	}
}
