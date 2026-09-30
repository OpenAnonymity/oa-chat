package main

import (
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
	"sync/atomic"
	"testing"
	"time"

	"github.com/OpenAnonymity/oa-chat/daemon/internal/config"
)

func TestTicketInferenceReusesKeyAndRetiresFailedResponse(t *testing.T) {
	for _, kind := range []string{"success", "HTTP failure", "early close", "canceled"} {
		t.Run(kind, func(t *testing.T) {
			dir := t.TempDir()
			wallet := `{"version":1,"org_url":"https://org.example","active":[{"finalized_ticket":"fixture-one","ticket_key_id":"fixture-issuer"},{"finalized_ticket":"fixture-two","ticket_key_id":"fixture-issuer"}],"spent":{},"invalidated":{}}`
			if err := os.WriteFile(filepath.Join(dir, "tickets.json"), []byte(wallet), 0600); err != nil {
				t.Fatal(err)
			}
			var issued, forwarded int
			var keys []string
			remote := &http.Client{Transport: ticketInferenceTransport(func(r *http.Request) (*http.Response, error) {
				status, body := 200, ""
				switch r.URL.String() {
				case "https://org.example/chat/model-tickets":
					body = `{"test/model":1}`
				case "https://org.example/chat/pinned-models":
					body = `{"disabled_models":[]}`
				case "https://org.example/api/request_key":
					issued++
					body = fmt.Sprintf(`{"key":"fresh-key-%d","station_id":"fixture-station","station_signature":"fixture-station-signature","org_signature":"fixture-org-signature","expires_at_unix":%d,"station_recently_attested":true}`, issued, time.Now().Add(time.Hour).Unix())
				case "https://verifier.example/submit_key":
					hash := sha256.Sum256([]byte(fmt.Sprintf("fresh-key-%d", issued)))
					body = fmt.Sprintf(`{"status":"verified","station_id":"fixture-station","key_hash":%q}`, hex.EncodeToString(hash[:8]))
				case "https://openrouter.ai/api/v1/chat/completions":
					forwarded++
					keys = append(keys, r.Header.Get("Authorization"))
					body = `{"choices":[]}`
					if kind == "HTTP failure" && forwarded == 1 {
						status = http.StatusPaymentRequired
					}
				default:
					return nil, fmt.Errorf("unexpected fixture endpoint")
				}
				return &http.Response{StatusCode: status, Header: http.Header{"Content-Type": {"application/json"}}, Body: io.NopCloser(strings.NewReader(body))}, nil
			})}
			c := config.Config{OrgURL: "https://org.example", VerifierURL: "https://verifier.example", KeyReuseWindowSeconds: 60}
			backend, err := ticketBackend(dir, c, remote)
			if err != nil {
				t.Fatal(err)
			}
			inference := &ticketInference{wallet: backend, client: remote}
			request := json.RawMessage(`{"model":"test/model","messages":[{"role":"user","content":"private prompt"}]}`)
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			first, err := inference.Complete(ctx, request)
			if err != nil {
				t.Fatal(err)
			}
			if kind == "canceled" {
				cancel()
			}
			if kind != "early close" && kind != "canceled" {
				_, _ = io.Copy(io.Discard, first.Body)
			}
			_ = first.Body.Close()
			second, err := inference.Complete(context.Background(), request)
			if err != nil {
				t.Fatal(err)
			}
			_, _ = io.Copy(io.Discard, second.Body)
			_ = second.Body.Close()
			wantIssued := 2
			if kind == "success" {
				wantIssued = 1
			}
			if issued != wantIssued || forwarded != 2 || keys[0] != "Bearer fresh-key-1" || keys[1] != fmt.Sprintf("Bearer fresh-key-%d", wantIssued) {
				t.Fatalf("wrong credential lifecycle: issued=%d forwarded=%d", issued, forwarded)
			}
		})
	}
}

type failedTicketBody struct{ closes atomic.Int32 }

func (b *failedTicketBody) Read([]byte) (int, error) { return 0, io.ErrUnexpectedEOF }
func (b *failedTicketBody) Close() error             { b.closes.Add(1); return nil }

type failedTicketClose struct{ io.Reader }

func (b *failedTicketClose) Close() error { return io.ErrUnexpectedEOF }

func TestTicketResponseCloseFailureInvalidatesAfterEOF(t *testing.T) {
	var invalidated atomic.Int32
	body := &failedTicketClose{Reader: strings.NewReader("provider response")}
	watched := watchTicketResponse(context.Background(), body, func() { invalidated.Add(1) })
	got, err := io.ReadAll(watched)
	if err != nil || string(got) != "provider response" {
		t.Fatal("provider body was changed", err)
	}
	_ = watched.Close()
	if invalidated.Load() != 1 {
		t.Fatal("failed cleanup left credential reusable")
	}
}

func TestTicketResponseFailureInvalidatesExactlyOnce(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	body := &failedTicketBody{}
	var invalidated atomic.Int32
	watched := watchTicketResponse(ctx, body, func() { invalidated.Add(1) })
	if _, err := watched.Read(make([]byte, 8)); err != io.ErrUnexpectedEOF {
		t.Fatal("read error was changed", err)
	}
	cancel()
	_ = watched.Close()
	if invalidated.Load() != 1 || body.closes.Load() != 1 {
		t.Fatal("response failure cleanup repeated or failed")
	}
}
