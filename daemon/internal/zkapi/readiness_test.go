package zkapi

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
)

func TestReadinessUsesAuthenticatedReadOnlyStateAndChecksWithdrawalReservations(t *testing.T) {
	for _, network := range []string{"mainnet", "sepolia"} {
		t.Run(network, func(t *testing.T) {
			for _, test := range []struct {
				name       string
				wallet     string
				withdrawal string
				want       WalletReadiness
			}{
				{"empty", `{"has_note":false,"pending_request":false,"note":null}`, `{"phase":"none"}`, WalletReadiness{}},
				{"funded", `{"has_note":true,"pending_request":false,"note":{"note_id":7,"current_balance":123456}}`, `{"phase":"none"}`, WalletReadiness{HasNote: true, Balance: 123456}},
				{"exhausted", `{"has_note":true,"pending_request":false,"note":{"note_id":0,"current_balance":0}}`, `{"phase":"none"}`, WalletReadiness{HasNote: true}},
				{"settlement", `{"has_note":true,"pending_request":true,"note":{"note_id":7,"current_balance":123456}}`, `{"phase":"none"}`, WalletReadiness{HasNote: true, PendingRequest: true, Balance: 123456}},
				{"reserved", `{"has_note":true,"pending_request":false,"note":{"note_id":7,"current_balance":123456}}`, `{"phase":"reserved","note_id":7,"final_balance":"123456"}`, WalletReadiness{HasNote: true, Balance: 123456, WithdrawalPending: true}},
				{"reserved_missing_note", `{"has_note":false,"pending_request":false}`, `{"phase":"reserved","note_id":7,"final_balance":"123456"}`, WalletReadiness{WithdrawalPending: true}},
				{"withdrawn", `{"has_note":false,"pending_request":false}`, `{"phase":"complete","note_id":7,"final_balance":"123456"}`, WalletReadiness{}},
				{"historical_withdrawal", `{"has_note":true,"pending_request":false,"note":{"note_id":8,"current_balance":123456}}`, `{"phase":"complete","note_id":7,"final_balance":"654321"}`, WalletReadiness{HasNote: true, Balance: 123456}},
			} {
				t.Run(test.name, func(t *testing.T) {
					var paths []string
					local := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
						body, _ := io.ReadAll(r.Body)
						if r.Method != http.MethodGet || r.Header.Get("Authorization") != "Bearer "+testBridgeToken || len(body) != 0 {
							t.Error("readiness must use authenticated reads without a request payload")
						}
						paths = append(paths, r.URL.Path)
						switch r.URL.Path {
						case "/oa/v1/status":
							_ = json.NewEncoder(w).Encode(testPolicy(network))
						case "/wallet/status":
							_, _ = io.WriteString(w, test.wallet)
						case "/oa/v1/withdraw/status":
							_, _ = io.WriteString(w, test.withdrawal)
						default:
							t.Errorf("unexpected action during readiness: %s", r.URL.Path)
							w.WriteHeader(http.StatusNotFound)
						}
					}))
					defer local.Close()
					client, err := New(Config{ClientURL: local.URL, BridgeToken: testBridgeToken, Network: network, HTTPClient: http.DefaultClient})
					if err != nil {
						t.Fatal(err)
					}
					got, err := client.Readiness(context.Background())
					if err != nil || got != test.want {
						t.Fatalf("got %+v, %v; want %+v", got, err, test.want)
					}
					if !reflect.DeepEqual(paths, []string{"/oa/v1/status", "/wallet/status", "/oa/v1/withdraw/status"}) {
						t.Fatalf("unexpected readiness requests: %v", paths)
					}
				})
			}
		})
	}
}

func TestReadinessFailsClosedForIncompleteAndContradictoryState(t *testing.T) {
	validWallet := `{"has_note":true,"pending_request":false,"note":{"note_id":7,"current_balance":123456}}`
	for _, test := range []struct{ name, wallet, withdrawal string }{
		{"missing_has_note", `{"pending_request":false}`, `{"phase":"none"}`},
		{"missing_pending", `{"has_note":false}`, `{"phase":"none"}`},
		{"null_pending", `{"has_note":false,"pending_request":null}`, `{"phase":"none"}`},
		{"missing_note", `{"has_note":true,"pending_request":false}`, `{"phase":"none"}`},
		{"missing_note_id", `{"has_note":true,"pending_request":false,"note":{"current_balance":0}}`, `{"phase":"none"}`},
		{"invalid_note_id", `{"has_note":true,"pending_request":false,"note":{"note_id":4294967296,"current_balance":0}}`, `{"phase":"none"}`},
		{"missing_balance", `{"has_note":true,"pending_request":false,"note":{"note_id":7}}`, `{"phase":"none"}`},
		{"negative_balance", `{"has_note":true,"pending_request":false,"note":{"note_id":7,"current_balance":-1}}`, `{"phase":"none"}`},
		{"false_with_note", `{"has_note":false,"pending_request":false,"note":{"note_id":7,"current_balance":0}}`, `{"phase":"none"}`},
		{"empty_withdrawal", validWallet, `{}`},
		{"unknown_phase", validWallet, `{"phase":"mystery"}`},
		{"none_with_note", validWallet, `{"phase":"none","note_id":7}`},
		{"reserved_missing_id", validWallet, `{"phase":"reserved","final_balance":"123456"}`},
		{"reserved_wrong_id", validWallet, `{"phase":"reserved","note_id":8,"final_balance":"123456"}`},
		{"reserved_wrong_balance", validWallet, `{"phase":"reserved","note_id":7,"final_balance":"123455"}`},
		{"reserved_padded_balance", validWallet, `{"phase":"reserved","note_id":7,"final_balance":"0123456"}`},
		{"reserved_missing_balance", validWallet, `{"phase":"reserved","note_id":7}`},
		{"completed_missing_id", validWallet, `{"phase":"complete","final_balance":"123456"}`},
		{"completed_active_note", validWallet, `{"phase":"complete","note_id":7,"final_balance":"123456"}`},
	} {
		t.Run(test.name, func(t *testing.T) {
			local := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				switch r.URL.Path {
				case "/oa/v1/status":
					_ = json.NewEncoder(w).Encode(testPolicy("mainnet"))
				case "/wallet/status":
					_, _ = io.WriteString(w, test.wallet)
				case "/oa/v1/withdraw/status":
					_, _ = io.WriteString(w, test.withdrawal)
				default:
					t.Errorf("unexpected readiness action: %s", r.URL.Path)
				}
			}))
			defer local.Close()
			client, err := New(Config{ClientURL: local.URL, BridgeToken: testBridgeToken, HTTPClient: http.DefaultClient})
			if err != nil {
				t.Fatal(err)
			}
			if got, err := client.Readiness(context.Background()); err == nil || got != (WalletReadiness{}) {
				t.Fatalf("invalid state accepted: %+v, %v", got, err)
			}
		})
	}
}

func TestReadinessRequiresCompanionPolicyAndRedactsFailures(t *testing.T) {
	for _, failurePath := range []string{"/oa/v1/status", "/wallet/status", "/oa/v1/withdraw/status"} {
		t.Run(failurePath, func(t *testing.T) {
			local := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path == failurePath {
					w.WriteHeader(http.StatusBadGateway)
					_, _ = io.WriteString(w, `{"error":"private recovery secret"}`)
					return
				}
				switch r.URL.Path {
				case "/oa/v1/status":
					_ = json.NewEncoder(w).Encode(testPolicy("mainnet"))
				case "/wallet/status":
					_, _ = io.WriteString(w, `{"has_note":false,"pending_request":false}`)
				default:
					t.Errorf("continued after failed readiness check: %s", r.URL.Path)
				}
			}))
			defer local.Close()
			client, err := New(Config{ClientURL: local.URL, BridgeToken: testBridgeToken, HTTPClient: http.DefaultClient})
			if err != nil {
				t.Fatal(err)
			}
			got, err := client.Readiness(context.Background())
			if err == nil || got != (WalletReadiness{}) || strings.Contains(err.Error(), "secret") {
				t.Fatalf("readiness did not safely fail: %+v, %v", got, err)
			}
		})
	}
}
