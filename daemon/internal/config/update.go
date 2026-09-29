package config

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"syscall"
)

// Update changes settings without replacing credentials or touching either
// wallet. The daemon's stable lock prevents changes to an active profile, and
// the expected snapshot prevents a second configuration editor losing edits.
func Update(dir string, previous, next Config) error {
	if err := Validate(next); err != nil {
		return err
	}
	if next.APIKey != previous.APIKey || next.ZKAPI.BridgeToken != previous.ZKAPI.BridgeToken || next.ManagementToken != previous.ManagementToken {
		return errors.New("configuration edits must preserve existing credentials")
	}
	if next.OrgURL != previous.OrgURL {
		return errors.New("ticket organization cannot be changed in an existing profile; use a separate configuration directory")
	}
	if err := EnsureDir(dir); err != nil {
		return err
	}
	path := filepath.Join(dir, "daemon.lock")
	fd, err := syscall.Open(path, syscall.O_RDWR|syscall.O_CREAT|syscall.O_NOFOLLOW|syscall.O_NONBLOCK|syscall.O_CLOEXEC, 0600)
	if err != nil {
		return errors.New("cannot lock configuration for editing; preserve the existing profile")
	}
	lock := os.NewFile(uintptr(fd), path)
	defer lock.Close()
	info, err := lock.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Mode().Perm() != 0600 {
		return errors.New("daemon.lock must be a regular owner-only file (chmod 600)")
	}
	if owner, ok := info.Sys().(*syscall.Stat_t); !ok || owner.Uid != uint32(os.Geteuid()) {
		return errors.New("daemon.lock must belong to the current user")
	}
	if err := syscall.Flock(fd, syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		return errors.New("this profile is in use; stop oa-chat serve before editing its configuration")
	}
	defer syscall.Flock(fd, syscall.LOCK_UN)
	current, err := Load(dir)
	if err != nil {
		return err
	}
	if current != previous {
		return errors.New("configuration changed while being edited; run oa-chat config again to review the current settings")
	}
	data, err := json.MarshalIndent(next, "", "  ")
	if err != nil {
		return err
	}
	file, err := os.CreateTemp(dir, ".config-*")
	if err != nil {
		return err
	}
	temporary := file.Name()
	defer os.Remove(temporary)
	if _, err := file.Write(append(data, '\n')); err != nil {
		file.Close()
		return err
	}
	if err := file.Sync(); err != nil {
		file.Close()
		return err
	}
	if err := file.Close(); err != nil {
		return err
	}
	if err := os.Rename(temporary, filepath.Join(dir, "config.json")); err != nil {
		return err
	}
	return syncDir(dir)
}
