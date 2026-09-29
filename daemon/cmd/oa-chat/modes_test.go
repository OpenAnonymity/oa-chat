package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"

	"github.com/OpenAnonymity/oa-chat/daemon/internal/config"
)

func TestServeSelectsModeWithoutChangingWalletConfiguration(t *testing.T) {
	c, err := config.Default()
	if err != nil {
		t.Fatal(err)
	}
	c.ZKAPI.Network = "sepolia"
	c.ZKAPI.Binary = "/missing/companion"
	c.ZKAPI.ProofSetupDir = "/missing/proof-assets"
	for _, saved := range []string{"ticket", "zkapi"} {
		c.Backend = saved
		for _, selected := range []string{"", "ticket", "zkapi"} {
			var args []string
			want := c
			if selected != "" {
				args = []string{"--backend", selected}
				want.Backend = selected
			}
			got, err := serveConfig(c, args)
			if err != nil || !reflect.DeepEqual(got, want) || c.Backend != saved {
				t.Fatalf("saved %s / selected %s changed wallet configuration: %v", saved, selected, err)
			}
		}
	}
	for _, args := range [][]string{{"--backend", "both"}, {"--backend", ""}, {"--backend", "ticket", "unexpected"}, {"--network", "sepolia"}} {
		if _, err := serveConfig(c, args); err == nil {
			t.Fatalf("accepted invalid serve arguments %q", args)
		}
	}
}

func TestActiveModeDiscoveryUsesAuthenticatedDaemonState(t *testing.T) {
	c, err := config.Default()
	if err != nil {
		t.Fatal(err)
	}
	c.Backend = "ticket"
	var response string
	daemon := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/admin/status" || r.Method != http.MethodGet || r.Header.Get("Authorization") != "Bearer "+c.APIKey {
			t.Error("mode discovery did not use authenticated local status")
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		if r.Header.Get("X-OA-Management-Token") != "" {
			t.Error("public mode metadata unnecessarily received the withdrawal credential")
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(response))
	}))
	defer daemon.Close()
	c.Listen = strings.TrimPrefix(daemon.URL, "http://")
	response = `{"backend":"zkapi","network":"sepolia","request_budget_policy":"model"}`
	active, err := resolveActiveConfig(context.Background(), c)
	if err != nil || active.Backend != "zkapi" || active.ZKAPI.Network != "sepolia" {
		t.Fatalf("did not resolve selected mode: %v", err)
	}
	if c.Backend != "ticket" || c.ZKAPI.Network != "mainnet" || active.APIKey != c.APIKey || active.ZKAPI.BridgeToken != c.ZKAPI.BridgeToken {
		t.Fatal("mode discovery changed wallet identity or persisted defaults")
	}
	response = `{"backend":"ticket"}`
	active, err = resolveActiveConfig(context.Background(), active)
	if err != nil || active.Backend != "ticket" {
		t.Fatal("could not switch back to ticket mode", err)
	}
	for _, invalid := range []string{`null`, `{}`, `{"backend":"both"}`, `{"backend":"zkapi"}`, `{"backend":"zkapi","network":"unknown"}`, `{"backend":"ticket","network":"sepolia"}`} {
		response = invalid
		if _, err := resolveActiveConfig(context.Background(), c); err == nil {
			t.Fatalf("accepted invalid mode metadata %s", invalid)
		}
	}
}
