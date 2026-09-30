package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/OpenAnonymity/oa-chat/daemon/internal/config"
)

type readinessTicketCounter func(context.Context) (int, error)

func (f readinessTicketCounter) CountContext(ctx context.Context) (int, error) { return f(ctx) }

type readinessWalletReader func(context.Context) (json.RawMessage, error)

func (f readinessWalletReader) WalletStatus(ctx context.Context) (json.RawMessage, error) {
	return f(ctx)
}

func TestTicketReadinessReportsOnlyAggregateState(t *testing.T) {
	for _, test := range []struct {
		name  string
		count int
		err   error
		want  string
	}{
		{name: "empty", want: "Ticket wallet: 0 tickets; run oa-chat config to import or redeem tickets"},
		{name: "available", count: 12, want: "Ticket wallet: 12 tickets available"},
		{name: "error", count: 12, err: errors.New("secret finalized_ticket and /private/wallet/path"), want: "Ticket wallet unavailable or busy; run oa-chat config to check"},
	} {
		t.Run(test.name, func(t *testing.T) {
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			read := ticketReadiness(readinessTicketCounter(func(got context.Context) (int, error) {
				if got != ctx {
					t.Fatal("wallet did not receive the bounded polling context")
				}
				return test.count, test.err
			}))
			if got := read(ctx); got != test.want {
				t.Fatalf("readiness = %q, want %q", got, test.want)
			}
		})
	}
}

func TestZKReadinessAllowlistedFlagsAndRedactedFailures(t *testing.T) {
	const unavailable = "zkAPI wallet status unavailable; retrying status"
	for _, test := range []struct {
		name string
		data string
		err  error
		want string
	}{
		{name: "empty", data: `{"has_note":false,"pending_request":false}`, want: "zkAPI companion ready; no private balance loaded; run oa-chat config to add funding"},
		{name: "loaded", data: `{"has_note":true,"pending_request":false,"balance":"secret-balance","note_id":"secret-note","private_key":"secret-key"}`, want: "zkAPI companion ready; private balance loaded"},
		{name: "legacy optional pending", data: `{"has_note":true}`, want: "zkAPI companion ready; private balance loaded"},
		{name: "pending", data: `{"has_note":true,"pending_request":true}`, want: "zkAPI companion ready; private wallet awaiting settlement"},
		{name: "pending before note", data: `{"has_note":false,"pending_request":true}`, want: "zkAPI companion ready; private wallet awaiting settlement"},
		{name: "remote error", data: `{"has_note":true}`, err: errors.New("secret-token https://secret-user:secret-password@example.test/?capability=secret"), want: "zkAPI companion unavailable or not ready; retrying status"},
		{name: "malformed", data: `{"has_note":true,"private_key":"secret-key"`, want: unavailable},
		{name: "missing readiness", data: `{"private_key":"secret-key"}`, want: unavailable},
		{name: "null document", data: `null`, want: unavailable},
		{name: "null readiness", data: `{"has_note":null}`, want: unavailable},
		{name: "string readiness", data: `{"has_note":"secret-key"}`, want: unavailable},
		{name: "string pending", data: `{"has_note":true,"pending_request":"secret-key"}`, want: unavailable},
		{name: "array document", data: `["secret-key"]`, want: unavailable},
	} {
		t.Run(test.name, func(t *testing.T) {
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			read := zkReadiness(readinessWalletReader(func(got context.Context) (json.RawMessage, error) {
				if got != ctx {
					t.Fatal("wallet did not receive the bounded polling context")
				}
				return json.RawMessage(test.data), test.err
			}))
			if got := read(ctx); got != test.want {
				t.Fatalf("readiness = %q, want %q", got, test.want)
			}
		})
	}
}

func TestMonitorReadinessLogsOnlyInitialAndChangedState(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	var output bytes.Buffer
	states := []string{"empty", "empty", "ready", "ready", "empty"}
	var checks []context.Context
	monitorReadiness(ctx, log.New(&output, "", 0), func(check context.Context) string {
		deadline, ok := check.Deadline()
		if !ok || time.Until(deadline) <= 0 || time.Until(deadline) > 3*time.Second {
			t.Fatal("readiness check must have a bounded deadline")
		}
		checks = append(checks, check)
		if len(checks) > len(states) {
			cancel()
			return "cancelled probe must not be logged"
		}
		return states[len(checks)-1]
	}, time.Millisecond)
	if got, want := output.String(), "Status: empty\nStatus: ready\nStatus: empty\n"; got != want {
		t.Fatalf("status transitions = %q, want %q", got, want)
	}
	for _, check := range checks {
		if !errors.Is(check.Err(), context.Canceled) {
			t.Fatal("finished check context was not cancelled")
		}
	}
}

func TestMonitorReadinessCancelsInFlightProbe(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	started, done := make(chan struct{}), make(chan struct{})
	var output bytes.Buffer
	go func() {
		defer close(done)
		monitorReadiness(ctx, log.New(&output, "", 0), func(check context.Context) string {
			close(started)
			<-check.Done()
			return "cancelled probe must not be logged"
		}, time.Hour)
	}()
	select {
	case <-started:
	case <-time.After(5 * time.Second):
		t.Fatal("initial readiness check did not run promptly")
	}
	cancel()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("shutdown did not cancel the in-flight readiness check")
	}
	if output.Len() != 0 {
		t.Fatalf("cancelled status was logged: %q", output.String())
	}
}

type serveOutput struct {
	mu      sync.Mutex
	buffer  bytes.Buffer
	changed chan struct{}
}

func (s *serveOutput) Write(p []byte) (int, error) {
	s.mu.Lock()
	n, err := s.buffer.Write(p)
	s.mu.Unlock()
	select {
	case s.changed <- struct{}{}:
	default:
	}
	return n, err
}

func (s *serveOutput) String() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.buffer.String()
}

func TestServeCommandWritesStatusAndLogsToStdout(t *testing.T) {
	if os.Getenv("OA_CHAT_SERVE_STDOUT_TEST_HELPER") == "1" {
		dir := os.Getenv("OA_CHAT_SERVE_STDOUT_TEST_DIR")
		c, err := config.Load(dir)
		if err != nil {
			t.Fatal(err)
		}
		expected := c
		c.Backend = "ticket"
		ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
		defer cancel()
		if err := serveSnapshot(ctx, dir, c, expected, os.Stdout); err != nil {
			log.Print(err)
			os.Exit(1)
		}
		os.Exit(0)
	}
	c, err := config.Default()
	if err != nil {
		t.Fatal(err)
	}
	// Ticket mode must work even when the saved default is zkAPI and its
	// companion/proving assets are absent. Selecting a mode cannot mutate them.
	c.Backend = "zkapi"
	c.RequireAPIKey = true // Exercise explicit authentication while the default is keyless.
	c.ZKAPI.Binary = filepath.Join(t.TempDir(), "missing-companion")
	c.ZKAPI.ProofSetupDir = filepath.Join(t.TempDir(), "missing-proof-assets")
	// Configuration requires a nonzero port; release a local ephemeral port just
	// before starting the child. No configured remote service is contacted.
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	c.Listen = listener.Addr().String()
	dir := filepath.Join(t.TempDir(), "config")
	if err := config.Init(dir, c); err != nil {
		listener.Close()
		t.Fatal(err)
	}
	savedConfig, err := os.ReadFile(filepath.Join(dir, "config.json"))
	if err != nil {
		t.Fatal(err)
	}
	listener.Close()
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(executable, "-test.run=^TestServeCommandWritesStatusAndLogsToStdout$")
	cmd.Env = append(os.Environ(), "OA_CHAT_SERVE_STDOUT_TEST_HELPER=1", "OA_CHAT_SERVE_STDOUT_TEST_DIR="+dir)
	stdout := &serveOutput{changed: make(chan struct{}, 1)}
	var stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = stdout, &stderr
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	done := make(chan struct{})
	var waitErr error
	go func() {
		waitErr = cmd.Wait()
		close(done)
	}()
	defer func() {
		_ = cmd.Process.Kill()
		<-done
	}()
	readyDeadline := time.NewTimer(10 * time.Second)
	defer readyDeadline.Stop()
	for !strings.Contains(stdout.String(), "Status: Ticket wallet: 0 tickets;") {
		select {
		case <-stdout.changed:
		case <-done:
			t.Fatalf("serve stopped before readiness: %v; stderr: %s", waitErr, stderr.String())
		case <-readyDeadline.C:
			t.Fatalf("serve did not report readiness on stdout: %s", stdout.String())
		}
	}
	client := &http.Client{Timeout: 5 * time.Second, Transport: &http.Transport{Proxy: nil}}
	defer client.CloseIdleConnections()
	active, err := resolveActiveConfig(context.Background(), c)
	if err != nil || active.Backend != "ticket" || active.ZKAPI != c.ZKAPI {
		t.Fatalf("running mode did not override saved default safely: %v", err)
	}
	req, err := http.NewRequest(http.MethodGet, "http://"+c.Listen+"/v1/models?secret-query", nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer secret-client-token")
	resp, err := client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	io.Copy(io.Discard, resp.Body)
	resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("unauthenticated request status = %d", resp.StatusCode)
	}
	if err := cmd.Process.Signal(syscall.SIGTERM); err != nil {
		t.Fatal(err)
	}
	select {
	case <-done:
		if waitErr != nil {
			t.Fatalf("serve failed: %v; stderr: %s", waitErr, stderr.String())
		}
	case <-time.After(10 * time.Second):
		t.Fatal("serve did not shut down after SIGTERM")
	}
	for _, want := range []string{"Starting local API service", "listening at http://" + c.Listen + "/v1", "direct HTTPS (network proxy off)", "Ticket wallet: 0 tickets", "/v1/models", "401", "Stopping local API service", "Local API service stopped"} {
		if !strings.Contains(stdout.String(), want) {
			t.Errorf("stdout does not contain %q: %s", want, stdout.String())
		}
	}
	if stderr.Len() != 0 {
		t.Errorf("successful serve wrote to stderr: %s", stderr.String())
	}
	afterConfig, err := os.ReadFile(filepath.Join(dir, "config.json"))
	if err != nil || !bytes.Equal(savedConfig, afterConfig) {
		t.Fatal("serve override changed the saved wallet configuration", err)
	}
	if _, err := os.Stat(filepath.Join(dir, "zkapi")); !os.IsNotExist(err) {
		t.Fatal("ticket mode touched zkAPI state")
	}
	if _, err := os.Stat(filepath.Join(dir, "funding")); !os.IsNotExist(err) {
		t.Fatal("ticket mode touched funding state")
	}
	for _, secret := range []string{c.APIKey, c.ZKAPI.BridgeToken, dir, "secret-query", "secret-client-token"} {
		if strings.Contains(stdout.String(), secret) {
			t.Errorf("stdout disclosed a credential or private request/configuration detail")
		}
	}
}
