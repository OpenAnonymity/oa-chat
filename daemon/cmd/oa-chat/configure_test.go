package main

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"

	"github.com/OpenAnonymity/oa-chat/daemon/internal/config"
	"github.com/OpenAnonymity/oa-chat/daemon/internal/zkapi"
)

func TestConfigureDefaultPromptsThenShowsTwentyDollarPayment(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "private")
	service := newWizardFixture()
	service.quote = func(call int, amount, usd uint64) (zkapi.AddressPaymentQuote, error) {
		q := wizardQuote()
		if call == 1 {
			if amount != 0 || usd != 20_000_000 {
				t.Fatal("default config did not quote a new $20 deposit")
			}
			q.InputMicroUSD, q.BalanceWei = usd, "0"
			q.ShortfallWei, q.RecommendedTopUpWei = q.RequiredTotalWei, q.RecommendedTotalWei
		} else if amount != q.Amount || usd != 0 {
			t.Fatal("funding refresh did not preserve the fixed ETH principal")
		}
		return q, nil
	}
	var output bytes.Buffer
	ui := &terminalSetupPrompter{out: &output, input: bufio.NewReader(strings.NewReader("\nno\n"))}
	err := configure(context.Background(), dir, nil, ui, io.Discard, func(ctx context.Context, _ string, c config.Config, action string, prompt setupPrompter, _ io.Writer) error {
		if action != "setup" || c.Backend != "zkapi" || c.ZKAPI.Network != "mainnet" || c.RelayURL != "" {
			t.Fatal("fresh config did not select Mainnet without proxying")
		}
		return guidedFunding(ctx, service, "", prompt, immediateWizardPoll)
	})
	if err == nil || !strings.Contains(err.Error(), "declined") || service.quoteCalls != 2 || service.approveCalls+service.resumeCalls != 0 {
		t.Fatal("default config did not wait for funding before declining the deposit", err)
	}
	for _, want := range []string{"Deposit amount in USD (network fees are extra) [20]:", "Selected deposit: $20", "Funding address:", "Scan with an Ethereum wallet:", "?value=750001000030000", "config --edit", "config --menu", "Receiving account balance: 0.000000000000000000 ETH", "Waiting for ETH: receiving account balance 0.000000000000000000 ETH", "Payment information updated.", "Funds available. Receiving account balance: 0.001000000000000000 ETH.", "Press Enter to continue with this deposit, or type cancel:"} {
		if !strings.Contains(output.String(), want) {
			t.Fatalf("payment display missing %q", want)
		}
	}
	if strings.Index(output.String(), "Deposit amount in USD") > strings.Index(output.String(), "Funding address:") {
		t.Fatal("payment shown before amount selection")
	}
	if strings.Index(output.String(), "Waiting for ETH:") > strings.Index(output.String(), "Funds available.") || strings.Index(output.String(), "Funds available.") > strings.Index(output.String(), "Press Enter to continue with this deposit") {
		t.Fatal("continuation prompt appeared before waiting and showing the funded balance")
	}
	for _, unwanted := range []string{"openai/gpt-4.1-mini", "request cap", "enough for", "Automatically deposit this fixed amount", "(yes/no)"} {
		if strings.Contains(output.String(), unwanted) {
			t.Fatalf("deposit setup described model affordability: %q", unwanted)
		}
	}
}

func TestConfigurePlainExistingChecksWithoutQuestionsOrChangingPreferences(t *testing.T) {
	dir, original := startTestConfig(t)
	next := original
	next.RelayURL = "wss://relay.example/"
	if err := config.Update(dir, original, next); err != nil {
		t.Fatal(err)
	}
	before, _ := os.ReadFile(filepath.Join(dir, "config.json"))
	ui := &fundingWizardUI{}
	called := false
	err := configure(context.Background(), dir, nil, ui, io.Discard, func(_ context.Context, _ string, c config.Config, action string, _ setupPrompter, _ io.Writer) error {
		called = true
		if c != next || action != "setup" {
			t.Fatal("plain config changed a saved preference")
		}
		return nil
	})
	after, _ := os.ReadFile(filepath.Join(dir, "config.json"))
	if err != nil || !called || ui.asks != 0 || !bytes.Equal(before, after) {
		t.Fatal("plain config did not check the saved profile directly", err)
	}
}

func TestConfigureNewDefaultsAndExplicitChoicesDoNotAsk(t *testing.T) {
	for _, test := range []struct {
		name, mode, network string
		args                []string
	}{
		{"defaults", "zkapi", "mainnet", nil},
		{"sepolia", "zkapi", "sepolia", []string{"--network", "sepolia"}},
		{"ticket", "ticket", "mainnet", []string{"--backend", "ticket"}},
	} {
		t.Run(test.name, func(t *testing.T) {
			dir := filepath.Join(t.TempDir(), "private", "new")
			var output bytes.Buffer
			ui := &terminalSetupPrompter{out: &output, input: bufio.NewReader(strings.NewReader(""))}
			called := false
			err := configure(context.Background(), dir, test.args, ui, &output, func(_ context.Context, gotDir string, c config.Config, action string, _ setupPrompter, _ io.Writer) error {
				called = true
				if gotDir != dir || action != "setup" || c.Backend != test.mode || c.ZKAPI.Network != test.network || c.ManagementToken == "" || c.RelayURL != "" {
					t.Fatal("wrong setup profile")
				}
				for _, secret := range []string{c.APIKey, c.ZKAPI.BridgeToken, c.ManagementToken} {
					if strings.Contains(output.String(), secret) {
						t.Fatal("configuration disclosed a credential")
					}
				}
				return nil
			})
			if err != nil || !called {
				t.Fatal("new setup did not complete", err)
			}
			if strings.Contains(output.String(), "Choose ") {
				t.Fatal("default setup asked a question before its funding action")
			}
			loaded, err := config.Load(dir)
			if err != nil || loaded.Backend != test.mode || loaded.ZKAPI.Network != test.network {
				t.Fatal("selected configuration was not persisted", err)
			}
		})
	}
}

func TestConfigureEditPreservesCredentialsAndAdvancedSettings(t *testing.T) {
	dir, original := startTestConfig(t)
	original.RelayURL, original.ZKAPI.Binary, original.ZKAPI.ProofSetupDir = "wss://relay.example/", "/custom/oa-zkapi", "/custom/proofs"
	original.ZKAPI.ExternalCompanion = true
	prior, err := config.Load(dir)
	if err != nil {
		t.Fatal(err)
	}
	if err := config.Update(dir, prior, original); err != nil {
		t.Fatal(err)
	}
	ui := &startTestUI{answers: []string{"ticket", "127.0.0.1:9876", "direct"}}
	called := false
	err = configure(context.Background(), dir, []string{"--edit"}, ui, io.Discard, func(_ context.Context, _ string, c config.Config, action string, _ setupPrompter, _ io.Writer) error {
		called = true
		want := original
		want.Backend, want.Listen, want.RelayURL = "ticket", "127.0.0.1:9876", ""
		if c != want || action != "setup" {
			t.Fatal("edit lost existing settings or selected the wrong action")
		}
		return nil
	})
	if err != nil || !called {
		t.Fatal("edit did not complete", err)
	}
	if len(ui.answers) != 0 {
		t.Fatal("edit asked unexpected questions")
	}
	loaded, err := config.Load(dir)
	if err != nil || loaded.Backend != "ticket" || loaded.ZKAPI.Network != "sepolia" || loaded.ZKAPI.Binary != original.ZKAPI.Binary || loaded.APIKey != original.APIKey || loaded.ManagementToken != original.ManagementToken {
		t.Fatal("edit did not preserve existing state", err)
	}
}

func TestConfigureFlagsEditExistingWithoutQuestions(t *testing.T) {
	dir, original := startTestConfig(t)
	ui := &startTestUI{}
	called := false
	err := configure(context.Background(), dir, []string{"--backend", "ticket", "--network", "mainnet", "--listen", "127.0.0.1:9876", "--relay-url", "", "--zkapi-binary", "/installed/oa-zkapi", "--proof-setup-dir", "/installed/proofs"}, ui, io.Discard, func(_ context.Context, _ string, c config.Config, action string, _ setupPrompter, _ io.Writer) error {
		called = true
		if action != "setup" || c.Backend != "ticket" || c.ZKAPI.Network != "mainnet" || c.Listen != "127.0.0.1:9876" || c.ZKAPI.Binary != "/installed/oa-zkapi" || c.ZKAPI.ProofSetupDir != "/installed/proofs" || c.APIKey != original.APIKey || c.ManagementToken != original.ManagementToken {
			t.Fatal("flag edits did not preserve credentials or apply settings")
		}
		return nil
	})
	if err != nil || !called {
		t.Fatal("flag edit failed", err)
	}
}

func TestConfigureEditDoesNotEchoSavedRelayCredential(t *testing.T) {
	dir, original := startTestConfig(t)
	next := original
	next.RelayURL = "wss://relay.example/?token=private-relay-credential"
	if err := config.Update(dir, original, next); err != nil {
		t.Fatal(err)
	}
	var output bytes.Buffer
	ui := &terminalSetupPrompter{out: &output, input: bufio.NewReader(strings.NewReader("\n\n\n\n"))}
	err := configure(context.Background(), dir, []string{"--edit"}, ui, &output, func(_ context.Context, _ string, c config.Config, _ string, _ setupPrompter, _ io.Writer) error {
		if c != next {
			t.Fatal("keeping saved settings changed the relay")
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(output.String(), "private-relay-credential") || strings.Contains(output.String(), "relay.example") {
		t.Fatal("edit exposed the saved relay URL")
	}
}

func TestConfigureStatusAndExplicitKeyNeverStartService(t *testing.T) {
	for _, exists := range []bool{false, true} {
		t.Run(map[bool]string{false: "missing", true: "existing"}[exists], func(t *testing.T) {
			dir := filepath.Join(t.TempDir(), "private")
			var c config.Config
			if exists {
				dir, c = startTestConfig(t)
			}
			var output bytes.Buffer
			ui := &terminalSetupPrompter{out: &output}
			never := func(context.Context, string, config.Config, string, setupPrompter, io.Writer) error {
				t.Fatal("status or API key started a service")
				return nil
			}
			if err := configure(context.Background(), dir, []string{"--status"}, ui, &output, never); err != nil {
				t.Fatal(err)
			}
			if exists && strings.Contains(output.String(), c.APIKey) {
				t.Fatal("status printed API key")
			}
			if !exists {
				info, err := os.Stat(dir)
				if err != nil || info.Mode().Perm() != 0700 {
					t.Fatal("status did not create private directory")
				}
				if _, err := os.Stat(filepath.Join(dir, "config.json")); !errors.Is(err, os.ErrNotExist) {
					t.Fatal("status initialized configuration")
				}
			}
			output.Reset()
			err := configure(context.Background(), dir, []string{"--api-key"}, ui, &output, never)
			if exists && (err != nil || output.String() != c.APIKey+"\n") {
				t.Fatal("explicit key output is not usable")
			}
			if !exists && err == nil {
				t.Fatal("missing profile produced an API key")
			}
		})
	}
}

func TestConfigureMenuActionsAndNoOpCheck(t *testing.T) {
	for _, choice := range []string{"check", "tickets", "withdraw", "return", "quit"} {
		t.Run(choice, func(t *testing.T) {
			dir, original := startTestConfig(t)
			before, _ := os.ReadFile(filepath.Join(dir, "config.json"))
			called := false
			ui := &startTestUI{answers: []string{choice}}
			err := configure(context.Background(), dir, []string{"--menu"}, ui, io.Discard, func(_ context.Context, _ string, c config.Config, action string, _ setupPrompter, _ io.Writer) error {
				called = true
				want := choice
				if choice == "check" {
					want = "setup"
				}
				if action != want || c != original {
					t.Fatal("wrong menu action or changed profile")
				}
				return nil
			})
			if err != nil || called != (choice != "quit") {
				t.Fatal("menu dispatch failed", err)
			}
			after, _ := os.ReadFile(filepath.Join(dir, "config.json"))
			if !bytes.Equal(before, after) {
				t.Fatal("menu action rewrote configuration")
			}
			if !strings.Contains(ui.output.String(), "Wallet menu") || strings.Contains(ui.output.String(), "OpenAI base URL") || strings.Contains(ui.output.String(), "Ephemeral key reuse") || strings.Contains(ui.output.String(), "Wallet actions:") {
				t.Fatal("wallet menu repeated the full configuration banner", ui.output.String())
			}
		})
	}
}

func TestConfigureRefusesActiveEditsAndPreservesUnsafeProfiles(t *testing.T) {
	t.Run("active", func(t *testing.T) {
		dir, _ := startTestConfig(t)
		lock, err := os.OpenFile(filepath.Join(dir, "daemon.lock"), os.O_CREATE|os.O_RDWR, 0600)
		if err != nil {
			t.Fatal(err)
		}
		defer lock.Close()
		if err := syscall.Flock(int(lock.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
			t.Fatal(err)
		}
		defer syscall.Flock(int(lock.Fd()), syscall.LOCK_UN)
		before, _ := os.ReadFile(filepath.Join(dir, "config.json"))
		err = configure(context.Background(), dir, []string{"--backend", "ticket"}, &startTestUI{}, io.Discard, func(context.Context, string, config.Config, string, setupPrompter, io.Writer) error {
			t.Fatal("active edit started setup")
			return nil
		})
		if err == nil || !strings.Contains(err.Error(), "stop oa-chat serve") {
			t.Fatal("active edit accepted", err)
		}
		after, _ := os.ReadFile(filepath.Join(dir, "config.json"))
		if !bytes.Equal(before, after) {
			t.Fatal("rejected edit changed profile")
		}
	})
	for _, kind := range []string{"malformed", "symlink", "public", "orphan"} {
		t.Run(kind, func(t *testing.T) {
			dir := filepath.Join(t.TempDir(), "private")
			if err := os.Mkdir(dir, 0700); err != nil {
				t.Fatal(err)
			}
			path := filepath.Join(dir, "config.json")
			switch kind {
			case "malformed":
				_ = os.WriteFile(path, []byte("malformed"), 0600)
			case "symlink":
				_ = os.Symlink("missing", path)
			case "public":
				_ = os.WriteFile(path, []byte("{}"), 0644)
			case "orphan":
				_ = os.Mkdir(filepath.Join(dir, "funding"), 0700)
			}
			before, _ := os.Lstat(path)
			err := configure(context.Background(), dir, []string{"--network", "sepolia"}, &startTestUI{}, io.Discard, func(context.Context, string, config.Config, string, setupPrompter, io.Writer) error {
				t.Fatal("unsafe profile started setup")
				return nil
			})
			if err == nil {
				t.Fatal("unsafe profile was replaced")
			}
			after, _ := os.Lstat(path)
			if before == nil && after != nil || before != nil && (after == nil || !os.SameFile(before, after)) {
				t.Fatal("unsafe profile was modified")
			}
		})
	}
}

func TestConfigureCancellationDoesNotWriteEdits(t *testing.T) {
	dir, _ := startTestConfig(t)
	before, _ := os.ReadFile(filepath.Join(dir, "config.json"))
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := configure(ctx, dir, []string{"--backend", "ticket"}, &startTestUI{}, io.Discard, nil); !errors.Is(err, context.Canceled) {
		t.Fatal("canceled configure did not stop", err)
	}
	after, _ := os.ReadFile(filepath.Join(dir, "config.json"))
	if !bytes.Equal(before, after) {
		t.Fatal("cancellation changed configuration")
	}
}

func TestConfigureRejectsInvalidFlagsBeforeCreatingState(t *testing.T) {
	for _, args := range [][]string{{"--backend", "both"}, {"--network", "unknown"}, {"--listen", ""}, {"--status", "--backend", "ticket"}, {"--api-key", "--status"}, {"extra"}, {"--edit", "--menu"}, {"--menu", "--network", "sepolia"}, {"--edit", "--usd", "20"}, {"--usd", "0"}, {"--usd", ""}, {"--usd", "1.0000001"}, {"--usd", "2", "--backend", "ticket"}} {
		dir := filepath.Join(t.TempDir(), "missing")
		if err := configure(context.Background(), dir, args, &startTestUI{}, io.Discard, nil); err == nil {
			t.Fatalf("accepted invalid flags %q", args)
		}
		if _, err := os.Stat(dir); !errors.Is(err, os.ErrNotExist) {
			t.Fatal("invalid flags created state")
		}
	}
}

func TestConfigureAdvertisesPasswordActionOnlyForSepoliaZKAPI(t *testing.T) {
	for _, mode := range []string{"zkapi", "ticket"} {
		for _, network := range []string{"sepolia", "mainnet"} {
			t.Run(mode+"/"+network, func(t *testing.T) {
				dir, previous := startTestConfig(t)
				c := previous
				c.Backend, c.ZKAPI.Network = mode, network
				if err := config.Update(dir, previous, c); err != nil {
					t.Fatal(err)
				}
				eligible := mode == "zkapi" && network == "sepolia"
				answer := "quit\n"
				if eligible {
					answer = "password\n"
				}
				var output bytes.Buffer
				ui := &terminalSetupPrompter{out: &output, input: bufio.NewReader(strings.NewReader(answer))}
				called := false
				err := configure(context.Background(), dir, []string{"--menu"}, ui, &output, func(_ context.Context, _ string, got config.Config, action string, _ setupPrompter, _ io.Writer) error {
					called = true
					if !eligible || got != c || action != "password" {
						t.Fatal("password menu changed settings or dispatched the wrong action")
					}
					return nil
				})
				if err != nil || called != eligible || strings.Contains(output.String(), "password,") != eligible {
					t.Fatalf("incorrect password menu for %s/%s: %v", mode, network, err)
				}
			})
		}
	}
}

func TestConfigureProductionPasswordMenuDoesNotEnterFunding(t *testing.T) {
	clearPasswordEnvironment(t)
	t.Setenv("OA_ZKAPI_TESTNET_PASSWORD", "test-environment-override")
	dir, _ := startTestConfig(t)
	ui := &fundingWizardUI{answers: []string{"password"}}
	err := configure(context.Background(), dir, []string{"--menu"}, ui, io.Discard, nil)
	if err == nil || !strings.Contains(err.Error(), "overridden by the environment") || ui.confirms != 0 || ui.asks != 1 {
		t.Fatal("production password action entered setup or bypassed password handling", err)
	}
	for _, name := range []string{"daemon.lock", "funding", "zkapi"} {
		if _, err := os.Stat(filepath.Join(dir, name)); !os.IsNotExist(err) {
			t.Fatalf("password menu unexpectedly created %s", name)
		}
	}
}

func TestConfigureAPIKeyRequirementCanBeEnabledAndDisabled(t *testing.T) {
	dir, original := startTestConfig(t)
	for _, require := range []bool{true, false} {
		args := []string{"--require-api-key"}
		if !require {
			args[0] += "=false"
		}
		ui := &fundingWizardUI{}
		err := configure(context.Background(), dir, args, ui, io.Discard, func(_ context.Context, _ string, c config.Config, _ string, _ setupPrompter, _ io.Writer) error {
			if c.RequireAPIKey != require || c.APIKey != original.APIKey || c.ManagementToken != original.ManagementToken {
				t.Fatal("authentication edit lost owner credentials or ignored the option")
			}
			return nil
		})
		if err != nil {
			t.Fatal(err)
		}
		saved, err := config.Load(dir)
		if err != nil || saved.RequireAPIKey != require {
			t.Fatal("authentication preference was not saved", err)
		}
		if strings.Contains(ui.String(), dir) || strings.Contains(ui.String(), original.APIKey) {
			t.Fatal("normal configuration output revealed private paths or credentials")
		}
	}
}

func TestConfigureOutputHidesProfilePaths(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "private-profile-unique")
	for _, args := range [][]string{{"--status"}, nil, {"--status"}} {
		ui := &fundingWizardUI{}
		err := configure(context.Background(), dir, args, ui, io.Discard, func(context.Context, string, config.Config, string, setupPrompter, io.Writer) error { return nil })
		if err != nil {
			t.Fatal(err)
		}
		if strings.Contains(ui.String(), dir) || strings.Contains(ui.String(), "private-profile-unique") {
			t.Fatal("configuration display leaked a filesystem path")
		}
	}
}

func TestConfigureKeyReuseWindowPersistsAndWiresBothBackends(t *testing.T) {
	dir, original := startTestConfig(t)
	for _, value := range []string{"15", "0", "300"} {
		ui := &fundingWizardUI{}
		var selected config.Config
		err := configure(context.Background(), dir, []string{"--key-reuse-window-seconds", value}, ui, io.Discard, func(_ context.Context, _ string, c config.Config, _ string, _ setupPrompter, _ io.Writer) error {
			selected = c
			return nil
		})
		if err != nil {
			t.Fatal(err)
		}
		loaded, err := config.Load(dir)
		if err != nil || loaded != selected || loaded.APIKey != original.APIKey {
			t.Fatal("window setting did not persist without changing credentials", err)
		}
		if zkConfig(loaded, nil).KeyReuseWindow.Seconds() != float64(loaded.KeyReuseWindowSeconds) {
			t.Fatal("zkAPI did not receive reuse setting")
		}
	}
	for _, value := range []string{"-1", "301", "invalid"} {
		if _, err := parseConfigureOptions([]string{"--key-reuse-window-seconds", value}, io.Discard); err == nil {
			t.Fatal("invalid window accepted", value)
		}
	}
}
