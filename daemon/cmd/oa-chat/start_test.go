package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/OpenAnonymity/oa-chat/daemon/internal/config"
	"golang.org/x/sys/unix"
)

type startTestUI struct {
	mu      sync.Mutex
	answers []string
	output  strings.Builder
	ready   chan struct{}
}

func (u *startTestUI) Ask(ctx context.Context, _, _ string) (string, error) {
	if err := ctx.Err(); err != nil {
		return "", err
	}
	u.mu.Lock()
	defer u.mu.Unlock()
	if len(u.answers) == 0 {
		return "", errors.New("unexpected setup question")
	}
	answer := u.answers[0]
	u.answers = u.answers[1:]
	return answer, nil
}

func (u *startTestUI) Confirm(ctx context.Context, question string) (bool, error) {
	answer, err := u.Ask(ctx, question, "no")
	return answer == "yes", err
}

func (u *startTestUI) Printf(format string, args ...any) {
	u.mu.Lock()
	defer u.mu.Unlock()
	text := fmt.Sprintf(format, args...)
	u.output.WriteString(text)
	if strings.Contains(text, "Ready for inference.") && u.ready != nil {
		close(u.ready)
		u.ready = nil
	}
}

func startTestConfig(t *testing.T) (string, config.Config) {
	t.Helper()
	dir := filepath.Join(t.TempDir(), "private config's")
	c, err := config.Default()
	if err != nil {
		t.Fatal(err)
	}
	c.Backend, c.ZKAPI.Network = "zkapi", "sepolia"
	if err := config.Init(dir, c); err != nil {
		t.Fatal(err)
	}
	c, err = config.Load(dir)
	if err != nil {
		t.Fatal(err)
	}
	return dir, c
}

func TestGuidedStartInitializesBothModesAndOwnerCredential(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "new")
	ui := &startTestUI{answers: []string{"wrong", "sepolia"}}
	c, err := prepareStartConfig(context.Background(), dir, startOptions{}, ui)
	if err != nil {
		t.Fatal(err)
	}
	if c.Backend != "zkapi" || c.ZKAPI.Network != "sepolia" || c.ManagementToken == "" || c.ManagementToken == c.APIKey || c.OrgURL == "" {
		t.Fatal("new config is missing one mode or the separate management credential")
	}
	for name, want := range map[string]os.FileMode{"": 0700, "config.json": 0600, "management-token": 0600} {
		info, err := os.Stat(filepath.Join(dir, name))
		if err != nil || info.Mode().Perm() != want {
			t.Fatalf("%s permissions: %v, %v", name, info, err)
		}
	}
	if strings.Contains(ui.output.String(), c.APIKey) || strings.Contains(ui.output.String(), c.ManagementToken) {
		t.Fatal("setup displayed credentials")
	}
}

func TestGuidedStartReusesConfigWithoutMigration(t *testing.T) {
	dir, original := startTestConfig(t)
	before, _ := os.ReadFile(filepath.Join(dir, "config.json"))
	for _, options := range []startOptions{{}, {backend: "ticket"}, {network: "sepolia", listen: original.Listen}} {
		got, err := prepareStartConfig(context.Background(), dir, options, &startTestUI{})
		want := original
		if options.backend != "" {
			want.Backend = options.backend
		}
		if err != nil || !reflect.DeepEqual(got, want) {
			t.Fatalf("did not reuse config: %v", err)
		}
	}
	for _, options := range []startOptions{{network: "mainnet"}, {listen: "127.0.0.1:9876"}} {
		if _, err := prepareStartConfig(context.Background(), dir, options, &startTestUI{}); err == nil {
			t.Fatal("accepted mismatched saved network/listener")
		}
	}
	after, _ := os.ReadFile(filepath.Join(dir, "config.json"))
	if !bytes.Equal(before, after) {
		t.Fatal("start rewrote existing config")
	}
}

func TestGuidedStartPreservesInvalidConfigurationAndOrphanedWallets(t *testing.T) {
	for _, kind := range []string{"malformed", "symlink", "permissions", "directory", "orphan"} {
		t.Run(kind, func(t *testing.T) {
			dir := filepath.Join(t.TempDir(), "config")
			if err := os.Mkdir(dir, 0700); err != nil {
				t.Fatal(err)
			}
			path := filepath.Join(dir, "config.json")
			switch kind {
			case "malformed":
				_ = os.WriteFile(path, []byte("broken"), 0600)
			case "symlink":
				_ = os.Symlink("missing-target", path)
			case "permissions":
				_ = os.WriteFile(path, []byte("{}"), 0644)
			case "directory":
				_ = os.Mkdir(path, 0700)
			case "orphan":
				_ = os.Mkdir(filepath.Join(dir, "funding"), 0700)
			}
			before, _ := os.Lstat(path)
			if _, err := prepareStartConfig(context.Background(), dir, startOptions{network: "sepolia"}, &startTestUI{}); err == nil {
				t.Fatal("reinitialized invalid config or orphaned wallet")
			}
			after, _ := os.Lstat(path)
			if before == nil && after != nil || before != nil && (after == nil || !os.SameFile(before, after)) {
				t.Fatal("existing config was replaced")
			}
		})
	}
}

func TestGuidedStartPromptRequiresCompleteExplicitConsent(t *testing.T) {
	for _, input := range []string{"", "yes", "\n", "no\n"} {
		ui := &terminalSetupPrompter{out: io.Discard, input: bufio.NewReader(strings.NewReader(input))}
		approved, err := ui.Confirm(context.Background(), "Approve deposit")
		if approved {
			t.Fatalf("input %q unexpectedly approved spending", input)
		}
		if !strings.Contains(input, "\n") && err == nil {
			t.Fatal("EOF was accepted as an answer")
		}
	}
	ui := &terminalSetupPrompter{out: io.Discard, input: bufio.NewReader(strings.NewReader("maybe\nyes\n"))}
	approved, err := ui.Confirm(context.Background(), "Approve deposit")
	if !approved || err != nil {
		t.Fatal("explicit confirmation failed", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	ui = &terminalSetupPrompter{out: io.Discard, input: bufio.NewReader(strings.NewReader("yes\n"))}
	if approved, err := ui.Confirm(ctx, "Approve deposit"); approved || !errors.Is(err, context.Canceled) {
		t.Fatal("canceled prompt accepted consent")
	}
}

func TestGuidedStartRejectsUnsafeOrAmbiguousFlags(t *testing.T) {
	for _, args := range [][]string{{"--network", ""}, {"--network", "unknown"}, {"--backend", "both"}, {"--usd", "0"}, {"--usd", "-2"}, {"--usd", "1.0000001"}, {"--model", ""}, {"--yes"}, {"extra"}} {
		if _, err := parseStartOptions(args); err == nil {
			t.Fatalf("accepted invalid arguments %q", args)
		}
	}
}

func TestGuidedStartTerminalWaitCancelsWithoutInput(t *testing.T) {
	read, write, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	defer read.Close()
	defer write.Close()
	device := &setupTerminal{fd: int(read.Fd())}
	if err := unix.SetNonblock(device.fd, true); err != nil {
		t.Fatal(err)
	}
	ui := &terminalSetupPrompter{out: io.Discard, input: bufio.NewReader(device), device: device}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Millisecond)
	defer cancel()
	started := time.Now()
	if approved, err := ui.Confirm(ctx, "Approve deposit"); approved || !errors.Is(err, context.DeadlineExceeded) {
		t.Fatal("terminal wait ignored cancellation")
	}
	if time.Since(started) > time.Second {
		t.Fatal("terminal cancellation took too long")
	}
}

type setupWouldBlockReader struct{ calls int }

func (r *setupWouldBlockReader) Read([]byte) (int, error) {
	r.calls++
	return 0, unix.EAGAIN
}

func TestGuidedStartPromptBoundsWouldBlockRetries(t *testing.T) {
	reader := &setupWouldBlockReader{}
	ui := &terminalSetupPrompter{out: io.Discard, input: bufio.NewReader(reader)}
	ctx, cancel := context.WithTimeout(context.Background(), 160*time.Millisecond)
	defer cancel()
	if approved, err := ui.Confirm(ctx, "Approve deposit"); approved || !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("would-block input did not cancel safely: approved=%v, err=%v", approved, err)
	}
	if reader.calls < 1 || reader.calls > 10 {
		t.Fatalf("would-block input busy-spun instead of waiting: %d reads", reader.calls)
	}
}

// This helper runs in its own controlling terminal. Its stdin is deliberately
// a pipe containing "yes": only input from the terminal may grant consent.
func TestGuidedStartPromptPTYHelper(t *testing.T) {
	if os.Getenv("OA_TEST_PROMPT_PTY") != "1" {
		return
	}
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt)
	defer cancel()
	ui := &terminalSetupPrompter{out: os.Stdout}
	defer ui.Close()
	approved, err := ui.Confirm(ctx, "PTY spending confirmation")
	switch os.Getenv("OA_TEST_PROMPT_PTY_ACTION") {
	case "approve":
		if !approved || err != nil {
			t.Fatalf("terminal confirmation failed: approved=%v, err=%v", approved, err)
		}
	case "decline":
		if approved || err != nil {
			t.Fatalf("terminal refusal failed: approved=%v, err=%v", approved, err)
		}
	case "eof":
		if approved || err == nil || ctx.Err() != nil {
			t.Fatalf("terminal EOF granted consent or canceled: approved=%v, err=%v", approved, err)
		}
	default:
		if approved || !errors.Is(err, context.Canceled) {
			t.Fatalf("terminal interrupt did not cancel consent: approved=%v, err=%v", approved, err)
		}
	}
	fmt.Println("PTY_EXPECTED_RESULT")
}

func TestGuidedStartPromptPTYConsentAndCancellation(t *testing.T) {
	python, err := exec.LookPath("python3")
	if err != nil {
		t.Skip("Python 3 is needed for the real PTY regression")
	}
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	const harness = `
import errno, os, pty, select, signal, sys, time

read_fd, write_fd = os.pipe()
os.write(write_fd, b"yes\n")
os.close(write_fd)
pid, terminal = pty.fork()
if pid == 0:
    os.dup2(read_fd, 0)
    os.close(read_fd)
    env = dict(os.environ, OA_TEST_PROMPT_PTY="1", OA_TEST_PROMPT_PTY_ACTION=sys.argv[2])
    os.execve(sys.argv[1], [sys.argv[1], "-test.run=^TestGuidedStartPromptPTYHelper$"], env)
os.close(read_fd)
output = b""
status = None
reaped = False
try:
    deadline = time.monotonic() + 5
    while b"PTY spending confirmation (yes/no) [no]: " not in output:
        if time.monotonic() >= deadline:
            raise RuntimeError("terminal prompt did not appear: " + repr(output))
        if select.select([terminal], [], [], 0.1)[0]:
            output += os.read(terminal, 4096)
        exited, status = os.waitpid(pid, os.WNOHANG)
        if exited:
            reaped = True
            raise RuntimeError("prompt consumed piped consent or exited early: " + repr(output))
    if sys.argv[2] == "partial":
        os.write(terminal, b"y")
    time.sleep(0.2)
    action = {"approve": b"yes\n", "decline": b"no\n", "eof": b"\x04"}.get(sys.argv[2], b"\x03")
    os.write(terminal, action)
    deadline = time.monotonic() + 3
    while True:
        if select.select([terminal], [], [], 0.1)[0]:
            try:
                output += os.read(terminal, 4096)
            except OSError as error:
                if error.errno != errno.EIO:
                    raise
        exited, status = os.waitpid(pid, os.WNOHANG)
        if exited:
            reaped = True
            break
        if time.monotonic() >= deadline:
            raise RuntimeError("terminal action needed extra input to exit: " + repr(output))
    if os.waitstatus_to_exitcode(status) != 0 or b"PTY_EXPECTED_RESULT" not in output:
        raise RuntimeError("terminal result failed: " + repr(output))
finally:
    if not reaped:
        try:
            os.kill(pid, signal.SIGKILL)
            os.waitpid(pid, 0)
        except ProcessLookupError:
            pass
    os.close(terminal)
`
	for _, input := range []string{"empty", "partial", "approve", "decline", "eof"} {
		t.Run(input, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			command := exec.CommandContext(ctx, python, "-c", harness, executable, input)
			if output, err := command.CombinedOutput(); err != nil {
				t.Fatalf("real PTY cancellation: %v\n%s", err, output)
			}
		})
	}
}

func TestGuidedStartOnlyAttachesAuthenticatedMatchingDaemon(t *testing.T) {
	_, c := startTestConfig(t)
	for _, test := range []struct {
		name, body string
		status     int
		want       bool
	}{
		{"matching", `{"backend":"zkapi","network":"sepolia"}`, 200, true},
		{"other-mode", `{"backend":"ticket"}`, 200, false},
		{"other-network", `{"backend":"zkapi","network":"mainnet"}`, 200, false},
		{"unauthenticated", `{}`, 401, false},
		{"old-service", `{}`, 404, false},
	} {
		t.Run(test.name, func(t *testing.T) {
			s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path != "/admin/status" || r.Header.Get("Authorization") != "Bearer "+c.APIKey {
					t.Error("probe did not authenticate local status")
				}
				w.WriteHeader(test.status)
				_, _ = io.WriteString(w, test.body)
			}))
			defer s.Close()
			selected := c
			selected.Listen = strings.TrimPrefix(s.URL, "http://")
			got, err := probeSetupService(context.Background(), selected)
			if got != test.want || (err == nil) != test.want {
				t.Fatalf("attachment = %v, %v", got, err)
			}
		})
	}
}

func TestGuidedStartAttachedServiceIsNotStopped(t *testing.T) {
	dir, c := startTestConfig(t)
	ui := &startTestUI{}
	funded := false
	runtime := startRuntime{
		probe: func(context.Context, config.Config) (bool, error) { return true, nil },
		serve: func(context.Context, string, config.Config, io.Writer) error {
			t.Fatal("started an attached daemon")
			return nil
		},
		companion: func(context.Context, config.Config) error { return nil },
		fund: func(ctx context.Context, got config.Config, usd, model string, _ setupPrompter) error {
			funded = true
			if got.ManagementToken != c.ManagementToken || usd != "2" || model != "test/model" || ctx.Err() != nil {
				t.Error("funding lost setup selection or credentials")
			}
			return nil
		},
		interval: time.Millisecond, timeout: time.Second,
	}
	if err := guidedStart(context.Background(), dir, startOptions{usd: "2", model: "test/model"}, ui, io.Discard, runtime); err != nil {
		t.Fatal(err)
	}
	if !funded || !strings.Contains(ui.output.String(), "existing daemon continues running") || strings.Contains(ui.output.String(), c.APIKey) || !strings.Contains(ui.output.String(), setupExecutable()+" --config-dir "+shellQuoteSetup(dir)) {
		t.Fatal("attach readiness or safe client instructions are missing")
	}
}

func TestGuidedStartMatchesActiveModeWithoutRewritingDefault(t *testing.T) {
	dir, saved := startTestConfig(t)
	ticketSetup := false
	runtime := startRuntime{
		active: func(_ context.Context, c config.Config) (config.Config, error) { c.Backend = "ticket"; return c, nil },
		probe: func(_ context.Context, c config.Config) (bool, error) {
			if c.Backend != "ticket" {
				t.Error("did not select authenticated running mode")
			}
			return true, nil
		},
		tickets:  func(context.Context, string, config.Config, setupPrompter) error { ticketSetup = true; return nil },
		interval: time.Millisecond, timeout: time.Second,
	}
	if err := guidedStart(context.Background(), dir, startOptions{}, &startTestUI{}, io.Discard, runtime); err != nil {
		t.Fatal(err)
	}
	after, err := config.Load(dir)
	if err != nil || !ticketSetup || !reflect.DeepEqual(saved, after) {
		t.Fatal("active-mode selection changed persistent config", err)
	}
	runtime.active = func(_ context.Context, c config.Config) (config.Config, error) {
		c.ZKAPI.Network = "mainnet"
		return c, nil
	}
	if err := guidedStart(context.Background(), dir, startOptions{}, &startTestUI{}, io.Discard, runtime); err == nil {
		t.Fatal("silently switched to running daemon's other network")
	}
}

func TestGuidedTicketsRequiresAuthenticatedModelDiscovery(t *testing.T) {
	dir, c := startTestConfig(t)
	wallet, err := json.Marshal(map[string]any{"version": 1, "org_url": c.OrgURL, "active": []map[string]string{{"finalized_ticket": "local-test-ticket", "ticket_key_id": "local-test-key"}}})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "tickets.json"), wallet, 0600); err != nil {
		t.Fatal(err)
	}
	for _, response := range []string{`{"data":[{"id":"test/model"}]}`, `{"data":[]}`, `{}`, `{"data":[{"id":""}]}`} {
		t.Run(response, func(t *testing.T) {
			s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method != http.MethodGet || r.URL.Path != "/v1/models" || r.Header.Get("Authorization") != "Bearer "+c.APIKey {
					t.Error("model discovery did not use the authenticated local endpoint")
				}
				_, _ = io.WriteString(w, response)
			}))
			defer s.Close()
			selected := c
			selected.Listen = strings.TrimPrefix(s.URL, "http://")
			ui := &startTestUI{}
			err := runGuidedTickets(context.Background(), dir, selected, ui)
			if (err == nil) != strings.Contains(response, "test/model") {
				t.Fatalf("incorrect model readiness: %v", err)
			}
		})
	}
}

func TestGuidedStartOwnedDaemonRemainsForegroundAndStopsOnCancel(t *testing.T) {
	dir, _ := startTestConfig(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	ready := make(chan struct{})
	ui := &startTestUI{ready: ready}
	var serving atomic.Bool
	stopped := make(chan struct{})
	runtime := startRuntime{
		probe: func(context.Context, config.Config) (bool, error) { return serving.Load(), nil },
		serve: func(ctx context.Context, _ string, _ config.Config, out io.Writer) error {
			_, _ = io.WriteString(out, "hidden setup log")
			serving.Store(true)
			<-ctx.Done()
			close(stopped)
			return nil
		},
		companion: func(context.Context, config.Config) error { return nil },
		fund:      func(context.Context, config.Config, string, string, setupPrompter) error { return nil },
		interval:  time.Millisecond, timeout: time.Second,
	}
	var logs bytes.Buffer
	result := make(chan error, 1)
	go func() { result <- guidedStart(ctx, dir, startOptions{}, ui, &logs, runtime) }()
	select {
	case <-ready:
	case <-time.After(2 * time.Second):
		t.Fatal("setup never became ready")
	}
	select {
	case <-result:
		t.Fatal("owned service returned before cancellation")
	default:
	}
	cancel()
	if err := <-result; err != nil {
		t.Fatal(err)
	}
	select {
	case <-stopped:
	default:
		t.Fatal("owned service was not stopped")
	}
	if logs.Len() != 0 {
		t.Fatal("routine setup logs interleaved prompts")
	}
}

func TestGuidedStartReportsOwnedDaemonFailure(t *testing.T) {
	dir, _ := startTestConfig(t)
	want := errors.New("companion binary is missing")
	runtime := startRuntime{
		probe:    func(ctx context.Context, _ config.Config) (bool, error) { return false, ctx.Err() },
		serve:    func(context.Context, string, config.Config, io.Writer) error { return want },
		interval: time.Millisecond, timeout: time.Second,
	}
	if err := guidedStart(context.Background(), dir, startOptions{}, &startTestUI{}, io.Discard, runtime); !errors.Is(err, want) {
		t.Fatalf("lost daemon startup failure: %v", err)
	}
}

func TestGuidedStartWaitsForOwnedHTTPAuthenticationDuringStartup(t *testing.T) {
	dir, _ := startTestConfig(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	ready := make(chan struct{})
	ui := &startTestUI{ready: ready}
	var probes atomic.Int32
	runtime := startRuntime{
		probe: func(context.Context, config.Config) (bool, error) {
			n := probes.Add(1)
			if n == 1 {
				return false, nil
			}
			if n < 5 {
				return false, errors.New("port is bound but HTTP authentication is not ready")
			}
			return true, nil
		},
		serve:     func(ctx context.Context, _ string, _ config.Config, _ io.Writer) error { <-ctx.Done(); return nil },
		companion: func(context.Context, config.Config) error { return nil },
		fund:      func(context.Context, config.Config, string, string, setupPrompter) error { return nil },
		interval:  time.Millisecond, timeout: time.Second,
	}
	result := make(chan error, 1)
	go func() { result <- guidedStart(ctx, dir, startOptions{}, ui, io.Discard, runtime) }()
	select {
	case <-ready:
	case err := <-result:
		t.Fatalf("terminated healthy delayed startup: %v", err)
	case <-time.After(2 * time.Second):
		t.Fatal("delayed HTTP startup never became ready")
	}
	cancel()
	if err := <-result; err != nil {
		t.Fatal(err)
	}
	if probes.Load() < 5 {
		t.Fatal("did not retry HTTP readiness")
	}
}

func TestGuidedStartStopsOwnServiceOnSetupFailure(t *testing.T) {
	for _, companionReady := range []bool{true, false} {
		t.Run(fmt.Sprint(companionReady), func(t *testing.T) {
			dir, _ := startTestConfig(t)
			var serving, stopped atomic.Bool
			runtime := startRuntime{
				probe: func(context.Context, config.Config) (bool, error) { return serving.Load(), nil },
				serve: func(ctx context.Context, _ string, _ config.Config, _ io.Writer) error {
					serving.Store(true)
					<-ctx.Done()
					stopped.Store(true)
					return nil
				},
				companion: func(context.Context, config.Config) error {
					if companionReady {
						return nil
					}
					return errors.New("not ready")
				},
				fund: func(context.Context, config.Config, string, string, setupPrompter) error {
					if !companionReady {
						t.Fatal("funding ran before companion readiness")
					}
					return errors.New("funding failed")
				},
				interval: time.Millisecond, timeout: 20 * time.Millisecond,
			}
			ui := &startTestUI{}
			if err := guidedStart(context.Background(), dir, startOptions{}, ui, io.Discard, runtime); err == nil {
				t.Fatal("setup failure was hidden")
			}
			if !stopped.Load() || strings.Contains(ui.output.String(), "Ready for inference") {
				t.Fatal("failed setup left a daemon running or reported ready")
			}
		})
	}
}
