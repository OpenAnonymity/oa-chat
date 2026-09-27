package main

import (
	"path/filepath"
	"testing"

	"github.com/OpenAnonymity/oa-chat/daemon/internal/config"
)

func TestInitializeNetworkProxySelection(t *testing.T) {
	for _, test := range []struct {
		name string
		args []string
		want string
	}{
		{name: "default"},
		{name: "zkapi-default", args: []string{"--backend", "zkapi"}},
		{name: "opt-in", args: []string{"--relay-url", "wss://relay.example/"}, want: "wss://relay.example/"},
		{name: "explicit-off", args: []string{"--relay-url", ""}},
	} {
		t.Run(test.name, func(t *testing.T) {
			dir := filepath.Join(t.TempDir(), "config")
			if err := initialize(dir, test.args); err != nil {
				t.Fatal(err)
			}
			loaded, err := config.Load(dir)
			if err != nil || loaded.RelayURL != test.want {
				t.Fatalf("incorrect proxy selection: %q, %v", loaded.RelayURL, err)
			}
		})
	}
}
