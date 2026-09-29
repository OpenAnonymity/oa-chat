package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/OpenAnonymity/oa-chat/daemon/internal/config"
	"github.com/OpenAnonymity/oa-chat/daemon/internal/zkapi"
)

type passwordSetupUI struct {
	startTestUI
	passwords []string
	secretErr error
}

func (p *passwordSetupUI) Secret(context.Context, string) (string, error) {
	if p.secretErr != nil {
		return "", p.secretErr
	}
	if len(p.passwords) == 0 {
		return "", errors.New("unexpected password prompt")
	}
	value := p.passwords[0]
	p.passwords = p.passwords[1:]
	return value, nil
}

func clearPasswordEnvironment(t *testing.T) {
	t.Helper()
	for _, name := range []string{"OA_ZKAPI_TESTNET_PASSWORD", "OA_ZKAPI_TESTNET_PASSWORD_FILE"} {
		t.Setenv(name, "")
		if err := os.Unsetenv(name); err != nil {
			t.Fatal(err)
		}
	}
}

func TestConfigPasswordRetriesHiddenAndSavesOnlyAcceptedValue(t *testing.T) {
	clearPasswordEnvironment(t)
	dir, c := startTestConfig(t)
	if err := config.SaveSepoliaPassword(dir, "old-password"); err != nil {
		t.Fatal(err)
	}
	ui := &passwordSetupUI{passwords: []string{"wrong-password", "accepted-password"}}
	checks := 0
	err := configureSepoliaPassword(context.Background(), dir, ui, false, func(_ context.Context, value string) error {
		checks++
		stored, err := config.SepoliaPassword(dir, "sepolia")
		if err != nil || stored != "old-password" {
			t.Fatal("password changed before authentication")
		}
		if value == "accepted-password" {
			return nil
		}
		return &zkapi.Error{Status: 401, Code: "testnet_password_required"}
	})
	if err != nil || checks != 3 {
		t.Fatalf("password recovery failed: %v, checks=%d", err, checks)
	}
	got, err := config.SepoliaPassword(dir, "sepolia")
	if err != nil || got != "accepted-password" {
		t.Fatal("accepted password was not saved")
	}
	loaded, err := config.Load(dir)
	if err != nil || loaded != c {
		t.Fatal("password recovery changed configuration")
	}
	for _, secret := range []string{"old-password", "wrong-password", "accepted-password"} {
		if strings.Contains(ui.output.String(), secret) {
			t.Fatal("password leaked into output")
		}
	}
}

func TestConfigPasswordChangeRepairsSavedFileWithoutReadingIt(t *testing.T) {
	clearPasswordEnvironment(t)
	dir, _ := startTestConfig(t)
	if err := os.WriteFile(filepath.Join(dir, config.TestnetPasswordFile), nil, 0600); err != nil {
		t.Fatal(err)
	}
	ui := &passwordSetupUI{passwords: []string{"replacement"}}
	err := configureSepoliaPassword(context.Background(), dir, ui, true, func(_ context.Context, value string) error {
		if value != "replacement" {
			t.Fatal("change tried the invalid saved password")
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if value, err := config.SepoliaPassword(dir, "sepolia"); err != nil || value != "replacement" {
		t.Fatal("password file was not repaired")
	}
}

func TestConfigPasswordCancellationAndConnectionFailurePreserveSavedValue(t *testing.T) {
	for _, failure := range []string{"cancel", "connection", "cancel-after-auth"} {
		t.Run(failure, func(t *testing.T) {
			clearPasswordEnvironment(t)
			dir, _ := startTestConfig(t)
			if err := config.SaveSepoliaPassword(dir, "saved-password"); err != nil {
				t.Fatal(err)
			}
			ui := &passwordSetupUI{passwords: []string{"new-password"}}
			if failure == "cancel" {
				ui.secretErr = context.Canceled
			}
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			err := configureSepoliaPassword(ctx, dir, ui, true, func(context.Context, string) error {
				if failure == "cancel-after-auth" {
					cancel()
					return nil
				}
				return errors.New("connection failed")
			})
			if err == nil {
				t.Fatal("failed password change succeeded")
			}
			if value, err := config.SepoliaPassword(dir, "sepolia"); err != nil || value != "saved-password" {
				t.Fatal("failed change overwrote saved password")
			}
		})
	}
}

func TestConfigPasswordOverrideIsNeitherPromptedNorSaved(t *testing.T) {
	clearPasswordEnvironment(t)
	t.Setenv("OA_ZKAPI_TESTNET_PASSWORD", "environment-password")
	dir, _ := startTestConfig(t)
	for _, change := range []bool{false, true} {
		ui := &passwordSetupUI{}
		err := configureSepoliaPassword(context.Background(), dir, ui, change, func(context.Context, string) error {
			if change {
				t.Fatal("password action checked an environment override")
			}
			return &zkapi.Error{Status: 401, Code: "testnet_password_required"}
		})
		if err == nil || !strings.Contains(err.Error(), "OA_ZKAPI_TESTNET_PASSWORD") {
			t.Fatal("missing environment override recovery guidance")
		}
		if _, err := os.Stat(filepath.Join(dir, config.TestnetPasswordFile)); !os.IsNotExist(err) {
			t.Fatal("environment password was saved")
		}
	}
}

func TestConfiguredServePasswordFailureCannotStartCompanionOrFunding(t *testing.T) {
	clearPasswordEnvironment(t)
	t.Setenv("OA_ZKAPI_TESTNET_PASSWORD", "") // Invalid locally; no network required.
	dir, c := startTestConfig(t)
	err := runConfiguredServe(context.Background(), dir, c, c, io.Discard)
	if err == nil || !strings.Contains(err.Error(), "Run oa-chat config") || !strings.Contains(err.Error(), "password") {
		t.Fatalf("serve did not return password setup guidance: %v", err)
	}
	for _, name := range []string{"daemon.lock", "funding", "zkapi"} {
		if _, err := os.Stat(filepath.Join(dir, name)); !os.IsNotExist(err) {
			t.Fatalf("serve created %s before password validation", name)
		}
	}
}

func TestHiddenPasswordPTYHelper(t *testing.T) {
	if os.Getenv("OA_TEST_SECRET_PTY") == "" {
		return
	}
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	ui := &terminalSetupPrompter{out: os.Stdout}
	defer ui.Close()
	value, err := ui.Secret(ctx, "Hidden password")
	if os.Getenv("OA_TEST_SECRET_PTY") == "cancel" {
		if !errors.Is(err, context.Canceled) {
			t.Fatal("password cancellation failed")
		}
	} else if err != nil || value != "private-test-password" {
		t.Fatal("hidden password read failed")
	}
	fmt.Println("SECRET_RESULT_OK")
}

func TestHiddenPasswordPTYDoesNotEchoAndCancels(t *testing.T) {
	python, err := exec.LookPath("python3")
	if err != nil {
		t.Skip("Python 3 is needed for PTY validation")
	}
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	const harness = `
import errno, os, pty, select, signal, sys, time, termios
pid, terminal = pty.fork()
if pid == 0:
    os.execve(sys.argv[1], [sys.argv[1], "-test.run=^TestHiddenPasswordPTYHelper$"], dict(os.environ, OA_TEST_SECRET_PTY=sys.argv[2]))
output = b""
reaped = False
try:
    deadline = time.monotonic() + 5
    while b"Hidden password: " not in output:
        if time.monotonic() > deadline: raise RuntimeError("password prompt missing")
        if select.select([terminal], [], [], .1)[0]: output += os.read(terminal, 4096)
    if termios.tcgetattr(terminal)[3] & termios.ECHO: raise RuntimeError("password echo enabled")
    os.write(terminal, b"private-test-password")
    time.sleep(.1)
    os.write(terminal, b"\x03" if sys.argv[2] == "cancel" else b"\n")
    deadline = time.monotonic() + 3
    while True:
        if select.select([terminal], [], [], .1)[0]:
            try: output += os.read(terminal, 4096)
            except OSError as e:
                if e.errno != errno.EIO: raise
        exited, status = os.waitpid(pid, os.WNOHANG)
        if exited:
            reaped = True
            break
        if time.monotonic() > deadline: raise RuntimeError("password prompt did not exit")
    if b"private-test-password" in output: raise RuntimeError("password appeared in terminal output")
    if os.waitstatus_to_exitcode(status) != 0 or b"SECRET_RESULT_OK" not in output: raise RuntimeError("password prompt failed")
    if not termios.tcgetattr(terminal)[3] & termios.ECHO: raise RuntimeError("terminal echo was not restored")
finally:
    if not reaped:
        os.kill(pid, signal.SIGKILL)
        os.waitpid(pid, 0)
    os.close(terminal)
`
	for _, action := range []string{"enter", "cancel"} {
		t.Run(action, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			if output, err := exec.CommandContext(ctx, python, "-c", harness, executable, action).CombinedOutput(); err != nil {
				t.Fatalf("hidden password PTY: %v\n%s", err, output)
			}
		})
	}
}
