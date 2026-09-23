package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/OpenAnonymity/oa-chat/daemon/internal/config"
	"github.com/OpenAnonymity/oa-chat/daemon/internal/server"
	"github.com/OpenAnonymity/oa-chat/daemon/internal/zkapi"
)

const withdrawalTestDestination = "0x3333333333333333333333333333333333333333"
const withdrawalTestManagementToken = "owner-only-management-token-distinct-from-api-key"

func withdrawalTestConfig(s *httptest.Server) config.Config {
	c := fundingTestConfig(s)
	c.ManagementToken = withdrawalTestManagementToken
	return c
}

func withdrawalTestStatus(phase string) map[string]any {
	state := map[string]any{
		"address": "0x1111111111111111111111111111111111111111", "chain_id": 1,
		"token_address": "0x2222222222222222222222222222222222222222", "token_decimals": 6,
		"eth_balance": "1000000000000000", "private_balance": 99971, "amount": 99971,
		"note_id": 58, "phase": phase, "message": "Withdrawal progress saved locally.",
	}
	if phase != "ready" && phase != "no_note" {
		state["destination"] = withdrawalTestDestination
	}
	return state
}

func TestWithdrawDefaultsToReadOnlyStatus(t *testing.T) {
	requests := 0
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests++
		if r.Method != http.MethodGet || r.URL.Path != "/admin/withdrawal" || r.Header.Get("Authorization") != "Bearer "+strings.Repeat("a", 32) || r.Header.Get("X-OA-Management-Token") != withdrawalTestManagementToken {
			t.Errorf("unexpected status request: %s %s", r.Method, r.URL.Path)
		}
		_ = json.NewEncoder(w).Encode(withdrawalTestStatus("ready"))
	}))
	defer s.Close()
	var out bytes.Buffer
	if err := runWithdrawal(context.Background(), withdrawalTestConfig(s), nil, &out); err != nil {
		t.Fatal(err)
	}
	if requests != 1 {
		t.Fatal("status made additional requests")
	}
	for _, want := range []string{"Ethereum Mainnet", "0.099971 USDC", "0.001000000000000000 ETH", "withdraw --to ADDRESS", "does not authorize a transaction"} {
		if !strings.Contains(out.String(), want) {
			t.Fatalf("missing %q in %s", want, out.String())
		}
	}
}

func TestWithdrawDestinationAuthorizesFullRemainingBalance(t *testing.T) {
	var sequence []string
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		sequence = append(sequence, r.Method+" "+r.URL.Path)
		if r.Header.Get("X-OA-Management-Token") != withdrawalTestManagementToken {
			t.Error("owner credential missing from withdrawal request")
		}
		phase := "ready"
		if r.Method == http.MethodPost {
			var body map[string]any
			if json.NewDecoder(r.Body).Decode(&body) != nil || len(body) != 2 || body["destination"] != withdrawalTestDestination || body["note_id"] != float64(58) {
				t.Error("wrong withdrawal authorization")
			}
			phase = "complete"
		}
		_ = json.NewEncoder(w).Encode(withdrawalTestStatus(phase))
	}))
	defer s.Close()
	var out bytes.Buffer
	if err := runWithdrawal(context.Background(), withdrawalTestConfig(s), []string{"--to", withdrawalTestDestination}, &out); err != nil {
		t.Fatal(err)
	}
	if strings.Join(sequence, ",") != "GET /admin/withdrawal,POST /admin/withdrawal" {
		t.Fatalf("wrong sequence: %v", sequence)
	}
	for _, want := range []string{"full remaining balance", withdrawalTestDestination, "closes the private balance", "0.02 ETH per transaction", "No wallet connection is needed", "not canceled"} {
		if !strings.Contains(out.String(), want) {
			t.Fatalf("missing %q in %s", want, out.String())
		}
	}
}

func TestWithdrawSavedDestinationCannotChange(t *testing.T) {
	for _, phase := range []string{"waiting_settlement", "waiting_funds", "withdrawal_pending", "confirming", "reverted"} {
		t.Run(phase, func(t *testing.T) {
			s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method != http.MethodGet {
					t.Error("changed destination authorized progress")
				}
				_ = json.NewEncoder(w).Encode(withdrawalTestStatus(phase))
			}))
			defer s.Close()
			err := runWithdrawal(context.Background(), withdrawalTestConfig(s), []string{"--to", "0x4444444444444444444444444444444444444444"}, &bytes.Buffer{})
			if err == nil || !strings.Contains(err.Error(), "different destination") {
				t.Fatalf("changed destination accepted: %v", err)
			}
		})
	}
}

func TestWithdrawReadOnlyShowsExactSavedResumeCommand(t *testing.T) {
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			t.Error("status submitted a withdrawal")
		}
		state := withdrawalTestStatus("withdrawal_pending")
		state["transaction_hash"] = "0x" + strings.Repeat("a", 64)
		_ = json.NewEncoder(w).Encode(state)
	}))
	defer s.Close()
	var out bytes.Buffer
	if err := runWithdrawal(context.Background(), withdrawalTestConfig(s), nil, &out); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), "withdraw --to "+withdrawalTestDestination) || !strings.Contains(out.String(), "Transaction: 0x"+strings.Repeat("a", 64)) {
		t.Fatal(out.String())
	}
}

func TestWithdrawCompleteCommandDoesNotResubmit(t *testing.T) {
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			t.Error("completed withdrawal resubmitted")
		}
		_ = json.NewEncoder(w).Encode(withdrawalTestStatus("complete"))
	}))
	defer s.Close()
	if err := runWithdrawal(context.Background(), withdrawalTestConfig(s), []string{"--to", withdrawalTestDestination}, &bytes.Buffer{}); err != nil {
		t.Fatal(err)
	}
}

func TestWithdrawReadyNoteIgnoresPreviousCompletedDestination(t *testing.T) {
	posts := 0
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		state := withdrawalTestStatus("ready")
		state["destination"] = "0x4444444444444444444444444444444444444444"
		if r.Method == http.MethodPost {
			posts++
			state = withdrawalTestStatus("complete")
		}
		_ = json.NewEncoder(w).Encode(state)
	}))
	defer s.Close()
	if err := runWithdrawal(context.Background(), withdrawalTestConfig(s), []string{"--to", withdrawalTestDestination}, &bytes.Buffer{}); err != nil {
		t.Fatal(err)
	}
	if posts != 1 {
		t.Fatal("new ready note was blocked by old completed destination")
	}
}

func TestWithdrawTerminalAndWaitingStatesStopAfterOneStep(t *testing.T) {
	for _, phase := range []string{"waiting_settlement", "waiting_funds", "reverted", "recovery_required", "no_note", "ready", "unknown"} {
		t.Run(phase, func(t *testing.T) {
			posts := 0
			s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				state := withdrawalTestStatus("ready")
				if r.Method == http.MethodPost {
					posts++
					state = withdrawalTestStatus(phase)
				}
				_ = json.NewEncoder(w).Encode(state)
			}))
			defer s.Close()
			var out bytes.Buffer
			err := runWithdrawal(context.Background(), withdrawalTestConfig(s), []string{"--to", withdrawalTestDestination}, &out)
			if err == nil || posts != 1 {
				t.Fatalf("phase %s did not stop exactly once: posts=%d err=%v", phase, posts, err)
			}
			if phase == "waiting_funds" && !strings.Contains(out.String(), "Send ETH on Ethereum Mainnet") {
				t.Fatal("missing ETH guidance")
			}
			if (phase == "waiting_funds" || phase == "waiting_settlement" || phase == "reverted") && !strings.Contains(out.String(), "withdraw --to "+withdrawalTestDestination) {
				t.Fatal("missing same-destination resume instructions")
			}
		})
	}
}

func TestWithdrawBlocksUnusableInitialStates(t *testing.T) {
	for _, phase := range []string{"no_note", "recovery_required", "unknown"} {
		t.Run(phase, func(t *testing.T) {
			s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method != http.MethodGet {
					t.Error("unusable state authorized withdrawal")
				}
				_ = json.NewEncoder(w).Encode(withdrawalTestStatus(phase))
			}))
			defer s.Close()
			if err := runWithdrawal(context.Background(), withdrawalTestConfig(s), []string{"--to", withdrawalTestDestination}, &bytes.Buffer{}); err == nil {
				t.Fatal("unusable state accepted")
			}
		})
	}
}

func TestWithdrawResponseDestinationChangeStopsImmediately(t *testing.T) {
	posts := 0
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		state := withdrawalTestStatus("ready")
		if r.Method == http.MethodPost {
			posts++
			state = withdrawalTestStatus("withdrawal_pending")
			state["destination"] = "0x4444444444444444444444444444444444444444"
		}
		_ = json.NewEncoder(w).Encode(state)
	}))
	defer s.Close()
	err := runWithdrawal(context.Background(), withdrawalTestConfig(s), []string{"--to", withdrawalTestDestination}, &bytes.Buffer{})
	if err == nil || !strings.Contains(err.Error(), "different destination") || posts != 1 {
		t.Fatalf("destination mismatch was not stopped: %v", err)
	}
}

func TestWithdrawReadOnlyCancellationDoesNotSuggestAuthorizingWithdrawal(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			t.Error("unexpected mutation")
		}
		cancel()
		<-r.Context().Done()
	}))
	defer s.Close()
	err := runWithdrawal(ctx, withdrawalTestConfig(s), nil, &bytes.Buffer{})
	if !errors.Is(err, errWithdrawalWaitStopped) || strings.Contains(err.Error(), "--to") || strings.Contains(err.Error(), "unavailable") {
		t.Fatalf("bad cancellation message: %v", err)
	}
}

func TestWithdrawCancellationDuringSubmissionDoesNotClaimCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet {
			_ = json.NewEncoder(w).Encode(withdrawalTestStatus("ready"))
			return
		}
		_, _ = io.Copy(io.Discard, r.Body)
		cancel()
		<-r.Context().Done()
	}))
	defer s.Close()
	err := runWithdrawal(ctx, withdrawalTestConfig(s), []string{"--to", withdrawalTestDestination}, &bytes.Buffer{})
	if !errors.Is(err, errWithdrawalWaitStopped) || !strings.Contains(err.Error(), "may still be progressing") {
		t.Fatalf("lost interruption recovery guidance: %v", err)
	}
}

func TestWithdrawPendingWaitHonorsCancellation(t *testing.T) {
	for _, phase := range []string{"withdrawal_pending", "confirming"} {
		t.Run(phase, func(t *testing.T) {
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			var posts atomic.Int32
			s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				state := withdrawalTestStatus("ready")
				if r.Method == http.MethodPost {
					posts.Add(1)
					state = withdrawalTestStatus(phase)
				}
				_ = json.NewEncoder(w).Encode(state)
				if r.Method == http.MethodPost {
					w.(http.Flusher).Flush()
					cancel()
				}
			}))
			defer s.Close()
			err := runWithdrawal(ctx, withdrawalTestConfig(s), []string{"--to", withdrawalTestDestination}, &bytes.Buffer{})
			if !errors.Is(err, errWithdrawalWaitStopped) || posts.Load() != 1 {
				t.Fatalf("pending cancellation failed: %v, posts=%d", err, posts.Load())
			}
		})
	}
}

func TestWithdrawUncertainRequestNeverAutomaticallyRetries(t *testing.T) {
	for _, code := range []int{http.StatusUnauthorized, http.StatusForbidden, http.StatusBadGateway} {
		t.Run(http.StatusText(code), func(t *testing.T) {
			posts := 0
			s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method == http.MethodGet {
					_ = json.NewEncoder(w).Encode(withdrawalTestStatus("ready"))
					return
				}
				posts++
				w.WriteHeader(code)
				_ = json.NewEncoder(w).Encode(map[string]string{"error": "Check saved withdrawal status."})
			}))
			defer s.Close()
			if err := runWithdrawal(context.Background(), withdrawalTestConfig(s), []string{"--to", withdrawalTestDestination}, &bytes.Buffer{}); err == nil {
				t.Fatal("error reply accepted")
			}
			if posts != 1 {
				t.Fatal("uncertain request retried")
			}
		})
	}
}

func TestWithdrawInvalidOptionsAndChecksumNeverReachDaemon(t *testing.T) {
	s := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	defer s.Close()
	c := withdrawalTestConfig(s)
	c.Listen = "127.0.0.1:1"
	for _, args := range [][]string{
		{"--to", ""}, {"--to", "0x" + strings.Repeat("0", 40)}, {"--to", "0x123"}, {"--to", "0x52908400098527886e0F7030069857D2E4169EE7"}, {"--to", withdrawalTestDestination, "extra"}, {"--amount", "1"}, {"--browser"},
	} {
		if err := runWithdrawal(context.Background(), c, args, &bytes.Buffer{}); err == nil || strings.Contains(err.Error(), "local withdrawal request") {
			t.Fatalf("invalid options reached daemon: %v: %v", args, err)
		}
	}
	c.Backend = "ticket"
	if err := runWithdrawal(context.Background(), c, nil, &bytes.Buffer{}); err == nil || !strings.Contains(err.Error(), "zkapi backend") {
		t.Fatalf("ticket backend accepted: %v", err)
	}
}

func TestWithdrawRejectsMalformedStatusBeforeSubmission(t *testing.T) {
	for _, mutation := range []string{"network", "decimals", "signer", "token", "eth", "destination", "missing_destination", "transaction"} {
		t.Run(mutation, func(t *testing.T) {
			s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method != http.MethodGet {
					t.Error("malformed state authorized mutation")
				}
				state := withdrawalTestStatus("withdrawal_pending")
				switch mutation {
				case "network":
					state["chain_id"] = 11155111
				case "decimals":
					state["token_decimals"] = 18
				case "signer":
					state["address"] = "bad"
				case "token":
					state["token_address"] = "0x" + strings.Repeat("0", 40)
				case "eth":
					state["eth_balance"] = "1.2"
				case "destination":
					state["destination"] = "0x52908400098527886e0F7030069857D2E4169EE7"
				case "missing_destination":
					delete(state, "destination")
				case "transaction":
					state["transaction_hash"] = "\x1b[2J"
				}
				_ = json.NewEncoder(w).Encode(state)
			}))
			defer s.Close()
			if err := runWithdrawal(context.Background(), withdrawalTestConfig(s), []string{"--to", withdrawalTestDestination}, &bytes.Buffer{}); err == nil {
				t.Fatal("invalid response accepted")
			}
		})
	}
}

func TestWithdrawNeverFollowsManagementRedirects(t *testing.T) {
	var forwarded atomic.Int32
	target := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { forwarded.Add(1) }))
	defer target.Close()
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, target.URL, http.StatusTemporaryRedirect)
	}))
	defer s.Close()
	if err := runWithdrawal(context.Background(), withdrawalTestConfig(s), nil, &bytes.Buffer{}); err == nil {
		t.Fatal("redirect accepted")
	}
	if forwarded.Load() != 0 {
		t.Fatal("management credential followed a redirect")
	}
}

func TestWithdrawPendingContinuesOnlyTheSameSavedDestination(t *testing.T) {
	var posts atomic.Int32
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		phase := "withdrawal_pending"
		if r.Method == http.MethodPost {
			var body map[string]any
			if json.NewDecoder(r.Body).Decode(&body) != nil || len(body) != 2 || body["destination"] != withdrawalTestDestination || body["note_id"] != float64(58) {
				t.Error("poll changed the authorized destination")
			}
			if posts.Add(1) == 2 {
				phase = "complete"
			}
		}
		state := withdrawalTestStatus(phase)
		state["transaction_hash"] = "0x" + strings.Repeat("b", 64)
		_ = json.NewEncoder(w).Encode(state)
	}))
	defer s.Close()
	var out bytes.Buffer
	if err := runWithdrawal(context.Background(), withdrawalTestConfig(s), []string{"--to", withdrawalTestDestination}, &out); err != nil {
		t.Fatal(err)
	}
	if posts.Load() != 2 {
		t.Fatalf("got %d progress steps", posts.Load())
	}
	if !strings.Contains(out.String(), "complete:") {
		t.Fatal("completion was not shown")
	}
}

func TestInferenceConflictDistinguishesWithdrawalFromSettlement(t *testing.T) {
	for _, code := range []string{"withdrawal_pending", "withdrawal_conflict", "pending_settlement", "unknown"} {
		t.Run(code, func(t *testing.T) {
			bridge := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				switch r.URL.Path {
				case "/oa/v1/status":
					_ = json.NewEncoder(w).Encode(map[string]any{"bridge_version": 1, "chain_id": 1, "mode": "direct_openrouter", "require_oa_org_key_source": true})
				case "/oa/v1/lease":
					body, _ := io.ReadAll(r.Body)
					if string(body) != "{}" {
						t.Error("inference contents crossed companion boundary")
					}
					w.WriteHeader(http.StatusConflict)
					_ = json.NewEncoder(w).Encode(map[string]any{"error": map[string]string{"code": code, "message": "private diagnostics must not cross this boundary", "funding_url": "/funding"}})
				default:
					t.Error("unexpected companion path")
					w.WriteHeader(http.StatusNotFound)
				}
			}))
			defer bridge.Close()
			client, err := zkapi.New(zkapi.Config{ClientURL: bridge.URL, BridgeToken: strings.Repeat("b", 32), Network: "mainnet", HTTPClient: &http.Client{}})
			if err != nil {
				t.Fatal(err)
			}
			_, err = (zkInference{client}).Complete(context.Background(), json.RawMessage(`{"model":"test","messages":[{"role":"user","content":"private prompt"}]}`))
			var backend *server.BackendError
			if !errors.As(err, &backend) || backend.Status != 409 {
				t.Fatalf("unexpected error: %v", err)
			}
			if strings.HasPrefix(code, "withdrawal_") {
				if backend.Code != "withdrawal_pending" || !strings.Contains(backend.Message, "saved destination") || strings.Contains(backend.Message, "settling") {
					t.Fatalf("withdrawal confused with settlement: %+v", backend)
				}
			} else if backend.Code != "settlement_pending" {
				t.Fatalf("settlement regression: %+v", backend)
			}
		})
	}
}

func TestWithdrawSettlementBeforeReservationRetainsRequestedDestinationInGuidance(t *testing.T) {
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		state := withdrawalTestStatus("ready")
		if r.Method == http.MethodPost {
			state["phase"] = "waiting_settlement"
		}
		_ = json.NewEncoder(w).Encode(state)
	}))
	defer s.Close()
	var out bytes.Buffer
	err := runWithdrawal(context.Background(), withdrawalTestConfig(s), []string{"--to", withdrawalTestDestination}, &out)
	if err == nil || !strings.Contains(out.String(), "After settlement, rerun oa-chat withdraw --to "+withdrawalTestDestination) {
		t.Fatalf("lost destination guidance: %v %s", err, out.String())
	}
}

func TestWithdrawLostSubmissionReplyNeverRetriesOrClaimsNoTransaction(t *testing.T) {
	var posts atomic.Int32
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet {
			_ = json.NewEncoder(w).Encode(withdrawalTestStatus("ready"))
			return
		}
		posts.Add(1)
		_, _ = io.Copy(io.Discard, r.Body)
		connection, _, err := w.(http.Hijacker).Hijack()
		if err != nil {
			t.Error(err)
			return
		}
		_ = connection.Close()
	}))
	defer s.Close()
	err := runWithdrawal(context.Background(), withdrawalTestConfig(s), []string{"--to", withdrawalTestDestination}, &bytes.Buffer{})
	if err == nil || !strings.Contains(err.Error(), "recover saved progress") || posts.Load() != 1 {
		t.Fatalf("lost reply retried or lost recovery guidance: %v posts=%d", err, posts.Load())
	}
	if strings.Contains(err.Error(), "not submitted") || strings.Contains(err.Error(), "canceled") {
		t.Fatalf("uncertain transaction misreported: %v", err)
	}
}

func TestWithdrawExplicitRetryAuthorizesOnlyTheInitiallyObservedHash(t *testing.T) {
	t.Parallel()
	failedHash := "0x" + strings.Repeat("c", 64)
	replacementHash := "0x" + strings.Repeat("d", 64)
	var posts atomic.Int32
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		state := withdrawalTestStatus("reverted")
		state["transaction_hash"] = failedHash
		if r.Method == http.MethodPost {
			var body map[string]any
			if json.NewDecoder(r.Body).Decode(&body) != nil {
				t.Error("invalid request")
			}
			attempt := posts.Add(1)
			if attempt == 1 {
				if len(body) != 3 || body["retry_transaction_hash"] != failedHash {
					t.Error("explicit retry did not identify the exact observed failure")
				}
				state["phase"] = "withdrawal_pending"
			} else {
				if len(body) != 2 || body["retry_transaction_hash"] != nil {
					t.Error("poll inherited one-time retry authorization")
				}
				state["phase"] = "complete"
			}
			if body["destination"] != withdrawalTestDestination || body["note_id"] != float64(58) {
				t.Error("destination changed")
			}
			state["transaction_hash"] = replacementHash
		}
		_ = json.NewEncoder(w).Encode(state)
	}))
	defer s.Close()
	if err := runWithdrawal(context.Background(), withdrawalTestConfig(s), []string{"--to", withdrawalTestDestination}, &bytes.Buffer{}); err != nil {
		t.Fatal(err)
	}
	if posts.Load() != 2 {
		t.Fatalf("unexpected progress requests: %d", posts.Load())
	}
}

func TestWithdrawRevertedWithoutHashDoesNotAuthorizeRetry(t *testing.T) {
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			t.Error("missing failed hash authorized a replacement")
		}
		_ = json.NewEncoder(w).Encode(withdrawalTestStatus("reverted"))
	}))
	defer s.Close()
	err := runWithdrawal(context.Background(), withdrawalTestConfig(s), []string{"--to", withdrawalTestDestination}, &bytes.Buffer{})
	if err == nil || !strings.Contains(err.Error(), "no saved transaction hash") {
		t.Fatalf("failed hash requirement missing: %v", err)
	}
}

func TestTwoWithdrawalClientsNeverAuthorizeRetryFromConcurrentRevert(t *testing.T) {
	failedHash := "0x" + strings.Repeat("e", 64)
	initialReads := make(chan struct{})
	var reads, posts, retries atomic.Int32
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		state := withdrawalTestStatus("withdrawal_pending")
		state["transaction_hash"] = failedHash
		if r.Method == http.MethodGet {
			if reads.Add(1) == 2 {
				close(initialReads)
			}
			<-initialReads // Both commands begin before either sees the revert.
		} else {
			posts.Add(1)
			var body map[string]any
			if json.NewDecoder(r.Body).Decode(&body) != nil {
				t.Error("invalid body")
			}
			state["phase"] = "reverted"
			if body["retry_transaction_hash"] != nil {
				retries.Add(1)
				state["phase"] = "complete"
			}
		}
		_ = json.NewEncoder(w).Encode(state)
	}))
	defer s.Close()
	results := make(chan error, 2)
	for range 2 {
		go func() {
			results <- runWithdrawal(context.Background(), withdrawalTestConfig(s), []string{"--to", withdrawalTestDestination}, &bytes.Buffer{})
		}()
	}
	for range 2 {
		if err := <-results; err == nil || !strings.Contains(err.Error(), "another explicit command") {
			t.Fatalf("polling client did not stop on finalized revert: %v", err)
		}
	}
	if posts.Load() != 2 || retries.Load() != 0 {
		t.Fatalf("concurrent clients retried: requests=%d retries=%d", posts.Load(), retries.Load())
	}
}

func TestWithdrawLostRetryReplyRequiresFreshStatusAndDoesNotRepeatAuthorization(t *testing.T) {
	failedHash := "0x" + strings.Repeat("c", 64)
	replacementHash := "0x" + strings.Repeat("d", 64)
	var posts atomic.Int32
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		state := withdrawalTestStatus("reverted")
		state["transaction_hash"] = failedHash
		if posts.Load() > 0 {
			state["phase"] = "withdrawal_pending"
			state["transaction_hash"] = replacementHash
		}
		if r.Method == http.MethodPost {
			var body map[string]any
			if json.NewDecoder(r.Body).Decode(&body) != nil {
				t.Error("invalid body")
			}
			if posts.Add(1) == 1 {
				if body["retry_transaction_hash"] != failedHash {
					t.Error("missing initial retry authorization")
				}
				connection, _, err := w.(http.Hijacker).Hijack()
				if err != nil {
					t.Error(err)
					return
				}
				_ = connection.Close() // The replacement exists, but its reply is lost.
				return
			}
			if len(body) != 2 || body["retry_transaction_hash"] != nil {
				t.Error("new command reauthorized a pending replacement")
			}
			state["phase"] = "complete"
		}
		_ = json.NewEncoder(w).Encode(state)
	}))
	defer s.Close()
	args := []string{"--to", withdrawalTestDestination}
	if err := runWithdrawal(context.Background(), withdrawalTestConfig(s), args, &bytes.Buffer{}); err == nil {
		t.Fatal("lost retry response accepted")
	}
	if posts.Load() != 1 {
		t.Fatal("uncertain retry was submitted again automatically")
	}
	if err := runWithdrawal(context.Background(), withdrawalTestConfig(s), args, &bytes.Buffer{}); err != nil {
		t.Fatal(err)
	}
	if posts.Load() != 2 {
		t.Fatalf("unexpected recovery request count %d", posts.Load())
	}
}

func TestWithdrawSelectedNoteIDZeroIsExplicitlyAuthorized(t *testing.T) {
	posts := 0
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		state := withdrawalTestStatus("ready")
		state["note_id"] = 0
		if r.Method == http.MethodPost {
			posts++
			var body map[string]any
			if json.NewDecoder(r.Body).Decode(&body) != nil || len(body) != 2 || body["note_id"] != float64(0) {
				t.Error("note zero was omitted or changed")
			}
			state["phase"] = "complete"
			state["destination"] = withdrawalTestDestination
		}
		_ = json.NewEncoder(w).Encode(state)
	}))
	defer s.Close()
	if err := runWithdrawal(context.Background(), withdrawalTestConfig(s), []string{"--to", withdrawalTestDestination}, &bytes.Buffer{}); err != nil {
		t.Fatal(err)
	}
	if posts != 1 {
		t.Fatalf("unexpected requests: %d", posts)
	}
}

func TestWithdrawStaleClientDoesNotAdoptNewlyFundedNote(t *testing.T) {
	var posts atomic.Int32
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		state := withdrawalTestStatus("withdrawal_pending")
		if r.Method == http.MethodPost {
			posts.Add(1)
			var body map[string]any
			if json.NewDecoder(r.Body).Decode(&body) != nil || body["note_id"] != float64(58) {
				t.Error("request lost its original note authorization")
			}
			// Another client finished note 58 and funded note 59 while this
			// client was paused after its initial status read.
			state["note_id"] = 59
		}
		_ = json.NewEncoder(w).Encode(state)
	}))
	defer s.Close()
	err := runWithdrawal(context.Background(), withdrawalTestConfig(s), []string{"--to", withdrawalTestDestination}, &bytes.Buffer{})
	if err == nil || !strings.Contains(err.Error(), "different private note") || posts.Load() != 1 {
		t.Fatalf("stale client adopted a new note: %v posts=%d", err, posts.Load())
	}
}

func TestWithdrawConfirmationIsOneShotAndNeverAuthorizesRetry(t *testing.T) {
	t.Parallel()
	failedHash := "0x" + strings.Repeat("c", 64)
	winningHash := "0x" + strings.Repeat("d", 64)
	var posts atomic.Int32
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		state := withdrawalTestStatus("reverted")
		state["transaction_hash"] = failedHash
		if r.Method == http.MethodPost {
			var body map[string]any
			if json.NewDecoder(r.Body).Decode(&body) != nil {
				t.Error("invalid request")
			}
			if body["destination"] != withdrawalTestDestination || body["note_id"] != float64(58) {
				t.Error("confirmation lost its note or destination binding")
			}
			if body["retry_transaction_hash"] != nil {
				t.Error("confirming a receipt authorized another transaction")
			}
			if posts.Add(1) == 1 {
				if len(body) != 3 || body["confirmation_transaction_hash"] != winningHash {
					t.Error("winning transaction was not submitted exactly once")
				}
				state["phase"] = "confirming"
			} else {
				if len(body) != 2 || body["confirmation_transaction_hash"] != nil {
					t.Error("poll repeated receipt adoption")
				}
				state["phase"] = "complete"
			}
			state["transaction_hash"] = winningHash
		}
		_ = json.NewEncoder(w).Encode(state)
	}))
	defer s.Close()
	var out bytes.Buffer
	if err := runWithdrawal(context.Background(), withdrawalTestConfig(s), []string{"--to", withdrawalTestDestination, "--confirm", winningHash}, &out); err != nil {
		t.Fatal(err)
	}
	if posts.Load() != 2 {
		t.Fatalf("unexpected requests: %d", posts.Load())
	}
	if !strings.Contains(out.String(), "does not authorize another transaction") {
		t.Fatal("confirmation was described as a new withdrawal")
	}
}

func TestWithdrawInvalidConfirmationNeverReachesDaemon(t *testing.T) {
	requests := 0
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests++
		t.Error("invalid confirmation reached daemon")
	}))
	defer s.Close()
	validHash := "0x" + strings.Repeat("a", 64)
	for _, args := range [][]string{
		{"--confirm", validHash},
		{"--to", withdrawalTestDestination, "--confirm", ""},
		{"--to", withdrawalTestDestination, "--confirm", "0x1234"},
		{"--to", withdrawalTestDestination, "--confirm", "0x" + strings.Repeat("g", 64)},
		{"--to", withdrawalTestDestination, "--confirm", validHash + "\n"},
	} {
		if err := runWithdrawal(context.Background(), withdrawalTestConfig(s), args, &bytes.Buffer{}); err == nil || !strings.Contains(err.Error(), "--confirm requires") {
			t.Fatalf("invalid confirmation accepted: %v", err)
		}
	}
	if requests != 0 {
		t.Fatal("invalid input reached daemon")
	}
}

func TestWithdrawConfirmationRequiresInitialFinalizedRevert(t *testing.T) {
	for _, phase := range []string{"ready", "withdrawal_pending", "waiting_settlement", "waiting_funds", "confirming", "complete", "no_note", "recovery_required"} {
		t.Run(phase, func(t *testing.T) {
			s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method != http.MethodGet {
					t.Error("confirmation accepted before a saved finalized revert")
				}
				_ = json.NewEncoder(w).Encode(withdrawalTestStatus(phase))
			}))
			defer s.Close()
			err := runWithdrawal(context.Background(), withdrawalTestConfig(s), []string{"--to", withdrawalTestDestination, "--confirm", "0x" + strings.Repeat("a", 64)}, &bytes.Buffer{})
			if err == nil || !strings.Contains(err.Error(), "only after") {
				t.Fatalf("wrong phase permitted confirmation: %v", err)
			}
		})
	}
}

func TestWithdrawLostConfirmationReplyNeverSubmitsAgain(t *testing.T) {
	var posts atomic.Int32
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet {
			state := withdrawalTestStatus("reverted")
			state["transaction_hash"] = "0x" + strings.Repeat("a", 64)
			_ = json.NewEncoder(w).Encode(state)
			return
		}
		posts.Add(1)
		var body map[string]any
		if json.NewDecoder(r.Body).Decode(&body) != nil || body["confirmation_transaction_hash"] != "0x"+strings.Repeat("b", 64) || body["retry_transaction_hash"] != nil {
			t.Error("confirmation authorization changed")
		}
		connection, _, err := w.(http.Hijacker).Hijack()
		if err != nil {
			t.Error(err)
			return
		}
		_ = connection.Close()
	}))
	defer s.Close()
	err := runWithdrawal(context.Background(), withdrawalTestConfig(s), []string{"--to", withdrawalTestDestination, "--confirm", "0x" + strings.Repeat("b", 64)}, &bytes.Buffer{})
	if err == nil || posts.Load() != 1 {
		t.Fatalf("lost confirmation was retried: %v posts=%d", err, posts.Load())
	}
}

func TestWithdrawExactConfirmationCommandResumesAfterLostReply(t *testing.T) {
	failedHash := "0x" + strings.Repeat("a", 64)
	winningHash := "0x" + strings.Repeat("b", 64)
	var posts atomic.Int32
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		state := withdrawalTestStatus("reverted")
		state["transaction_hash"] = failedHash
		if posts.Load() > 0 {
			state["phase"] = "confirming"
			state["transaction_hash"] = winningHash
		}
		if posts.Load() > 1 {
			state["phase"] = "complete"
		}
		if r.Method == http.MethodPost {
			var body map[string]any
			if json.NewDecoder(r.Body).Decode(&body) != nil || len(body) != 3 || body["destination"] != withdrawalTestDestination || body["note_id"] != float64(58) || body["confirmation_transaction_hash"] != winningHash || body["retry_transaction_hash"] != nil {
				t.Error("resumed confirmation changed its saved evidence or authorization")
			}
			if posts.Add(1) == 1 {
				connection, _, err := w.(http.Hijacker).Hijack()
				if err != nil {
					t.Error(err)
					return
				}
				_ = connection.Close() // Evidence persisted before the reply was lost.
				return
			}
			state["phase"] = "complete"
		}
		_ = json.NewEncoder(w).Encode(state)
	}))
	defer s.Close()
	args := []string{"--to", withdrawalTestDestination, "--confirm", winningHash}
	if err := runWithdrawal(context.Background(), withdrawalTestConfig(s), args, &bytes.Buffer{}); err == nil || posts.Load() != 1 {
		t.Fatalf("lost confirmation was automatically retried: %v posts=%d", err, posts.Load())
	}
	if err := runWithdrawal(context.Background(), withdrawalTestConfig(s), args, &bytes.Buffer{}); err != nil || posts.Load() != 2 {
		t.Fatalf("exact confirmation command could not resume: %v posts=%d", err, posts.Load())
	}
	if err := runWithdrawal(context.Background(), withdrawalTestConfig(s), args, &bytes.Buffer{}); err != nil || posts.Load() != 2 {
		t.Fatalf("completed confirmation was not read-only: %v posts=%d", err, posts.Load())
	}
}

func TestWithdrawConfirmationCannotReplaceSavedEvidence(t *testing.T) {
	for _, phase := range []string{"confirming", "complete"} {
		t.Run(phase, func(t *testing.T) {
			s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method != http.MethodGet {
					t.Error("confirmation replaced saved evidence")
				}
				state := withdrawalTestStatus(phase)
				state["transaction_hash"] = "0x" + strings.Repeat("a", 64)
				_ = json.NewEncoder(w).Encode(state)
			}))
			defer s.Close()
			err := runWithdrawal(context.Background(), withdrawalTestConfig(s), []string{"--to", withdrawalTestDestination, "--confirm", "0x" + strings.Repeat("b", 64)}, &bytes.Buffer{})
			if err == nil || !strings.Contains(err.Error(), "same saved confirmation transaction") {
				t.Fatalf("different evidence permitted: %v", err)
			}
		})
	}
}
