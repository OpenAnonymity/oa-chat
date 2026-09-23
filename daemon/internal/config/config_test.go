package config

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync"
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

func TestManagementTokenPersistsPrivatelyWithoutChangingConfig(t *testing.T) {
	c, err := Default()
	if err != nil {
		t.Fatal(err)
	}
	dir := filepath.Join(t.TempDir(), "config")
	if err := Init(dir, c); err != nil {
		t.Fatal(err)
	}
	before, err := os.ReadFile(filepath.Join(dir, "config.json"))
	if err != nil {
		t.Fatal(err)
	}
	loaded, err := Load(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(loaded.ManagementToken) != 64 || loaded.ManagementToken == loaded.APIKey {
		t.Fatal("management credential is missing or duplicates inference access")
	}
	again, err := Load(dir)
	if err != nil || again.ManagementToken != loaded.ManagementToken {
		t.Fatal("management credential changed on reload", err)
	}
	info, err := os.Lstat(filepath.Join(dir, managementTokenFile))
	if err != nil || !info.Mode().IsRegular() || info.Mode().Perm() != 0600 {
		t.Fatal("management credential is not a private regular file")
	}
	after, err := os.ReadFile(filepath.Join(dir, "config.json"))
	if err != nil || !bytes.Equal(before, after) {
		t.Fatal("loading management credential changed existing config")
	}
	published, err := json.Marshal(loaded)
	if err != nil || bytes.Contains(published, []byte(loaded.ManagementToken)) || bytes.Contains(published, []byte("management")) {
		t.Fatal("management credential appeared in serialized config")
	}
}

func TestConcurrentLoadsShareOneDurableManagementToken(t *testing.T) {
	c, err := Default()
	if err != nil {
		t.Fatal(err)
	}
	dir := filepath.Join(t.TempDir(), "config")
	if err := Init(dir, c); err != nil {
		t.Fatal(err)
	}
	const workers = 32
	values := make([]Config, workers)
	failures := make([]error, workers)
	var group sync.WaitGroup
	start := make(chan struct{})
	for i := range workers {
		group.Add(1)
		go func() {
			defer group.Done()
			<-start
			values[i], failures[i] = Load(dir)
		}()
	}
	close(start)
	group.Wait()
	for i := range workers {
		if failures[i] != nil || values[i].ManagementToken == "" || values[i].ManagementToken != values[0].ManagementToken {
			t.Fatalf("concurrent load %d disagreed or failed: %v", i, failures[i])
		}
	}
	files, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	for _, file := range files {
		if strings.HasPrefix(file.Name(), ".management-token-") {
			t.Fatal("completed load left temporary credential files")
		}
	}
}

func TestManagementTokenRejectsUnsafeExistingFileWithoutReplacement(t *testing.T) {
	for _, kind := range []string{"symlink", "public", "malformed", "inference-key", "directory"} {
		t.Run(kind, func(t *testing.T) {
			c, err := Default()
			if err != nil {
				t.Fatal(err)
			}
			dir := filepath.Join(t.TempDir(), "config")
			if err := Init(dir, c); err != nil {
				t.Fatal(err)
			}
			path := filepath.Join(dir, managementTokenFile)
			content := []byte(strings.Repeat("a", 64) + "\n")
			switch kind {
			case "symlink":
				target := filepath.Join(dir, "existing-secret")
				if err := os.WriteFile(target, content, 0600); err != nil {
					t.Fatal(err)
				}
				if err := os.Symlink(target, path); err != nil {
					t.Fatal(err)
				}
			case "directory":
				if err := os.Mkdir(path, 0700); err != nil {
					t.Fatal(err)
				}
			default:
				if kind == "malformed" {
					content = []byte("partial")
				}
				if kind == "inference-key" {
					content = []byte(c.APIKey + "\n")
				}
				if err := os.WriteFile(path, content, 0600); err != nil {
					t.Fatal(err)
				}
				if kind == "public" {
					if err := os.Chmod(path, 0644); err != nil {
						t.Fatal(err)
					}
				}
			}
			before, err := os.Lstat(path)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := Load(dir); err == nil {
				t.Fatal("accepted unsafe management credential")
			}
			after, err := os.Lstat(path)
			if err != nil || !os.SameFile(before, after) || before.Mode() != after.Mode() {
				t.Fatal("failed load replaced or altered an existing credential")
			}
			if kind != "directory" {
				actual, err := os.ReadFile(path)
				if err != nil || !bytes.Equal(actual, content) {
					t.Fatal("failed load changed credential content")
				}
			}
		})
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
