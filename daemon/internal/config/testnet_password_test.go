package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestSepoliaPasswordPrivatePersistenceAndOverrides(t *testing.T) {
	dir := t.TempDir()
	if err := os.Chmod(dir, 0700); err != nil {
		t.Fatal(err)
	}
	if got, err := SepoliaPassword(dir, "sepolia"); got != "" || err != nil {
		t.Fatal("absent password", err)
	}
	if err := SaveSepoliaPassword(dir, "shared secret"); err != nil {
		t.Fatal(err)
	}
	if got, err := SepoliaPassword(dir, "sepolia"); got != "shared secret" || err != nil {
		t.Fatal("saved password unavailable", err)
	}
	if info, err := os.Stat(filepath.Join(dir, TestnetPasswordFile)); err != nil || info.Mode().Perm() != 0600 {
		t.Fatal("password permissions", err)
	}
	t.Setenv("OA_ZKAPI_TESTNET_PASSWORD", "temporary override")
	if got, err := SepoliaPassword(dir, "sepolia"); got != "temporary override" || err != nil {
		t.Fatal("override unavailable", err)
	}
	if got, err := SepoliaPassword(dir, "mainnet"); got != "" || err != nil {
		t.Fatal("password reached mainnet", err)
	}
	t.Setenv("OA_ZKAPI_TESTNET_PASSWORD", "secret\r\nInjected: yes")
	if _, err := SepoliaPassword(dir, "sepolia"); err == nil || strings.Contains(err.Error(), "secret") {
		t.Fatal("unsafe password accepted or echoed")
	}
}

func TestSepoliaPasswordRejectsUnsafeFiles(t *testing.T) {
	for _, kind := range []string{"symlink", "public", "directory", "oversize", "empty"} {
		t.Run(kind, func(t *testing.T) {
			dir := t.TempDir()
			path := filepath.Join(dir, "password")
			t.Setenv("OA_ZKAPI_TESTNET_PASSWORD_FILE", path)
			switch kind {
			case "symlink":
				if err := os.WriteFile(path+"-target", []byte("secret"), 0600); err != nil {
					t.Fatal(err)
				}
				if err := os.Symlink(path+"-target", path); err != nil {
					t.Fatal(err)
				}
			case "directory":
				if err := os.Mkdir(path, 0700); err != nil {
					t.Fatal(err)
				}
			default:
				value := "secret"
				if kind == "oversize" {
					value = strings.Repeat("x", 1025)
				}
				if kind == "empty" {
					value = ""
				}
				if err := os.WriteFile(path, []byte(value), 0600); err != nil {
					t.Fatal(err)
				}
				if kind == "public" {
					if err := os.Chmod(path, 0644); err != nil {
						t.Fatal(err)
					}
				}
			}
			if _, err := SepoliaPassword(dir, "sepolia"); err == nil {
				t.Fatal("unsafe password file accepted")
			}
		})
	}
}
