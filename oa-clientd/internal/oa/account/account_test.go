package account

import (
	"bytes"
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/ecdh"
	"crypto/hkdf"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/OpenAnonymity/oa-chat/oa-clientd/internal/oa/oatest"
	"github.com/OpenAnonymity/oa-chat/oa-clientd/internal/oa/securefile"
	"github.com/OpenAnonymity/oa-chat/oa-clientd/internal/oa/wallet"
)

const (
	testAccount = "1234567890123456"
	testChat    = "https://chat.test"
	testOrg     = "https://org.test"
)

var testMaster = []byte("0123456789abcdef0123456789abcdef")

// fakeOrg is the account side of oa-org: the daemon handshake, a SuperTokens
// style header session, and the last-write-wins blob store.
type fakeOrg struct {
	mu          sync.Mutex
	blobs       map[string]Blob
	access      string
	refresh     string
	refreshUsed int
	revoked     bool
	failSync    int
	failPush    bool
	partialPush bool
	pushes      [][]Blob
	requests    []string
	headers     []http.Header
	polls       int
	// Handshake script.
	sealedFor   func(publicKey []byte, transaction string) sealedEnvelope
	pollStatus  func(polls int) (int, map[string]any)
	publicKey   []byte
	transaction string
	completes   int
	cancels     int
	completeErr int
}

func newFakeOrg() *fakeOrg {
	return &fakeOrg{blobs: map[string]Blob{}, access: "access-1", refresh: "refresh-1"}
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func (o *fakeOrg) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	o.mu.Lock()
	defer o.mu.Unlock()
	o.requests = append(o.requests, r.Method+" "+r.URL.RequestURI())
	o.headers = append(o.headers, r.Header.Clone())
	switch r.URL.Path {
	case "/auth/session/refresh":
		o.refreshUsed++
		if o.revoked || r.Header.Get("Authorization") != "Bearer "+o.refresh {
			writeJSON(w, 401, map[string]string{"message": "unauthorised"})
			return
		}
		o.access = fmt.Sprintf("access-%d", o.refreshUsed+1)
		o.refresh = fmt.Sprintf("refresh-%d", o.refreshUsed+1)
		w.Header().Set("st-access-token", o.access)
		w.Header().Set("st-refresh-token", o.refresh)
		writeJSON(w, 200, map[string]string{})
		return
	case "/auth/daemon/start":
		var body struct {
			Key string `json:"daemonPublicKey"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		o.publicKey, _ = base64.RawURLEncoding.DecodeString(body.Key)
		o.transaction = strings.Repeat("T", 43)
		writeJSON(w, 200, map[string]any{"transaction": o.transaction, "userCode": "ABCD-EF23", "expiresIn": 600, "pollInterval": 1})
		return
	case "/auth/daemon/poll":
		o.polls++
		status, body := o.pollStatus(o.polls)
		writeJSON(w, status, body)
		return
	case "/auth/daemon/cancel":
		o.cancels++
		writeJSON(w, 200, map[string]bool{"success": true})
		return
	case "/auth/daemon/complete":
		o.completes++
		if o.completeErr != 0 {
			writeJSON(w, o.completeErr, map[string]any{"detail": map[string]string{"code": "DAEMON_AUTH_ALREADY_USED"}})
			return
		}
		w.Header().Set("st-access-token", o.access)
		w.Header().Set("st-refresh-token", o.refresh)
		writeJSON(w, 200, map[string]bool{"success": true})
		return
	}
	if r.Header.Get("Authorization") != "Bearer "+o.access || o.revoked {
		writeJSON(w, 401, map[string]string{"message": "try refresh token"})
		return
	}
	switch {
	case r.URL.Path == "/auth/signout":
		o.revoked = true
		writeJSON(w, 200, map[string]string{"status": "OK"})
	case r.URL.Path == "/auth/sync" && r.Method == http.MethodGet:
		if o.failSync > 0 {
			o.failSync--
			writeJSON(w, 503, map[string]string{"error": "down"})
			return
		}
		list := []Blob{}
		for _, blob := range o.blobs {
			list = append(list, blob)
		}
		writeJSON(w, 200, map[string]any{"blobs": list, "server_time": 1000})
	case r.URL.Path == "/auth/sync" && r.Method == http.MethodPost:
		if o.failPush {
			writeJSON(w, 503, map[string]string{"error": "down"})
			return
		}
		var body struct {
			Blobs []Blob `json:"blobs"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		o.pushes = append(o.pushes, body.Blobs)
		accepted := []string{}
		for i, blob := range body.Blobs {
			if o.partialPush && i > 0 {
				break
			}
			o.blobs[blob.ID] = blob
			accepted = append(accepted, blob.ID)
		}
		writeJSON(w, 200, map[string]any{"accepted": accepted})
	default:
		writeJSON(w, 404, map[string]string{"detail": "Not Found"})
	}
}

type recordingPrompter struct {
	link, code string
	opened     bool
}

func (p *recordingPrompter) Authorize(link, code string, opened bool, _ time.Duration) {
	p.link, p.code, p.opened = link, code, opened
}

func noSleep(ctx context.Context, _ time.Duration) error { return ctx.Err() }

// browserSeal is the browser's sealForDaemon, independently written for tests;
// testdata/daemon-auth-v1.json pins the browser's real output against openEnvelope.
func browserSeal(t *testing.T, publicKey []byte, transaction, account, origin string, master []byte) sealedEnvelope {
	t.Helper()
	ephemeral, err := ecdh.P256().GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	peer, err := ecdh.P256().NewPublicKey(publicKey)
	if err != nil {
		t.Fatal(err)
	}
	shared, err := ephemeral.ECDH(peer)
	if err != nil {
		t.Fatal(err)
	}
	salt := sha256.Sum256([]byte(transaction))
	key, err := hkdf.Key(sha256.New, shared, salt[:], envelopeInfo+"|"+hex.EncodeToString(publicKey)+"|"+hex.EncodeToString(ephemeral.PublicKey().Bytes()), 32)
	if err != nil {
		t.Fatal(err)
	}
	block, _ := aes.NewCipher(key)
	aead, _ := cipher.NewGCM(block)
	nonce := make([]byte, 12)
	rand.Read(nonce)
	plaintext, _ := json.Marshal(envelopePlaintext{Version: 1, AccountID: account, Transaction: transaction, Origin: origin, MasterKey: base64.RawURLEncoding.EncodeToString(master)})
	return sealedEnvelope{
		EphemeralKey: base64.RawURLEncoding.EncodeToString(ephemeral.PublicKey().Bytes()),
		Nonce:        base64.RawURLEncoding.EncodeToString(nonce),
		Ciphertext:   base64.RawURLEncoding.EncodeToString(aead.Seal(nil, nonce, plaintext, []byte(envelopeAADLabel+"|"+transaction))),
	}
}

func approvedScript(t *testing.T, org *fakeOrg, account, origin string) func(int) (int, map[string]any) {
	return func(polls int) (int, map[string]any) {
		if polls < 3 {
			return 200, map[string]any{"status": "pending"}
		}
		return 200, map[string]any{"status": "approved", "accountId": testAccount, "accountKind": "username", "label": "alice",
			"sealed": browserSeal(t, org.publicKey, org.transaction, account, origin, testMaster)}
	}
}

func authorizer(org *fakeOrg, prompter Prompter) *Authorizer {
	return &Authorizer{OrgURL: testOrg, ChatURL: testChat, Client: oatest.Client(org), Prompter: prompter,
		OpenBrowser: func(string) error { return nil }, ClientName: "oa-clientd", Version: "test", sleep: noSleep}
}

func TestAuthorizeHappyPathOpensBrowserAndKeepsSecretsInFragment(t *testing.T) {
	org := newFakeOrg()
	org.pollStatus = approvedScript(t, org, testAccount, testChat)
	prompter := &recordingPrompter{}
	auth := authorizer(org, prompter)
	var opened string
	auth.OpenBrowser = func(link string) error { opened = link; return nil }
	result, err := auth.Run(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if result.Identity.AccountID != testAccount || string(result.Identity.MasterKey) != string(testMaster) {
		t.Fatalf("identity = %+v", result.Identity.AccountID)
	}
	if result.Identity.Access != "access-1" || result.Identity.Refresh != "refresh-1" || !deviceIDPattern.MatchString(result.Identity.DeviceID) {
		t.Fatal("session or device ID missing")
	}
	if opened == "" || opened != prompter.link || prompter.code != "ABCD-EF23" || !prompter.opened {
		t.Fatalf("browser link = %q, code = %q", opened, prompter.code)
	}
	parsed, _ := url.Parse(opened)
	if parsed.RawQuery != "" || parsed.Host != "chat.test" || !strings.HasPrefix(parsed.Fragment, "oa-daemon=") {
		t.Fatalf("link must carry its payload in the fragment only: %s", opened)
	}
	// The verifier and code never travel in a URL, and nothing in the handshake
	// carries a session or cookie before completion.
	for _, request := range org.requests {
		if strings.Contains(request, "?") {
			t.Fatalf("query string on %s", request)
		}
	}
	for _, header := range org.headers {
		if header.Get("Cookie") != "" || header.Get("Authorization") != "" {
			t.Fatal("anonymous handshake carried a credential")
		}
	}
}

func TestAuthorizeRetriesNetworkAndServerFailuresWithinDeadline(t *testing.T) {
	org := newFakeOrg()
	script := approvedScript(t, org, testAccount, testChat)
	org.pollStatus = func(polls int) (int, map[string]any) {
		if polls == 1 {
			return 503, map[string]any{"error": "down"}
		}
		return script(polls)
	}
	if _, err := authorizer(org, &recordingPrompter{}).Run(context.Background()); err != nil {
		t.Fatal(err)
	}
}

func TestAuthorizeNoBrowserStillPrintsLink(t *testing.T) {
	org := newFakeOrg()
	org.pollStatus = approvedScript(t, org, testAccount, testChat)
	prompter := &recordingPrompter{}
	auth := authorizer(org, prompter)
	auth.OpenBrowser = func(string) error { return errors.New("no display") }
	if _, err := auth.Run(context.Background()); err != nil {
		t.Fatal(err)
	}
	if prompter.opened || prompter.link == "" {
		t.Fatal("fallback link must be shown when the browser cannot open")
	}
}

func TestAuthorizeRefusals(t *testing.T) {
	cases := []struct {
		name     string
		script   func(*testing.T, *fakeOrg) func(int) (int, map[string]any)
		expected string
		setup    func(*Authorizer)
		withdraw bool
		noSess   bool
	}{
		{
			name: "declined",
			script: func(*testing.T, *fakeOrg) func(int) (int, map[string]any) {
				return func(int) (int, map[string]any) {
					return 403, map[string]any{"detail": map[string]string{"code": "DAEMON_AUTH_DENIED"}}
				}
			},
			expected: "declined", noSess: true,
		},
		{
			name: "expired",
			script: func(*testing.T, *fakeOrg) func(int) (int, map[string]any) {
				return func(int) (int, map[string]any) {
					return 410, map[string]any{"detail": map[string]string{"code": "DAEMON_AUTH_EXPIRED"}}
				}
			},
			expected: "expired", noSess: true,
		},
		{
			name: "envelope from another app origin",
			script: func(t *testing.T, o *fakeOrg) func(int) (int, map[string]any) {
				return approvedScript(t, o, testAccount, "https://evil.example")
			},
			expected: "another OA app", withdraw: true, noSess: true,
		},
		{
			name: "browser and org disagree about the account",
			script: func(t *testing.T, o *fakeOrg) func(int) (int, map[string]any) {
				return approvedScript(t, o, "6543210987654321", testChat)
			},
			expected: "disagree", withdraw: true, noSess: true,
		},
		{
			name: "profile bound to another account",
			script: func(t *testing.T, o *fakeOrg) func(int) (int, map[string]any) {
				return approvedScript(t, o, testAccount, testChat)
			},
			setup:    func(a *Authorizer) { a.ExpectedAccount = "6543210987654321" },
			expected: "different account", withdraw: true, noSess: true,
		},
		{
			name: "ciphertext for another transaction",
			script: func(t *testing.T, o *fakeOrg) func(int) (int, map[string]any) {
				return func(int) (int, map[string]any) {
					return 200, map[string]any{"status": "approved", "accountId": testAccount,
						"sealed": browserSeal(t, o.publicKey, strings.Repeat("X", 43), testAccount, testChat, testMaster)}
				}
			},
			expected: "could not be opened", withdraw: true, noSess: true,
		},
		{
			name: "server tampered with the ciphertext",
			script: func(t *testing.T, o *fakeOrg) func(int) (int, map[string]any) {
				return func(int) (int, map[string]any) {
					sealed := browserSeal(t, o.publicKey, o.transaction, testAccount, testChat, testMaster)
					sealed.Ciphertext = base64.RawURLEncoding.EncodeToString(make([]byte, 64))
					return 200, map[string]any{"status": "approved", "accountId": testAccount, "sealed": sealed}
				}
			},
			expected: "could not be opened", withdraw: true, noSess: true,
		},
		{
			name: "short key in the envelope",
			script: func(t *testing.T, o *fakeOrg) func(int) (int, map[string]any) {
				return func(int) (int, map[string]any) {
					return 200, map[string]any{"status": "approved", "accountId": testAccount,
						"sealed": browserSeal(t, o.publicKey, o.transaction, testAccount, testChat, []byte("short"))}
				}
			},
			expected: "invalid key", withdraw: true, noSess: true,
		},
		{
			name: "malformed account",
			script: func(*testing.T, *fakeOrg) func(int) (int, map[string]any) {
				return func(int) (int, map[string]any) {
					return 200, map[string]any{"status": "approved", "accountId": "../../evil"}
				}
			},
			expected: "invalid authorization", noSess: true,
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			org := newFakeOrg()
			org.pollStatus = c.script(t, org)
			auth := authorizer(org, &recordingPrompter{})
			if c.setup != nil {
				c.setup(auth)
			}
			_, err := auth.Run(context.Background())
			if err == nil || !strings.Contains(err.Error(), c.expected) {
				t.Fatalf("err = %v, want %q", err, c.expected)
			}
			if c.withdraw && org.cancels != 1 {
				t.Fatalf("cancels = %d", org.cancels)
			}
			if c.noSess && org.completes != 0 {
				t.Fatal("a refused authorization must not create a session")
			}
		})
	}
}

func TestAuthorizeCancelWithdraws(t *testing.T) {
	org := newFakeOrg()
	ctx, cancel := context.WithCancel(context.Background())
	org.pollStatus = func(int) (int, map[string]any) {
		cancel()
		return 200, map[string]any{"status": "pending"}
	}
	_, err := authorizer(org, &recordingPrompter{}).Run(ctx)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("err = %v", err)
	}
	if org.cancels != 1 || org.completes != 0 {
		t.Fatalf("cancels=%d completes=%d", org.cancels, org.completes)
	}
}

func TestAuthorizeDeadlineIsBounded(t *testing.T) {
	org := newFakeOrg()
	org.pollStatus = func(int) (int, map[string]any) { return 200, map[string]any{"status": "pending"} }
	auth := authorizer(org, &recordingPrompter{})
	clock := time.Unix(1000, 0)
	auth.now = func() time.Time { return clock }
	auth.sleep = func(ctx context.Context, d time.Duration) error { clock = clock.Add(d); return ctx.Err() }
	if _, err := auth.Run(context.Background()); !errors.Is(err, ErrExpired) {
		t.Fatalf("err = %v", err)
	}
	if clock.Sub(time.Unix(1000, 0)) > maxAuthDeadline {
		t.Fatal("waited past the bound")
	}
}

func TestLostCompletionResponseAsksTheOrgToEndTheSession(t *testing.T) {
	org := newFakeOrg()
	org.pollStatus = approvedScript(t, org, testAccount, testChat)
	auth := authorizer(org, &recordingPrompter{})
	drop := &dropFirstComplete{next: oatest.Transport{Handler: org}}
	auth.Client = &http.Client{Transport: drop}
	if _, err := auth.Run(context.Background()); err == nil {
		t.Fatal("expected failure")
	}
	if org.completes != 1 || !drop.dropped {
		t.Fatalf("completes=%d dropped=%v", org.completes, drop.dropped)
	}
}

type dropFirstComplete struct {
	next    http.RoundTripper
	dropped bool
}

func (d *dropFirstComplete) RoundTrip(r *http.Request) (*http.Response, error) {
	if r.URL.Path == "/auth/daemon/complete" && !d.dropped {
		d.dropped = true
		return nil, errors.New("connection reset")
	}
	return d.next.RoundTrip(r)
}

func TestPresentNeedsNoSessionLock(t *testing.T) {
	org := newFakeOrg()
	session, dir := newSession(t, org)
	if err := session.Present(); err != nil {
		t.Fatal(err)
	}
	lock, err := securefile.TryLock(filepath.Join(dir, sessionLockFile))
	if err != nil {
		t.Fatal(err)
	}
	defer lock.Release()
	session.mu.Lock()
	defer session.mu.Unlock()
	if err := session.Present(); err != nil {
		t.Fatalf("present while a refresh holds the lock: %v", err)
	}
}

func TestAuthorizeReplayedCompletionFailsCleanly(t *testing.T) {
	org := newFakeOrg()
	org.pollStatus = approvedScript(t, org, testAccount, testChat)
	org.completeErr = 409
	_, err := authorizer(org, &recordingPrompter{}).Run(context.Background())
	if err == nil || !strings.Contains(err.Error(), "DAEMON_AUTH_ALREADY_USED") {
		t.Fatalf("err = %v", err)
	}
}

// The vector is a copy of the web app's test/fixtures/daemon-auth-v1.json, kept
// here so the module tests stand alone; in a checkout of the repository both
// copies must be the same bytes.
func TestBrowserVectorMatchesTheWebAppFixture(t *testing.T) {
	web, err := os.ReadFile("../../../../test/fixtures/daemon-auth-v1.json")
	if errors.Is(err, fs.ErrNotExist) {
		t.Skip("not inside the oa-chat repository")
	}
	if err != nil {
		t.Fatal(err)
	}
	local, err := os.ReadFile("testdata/daemon-auth-v1.json")
	if err != nil || !bytes.Equal(web, local) {
		t.Fatalf("testdata/daemon-auth-v1.json differs from the web app's fixture (err=%v)", err)
	}
}

func TestBrowserVectorOpensInGo(t *testing.T) {
	data, err := os.ReadFile("testdata/daemon-auth-v1.json")
	if err != nil {
		t.Fatal(err)
	}
	var vector struct {
		Transaction string `json:"transaction"`
		AccountID   string `json:"accountId"`
		Origin      string `json:"origin"`
		MasterKey   string `json:"masterKey"`
		Daemon      struct {
			D string `json:"d"`
		} `json:"daemonPrivateJwk"`
		DaemonPublicKey string         `json:"daemonPublicKey"`
		Sealed          sealedEnvelope `json:"sealed"`
		SyncBlobs       struct {
			Active Blob `json:"active"`
			Lease  Blob `json:"lease"`
		} `json:"syncBlobs"`
	}
	if err := json.Unmarshal(data, &vector); err != nil {
		t.Fatal(err)
	}
	scalar, err := base64.RawURLEncoding.DecodeString(vector.Daemon.D)
	if err != nil {
		t.Fatal(err)
	}
	private, err := ecdh.P256().NewPrivateKey(scalar)
	if err != nil {
		t.Fatal(err)
	}
	message, err := openEnvelope(private, vector.Transaction, vector.Origin, vector.Sealed)
	if err != nil {
		t.Fatalf("browser envelope did not open: %v", err)
	}
	if message.AccountID != vector.AccountID || message.MasterKey != vector.MasterKey {
		t.Fatalf("message = %+v", message.AccountID)
	}
	if _, err := openEnvelope(private, vector.Transaction, "https://evil.example", vector.Sealed); err == nil {
		t.Fatal("wrong origin accepted")
	}
	// The browser's sync blobs decrypt and address identically in Go.
	master, _ := base64.RawURLEncoding.DecodeString(vector.MasterKey)
	if BlobID(master, logicalActive) != vector.SyncBlobs.Active.ID {
		t.Fatal("opaque blob IDs differ from the browser's")
	}
	remote, err := decodeRemote(master, []Blob{vector.SyncBlobs.Active, vector.SyncBlobs.Lease})
	if err != nil {
		t.Fatal(err)
	}
	if len(remote.Active) != 1 || remote.Active[0].Token != "tok-1" || !strings.Contains(string(remote.Active[0].Raw), "keep-me") {
		t.Fatalf("active = %+v", remote.Active)
	}
	if lease := remote.Leases[strings.Repeat("a", 32)]; lease.ExpiresAtMS != 123 || len(lease.Fingerprints) != 1 {
		t.Fatalf("lease = %+v", lease)
	}
}

// Identity helpers shared by the session and sync tests.
func newSession(t *testing.T, org *fakeOrg) (*Session, string) {
	t.Helper()
	dir := oatest.PrivateDir(t)
	client, err := AccountClient(oatest.Client(org), testOrg)
	if err != nil {
		t.Fatal(err)
	}
	session := NewSession(dir, testOrg, client)
	err = session.Save(context.Background(), &Identity{AccountID: testAccount, AccountKind: "username", OrgURL: testOrg,
		DeviceID: strings.Repeat("d", 32), MasterKey: testMaster, Access: org.access, Refresh: org.refresh})
	if err != nil {
		t.Fatal(err)
	}
	return session, dir
}

func TestAccountClientRefusesEverythingButTheAccountSurface(t *testing.T) {
	org := newFakeOrg()
	client, _ := AccountClient(oatest.Client(org), testOrg)
	for _, target := range []string{
		testOrg + "/api/request_key",
		testOrg + "/chat/model-tickets",
		testOrg + "/api/billing/tickets/claim",
		testOrg + "/api/billing/checkout",
		testOrg + "/auth/keyring",
		"https://evil.example/auth/sync",
		"https://openrouter.ai/api/v1/chat/completions",
	} {
		response, err := client.Post(target, "application/json", strings.NewReader("{}"))
		if err == nil {
			response.Body.Close()
			t.Fatalf("%s was allowed", target)
		}
	}
	if len(org.requests) != 0 {
		t.Fatalf("requests reached the org: %v", org.requests)
	}
}

func TestSessionRefreshesOnceAndRotatesDurably(t *testing.T) {
	org := newFakeOrg()
	session, dir := newSession(t, org)
	org.access = "server-rotated"
	status, _, err := session.Do(context.Background(), http.MethodGet, "/auth/sync?since=0", nil)
	if err != nil || status != 200 {
		t.Fatalf("status=%d err=%v", status, err)
	}
	if org.refreshUsed != 1 {
		t.Fatalf("refreshes = %d", org.refreshUsed)
	}
	reloaded := NewSession(dir, testOrg, session.client)
	identity, err := reloaded.Load(context.Background())
	if err != nil || identity.Refresh != org.refresh || identity.Access != org.access {
		t.Fatalf("rotation not durable: %+v %v", identity, err)
	}
	info, err := os.Stat(filepath.Join(dir, sessionFile))
	if err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("session mode = %v", info.Mode())
	}
}

func TestRevocationErasesCredentialsAndSaysSo(t *testing.T) {
	org := newFakeOrg()
	session, dir := newSession(t, org)
	org.revoked = true
	_, _, err := session.Do(context.Background(), http.MethodGet, "/auth/sync?since=0", nil)
	if !errors.Is(err, ErrRevoked) {
		t.Fatalf("err = %v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, sessionFile)); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("the sync key and tokens must be erased on revocation")
	}
	if _, err := session.Load(context.Background()); !errors.Is(err, ErrSignedOut) {
		t.Fatalf("load = %v", err)
	}
}

func TestSessionRefusesAnotherDeployment(t *testing.T) {
	org := newFakeOrg()
	session, dir := newSession(t, org)
	other := NewSession(dir, "https://staging.test", session.client)
	if _, err := other.Load(context.Background()); err == nil || !strings.Contains(err.Error(), "another OA deployment") {
		t.Fatalf("err = %v", err)
	}
}

func TestSessionRefusesASymlinkedSecretFile(t *testing.T) {
	org := newFakeOrg()
	session, dir := newSession(t, org)
	path := filepath.Join(dir, sessionFile)
	moved := filepath.Join(dir, "moved.json")
	os.Rename(path, moved)
	os.Symlink(moved, path)
	if _, err := session.Load(context.Background()); err == nil || !strings.Contains(err.Error(), "symbolic link") {
		t.Fatalf("err = %v", err)
	}
}

// browser is a second client on the same account with the browser's rules.
type peer struct {
	syncer *Syncer
	store  *wallet.Store
}

func newPeer(t *testing.T, org *fakeOrg, device string, lease int) *peer {
	t.Helper()
	dir := oatest.PrivateDir(t)
	client, _ := AccountClient(oatest.Client(org), testOrg)
	session := NewSession(dir, testOrg, client)
	if err := session.Save(context.Background(), &Identity{AccountID: testAccount, OrgURL: testOrg, DeviceID: device, MasterKey: testMaster, Access: org.access, Refresh: org.refresh}); err != nil {
		t.Fatal(err)
	}
	store, _ := wallet.Open(dir)
	return &peer{syncer: &Syncer{Session: session, Store: store, LeaseSize: lease}, store: store}
}

func (p *peer) state(t *testing.T) *wallet.State {
	t.Helper()
	var snapshot *wallet.State
	if err := p.store.View(context.Background(), func(st *wallet.State) error { snapshot = st; return nil }); err != nil {
		t.Fatal(err)
	}
	return snapshot
}

func webTicket(token string) wallet.Ticket {
	raw, _ := json.Marshal(map[string]any{"finalized_ticket": token, "signed_response": "keep"})
	return wallet.Ticket{Token: token, Raw: raw}
}

func seedBrowser(t *testing.T, org *fakeOrg, active, archive []wallet.Ticket) {
	t.Helper()
	for logical, tickets := range map[string][]wallet.Ticket{logicalActive: active, logicalArchive: archive} {
		payload, err := ticketPayload(tickets)
		if err != nil {
			t.Fatal(err)
		}
		blob, err := Seal(testMaster, logical, BlobID(testMaster, logical), payload)
		if err != nil {
			t.Fatal(err)
		}
		org.blobs[blob.ID] = blob
	}
}

func readBlob(t *testing.T, org *fakeOrg, logical string) []wallet.Ticket {
	t.Helper()
	blob, ok := org.blobs[BlobID(testMaster, logical)]
	if !ok {
		return nil
	}
	plaintext, err := Open(testMaster, logical, blob)
	if err != nil {
		t.Fatal(err)
	}
	var payload blobPayload
	var tickets []wallet.Ticket
	if json.Unmarshal(plaintext, &payload) != nil || json.Unmarshal(payload.Data, &tickets) != nil {
		t.Fatal("unreadable blob")
	}
	return tickets
}

func TestFirstSyncTakesTheWalletWithoutRewritingIt(t *testing.T) {
	org := newFakeOrg()
	seedBrowser(t, org, []wallet.Ticket{webTicket("a"), webTicket("b"), webTicket("c")}, nil)
	before := org.blobs[BlobID(testMaster, logicalActive)]
	p := newPeer(t, org, strings.Repeat("a", 32), 2)
	outcome, err := p.syncer.Once(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if outcome.Active != 3 || outcome.Available != 3 {
		t.Fatalf("outcome = %+v", outcome)
	}
	if org.blobs[BlobID(testMaster, logicalActive)].Ciphertext != before.Ciphertext {
		t.Fatal("a sync with nothing new must not overwrite the wallet")
	}
	// Only the lease record was written.
	if len(org.pushes) != 1 || len(org.pushes[0]) != 1 {
		t.Fatalf("pushes = %v", org.pushes)
	}
	if !strings.Contains(strings.Join(org.requests, " "), "since=0") {
		t.Fatal("expected a full pull")
	}
	state := p.state(t)
	if len(state.Lease.Fingerprints) != 2 || state.LeaseDirty {
		t.Fatalf("lease = %+v dirty=%v", state.Lease, state.LeaseDirty)
	}
}

func TestSecondSyncIsQuiet(t *testing.T) {
	org := newFakeOrg()
	seedBrowser(t, org, []wallet.Ticket{webTicket("a")}, nil)
	p := newPeer(t, org, strings.Repeat("a", 32), 2)
	if _, err := p.syncer.Once(context.Background()); err != nil {
		t.Fatal(err)
	}
	pushes := len(org.pushes)
	outcome, err := p.syncer.Once(context.Background())
	if err != nil || !outcome.Skipped || len(org.pushes) != pushes {
		t.Fatalf("outcome=%+v err=%v pushes=%d", outcome, err, len(org.pushes))
	}
}

func TestWrongKeyAbortsBeforeAnyWrite(t *testing.T) {
	org := newFakeOrg()
	seedBrowser(t, org, []wallet.Ticket{webTicket("a")}, nil)
	before := org.blobs[BlobID(testMaster, logicalActive)]
	p := newPeer(t, org, strings.Repeat("a", 32), 2)
	identity, _ := p.syncer.Session.Load(context.Background())
	identity.MasterKey = []byte("ffffffffffffffffffffffffffffffff")
	// The wrong key addresses different blob IDs, so plant the account's blob
	// where this key looks: it must refuse rather than treat it as empty.
	blob := before
	blob.ID = BlobID(identity.MasterKey, logicalActive)
	org.blobs[blob.ID] = blob
	p.syncer.Session.Save(context.Background(), identity)
	if _, err := p.syncer.Once(context.Background()); !errors.Is(err, ErrWrongKey) {
		t.Fatalf("err = %v", err)
	}
	if len(org.pushes) != 0 {
		t.Fatal("a wrong key must never write")
	}
}

func TestSyncRefusesAnotherAccountsReplica(t *testing.T) {
	org := newFakeOrg()
	p := newPeer(t, org, strings.Repeat("a", 32), 2)
	p.store.Create(context.Background(), testOrg, "6543210987654321", strings.Repeat("a", 32))
	if _, err := p.syncer.Once(context.Background()); !errors.Is(err, wallet.ErrOtherAccount) {
		t.Fatalf("err = %v", err)
	}
	if len(org.pushes) != 0 {
		t.Fatal("must not write")
	}
}

func spendLocally(t *testing.T, p *peer, cost int) *wallet.Reservation {
	t.Helper()
	var reservation *wallet.Reservation
	err := p.store.Update(context.Background(), func(st *wallet.State) error {
		var err error
		reservation, err = st.Reserve("r", "nonce", cost, func(wallet.Ticket) bool { return true }, time.Now())
		if err != nil {
			return err
		}
		st.CommitSpent(reservation.ID, time.Now())
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	return reservation
}

func TestSpendPropagatesOnNextSyncAndNeverDropsUnknownFields(t *testing.T) {
	org := newFakeOrg()
	seedBrowser(t, org, []wallet.Ticket{webTicket("a"), webTicket("b")}, nil)
	p := newPeer(t, org, strings.Repeat("a", 32), 2)
	if _, err := p.syncer.Once(context.Background()); err != nil {
		t.Fatal(err)
	}
	pushes := len(org.pushes)
	reservation := spendLocally(t, p, 1)
	if len(org.pushes) != pushes {
		t.Fatal("redemption must not trigger an immediate authenticated request")
	}
	if _, err := p.syncer.Once(context.Background()); err != nil {
		t.Fatal(err)
	}
	archive := readBlob(t, org, logicalArchive)
	if len(archive) != 1 || archive[0].Token != reservation.Tickets[0].Token {
		t.Fatalf("archive = %+v", archive)
	}
	if !strings.Contains(string(archive[0].Raw), "signed_response") || !strings.Contains(string(archive[0].Raw), "consumed_at") {
		t.Fatalf("archive record = %s", archive[0].Raw)
	}
	for _, active := range readBlob(t, org, logicalActive) {
		if active.Token == reservation.Tickets[0].Token {
			t.Fatal("a consumed ticket stayed active remotely")
		}
	}
}

func TestOfflineSyncKeepsChangesAndRetriesExactly(t *testing.T) {
	org := newFakeOrg()
	seedBrowser(t, org, []wallet.Ticket{webTicket("a"), webTicket("b")}, nil)
	p := newPeer(t, org, strings.Repeat("a", 32), 2)
	if _, err := p.syncer.Once(context.Background()); err != nil {
		t.Fatal(err)
	}
	spent := spendLocally(t, p, 1).Tickets[0].Token

	org.failSync = 1
	if _, err := p.syncer.Once(context.Background()); err == nil {
		t.Fatal("expected pull failure")
	}
	org.failPush = true
	if _, err := p.syncer.Once(context.Background()); err == nil {
		t.Fatal("expected push failure")
	}
	if !p.state(t).Dirty {
		t.Fatal("a failed push must keep the change marked")
	}
	org.failPush = false
	org.partialPush = true
	if _, err := p.syncer.Once(context.Background()); err == nil {
		t.Fatal("a partial store must not count as done")
	}
	if !p.state(t).Dirty {
		t.Fatal("a partial push must keep the change marked")
	}
	org.partialPush = false
	if _, err := p.syncer.Once(context.Background()); err != nil {
		t.Fatal(err)
	}
	state := p.state(t)
	if state.Dirty || !state.Spent[wallet.Fingerprint(spent)] {
		t.Fatalf("dirty=%v", state.Dirty)
	}
	if archive := readBlob(t, org, logicalArchive); len(archive) != 1 || archive[0].Token != spent {
		t.Fatalf("archive = %+v", archive)
	}
}

func TestRestartResumesFromDisk(t *testing.T) {
	org := newFakeOrg()
	seedBrowser(t, org, []wallet.Ticket{webTicket("a")}, nil)
	p := newPeer(t, org, strings.Repeat("a", 32), 1)
	p.syncer.Once(context.Background())
	spendLocally(t, p, 1)
	org.failPush = true
	p.syncer.Once(context.Background())
	org.failPush = false
	restarted := &Syncer{Session: p.syncer.Session, Store: p.store, LeaseSize: 1}
	if _, err := restarted.Once(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(readBlob(t, org, logicalArchive)) != 1 {
		t.Fatal("the spend made before the restart was lost")
	}
}

func TestTwoClientsConvergeAndHoldDisjointLeases(t *testing.T) {
	org := newFakeOrg()
	tickets := []wallet.Ticket{}
	for i := 0; i < 8; i++ {
		tickets = append(tickets, webTicket(fmt.Sprintf("t%d", i)))
	}
	seedBrowser(t, org, tickets, nil)
	first := newPeer(t, org, strings.Repeat("a", 32), 3)
	second := newPeer(t, org, strings.Repeat("b", 32), 3)
	ctx := context.Background()
	for _, p := range []*peer{first, second, first, second} {
		if _, err := p.syncer.Once(ctx); err != nil {
			t.Fatal(err)
		}
	}
	held := map[string]bool{}
	for _, fingerprint := range first.state(t).Lease.Fingerprints {
		held[fingerprint] = true
	}
	for _, fingerprint := range second.state(t).Lease.Fingerprints {
		if held[fingerprint] {
			t.Fatal("two clients leased the same ticket")
		}
	}
	if len(second.state(t).OtherLeases) != 1 || second.state(t).Available(time.Now()) != 5 {
		t.Fatalf("second sees %+v", second.state(t).OtherLeases)
	}
	spent := spendLocally(t, first, 2)
	for _, p := range []*peer{first, second} {
		if _, err := p.syncer.Once(ctx); err != nil {
			t.Fatal(err)
		}
	}
	active := map[string]bool{}
	for _, ticket := range second.state(t).Active {
		active[ticket.Token] = true
	}
	for _, ticket := range spent.Tickets {
		if active[ticket.Token] {
			t.Fatal("a ticket spent by one client stayed spendable on the other")
		}
	}
}

func TestLastWriteWinsRaceCannotResurrectAConsumedTicket(t *testing.T) {
	org := newFakeOrg()
	seedBrowser(t, org, []wallet.Ticket{webTicket("a"), webTicket("b")}, nil)
	p := newPeer(t, org, strings.Repeat("a", 32), 1)
	ctx := context.Background()
	p.syncer.Once(ctx)
	spent := spendLocally(t, p, 1).Tickets[0].Token
	p.syncer.Once(ctx)
	// A stale browser overwrites both records from before the spend.
	seedBrowser(t, org, []wallet.Ticket{webTicket("a"), webTicket("b")}, nil)
	if _, err := p.syncer.Once(ctx); err != nil {
		t.Fatal(err)
	}
	for _, active := range p.state(t).Active {
		if active.Token == spent {
			t.Fatal("stale write resurrected a spent ticket")
		}
	}
	found := false
	for _, archived := range readBlob(t, org, logicalArchive) {
		found = found || archived.Token == spent
	}
	if !found {
		t.Fatal("the next sync must restore the consumed record remotely")
	}
}

func TestFinalizeReleasesLeaseAndPublishesSpends(t *testing.T) {
	org := newFakeOrg()
	seedBrowser(t, org, []wallet.Ticket{webTicket("a"), webTicket("b")}, nil)
	p := newPeer(t, org, strings.Repeat("a", 32), 2)
	ctx := context.Background()
	p.syncer.Once(ctx)
	spendLocally(t, p, 1)
	if err := p.syncer.Finalize(ctx); err != nil {
		t.Fatal(err)
	}
	blob := org.blobs[BlobID(testMaster, logicalLeaseItem+":"+strings.Repeat("a", 32))]
	plaintext, err := Open(testMaster, logicalLeaseItem, blob)
	if err != nil {
		t.Fatal(err)
	}
	var lease struct {
		Fingerprints []string `json:"fingerprints"`
		ExpiresAtMS  int64    `json:"expires_at_ms"`
	}
	json.Unmarshal(plaintext, &lease)
	if len(lease.Fingerprints) != 0 || lease.ExpiresAtMS != 0 {
		t.Fatalf("lease after finalize = %+v", lease)
	}
	if len(readBlob(t, org, logicalArchive)) != 1 {
		t.Fatal("spend not published")
	}
	if p.syncer.LeaseSize != 2 {
		t.Fatal("finalize must restore the configured lease size")
	}
}

func TestForeignLeaseRecordCannotClaimAnotherDevicesID(t *testing.T) {
	// A record whose opaque ID does not match its stated device is ignored.
	blob, err := Seal(testMaster, logicalLeaseItem, "wrongid", struct {
		Type     string `json:"type"`
		DeviceID string `json:"device_id"`
	}{"ticket-lease", strings.Repeat("c", 32)})
	if err != nil {
		t.Fatal(err)
	}
	remote, err := decodeRemote(testMaster, []Blob{blob})
	if err != nil || len(remote.Leases) != 0 {
		t.Fatalf("leases = %+v err = %v", remote.Leases, err)
	}
	// A record from a newer client under an unknown key is left alone.
	unknown, _ := Seal([]byte(strings.Repeat("z", 32)), "future", "future-id", map[string]string{"type": "future"})
	if _, err := decodeRemote(testMaster, []Blob{unknown}); err != nil {
		t.Fatalf("unknown record must not fail the sync: %v", err)
	}
}

func TestPeerRemovalRecordsAreHonoredWhenTheSharedArchiveLostThem(t *testing.T) {
	org := newFakeOrg()
	seedBrowser(t, org, []wallet.Ticket{webTicket("a"), webTicket("b")}, nil)
	writer := strings.Repeat("9", 32)
	record, err := Seal(testMaster, logicalRemovals, BlobID(testMaster, logicalRemovals+":"+writer), removalsPayload{
		Type: "ticket-removals", WriterID: writer, Archived: []wallet.Ticket{webTicket("a")},
		Tombstones: []wallet.Tombstone{{Fingerprint: wallet.Fingerprint("b")}},
	})
	if err != nil {
		t.Fatal(err)
	}
	org.blobs[record.ID] = record
	p := newPeer(t, org, strings.Repeat("a", 32), 2)
	if _, err := p.syncer.Once(context.Background()); err != nil {
		t.Fatal(err)
	}
	state := p.state(t)
	if len(state.Active) != 0 || len(state.Archive) != 1 || state.Archive[0].Token != "a" {
		t.Fatalf("active=%d archive=%+v", len(state.Active), state.Archive)
	}
}

func TestRemovalRecordSurvivesEitherBlobOrder(t *testing.T) {
	writer := strings.Repeat("9", 32)
	record, err := Seal(testMaster, logicalRemovals, BlobID(testMaster, logicalRemovals+":"+writer), removalsPayload{
		Type: "ticket-removals", WriterID: writer, Archived: []wallet.Ticket{webTicket("a")},
		Tombstones: []wallet.Tombstone{{Fingerprint: wallet.Fingerprint("b")}},
	})
	if err != nil {
		t.Fatal(err)
	}
	emptyArchive, _ := ticketPayload(nil)
	archive, _ := Seal(testMaster, logicalArchive, BlobID(testMaster, logicalArchive), emptyArchive)
	tombstones, _ := Seal(testMaster, logicalTombstones, BlobID(testMaster, logicalTombstones), emptyArchive)
	for _, order := range [][]Blob{{record, archive, tombstones}, {archive, tombstones, record}} {
		remote, err := decodeRemote(testMaster, order)
		if err != nil {
			t.Fatal(err)
		}
		if len(remote.Archive) != 1 || len(remote.Tombstones) != 1 {
			t.Fatalf("archive=%d tombstones=%d", len(remote.Archive), len(remote.Tombstones))
		}
	}
}

func TestLeaseLeavesHalfASmallWalletToTheBrowser(t *testing.T) {
	org := newFakeOrg()
	seedBrowser(t, org, []wallet.Ticket{webTicket("a"), webTicket("b"), webTicket("c"), webTicket("d")}, nil)
	p := newPeer(t, org, strings.Repeat("a", 32), 30)
	if _, err := p.syncer.Once(context.Background()); err != nil {
		t.Fatal(err)
	}
	if got := len(p.state(t).Lease.Fingerprints); got != 2 {
		t.Fatalf("leased %d of 4", got)
	}
}

func publishedLease(t *testing.T, org *fakeOrg, device string) struct {
	Fingerprints []string `json:"fingerprints"`
	ExpiresAtMS  int64    `json:"expires_at_ms"`
} {
	t.Helper()
	var lease struct {
		Fingerprints []string `json:"fingerprints"`
		ExpiresAtMS  int64    `json:"expires_at_ms"`
	}
	plaintext, err := Open(testMaster, logicalLeaseItem, org.blobs[BlobID(testMaster, logicalLeaseItem+":"+device)])
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(plaintext, &lease); err != nil {
		t.Fatal(err)
	}
	return lease
}

// The live sequence: a default lease takes half of 8 tickets, then the setting is
// lowered and serve restarts. The next sync must publish the smaller lease.
func TestLoweringTheLeaseSettingPublishesTheSmallerLease(t *testing.T) {
	org := newFakeOrg()
	tickets := []wallet.Ticket{}
	for i := 0; i < 8; i++ {
		tickets = append(tickets, webTicket(fmt.Sprintf("t%d", i)))
	}
	seedBrowser(t, org, tickets, nil)
	device := strings.Repeat("a", 32)
	ctx := context.Background()
	p := newPeer(t, org, device, 30)
	if _, err := p.syncer.Once(ctx); err != nil {
		t.Fatal(err)
	}
	if got := len(publishedLease(t, org, device).Fingerprints); got != 4 {
		t.Fatalf("half of 8 expected, published %d", got)
	}
	walletBefore := org.blobs[BlobID(testMaster, logicalActive)].Ciphertext
	restarted := &Syncer{Session: p.syncer.Session, Store: p.store, LeaseSize: 2}
	if _, err := restarted.Once(ctx); err != nil {
		t.Fatal(err)
	}
	lease := publishedLease(t, org, device)
	want := map[string]bool{wallet.Fingerprint("t7"): true, wallet.Fingerprint("t6"): true}
	if len(lease.Fingerprints) != 2 || !want[lease.Fingerprints[0]] || !want[lease.Fingerprints[1]] {
		t.Fatalf("published lease = %v", lease.Fingerprints)
	}
	if org.blobs[BlobID(testMaster, logicalActive)].Ciphertext != walletBefore {
		t.Fatal("changing a lease must not rewrite the wallet")
	}
	if state := p.state(t); len(state.Active) != 8 || state.LeaseDirty {
		t.Fatalf("active=%d dirty=%v", len(state.Active), state.LeaseDirty)
	}
	pushes := len(org.pushes)
	outcome, err := restarted.Once(ctx)
	if err != nil || !outcome.Skipped || len(org.pushes) != pushes {
		t.Fatalf("a settled lease must stay quiet: %+v %v", outcome, err)
	}
	empty := &Syncer{Session: p.syncer.Session, Store: p.store, LeaseSize: 0}
	if _, err := empty.Once(ctx); err != nil {
		t.Fatal(err)
	}
	if lease := publishedLease(t, org, device); len(lease.Fingerprints) != 0 || lease.ExpiresAtMS != 0 {
		t.Fatalf("zero must release: %+v", lease)
	}
}

func TestLeaseFollowsAShrinkingWalletHalfCap(t *testing.T) {
	org := newFakeOrg()
	seedBrowser(t, org, []wallet.Ticket{webTicket("a"), webTicket("b"), webTicket("c"), webTicket("d")}, nil)
	device := strings.Repeat("a", 32)
	ctx := context.Background()
	p := newPeer(t, org, device, 30)
	if _, err := p.syncer.Once(ctx); err != nil {
		t.Fatal(err)
	}
	// Another client spent two: only those two remain in the wallet.
	seedBrowser(t, org, []wallet.Ticket{webTicket("a"), webTicket("b")}, []wallet.Ticket{webTicket("c"), webTicket("d")})
	if _, err := p.syncer.Once(ctx); err != nil {
		t.Fatal(err)
	}
	if got := len(publishedLease(t, org, device).Fingerprints); got != 1 {
		t.Fatalf("half of 2 expected, published %d", got)
	}
}

func TestSpendPublishesThisDevicesOwnRemovalRecord(t *testing.T) {
	org := newFakeOrg()
	seedBrowser(t, org, []wallet.Ticket{webTicket("a")}, nil)
	device := strings.Repeat("a", 32)
	p := newPeer(t, org, device, 1)
	ctx := context.Background()
	p.syncer.Once(ctx)
	spendLocally(t, p, 1)
	if _, err := p.syncer.Once(ctx); err != nil {
		t.Fatal(err)
	}
	blob, ok := org.blobs[BlobID(testMaster, logicalRemovals+":"+device)]
	if !ok {
		t.Fatal("no removal record")
	}
	plaintext, err := Open(testMaster, logicalRemovals, blob)
	if err != nil {
		t.Fatal(err)
	}
	var removals removalsPayload
	if json.Unmarshal(plaintext, &removals) != nil || removals.WriterID != device || len(removals.Archived) != 1 || removals.Tombstones == nil {
		t.Fatalf("removals = %s", plaintext)
	}
}

func TestUploadBatchesRespectBothBounds(t *testing.T) {
	big := Blob{ID: "x", Ciphertext: strings.Repeat("c", maxUploadBytes/3)}
	batches, err := uploadBatches([]Blob{big, big, big})
	if err != nil || len(batches) != 2 {
		t.Fatalf("batches=%d err=%v", len(batches), err)
	}
	many := make([]Blob, maxBlobsPerRequest+1)
	if batches, _ := uploadBatches(many); len(batches) != 2 {
		t.Fatalf("batches = %d", len(batches))
	}
	if _, err := uploadBatches([]Blob{{Ciphertext: strings.Repeat("c", maxUploadBytes)}}); err == nil {
		t.Fatal("oversize record accepted")
	}
}

// gatedOrg holds a chosen request inside the org, after it left the client, the way
// a slow network does, and records how many sync exchanges overlap.
type gatedOrg struct {
	*fakeOrg
	gate     chan struct{}
	entered  chan struct{}
	gatePush func() bool
}

func (g *gatedOrg) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path == "/auth/sync" && r.Method == http.MethodPost && g.gatePush() {
		g.entered <- struct{}{}
		<-g.gate
	}
	g.fakeOrg.ServeHTTP(w, r)
}

func profileSyncer(t *testing.T, handler http.Handler, dir string) *Syncer {
	t.Helper()
	client, err := AccountClient(oatest.Client(handler), testOrg)
	if err != nil {
		t.Fatal(err)
	}
	store, err := wallet.Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	return &Syncer{Session: NewSession(dir, testOrg, client), Store: store, LeaseSize: 2}
}

func TestDelayedPushCannotLandAfterLogoutErases(t *testing.T) {
	org := newFakeOrg()
	seedBrowser(t, org, []wallet.Ticket{webTicket("a"), webTicket("b")}, nil)
	var once sync.Once
	gated := &gatedOrg{fakeOrg: org, gate: make(chan struct{}), entered: make(chan struct{}, 1), gatePush: func() bool {
		first := false
		once.Do(func() { first = true })
		return first
	}}
	dir := oatest.PrivateDir(t)
	device := strings.Repeat("a", 32)
	ctx := context.Background()
	daemon := profileSyncer(t, gated, dir)
	if err := daemon.Session.Save(ctx, &Identity{AccountID: testAccount, OrgURL: testOrg, DeviceID: device, MasterKey: testMaster, Access: org.access, Refresh: org.refresh}); err != nil {
		t.Fatal(err)
	}
	stale := make(chan error, 1)
	go func() {
		_, err := daemon.Once(ctx)
		stale <- err
	}()
	<-gated.entered // The daemon's push has left it and is delayed in the network.

	logout := profileSyncer(t, gated, dir)
	logoutDone := make(chan error, 1)
	logoutEntered := make(chan struct{})
	go func() {
		logoutDone <- logout.Exclusive(ctx, func() error {
			close(logoutEntered)
			if err := logout.Store.Update(ctx, func(st *wallet.State) error {
				reservation, err := st.Reserve("r", "n", 1, func(wallet.Ticket) bool { return true }, time.Now())
				if err != nil {
					return err
				}
				st.CommitSpent(reservation.ID, time.Now())
				return nil
			}); err != nil {
				return err
			}
			if err := logout.FinalizeLocked(ctx); err != nil {
				return err
			}
			if err := logout.Session.SignOut(ctx); err != nil {
				return err
			}
			if err := logout.Session.Erase(ctx); err != nil {
				return err
			}
			return logout.Store.Delete(ctx)
		})
	}()
	// The lock is held, so logout cannot have entered while the push is out.
	if _, err := securefile.TryLock(filepath.Join(dir, syncLockFile)); !errors.Is(err, securefile.ErrLocked) {
		t.Fatalf("the sync lock must be held across the push: %v", err)
	}
	select {
	case <-logoutEntered:
		t.Fatal("logout ran during a sync")
	default:
	}
	close(gated.gate)
	if err := <-stale; err != nil {
		t.Fatal(err)
	}
	if err := <-logoutDone; err != nil {
		t.Fatal(err)
	}
	// The last write of this device's record is the final one, holding the spend.
	plaintext, err := Open(testMaster, logicalRemovals, org.blobs[BlobID(testMaster, logicalRemovals+":"+device)])
	if err != nil {
		t.Fatal(err)
	}
	var removals removalsPayload
	if json.Unmarshal(plaintext, &removals) != nil || len(removals.Archived) != 1 {
		t.Fatalf("a stale write replaced the final record: %s", plaintext)
	}
	if _, err := daemon.Once(ctx); !errors.Is(err, ErrSignedOut) {
		t.Fatalf("a queued sync after logout must find no session: %v", err)
	}
}

func TestConcurrentSyncsNeverOverlap(t *testing.T) {
	org := newFakeOrg()
	seedBrowser(t, org, []wallet.Ticket{webTicket("a"), webTicket("b")}, nil)
	dir := oatest.PrivateDir(t)
	ctx := context.Background()
	var mu sync.Mutex
	inFlight, overlap := 0, false
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/auth/sync" {
			mu.Lock()
			inFlight++
			if inFlight > 1 {
				overlap = true
			}
			mu.Unlock()
			defer func() { mu.Lock(); inFlight--; mu.Unlock() }()
		}
		org.ServeHTTP(w, r)
	})
	first := profileSyncer(t, handler, dir)
	if err := first.Session.Save(ctx, &Identity{AccountID: testAccount, OrgURL: testOrg, DeviceID: strings.Repeat("a", 32), MasterKey: testMaster, Access: org.access, Refresh: org.refresh}); err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			syncer := profileSyncer(t, handler, dir)
			if _, err := syncer.Once(ctx); err != nil {
				t.Error(err)
			}
		}()
	}
	wg.Wait()
	if overlap {
		t.Fatal("two syncs of one profile overlapped")
	}
}

func accountIdentity(account, access string) *Identity {
	return &Identity{AccountID: account, OrgURL: testOrg, DeviceID: strings.Repeat("e", 32), MasterKey: testMaster, Access: access, Refresh: "r-" + access}
}

func signoutsWith(org *fakeOrg, access string) int {
	count := 0
	for i, request := range org.requests {
		if strings.Contains(request, "/auth/signout") && org.headers[i].Get("Authorization") == "Bearer "+access {
			count++
		}
	}
	return count
}

// Both logins passed browser approval against an empty profile. This is the
// interleaving: the first to commit binds it, and the second is refused and revoked.
func TestSecondFirstLoginLosesAndIsRevoked(t *testing.T) {
	org := newFakeOrg()
	dir := oatest.PrivateDir(t)
	ctx := context.Background()
	syncer := profileSyncer(t, org, dir)
	a, b := accountIdentity("1111111111111111", "access-a"), accountIdentity("2222222222222222", "access-b")
	if err := syncer.CommitAuthorization(ctx, a, nil); err != nil {
		t.Fatal(err)
	}
	if err := syncer.CommitAuthorization(ctx, b, nil); !errors.Is(err, ErrBindingLost) {
		t.Fatalf("err = %v", err)
	}
	if got, _ := syncer.Session.AccountID(); got != a.AccountID {
		t.Fatalf("session account = %s", got)
	}
	if err := syncer.Store.View(ctx, func(st *wallet.State) error {
		if st.AccountID != a.AccountID {
			t.Fatalf("wallet account = %s", st.AccountID)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if signoutsWith(org, "access-b") != 1 || signoutsWith(org, "access-a") != 0 {
		t.Fatalf("revocations wrong: %v", org.requests)
	}
}

func TestSameAccountReloginReplacesAndKeepsTheDevice(t *testing.T) {
	org := newFakeOrg()
	org.access = "access-1"
	dir := oatest.PrivateDir(t)
	ctx := context.Background()
	syncer := profileSyncer(t, org, dir)
	first := accountIdentity(testAccount, "access-1")
	first.DeviceID = strings.Repeat("f", 32)
	if err := syncer.CommitAuthorization(ctx, first, nil); err != nil {
		t.Fatal(err)
	}
	second := accountIdentity(testAccount, "access-2")
	if err := syncer.CommitAuthorization(ctx, second, nil); err != nil {
		t.Fatal(err)
	}
	loaded, err := syncer.Session.Load(ctx)
	if err != nil || loaded.Access != "access-2" || loaded.DeviceID != first.DeviceID {
		t.Fatalf("loaded = %+v err=%v", loaded, err)
	}
	if signoutsWith(org, "access-1") != 1 {
		t.Fatalf("the earlier session must end: %v", org.requests)
	}
}

func TestCommitWaitsForARunningSyncAndRecheckRefuses(t *testing.T) {
	org := newFakeOrg()
	dir := oatest.PrivateDir(t)
	ctx := context.Background()
	syncer := profileSyncer(t, org, dir)
	refused := errors.New("the profile changed deployment")
	identity := accountIdentity(testAccount, "access-x")
	if err := syncer.CommitAuthorization(ctx, identity, func() error { return refused }); !errors.Is(err, refused) {
		t.Fatalf("err = %v", err)
	}
	if signoutsWith(org, "access-x") != 1 {
		t.Fatal("a refused authorization must be revoked")
	}
	if _, err := syncer.Session.Load(ctx); !errors.Is(err, ErrSignedOut) {
		t.Fatal("a refused authorization must not be saved")
	}
	lock, err := securefile.TryLock(filepath.Join(dir, syncLockFile))
	if err != nil {
		t.Fatal(err)
	}
	short, cancel := context.WithTimeout(ctx, 60*time.Millisecond)
	defer cancel()
	if err := syncer.CommitAuthorization(short, identity, nil); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("commit must wait for the lock: %v", err)
	}
	lock.Release()
}

func installed(t *testing.T, org *fakeOrg) (*Syncer, string, *Identity) {
	t.Helper()
	dir := oatest.PrivateDir(t)
	syncer := profileSyncer(t, org, dir)
	old := accountIdentity(testAccount, "access-old")
	if err := syncer.CommitAuthorization(context.Background(), old, nil); err != nil {
		t.Fatal(err)
	}
	return syncer, dir, old
}

func assertOnlyReplacementRevoked(t *testing.T, org *fakeOrg, syncer *Syncer) {
	t.Helper()
	if signoutsWith(org, "access-new") != 1 {
		t.Fatalf("the replacement must be revoked once: %v", org.requests)
	}
	if signoutsWith(org, "access-old") != 0 {
		t.Fatalf("the installed session was revoked: %v", org.requests)
	}
	loaded, err := syncer.Session.Load(context.Background())
	if err != nil || loaded.Access != "access-old" || loaded.AccountID != testAccount {
		t.Fatalf("installed session changed: %+v %v", loaded, err)
	}
}

func TestCancelledWaitForLockRevokesOnlyTheReplacement(t *testing.T) {
	org := newFakeOrg()
	syncer, dir, _ := installed(t, org)
	lock, err := securefile.TryLock(filepath.Join(dir, syncLockFile))
	if err != nil {
		t.Fatal(err)
	}
	defer lock.Release()
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	err = syncer.CommitAuthorization(ctx, accountIdentity(testAccount, "access-new"), nil)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("the original failure must survive: %v", err)
	}
	assertOnlyReplacementRevoked(t, org, syncer)
}

func TestLockErrorRevokesOnlyTheReplacement(t *testing.T) {
	org := newFakeOrg()
	syncer, dir, _ := installed(t, org)
	path := filepath.Join(dir, syncLockFile)
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(dir, "elsewhere"), path); err != nil {
		t.Fatal(err)
	}
	err := syncer.CommitAuthorization(context.Background(), accountIdentity(testAccount, "access-new"), nil)
	if err == nil || strings.Contains(err.Error(), "access-new") {
		t.Fatalf("err = %v", err)
	}
	assertOnlyReplacementRevoked(t, org, syncer)
}

func TestSessionWriteFailureRevokesOnlyTheReplacement(t *testing.T) {
	org := newFakeOrg()
	syncer, dir, _ := installed(t, org)
	if err := os.Chmod(dir, 0o500); err != nil {
		t.Fatal(err)
	}
	defer os.Chmod(dir, 0o700)
	err := syncer.CommitAuthorization(context.Background(), accountIdentity(testAccount, "access-new"), nil)
	if err == nil || strings.Contains(err.Error(), "access-new") {
		t.Fatalf("err = %v", err)
	}
	if err := os.Chmod(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	assertOnlyReplacementRevoked(t, org, syncer)
	if err := syncer.Store.View(context.Background(), func(st *wallet.State) error {
		if st.AccountID != testAccount {
			t.Fatalf("wallet account = %s", st.AccountID)
		}
		return nil
	}); err != nil {
		t.Fatalf("the wallet binding must survive: %v", err)
	}
}

func TestFirstLoginWriteFailureLeavesTheProfileUnbound(t *testing.T) {
	org := newFakeOrg()
	dir := oatest.PrivateDir(t)
	syncer := profileSyncer(t, org, dir)
	// A directory where session.json goes makes only the final replace fail.
	if err := os.Mkdir(filepath.Join(dir, sessionFile), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, sessionFile, "x"), nil, 0o600); err != nil {
		t.Fatal(err)
	}
	identity := accountIdentity("1111111111111111", "access-new")
	err := syncer.CommitAuthorization(context.Background(), identity, nil)
	if err == nil {
		t.Fatal("expected a failure")
	}
	if signoutsWith(org, "access-new") != 1 {
		t.Fatalf("revocations: %v", org.requests)
	}
	if err := syncer.Store.View(context.Background(), func(*wallet.State) error { return nil }); !errors.Is(err, wallet.ErrNoWallet) {
		t.Fatalf("a failed first login must not bind the profile: %v", err)
	}
}

func TestLostRaceIsRevokedExactlyOnceAndCommitNever(t *testing.T) {
	org := newFakeOrg()
	syncer, _, _ := installed(t, org)
	err := syncer.CommitAuthorization(context.Background(), accountIdentity("2222222222222222", "access-other"), nil)
	if !errors.Is(err, ErrBindingLost) {
		t.Fatalf("err = %v", err)
	}
	if signoutsWith(org, "access-other") != 1 || signoutsWith(org, "access-old") != 0 {
		t.Fatalf("revocations: %v", org.requests)
	}
	if err := syncer.CommitAuthorization(context.Background(), accountIdentity(testAccount, "access-kept"), nil); err != nil {
		t.Fatal(err)
	}
	if signoutsWith(org, "access-kept") != 0 {
		t.Fatal("a committed session was revoked")
	}
}

func TestRevokeRefreshesAnExpiredTokenWithoutTouchingTheProfile(t *testing.T) {
	org := newFakeOrg()
	syncer, _, _ := installed(t, org)
	stale := &Identity{AccountID: testAccount, OrgURL: testOrg, Access: "expired", Refresh: org.refresh}
	syncer.Session.RevokeIdentity(context.Background(), stale)
	if !org.revoked {
		t.Fatalf("not revoked: %v", org.requests)
	}
	loaded, err := syncer.Session.Load(context.Background())
	if err != nil || loaded.Access != "access-old" {
		t.Fatalf("profile changed: %+v %v", loaded, err)
	}
}

func TestSecretsNeverAppearInErrors(t *testing.T) {
	org := newFakeOrg()
	session, _ := newSession(t, org)
	session.client = &http.Client{Transport: failingTransport{}}
	_, _, err := session.Do(context.Background(), http.MethodGet, "/auth/sync?since=0", nil)
	if err == nil || strings.Contains(err.Error(), "secret") || strings.Contains(err.Error(), "access-1") {
		t.Fatalf("err = %v", err)
	}
}

type failingTransport struct{}

func (failingTransport) RoundTrip(*http.Request) (*http.Response, error) {
	return nil, errors.New("dial wss://relay?secret=abc: refused")
}

func TestBuildURLCarriesOnlyTheFragment(t *testing.T) {
	link, err := BuildURL("https://chat.test", strings.Repeat("T", 43), make([]byte, 65))
	if err != nil {
		t.Fatal(err)
	}
	parsed, err := url.Parse(link)
	if err != nil || parsed.RawQuery != "" || parsed.Path != "/" {
		t.Fatalf("link = %s", link)
	}
}
