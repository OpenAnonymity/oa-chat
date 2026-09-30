package config

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestLocalInferenceAuthenticationDefaultsAndPersists(t *testing.T) {
	for _, setting := range []string{"missing", "false", "true"} {
		t.Run(setting, func(t *testing.T) {
			c, err := Default()
			if err != nil {
				t.Fatal(err)
			}
			if c.RequireAPIKey || c.Listen != "127.0.0.1:8787" || len(c.APIKey) < 32 {
				t.Fatal("default must be keyless loopback inference with a private management credential")
			}
			c.RequireAPIKey = setting == "true"
			dir := filepath.Join(t.TempDir(), "config")
			if err := Init(dir, c); err != nil {
				t.Fatal(err)
			}
			if setting == "missing" {
				// Existing profiles predate the field and acquire the new default
				// without losing their private authentication credentials.
				encoded, _ := json.Marshal(c)
				var values map[string]json.RawMessage
				if err := json.Unmarshal(encoded, &values); err != nil {
					t.Fatal(err)
				}
				delete(values, "require_api_key")
				encoded, _ = json.Marshal(values)
				if err := os.WriteFile(filepath.Join(dir, "config.json"), encoded, 0600); err != nil {
					t.Fatal(err)
				}
			}
			loaded, err := Load(dir)
			if err != nil || loaded.RequireAPIKey != c.RequireAPIKey || loaded.APIKey != c.APIKey || loaded.ManagementToken == "" {
				t.Fatal("authentication setting or management credentials lost", err)
			}
			next := loaded
			next.RequireAPIKey = !loaded.RequireAPIKey
			if err := Update(dir, loaded, next); err != nil {
				t.Fatal(err)
			}
			again, err := Load(dir)
			if err != nil || again.RequireAPIKey != next.RequireAPIKey || again.APIKey != loaded.APIKey || again.ManagementToken != loaded.ManagementToken {
				t.Fatal("authentication preference was not saved without changing credentials", err)
			}
		})
	}
}

func TestPrivateDirectoryErrorOmitsRealPath(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "private-account-name")
	if err := os.Mkdir(dir, 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(dir, 0755); err != nil {
		t.Fatal(err)
	}
	err := EnsureDir(dir)
	if err == nil || strings.Contains(err.Error(), dir) || strings.Contains(err.Error(), "private-account-name") || !strings.Contains(err.Error(), "chmod 700") {
		t.Fatalf("unsafe or unactionable permission error: %v", err)
	}
}
