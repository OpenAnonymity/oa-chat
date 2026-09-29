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
)

func TestConfigureNewPromptsModeAndOnlyZKAPINetwork(t *testing.T) {
	for _, test := range []struct{ name, answers, mode, network string }{
		{"defaults", "\n\n", "zkapi", "mainnet"},
		{"sepolia", "zkapi\nsepolia\n", "zkapi", "sepolia"},
		{"ticket", "ticket\n", "ticket", "mainnet"},
	} {
		t.Run(test.name, func(t *testing.T) {
			dir := filepath.Join(t.TempDir(), "private", "new")
			var output bytes.Buffer
			ui := &terminalSetupPrompter{out: &output, input: bufio.NewReader(strings.NewReader(test.answers))}
			called := false
			err := configure(context.Background(), dir, nil, ui, &output, func(_ context.Context, gotDir string, c config.Config, action string, _ setupPrompter, _ io.Writer) error {
				called = true
				if gotDir != dir || action != "setup" || c.Backend != test.mode || c.ZKAPI.Network != test.network || c.ManagementToken == "" {
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
			if test.mode == "ticket" && strings.Contains(output.String(), "Choose network") {
				t.Fatal("ticket mode asked for an ETH network")
			}
			if test.mode == "zkapi" && !strings.Contains(output.String(), "[mainnet]") {
				t.Fatal("new setup did not default to mainnet")
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
	ui := &startTestUI{answers: []string{"edit", "ticket", "127.0.0.1:9876", "direct"}}
	called := false
	err = configure(context.Background(), dir, nil, ui, io.Discard, func(_ context.Context, _ string, c config.Config, action string, _ setupPrompter, _ io.Writer) error {
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
	ui := &terminalSetupPrompter{out: &output, input: bufio.NewReader(strings.NewReader("edit\n\n\n\n\n"))}
	err := configure(context.Background(), dir, nil, ui, &output, func(_ context.Context, _ string, c config.Config, _ string, _ setupPrompter, _ io.Writer) error {
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
			err := configure(context.Background(), dir, nil, ui, io.Discard, func(_ context.Context, _ string, c config.Config, action string, _ setupPrompter, _ io.Writer) error {
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
	for _, args := range [][]string{{"--backend", "both"}, {"--network", "unknown"}, {"--listen", ""}, {"--status", "--backend", "ticket"}, {"--api-key", "--status"}, {"extra"}} {
		dir := filepath.Join(t.TempDir(), "missing")
		if err := configure(context.Background(), dir, args, &startTestUI{}, io.Discard, nil); err == nil {
			t.Fatalf("accepted invalid flags %q", args)
		}
		if _, err := os.Stat(dir); !errors.Is(err, os.ErrNotExist) {
			t.Fatal("invalid flags created state")
		}
	}
}
