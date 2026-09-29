package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"os/signal"
	"syscall"
	"testing"
	"time"
)

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
