package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestLegacyNativeRequestCapDoesNotBlockConfigLoad(t *testing.T) {
	for _, cap := range []uint64{1_000_000, 4_500_000, 4_000_000, ^uint64(0)} {
		config, err := Default()
		if err != nil {
			t.Fatal(err)
		}
		config.Backend, config.ZKAPI.RequestLimitMicroUSD = "zkapi", cap
		dir := filepath.Join(t.TempDir(), "wallet")
		if err := Init(dir, config); err != nil {
			t.Fatal(err)
		}
		loaded, err := Load(dir)
		if err != nil || loaded.ZKAPI.RequestLimitMicroUSD != cap {
			t.Fatalf("legacy request-limit compatibility failed: %v", err)
		}
	}
}

func TestNewConfigHasBothModesWithoutFixedBudget(t *testing.T) {
	c, err := Default()
	if err != nil {
		t.Fatal(err)
	}
	dir := filepath.Join(t.TempDir(), "wallet")
	if err := Init(dir, c); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(filepath.Join(dir, "config.json"))
	if err != nil || strings.Contains(string(data), "request_limit_micro_usd") {
		t.Fatal("new config retained a fixed budget", err)
	}
	for _, mode := range []string{"ticket", "zkapi"} {
		loaded, err := Load(dir)
		if err != nil {
			t.Fatal(err)
		}
		loaded.Backend = mode
		if err := Validate(loaded); err != nil {
			t.Fatalf("one initialization did not configure %s: %v", mode, err)
		}
		if loaded.APIKey != c.APIKey || loaded.ZKAPI.BridgeToken != c.ZKAPI.BridgeToken {
			t.Fatal("switching modes changed credentials")
		}
	}
}
