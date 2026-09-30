package ticket

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type reuseFixture struct {
	issuer      *testIssuer
	backend     *Backend
	clock       atomic.Int64
	policyCalls atomic.Int64
	mu          sync.Mutex
	prices      map[string]int
	disabled    []string
}

func newReuseFixture(t *testing.T, window time.Duration) *reuseFixture {
	t.Helper()
	f := &reuseFixture{issuer: newTestIssuer(t), prices: map[string]int{"test/model": 1, "test/title": 1, "test/expensive": 2}}
	f.clock.Store(time.Now().UnixNano())
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/chat/model-tickets":
			f.policyCalls.Add(1)
			f.mu.Lock()
			defer f.mu.Unlock()
			json.NewEncoder(w).Encode(f.prices)
		case "/chat/pinned-models":
			f.policyCalls.Add(1)
			f.mu.Lock()
			defer f.mu.Unlock()
			json.NewEncoder(w).Encode(map[string]any{"disabled_models": f.disabled})
		default:
			f.issuer.serve(w, r)
		}
	}))
	t.Cleanup(server.Close)
	b, err := New(Config{OrgURL: server.URL, VerifierURL: server.URL, WalletPath: filepath.Join(t.TempDir(), "tickets.json"), Client: server.Client(), KeyReuseWindow: window})
	if err != nil {
		t.Fatal(err)
	}
	b.now = func() time.Time { return time.Unix(0, f.clock.Load()) }
	f.backend = b
	if n, err := b.RedeemCode(context.Background(), code(12)); n != 12 || err != nil {
		t.Fatalf("prepare tickets: %d %v", n, err)
	}
	return f
}

func (f *reuseFixture) acquire(t *testing.T, model string) Credential {
	t.Helper()
	credential, err := f.backend.Acquire(context.Background(), model)
	if err != nil {
		t.Fatal(err)
	}
	return credential
}

func (f *reuseFixture) keyRequests() int {
	f.issuer.mu.Lock()
	defer f.issuer.mu.Unlock()
	return len(f.issuer.keyRequests)
}

func TestKeyReuseCoalescesBurstAndChecksEachModelsPolicy(t *testing.T) {
	f := newReuseFixture(t, time.Minute)
	const requests = 12
	var group sync.WaitGroup
	for n := 0; n < requests; n++ {
		group.Add(1)
		go func(n int) {
			defer group.Done()
			model := "test/model"
			if n%2 == 0 {
				model = "test/title:online"
			}
			credential, err := f.backend.Acquire(context.Background(), model)
			if err != nil || credential.Key != "test-ephemeral-key" || credential.VerificationStatus != "verified" {
				t.Errorf("burst acquire: credential status %q, error %v", credential.VerificationStatus, err)
			}
		}(n)
	}
	group.Wait()
	if got := f.keyRequests(); got != 1 {
		t.Fatalf("burst redeemed %d keys, want one", got)
	}
	if got := f.policyCalls.Load(); got != 2*requests {
		t.Fatalf("live policy checks = %d, want %d", got, 2*requests)
	}
	if remaining, err := f.backend.Count(); remaining != 11 || err != nil {
		t.Fatalf("burst spent extra tickets: remaining %d, error %v", remaining, err)
	}
	data, err := os.ReadFile(f.backend.cfg.WalletPath)
	if err != nil || strings.Contains(string(data), "test-ephemeral-key") {
		t.Fatalf("provider key entered durable wallet or wallet unreadable: %v", err)
	}
}

func TestKeyReuseWindowIsFixedAndRestartsDoNotReuse(t *testing.T) {
	f := newReuseFixture(t, time.Minute)
	f.acquire(t, "test/model")
	f.clock.Add(int64(59 * time.Second))
	f.acquire(t, "test/title")
	if f.keyRequests() != 1 {
		t.Fatal("key was not reused before the deadline")
	}
	f.clock.Add(int64(time.Second))
	f.acquire(t, "test/model")
	if f.keyRequests() != 2 {
		t.Fatal("reuse extended the fixed window")
	}
	restarted, err := New(f.backend.cfg)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := restarted.Acquire(context.Background(), "test/model"); err != nil {
		t.Fatal(err)
	}
	if f.keyRequests() != 3 {
		t.Fatal("process restart reused a provider key")
	}
}

func TestKeyReuseEndsBeforeProviderExpiry(t *testing.T) {
	f := newReuseFixture(t, time.Minute)
	// Integer seconds match the issuer's expiry representation exactly.
	now := time.Unix(f.backend.now().Unix(), 0)
	f.clock.Store(now.UnixNano())
	f.issuer.mu.Lock()
	f.issuer.expiresAt = now.Add(10 * time.Second).Unix()
	f.issuer.mu.Unlock()
	f.acquire(t, "test/model")
	f.clock.Add(int64(8 * time.Second))
	f.acquire(t, "test/title")
	if f.keyRequests() != 1 {
		t.Fatal("key was not reused within provider expiry guard")
	}
	f.clock.Add(int64(time.Second))
	f.issuer.mu.Lock()
	f.issuer.expiresAt = now.Add(time.Hour).Unix()
	f.issuer.mu.Unlock()
	f.acquire(t, "test/model")
	if f.keyRequests() != 2 {
		t.Fatal("key was reused at its expiry guard boundary")
	}
}

func TestKeyReuseRejectsFreshKeyWithinExpiryGuard(t *testing.T) {
	f := newReuseFixture(t, time.Minute)
	now := time.Unix(f.backend.now().Unix(), 0)
	f.clock.Store(now.UnixNano())
	f.issuer.mu.Lock()
	f.issuer.expiresAt = now.Add(time.Second).Unix()
	f.issuer.mu.Unlock()
	credential, err := f.backend.Acquire(context.Background(), "test/model")
	if err == nil || credential.Key != "" || f.backend.cached.credential.Key != "" {
		t.Fatalf("near-expired key became usable: %v", err)
	}
}

func TestKeyReuseRequiresMatchingCurrentTierAndAvailability(t *testing.T) {
	f := newReuseFixture(t, time.Minute)
	f.acquire(t, "test/model")
	f.mu.Lock()
	f.disabled = []string{"test/title"}
	f.mu.Unlock()
	if _, err := f.backend.Acquire(context.Background(), "test/title"); err == nil {
		t.Fatal("disabled same-tier model reused the cached key")
	}
	if f.keyRequests() != 1 {
		t.Fatal("disabled model redeemed a key")
	}
	f.mu.Lock()
	f.disabled = nil
	f.prices["test/model"] = 2
	f.mu.Unlock()
	f.acquire(t, "test/model")
	if f.keyRequests() != 2 {
		t.Fatal("changed model price reused the old tier")
	}
	f.acquire(t, "test/title")
	if f.keyRequests() != 3 {
		t.Fatal("switching back to a prior tier resurrected an older key")
	}
	f.mu.Lock()
	delete(f.prices, "test/title")
	f.mu.Unlock()
	if _, err := f.backend.Acquire(context.Background(), "test/title"); err == nil {
		t.Fatal("unpriced model reused a cached key")
	}
	if f.keyRequests() != 3 {
		t.Fatal("unpriced model redeemed a key")
	}
}

func TestKeyReuseCancellationWhileWaitingDoesNotRedeem(t *testing.T) {
	f := newReuseFixture(t, time.Minute)
	f.backend.acquireGate <- struct{}{}
	defer func() { <-f.backend.acquireGate }()
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	credential, err := f.backend.Acquire(ctx, "test/model")
	if !errors.Is(err, context.DeadlineExceeded) || credential.Key != "" {
		t.Fatalf("queued acquisition ignored cancellation: %v", err)
	}
	if f.keyRequests() != 0 || f.policyCalls.Load() != 0 {
		t.Fatal("canceled queued request contacted remote services")
	}
}

func TestKeyReuseInvalidationDoesNotDiscardReplacement(t *testing.T) {
	f := newReuseFixture(t, time.Minute)
	credential := f.acquire(t, "test/model")
	f.backend.InvalidateCredential("different-key")
	f.acquire(t, "test/model")
	if f.keyRequests() != 1 {
		t.Fatal("an older failed request invalidated a different credential")
	}
	f.backend.InvalidateCredential(credential.Key)
	f.acquire(t, "test/model")
	if f.keyRequests() != 2 {
		t.Fatal("provider failure did not invalidate the cached credential")
	}
}

func TestKeyReusePreservesOutageStatusAndKnownBan(t *testing.T) {
	f := newReuseFixture(t, time.Minute)
	f.issuer.mu.Lock()
	f.issuer.proofHTTP = http.StatusServiceUnavailable
	f.issuer.proofBody = `{"status":"unavailable"}`
	f.issuer.recentlyAttested = true
	f.issuer.mu.Unlock()
	first := f.acquire(t, "test/model")
	second := f.acquire(t, "test/title")
	if first != second || second.VerificationStatus != "verifier-unavailable" || second.VerificationDetail != "recently_attested_outage" || f.keyRequests() != 1 {
		t.Fatal("reuse changed outage credential status or redeemed another key")
	}
	f.backend.banned.Store("station-1", true)
	if credential, err := f.backend.Acquire(context.Background(), "test/model"); err == nil || credential.Key != "" {
		t.Fatal("a known banned station's cached key was reused")
	}
}

func TestKeyReuseZeroDisablesCaching(t *testing.T) {
	f := newReuseFixture(t, 0)
	f.acquire(t, "test/model")
	f.acquire(t, "test/model")
	if f.keyRequests() != 2 || f.backend.cached.credential.Key != "" {
		t.Fatal("zero reuse window did not preserve per-request acquisition")
	}
}

func TestKeyReuseRejectsUnboundedConfiguration(t *testing.T) {
	for _, window := range []time.Duration{-time.Second, 5*time.Minute + time.Nanosecond} {
		if _, err := New(Config{KeyReuseWindow: window}); err == nil {
			t.Fatalf("accepted invalid key reuse window %v", window)
		}
	}
}
