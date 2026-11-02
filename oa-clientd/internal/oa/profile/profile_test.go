package profile

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/OpenAnonymity/oa-chat/oa-clientd/internal/oa/oatest"
)

func TestIdentityIsSeparateFromZkapiClientd(t *testing.T) {
	if DefaultListen == "127.0.0.1:8787" || DefaultListen == "127.0.0.1:8790" {
		t.Fatal("the default port collides with zkapi-clientd or its companion")
	}
	t.Setenv("OA_CLIENTD_CONFIG_DIR", "")
	t.Setenv("ZKAPI_CLIENTD_CONFIG_DIR", "/should/be/ignored")
	t.Setenv("OA_CHAT_CONFIG_DIR", "/should/be/ignored")
	dir, err := DefaultDir()
	if err != nil {
		t.Fatal(err)
	}
	if filepath.Base(dir) != "oa-clientd" || strings.Contains(dir, "zkapi") {
		t.Fatalf("dir = %s", dir)
	}
	t.Setenv("OA_CLIENTD_CONFIG_DIR", "/explicit/oa")
	if dir, _ := DefaultDir(); dir != "/explicit/oa" {
		t.Fatalf("dir = %s", dir)
	}
}

func TestEnvironmentsAreExact(t *testing.T) {
	staging, ok := LookupEnvironment("staging")
	if !ok || staging.OrgURL != "https://org-staging.openanonymity.ai" || staging.ChatURL != "https://staging.openanonymity.ai" {
		t.Fatalf("staging = %+v", staging)
	}
	if _, ok := LookupEnvironment("mainnet"); ok {
		t.Fatal("unknown environment accepted")
	}
	config, err := Default(staging)
	if err != nil {
		t.Fatal(err)
	}
	if !config.WebSearch {
		t.Fatal("web search defaults on, as in zkapi-clientd")
	}
	if err := Validate(config); err != nil {
		t.Fatal(err)
	}
}

func TestValidateRefusesWideningTheBoundary(t *testing.T) {
	staging, _ := LookupEnvironment("staging")
	base, _ := Default(staging)
	cases := map[string]func(*Config){
		"non-loopback listen":  func(c *Config) { c.Listen = "0.0.0.0:8797" },
		"hostname listen":      func(c *Config) { c.Listen = "localhost:8797" },
		"http org":             func(c *Config) { c.OrgURL = "http://org.example" },
		"org with path":        func(c *Config) { c.OrgURL = "https://org.example/path" },
		"org with credentials": func(c *Config) { c.OrgURL = "https://user:pw@org.example" },
		"chat with query":      func(c *Config) { c.ChatURL = "https://chat.example?x=1" },
		"short key":            func(c *Config) { c.APIKey = "short" },
		"reuse too long":       func(c *Config) { c.KeyReuseWindowSeconds = 301 },
		"bad model":            func(c *Config) { c.DefaultModel = "bad model" },
		"lease too big":        func(c *Config) { c.LeaseSize = 501 },
		"sync too often":       func(c *Config) { c.SyncIntervalSeconds = 5 },
		"bad relay":            func(c *Config) { c.RelayURL = "ftp://relay" },
		"plain http rewriter":  func(c *Config) { c.Rewriter.URL, c.Rewriter.Model = "http://rewriter.example", "m" },
		"cover without tor":    func(c *Config) { c.Cover.URLs = "https://example.com"; c.Cover.Rate = 1; c.Cover.Concurrency = 1 },
	}
	for name, mutate := range cases {
		config := base
		mutate(&config)
		if err := Validate(config); err == nil {
			t.Errorf("%s accepted", name)
		}
	}
}

func TestSaveLoadRoundTripAndPermissions(t *testing.T) {
	dir := oatest.PrivateDir(t)
	if _, err := Load(dir); !errors.Is(err, ErrMissing) {
		t.Fatalf("err = %v", err)
	}
	staging, _ := LookupEnvironment("staging")
	config, _ := Default(staging)
	if err := Save(dir, config); err != nil {
		t.Fatal(err)
	}
	loaded, err := Load(dir)
	if err != nil || loaded != config {
		t.Fatalf("loaded = %+v, %v", loaded, err)
	}
	path := filepath.Join(dir, configFile)
	if info, _ := os.Stat(path); info.Mode().Perm() != 0o600 {
		t.Fatalf("mode = %v", info.Mode())
	}
	os.Chmod(path, 0o644)
	if _, err := Load(dir); err == nil {
		t.Fatal("group-readable config accepted")
	}
	os.Chmod(path, 0o600)
	os.WriteFile(path, []byte(`{"environment":"staging","zkapi":{"bridge_token":"x"}}`), 0o600)
	if _, err := Load(dir); err == nil {
		t.Fatal("a zkAPI profile must not load as an oa-clientd profile")
	}
}
