package ticket

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/cloudflare/circl/blindsign/blindrsa"
)

type testIssuer struct {
	key              *rsa.PrivateKey
	der              []byte
	server           *httptest.Server
	t                *testing.T
	issueBodies      [][]byte
	keyRequests      []string
	issueUnavailable bool
	keyUnavailable   bool
	proofStatus      string
	proofStation     string
	proofHash        string
	mu               sync.Mutex
}

func newTestIssuer(t *testing.T) *testIssuer {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	der, err := x509.MarshalPKIXPublicKey(&key.PublicKey)
	if err != nil {
		t.Fatal(err)
	}
	f := &testIssuer{key: key, der: der, t: t}
	f.server = httptest.NewServer(http.HandlerFunc(f.serve))
	t.Cleanup(f.server.Close)
	return f
}

func (f *testIssuer) serve(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if r.Header.Get("Cookie") != "" {
		f.t.Error("identity cookie leaked to public ticket endpoint")
	}
	w.Header().Set("Content-Type", "application/json")
	switch r.URL.Path {
	case "/chat/model-tickets":
		fmt.Fprint(w, `{"test/model":1,"test/expensive":2,"test/disabled":1}`)
	case "/chat/pinned-models":
		fmt.Fprint(w, `{"disabled_models":["test/disabled"]}`)
	case "/api/ticket/issue/public-key":
		json.NewEncoder(w).Encode(map[string]any{"public_key": base64.URLEncoding.EncodeToString(f.der), "key_id": digest(f.der), "can_issue": true})
	case "/api/alpha-register":
		var body struct {
			Code     string               `json:"credential"`
			KeyID    string               `json:"expected_key_id"`
			Requests [][2]json.RawMessage `json:"blinded_requests"`
		}
		var raw json.RawMessage
		if err := json.NewDecoder(r.Body).Decode(&raw); err != nil {
			f.t.Error(err)
			w.WriteHeader(400)
			return
		}
		f.issueBodies = append(f.issueBodies, append([]byte{}, raw...))
		if f.issueUnavailable {
			w.WriteHeader(503)
			fmt.Fprint(w, `{"error":"temporarily unavailable"}`)
			return
		}
		if err := json.Unmarshal(raw, &body); err != nil {
			f.t.Error(err)
		}
		if body.KeyID != digest(f.der) {
			f.t.Error("issuance key binding missing")
		}
		responses := make([][2]any, 0, len(body.Requests))
		for _, row := range body.Requests {
			var i int
			var encoded string
			json.Unmarshal(row[0], &i)
			json.Unmarshal(row[1], &encoded)
			request, err := decode64(encoded)
			if err != nil || len(request) != 259 {
				f.t.Error("invalid blind request")
				w.WriteHeader(400)
				return
			}
			signer := blindrsa.NewSigner(f.key)
			sig, err := signer.BlindSign(request[3:])
			if err != nil {
				f.t.Error(err)
				return
			}
			responses = append(responses, [2]any{i, base64.URLEncoding.EncodeToString(sig)})
		}
		json.NewEncoder(w).Encode(map[string]any{"key_id": digest(f.der), "signed_responses": responses})
	case "/api/request_key":
		f.keyRequests = append(f.keyRequests, r.Header.Get("Authorization"))
		if f.keyUnavailable {
			w.WriteHeader(503)
			fmt.Fprint(w, `{"error":"temporarily unavailable"}`)
			return
		}
		tokens := strings.Split(strings.SplitN(r.Header.Get("Authorization"), "=", 2)[1], ",")
		client, _ := blindrsa.NewClient(blindrsa.SHA384PSSDeterministic, &f.key.PublicKey)
		for _, token := range tokens {
			b, err := decode64(token)
			if err != nil || len(b) != tokenSize {
				f.t.Error("invalid token")
				return
			}
			if err := client.Verify(b[:98], b[98:]); err != nil {
				f.t.Error("invalid unblinded signature")
				return
			}
		}
		json.NewEncoder(w).Encode(map[string]any{"key": "test-ephemeral-key", "station_id": "station-1", "station_signature": "station-proof", "org_signature": "org-proof", "expires_at_unix": time.Now().Add(time.Hour).Unix()})
	case "/submit_key":
		var body map[string]any
		json.NewDecoder(r.Body).Decode(&body)
		if body["api_key"] != "test-ephemeral-key" || body["station_id"] != "station-1" || body["key_valid_till"] == nil || body["station_signature"] != "station-proof" || body["org_signature"] != "org-proof" {
			f.t.Error("verifier payload mismatch")
		}
		status, station, hash := f.proofStatus, f.proofStation, f.proofHash
		if status == "" {
			status = "verified"
		}
		if station == "" {
			station = "station-1"
		}
		if hash == "" {
			hash = digest([]byte("test-ephemeral-key"))[:16]
		}
		json.NewEncoder(w).Encode(map[string]any{"status": status, "station_id": station, "key_hash": hash})
	default:
		w.WriteHeader(404)
	}
}

func (f *testIssuer) backend(t *testing.T, path string) *Backend {
	t.Helper()
	jar, _ := cookiejar.New(nil)
	origin, _ := url.Parse(f.server.URL)
	jar.SetCookies(origin, []*http.Cookie{{Name: "identity", Value: "must-not-leak"}})
	b, err := New(Config{OrgURL: f.server.URL, VerifierURL: f.server.URL, WalletPath: path, Client: &http.Client{Jar: jar}})
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func code(n int) string { return strings.Repeat("a", 20) + fmt.Sprintf("%04x", n) }

func TestIssueRedeemAndSpentImport(t *testing.T) {
	f := newTestIssuer(t)
	path := filepath.Join(t.TempDir(), "tickets.json")
	b := f.backend(t, path)
	n, err := b.RedeemCode(context.Background(), code(3))
	if err != nil || n != 3 {
		t.Fatalf("issue: %d %v", n, err)
	}
	before, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(before, []byte(code(3))) || bytes.Contains(before, []byte("blinded_requests")) || bytes.Contains(before, []byte("entropy")) {
		t.Fatal("finalized wallet retains issuance metadata")
	}
	credential, err := b.Acquire(context.Background(), "test/model")
	if err != nil || credential.Key != "test-ephemeral-key" {
		t.Fatalf("acquire: %v", err)
	}
	var export wallet
	json.Unmarshal(before, &export)
	payload, _ := json.Marshal(map[string]any{"data": map[string]any{"tickets": map[string]any{"active": export.Active}}})
	if n, err := b.Import(context.Background(), bytes.NewReader(payload)); err != nil || n != 0 {
		t.Fatalf("spent ticket resurrected: %d %v", n, err)
	}
	if n, err := b.Count(); err != nil || n != 2 {
		t.Fatalf("count: %d %v", n, err)
	}
	info, _ := os.Stat(path)
	if info.Mode().Perm() != 0600 {
		t.Fatal("wallet file is not mode 0600")
	}
}

func TestIssuanceCrashRecoveryReusesBlindedBatch(t *testing.T) {
	f := newTestIssuer(t)
	path := filepath.Join(t.TempDir(), "tickets.json")
	b := f.backend(t, path)
	f.issueUnavailable = true
	if _, err := b.RedeemCode(context.Background(), code(2)); err == nil {
		t.Fatal("expected outage")
	}
	f.issueUnavailable = false
	restarted := f.backend(t, path)
	if n, err := restarted.RedeemCode(context.Background(), code(2)); err != nil || n != 2 {
		t.Fatalf("recovery: %d %v", n, err)
	}
	for _, body := range f.issueBodies[1:] {
		if !bytes.Equal(body, f.issueBodies[0]) {
			t.Fatal("invitation was retried with a different blinded batch")
		}
	}
}

func TestSpendCrashRecoveryReusesExactTickets(t *testing.T) {
	f := newTestIssuer(t)
	path := filepath.Join(t.TempDir(), "tickets.json")
	b := f.backend(t, path)
	if _, err := b.RedeemCode(context.Background(), code(2)); err != nil {
		t.Fatal(err)
	}
	f.keyUnavailable = true
	if _, err := b.Acquire(context.Background(), "test/model"); err == nil {
		t.Fatal("expected outage")
	}
	if n, _ := b.Count(); n != 1 {
		t.Fatal("reservation did not persist before network call")
	}
	f.keyUnavailable = false
	restarted := f.backend(t, path)
	if _, err := restarted.Acquire(context.Background(), "test/model"); err != nil {
		t.Fatal(err)
	}
	for _, auth := range f.keyRequests[1:] {
		if auth != f.keyRequests[0] {
			t.Fatal("spending retry selected different tickets")
		}
	}
	if n, _ := b.Count(); n != 1 {
		t.Fatal("recovery spent new tickets")
	}
}

func TestVerifierFailsClosed(t *testing.T) {
	for _, mode := range []string{"pending", "unverified", "unknown", "station", "hash", "short_hash", "full_hash_suffix"} {
		t.Run(mode, func(t *testing.T) {
			f := newTestIssuer(t)
			b := f.backend(t, filepath.Join(t.TempDir(), "tickets.json"))
			if _, err := b.RedeemCode(context.Background(), code(1)); err != nil {
				t.Fatal(err)
			}
			switch mode {
			case "station":
				f.proofStation = "different"
			case "hash":
				f.proofHash = strings.Repeat("0", 64)
			case "short_hash":
				f.proofHash = strings.Repeat("0", 16)
			case "full_hash_suffix":
				f.proofHash = digest([]byte("test-ephemeral-key"))[:16] + strings.Repeat("0", 48)
			default:
				f.proofStatus = mode
			}
			credential, err := b.Acquire(context.Background(), "test/model")
			if err == nil || credential.Key != "" {
				t.Fatal("unverified credential activated")
			}
			if n, _ := b.Count(); n != 0 {
				t.Fatal("verification failure restored tickets")
			}
		})
	}
}

func TestVerifierAcceptsFullHashResponse(t *testing.T) {
	f := newTestIssuer(t)
	f.proofHash = digest([]byte("test-ephemeral-key"))
	b := f.backend(t, filepath.Join(t.TempDir(), "tickets.json"))
	if _, err := b.RedeemCode(context.Background(), code(1)); err != nil {
		t.Fatal(err)
	}
	credential, err := b.Acquire(context.Background(), "test/model")
	if err != nil || credential.Key != "test-ephemeral-key" {
		t.Fatalf("full hash response rejected: %v", err)
	}
}

func TestVerifierKeyHashMatchesBrowserContract(t *testing.T) {
	// This is OA Chat's test/services/verifierRequired.test.js fixture. The
	// production browser hashes only the first eight SHA-256 bytes for comparison.
	const key = "child-secret"
	const browserHash = "1b208a37bbf953ac"
	if !verifierKeyHashMatches(browserHash, key) {
		t.Fatal("browser verifier identifier rejected")
	}
	full := digest([]byte(key))
	for length := 0; length <= len(full); length++ {
		want := length == 16 || length == 64
		if got := verifierKeyHashMatches(full[:length], key); got != want {
			t.Errorf("prefix length %d accepted=%v, want %v", length, got, want)
		}
	}
	for _, reported := range []string{browserHash + "x", strings.ToUpper(browserHash), " " + browserHash, browserHash + " ", browserHash + strings.Repeat("0", 48), full + "0"} {
		if verifierKeyHashMatches(reported, key) {
			t.Error("malformed or mismatched verifier identifier accepted")
		}
	}
	if verifierKeyHashMatches(digest(nil)[:16], "") {
		t.Fatal("empty provisional key accepted")
	}
}

func TestConcurrentProcessesCannotDoubleSpend(t *testing.T) {
	f := newTestIssuer(t)
	path := filepath.Join(t.TempDir(), "tickets.json")
	b := f.backend(t, path)
	if _, err := b.RedeemCode(context.Background(), code(1)); err != nil {
		t.Fatal(err)
	}
	var successes atomic.Int32
	var wg sync.WaitGroup
	for i := 0; i < 6; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			other := f.backend(t, path)
			if _, err := other.Acquire(context.Background(), "test/model"); err == nil {
				successes.Add(1)
			}
		}()
	}
	wg.Wait()
	if successes.Load() != 1 || len(f.keyRequests) != 1 {
		t.Fatal("the same ticket was redeemed concurrently")
	}
}

func TestModelPolicyAndNoTicketLeakOnRedirect(t *testing.T) {
	f := newTestIssuer(t)
	b := f.backend(t, filepath.Join(t.TempDir(), "tickets.json"))
	models, err := b.Models(context.Background())
	if err != nil || bytes.Contains(models, []byte("test/disabled")) {
		t.Fatalf("models: %s %v", models, err)
	}
	for _, model := range []string{"unknown/model", "test/disabled"} {
		if _, err := b.Acquire(context.Background(), model); err == nil {
			t.Fatal("unsupported model accepted")
		}
	}
	if len(f.keyRequests) != 0 {
		t.Fatal("unsupported model spent a ticket")
	}
	var leaked atomic.Bool
	sink := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { leaked.Store(true) }))
	defer sink.Close()
	redirect := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { http.Redirect(w, r, sink.URL, 307) }))
	defer redirect.Close()
	var out any
	if err := b.request(context.Background(), "POST", redirect.URL, nil, "InferenceTicket token=secret", &out); err == nil {
		t.Fatal("redirect should fail")
	}
	if leaked.Load() {
		t.Fatal("ticket request followed a redirect")
	}
}

func TestTamperedChallengeAndSignatureRejected(t *testing.T) {
	f := newTestIssuer(t)
	state, err := newBlindState(&f.key.PublicKey, f.der)
	if err != nil {
		t.Fatal(err)
	}
	request, _ := decode64(state.Request)
	signer := blindrsa.NewSigner(f.key)
	sig, err := signer.BlindSign(request[3:])
	if err != nil {
		t.Fatal(err)
	}
	token, err := finalize(&f.key.PublicKey, state, base64.URLEncoding.EncodeToString(sig))
	if err != nil {
		t.Fatal(err)
	}
	corrupt, _ := decode64(token)
	corrupt[40] ^= 1
	if _, _, err := normalizeToken(base64.URLEncoding.EncodeToString(corrupt)); err == nil {
		t.Fatal("server-tagged challenge accepted")
	}
	sig[10] ^= 1
	if _, err := finalize(&f.key.PublicKey, state, base64.URLEncoding.EncodeToString(sig)); err == nil {
		t.Fatal("tagged signature accepted")
	}
}

// Cross-language compatibility with the very library used by OA Chat. This is
// an additional developer check; the daemon itself never requires Node.js.
func TestBrowserPrivacyPassInteroperability(t *testing.T) {
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("Node.js unavailable; Go protocol tests still run")
	}
	f := newTestIssuer(t)
	state, err := newBlindState(&f.key.PublicKey, f.der)
	if err != nil {
		t.Fatal(err)
	}
	request, _ := decode64(state.Request)
	signer := blindrsa.NewSigner(f.key)
	signature, err := signer.BlindSign(request[3:])
	if err != nil {
		t.Fatal(err)
	}
	token, err := finalize(&f.key.PublicKey, state, base64.URLEncoding.EncodeToString(signature))
	if err != nil {
		t.Fatal(err)
	}
	vendor, err := filepath.Abs("../../../chat/vendor/privacypass-ts/privacypass-ts.min.js")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(vendor); err != nil {
		t.Skip("browser vendor library is not present in daemon-only source archive")
	}
	privateDER, err := x509.MarshalPKCS8PrivateKey(f.key)
	if err != nil {
		t.Fatal(err)
	}
	payload, _ := json.Marshal(map[string]any{"vendor": vendor, "publicKey": base64.StdEncoding.EncodeToString(f.der), "privateKey": base64.StdEncoding.EncodeToString(privateDER), "token": token, "issuer": issuerName})
	script := `import fs from 'node:fs';
import {pathToFileURL} from 'node:url';
const input=JSON.parse(fs.readFileSync(0,'utf8'));
const {publicVerif,Token,TOKEN_TYPES,TokenChallenge,util}=await import(pathToFileURL(input.vendor));
const bytes=s=>new Uint8Array(Buffer.from(s,'base64url'));
const key=await crypto.subtle.importKey('spki',bytes(input.publicKey),{name:'RSA-PSS',hash:'SHA-384'},true,['verify']);
const token=Token.deserialize(TOKEN_TYPES.BLIND_RSA,bytes(input.token));
const origin=new publicVerif.Origin(publicVerif.BlindRSAMode.PSS);
if(!await origin.verify(token,key))throw new Error('browser rejected Go token');
const challenge=new TokenChallenge(2,input.issuer,new Uint8Array(0));
const expected=new Uint8Array(await crypto.subtle.digest('SHA-256',challenge.serialize()));
if(Buffer.compare(expected,token.authInput.challengeDigest)!==0)throw new Error('challenge differs from browser');
const privateKey=await crypto.subtle.importKey('pkcs8',bytes(input.privateKey),{name:'RSA-PSS',hash:'SHA-384'},true,['sign']);
const pssKey=util.convertEncToRSASSAPSS(bytes(input.publicKey));
const browserClient=new publicVerif.Client(publicVerif.BlindRSAMode.PSS);
const request=await browserClient.createTokenRequest(challenge,pssKey);
const issuer=new publicVerif.Issuer(publicVerif.BlindRSAMode.PSS,input.issuer,privateKey,key);
const signed=await issuer.issue(request);
const browserToken=await browserClient.finalize(signed);
process.stdout.write(JSON.stringify({public_key:Buffer.from(pssKey).toString('base64url'),token:Buffer.from(browserToken.serialize()).toString('base64url')}));`
	cmd := exec.Command(node, "--input-type=module", "-e", script)
	cmd.Stdin = bytes.NewReader(payload)
	output, err := cmd.Output()
	if err != nil {
		t.Fatalf("browser interoperability: %v %s", err, output)
	}
	var browser struct {
		PublicKey string `json:"public_key"`
		Token     string `json:"token"`
	}
	if err := json.Unmarshal(output, &browser); err != nil {
		t.Fatalf("browser response: %v", err)
	}
	public, _, err := parsePublicKey(browser.PublicKey)
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := normalizeToken(browser.Token); err != nil {
		t.Fatal(err)
	}
	browserToken, _ := decode64(browser.Token)
	client, _ := blindrsa.NewClient(blindrsa.SHA384PSSDeterministic, public)
	if err := client.Verify(browserToken[:98], browserToken[98:]); err != nil {
		t.Fatal("Go rejected browser-issued token")
	}
}
