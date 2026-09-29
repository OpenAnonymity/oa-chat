package main

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"
)

func returnTestStatus(phase string) map[string]any {
	return map[string]any{"address": "0x1111111111111111111111111111111111111111", "chain_id": 1, "eth_balance": "1000000000000000", "phase": phase, "destination": withdrawalTestDestination, "amount_wei": "750001000000000", "transaction_hash": "0x" + strings.Repeat("b", 64), "message": "Saved public return."}
}

func TestPublicReturnQuotesExactWeiWithoutApproval(t *testing.T) {
	posts := 0
	s := fundingCLITestServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		posts++
		var body map[string]string
		if r.Method != http.MethodPost || r.URL.Path != "/admin/return/quote" || json.NewDecoder(r.Body).Decode(&body) != nil || body["destination"] != withdrawalTestDestination || body["amount_wei"] != "1" {
			t.Error("one-wei quote changed intent or signed")
		}
		q := paymentTestQuote("return")
		q.PrincipalWei = "1"
		_ = json.NewEncoder(w).Encode(q)
	}))
	defer s.Close()
	var out bytes.Buffer
	if err := runFunding(context.Background(), fundingTestConfig(s), []string{"return", "--to", withdrawalTestDestination, "--amount", "0.000000000000000001"}, &out); err != nil {
		t.Fatal(err)
	}
	if posts != 1 || !strings.Contains(out.String(), "Fixed amount: 0.000000000000000001 ETH") {
		t.Fatal("return did not preserve exact wei", out.String())
	}
}

func TestPublicReturnApprovalAndResumeRetainAmountAndRecipient(t *testing.T) {
	for _, mode := range []string{"approve", "resume"} {
		for _, mutation := range []string{"", "destination", "amount"} {
			t.Run(mode+"/"+mutation, func(t *testing.T) {
				var sequence []string
				s := fundingCLITestServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					sequence = append(sequence, r.Method+" "+r.URL.Path)
					if r.URL.Path == "/admin/return/quote" {
						_ = json.NewEncoder(w).Encode(paymentTestQuote("return"))
						return
					}
					state := returnTestStatus("return_pending")
					if r.Method == http.MethodPost {
						state["phase"] = "complete"
						if mode == "approve" {
							var body map[string]string
							if json.NewDecoder(r.Body).Decode(&body) != nil || len(body) != 1 || body["quote_id"] != testQuoteID {
								t.Error("return lost quote-ID authorization")
							}
						}
						if mutation == "destination" {
							state["destination"] = "0x4444444444444444444444444444444444444444"
						}
						if mutation == "amount" {
							state["amount_wei"] = "750001000000001"
						}
					}
					_ = json.NewEncoder(w).Encode(state)
				}))
				defer s.Close()
				args := []string{"--resume"}
				if mode == "approve" {
					args = []string{"--approve", testQuoteID}
				}
				err := runPublicReturn(context.Background(), fundingTestConfig(s), args, &bytes.Buffer{})
				if (err != nil) != (mutation != "") || len(sequence) != 2 {
					t.Fatalf("return binding: %v %v", sequence, err)
				}
				want := "GET /admin/return"
				if mode == "approve" {
					want += "/quote"
				}
				if sequence[0] != want {
					t.Fatal("approval/resume did not read saved intent first", sequence)
				}
			})
		}
	}
}

func TestPublicReturnResumeNeverSignsAnUnsignedIntent(t *testing.T) {
	for _, phase := range []string{"ready", "quoted", "reverted", "complete"} {
		t.Run(phase, func(t *testing.T) {
			s := fundingCLITestServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method != http.MethodGet {
					t.Error("resume mutated unsigned/completed intent")
				}
				_ = json.NewEncoder(w).Encode(returnTestStatus(phase))
			}))
			defer s.Close()
			err := runPublicReturn(context.Background(), fundingTestConfig(s), []string{"--resume"}, &bytes.Buffer{})
			if (err == nil) != (phase == "complete") {
				t.Fatalf("unsafe resume for %s: %v", phase, err)
			}
		})
	}
}

func TestPublicReturnLostApprovalReplyDoesNotRetry(t *testing.T) {
	var posts atomic.Int32
	s := fundingCLITestServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet {
			_ = json.NewEncoder(w).Encode(paymentTestQuote("return"))
			return
		}
		posts.Add(1)
		connection, _, err := w.(http.Hijacker).Hijack()
		if err != nil {
			t.Error(err)
			return
		}
		_ = connection.Close()
	}))
	defer s.Close()
	err := runPublicReturn(context.Background(), fundingTestConfig(s), []string{"--approve", testQuoteID}, &bytes.Buffer{})
	if err == nil || posts.Load() != 1 || !strings.Contains(err.Error(), "fund return --resume") {
		t.Fatalf("lost reply recovery guidance/retry: posts=%d error=%v", posts.Load(), err)
	}
}

func TestPublicReturnParsingAndInvalidOptionsNeverReachDaemon(t *testing.T) {
	for value, want := range map[string]string{"0.000000000000000001": "1", "1.000000000000000001": "1000000000000000001"} {
		if got, err := parseReturnAmount(value); err != nil || got != want {
			t.Fatalf("exact return amount %s: %s %v", value, got, err)
		}
	}
	for _, args := range [][]string{{"--to", ""}, {"--amount", "1"}, {"--approve", ""}, {"--to", withdrawalTestDestination, "--amount", ""}, {"--to", withdrawalTestDestination, "--amount", "0.0000000000000000001"}, {"--resume", "--approve", testQuoteID}, {"--to", withdrawalTestDestination, "--resume"}} {
		if err := runPublicReturn(context.Background(), configForUnreachableWallet(), args, &bytes.Buffer{}); err == nil || strings.Contains(err.Error(), "unavailable") {
			t.Fatalf("invalid return input reached network: %v %v", args, err)
		}
	}
}

func TestWithdrawalResumeOnlyRecoversSignedState(t *testing.T) {
	for _, phase := range []string{"ready", "quoted", "waiting_funds", "reverted", "withdrawal_pending", "confirming", "complete"} {
		t.Run(phase, func(t *testing.T) {
			posts := 0
			s := fundingCLITestServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				state := withdrawalTestStatus(phase)
				state["transaction_hash"] = "0x" + strings.Repeat("b", 64)
				if r.Method == http.MethodPost {
					posts++
					var body map[string]any
					if r.URL.Path != "/admin/withdrawal" || json.NewDecoder(r.Body).Decode(&body) != nil || len(body) != 2 || body["note_id"] != float64(58) || body["destination"] != withdrawalTestDestination {
						t.Error("resume changed authorized state or requested signing")
					}
					state["phase"] = "complete"
				}
				_ = json.NewEncoder(w).Encode(state)
			}))
			defer s.Close()
			err := runWithdrawal(context.Background(), fundingTestConfig(s), []string{"--resume"}, &bytes.Buffer{})
			wantPosts := 0
			if phase == "withdrawal_pending" || phase == "confirming" {
				wantPosts = 1
			}
			if (err == nil) != (wantPosts == 1 || phase == "complete") || posts != wantPosts {
				t.Fatalf("resume %s: posts=%d err=%v", phase, posts, err)
			}
		})
	}
}
