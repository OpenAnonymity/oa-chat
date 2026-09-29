package config

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
)

func editableConfig(t *testing.T) (string, Config) {
	t.Helper()
	dir := filepath.Join(t.TempDir(), "private")
	c, err := Default()
	if err != nil {
		t.Fatal(err)
	}
	if err := Init(dir, c); err != nil {
		t.Fatal(err)
	}
	c, err = Load(dir)
	if err != nil {
		t.Fatal(err)
	}
	return dir, c
}

func TestUpdatePreservesBothWalletsAndCredentials(t *testing.T) {
	dir, original := editableConfig(t)
	files := []string{"tickets.json", "funding/mainnet/address-funding.json", "funding/sepolia/address-funding.json", "zkapi/mainnet/deployment/note.json", "zkapi/sepolia/deployment/note.json", "management-token"}
	before := map[string][]byte{}
	for _, name := range files {
		path := filepath.Join(dir, name)
		if name != "management-token" {
			if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(path, []byte("private recovery fixture "+name), 0600); err != nil {
				t.Fatal(err)
			}
		}
		before[name], _ = os.ReadFile(path)
	}
	updated := original
	updated.Backend, updated.ZKAPI.Network, updated.Listen = "zkapi", "sepolia", "127.0.0.1:9876"
	if err := Update(dir, original, updated); err != nil {
		t.Fatal(err)
	}
	loaded, err := Load(dir)
	if err != nil || loaded != updated {
		t.Fatalf("edited settings did not persist: %v", err)
	}
	if err := Update(dir, loaded, original); err != nil {
		t.Fatal(err)
	}
	loaded, err = Load(dir)
	if err != nil || loaded != original {
		t.Fatalf("profile did not round-trip: %v", err)
	}
	for name, want := range before {
		path := filepath.Join(dir, name)
		data, err := os.ReadFile(path)
		if err != nil || !bytes.Equal(data, want) {
			t.Fatalf("edit changed private wallet file %s", name)
		}
		info, err := os.Stat(path)
		if err != nil || info.Mode().Perm() != 0600 {
			t.Fatalf("wallet permissions changed: %s", name)
		}
	}
	info, err := os.Stat(filepath.Join(dir, "config.json"))
	if err != nil || info.Mode().Perm() != 0600 {
		t.Fatal("updated config is not owner-only")
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), ".config-") {
			t.Fatal("temporary config was left behind")
		}
	}
}

func TestUpdateRejectsActiveDaemonAndStaleEditor(t *testing.T) {
	dir, original := editableConfig(t)
	next := original
	next.Backend = "zkapi"
	lock, err := os.OpenFile(filepath.Join(dir, "daemon.lock"), os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		t.Fatal(err)
	}
	defer lock.Close()
	if err := syscall.Flock(int(lock.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		t.Fatal(err)
	}
	if err := Update(dir, original, next); err == nil || !strings.Contains(err.Error(), "stop oa-chat serve") {
		t.Fatal("updated a running daemon's profile", err)
	}
	if err := syscall.Flock(int(lock.Fd()), syscall.LOCK_UN); err != nil {
		t.Fatal(err)
	}
	if err := Update(dir, original, next); err != nil {
		t.Fatal(err)
	}
	stale := original
	stale.ZKAPI.Network = "sepolia"
	if err := Update(dir, original, stale); err == nil {
		t.Fatal("stale editor overwrote newer settings")
	}
	loaded, err := Load(dir)
	if err != nil || loaded != next {
		t.Fatal("rejected update changed config", err)
	}
}

func TestUpdateRejectsCredentialAndOrganizationChanges(t *testing.T) {
	for _, kind := range []string{"api", "bridge", "management", "organization", "routing"} {
		t.Run(kind, func(t *testing.T) {
			dir, original := editableConfig(t)
			before, _ := os.ReadFile(filepath.Join(dir, "config.json"))
			next := original
			switch kind {
			case "api":
				next.APIKey = strings.Repeat("a", 64)
			case "bridge":
				next.ZKAPI.BridgeToken = strings.Repeat("b", 64)
			case "management":
				next.ManagementToken = strings.Repeat("c", 64)
			case "organization":
				next.OrgURL = "https://org-other.example"
			case "routing":
				next.Listen = "0.0.0.0:8787"
			}
			if err := Update(dir, original, next); err == nil {
				t.Fatal("accepted unsafe edit")
			}
			after, _ := os.ReadFile(filepath.Join(dir, "config.json"))
			if !bytes.Equal(before, after) {
				t.Fatal("failed edit rewrote config")
			}
		})
	}
}

func TestUpdateRejectsUnsafeLockWithoutTouchingTarget(t *testing.T) {
	for _, kind := range []string{"symlink", "fifo", "public", "directory"} {
		t.Run(kind, func(t *testing.T) {
			dir, original := editableConfig(t)
			next := original
			next.Backend = "zkapi"
			path := filepath.Join(dir, "daemon.lock")
			switch kind {
			case "symlink":
				if err := os.Symlink("config.json", path); err != nil {
					t.Fatal(err)
				}
			case "fifo":
				if err := syscall.Mkfifo(path, 0600); err != nil {
					t.Fatal(err)
				}
			case "public":
				if err := os.WriteFile(path, nil, 0644); err != nil {
					t.Fatal(err)
				}
			case "directory":
				if err := os.Mkdir(path, 0700); err != nil {
					t.Fatal(err)
				}
			}
			before, _ := os.ReadFile(filepath.Join(dir, "config.json"))
			if err := Update(dir, original, next); err == nil {
				t.Fatal("accepted unsafe daemon lock")
			}
			after, _ := os.ReadFile(filepath.Join(dir, "config.json"))
			if !bytes.Equal(before, after) {
				t.Fatal("unsafe lock changed config")
			}
		})
	}
}
