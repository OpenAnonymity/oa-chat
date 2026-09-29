package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/OpenAnonymity/oa-chat/daemon/internal/ticket"
)

type ticketInferenceTransport func(*http.Request) (*http.Response, error)

func (fn ticketInferenceTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	return fn(req)
}

func TestTicketInferenceOverridesProviderVerificationHeaders(t *testing.T) {
	for _, outage := range []bool{false, true} {
		t.Run(fmt.Sprintf("outage=%v", outage), func(t *testing.T) {
			const ephemeral = "ephemeral-fixture-key"
			const org = "https://org.example"
			path := filepath.Join(t.TempDir(), "tickets.json")
			// A private wallet fixture isolates forwarding from blind issuance,
			// whose cryptographic interoperability is tested in internal/ticket.
			walletJSON := `{"version":1,"org_url":"https://org.example","active":[{"finalized_ticket":"fixture-ticket","ticket_key_id":"fixture-issuer"}],"spent":{},"invalidated":{}}`
			if err := os.WriteFile(path, []byte(walletJSON), 0600); err != nil {
				t.Fatal(err)
			}
			keyRequests, verificationRequests := 0, 0
			walletClient := &http.Client{Transport: ticketInferenceTransport(func(r *http.Request) (*http.Response, error) {
				status, body := 200, ""
				switch r.URL.String() {
				case org + "/chat/model-tickets":
					body = `{"test/model":1}`
				case org + "/chat/pinned-models":
					body = `{"disabled_models":[]}`
				case org + "/api/request_key":
					keyRequests++
					body = fmt.Sprintf(`{"key":%q,"station_id":"fixture-station","station_signature":"fixture-station-signature","org_signature":"fixture-org-signature","expires_at_unix":%d,"station_recently_attested":true}`, ephemeral, time.Now().Add(time.Hour).Unix())
				case "https://verifier.example/submit_key":
					verificationRequests++
					if outage {
						status, body = 503, `{"status":"unavailable"}`
					} else {
						hash := sha256.Sum256([]byte(ephemeral))
						body = fmt.Sprintf(`{"status":"verified","station_id":"fixture-station","key_hash":%q}`, hex.EncodeToString(hash[:8]))
					}
				default:
					t.Fatalf("unexpected wallet request: %s", r.URL)
				}
				return &http.Response{StatusCode: status, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(body))}, nil
			})}
			wallet, err := ticket.New(ticket.Config{OrgURL: org, VerifierURL: "https://verifier.example", WalletPath: path, Client: walletClient})
			if err != nil {
				t.Fatal(err)
			}
			prompt := json.RawMessage(`{"model":"test/model","messages":[{"role":"user","content":"private test prompt"}]}`)
			providerRequests := 0
			client := &http.Client{Transport: ticketInferenceTransport(func(r *http.Request) (*http.Response, error) {
				providerRequests++
				if r.URL.String() != "https://openrouter.ai/api/v1/chat/completions" || r.Header.Get("Authorization") != "Bearer "+ephemeral {
					t.Fatal("inference did not use the exact newly issued provider credential")
				}
				body, err := io.ReadAll(r.Body)
				if err != nil || !bytes.Equal(body, prompt) {
					t.Fatal("inference payload changed")
				}
				if r.Header.Get("X-OA-Verification-Status") != "" || r.Header.Get("X-OA-Verification-Detail") != "" {
					t.Fatal("local verification metadata reached the provider")
				}
				header := make(http.Header)
				// A provider cannot upgrade outage access or downgrade verified access.
				status := "verifier-unavailable"
				if outage {
					status = "verified"
				}
				header.Add("X-OA-Verification-Status", status)
				header.Add("X-OA-Verification-Status", "private-provider-status")
				header.Set("X-OA-Verification-Detail", "private-provider-detail")
				return &http.Response{StatusCode: 200, Header: header, Body: io.NopCloser(strings.NewReader(`{"choices":[]}`))}, nil
			})}
			response, err := (&ticketInference{wallet: wallet, client: client}).Complete(context.Background(), prompt)
			if err != nil {
				t.Fatal(err)
			}
			defer response.Body.Close()
			wantStatus, wantDetail := "verified", ""
			if outage {
				wantStatus, wantDetail = "verifier-unavailable", "recently_attested_outage"
			}
			if response.Header.Get("X-OA-Verification-Status") != wantStatus || len(response.Header.Values("X-OA-Verification-Status")) != 1 || response.Header.Get("X-OA-Verification-Detail") != wantDetail {
				t.Fatalf("provider altered verification metadata: %v", response.Header)
			}
			if keyRequests != 1 || verificationRequests != 1 || providerRequests != 1 {
				t.Fatal("inference did not use exactly one issued and checked credential")
			}
			if count, err := wallet.Count(); err != nil || count != 0 {
				t.Fatal("outage/verified forwarding restored spent tickets")
			}
		})
	}
}
