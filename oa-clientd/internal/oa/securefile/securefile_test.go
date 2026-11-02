package securefile

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func private(t *testing.T) string {
	t.Helper()
	dir := filepath.Join(t.TempDir(), "p")
	if err := EnsureDir(dir); err != nil {
		t.Fatal(err)
	}
	return dir
}

func TestWriteAtomicIsOwnerOnlyAndLeavesNoTemp(t *testing.T) {
	dir := private(t)
	path := filepath.Join(dir, "f")
	if err := WriteAtomic(path, []byte("one")); err != nil {
		t.Fatal(err)
	}
	if err := WriteAtomic(path, []byte("two")); err != nil {
		t.Fatal(err)
	}
	data, err := Read(path, 16)
	if err != nil || string(data) != "two" {
		t.Fatalf("data=%q err=%v", data, err)
	}
	if info, _ := os.Stat(path); info.Mode().Perm() != 0o600 {
		t.Fatalf("mode = %v", info.Mode())
	}
	entries, _ := os.ReadDir(dir)
	if len(entries) != 1 {
		t.Fatalf("leftovers: %v", entries)
	}
}

func TestReadRefusals(t *testing.T) {
	dir := private(t)
	path := filepath.Join(dir, "f")
	if _, err := Read(path, 16); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("err = %v", err)
	}
	WriteAtomic(path, []byte("0123456789"))
	if _, err := Read(path, 5); err == nil || !strings.Contains(err.Error(), "maximum") {
		t.Fatalf("oversize: %v", err)
	}
	link := filepath.Join(dir, "l")
	os.Symlink(path, link)
	if _, err := Read(link, 16); err == nil || !strings.Contains(err.Error(), "symbolic") {
		t.Fatalf("symlink: %v", err)
	}
	os.Chmod(path, 0o640)
	if _, err := Read(path, 16); err == nil || !strings.Contains(err.Error(), "chmod 600") {
		t.Fatalf("mode: %v", err)
	}
	if _, err := Read(dir, 16); err == nil {
		t.Fatal("directory accepted")
	}
}

func TestEnsureDirRefusesLooseAndSymlinkedDirectories(t *testing.T) {
	base := t.TempDir()
	loose := filepath.Join(base, "loose")
	os.Mkdir(loose, 0o755)
	if err := EnsureDir(loose); err == nil {
		t.Fatal("loose directory accepted")
	}
	real := filepath.Join(base, "real")
	os.Mkdir(real, 0o700)
	link := filepath.Join(base, "link")
	os.Symlink(real, link)
	if err := EnsureDir(link); err == nil {
		t.Fatal("symlinked directory accepted")
	}
}

func TestLockExcludesAcrossDescriptorsAndWaits(t *testing.T) {
	dir := private(t)
	path := filepath.Join(dir, "lock")
	first, err := TryLock(path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := TryLock(path); !errors.Is(err, ErrLocked) {
		t.Fatalf("err = %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Millisecond)
	defer cancel()
	if _, err := AcquireLock(ctx, path); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("err = %v", err)
	}
	first.Release()
	second, err := TryLock(path)
	if err != nil {
		t.Fatal(err)
	}
	second.Release()
	second.Release()
}

func TestLockRefusesASymlink(t *testing.T) {
	dir := private(t)
	target := filepath.Join(dir, "target")
	os.WriteFile(target, nil, 0o600)
	link := filepath.Join(dir, "lock")
	os.Symlink(target, link)
	if _, err := TryLock(link); err == nil {
		t.Fatal("symlinked lock accepted")
	}
}
