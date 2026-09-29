package main

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/OpenAnonymity/oa-chat/daemon/internal/config"
	"github.com/OpenAnonymity/oa-chat/daemon/internal/zkapi"
)

type readOnlyFundingFixture struct{ *wizardFundingFixture }

func (readOnlyFundingFixture) Address(context.Context) (zkapi.AddressFundingStatus, error) {
	panic("serve must not create a funding address")
}
func (readOnlyFundingFixture) Withdrawal(context.Context) (zkapi.AddressWithdrawalStatus, error) {
	panic("serve must not create withdrawal recovery state")
}

func TestServeReadinessDoesNotAuthorizeOrPrepareWalletOperations(t *testing.T) {
	for _, test := range []struct {
		name    string
		state   zkapi.WalletReadiness
		failure string
	}{
		{"unfunded", zkapi.WalletReadiness{}, "no private balance"},
		{"settlement", zkapi.WalletReadiness{HasNote: true, PendingRequest: true, Balance: 999999}, "awaiting settlement"},
		{"withdrawal", zkapi.WalletReadiness{HasNote: true, WithdrawalPending: true, Balance: 999999}, "withdrawal is reserved"},
		{"low balance", zkapi.WalletReadiness{HasNote: true, Balance: 1}, "below"},
		{"ready", zkapi.WalletReadiness{HasNote: true, Balance: 999999}, ""},
	} {
		t.Run(test.name, func(t *testing.T) {
			fixture := newWizardFixture()
			fixture.ready = func(int) zkapi.WalletReadiness { return test.state }
			ui := &fundingWizardUI{}
			err := configuredWalletReady(context.Background(), readOnlyFundingFixture{fixture}, ui)
			if test.failure == "" && err != nil || test.failure != "" && (err == nil || !strings.Contains(err.Error(), test.failure)) {
				t.Fatalf("unexpected readiness result: %v", err)
			}
			if fixture.quoteCalls != 0 || fixture.approveCalls != 0 || fixture.resumeCalls != 0 || ui.asks != 0 || ui.confirms != 0 {
				t.Fatal("serve attempted interactive setup or a wallet mutation")
			}
		})
	}
}

func TestServeMissingConfigurationAndTicketsPointToConfig(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "missing")
	if err := run([]string{"--config-dir", dir, "serve"}); err == nil || !strings.Contains(err.Error(), "Run oa-chat config") {
		t.Fatalf("missing configuration guidance: %v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, "config.json")); !os.IsNotExist(err) {
		t.Fatal("serve initialized configuration")
	}
	c, err := config.Default()
	if err != nil {
		t.Fatal(err)
	}
	if err := config.Init(dir, c); err != nil {
		t.Fatal(err)
	}
	if err := run([]string{"--config-dir", dir, "serve"}); err == nil || !strings.Contains(err.Error(), "Run oa-chat config") || !strings.Contains(err.Error(), "empty") {
		t.Fatalf("empty ticket guidance: %v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, "daemon.lock")); !os.IsNotExist(err) {
		t.Fatal("empty-ticket serve started the API")
	}
}

func TestConfigRuntimeReturnsAndStopsOnlyOwnedServices(t *testing.T) {
	for _, attached := range []bool{false, true} {
		t.Run(map[bool]string{false: "owned", true: "attached"}[attached], func(t *testing.T) {
			dir, c := startTestConfig(t)
			var probes atomic.Int32
			var stopped atomic.Bool
			var starts atomic.Int32
			runtime := startRuntime{
				probe:     func(context.Context, config.Config) (bool, error) { return attached || probes.Add(1) > 1, nil },
				companion: func(context.Context, config.Config) error { return nil },
				serve: func(ctx context.Context, _ string, _ config.Config, _ io.Writer) error {
					starts.Add(1)
					<-ctx.Done()
					stopped.Store(true)
					return nil
				},
				fund:     func(context.Context, config.Config, string, string, setupPrompter) error { return nil },
				interval: time.Millisecond, timeout: time.Second,
			}
			ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
			defer cancel()
			err := guidedStart(ctx, dir, startOptions{prepared: &c, setupOnly: true}, &startTestUI{}, io.Discard, runtime)
			if err != nil || ctx.Err() != nil {
				t.Fatalf("config did not finish: %v", err)
			}
			if attached && starts.Load() != 0 || !attached && (starts.Load() != 1 || !stopped.Load()) {
				t.Fatal("incorrect runtime ownership cleanup")
			}
		})
	}
}

func TestConfigRuntimeRetainsSavedModeInsteadOfAdoptingRunningMode(t *testing.T) {
	dir, c := startTestConfig(t)
	c.Backend = "ticket"
	checked := false
	runtime := startRuntime{
		active: func(context.Context, config.Config) (config.Config, error) {
			t.Fatal("config adopted active mode")
			return c, nil
		},
		probe: func(_ context.Context, got config.Config) (bool, error) {
			if got.Backend != "ticket" {
				t.Fatal("saved mode changed")
			}
			return true, nil
		},
		tickets:  func(context.Context, string, config.Config, setupPrompter) error { checked = true; return nil },
		interval: time.Millisecond, timeout: time.Second,
	}
	if err := guidedStart(context.Background(), dir, startOptions{prepared: &c, setupOnly: true}, &startTestUI{}, io.Discard, runtime); err != nil || !checked {
		t.Fatalf("saved ticket mode not checked: %v", err)
	}
}

func TestServeRejectsConfigurationChangedBeforeLock(t *testing.T) {
	dir, c := startTestConfig(t)
	c.Listen = "127.0.0.1:19876"
	var out bytes.Buffer
	err := serve(context.Background(), dir, c, &out)
	if err == nil || !strings.Contains(err.Error(), "configuration changed") {
		t.Fatalf("stale settings accepted: %v", err)
	}
}

func TestServeNeverAcceptsInteractiveConsent(t *testing.T) {
	p := noninteractiveSetup{out: io.Discard}
	if _, err := p.Ask(context.Background(), "mode", "zkapi"); err == nil {
		t.Fatal("serve asked for configuration")
	}
	if yes, err := p.Confirm(context.Background(), "deposit"); yes || err == nil {
		t.Fatal("serve allowed funding approval")
	}
}

func TestServeRejectsConcurrentSavedModeChange(t *testing.T) {
	dir, previous := startTestConfig(t)
	next := previous
	next.Backend = "ticket"
	if err := config.Update(dir, previous, next); err != nil {
		t.Fatal(err)
	}
	err := serveSnapshot(context.Background(), dir, previous, previous, io.Discard)
	if err == nil || !strings.Contains(err.Error(), "configuration changed") {
		t.Fatalf("backend-only edit was lost: %v", err)
	}
}

func TestConfigPaymentRequiresConsentAndRejectsReplacedQuote(t *testing.T) {
	for _, action := range []string{"withdraw", "return"} {
		for _, outcome := range []string{"refused", "replaced", "changed-destination", "approved"} {
			t.Run(action+"/"+outcome, func(t *testing.T) {
				kind, prefix := "withdrawal", "/admin/withdrawal"
				if action == "return" {
					kind, prefix = "return", "/admin/return"
				}
				gets, approvals := 0, 0
				s := fundingCLITestServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					if r.URL.Path == prefix+"/quote" {
						quote := paymentTestQuote(kind)
						if r.Method == http.MethodGet {
							gets++
							if outcome == "replaced" && gets >= 2 {
								quote.ID = strings.Repeat("e", 64)
							}
							if outcome == "changed-destination" {
								quote.Destination = "0x4444444444444444444444444444444444444444"
							}
						}
						_ = json.NewEncoder(w).Encode(quote)
						return
					}
					if r.URL.Path == prefix+"/approve" {
						approvals++
						var body map[string]string
						if json.NewDecoder(r.Body).Decode(&body) != nil || body["quote_id"] != testQuoteID {
							t.Error("approved something other than the displayed quote")
						}
						if kind == "withdrawal" {
							state := withdrawalTestStatus("complete")
							state["transaction_hash"] = "0x" + strings.Repeat("b", 64)
							_ = json.NewEncoder(w).Encode(state)
						} else {
							_ = json.NewEncoder(w).Encode(returnTestStatus("complete"))
						}
						return
					}
					if r.URL.Path == prefix {
						if kind == "withdrawal" {
							_ = json.NewEncoder(w).Encode(withdrawalTestStatus("ready"))
						} else {
							_ = json.NewEncoder(w).Encode(returnTestStatus("ready"))
						}
						return
					}
					t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
					http.Error(w, "unexpected", http.StatusBadRequest)
				}))
				defer s.Close()
				ui := &fundingWizardUI{answers: []string{withdrawalTestDestination}, confirmations: []bool{outcome != "refused"}}
				if action == "return" {
					ui.answers = append(ui.answers, "all")
				}
				err := configurePayment(context.Background(), withdrawalTestConfig(s), action, ui)
				if outcome == "approved" {
					if err != nil || approvals != 1 {
						t.Fatalf("approval failed: %v, posts=%d", err, approvals)
					}
				} else if err == nil || approvals != 0 {
					t.Fatalf("unsafe approval: %v, posts=%d", err, approvals)
				}
				for _, legacy := range []string{"oa-chat withdraw", "oa-chat fund", "--approve"} {
					if strings.Contains(ui.String(), legacy) {
						t.Fatalf("public payment menu exposed legacy command: %s", legacy)
					}
				}
			})
		}
	}
}

func TestReadinessSelectsAffordableModelRatherThanPreferredHigherCap(t *testing.T) {
	models := []setupModel{{ID: "openai/gpt-4.1-mini", Budget: 1_000_000}, {ID: "provider/lower-cap", Budget: 100_000}}
	model, err := selectReadinessModel(models)
	if err != nil || model.ID != "provider/lower-cap" {
		t.Fatalf("readiness forced a more expensive model: %v", err)
	}
}
