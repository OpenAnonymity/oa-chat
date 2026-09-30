package main

import (
	"bytes"
	"context"
	"errors"
	"log"
	"strings"
	"testing"
	"time"

	"github.com/OpenAnonymity/oa-chat/daemon/internal/zkapi"
)

func sessionLogFeed(instance string, first uint64, events ...zkapi.SessionEvent) zkapi.SessionEvents {
	return zkapi.SessionEvents{Version: 1, InstanceID: instance, FirstSequence: first, NextSequence: first + uint64(len(events)), Events: events}
}

func sessionLogStart(seq uint64, id string) zkapi.SessionEvent {
	return zkapi.SessionEvent{Sequence: seq, Kind: "started", SessionID: id}
}

func sessionLogEnd(seq uint64, id, cost, balance string) zkapi.SessionEvent {
	return zkapi.SessionEvent{Sequence: seq, Kind: "settled", SessionID: id, ChargeUnits: &cost, BalanceUnits: &balance}
}

func TestSessionLogsOncePerKeyAndActualSettlement(t *testing.T) {
	var out bytes.Buffer
	logger := log.New(&out, "", 0)
	var cursor sessionLogCursor
	start := sessionLogStart(1, "private-session-id")
	feed := sessionLogFeed("private-process-id", 1, start)
	cursor.report(logger, feed)
	// Polling, key reuse, and provider responses are not session boundaries.
	for range 3 {
		cursor.report(logger, feed)
	}
	feed = sessionLogFeed("private-process-id", 1, start, sessionLogEnd(2, "private-session-id", "28", "1121532"))
	cursor.report(logger, feed)
	cursor.report(logger, feed)
	want := "zkAPI OpenRouter key session 1 started\nzkAPI OpenRouter key session 1 ended (settled); cost: 0.000000028 ETH; balance remaining: 0.001121532 ETH\n"
	if out.String() != want {
		t.Fatalf("incorrect session accounting output: %s", out.String())
	}
}

func TestSessionLogsRecoveryGapAndRestartNeverInventCost(t *testing.T) {
	var out bytes.Buffer
	logger := log.New(&out, "", 0)
	var cursor sessionLogCursor
	cursor.report(logger, sessionLogFeed("one", 1, sessionLogStart(1, "old")))
	// Restarted helper has no start event but can recover a signed settlement.
	cursor.report(logger, sessionLogFeed("two", 1, sessionLogEnd(1, "old", "0", "1121560")))
	cursor.report(logger, sessionLogFeed("two", 1, sessionLogEnd(1, "old", "0", "1121560"), sessionLogStart(2, "next")))
	// A trimmed history can't be used to infer cost or invent missing events.
	feed := sessionLogFeed("two", 5, sessionLogEnd(5, "next", "10", "1121550"))
	cursor.report(logger, feed)
	cursor.report(logger, feed)
	got := out.String()
	if strings.Count(got, "history is no longer available") != 1 || strings.Count(got, "Previous zkAPI OpenRouter key session ended") != 2 || strings.Count(got, "cost:") != 2 || !strings.Contains(got, "cost: 0.000000000 ETH") || !strings.Contains(got, "session 2 started") {
		t.Fatal("lost/recovered accounting was mislabeled", got)
	}
	for _, private := range []string{"private", "old", "next", "companion", "Status:"} {
		if strings.Contains(got, private) {
			t.Fatal("operational details entered log")
		}
	}
}

type sessionReaderFunc func(context.Context) (zkapi.SessionEvents, error)

func (f sessionReaderFunc) SessionEvents(ctx context.Context) (zkapi.SessionEvents, error) {
	return f(ctx)
}

func TestSessionMonitorHidesTransientErrorsAndStopsOnCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	var out bytes.Buffer
	calls := 0
	reader := sessionReaderFunc(func(check context.Context) (zkapi.SessionEvents, error) {
		if _, ok := check.Deadline(); !ok {
			t.Error("probe has no deadline")
		}
		calls++
		if calls == 1 || calls == 3 {
			return zkapi.SessionEvents{}, errors.New("private-wallet secret-url")
		}
		if calls == 5 {
			cancel()
			return zkapi.SessionEvents{}, check.Err()
		}
		return sessionLogFeed("one", 1, sessionLogStart(1, "id")), nil
	})
	monitorSessions(ctx, log.New(&out, "", 0), reader, time.Millisecond)
	if out.String() != "zkAPI OpenRouter key session 1 started\n" {
		t.Fatal("transient failure or repeated start was logged", out.String())
	}
}

func TestSessionMonitorReportsSustainedFailureOnceWithoutSecrets(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	var out bytes.Buffer
	calls := 0
	reader := sessionReaderFunc(func(context.Context) (zkapi.SessionEvents, error) {
		calls++
		if calls == 18 {
			cancel()
		}
		return zkapi.SessionEvents{}, errors.New("secret-credential")
	})
	monitorSessions(ctx, log.New(&out, "", 0), reader, time.Millisecond)
	if strings.Count(out.String(), "Session cost reporting is unavailable") != 1 || strings.Contains(out.String(), "secret") {
		t.Fatal("sustained failure was silent, repeated, or leaked details", out.String())
	}
}
