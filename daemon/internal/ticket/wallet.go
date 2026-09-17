package ticket

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"time"
)

const maxWalletSize = 128 << 20

type record struct {
	Token string `json:"finalized_ticket"`
	KeyID string `json:"ticket_key_id"`
}

type reservation struct {
	Model   string   `json:"model"`
	Tickets []record `json:"tickets"`
}

type issuance struct {
	Code      string       `json:"code"`
	PublicKey string       `json:"public_key"`
	KeyID     string       `json:"key_id"`
	States    []blindState `json:"states"`
}

type wallet struct {
	Version     int             `json:"version"`
	OrgURL      string          `json:"org_url"`
	Active      []record        `json:"active"`
	Spent       map[string]bool `json:"spent"`
	Invalidated map[string]bool `json:"invalidated"`
	Pending     *reservation    `json:"pending,omitempty"`
	Issuance    *issuance       `json:"issuance,omitempty"`
}

// A separate, stable lock inode protects atomic wallet replacement across the
// service and concurrently running import commands. Locks release on crashes.
func (b *Backend) withWallet(ctx context.Context, fn func(*wallet) error) error {
	if err := os.MkdirAll(filepath.Dir(b.cfg.WalletPath), 0700); err != nil {
		return err
	}
	path := b.cfg.WalletPath + ".lock"
	fd, err := syscall.Open(path, syscall.O_RDWR|syscall.O_CREAT|syscall.O_NOFOLLOW, 0600)
	if err != nil {
		return fmt.Errorf("open wallet lock: %w", err)
	}
	f := os.NewFile(uintptr(fd), path)
	defer f.Close()
	if err := f.Chmod(0600); err != nil {
		return err
	}
	for {
		err = syscall.Flock(fd, syscall.LOCK_EX|syscall.LOCK_NB)
		if err == nil {
			break
		}
		if err != syscall.EWOULDBLOCK && err != syscall.EAGAIN {
			return err
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(25 * time.Millisecond):
		}
	}
	defer syscall.Flock(fd, syscall.LOCK_UN)
	w := wallet{Version: 1, OrgURL: b.cfg.OrgURL, Spent: map[string]bool{}, Invalidated: map[string]bool{}}
	if fi, err := os.Lstat(b.cfg.WalletPath); err == nil {
		if !fi.Mode().IsRegular() || fi.Mode().Perm()&0077 != 0 {
			return errors.New("wallet must be a regular file accessible only to its owner (chmod 600)")
		}
		if fi.Size() > maxWalletSize {
			return errors.New("wallet exceeds maximum size")
		}
		data, err := os.ReadFile(b.cfg.WalletPath)
		if err != nil {
			return err
		}
		if err = json.Unmarshal(data, &w); err != nil {
			return errors.New("wallet is not valid JSON")
		}
		if w.Version != 1 || w.OrgURL != b.cfg.OrgURL {
			return errors.New("wallet version or organization does not match configuration; use a separate config directory for staging")
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if w.Spent == nil {
		w.Spent = map[string]bool{}
	}
	if w.Invalidated == nil {
		w.Invalidated = map[string]bool{}
	}
	return fn(&w)
}

func (b *Backend) saveWallet(w *wallet) error {
	data, err := json.Marshal(w)
	if err != nil {
		return err
	}
	f, err := os.CreateTemp(filepath.Dir(b.cfg.WalletPath), ".oa-tickets-*")
	if err != nil {
		return err
	}
	name := f.Name()
	defer os.Remove(name)
	if _, err = f.Write(data); err == nil {
		err = f.Sync()
	}
	closeErr := f.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	if err = os.Rename(name, b.cfg.WalletPath); err != nil {
		return err
	}
	dir, err := os.Open(filepath.Dir(b.cfg.WalletPath))
	if err != nil {
		return err
	}
	defer dir.Close()
	return dir.Sync()
}

func (b *Backend) Count() (int, error) {
	return b.CountContext(context.Background())
}

// CountContext lets interactive status checks stop waiting for a wallet lock
// held by an issuance/import operation, including on SIGINT or service timeout.
func (b *Backend) CountContext(ctx context.Context) (int, error) {
	n := 0
	err := b.withWallet(ctx, func(w *wallet) error { n = len(w.Active); return nil })
	return n, err
}

type importRecord struct {
	Token         string          `json:"finalized_ticket"`
	Status        string          `json:"status"`
	Used          bool            `json:"used"`
	ConsumedAt    json.RawMessage `json:"consumed_at"`
	UsedAt        json.RawMessage `json:"used_at"`
	InvalidatedAt json.RawMessage `json:"invalidated_at"`
}

func importRows(raw json.RawMessage, archived bool, depth int) ([]importRecord, []importRecord, error) {
	if depth > 8 {
		return nil, nil, errors.New("ticket file nesting is too deep")
	}
	var rows []importRecord
	if err := json.Unmarshal(raw, &rows); err == nil && rows != nil {
		var active, spent []importRecord
		for _, row := range rows {
			status := strings.ToLower(row.Status)
			used := archived || row.Used || status == "archived" || status == "consumed" || status == "used" || status == "invalidated" || hasValue(row.ConsumedAt) || hasValue(row.UsedAt) || hasValue(row.InvalidatedAt)
			if used {
				spent = append(spent, row)
			} else {
				active = append(active, row)
			}
		}
		return active, spent, nil
	}
	var obj map[string]json.RawMessage
	if err := json.Unmarshal(raw, &obj); err != nil {
		return nil, nil, errors.New("invalid ticket export")
	}
	for _, field := range []string{"data", "tickets"} {
		if nested, ok := obj[field]; ok {
			return importRows(nested, archived, depth+1)
		}
	}
	var active, spent []importRecord
	found := false
	for _, field := range []string{"active", "activeTickets", "archived", "archivedTickets"} {
		if nested, ok := obj[field]; ok {
			found = true
			a, s, err := importRows(nested, archived || strings.HasPrefix(field, "archived"), depth+1)
			if err != nil {
				return nil, nil, err
			}
			active = append(active, a...)
			spent = append(spent, s...)
		}
	}
	if !found {
		return nil, nil, errors.New("no tickets found in import file")
	}
	return active, spent, nil
}

func hasValue(raw json.RawMessage) bool {
	return len(raw) > 0 && string(raw) != "null" && string(raw) != "\"\"" && string(raw) != "false"
}

// Import accepts the same ticket-only and full-backup envelopes as the web UI.
// It strips issuance metadata and persists canonical token hashes as tombstones
// so importing an old export cannot resurrect an already spent ticket.
func (b *Backend) Import(ctx context.Context, r io.Reader) (int, error) {
	data, err := io.ReadAll(io.LimitReader(r, maxWalletSize+1))
	if err != nil {
		return 0, err
	}
	if len(data) > maxWalletSize {
		return 0, errors.New("ticket export is too large")
	}
	active, spent, err := importRows(data, false, 0)
	if err != nil {
		return 0, err
	}
	var normalized []record
	var tombstones []string
	for _, row := range append(append([]importRecord{}, spent...), active...) {
		if _, _, err := normalizeToken(row.Token); err != nil {
			return 0, err
		}
	}
	for _, row := range spent {
		token, _, _ := normalizeToken(row.Token)
		tombstones = append(tombstones, digest([]byte(token)))
	}
	for _, row := range active {
		token, id, _ := normalizeToken(row.Token)
		normalized = append(normalized, record{Token: token, KeyID: id})
	}
	added := 0
	err = b.withWallet(ctx, func(w *wallet) error {
		for _, hash := range tombstones {
			w.Spent[hash] = true
		}
		kept := w.Active[:0]
		seen := map[string]bool{}
		for _, t := range w.Active {
			hash := digest([]byte(t.Token))
			if !w.Spent[hash] && !w.Invalidated[t.KeyID] {
				kept = append(kept, t)
				seen[hash] = true
			}
		}
		w.Active = kept
		for _, t := range normalized {
			hash := digest([]byte(t.Token))
			if !seen[hash] && !w.Spent[hash] && !w.Invalidated[t.KeyID] {
				w.Active = append(w.Active, t)
				seen[hash] = true
				added++
			}
		}
		return b.saveWallet(w)
	})
	if err != nil {
		return 0, err
	}
	return added, nil
}
