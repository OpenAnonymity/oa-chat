package config

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestKeyReuseDefaultMigrationAndExplicitDisable(t *testing.T) {
	for _, test := range []struct {
		name  string
		value string
		want  int
	}{{"missing", "", 60}, {"disabled", "0", 0}, {"custom", "25", 25}, {"maximum", "300", 300}} {
		t.Run(test.name, func(t *testing.T) {
			c, err := Default()
			if err != nil || c.KeyReuseWindowSeconds != 60 {
				t.Fatal("wrong default", err)
			}
			dir := filepath.Join(t.TempDir(), "profile")
			if err := Init(dir, c); err != nil {
				t.Fatal(err)
			}
			raw, _ := json.Marshal(c)
			var fields map[string]json.RawMessage
			_ = json.Unmarshal(raw, &fields)
			delete(fields, "key_reuse_window_seconds")
			if test.value != "" {
				fields["key_reuse_window_seconds"] = json.RawMessage(test.value)
			}
			raw, _ = json.Marshal(fields)
			if err := os.WriteFile(filepath.Join(dir, "config.json"), raw, 0600); err != nil {
				t.Fatal(err)
			}
			loaded, err := Load(dir)
			if err != nil || loaded.KeyReuseWindowSeconds != test.want || loaded.APIKey != c.APIKey {
				t.Fatal("missing and disabled settings were conflated, or credentials changed", err)
			}
			next := loaded
			next.KeyReuseWindowSeconds = 0
			if err := Update(dir, loaded, next); err != nil {
				t.Fatal(err)
			}
			saved, err := Load(dir)
			if err != nil || saved.KeyReuseWindowSeconds != 0 || saved.ManagementToken != loaded.ManagementToken {
				t.Fatal("explicit disable did not persist", err)
			}
		})
	}
}

func TestKeyReuseRejectsOutOfBoundsConfiguration(t *testing.T) {
	for _, seconds := range []int{-1, 301, 1 << 30} {
		c, err := Default()
		if err != nil {
			t.Fatal(err)
		}
		c.KeyReuseWindowSeconds = seconds
		if Validate(c) == nil {
			t.Fatal("unsafe reuse window accepted", seconds)
		}
	}
}

func TestKeyReuseRejectsNonIntegerJSON(t *testing.T) {
	for _, value := range []string{"null", "1.5", `"60"`, "true", "{}"} {
		t.Run(value, func(t *testing.T) {
			c, err := Default()
			if err != nil {
				t.Fatal(err)
			}
			dir := filepath.Join(t.TempDir(), "profile")
			if err := Init(dir, c); err != nil {
				t.Fatal(err)
			}
			raw, _ := json.Marshal(c)
			var fields map[string]json.RawMessage
			_ = json.Unmarshal(raw, &fields)
			fields["key_reuse_window_seconds"] = json.RawMessage(value)
			raw, _ = json.Marshal(fields)
			if err := os.WriteFile(filepath.Join(dir, "config.json"), raw, 0600); err != nil {
				t.Fatal(err)
			}
			if _, err := Load(dir); err == nil {
				t.Fatal("non-integer reuse window accepted")
			}
		})
	}
}
