package zkapi

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
)

func TestAddressFundingCapabilityChecksPrecedeSigning(t *testing.T) {
	h, err := NewFundingHandler(&Client{config: Config{Network: "mainnet"}}, "http://127.0.0.1:8787", t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	link, _ := h.NewSession()
	u, _ := url.Parse(link)
	for _, test := range []struct {
		method, path, origin, token, contentType string
		want                                     int
	}{
		{"GET", "/funding/api/address", "", "", "", 401},
		{"POST", "/funding/api/address/deposit", "", "", "application/json", 401},
		{"POST", "/funding/api/address/deposit", "https://evil.invalid", u.Fragment, "application/json", 403},
		{"POST", "/funding/api/address/deposit", "", u.Fragment, "text/plain", 415},
	} {
		r := httptest.NewRequest(test.method, "http://127.0.0.1:8787"+test.path, strings.NewReader(`{"amount":100000}`))
		r.Header.Set("Authorization", "Bearer "+test.token)
		r.Header.Set("Origin", test.origin)
		r.Header.Set("Content-Type", test.contentType)
		w := httptest.NewRecorder()
		// This handler intentionally has no usable RPC/companion client. A
		// request crossing the authorization checks would panic or fail here.
		h.ServeHTTP(w, r)
		if w.Code != test.want {
			t.Fatalf("%s %s: got %d, want %d", test.method, test.path, w.Code, test.want)
		}
	}
}

func TestFundingAdminRejectsMalformedDepositsBeforeAccessingKey(t *testing.T) {
	h := &FundingHandler{}
	for _, body := range []string{`{}`, `{"amount":1,"private_key":"do not accept keys"}`, `{"amount":1} {}`, `{"amount":-1}`, strings.Repeat(" ", 1025)} {
		r := httptest.NewRequest("POST", "http://127.0.0.1:8787/admin/funding/deposit", strings.NewReader(body))
		r.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		h.ServeAdminHTTP(w, r)
		if w.Code != http.StatusBadGateway || strings.Contains(w.Body.String(), "private_key") {
			t.Fatalf("unsafe invalid deposit response: %d %s", w.Code, w.Body.String())
		}
	}
}
