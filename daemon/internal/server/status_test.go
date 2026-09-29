package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestActiveModeStatusRequiresAuthenticationAndRejectsBrowserOrigins(t *testing.T) {
	api, err := New(&fakeBackend{}, testKey, 1)
	if err != nil {
		t.Fatal(err)
	}
	api.Status = ServiceStatus{Backend: "zkapi", Network: "sepolia", RequestBudgetPolicy: "model"}
	api.ManagementToken = "private-withdrawal-credential-at-least-32-characters"
	api.Admin = http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		t.Error("mode metadata reached wallet management")
	})
	for _, test := range []struct {
		name, method, key, origin, site string
		want                            int
	}{
		{"authorized", http.MethodGet, testKey, "", "", 200},
		{"unauthenticated", http.MethodGet, "", "", "", 401},
		{"wrong key", http.MethodGet, "wrong", "", "", 401},
		{"browser", http.MethodGet, testKey, "https://example.test", "", 403},
		{"cross site", http.MethodGet, testKey, "", "cross-site", 403},
		{"mutation", http.MethodPost, testKey, "", "", 405},
	} {
		t.Run(test.name, func(t *testing.T) {
			r := httptest.NewRequest(test.method, "/admin/status", nil)
			r.Header.Set("Authorization", "Bearer "+test.key)
			r.Header.Set("Origin", test.origin)
			r.Header.Set("Sec-Fetch-Site", test.site)
			w := httptest.NewRecorder()
			api.ServeHTTP(w, r)
			if w.Code != test.want {
				t.Fatalf("status %d, want %d", w.Code, test.want)
			}
			if strings.Contains(w.Body.String(), testKey) || strings.Contains(w.Body.String(), api.ManagementToken) {
				t.Fatal("mode metadata disclosed credentials")
			}
			if test.want == 200 {
				var fields map[string]string
				if json.Unmarshal(w.Body.Bytes(), &fields) != nil || len(fields) != 3 || fields["backend"] != "zkapi" || fields["network"] != "sepolia" || fields["request_budget_policy"] != "model" {
					t.Fatal("mode status exposed unexpected fields", w.Body.String())
				}
			}
		})
	}
	api.Status = ServiceStatus{Backend: "ticket"}
	api.Admin = nil
	r := httptest.NewRequest(http.MethodGet, "/admin/status", nil)
	r.Header.Set("Authorization", "Bearer "+testKey)
	w := httptest.NewRecorder()
	api.ServeHTTP(w, r)
	if w.Code != 200 || strings.TrimSpace(w.Body.String()) != `{"backend":"ticket"}` {
		t.Fatal("ticket mode metadata depends on a funding handler", w.Body.String())
	}
}
