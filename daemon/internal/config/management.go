package config

import (
	"encoding/hex"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"syscall"
)

const managementTokenFile = "management-token"

func loadManagementToken(dir string) (string, error) {
	path := filepath.Join(dir, managementTokenFile)
	token, err := readManagementToken(path)
	if errors.Is(err, os.ErrNotExist) {
		// Link a complete, synced temporary file without replacing an existing
		// credential. Concurrent Load calls all read the winning inode, and no
		// reader can observe a partially written credential.
		token, err = Secret()
		if err != nil {
			return "", errors.New("cannot generate local management credential")
		}
		file, err := os.CreateTemp(dir, ".management-token-*")
		if err != nil {
			return "", errors.New("cannot create local management credential")
		}
		temporary := file.Name()
		defer os.Remove(temporary)
		if _, err := io.WriteString(file, token+"\n"); err != nil {
			file.Close()
			return "", errors.New("cannot write local management credential")
		}
		if err := file.Sync(); err != nil {
			file.Close()
			return "", errors.New("cannot sync local management credential")
		}
		if err := file.Close(); err != nil {
			return "", errors.New("cannot close local management credential")
		}
		if err := os.Link(temporary, path); err != nil && !errors.Is(err, os.ErrExist) {
			return "", errors.New("cannot persist local management credential")
		}
		if err := os.Remove(temporary); err != nil {
			return "", errors.New("cannot finish local management credential creation")
		}
		created, readErr := readManagementToken(path)
		if readErr != nil {
			return "", readErr
		}
		token = created
	}
	if err != nil {
		return "", err
	}
	// A concurrent creator may have linked the inode but not yet synced the
	// directory. Every successful reader makes that name durable before use.
	if err := syncDir(dir); err != nil {
		return "", errors.New("cannot sync local management credential directory")
	}
	return token, nil
}

func readManagementToken(path string) (string, error) {
	// Reject symlinks at open time, including replacement between a metadata
	// check and open. Nonblocking prevents a malformed FIFO from hanging Load.
	fd, err := syscall.Open(path, syscall.O_RDONLY|syscall.O_CLOEXEC|syscall.O_NOFOLLOW|syscall.O_NONBLOCK, 0)
	if err != nil {
		if errors.Is(err, syscall.ENOENT) {
			return "", os.ErrNotExist
		}
		return "", errors.New("management-token must be a readable regular owner-only file (chmod 600)")
	}
	file := os.NewFile(uintptr(fd), path)
	defer file.Close()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Mode().Perm() != 0600 || info.Size() > 65 {
		return "", errors.New("management-token must be a regular owner-only file (chmod 600)")
	}
	if owner, ok := info.Sys().(*syscall.Stat_t); !ok || owner.Uid != uint32(os.Geteuid()) {
		return "", errors.New("management-token must belong to the current user")
	}
	data, err := io.ReadAll(io.LimitReader(file, 66))
	if err != nil {
		return "", errors.New("cannot read local management credential")
	}
	token := strings.TrimSuffix(string(data), "\n")
	decoded, err := hex.DecodeString(token)
	if err != nil || len(token) != 64 || len(decoded) != 32 {
		return "", errors.New("management-token is invalid; preserve existing configuration and credentials")
	}
	return token, nil
}
