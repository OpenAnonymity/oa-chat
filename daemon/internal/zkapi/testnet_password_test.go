package zkapi

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestTestnetPasswordAuthenticationAndRejection(t *testing.T) {
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v2/auth" || r.Header.Get("Authorization") != "" || r.Header.Get("Cookie") != "" {
			t.Error("unexpected authentication request")
		}
		if r.Header.Get(TestnetPasswordHeader) != "shared secret" {
			w.WriteHeader(401)
			_, _ = io.WriteString(w, "private remote failure details")
			return
		}
		_, _ = io.WriteString(w, `{"authenticated":true}`)
	}))
	defer server.Close()
	for _, password := range []string{"", "wrong", "shared secret"} {
		err := checkTestnetPasswordURL(context.Background(), server.URL+"/v2/auth", password, server.Client())
		if password == "shared secret" {
			if err != nil {
				t.Fatal(err)
			}
			continue
		}
		var auth *Error
		if !errors.As(err, &auth) || auth.Code != "testnet_password_required" || strings.Contains(err.Error(), "private remote") {
			t.Fatalf("unsafe rejection: %v", err)
		}
	}
	if err := CheckTestnetPassword(context.Background(), "mainnet", "shared secret", nil); err != nil {
		t.Fatal("mainnet should not authenticate", err)
	}
}

func TestTestnetPasswordNeverFollowsRedirect(t *testing.T) {
	leaked := false
	other := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { leaked = true }))
	defer other.Close()
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { http.Redirect(w, r, other.URL, 302) }))
	defer server.Close()
	if err := checkTestnetPasswordURL(context.Background(), server.URL, "shared secret", server.Client()); err == nil || leaked {
		t.Fatal("redirect accepted or credential leaked")
	}
}

func TestCompanionPasswordOnlyReachesSepoliaEnvironment(t *testing.T) {
	if got := companionTestnetEnvironment("mainnet", "secret"); len(got) != 0 {
		t.Fatal("mainnet received password")
	}
	if got := companionTestnetEnvironment("sepolia", "secret"); len(got) != 1 || got[0] != "OA_ZKAPI_TESTNET_PASSWORD=secret" {
		t.Fatal("Sepolia lost password")
	}
}

func TestCompanionAuthenticationFailureIsActionableAndRedacted(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(401)
		_, _ = io.WriteString(w, `{"error":{"code":"testnet_password_required","message":"private server details"}}`)
	}))
	defer server.Close()
	client, err := New(Config{ClientURL: server.URL, BridgeToken: testBridgeToken, HTTPClient: http.DefaultClient})
	if err != nil {
		t.Fatal(err)
	}
	_, err = client.request(context.Background(), http.MethodGet, "/oa/v1/billing/quote", nil)
	var rejected *Error
	if !errors.As(err, &rejected) || rejected.Code != "testnet_password_required" || !strings.Contains(err.Error(), "oa-chat config") || strings.Contains(err.Error(), "private server") {
		t.Fatalf("authentication error was hidden or leaked: %v", err)
	}
}

func TestCompanionWithoutPasswordSupportIsRejectedBeforeFunding(t *testing.T) {
	policy := testPolicy("mainnet")
	policy["bridge_version"] = 3
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _ = json.NewEncoder(w).Encode(policy) }))
	defer server.Close()
	client, err := New(Config{ClientURL: server.URL, BridgeToken: testBridgeToken, HTTPClient: http.DefaultClient})
	if err != nil {
		t.Fatal(err)
	}
	var rejected *Error
	if err := client.Check(context.Background()); !errors.As(err, &rejected) || rejected.Code != "companion_policy_mismatch" {
		t.Fatalf("old companion was not rejected: %v", err)
	}
}
