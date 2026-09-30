package zkapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func sessionTestFeed() SessionEvents {
	charge, balance := "0", "1234567"
	id := strings.Repeat("b", 64)
	return SessionEvents{Version: 1, InstanceID: strings.Repeat("a", 32), FirstSequence: 1, NextSequence: 3, Events: []SessionEvent{
		{Sequence: 1, Kind: "started", SessionID: id},
		{Sequence: 2, Kind: "settled", SessionID: id, ChargeUnits: &charge, BalanceUnits: &balance},
	}}
}

func TestSessionEventsAuthenticatedReadOnlyAndExactAmounts(t *testing.T) {
	var paths []string
	local := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		paths = append(paths, r.URL.Path)
		if r.Method != http.MethodGet || r.Header.Get("Authorization") != "Bearer "+testBridgeToken {
			t.Error("accounting read did not use authenticated GET")
		}
		switch r.URL.Path {
		case "/oa/v1/status":
			_ = json.NewEncoder(w).Encode(testPolicy("mainnet"))
		case "/oa/v1/session-events":
			_ = json.NewEncoder(w).Encode(sessionTestFeed())
		default:
			t.Error("accounting tried another endpoint")
			w.WriteHeader(500)
		}
	}))
	defer local.Close()
	c, err := New(Config{ClientURL: local.URL, BridgeToken: testBridgeToken, HTTPClient: &http.Client{Transport: &http.Transport{Proxy: nil}}})
	if err != nil {
		t.Fatal(err)
	}
	feed, err := c.SessionEvents(context.Background())
	if err != nil || len(paths) != 2 || len(feed.Events) != 2 || *feed.Events[1].ChargeUnits != "0" || *feed.Events[1].BalanceUnits != "1234567" {
		t.Fatal("signed zero-cost settlement was lost or altered", err)
	}
}

func TestSessionEventsRejectMalformedFinancialMetadata(t *testing.T) {
	text := func(s string) *string { return &s }
	for name, change := range map[string]func(*SessionEvents){
		"version":          func(f *SessionEvents) { f.Version = 0 },
		"instance":         func(f *SessionEvents) { f.InstanceID = "private-name\n" },
		"session":          func(f *SessionEvents) { f.Events[0].SessionID = "private-note" },
		"gap":              func(f *SessionEvents) { f.Events[1].Sequence++ },
		"overflow":         func(f *SessionEvents) { f.FirstSequence = ^uint64(0) },
		"missing":          func(f *SessionEvents) { f.Events[1].ChargeUnits = nil },
		"balance":          func(f *SessionEvents) { f.Events[1].BalanceUnits = text("-1") },
		"fraction":         func(f *SessionEvents) { f.Events[1].ChargeUnits = text("0.1") },
		"noncanonical":     func(f *SessionEvents) { f.Events[1].ChargeUnits = text("000") },
		"oversize":         func(f *SessionEvents) { f.Events[1].ChargeUnits = text("340282366920938463463374607431768211456") },
		"injection":        func(f *SessionEvents) { f.Events[1].ChargeUnits = text("0\nprivate detail") },
		"unconfirmed cost": func(f *SessionEvents) { f.Events[0].ChargeUnits = text("1") },
		"unknown kind":     func(f *SessionEvents) { f.Events[1].Kind = "private-key" },
		"unbounded":        func(f *SessionEvents) { f.Events = make([]SessionEvent, 129); f.NextSequence = 130 },
	} {
		t.Run(name, func(t *testing.T) {
			feed := sessionTestFeed()
			change(&feed)
			if validSessionEvents(feed) {
				t.Fatal("invalid accounting feed accepted")
			}
		})
	}
	maximum := "340282366920938463463374607431768211455"
	feed := sessionTestFeed()
	feed.Events[1].BalanceUnits = &maximum
	if !validSessionEvents(feed) {
		t.Fatal("exact u128 accounting rejected")
	}
}
