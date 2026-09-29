package config

import (
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"syscall"
)

const TestnetPasswordFile = "sepolia-password"

// SepoliaPassword is deliberately separate from wallet configuration and from
// the inference API credential. Environment overrides are never persisted.
func SepoliaPassword(dir, network string) (string, error) {
	if network != "sepolia" {
		return "", nil
	}
	if value, ok := os.LookupEnv("OA_ZKAPI_TESTNET_PASSWORD"); ok {
		return validateTestnetPassword(value)
	}
	path := os.Getenv("OA_ZKAPI_TESTNET_PASSWORD_FILE")
	if path == "" {
		path = filepath.Join(dir, TestnetPasswordFile)
	}
	fd, err := syscall.Open(path, syscall.O_RDONLY|syscall.O_CLOEXEC|syscall.O_NOFOLLOW|syscall.O_NONBLOCK, 0)
	if err != nil {
		if errors.Is(err, syscall.ENOENT) && os.Getenv("OA_ZKAPI_TESTNET_PASSWORD_FILE") == "" {
			return "", nil
		}
		return "", errors.New("Sepolia password file must be a readable regular owner-only file")
	}
	f := os.NewFile(uintptr(fd), path)
	defer f.Close()
	info, err := f.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Mode().Perm()&0077 != 0 || info.Size() > 1026 {
		return "", errors.New("Sepolia password file must be a regular owner-only file (chmod 600)")
	}
	if owner, ok := info.Sys().(*syscall.Stat_t); !ok || owner.Uid != uint32(os.Geteuid()) {
		return "", errors.New("Sepolia password file must belong to the current user")
	}
	data, err := io.ReadAll(io.LimitReader(f, 1027))
	if err != nil {
		return "", errors.New("could not read Sepolia password file")
	}
	return validateTestnetPassword(strings.TrimSuffix(strings.TrimSuffix(string(data), "\n"), "\r"))
}

func validateTestnetPassword(value string) (string, error) {
	if len(value) == 0 || len(value) > 1024 || strings.TrimSpace(value) != value {
		return "", errors.New("Sepolia password must contain 1–1024 characters without surrounding whitespace")
	}
	for _, c := range []byte(value) {
		if c < 0x20 || c > 0x7e {
			return "", errors.New("Sepolia password must use printable ASCII characters")
		}
	}
	return value, nil
}

func SaveSepoliaPassword(dir, value string) error {
	if _, err := validateTestnetPassword(value); err != nil {
		return err
	}
	if err := EnsureDir(dir); err != nil {
		return err
	}
	f, err := os.CreateTemp(dir, ".sepolia-password-*")
	if err != nil {
		return errors.New("could not save Sepolia password")
	}
	defer os.Remove(f.Name())
	defer f.Close()
	if _, err = io.WriteString(f, value+"\n"); err != nil {
		return errors.New("could not save Sepolia password")
	}
	if err = f.Sync(); err != nil {
		return err
	}
	if err = f.Close(); err != nil {
		return err
	}
	if err = os.Rename(f.Name(), filepath.Join(dir, TestnetPasswordFile)); err != nil {
		return errors.New("could not save Sepolia password")
	}
	return syncDir(dir)
}
