package main

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/OpenAnonymity/oa-chat/daemon/internal/zkapi"
)

func TestPaymentQuoteRejectsInvalidAuthorizationBindings(t *testing.T) {
	for name, mutate := range map[string]func(*zkapi.AddressPaymentQuote){
		"expired":      func(q *zkapi.AddressPaymentQuote) { q.ExpiresAt = time.Now().Add(-time.Second).UnixMilli() },
		"network":      func(q *zkapi.AddressPaymentQuote) { q.ChainID = 11155111 },
		"deployment":   func(q *zkapi.AddressPaymentQuote) { q.DeploymentID = "other-vault" },
		"vault":        func(q *zkapi.AddressPaymentQuote) { q.Contract = withdrawalTestDestination },
		"id":           func(q *zkapi.AddressPaymentQuote) { q.ID = "bad" },
		"kind":         func(q *zkapi.AddressPaymentQuote) { q.Kind = "return" },
		"principal":    func(q *zkapi.AddressPaymentQuote) { q.PrincipalWei = "750001000000001" },
		"empty amount": func(q *zkapi.AddressPaymentQuote) { q.Amount = 0 },
		"fee":          func(q *zkapi.AddressPaymentQuote) { q.FeeReserveWei = "1.5" },
		"gas":          func(q *zkapi.AddressPaymentQuote) { q.GasLimit = 1 },
		"policy":       func(q *zkapi.AddressPaymentQuote) { q.FeePolicy = "high" },
	} {
		t.Run(name, func(t *testing.T) {
			s := fundingCLITestServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				q := paymentTestQuote("deposit")
				mutate(&q)
				_ = json.NewEncoder(w).Encode(q)
			}))
			defer s.Close()
			if _, err := requestPaymentQuote(context.Background(), fundingTestConfig(s), http.MethodGet, "/admin/funding/quote", "deposit", nil); err == nil {
				t.Fatal("invalid quote was accepted")
			}
		})
	}
}

func TestPaymentQuoteShowsExactWeiShortfallAndUSDSelection(t *testing.T) {
	q := paymentTestQuote("deposit")
	q.InputMicroUSD = 2_000_001
	q.ShortfallWei, q.RecommendedTopUpWei = "1", "1000000001"
	var out bytes.Buffer
	printPaymentQuote(&out, q, "oa-chat fund")
	for _, want := range []string{"Selected USD value: $2.000001", "Required top-up: 0.000000000000000001 ETH", "Recommended top-up including buffer: 0.000000001000000001 ETH", "?value=1000000001", "--approve " + testQuoteID} {
		if !strings.Contains(out.String(), want) {
			t.Fatalf("missing exact quote quantity %q: %s", want, out.String())
		}
	}
	q.ShortfallWei = "0"
	out.Reset()
	printPaymentQuote(&out, q, "oa-chat fund")
	if !strings.Contains(out.String(), "no top-up is needed") || strings.Contains(out.String(), "Payment URI:") {
		t.Fatal("optional buffer was presented as a required payment")
	}
}

func TestFundUSDQuotePreservesExactSelectionAndDoesNotApprove(t *testing.T) {
	for _, mismatch := range []bool{false, true} {
		posts := 0
		s := fundingCLITestServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.Method == http.MethodGet {
				_ = json.NewEncoder(w).Encode(fundingTestStatus("ready"))
				return
			}
			posts++
			var body map[string]uint64
			if r.URL.Path != "/admin/funding/quote" || json.NewDecoder(r.Body).Decode(&body) != nil || len(body) != 1 || body["micro_usd"] != 1_000_001 {
				t.Error("USD quote changed intent or authorized signing")
			}
			q := paymentTestQuote("deposit")
			q.InputMicroUSD = 1_000_001
			if mismatch {
				q.InputMicroUSD++
			}
			_ = json.NewEncoder(w).Encode(q)
		}))
		err := runFunding(context.Background(), fundingTestConfig(s), []string{"--usd", "1.000001"}, &bytes.Buffer{})
		s.Close()
		if (err != nil) != mismatch || posts != 1 {
			t.Fatalf("wrong USD quote boundary: mismatch=%t posts=%d error=%v", mismatch, posts, err)
		}
	}
}

func TestFundApprovalUsesOnlyReviewedIDAndNeverRetriesAmbiguousResponse(t *testing.T) {
	for _, outcome := range []string{"active", "changed-id", "changed-principal", "lost-reply"} {
		t.Run(outcome, func(t *testing.T) {
			var posts atomic.Int32
			s := fundingCLITestServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path == "/admin/funding/quote" {
					q := paymentTestQuote("deposit")
					if outcome == "changed-id" {
						q.ID = strings.Repeat("b", 64)
					}
					_ = json.NewEncoder(w).Encode(q)
					return
				}
				state := fundingTestStatus("ready")
				if r.Method == http.MethodPost {
					posts.Add(1)
					var body map[string]string
					if r.URL.Path != "/admin/funding/approve" || json.NewDecoder(r.Body).Decode(&body) != nil || len(body) != 1 || body["quote_id"] != testQuoteID {
						t.Error("approval was not bound to the reviewed ID")
					}
					if outcome == "lost-reply" {
						conn, _, err := w.(http.Hijacker).Hijack()
						if err != nil {
							t.Error(err)
							return
						}
						_ = conn.Close()
						return
					}
					state["phase"], state["amount"] = "active", 750001
					if outcome == "changed-principal" {
						state["amount"] = 750002
					}
				}
				_ = json.NewEncoder(w).Encode(state)
			}))
			defer s.Close()
			err := runFunding(context.Background(), fundingTestConfig(s), []string{"--approve", testQuoteID}, &bytes.Buffer{})
			wantPosts := 1
			if outcome == "changed-id" {
				wantPosts = 0
			}
			if (err == nil) != (outcome == "active") || posts.Load() != int32(wantPosts) {
				t.Fatalf("approval failed safely? outcome=%s posts=%d error=%v", outcome, posts.Load(), err)
			}
			if outcome == "lost-reply" && !strings.Contains(err.Error(), "fund --resume") {
				t.Fatal("lost approval reply did not direct recovery")
			}
		})
	}
}

func TestFundRejectsExplicitEmptyAndConflictingOptionsBeforeNetwork(t *testing.T) {
	for _, args := range [][]string{{"--amount", ""}, {"--usd", ""}, {"--approve", ""}, {"--usd", "1", "--amount", "1"}, {"--resume", "--approve", testQuoteID}, {"--usd", "0.0000001"}} {
		if err := runFunding(context.Background(), configForUnreachableWallet(), args, &bytes.Buffer{}); err == nil || strings.Contains(err.Error(), "unavailable") {
			t.Fatalf("invalid arguments reached network: %q: %v", args, err)
		}
	}
}
