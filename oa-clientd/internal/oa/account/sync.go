package account

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math/rand/v2"
	"net/http"
	"regexp"
	"sort"
	"time"

	"github.com/OpenAnonymity/oa-chat/oa-clientd/internal/oa/securefile"
	"github.com/OpenAnonymity/oa-chat/oa-clientd/internal/oa/wallet"
)

const (
	maxBlobsPerRequest = 100
	maxUploadBytes     = 3500 * 1024
	blobEnvelopeBytes  = 64
)

// ErrWrongKey means this key cannot read the account's own wallet. Nothing is
// pushed: writing here would overwrite the account's data with a foreign replica.
var ErrWrongKey = errors.New("this computer's sync key cannot read the account's wallet; nothing was changed. Run oa-clientd logout, then oa-clientd login")

// Syncer merges the replica with the account's encrypted blobs. It uses the
// browser's format, so a browser reads what it writes and the reverse.
type Syncer struct {
	Session   *Session
	Store     *wallet.Store
	LeaseSize int
	Now       func() time.Time
}

// Outcome reports one sync in counts only.
type Outcome struct {
	Pulled, Pushed int
	Active         int
	Available      int
	Skipped        bool
}

func (s *Syncer) now() time.Time {
	if s.Now != nil {
		return s.Now()
	}
	return time.Now()
}

type blobPayload struct {
	Type        string          `json:"type"`
	Data        json.RawMessage `json:"data,omitempty"`
	KeyID       string          `json:"key_id,omitempty"`
	DeviceID    string          `json:"device_id,omitempty"`
	Fingerprint []string        `json:"fingerprints,omitempty"`
	ExpiresAt   int64           `json:"expires_at_ms,omitempty"`
}

var keyIDPattern = regexp.MustCompile(`^[0-9a-f]{64}$`)
var deviceIDPattern = regexp.MustCompile(`^[0-9a-f]{32}$`)

// decodeRemote decrypts a pull. A fixed blob that will not open is fatal: it
// means a wrong key, and continuing would replace the account's data. Unknown
// IDs may be per-generation or per-device records, or a newer client's own; they
// are probed and otherwise left alone.
func decodeRemote(master []byte, blobs []Blob) (wallet.Remote, error) {
	fixed := map[string]string{
		BlobID(master, logicalActive):      logicalActive,
		BlobID(master, logicalArchive):     logicalArchive,
		BlobID(master, logicalTombstones):  logicalTombstones,
		BlobID(master, logicalInvalidated): logicalInvalidated,
	}
	remote := wallet.Remote{Leases: map[string]wallet.Lease{}}
	for _, blob := range blobs {
		if blob.Ciphertext == "" || blob.IV == "" {
			continue
		}
		if logical, ok := fixed[blob.ID]; ok {
			plaintext, err := Open(master, logical, blob)
			if err != nil {
				return wallet.Remote{}, ErrWrongKey
			}
			var payload blobPayload
			if err := json.Unmarshal(plaintext, &payload); err != nil {
				return wallet.Remote{}, errors.New("the account's wallet holds a record this client cannot read; nothing was changed")
			}
			switch logical {
			case logicalActive, logicalArchive:
				var tickets []wallet.Ticket
				if payload.Type != "tickets" || json.Unmarshal(payload.Data, &tickets) != nil {
					return wallet.Remote{}, errors.New("the account's wallet holds a record this client cannot read; nothing was changed")
				}
				if logical == logicalActive {
					remote.Active = append(remote.Active, tickets...)
				} else {
					// Append: the org returns blobs by update time, so a removal
					// record can arrive before the shared archive a stale device
					// overwrote, and exactly that record must survive.
					remote.Archive = append(remote.Archive, tickets...)
				}
			case logicalTombstones:
				var tombstones []wallet.Tombstone
				if payload.Type != "tickets" || json.Unmarshal(payload.Data, &tombstones) != nil {
					return wallet.Remote{}, errors.New("the account's wallet holds a record this client cannot read; nothing was changed")
				}
				remote.Tombstones = append(remote.Tombstones, tombstones...)
			case logicalInvalidated:
				var ids []string
				if payload.Type != "ticket-invalidations" || json.Unmarshal(payload.Data, &ids) != nil {
					return wallet.Remote{}, errors.New("the account's wallet holds a record this client cannot read; nothing was changed")
				}
				remote.Invalidated = append(remote.Invalidated, ids...)
			}
			continue
		}
		if plaintext, err := Open(master, logicalInvalidItem, blob); err == nil {
			var payload blobPayload
			if json.Unmarshal(plaintext, &payload) == nil && payload.Type == "ticket-invalidation" && keyIDPattern.MatchString(payload.KeyID) &&
				BlobID(master, logicalInvalidItem+":"+payload.KeyID) == blob.ID {
				remote.Invalidated = append(remote.Invalidated, payload.KeyID)
			}
			continue
		}
		if plaintext, err := Open(master, logicalRemovals, blob); err == nil {
			var removals removalsPayload
			if json.Unmarshal(plaintext, &removals) == nil && removals.Type == "ticket-removals" && deviceIDPattern.MatchString(removals.WriterID) &&
				BlobID(master, logicalRemovals+":"+removals.WriterID) == blob.ID {
				remote.Archive = append(remote.Archive, removals.Archived...)
				remote.Tombstones = append(remote.Tombstones, removals.Tombstones...)
			}
			continue
		}
		if plaintext, err := Open(master, logicalLeaseItem, blob); err == nil {
			var payload blobPayload
			if json.Unmarshal(plaintext, &payload) == nil && payload.Type == "ticket-lease" && deviceIDPattern.MatchString(payload.DeviceID) &&
				BlobID(master, logicalLeaseItem+":"+payload.DeviceID) == blob.ID {
				remote.Leases[payload.DeviceID] = wallet.Lease{Fingerprints: payload.Fingerprint, ExpiresAtMS: payload.ExpiresAt}
			}
		}
	}
	return remote, nil
}

// removalsPayload is the browser's per-installation record of consumed and
// removed tickets.
type removalsPayload struct {
	Type       string             `json:"type"`
	WriterID   string             `json:"writer_id"`
	Archived   []wallet.Ticket    `json:"archived"`
	Tombstones []wallet.Tombstone `json:"tombstones"`
}

func ticketPayload(tickets []wallet.Ticket) (blobPayload, error) {
	data, err := json.Marshal(wallet.CanonicalTickets(tickets))
	if err != nil {
		return blobPayload{}, errors.New("cannot encode tickets")
	}
	return blobPayload{Type: "tickets", Data: data}, nil
}

// buildBlobs seals the replica. Reserved tickets stay in the active record: the
// org has not decided them, and a peer that spends one simply loses the race.
func buildBlobs(master []byte, state *wallet.State, includeWallet, includeLease bool) ([]Blob, error) {
	var blobs []Blob
	if includeWallet {
		active := append([]wallet.Ticket{}, state.Active...)
		for _, reservation := range state.Pending {
			active = append(active, reservation.Tickets...)
		}
		for _, entry := range []struct {
			logical string
			tickets []wallet.Ticket
		}{{logicalActive, active}, {logicalArchive, state.Archive}} {
			payload, err := ticketPayload(entry.tickets)
			if err != nil {
				return nil, err
			}
			blob, err := Seal(master, entry.logical, BlobID(master, entry.logical), payload)
			if err != nil {
				return nil, err
			}
			blobs = append(blobs, blob)
		}
		tombstones := state.Tombstones
		if tombstones == nil {
			tombstones = []wallet.Tombstone{}
		}
		data, err := json.Marshal(tombstones)
		if err != nil {
			return nil, errors.New("cannot encode tombstones")
		}
		blob, err := Seal(master, logicalTombstones, BlobID(master, logicalTombstones), blobPayload{Type: "tickets", Data: data})
		if err != nil {
			return nil, err
		}
		blobs = append(blobs, blob)
		removals, err := Seal(master, logicalRemovals, BlobID(master, logicalRemovals+":"+state.DeviceID), removalsPayload{
			Type: "ticket-removals", WriterID: state.DeviceID, Archived: wallet.CanonicalTickets(state.Archive), Tombstones: tombstones,
		})
		if err != nil {
			return nil, err
		}
		blobs = append(blobs, removals)
		if len(state.Invalidated) > 0 {
			data, err := json.Marshal(state.Invalidated)
			if err != nil {
				return nil, errors.New("cannot encode invalidated generations")
			}
			blob, err := Seal(master, logicalInvalidated, BlobID(master, logicalInvalidated), blobPayload{Type: "ticket-invalidations", Data: data})
			if err != nil {
				return nil, err
			}
			blobs = append(blobs, blob)
			for _, id := range state.Invalidated {
				item, err := Seal(master, logicalInvalidItem, BlobID(master, logicalInvalidItem+":"+id), blobPayload{Type: "ticket-invalidation", KeyID: id})
				if err != nil {
					return nil, err
				}
				blobs = append(blobs, item)
			}
		}
	}
	if includeLease {
		fingerprints := append([]string{}, state.Lease.Fingerprints...)
		sort.Strings(fingerprints)
		payload := struct {
			Type         string   `json:"type"`
			DeviceID     string   `json:"device_id"`
			Fingerprints []string `json:"fingerprints"`
			ExpiresAtMS  int64    `json:"expires_at_ms"`
		}{"ticket-lease", state.DeviceID, fingerprints, state.Lease.ExpiresAtMS}
		blob, err := Seal(master, logicalLeaseItem, BlobID(master, logicalLeaseItem+":"+state.DeviceID), payload)
		if err != nil {
			return nil, err
		}
		blobs = append(blobs, blob)
	}
	return blobs, nil
}

func (s *Syncer) pull(ctx context.Context) ([]Blob, int64, error) {
	status, data, err := s.Session.Do(ctx, http.MethodGet, "/auth/sync?since=0", nil)
	if err != nil {
		return nil, 0, err
	}
	if status < 200 || status >= 300 {
		return nil, 0, &statusError{Status: status, Code: errorCode(data)}
	}
	var response struct {
		Blobs      []Blob `json:"blobs"`
		ServerTime int64  `json:"server_time"`
	}
	if err := json.Unmarshal(data, &response); err != nil {
		return nil, 0, errors.New("OA account service returned an invalid sync response")
	}
	return response.Blobs, response.ServerTime, nil
}

// uploadBatches splits blobs by the org's per-request count and the browser's
// request-size bound.
func uploadBatches(blobs []Blob) ([][]Blob, error) {
	var batches [][]Blob
	var current []Blob
	size := 0
	for _, blob := range blobs {
		item := len(blob.ID) + len(blob.Ciphertext) + len(blob.IV) + blobEnvelopeBytes
		if item > maxUploadBytes {
			return nil, errors.New("a wallet record is too large to upload")
		}
		if len(current) == maxBlobsPerRequest || size+item > maxUploadBytes {
			batches = append(batches, current)
			current, size = nil, 0
		}
		current = append(current, blob)
		size += item
	}
	if len(current) > 0 {
		batches = append(batches, current)
	}
	return batches, nil
}

func (s *Syncer) push(ctx context.Context, blobs []Blob) (int, error) {
	batches, err := uploadBatches(blobs)
	if err != nil {
		return 0, err
	}
	accepted := 0
	for _, batch := range batches {
		body, err := json.Marshal(map[string]any{"blobs": batch})
		if err != nil {
			return accepted, errors.New("cannot encode sync push")
		}
		status, data, err := s.Session.Do(ctx, http.MethodPost, "/auth/sync", body)
		if err != nil {
			return accepted, err
		}
		if status < 200 || status >= 300 {
			return accepted, &statusError{Status: status, Code: errorCode(data)}
		}
		var response struct {
			Accepted []string `json:"accepted"`
		}
		if err := json.Unmarshal(data, &response); err != nil {
			return accepted, errors.New("OA account service returned an invalid sync response")
		}
		if len(response.Accepted) != len(batch) {
			return accepted + len(response.Accepted), errors.New("OA account service stored only part of the wallet")
		}
		accepted += len(batch)
	}
	return accepted, nil
}

// Exclusive runs fn holding the profile's sync lock, across processes, so one
// pull-merge-push, final sync or account change happens at a time. A delayed push
// cannot land after a newer final sync. Order: this lock, then the short session
// and wallet locks; never the reverse, and those are not held over the network.
func (s *Syncer) Exclusive(ctx context.Context, fn func() error) error {
	lock, err := securefile.AcquireLock(ctx, s.Session.syncLockPath())
	if err != nil {
		return err
	}
	defer lock.Release()
	return fn()
}

// Once runs one full sync under the sync lock.
func (s *Syncer) Once(ctx context.Context) (Outcome, error) {
	var outcome Outcome
	err := s.Exclusive(ctx, func() error {
		var err error
		outcome, err = s.onceLocked(ctx, s.LeaseSize)
		return err
	})
	return outcome, err
}

// onceLocked runs one full sync. Each committed step leaves a state a retry can
// continue from: a failed pull changes nothing, and a failed push keeps the
// dirty flags, so the next sync sends the same merged data.
func (s *Syncer) onceLocked(ctx context.Context, leaseSize int) (Outcome, error) {
	identity, err := s.Session.Load(ctx)
	if err != nil {
		return Outcome{}, err
	}
	if err := s.Store.Create(ctx, identity.OrgURL, identity.AccountID, identity.DeviceID); err != nil {
		return Outcome{}, err
	}
	blobs, serverTime, err := s.pull(ctx)
	if err != nil {
		return Outcome{}, err
	}
	remote, err := decodeRemote(identity.MasterKey, blobs)
	if err != nil {
		return Outcome{}, err
	}
	now := s.now()
	var needsWallet, needsLease bool
	var outgoing []Blob
	var outcome Outcome
	err = s.Store.Update(ctx, func(state *wallet.State) error {
		if state.AccountID != identity.AccountID || state.OrgURL != identity.OrgURL {
			return wallet.ErrOtherAccount
		}
		state.DeviceID = identity.DeviceID
		merged := state.Merge(remote)
		// Never lease more than half a small wallet, so a running daemon cannot
		// leave an open browser with a balance it may not spend.
		state.RefreshLease(min(leaseSize, (len(state.Active)+1)/2), now)
		state.RemoteTime = serverTime
		needsWallet = merged || state.Dirty
		needsLease = state.LeaseDirty
		if state.Dirty && !merged {
			// Dirty but already reflected remotely: nothing to send.
			needsWallet = false
			state.Dirty = false
		} else if merged {
			state.Dirty = true
		}
		outcome.Pulled = len(blobs)
		outcome.Active = len(state.Active)
		outcome.Available = state.Available(now)
		if !needsWallet && !needsLease {
			return nil
		}
		var err error
		outgoing, err = buildBlobs(identity.MasterKey, state, needsWallet, needsLease)
		return err
	})
	if err != nil {
		return Outcome{}, err
	}
	if len(outgoing) == 0 {
		outcome.Skipped = true
		err := s.Store.Update(ctx, func(state *wallet.State) error {
			state.LastSyncMS = now.UnixMilli()
			return nil
		})
		return outcome, err
	}
	pushed, err := s.push(ctx, outgoing)
	outcome.Pushed = pushed
	if err != nil {
		return outcome, err
	}
	err = s.Store.Update(ctx, func(state *wallet.State) error {
		// Only what was sealed above is known to be remote. A redemption since
		// then set the flags again and belongs to the next sync; compare by
		// content so it is not cleared here.
		if needsWallet && !walletChangedSince(identity.MasterKey, state, outgoing) {
			state.Dirty = false
		}
		if needsLease && !leaseChangedSince(identity.MasterKey, state, outgoing) {
			state.LeaseDirty = false
		}
		state.LastSyncMS = now.UnixMilli()
		return nil
	})
	return outcome, err
}

// walletChangedSince decrypts what was pushed and compares tokens, so a
// concurrent redemption keeps its dirty flag.
func walletChangedSince(master []byte, state *wallet.State, pushed []Blob) bool {
	for _, blob := range pushed {
		switch blob.ID {
		case BlobID(master, logicalActive):
			active := append([]wallet.Ticket{}, state.Active...)
			for _, reservation := range state.Pending {
				active = append(active, reservation.Tickets...)
			}
			if !blobHolds(master, logicalActive, blob, active) {
				return true
			}
		case BlobID(master, logicalArchive):
			if !blobHolds(master, logicalArchive, blob, state.Archive) {
				return true
			}
		}
	}
	return false
}

func blobHolds(master []byte, logical string, blob Blob, tickets []wallet.Ticket) bool {
	plaintext, err := Open(master, logical, blob)
	if err != nil {
		return false
	}
	var payload blobPayload
	var held []wallet.Ticket
	if json.Unmarshal(plaintext, &payload) != nil || json.Unmarshal(payload.Data, &held) != nil {
		return false
	}
	return wallet.Equal(held, tickets)
}

func leaseChangedSince(master []byte, state *wallet.State, pushed []Blob) bool {
	id := BlobID(master, logicalLeaseItem+":"+state.DeviceID)
	for _, blob := range pushed {
		if blob.ID != id {
			continue
		}
		plaintext, err := Open(master, logicalLeaseItem, blob)
		if err != nil {
			return true
		}
		var payload blobPayload
		if json.Unmarshal(plaintext, &payload) != nil {
			return true
		}
		if payload.ExpiresAt != state.Lease.ExpiresAtMS || len(payload.Fingerprint) != len(state.Lease.Fingerprints) {
			return true
		}
		held := map[string]bool{}
		for _, fingerprint := range payload.Fingerprint {
			held[fingerprint] = true
		}
		for _, fingerprint := range state.Lease.Fingerprints {
			if !held[fingerprint] {
				return true
			}
		}
		return false
	}
	return true
}

// Run syncs until ctx ends. The wait is jittered and redemption never shortens
// it, so an authenticated sync is not a signal of a recent redemption. A failure
// backs off and stays quiet except for one fixed line per state change. A signed
// out computer keeps checking its local files only, so oa-clientd login resumes
// sync in a running service without a restart.
func (s *Syncer) Run(ctx context.Context, base time.Duration, report func(Outcome, error)) {
	failures := 0
	for {
		outcome, err := s.Once(ctx)
		if ctx.Err() != nil {
			return
		}
		report(outcome, err)
		wait := base + time.Duration(rand.Int64N(int64(base)))
		if err != nil {
			failures++
			backoff := time.Duration(1<<min(failures, 5)) * 15 * time.Second
			wait = min(backoff, wait) + time.Duration(rand.Int64N(int64(15*time.Second)))
		} else {
			failures = 0
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(wait):
		}
	}
}

// FinalizeLocked pushes everything and releases the lease for logout. The caller
// holds Exclusive and keeps it through erasure. It reports an error if the account
// does not yet hold this computer's consumed tickets.
func (s *Syncer) FinalizeLocked(ctx context.Context) error {
	if err := s.Store.Update(ctx, func(state *wallet.State) error {
		state.ReleaseLease()
		state.Dirty = true
		return nil
	}); err != nil {
		return err
	}
	if _, err := s.onceLocked(ctx, 0); err != nil {
		return fmt.Errorf("the final sync failed: %w", err)
	}
	return nil
}

// Finalize is FinalizeLocked under its own Exclusive.
func (s *Syncer) Finalize(ctx context.Context) error {
	return s.Exclusive(ctx, func() error { return s.FinalizeLocked(ctx) })
}

// ErrBindingLost means a concurrent login bound this profile first. The new session
// was revoked and nothing here changed.
var ErrBindingLost = errors.New("this profile now belongs to another account or OA deployment; the new authorization was ended. Run oa-clientd logout first, or use a separate --config-dir")

// CommitAuthorization installs a completed authorization. It rechecks the profile's
// binding at the last moment, since browser approval can take minutes and another
// login may have finished. Unless the new session is saved, it is revoked with its
// own token, whatever the reason: a lost race, a cancelled wait, a lock or file error.
// The installed session is replaced only after that save, so a failure leaves it
// working.
func (s *Syncer) CommitAuthorization(ctx context.Context, identity *Identity, recheck func() error) error {
	committed := false
	defer func() {
		if !committed {
			s.Session.RevokeIdentity(ctx, identity)
		}
	}()
	return s.Exclusive(ctx, func() error {
		if recheck != nil {
			if err := recheck(); err != nil {
				return err
			}
		}
		walletExisted := true
		err := s.Store.View(ctx, func(state *wallet.State) error {
			if state.AccountID != identity.AccountID || state.OrgURL != identity.OrgURL {
				return ErrBindingLost
			}
			// The wallet's device keeps its lease and removal records.
			identity.DeviceID = state.DeviceID
			return nil
		})
		switch {
		case errors.Is(err, wallet.ErrNoWallet):
			walletExisted = false
		case errors.Is(err, ErrBindingLost):
			return err
		case err != nil:
			return errors.New("the wallet could not be checked; the new authorization was ended")
		}
		previous, err := s.Session.Load(ctx)
		if err != nil && !errors.Is(err, ErrSignedOut) {
			return ErrBindingLost
		}
		if err == nil && previous.AccountID != identity.AccountID {
			return ErrBindingLost
		}
		if err := s.Store.Create(ctx, identity.OrgURL, identity.AccountID, identity.DeviceID); err != nil {
			return err
		}
		if err := s.Session.Save(ctx, identity); err != nil {
			if !walletExisted {
				// Nothing was ever in it: this failed login must not bind the profile.
				_ = s.Store.Delete(context.WithoutCancel(ctx))
			}
			return err
		}
		committed = true
		// This computer's earlier session must not stay live beside the new one.
		// Best effort: an unreachable org lets the old one expire.
		if previous != nil {
			s.Session.RevokeIdentity(ctx, previous)
		}
		return nil
	})
}
