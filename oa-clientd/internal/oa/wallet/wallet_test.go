package wallet

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/OpenAnonymity/oa-chat/oa-clientd/internal/oa/oatest"
)

var testNow = time.UnixMilli(1_800_000_000_000)

func ticket(token string) Ticket {
	raw, _ := json.Marshal(map[string]any{"finalized_ticket": token, "signed_response": "sig-" + token, "blinded_request": "req-" + token})
	return Ticket{Token: token, Raw: raw}
}

func tokens(list []Ticket) string {
	out := []string{}
	for _, t := range list {
		out = append(out, t.Token)
	}
	return strings.Join(out, ",")
}

func fresh() *State { return newState("https://org", "1234567890123456", "device") }

func allow(Ticket) bool { return true }

func TestMergeAddsRemoteTickets(t *testing.T) {
	st := fresh()
	if st.Merge(Remote{Active: []Ticket{ticket("a"), ticket("b")}}) {
		t.Fatal("nothing local to push")
	}
	if tokens(st.Active) != "a,b" {
		t.Fatalf("active = %s", tokens(st.Active))
	}
}

func TestMergeConsumedAlwaysWins(t *testing.T) {
	st := fresh()
	st.Active = []Ticket{ticket("a"), ticket("b")}
	push := st.Merge(Remote{Active: []Ticket{ticket("a"), ticket("b")}, Archive: []Ticket{ticket("a")}})
	if tokens(st.Active) != "b" || tokens(st.Archive) != "a" {
		t.Fatalf("active=%s archive=%s", tokens(st.Active), tokens(st.Archive))
	}
	if !push {
		t.Fatal("a consumed ticket still listed active remotely must be corrected")
	}
}

func TestSpentTicketNeverResurrects(t *testing.T) {
	st := fresh()
	st.Active = []Ticket{ticket("a")}
	reservation, err := st.Reserve("r", "nonce", 1, allow, testNow)
	if err != nil {
		t.Fatal(err)
	}
	st.CommitSpent(reservation.ID, testNow)
	// A stale peer pushes the ticket active and has lost the archive entry.
	st.Archive = nil
	st.Merge(Remote{Active: []Ticket{ticket("a")}})
	if len(st.Active) != 0 {
		t.Fatalf("spent ticket returned to active: %s", tokens(st.Active))
	}
}

func TestTombstonesRemoveEverywhereAndAreUnioned(t *testing.T) {
	st := fresh()
	st.Active = []Ticket{ticket("a"), ticket("b")}
	st.Archive = []Ticket{ticket("c")}
	st.Tombstones = []Tombstone{{Fingerprint: "local"}}
	push := st.Merge(Remote{
		Active:     []Ticket{ticket("a"), ticket("b")},
		Archive:    []Ticket{ticket("c")},
		Tombstones: []Tombstone{{Fingerprint: Fingerprint("a")}, {Fingerprint: Fingerprint("c")}},
	})
	if tokens(st.Active) != "b" || len(st.Archive) != 0 {
		t.Fatalf("active=%s archive=%s", tokens(st.Active), tokens(st.Archive))
	}
	if len(st.Tombstones) != 3 || !push {
		t.Fatalf("tombstones must union and push: %d %v", len(st.Tombstones), push)
	}
}

func TestInvalidatedGenerationIsRemovedAndDeviceCannotRestoreIt(t *testing.T) {
	issuer := oatest.NewIssuer(t)
	old := issuer.Token(t)
	st := fresh()
	st.Active = []Ticket{ticket(old), ticket("legacy")}
	st.Merge(Remote{Invalidated: []string{strings.ToUpper(issuer.KeyID), "not-a-key"}})
	if tokens(st.Active) != "legacy" {
		t.Fatalf("active = %s", tokens(st.Active))
	}
	if len(st.Invalidated) != 1 || st.Invalidated[0] != issuer.KeyID {
		t.Fatalf("invalidated = %v", st.Invalidated)
	}
	st.Merge(Remote{Active: []Ticket{ticket(old)}})
	if tokens(st.Active) != "legacy" {
		t.Fatal("a stale peer restored an invalidated generation")
	}
}

func TestMergeKeepsUnknownFieldsAndDeduplicates(t *testing.T) {
	st := fresh()
	raw := json.RawMessage(`{"finalized_ticket":"a","future_field":{"x":1}}`)
	st.Merge(Remote{Active: []Ticket{{Token: "a", Raw: raw}, {Token: "a", Raw: raw}}})
	if len(st.Active) != 1 || !strings.Contains(string(st.Active[0].Raw), "future_field") {
		t.Fatalf("active = %s", st.Active[0].Raw)
	}
	data, err := json.Marshal(st.Active[0].Consumed(testNow))
	if err != nil || !strings.Contains(string(data), "future_field") || !strings.Contains(string(data), "consumed_at") {
		t.Fatalf("consumed record lost fields: %s", data)
	}
}

func TestMergeReportsWhenRemoteIsMissingLocalState(t *testing.T) {
	st := fresh()
	st.Active = []Ticket{ticket("a")}
	if !st.Merge(Remote{}) {
		t.Fatal("remote lacks a local ticket")
	}
	if st.Merge(Remote{Active: []Ticket{ticket("a")}}) {
		t.Fatal("remote already holds everything")
	}
}

func TestReserveSpendsLeaseFirstThenTailAwayFromBrowserHead(t *testing.T) {
	st := fresh()
	st.Active = []Ticket{ticket("a"), ticket("b"), ticket("c"), ticket("d")}
	st.Lease.Fingerprints = []string{Fingerprint("b")}
	reservation, err := st.Reserve("r", "nonce", 2, allow, testNow)
	if err != nil {
		t.Fatal(err)
	}
	if tokens(reservation.Tickets) != "b,d" {
		t.Fatalf("selected %s", tokens(reservation.Tickets))
	}
	if tokens(st.Active) != "a,c" {
		t.Fatalf("remaining %s", tokens(st.Active))
	}
}

func TestReserveNeverTakesAnotherDevicesLeaseUntilItExpires(t *testing.T) {
	st := fresh()
	st.Active = []Ticket{ticket("a"), ticket("b")}
	st.OtherLeases = map[string]Lease{"other": {Fingerprints: []string{Fingerprint("b")}, ExpiresAtMS: testNow.Add(time.Hour).UnixMilli()}}
	_, err := st.Reserve("r", "nonce", 2, allow, testNow)
	var short *InsufficientError
	if !errors.As(err, &short) || short.Have != 1 || short.HeldElsewhere != 1 {
		t.Fatalf("err = %v", err)
	}
	if len(st.Active) != 2 || len(st.Pending) != 0 {
		t.Fatal("a refused reservation changed state")
	}
	if _, err := st.Reserve("r", "nonce", 2, allow, testNow.Add(2*time.Hour)); err != nil {
		t.Fatalf("expired lease should release: %v", err)
	}
}

func TestReserveSkipsIneligible(t *testing.T) {
	st := fresh()
	st.Active = []Ticket{ticket("forged"), ticket("good")}
	reservation, err := st.Reserve("r", "nonce", 1, func(t Ticket) bool { return t.Token == "good" }, testNow)
	if err != nil || reservation.Tickets[0].Token != "good" {
		t.Fatalf("reservation = %v, %v", reservation, err)
	}
	if _, err := st.Reserve("q", "nonce", 1, func(t Ticket) bool { return t.Token == "good" }, testNow); err == nil {
		t.Fatal("forged ticket must not be selected")
	}
}

func TestAlreadySpentKeepsOnlyTheOthers(t *testing.T) {
	st := fresh()
	st.Active = []Ticket{ticket("a"), ticket("b"), ticket("c")}
	reservation, _ := st.Reserve("r", "nonce", 3, allow, testNow)
	failed := reservation.Tickets[1].Token
	st.RejectAlreadySpent("r", 1, testNow)
	if len(st.Pending) != 0 || len(st.Active) != 2 || tokens(st.Archive) != failed {
		t.Fatalf("active=%s archive=%s pending=%d", tokens(st.Active), tokens(st.Archive), len(st.Pending))
	}
	if !st.Spent[Fingerprint(failed)] {
		t.Fatal("failed ticket must be remembered as spent")
	}
}

func TestAlreadySpentWithoutIndexConsumesAll(t *testing.T) {
	st := fresh()
	st.Active = []Ticket{ticket("a"), ticket("b")}
	st.Reserve("r", "nonce", 2, allow, testNow)
	st.RejectAlreadySpent("r", -1, testNow)
	if len(st.Active) != 0 || len(st.Archive) != 2 {
		t.Fatalf("active=%d archive=%d", len(st.Active), len(st.Archive))
	}
}

func TestRestorePendingReturnsTicketsUnspent(t *testing.T) {
	st := fresh()
	st.Active = []Ticket{ticket("a")}
	st.Reserve("r", "nonce", 1, allow, testNow)
	st.RestorePending("r")
	if tokens(st.Active) != "a" || len(st.Archive) != 0 || st.Spent[Fingerprint("a")] {
		t.Fatal("a refusal that spent nothing must restore")
	}
}

func TestMergeLeavesReservedTicketsOutOfActive(t *testing.T) {
	st := fresh()
	st.Active = []Ticket{ticket("a"), ticket("b")}
	st.Reserve("r", "nonce", 1, allow, testNow)
	reserved := st.Pending[0].Tickets[0].Token
	st.Merge(Remote{Active: []Ticket{ticket("a"), ticket("b")}})
	for _, active := range st.Active {
		if active.Token == reserved {
			t.Fatal("a reserved ticket came back as spendable")
		}
	}
}

func TestLeaseTakesFromTailRenewsAndYields(t *testing.T) {
	st := fresh()
	st.Active = []Ticket{ticket("a"), ticket("b"), ticket("c")}
	st.RefreshLease(2, testNow)
	held := map[string]bool{}
	for _, fingerprint := range st.Lease.Fingerprints {
		held[fingerprint] = true
	}
	if !held[Fingerprint("c")] || !held[Fingerprint("b")] || held[Fingerprint("a")] {
		t.Fatalf("lease = %v", st.Lease.Fingerprints)
	}
	if !st.LeaseDirty || st.Lease.ExpiresAtMS != testNow.Add(LeaseTTL).UnixMilli() {
		t.Fatal("new lease must be dirty and expire one TTL out")
	}
	st.LeaseDirty = false
	st.RefreshLease(2, testNow.Add(time.Minute))
	if st.LeaseDirty {
		t.Fatal("a young lease needs no write")
	}
	st.RefreshLease(2, testNow.Add(LeaseTTL/2+time.Minute))
	if !st.LeaseDirty {
		t.Fatal("a half-spent lease must renew")
	}
	st.OtherLeases = map[string]Lease{"other": {Fingerprints: []string{Fingerprint("c")}, ExpiresAtMS: testNow.Add(100 * time.Hour).UnixMilli()}}
	st.RefreshLease(2, testNow.Add(50*time.Hour))
	for _, fingerprint := range st.Lease.Fingerprints {
		if fingerprint == Fingerprint("c") {
			t.Fatal("a lapsed lease must yield to another device's claim")
		}
	}
	st.ReleaseLease()
	if len(st.Lease.Fingerprints) != 0 || st.Lease.ExpiresAtMS != 0 || !st.LeaseDirty {
		t.Fatal("release must clear and publish")
	}
}

func eightLeasedFour() *State {
	st := fresh()
	for _, token := range []string{"a", "b", "c", "d", "e", "f", "g", "h"} {
		st.Active = append(st.Active, ticket(token))
	}
	st.RefreshLease(4, testNow)
	st.LeaseDirty = false
	return st
}

func leased(st *State) map[string]bool {
	set := map[string]bool{}
	for _, fingerprint := range st.Lease.Fingerprints {
		set[fingerprint] = true
	}
	return set
}

func TestLeaseShrinksToALowerTargetKeepingTheTail(t *testing.T) {
	st := eightLeasedFour()
	expiry := st.Lease.ExpiresAtMS
	st.RefreshLease(2, testNow.Add(time.Minute))
	got := leased(st)
	if len(got) != 2 || !got[Fingerprint("h")] || !got[Fingerprint("g")] {
		t.Fatalf("lease = %v", st.Lease.Fingerprints)
	}
	if !st.LeaseDirty || st.Lease.ExpiresAtMS != expiry {
		t.Fatalf("shrink must publish and need no renewal: dirty=%v", st.LeaseDirty)
	}
	if len(st.Active) != 8 || len(st.Archive) != 0 || len(st.Spent) != 0 {
		t.Fatal("releasing a lease must not move any ticket")
	}
	st.LeaseDirty = false
	st.RefreshLease(2, testNow.Add(2*time.Minute))
	if st.LeaseDirty || len(leased(st)) != 2 {
		t.Fatal("a settled lease needs no write")
	}
	st.RefreshLease(3, testNow.Add(3*time.Minute))
	if got := leased(st); len(got) != 3 || !got[Fingerprint("f")] {
		t.Fatalf("growing again = %v", st.Lease.Fingerprints)
	}
}

func TestLeaseTargetZeroReleasesEverything(t *testing.T) {
	st := eightLeasedFour()
	st.RefreshLease(0, testNow.Add(time.Minute))
	if len(st.Lease.Fingerprints) != 0 || st.Lease.ExpiresAtMS != 0 || !st.LeaseDirty {
		t.Fatalf("lease = %+v", st.Lease)
	}
	st.LeaseDirty = false
	st.RefreshLease(0, testNow.Add(2*time.Minute))
	if st.LeaseDirty {
		t.Fatal("an empty lease must stay quiet")
	}
}

func TestLeaseShrinkKeepsInFlightReservationsAboveTarget(t *testing.T) {
	st := eightLeasedFour()
	reservation, err := st.Reserve("r", "nonce", 3, allow, testNow)
	if err != nil {
		t.Fatal(err)
	}
	for _, target := range []int{2, 0} {
		st.RefreshLease(target, testNow.Add(time.Minute))
		got := leased(st)
		for _, reservedTicket := range reservation.Tickets {
			if !got[Fingerprint(reservedTicket.Token)] {
				t.Fatalf("target %d dropped an in-flight ticket", target)
			}
		}
		if len(got) != 3 {
			t.Fatalf("target %d lease = %d", target, len(got))
		}
	}
	st.CommitSpent("r", testNow)
	st.RefreshLease(0, testNow.Add(2*time.Minute))
	if len(st.Lease.Fingerprints) != 0 || st.Lease.ExpiresAtMS != 0 {
		t.Fatalf("after commit lease = %+v", st.Lease)
	}
}

func TestLeaseShrinkKeepsReservationWhenRestored(t *testing.T) {
	st := eightLeasedFour()
	if _, err := st.Reserve("r", "nonce", 2, allow, testNow); err != nil {
		t.Fatal(err)
	}
	st.RefreshLease(1, testNow.Add(time.Minute))
	st.RestorePending("r")
	if len(st.Active) != 8 || len(st.Pending) != 0 {
		t.Fatalf("active=%d", len(st.Active))
	}
	st.RefreshLease(1, testNow.Add(2*time.Minute))
	if len(st.Lease.Fingerprints) != 1 {
		t.Fatalf("lease = %v", st.Lease.Fingerprints)
	}
}

func TestLeaseRefreshDropsConsumedAndClaimedFingerprints(t *testing.T) {
	st := eightLeasedFour()
	st.Lease.Fingerprints = append(st.Lease.Fingerprints, Fingerprint("gone"))
	st.RefreshLease(4, testNow.Add(time.Minute))
	if leased(st)[Fingerprint("gone")] || !st.LeaseDirty {
		t.Fatal("a ticket no longer here must leave the lease")
	}
	late := testNow.Add(LeaseTTL + time.Hour)
	st.OtherLeases = map[string]Lease{"other": {Fingerprints: []string{Fingerprint("h")}, ExpiresAtMS: late.Add(time.Hour).UnixMilli()}}
	st.RefreshLease(4, late)
	got := leased(st)
	if got[Fingerprint("h")] || len(got) != 4 || !got[Fingerprint("d")] {
		t.Fatalf("lapsed lease = %v", st.Lease.Fingerprints)
	}
}

func TestStoreRefusesAnotherAccountAndOrg(t *testing.T) {
	store, err := Open(oatest.PrivateDir(t))
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	if err := store.Create(ctx, "https://org", "1111111111111111", "d"); err != nil {
		t.Fatal(err)
	}
	if err := store.Create(ctx, "https://org", "1111111111111111", "d"); err != nil {
		t.Fatalf("same account is idempotent: %v", err)
	}
	for _, c := range [][2]string{{"https://org", "2222222222222222"}, {"https://staging", "1111111111111111"}} {
		if err := store.Create(ctx, c[0], c[1], "d"); !errors.Is(err, ErrOtherAccount) {
			t.Fatalf("%v: %v", c, err)
		}
	}
}

func TestStorePersistsAcrossRestartAndDiscardsFailedUpdates(t *testing.T) {
	dir := oatest.PrivateDir(t)
	store, _ := Open(dir)
	ctx := context.Background()
	store.Create(ctx, "o", "a", "d")
	store.Update(ctx, func(st *State) error {
		st.Active = []Ticket{ticket("a"), ticket("b")}
		_, err := st.Reserve("r", "nonce", 1, allow, testNow)
		return err
	})
	failure := errors.New("no")
	if err := store.Update(ctx, func(st *State) error { st.Active = nil; return failure }); !errors.Is(err, failure) {
		t.Fatal(err)
	}
	reopened, _ := Open(dir)
	err := reopened.View(ctx, func(st *State) error {
		if len(st.Active) != 1 || len(st.Pending) != 1 {
			t.Fatalf("active=%d pending=%d", len(st.Active), len(st.Pending))
		}
		if !strings.Contains(string(st.Pending[0].Tickets[0].Raw), "signed_response") {
			t.Fatal("raw record lost across restart")
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}

// Two processes share a wallet through separate file descriptors. Each ticket
// must be reserved exactly once.
func TestConcurrentReservationsNeverShareATicket(t *testing.T) {
	dir := oatest.PrivateDir(t)
	first, _ := Open(dir)
	second, _ := Open(dir)
	ctx := context.Background()
	first.Create(ctx, "o", "a", "d")
	const count = 40
	first.Update(ctx, func(st *State) error {
		for i := 0; i < count; i++ {
			st.Active = append(st.Active, ticket(fmt.Sprintf("t%d", i)))
		}
		return nil
	})
	var wg sync.WaitGroup
	for i := 0; i < count; i++ {
		store := first
		if i%2 == 1 {
			store = second
		}
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			if err := store.Update(ctx, func(st *State) error {
				_, err := st.Reserve(fmt.Sprintf("r%d", i), "nonce", 1, allow, testNow)
				return err
			}); err != nil {
				t.Error(err)
			}
		}(i)
	}
	wg.Wait()
	first.View(ctx, func(st *State) error {
		seen := map[string]bool{}
		for _, reservation := range st.Pending {
			for _, t2 := range reservation.Tickets {
				if seen[t2.Token] {
					t.Errorf("ticket %s reserved twice", t2.Token)
				}
				seen[t2.Token] = true
			}
		}
		if len(seen) != count || len(st.Active) != 0 {
			t.Errorf("reserved %d, %d left", len(seen), len(st.Active))
		}
		return nil
	})
}

func TestStoreFilePermissionsAndSymlinks(t *testing.T) {
	dir := oatest.PrivateDir(t)
	store, _ := Open(dir)
	ctx := context.Background()
	store.Create(ctx, "o", "a", "d")
	path := filepath.Join(dir, stateFile)
	info, err := os.Stat(path)
	if err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("mode = %v, %v", info.Mode(), err)
	}
	os.Chmod(path, 0o644)
	if err := store.View(ctx, func(*State) error { return nil }); err == nil || !strings.Contains(err.Error(), "chmod 600") {
		t.Fatalf("group-readable wallet accepted: %v", err)
	}
	os.Chmod(path, 0o600)
	moved := filepath.Join(dir, "elsewhere.json")
	os.Rename(path, moved)
	os.Symlink(moved, path)
	if err := store.View(ctx, func(*State) error { return nil }); err == nil || !strings.Contains(err.Error(), "symbolic link") {
		t.Fatalf("symlinked wallet accepted: %v", err)
	}
	loose := t.TempDir()
	os.Chmod(loose, 0o755)
	if _, err := Open(loose); err == nil {
		t.Fatal("a world-readable profile directory was accepted")
	}
}

func TestVerifyToken(t *testing.T) {
	issuer := oatest.NewIssuer(t)
	key, err := ParseIssuerKey(issuer.Encoded, issuer.KeyID)
	if err != nil {
		t.Fatal(err)
	}
	token := issuer.Token(t)
	if err := VerifyToken(token, key); err != nil {
		t.Fatalf("valid token refused: %v", err)
	}
	if KeyID(token) != issuer.KeyID {
		t.Fatal("key ID must come from the token bytes")
	}
	other := oatest.NewIssuer(t)
	otherKey, _ := ParseIssuerKey(other.Encoded, "")
	if err := VerifyToken(token, otherKey); err == nil {
		t.Fatal("another issuer's generation accepted")
	}
	// Same key ID claim, signed by someone else: the wrong-issuer forgery.
	raw, _ := DecodeToken(token)
	forged := append([]byte{}, raw...)
	forged[len(forged)-1] ^= 1
	if err := VerifyToken(encode(forged), key); err == nil {
		t.Fatal("corrupted signature accepted")
	}
	wrongChallenge := append([]byte{}, raw...)
	wrongChallenge[40] ^= 1
	if err := VerifyToken(encode(wrongChallenge), key); err == nil || !strings.Contains(err.Error(), "challenge") {
		t.Fatalf("server-tagged challenge accepted: %v", err)
	}
	if err := VerifyToken("not-a-ticket", key); err == nil {
		t.Fatal("garbage accepted")
	}
	if _, err := ParseIssuerKey(issuer.Encoded, "wrong"); err == nil {
		t.Fatal("key ID mismatch accepted")
	}
}

func encode(raw []byte) string { return base64.URLEncoding.EncodeToString(raw) }
