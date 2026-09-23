package config

import (
	"os"
	"path/filepath"
	"testing"
)

func TestInitPrivateAndNeverClobbers(t *testing.T) {
	c, err := Default()
	if err != nil {
		t.Fatal(err)
	}
	dir := filepath.Join(t.TempDir(), "config")
	if err := Init(dir, c); err != nil {
		t.Fatal(err)
	}
	for path, want := range map[string]os.FileMode{dir: 0700, filepath.Join(dir, "config.json"): 0600} {
		info, err := os.Stat(path)
		if err != nil || info.Mode().Perm() != want {
			t.Fatalf("permissions %s", path)
		}
	}
	loaded, err := Load(dir)
	if err != nil || loaded.APIKey != c.APIKey || loaded.ZKAPI.Network != "mainnet" {
		t.Fatalf("load failed %v", err)
	}
	other, _ := Default()
	if Init(dir, other) == nil {
		t.Fatal("init overwrote existing config")
	}
	loaded, _ = Load(dir)
	if loaded.APIKey != c.APIKey {
		t.Fatal("existing key replaced")
	}
	if err := os.Chmod(filepath.Join(dir, "config.json"), 0644); err != nil {
		t.Fatal(err)
	}
	if _, err := Load(dir); err == nil {
		t.Fatal("accepted readable secrets")
	}
}

func TestRejectUnsafeRouting(t *testing.T) {
	for _, mutate := range []func(*Config){
		func(c *Config) { c.Listen = "0.0.0.0:8787" }, func(c *Config) { c.Listen = "localhost:8787" },
		func(c *Config) { c.OrgURL = "http://org.example" }, func(c *Config) { c.VerifierURL = "https://user:secret@example.com" },
		func(c *Config) { c.RelayURL = "ws://relay.example" }, func(c *Config) { c.ZKAPI.Network = "unknown" },
		func(c *Config) { c.ZKAPI.ClientURL = "http://remote.example:8790" }, func(c *Config) { c.ZKAPI.ClientURL = "http://127.0.0.1:8790?token=secret" },
	} {
		c, _ := Default()
		mutate(&c)
		if Validate(c) == nil {
			t.Fatal("unsafe config accepted")
		}
	}
}
