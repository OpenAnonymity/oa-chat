// Package wallet is oa-clientd's durable replica of an OA account's encrypted
// ticket wallet. It follows the browser's conflict rules: consumed state always
// wins, tombstones and invalidated generations are append-only, and unknown
// fields on a ticket record survive the round trip.
//
// Every state change is committed before the action it records, so a crash can
// retry an exact redemption but never resurrect a spent ticket.
package wallet

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/OpenAnonymity/oa-chat/oa-clientd/internal/oa/securefile"
)

const (
	stateFile    = "wallet.json"
	lockFile     = "wallet.lock"
	maxStateSize = 256 << 20
	stateVersion = 1
	// LeaseTTL bounds how long a stopped daemon can keep tickets from the web
	// app. The holder renews well before it ends; afterwards they are free.
	LeaseTTL = 6 * time.Hour
)

// Ticket is one wallet record. Raw keeps the browser's whole object, including
// its blinding fields and consumed_at, so a merge can never strip them.
type Ticket struct {
	Token string
	Raw   json.RawMessage
}

func (t Ticket) MarshalJSON() ([]byte, error) { return t.Raw, nil }

func (t *Ticket) UnmarshalJSON(data []byte) error {
	var head struct {
		Token string `json:"finalized_ticket"`
	}
	if err := json.Unmarshal(data, &head); err != nil {
		return err
	}
	t.Token = head.Token
	t.Raw = append(json.RawMessage(nil), data...)
	return nil
}

// Fingerprint is the browser's tombstone hash: SHA-256 of the exact stored
// token string, as lowercase hex.
func Fingerprint(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

// Consumed returns the record with consumed_at set, keeping every other field.
func (t Ticket) Consumed(now time.Time) Ticket {
	values := map[string]json.RawMessage{}
	if json.Unmarshal(t.Raw, &values) != nil {
		values = map[string]json.RawMessage{"finalized_ticket": mustJSON(t.Token)}
	}
	if existing, ok := values["consumed_at"]; !ok || string(existing) == "null" {
		values["consumed_at"] = mustJSON(now.UTC().Format("2006-01-02T15:04:05.000Z"))
	}
	raw, _ := json.Marshal(values)
	return Ticket{Token: t.Token, Raw: raw}
}

func mustJSON(v any) json.RawMessage {
	data, _ := json.Marshal(v)
	return data
}

// Tombstone is the browser's deletion record. Its fingerprint hides the token.
type Tombstone struct {
	Fingerprint string `json:"fingerprint"`
	RemovedAt   string `json:"removed_at,omitempty"`
}

// Lease says a device intends to spend these tickets. Other clients skip them
// until it expires. It is coordination, not enforcement: the org's single-spend
// check is what finally decides, and a client that ignores a lease only loses
// that race.
type Lease struct {
	Fingerprints []string `json:"fingerprints"`
	ExpiresAtMS  int64    `json:"expires_at_ms"`
}

// Reservation is tickets committed to one exact /api/request_key attempt. Its
// tokens are out of Active but not yet Archive: the org decides which. Retrying
// the identical token list is safe because the org replays the first response.
//
// Nonce names this redemption intent to the org, which keys its one-show replay
// on it. It is committed before the first send and never changes, so every retry
// and restart recovers this request's key, while another client holding the same
// tickets, whose nonce differs, can never receive it.
type Reservation struct {
	ID        string   `json:"id"`
	Nonce     string   `json:"nonce"`
	Cost      int      `json:"cost"`
	Tickets   []Ticket `json:"tickets"`
	CreatedMS int64    `json:"created_ms"`
}

// State is the persisted replica.
type State struct {
	Version     int             `json:"version"`
	OrgURL      string          `json:"org_url"`
	AccountID   string          `json:"account_id"`
	DeviceID    string          `json:"device_id"`
	Active      []Ticket        `json:"active"`
	Archive     []Ticket        `json:"archive"`
	Tombstones  []Tombstone     `json:"tombstones"`
	Invalidated []string        `json:"invalidated_key_ids"`
	Spent       map[string]bool `json:"spent"`
	Pending     []*Reservation  `json:"pending"`
	Lease       Lease           `json:"lease"`
	// OtherLeases holds other devices' current leases from the last sync.
	OtherLeases map[string]Lease `json:"other_leases"`
	// Dirty means local changes have not been pushed. LeaseDirty marks only
	// the lease record, which has its own blob.
	Dirty      bool  `json:"dirty"`
	LeaseDirty bool  `json:"lease_dirty"`
	RemoteTime int64 `json:"remote_time"`
	LastSyncMS int64 `json:"last_sync_ms"`
}

func newState(orgURL, accountID, deviceID string) *State {
	return &State{Version: stateVersion, OrgURL: orgURL, AccountID: accountID, DeviceID: deviceID, Spent: map[string]bool{}, OtherLeases: map[string]Lease{}}
}

// Store guards one wallet file across goroutines and processes.
type Store struct {
	dir string
	mu  sync.Mutex
	now func() time.Time
}

// Open prepares a store in a private profile directory.
func Open(dir string) (*Store, error) {
	if err := securefile.EnsureDir(dir); err != nil {
		return nil, err
	}
	return &Store{dir: dir, now: time.Now}, nil
}

// ErrNoWallet means no replica has been created yet.
var ErrNoWallet = errors.New("no ticket wallet yet; run oa-clientd setup")

func (s *Store) read() (*State, error) {
	data, err := securefile.Read(filepath.Join(s.dir, stateFile), maxStateSize)
	if errors.Is(err, os.ErrNotExist) {
		return nil, ErrNoWallet
	}
	if err != nil {
		return nil, err
	}
	state := &State{}
	if err := json.Unmarshal(data, state); err != nil {
		return nil, errors.New("wallet.json is invalid; it was left untouched")
	}
	if state.Version != stateVersion {
		return nil, errors.New("wallet.json has an unsupported version; it was left untouched")
	}
	if state.Spent == nil {
		state.Spent = map[string]bool{}
	}
	if state.OtherLeases == nil {
		state.OtherLeases = map[string]Lease{}
	}
	return state, nil
}

func (s *Store) write(state *State) error {
	data, err := json.Marshal(state)
	if err != nil {
		return errors.New("cannot encode wallet")
	}
	return securefile.WriteAtomic(filepath.Join(s.dir, stateFile), data)
}

// Create binds a wallet to an account once. It refuses to adopt a replica of
// another account or org, so a login can never merge two accounts' tickets.
func (s *Store) Create(ctx context.Context, orgURL, accountID, deviceID string) error {
	return s.locked(ctx, func() error {
		existing, err := s.read()
		if err == nil {
			if existing.OrgURL != orgURL || existing.AccountID != accountID {
				return ErrOtherAccount
			}
			return nil
		}
		if !errors.Is(err, ErrNoWallet) {
			return err
		}
		return s.write(newState(orgURL, accountID, deviceID))
	})
}

// ErrOtherAccount protects a profile holding another account's replica.
var ErrOtherAccount = errors.New("this profile holds another account's wallet; run oa-clientd logout first or use a separate --config-dir")

func (s *Store) locked(ctx context.Context, fn func() error) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	lock, err := securefile.AcquireLock(ctx, filepath.Join(s.dir, lockFile))
	if err != nil {
		return err
	}
	defer lock.Release()
	return fn()
}

// Update runs fn with exclusive access and commits its changes. An error from
// fn discards them. Never hold this across a network request.
func (s *Store) Update(ctx context.Context, fn func(*State) error) error {
	return s.locked(ctx, func() error {
		state, err := s.read()
		if err != nil {
			return err
		}
		if err := fn(state); err != nil {
			return err
		}
		return s.write(state)
	})
}

// View reads a consistent snapshot without changing anything.
func (s *Store) View(ctx context.Context, fn func(*State) error) error {
	return s.locked(ctx, func() error {
		state, err := s.read()
		if err != nil {
			return err
		}
		return fn(state)
	})
}

// Delete removes the replica after logout has pushed what it must.
func (s *Store) Delete(ctx context.Context) error {
	return s.locked(ctx, func() error { return securefile.Remove(filepath.Join(s.dir, stateFile)) })
}

// Remote is the decrypted content of the account's sync blobs.
type Remote struct {
	Active      []Ticket
	Archive     []Ticket
	Tombstones  []Tombstone
	Invalidated []string
	Leases      map[string]Lease
}

// KeyID reads the issuer generation from a finalized RFC 9578 token. The token
// bytes are authoritative; a record's ticket_key_id is mutable metadata.
func KeyID(token string) string {
	raw, err := DecodeToken(token)
	if err != nil || len(raw) < 98 {
		return ""
	}
	return hex.EncodeToString(raw[66:98])
}

// Merge applies a pull under the browser's CRDT rules and reports whether the
// replica now holds something the remote lacks.
func (st *State) Merge(remote Remote) (needsPush bool) {
	before := func(tickets []Ticket) map[string]bool {
		set := make(map[string]bool, len(tickets))
		for _, t := range tickets {
			set[t.Token] = true
		}
		return set
	}
	remoteActive, remoteArchive := before(remote.Active), before(remote.Archive)

	remoteTombstones := make(map[string]bool, len(remote.Tombstones))
	for _, tombstone := range remote.Tombstones {
		remoteTombstones[tombstone.Fingerprint] = true
	}
	st.Tombstones = mergeTombstones(st.Tombstones, remote.Tombstones)
	removed := make(map[string]bool, len(st.Tombstones))
	for _, tombstone := range st.Tombstones {
		removed[tombstone.Fingerprint] = true
	}

	remoteInvalidated := make(map[string]bool, len(remote.Invalidated))
	for _, id := range remote.Invalidated {
		if normalized := normalizeKeyID(id); normalized != "" {
			remoteInvalidated[normalized] = true
		}
	}
	st.Invalidated = mergeKeyIDs(st.Invalidated, remote.Invalidated)
	invalidated := make(map[string]bool, len(st.Invalidated))
	for _, id := range st.Invalidated {
		invalidated[id] = true
	}

	keep := func(t Ticket) bool {
		if t.Token == "" || removed[Fingerprint(t.Token)] {
			return false
		}
		id := KeyID(t.Token)
		return id == "" || !invalidated[id]
	}

	// Archive: the union of everything consumed anywhere.
	archive := make([]Ticket, 0, len(st.Archive)+len(remote.Archive))
	seen := map[string]bool{}
	for _, t := range append(append([]Ticket{}, st.Archive...), remote.Archive...) {
		if keep(t) && !seen[t.Token] {
			seen[t.Token] = true
			archive = append(archive, t)
		}
	}
	st.Archive = archive

	// Reserved tickets stay out of Active: the org decides their fate, and the
	// retry of that exact request is the only thing that may use them. A
	// ticket another device consumed resolves the reservation in the next retry.
	reserved := map[string]bool{}
	for _, reservation := range st.Pending {
		for _, t := range reservation.Tickets {
			reserved[t.Token] = true
		}
	}

	// Active: everything known and not consumed. Consumed always wins, and the
	// local spent set remembers tokens even if a stale peer dropped its archive.
	active := make([]Ticket, 0, len(st.Active)+len(remote.Active))
	present := map[string]bool{}
	for _, t := range append(append([]Ticket{}, st.Active...), remote.Active...) {
		if !keep(t) || seen[t.Token] || present[t.Token] || reserved[t.Token] || st.Spent[Fingerprint(t.Token)] {
			continue
		}
		present[t.Token] = true
		active = append(active, t)
	}
	st.Active = active

	st.OtherLeases = map[string]Lease{}
	for device, lease := range remote.Leases {
		if device != st.DeviceID {
			st.OtherLeases[device] = lease
		}
	}
	st.pruneLease()

	if !subset(active, remoteActive) || !subset(archive, remoteArchive) {
		needsPush = true
	}
	// A consumed ticket still listed as active remotely needs correcting too.
	for token := range remoteActive {
		if seen[token] || removed[Fingerprint(token)] || st.Spent[Fingerprint(token)] {
			needsPush = true
			break
		}
	}
	for fingerprint := range removed {
		if !remoteTombstones[fingerprint] {
			needsPush = true
			break
		}
	}
	for id := range invalidated {
		if !remoteInvalidated[id] {
			needsPush = true
			break
		}
	}
	return needsPush
}

func subset(tickets []Ticket, set map[string]bool) bool {
	for _, t := range tickets {
		if !set[t.Token] {
			return false
		}
	}
	return true
}

func mergeTombstones(existing, incoming []Tombstone) []Tombstone {
	merged := make([]Tombstone, 0, len(existing)+len(incoming))
	index := map[string]int{}
	for _, tombstone := range append(append([]Tombstone{}, existing...), incoming...) {
		if tombstone.Fingerprint == "" {
			continue
		}
		position, ok := index[tombstone.Fingerprint]
		if !ok {
			index[tombstone.Fingerprint] = len(merged)
			merged = append(merged, tombstone)
			continue
		}
		if tombstone.RemovedAt > merged[position].RemovedAt {
			merged[position] = tombstone
		}
	}
	return merged
}

func normalizeKeyID(id string) string {
	id = strings.ToLower(strings.TrimSpace(id))
	if len(id) != 64 {
		return ""
	}
	if _, err := hex.DecodeString(id); err != nil {
		return ""
	}
	return id
}

func mergeKeyIDs(existing, incoming []string) []string {
	merged := []string{}
	seen := map[string]bool{}
	for _, id := range append(append([]string{}, existing...), incoming...) {
		if id = normalizeKeyID(id); id != "" && !seen[id] {
			seen[id] = true
			merged = append(merged, id)
		}
	}
	return merged
}

// pruneLease drops fingerprints that are no longer active or reserved.
func (st *State) pruneLease() {
	current := map[string]bool{}
	for _, t := range st.Active {
		current[Fingerprint(t.Token)] = true
	}
	for _, reservation := range st.Pending {
		for _, t := range reservation.Tickets {
			current[Fingerprint(t.Token)] = true
		}
	}
	kept := st.Lease.Fingerprints[:0:0]
	for _, fingerprint := range st.Lease.Fingerprints {
		if current[fingerprint] {
			kept = append(kept, fingerprint)
		}
	}
	if len(kept) != len(st.Lease.Fingerprints) {
		st.Lease.Fingerprints = kept
		st.LeaseDirty = true
	}
}

// heldElsewhere returns fingerprints under another device's unexpired lease.
func (st *State) heldElsewhere(now time.Time) map[string]bool {
	held := map[string]bool{}
	for _, lease := range st.OtherLeases {
		if lease.ExpiresAtMS > now.UnixMilli() {
			for _, fingerprint := range lease.Fingerprints {
				held[fingerprint] = true
			}
		}
	}
	return held
}

// Available counts tickets this device may spend: not held by another device.
func (st *State) Available(now time.Time) int {
	held := st.heldElsewhere(now)
	count := 0
	for _, t := range st.Active {
		if !held[Fingerprint(t.Token)] {
			count++
		}
	}
	return count
}

// HeldByOthers counts active tickets other devices have leased.
func (st *State) HeldByOthers(now time.Time) int { return len(st.Active) - st.Available(now) }

// RefreshLease moves this device's lease to target tickets, keeping those nearest
// the tail of the wallet because the browser spends from the head. A lower target
// releases the excess, so a smaller setting or wallet takes effect on the next sync.
// Tickets reserved for a request in flight stay leased even above target, because the
// org has not decided them. It renews the expiry when less than half remains and an
// empty lease has none. It reports nothing to the network.
func (st *State) RefreshLease(target int, now time.Time) {
	held := st.heldElsewhere(now)
	active := map[string]bool{}
	for _, t := range st.Active {
		active[Fingerprint(t.Token)] = true
	}
	reserved := map[string]bool{}
	for _, reservation := range st.Pending {
		for _, t := range reservation.Tickets {
			reserved[Fingerprint(t.Token)] = true
		}
	}
	current := map[string]bool{}
	for _, fingerprint := range st.Lease.Fingerprints {
		switch {
		case reserved[fingerprint]:
			current[fingerprint] = true
		case !active[fingerprint]:
			st.LeaseDirty = true // Consumed or removed.
		case held[fingerprint] && st.Lease.ExpiresAtMS <= now.UnixMilli():
			st.LeaseDirty = true // Our lease lapsed and another device claimed it.
		default:
			current[fingerprint] = true
		}
	}
	// Release from the head, the end the browser spends from.
	for i := 0; i < len(st.Active) && len(current) > target; i++ {
		fingerprint := Fingerprint(st.Active[i].Token)
		if current[fingerprint] && !reserved[fingerprint] {
			delete(current, fingerprint)
			st.LeaseDirty = true
		}
	}
	kept := st.Lease.Fingerprints[:0:0]
	for _, fingerprint := range st.Lease.Fingerprints {
		if current[fingerprint] {
			kept = append(kept, fingerprint)
		}
	}
	st.Lease.Fingerprints = kept
	for i := len(st.Active) - 1; i >= 0 && len(current) < target; i-- {
		fingerprint := Fingerprint(st.Active[i].Token)
		if !current[fingerprint] && !held[fingerprint] {
			current[fingerprint] = true
			st.Lease.Fingerprints = append(st.Lease.Fingerprints, fingerprint)
			st.LeaseDirty = true
		}
	}
	if len(st.Lease.Fingerprints) == 0 {
		if st.Lease.ExpiresAtMS != 0 {
			st.Lease.ExpiresAtMS = 0
			st.LeaseDirty = true
		}
		return
	}
	if st.Lease.ExpiresAtMS-now.UnixMilli() < int64(LeaseTTL/2/time.Millisecond) {
		st.Lease.ExpiresAtMS = now.Add(LeaseTTL).UnixMilli()
		st.LeaseDirty = true
	}
}

// ReleaseLease gives every unreserved ticket back to the other clients.
func (st *State) ReleaseLease() {
	if len(st.Lease.Fingerprints) == 0 && st.Lease.ExpiresAtMS == 0 {
		return
	}
	st.Lease = Lease{Fingerprints: []string{}}
	st.LeaseDirty = true
}

// Reserve durably commits cost spendable tickets to a new reservation. eligible
// filters out tickets that fail local issuer checks. Reservation comes from the
// lease first, then extends it, and never takes a ticket another device holds.
func (st *State) Reserve(id, nonce string, cost int, eligible func(Ticket) bool, now time.Time) (*Reservation, error) {
	held := st.heldElsewhere(now)
	leased := map[string]bool{}
	for _, fingerprint := range st.Lease.Fingerprints {
		leased[fingerprint] = true
	}
	type candidate struct {
		index  int
		leased bool
	}
	candidates := []candidate{}
	spendable, heldHere := 0, 0
	for i, t := range st.Active {
		fingerprint := Fingerprint(t.Token)
		if held[fingerprint] {
			heldHere++
			continue
		}
		if !eligible(t) {
			continue
		}
		spendable++
		candidates = append(candidates, candidate{i, leased[fingerprint]})
	}
	if spendable < cost {
		return nil, &InsufficientError{Need: cost, Have: spendable, HeldElsewhere: heldHere}
	}
	// Leased tickets first, then from the tail, away from the browser's head.
	sort.SliceStable(candidates, func(i, j int) bool {
		if candidates[i].leased != candidates[j].leased {
			return candidates[i].leased
		}
		return candidates[i].index > candidates[j].index
	})
	selected := map[int]bool{}
	reservation := &Reservation{ID: id, Nonce: nonce, Cost: cost, CreatedMS: now.UnixMilli()}
	for _, c := range candidates[:cost] {
		selected[c.index] = true
		reservation.Tickets = append(reservation.Tickets, st.Active[c.index])
	}
	remaining := make([]Ticket, 0, len(st.Active)-cost)
	for i, t := range st.Active {
		if !selected[i] {
			remaining = append(remaining, t)
		}
	}
	st.Active = remaining
	st.Pending = append(st.Pending, reservation)
	for _, t := range reservation.Tickets {
		fingerprint := Fingerprint(t.Token)
		if !leased[fingerprint] {
			st.Lease.Fingerprints = append(st.Lease.Fingerprints, fingerprint)
			st.LeaseDirty = true
		}
	}
	st.Dirty = true
	return reservation, nil
}

// InsufficientError reports a shortage without naming any ticket.
type InsufficientError struct {
	Need, Have, HeldElsewhere int
}

func (e *InsufficientError) Error() string { return "insufficient inference tickets" }

func (st *State) findPending(id string) (int, *Reservation) {
	for i, reservation := range st.Pending {
		if reservation.ID == id {
			return i, reservation
		}
	}
	return -1, nil
}

func (st *State) dropPending(index int) {
	st.Pending = append(st.Pending[:index:index], st.Pending[index+1:]...)
}

// CommitSpent records a redemption the org accepted: its tickets move to the
// archive permanently, whatever verification decides next.
func (st *State) CommitSpent(id string, now time.Time) {
	index, reservation := st.findPending(id)
	if reservation == nil {
		return
	}
	st.dropPending(index)
	for _, t := range reservation.Tickets {
		st.markConsumed(t, now)
	}
	st.pruneLease()
	st.Dirty = true
}

func (st *State) markConsumed(t Ticket, now time.Time) {
	st.Spent[Fingerprint(t.Token)] = true
	for _, existing := range st.Archive {
		if existing.Token == t.Token {
			return
		}
	}
	st.Archive = append(st.Archive, t.Consumed(now))
}

// RejectAlreadySpent resolves a definitive TICKET_ALREADY_SPENT. The org rolls
// back the rest of a multi-ticket request, so only the failed ticket is lost and
// the others return to the wallet unspent. Without an index the whole
// reservation is consumed: refusing to restore cannot create a double spend.
func (st *State) RejectAlreadySpent(id string, failedIndex int, now time.Time) {
	index, reservation := st.findPending(id)
	if reservation == nil {
		return
	}
	st.dropPending(index)
	if failedIndex < 0 || failedIndex >= len(reservation.Tickets) {
		for _, t := range reservation.Tickets {
			st.markConsumed(t, now)
		}
	} else {
		for i, t := range reservation.Tickets {
			if i == failedIndex {
				st.markConsumed(t, now)
			} else {
				st.Active = append(st.Active, t)
			}
		}
	}
	st.pruneLease()
	st.Dirty = true
}

// RejectInvalidated applies a global key rotation: every local ticket of that
// generation is gone, and a durable encrypted tombstone stops peers restoring it.
// Other tickets in the reservation return to the wallet unspent.
func (st *State) RejectInvalidated(id, keyID string) {
	normalized := normalizeKeyID(keyID)
	if index, reservation := st.findPending(id); reservation != nil {
		st.dropPending(index)
		for _, t := range reservation.Tickets {
			if normalized == "" || KeyID(t.Token) != normalized {
				st.Active = append(st.Active, t)
			}
		}
	}
	if normalized == "" {
		st.Dirty = true
		return
	}
	st.Invalidated = mergeKeyIDs(st.Invalidated, []string{normalized})
	filter := func(tickets []Ticket) []Ticket {
		kept := tickets[:0:0]
		for _, t := range tickets {
			if KeyID(t.Token) != normalized {
				kept = append(kept, t)
			}
		}
		return kept
	}
	st.Active = filter(st.Active)
	st.Archive = filter(st.Archive)
	st.pruneLease()
	st.Dirty = true
}

// RestorePending returns a reservation's tickets after a definitive rejection
// that spent nothing, such as a pricing or tier refusal.
func (st *State) RestorePending(id string) {
	index, reservation := st.findPending(id)
	if reservation == nil {
		return
	}
	st.dropPending(index)
	st.Active = append(st.Active, reservation.Tickets...)
	st.pruneLease()
	st.Dirty = true
}

// Equal reports whether two ticket lists hold the same tokens in any order.
func Equal(a, b []Ticket) bool {
	if len(a) != len(b) {
		return false
	}
	set := map[string]bool{}
	for _, t := range a {
		set[t.Token] = true
	}
	for _, t := range b {
		if !set[t.Token] {
			return false
		}
	}
	return true
}

// CanonicalTickets encodes a list for a sync blob. A nil list becomes an empty
// array because the browser treats empty arrays as data.
func CanonicalTickets(tickets []Ticket) []Ticket {
	if tickets == nil {
		return []Ticket{}
	}
	return tickets
}

// ContainsSecret lets tests and diagnostics check that no token leaked.
func ContainsSecret(data []byte, tickets []Ticket) bool {
	for _, t := range tickets {
		if t.Token != "" && bytes.Contains(data, []byte(t.Token)) {
			return true
		}
	}
	return false
}
