// Package securefile holds the owner-only file primitives oa-clientd's private
// profile depends on: private real directories, no-follow reads, atomic synced
// replacement, and a process-shared lock on a stable inode.
package securefile

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"syscall"
	"time"
)

// EnsureDir creates a private directory and refuses a symlink or a directory
// another user can read.
func EnsureDir(dir string) error {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	info, err := os.Lstat(dir)
	if err != nil {
		return err
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return errors.New("the profile directory must be a real directory")
	}
	if info.Mode().Perm()&0o077 != 0 {
		return errors.New("the profile directory must be private (chmod 700)")
	}
	return nil
}

// Read returns a private regular file's contents. It opens without following
// a symlink and checks the opened file, so a swap after the check is harmless.
func Read(path string, limit int64) ([]byte, error) {
	fd, err := syscall.Open(path, syscall.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_CLOEXEC|syscall.O_NONBLOCK, 0)
	if err != nil {
		if errors.Is(err, syscall.ENOENT) {
			return nil, os.ErrNotExist
		}
		if errors.Is(err, syscall.ELOOP) {
			return nil, fmt.Errorf("%s must not be a symbolic link", filepath.Base(path))
		}
		return nil, fmt.Errorf("cannot open %s", filepath.Base(path))
	}
	file := os.NewFile(uintptr(fd), path)
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return nil, fmt.Errorf("cannot inspect %s", filepath.Base(path))
	}
	if !info.Mode().IsRegular() {
		return nil, fmt.Errorf("%s must be a regular file", filepath.Base(path))
	}
	if info.Mode().Perm()&0o077 != 0 {
		return nil, fmt.Errorf("%s must be accessible only to its owner (chmod 600)", filepath.Base(path))
	}
	if stat, ok := info.Sys().(*syscall.Stat_t); ok && int(stat.Uid) != os.Geteuid() {
		return nil, fmt.Errorf("%s must belong to the current user", filepath.Base(path))
	}
	if info.Size() > limit {
		return nil, fmt.Errorf("%s exceeds its maximum size", filepath.Base(path))
	}
	data, err := io.ReadAll(io.LimitReader(file, limit+1))
	if err != nil {
		return nil, fmt.Errorf("cannot read %s", filepath.Base(path))
	}
	if int64(len(data)) > limit {
		return nil, fmt.Errorf("%s exceeds its maximum size", filepath.Base(path))
	}
	return data, nil
}

// WriteAtomic replaces path with a synced owner-only file. A crash leaves the
// previous contents or the new ones, never a partial file.
func WriteAtomic(path string, data []byte) error {
	dir := filepath.Dir(path)
	file, err := os.CreateTemp(dir, ".oa-tmp-*")
	if err != nil {
		return fmt.Errorf("cannot create temporary file for %s", filepath.Base(path))
	}
	name := file.Name()
	defer os.Remove(name)
	if err := file.Chmod(0o600); err != nil {
		file.Close()
		return fmt.Errorf("cannot protect %s", filepath.Base(path))
	}
	if _, err := file.Write(data); err != nil {
		file.Close()
		return fmt.Errorf("cannot write %s", filepath.Base(path))
	}
	if err := file.Sync(); err != nil {
		file.Close()
		return fmt.Errorf("cannot sync %s", filepath.Base(path))
	}
	if err := file.Close(); err != nil {
		return fmt.Errorf("cannot close %s", filepath.Base(path))
	}
	if err := os.Rename(name, path); err != nil {
		return fmt.Errorf("cannot replace %s", filepath.Base(path))
	}
	return SyncDir(dir)
}

// SyncDir makes a rename or removal in dir durable.
func SyncDir(dir string) error {
	file, err := os.Open(dir)
	if err != nil {
		return err
	}
	defer file.Close()
	return file.Sync()
}

// Remove deletes a file durably. A missing file is not an error.
func Remove(path string) error {
	if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("cannot remove %s", filepath.Base(path))
	}
	return SyncDir(filepath.Dir(path))
}

// Lock is an exclusive flock on a stable inode beside the files it guards. The
// kernel releases it on a crash, so no recovery step can find a stale lock.
type Lock struct{ file *os.File }

func open(path string) (*os.File, error) {
	fd, err := syscall.Open(path, syscall.O_RDWR|syscall.O_CREAT|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0o600)
	if err != nil {
		return nil, fmt.Errorf("cannot open lock %s", filepath.Base(path))
	}
	file := os.NewFile(uintptr(fd), path)
	if err := file.Chmod(0o600); err != nil {
		file.Close()
		return nil, fmt.Errorf("cannot protect lock %s", filepath.Base(path))
	}
	return file, nil
}

// TryLock takes the lock now or reports ErrLocked.
func TryLock(path string) (*Lock, error) {
	file, err := open(path)
	if err != nil {
		return nil, err
	}
	if err := syscall.Flock(int(file.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		file.Close()
		if errors.Is(err, syscall.EWOULDBLOCK) {
			return nil, ErrLocked
		}
		return nil, fmt.Errorf("cannot lock %s", filepath.Base(path))
	}
	return &Lock{file: file}, nil
}

// ErrLocked means another process holds the lock.
var ErrLocked = errors.New("locked by another process")

// AcquireLock waits for the lock until ctx ends.
func AcquireLock(ctx context.Context, path string) (*Lock, error) {
	for {
		lock, err := TryLock(path)
		if err == nil {
			return lock, nil
		}
		if !errors.Is(err, ErrLocked) {
			return nil, err
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(20 * time.Millisecond):
		}
	}
}

// Release unlocks. The inode stays so waiters and later holders share it.
func (l *Lock) Release() {
	if l == nil || l.file == nil {
		return
	}
	_ = syscall.Flock(int(l.file.Fd()), syscall.LOCK_UN)
	_ = l.file.Close()
	l.file = nil
}
