package zkapi

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

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

func TestFundingBrowserEndpointsRemoved(t *testing.T) {
	h := &FundingHandler{}
	for _, path := range []string{"/admin/fund", "/funding", "/funding/app.js", "/funding/api/address", "/funding/api/address/deposit"} {
		r := httptest.NewRequest("POST", "http://127.0.0.1:8787"+path, strings.NewReader("{}"))
		r.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		h.ServeAdminHTTP(w, r)
		if w.Code != http.StatusNotFound {
			t.Errorf("removed path %s: %d", path, w.Code)
		}
	}
}
