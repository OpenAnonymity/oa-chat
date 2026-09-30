package main

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"os/signal"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestTerminalContinueRequiresCompleteAnswer(t *testing.T) {
	for _, test := range []struct {
		name, input string
		approved    bool
		wantError   bool
	}{
		{name: "enter", input: "\n", approved: true},
		{name: "cancel", input: "cancel\n"},
		{name: "no", input: "no\n"},
		{name: "n", input: "N\n"},
		{name: "retry", input: "yes\nmaybe\n\n", approved: true},
		{name: "empty EOF", wantError: true},
		{name: "partial EOF", input: "cancel", wantError: true},
	} {
		t.Run(test.name, func(t *testing.T) {
			var output strings.Builder
			ui := &terminalSetupPrompter{out: &output, input: bufio.NewReader(strings.NewReader(test.input))}
			approved, err := ui.Continue(context.Background(), "Continue deposit")
			if approved != test.approved || (err != nil) != test.wantError {
				t.Fatalf("approved=%v, err=%v", approved, err)
			}
			if test.name == "retry" && strings.Count(output.String(), "Continue deposit: ") != 3 {
				t.Fatal("unrecognized answers did not repeat the question")
			}
		})
	}
}

func TestTerminalContinueCancellationAndFlushFailureCannotApprove(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	ui := &terminalSetupPrompter{out: io.Discard, input: bufio.NewReader(strings.NewReader("\n"))}
	if approved, err := ui.Continue(ctx, "Continue"); approved || !errors.Is(err, context.Canceled) {
		t.Fatalf("canceled context approved=%v, err=%v", approved, err)
	}
	reader, writer, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close()
	defer writer.Close()
	var output strings.Builder
	device := &setupTerminal{fd: int(reader.Fd())}
	ui = &terminalSetupPrompter{out: &output, input: bufio.NewReader(device), device: device}
	if approved, err := ui.Continue(context.Background(), "Continue"); approved || err == nil || output.Len() != 0 {
		t.Fatalf("failed terminal flush approved=%v, err=%v, output=%q", approved, err, output.String())
	}
	noninteractive := &noninteractiveSetup{out: io.Discard}
	if approved, err := noninteractive.Continue(context.Background(), "Continue"); approved || err == nil {
		t.Fatalf("noninteractive prompt approved=%v, err=%v", approved, err)
	}
}

// Only the PTY harness below starts this helper. Standard input deliberately
// contains a piped Enter; production prompts must read the controlling terminal.
func TestTerminalContinuePTYHelper(t *testing.T) {
	if os.Getenv("OA_TEST_CONTINUE_PTY") != "1" {
		return
	}
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt)
	defer cancel()
	action := os.Getenv("OA_TEST_CONTINUE_PTY_ACTION")
	ui := &terminalSetupPrompter{out: os.Stdout}
	defer ui.Close()
	if action == "queued" {
		if answer, err := ui.Ask(ctx, "PTY prime reader", ""); err != nil || answer != "ready" {
			t.Fatalf("reader priming failed: %q, %v", answer, err)
		}
		if queued, err := ui.input.Peek(1); err != nil || string(queued) != "\n" {
			t.Fatalf("Enter not buffered before Continue: %q, %v", queued, err)
		}
		fmt.Println("PTY_BUFFERED_ENTER")
		fd, err := strconv.Atoi(os.Getenv("OA_TEST_CONTINUE_GATE_FD"))
		if err != nil {
			t.Fatal(err)
		}
		gate := os.NewFile(uintptr(fd), "queued-input-gate")
		defer gate.Close()
		if _, err := io.ReadFull(gate, make([]byte, 1)); err != nil {
			t.Fatal(err)
		}
	}
	if action == "timeout" {
		var stop context.CancelFunc
		ctx, stop = context.WithTimeout(ctx, 500*time.Millisecond)
		defer stop()
	}
	approved, err := ui.Continue(ctx, "PTY Enter to continue")
	switch action {
	case "approve", "queued":
		if !approved || err != nil {
			t.Fatalf("terminal Enter approved=%v, err=%v", approved, err)
		}
	case "cancel":
		if approved || err != nil {
			t.Fatalf("terminal cancel approved=%v, err=%v", approved, err)
		}
	case "eof":
		if approved || err == nil || ctx.Err() != nil {
			t.Fatalf("terminal EOF approved=%v, err=%v", approved, err)
		}
	case "timeout":
		if approved || !errors.Is(err, context.DeadlineExceeded) {
			t.Fatalf("terminal timeout approved=%v, err=%v", approved, err)
		}
	default:
		if approved || !errors.Is(err, context.Canceled) {
			t.Fatalf("terminal interrupt approved=%v, err=%v", approved, err)
		}
	}
	fmt.Println("PTY_EXPECTED_CONTINUE_RESULT")
}

func TestTerminalContinuePTYFreshInputAndCancellation(t *testing.T) {
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
os.write(write_fd, b"\n")
os.close(write_fd)
gate_read, gate_write = os.pipe()
os.set_inheritable(gate_read, True)
pid, terminal = pty.fork()
if pid == 0:
    os.close(gate_write)
    os.dup2(read_fd, 0)
    os.close(read_fd)
    env = dict(os.environ, OA_TEST_CONTINUE_PTY="1", OA_TEST_CONTINUE_PTY_ACTION=sys.argv[2], OA_TEST_CONTINUE_GATE_FD=str(gate_read))
    os.execve(sys.argv[1], [sys.argv[1], "-test.run=^TestTerminalContinuePTYHelper$"], env)
os.close(read_fd)
os.close(gate_read)
output = b""
reaped = False

def read_output():
    global output
    if select.select([terminal], [], [], 0.05)[0]:
        try:
            output += os.read(terminal, 4096)
        except OSError as error:
            if error.errno != errno.EIO:
                raise

def wait_for(marker):
    global reaped
    deadline = time.monotonic() + 5
    while marker not in output:
        read_output()
        exited, status = os.waitpid(pid, os.WNOHANG)
        if exited:
            reaped = True
            raise RuntimeError("prompt exited early: " + repr(output))
        if time.monotonic() >= deadline:
            raise RuntimeError("prompt did not appear: " + repr(output))

try:
    if sys.argv[2] == "queued":
        wait_for(b"PTY prime reader: ")
        os.write(terminal, b"ready\n\n")
        wait_for(b"PTY_BUFFERED_ENTER")
        os.write(terminal, b"\n")
        os.write(gate_write, b"x")
    wait_for(b"PTY Enter to continue: ")
    deadline = time.monotonic() + 0.2
    while time.monotonic() < deadline:
        read_output()
        exited, status = os.waitpid(pid, os.WNOHANG)
        if exited:
            reaped = True
            raise RuntimeError("pretyped or piped Enter granted consent: " + repr(output))
        if b"PTY_EXPECTED_CONTINUE_RESULT" in output:
            raise RuntimeError("pretyped or piped Enter granted consent: " + repr(output))
    action = {"approve": b"\n", "queued": b"\n", "cancel": b"cancel\n", "eof": b"\x04", "interrupt": b"\x03"}.get(sys.argv[2])
    if action is not None:
        os.write(terminal, action)
    deadline = time.monotonic() + 3
    while True:
        read_output()
        exited, status = os.waitpid(pid, os.WNOHANG)
        if exited:
            reaped = True
            break
        if time.monotonic() >= deadline:
            raise RuntimeError("terminal action needed extra input to exit: " + repr(output))
    if os.waitstatus_to_exitcode(status) != 0 or b"PTY_EXPECTED_CONTINUE_RESULT" not in output:
        raise RuntimeError("terminal result failed: " + repr(output))
finally:
    if not reaped:
        try:
            os.kill(pid, signal.SIGKILL)
            os.waitpid(pid, 0)
        except ProcessLookupError:
            pass
    os.close(gate_write)
    os.close(terminal)
`
	for _, action := range []string{"approve", "queued", "cancel", "eof", "interrupt", "timeout"} {
		t.Run(action, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			command := exec.CommandContext(ctx, python, "-c", harness, executable, action)
			if output, err := command.CombinedOutput(); err != nil {
				t.Fatalf("real PTY continuation: %v\n%s", err, output)
			}
		})
	}
}
