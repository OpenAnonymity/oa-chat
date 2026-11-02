package tickets

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/OpenAnonymity/oa-chat/oa-clientd/internal/oa/oatest"
	"github.com/OpenAnonymity/oa-chat/oa-clientd/internal/oa/wallet"
	"github.com/OpenAnonymity/oa-chat/oa-clientd/pkg/rewriter"
	"github.com/OpenAnonymity/oa-chat/oa-clientd/pkg/server"
)

const (
	testOrg      = "https://org.test"
	testVerifier = "https://verifier.test"
	testProvider = "https://provider.test/api/v1"
)

// world is the anonymous side of OA: the org's redemption routes, the verifier
// and the provider, all on one in-memory handler.
type world struct {
	t      *testing.T
	mu     sync.Mutex
	issuer *oatest.Issuer
	orgKey ed25519.PrivateKey

	prices   map[string]int
	disabled []string

	spent       map[string]bool
	responses   map[string]map[string]any
	keyCounter  int
	redeemCalls []string
	legacyCalls int
	oldServer   bool
	nonces      []string
	// held tickets answer as another client's live request holds them.
	held       map[string]bool
	redeemFail func(tokens []string) (int, any)
	dropRedeem int

	verifierStatus func(key, station string) (int, any)
	badOrgSig      bool
	expiresIn      int64
	consumed       int
	noOrgKey       bool

	providerStatus int
	providerBody   string
	providerType   string
	providerAuth   []string
	providerBodies []string

	requests []*http.Request
}

func newWorld(t *testing.T) *world {
	_, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	return &world{t: t, issuer: oatest.NewIssuer(t), orgKey: private,
		prices: map[string]int{"vendor/one": 1, "vendor/three": 3}, spent: map[string]bool{}, responses: map[string]map[string]any{},
		expiresIn: 600, providerStatus: 200, providerBody: `{"choices":[{"message":{"content":"hi"}}]}`, providerType: "application/json"}
}

func (w *world) ServeHTTP(rw http.ResponseWriter, r *http.Request) {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.requests = append(w.requests, r.Clone(context.Background()))
	respond := func(status int, value any) {
		rw.Header().Set("Content-Type", "application/json")
		rw.WriteHeader(status)
		_ = json.NewEncoder(rw).Encode(value)
	}
	switch {
	case r.Host == "provider.test":
		w.providerAuth = append(w.providerAuth, r.Header.Get("Authorization"))
		body, _ := io.ReadAll(r.Body)
		w.providerBodies = append(w.providerBodies, string(body))
		rw.Header().Set("Content-Type", w.providerType)
		rw.Header().Set("X-OA-Verification-Status", "forged")
		rw.WriteHeader(w.providerStatus)
		_, _ = io.WriteString(rw, w.providerBody)
	case r.Host == "verifier.test" && r.URL.Path == "/submit_key":
		var body struct {
			Key     string `json:"api_key"`
			Station string `json:"station_id"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		if w.verifierStatus != nil {
			status, value := w.verifierStatus(body.Key, body.Station)
			respond(status, value)
			return
		}
		sum := sha256.Sum256([]byte(body.Key))
		respond(200, map[string]string{"status": "verified", "station_id": body.Station, "key_hash": hex.EncodeToString(sum[:])[:16]})
	case r.URL.Path == "/chat/model-tickets":
		respond(200, w.prices)
	case r.URL.Path == "/chat/pinned-models":
		respond(200, map[string]any{"disabled_models": w.disabled})
	case r.URL.Path == "/api/ticket/issue/public-key":
		respond(200, map[string]string{"public_key": w.issuer.Encoded, "key_id": w.issuer.KeyID})
	case r.URL.Path == "/api/public_key":
		if w.noOrgKey {
			respond(503, map[string]string{"detail": "not configured"})
			return
		}
		respond(200, map[string]string{"public_key": hex.EncodeToString(w.orgKey.Public().(ed25519.PublicKey)), "algorithm": "Ed25519"})
	case r.URL.Path == "/api/request_key":
		w.legacyCalls++
		w.redeem(r, respond)
	case r.URL.Path == "/api/request_key/nonce":
		if w.oldServer {
			respond(404, map[string]string{"detail": "Not Found"})
			return
		}
		if r.Header.Get("X-OA-Redemption-Nonce") == "" {
			respond(400, map[string]any{"detail": map[string]string{"error_code": "REDEMPTION_NONCE_REQUIRED"}})
			return
		}
		w.redeem(r, respond)
	default:
		respond(404, map[string]string{"detail": "Not Found"})
	}
}

func (w *world) redeem(r *http.Request, respond func(int, any)) {
	header := r.Header.Get("Authorization")
	var tokens []string
	switch {
	case strings.HasPrefix(header, "InferenceTicket tokens="):
		tokens = strings.Split(strings.TrimPrefix(header, "InferenceTicket tokens="), ",")
	case strings.HasPrefix(header, "InferenceTicket token="):
		tokens = []string{strings.TrimPrefix(header, "InferenceTicket token=")}
	default:
		respond(401, map[string]any{"detail": map[string]string{"error_code": "TICKET_MALFORMED"}})
		return
	}
	nonce := r.Header.Get("X-OA-Redemption-Nonce")
	// As the org: replay and attempt ownership key on nonce and exact tokens;
	// spent state stays global per ticket.
	id := nonce + "|" + strings.Join(tokens, ",")
	w.redeemCalls = append(w.redeemCalls, strings.Join(tokens, ","))
	w.nonces = append(w.nonces, nonce)
	if w.redeemFail != nil {
		if status, value := w.redeemFail(tokens); status != 0 {
			respond(status, value)
			return
		}
	}
	if replay, ok := w.responses[id]; ok {
		if w.dropRedeem > 0 {
			w.dropRedeem--
			respond(503, map[string]string{"detail": "again"})
			return
		}
		respond(200, replay)
		return
	}
	for i, token := range tokens {
		if w.held[token] {
			respond(503, map[string]any{"detail": ticketError("TICKET_REQUEST_IN_PROGRESS", len(tokens), i, "held_by_other_request")})
			return
		}
		if w.spent[token] {
			respond(401, map[string]any{"detail": ticketError("TICKET_ALREADY_SPENT", len(tokens), i, "Ticket already spent")})
			return
		}
	}
	for _, token := range tokens {
		w.spent[token] = true
	}
	w.keyCounter++
	key := fmt.Sprintf("sk-test-%d", w.keyCounter)
	expires := time.Now().Unix() + w.expiresIn
	stationSig := "station-sig"
	message := fmt.Sprintf("%s|%s|%d|%s", "station-1", key, expires, stationSig)
	signature := ed25519.Sign(w.orgKey, []byte(message))
	if w.badOrgSig {
		signature[0] ^= 1
	}
	consumed := len(tokens)
	if w.consumed != 0 {
		consumed = w.consumed
	}
	response := map[string]any{"key": key, "station_id": "station-1", "station_signature": stationSig, "org_signature": hex.EncodeToString(signature),
		"expires_at_unix": expires, "tickets_consumed": consumed, "credit_limit": 0.05, "duration_minutes": 10, "station_recently_attested": false}
	w.responses[id] = response
	if w.dropRedeem > 0 {
		// The org spent them but the response never arrived.
		w.dropRedeem--
		respond(503, map[string]string{"detail": "lost"})
		return
	}
	respond(200, response)
}

// ticketError is auth/ticket_auth.py's _build_ticket_error.
func ticketError(code string, submitted, index int, reason string) map[string]any {
	return map[string]any{"error_code": code, "message": "m", "tickets_submitted": submitted, "tickets_consumed": 0,
		"failed_ticket": map[string]any{"index": index, "preview": "abc...", "reason": reason}}
}

func (w *world) newSource(t *testing.T, count int, reuse time.Duration) (*TicketSource, *wallet.Store, string) {
	t.Helper()
	dir := oatest.PrivateDir(t)
	store, err := wallet.Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	if err := store.Create(ctx, testOrg, "1234567890123456", strings.Repeat("d", 32)); err != nil {
		t.Fatal(err)
	}
	store.Update(ctx, func(st *wallet.State) error {
		for i := 0; i < count; i++ {
			st.Active = append(st.Active, w.ticket())
		}
		return nil
	})
	source, err := New(Config{OrgURL: testOrg, VerifierURL: testVerifier, Store: store, Client: oatest.Client(w), KeyReuseWindow: reuse})
	if err != nil {
		t.Fatal(err)
	}
	return source, store, dir
}

func (w *world) ticket() wallet.Ticket {
	token := w.issuer.Token(w.t)
	raw, _ := json.Marshal(map[string]string{"finalized_ticket": token, "signed_response": "sr"})
	return wallet.Ticket{Token: token, Raw: raw}
}

func counts(t *testing.T, store *wallet.Store) (active, archive, pending int) {
	t.Helper()
	store.View(context.Background(), func(st *wallet.State) error {
		active, archive = len(st.Active), len(st.Archive)
		for _, reservation := range st.Pending {
			pending += len(reservation.Tickets)
		}
		return nil
	})
	return
}

func wantCode(t *testing.T, err error, code string) {
	t.Helper()
	var safe *SafeError
	if !errors.As(err, &safe) || safe.Code != code {
		t.Fatalf("err = %v, want %s", err, code)
	}
}

func TestAcquireRedeemsTheExactModelCostAndVerifies(t *testing.T) {
	w := newWorld(t)
	source, store, _ := w.newSource(t, 5, 0)
	credential, err := source.Acquire(context.Background(), "vendor/three", false)
	if err != nil {
		t.Fatal(err)
	}
	if credential.VerificationStatus != "verified" || credential.Key != "sk-test-1" {
		t.Fatalf("credential = %+v", credential.VerificationStatus)
	}
	if !strings.Contains(w.redeemCalls[0], ",") || strings.Count(w.redeemCalls[0], ",") != 2 {
		t.Fatalf("expected 3 tickets, got %q", w.redeemCalls[0])
	}
	if active, archive, pending := counts(t, store); active != 2 || archive != 3 || pending != 0 {
		t.Fatalf("active=%d archive=%d pending=%d", active, archive, pending)
	}
}

func TestOnlineSuffixPricesAsItsBaseModel(t *testing.T) {
	w := newWorld(t)
	source, store, _ := w.newSource(t, 3, 0)
	if _, err := source.Acquire(context.Background(), "vendor/one:online", false); err != nil {
		t.Fatal(err)
	}
	if active, _, _ := counts(t, store); active != 2 {
		t.Fatalf("active = %d", active)
	}
}

func TestRedemptionCarriesNoAccountIdentity(t *testing.T) {
	w := newWorld(t)
	source, _, _ := w.newSource(t, 2, 0)
	if _, err := source.Acquire(context.Background(), "vendor/one", false); err != nil {
		t.Fatal(err)
	}
	if len(w.requests) == 0 {
		t.Fatal("no requests")
	}
	for _, request := range w.requests {
		for _, name := range []string{"Cookie", "St-Auth-Mode", "St-Access-Token", "Rid", "Anti-Csrf", "Front-Token"} {
			if request.Header.Get(name) != "" {
				t.Fatalf("%s on %s", name, request.URL)
			}
		}
		auth := request.Header.Get("Authorization")
		if request.URL.Path == "/api/request_key/nonce" {
			if !strings.HasPrefix(auth, "InferenceTicket ") {
				t.Fatalf("redemption authorization = %q", auth)
			}
		} else if auth != "" {
			t.Fatalf("Authorization on %s", request.URL)
		}
		if strings.HasPrefix(request.URL.Path, "/auth") || strings.Contains(request.URL.RawQuery, "account") {
			t.Fatalf("account route on the anonymous path: %s", request.URL)
		}
		if ua := request.Header.Get("User-Agent"); ua != userAgent {
			t.Fatalf("User-Agent = %q", ua)
		}
	}
}

func TestAnonymousClientRefusesAccountRoutesAndStripsCredentials(t *testing.T) {
	w := newWorld(t)
	client := AnonymousClient(oatest.Client(w))
	for _, target := range []string{testOrg + "/auth/sync", testOrg + "/auth/daemon/start", testOrg + "/api/billing/tickets/claim"} {
		response, err := client.Get(target)
		if err == nil {
			response.Body.Close()
			t.Fatalf("%s reached the network", target)
		}
	}
	request, _ := http.NewRequest(http.MethodGet, testOrg+"/chat/model-tickets", nil)
	request.Header.Set("Cookie", "sAccessToken=abc")
	request.Header.Set("Authorization", "Bearer account-token")
	request.Header.Set("st-auth-mode", "header")
	response, err := client.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	seen := w.requests[len(w.requests)-1]
	if seen.Header.Get("Cookie") != "" || seen.Header.Get("Authorization") != "" || seen.Header.Get("St-Auth-Mode") != "" {
		t.Fatalf("headers leaked: %v", seen.Header)
	}
}

func TestLostResponseRetriesTheExactTicketsWithoutSpendingMore(t *testing.T) {
	w := newWorld(t)
	w.dropRedeem = 3 // Every in-request retry loses its response.
	source, store, dir := w.newSource(t, 5, 0)
	_, err := source.Acquire(context.Background(), "vendor/three", false)
	wantCode(t, err, "key_request_interrupted")
	if active, archive, pending := counts(t, store); active != 2 || archive != 0 || pending != 3 {
		t.Fatalf("active=%d archive=%d pending=%d", active, archive, pending)
	}
	first := w.redeemCalls[0]

	// A restart: a new store and source on the same directory.
	restarted, err := wallet.Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	next, err := New(Config{OrgURL: testOrg, VerifierURL: testVerifier, Store: restarted, Client: oatest.Client(w)})
	if err != nil {
		t.Fatal(err)
	}
	credential, err := next.Acquire(context.Background(), "vendor/three", false)
	if err != nil {
		t.Fatal(err)
	}
	if credential.Key != "sk-test-1" {
		t.Fatalf("expected the org's replayed key, got %s", credential.Key)
	}
	if w.redeemCalls[len(w.redeemCalls)-1] != first {
		t.Fatal("the retry must send the identical tokens")
	}
	if active, archive, pending := counts(t, restarted); active != 2 || archive != 3 || pending != 0 {
		t.Fatalf("active=%d archive=%d pending=%d", active, archive, pending)
	}
	if w.keyCounter != 1 {
		t.Fatalf("spent %d times", w.keyCounter)
	}
}

func TestCollisionWithAnotherClientRetriesWithOtherTickets(t *testing.T) {
	w := newWorld(t)
	source, store, _ := w.newSource(t, 4, 0)
	// The browser already spent the two tickets this client would pick first.
	store.View(context.Background(), func(st *wallet.State) error {
		w.spent[st.Active[3].Token] = true
		w.spent[st.Active[2].Token] = true
		return nil
	})
	credential, err := source.Acquire(context.Background(), "vendor/one", false)
	if err != nil {
		t.Fatal(err)
	}
	if credential.Key == "" {
		t.Fatal("no key")
	}
	active, archive, pending := counts(t, store)
	if active != 1 || archive != 3 || pending != 0 {
		t.Fatalf("active=%d archive=%d pending=%d", active, archive, pending)
	}
}

func TestMultiTicketCollisionLosesOnlyTheSpentTicket(t *testing.T) {
	w := newWorld(t)
	source, store, _ := w.newSource(t, 3, 0)
	w.mu.Lock()
	rejected := false
	w.redeemFail = func(tokens []string) (int, any) {
		if !rejected {
			rejected = true
			return 401, map[string]any{"detail": ticketError("TICKET_ALREADY_SPENT", 3, 1, "Ticket already spent")}
		}
		return 0, nil
	}
	w.mu.Unlock()
	// The wallet now holds two tickets, too few for this model.
	_, err := source.Acquire(context.Background(), "vendor/three", false)
	wantCode(t, err, "insufficient_tickets")
	if active, archive, pending := counts(t, store); active != 2 || archive != 1 || pending != 0 {
		t.Fatalf("only the failed ticket may be archived: active=%d archive=%d pending=%d", active, archive, pending)
	}
}

func TestRotationDropsTheGenerationAndRecordsAnEncryptedTombstone(t *testing.T) {
	w := newWorld(t)
	source, store, _ := w.newSource(t, 2, 0)
	old := w.issuer
	w.mu.Lock()
	w.redeemFail = func([]string) (int, any) {
		return 401, map[string]any{"detail": map[string]any{"error_code": "TICKET_KEY_INVALIDATED", "invalidated_key_id": old.KeyID}}
	}
	w.mu.Unlock()
	_, err := source.Acquire(context.Background(), "vendor/one", false)
	wantCode(t, err, "insufficient_tickets")
	store.View(context.Background(), func(st *wallet.State) error {
		if len(st.Active) != 0 || len(st.Invalidated) != 1 || st.Invalidated[0] != old.KeyID || !st.Dirty {
			t.Fatalf("active=%d invalidated=%v dirty=%v", len(st.Active), st.Invalidated, st.Dirty)
		}
		return nil
	})
}

func TestDefinitiveRefusalRestoresTickets(t *testing.T) {
	w := newWorld(t)
	source, store, _ := w.newSource(t, 2, 0)
	w.mu.Lock()
	w.redeemFail = func([]string) (int, any) {
		return 400, map[string]any{"detail": map[string]any{"error_code": "TICKET_TIER_MISMATCH"}}
	}
	w.mu.Unlock()
	_, err := source.Acquire(context.Background(), "vendor/one", false)
	wantCode(t, err, "key_request_refused")
	if active, archive, pending := counts(t, store); active != 2 || archive != 0 || pending != 0 {
		t.Fatalf("active=%d archive=%d pending=%d", active, archive, pending)
	}
}

func TestPolicyFailsBeforeAnyTicketIsSelected(t *testing.T) {
	w := newWorld(t)
	w.disabled = []string{"vendor/three"}
	source, store, _ := w.newSource(t, 5, 0)
	for _, model := range []string{"vendor/three", "vendor/unknown"} {
		_, err := source.Acquire(context.Background(), model, false)
		wantCode(t, err, "model_not_available")
	}
	if len(w.redeemCalls) != 0 {
		t.Fatal("tickets were sent for an unpriced model")
	}
	if active, _, _ := counts(t, store); active != 5 {
		t.Fatalf("active = %d", active)
	}
}

func TestInvalidPricingIsRefused(t *testing.T) {
	w := newWorld(t)
	w.prices = map[string]int{"vendor/one": 0}
	source, _, _ := w.newSource(t, 5, 0)
	if _, err := source.Acquire(context.Background(), "vendor/one", false); err == nil {
		t.Fatal("zero-cost pricing accepted")
	}
	if len(w.redeemCalls) != 0 {
		t.Fatal("tickets were sent")
	}
}

func TestInsufficientTicketsNeverBuysAndExplains(t *testing.T) {
	w := newWorld(t)
	source, store, _ := w.newSource(t, 2, 0)
	_, err := source.Acquire(context.Background(), "vendor/three", false)
	wantCode(t, err, "insufficient_tickets")
	if !strings.Contains(err.Error(), "Nothing is ever purchased") {
		t.Fatalf("err = %v", err)
	}
	for _, request := range w.requests {
		if strings.Contains(request.URL.Path, "billing") || strings.Contains(request.URL.Path, "checkout") {
			t.Fatalf("billing touched: %s", request.URL)
		}
	}
	if active, _, _ := counts(t, store); active != 2 {
		t.Fatalf("active = %d", active)
	}
}

func TestWrongIssuerTicketIsNeverSent(t *testing.T) {
	w := newWorld(t)
	source, store, _ := w.newSource(t, 0, 0)
	other := oatest.NewIssuer(t)
	store.Update(context.Background(), func(st *wallet.State) error {
		forged := other.Token(t)
		raw, _ := json.Marshal(map[string]string{"finalized_ticket": forged})
		st.Active = []wallet.Ticket{{Token: forged, Raw: raw}, {Token: "garbage", Raw: json.RawMessage(`{"finalized_ticket":"garbage"}`)}}
		return nil
	})
	_, err := source.Acquire(context.Background(), "vendor/one", false)
	wantCode(t, err, "insufficient_tickets")
	if len(w.redeemCalls) != 0 {
		t.Fatal("a foreign ticket was sent")
	}
	if active, _, _ := counts(t, store); active != 2 {
		t.Fatal("foreign tickets stay in the replica; only this client refuses to spend them")
	}
}

func TestIssuerKeyMismatchFailsClosed(t *testing.T) {
	w := newWorld(t)
	source, _, _ := w.newSource(t, 2, 0)
	w.issuer.KeyID = strings.Repeat("0", 64)
	if _, err := source.Acquire(context.Background(), "vendor/one", false); err == nil {
		t.Fatal("mismatched issuer key metadata accepted")
	}
	if len(w.redeemCalls) != 0 {
		t.Fatal("tickets were sent")
	}
}

func TestBadOrgSignatureDiscardsKeyAndTicketsStaySpent(t *testing.T) {
	w := newWorld(t)
	w.badOrgSig = true
	source, store, _ := w.newSource(t, 2, 0)
	_, err := source.Acquire(context.Background(), "vendor/one", false)
	wantCode(t, err, "key_rejected")
	if !strings.Contains(err.Error(), "org signature") {
		t.Fatalf("err = %v", err)
	}
	if _, archive, _ := counts(t, store); archive != 1 {
		t.Fatal("tickets must stay spent")
	}
	for _, request := range w.requests {
		if request.Host == "verifier.test" {
			t.Fatal("a key with a bad signature must not reach the verifier")
		}
	}
}

func TestKeyConstraintsAreEnforced(t *testing.T) {
	t.Run("wrong ticket count", func(t *testing.T) {
		w := newWorld(t)
		w.consumed = 9
		source, _, _ := w.newSource(t, 2, 0)
		_, err := source.Acquire(context.Background(), "vendor/one", false)
		wantCode(t, err, "key_rejected")
	})
	t.Run("expired", func(t *testing.T) {
		w := newWorld(t)
		w.expiresIn = -5
		source, _, _ := w.newSource(t, 2, 0)
		_, err := source.Acquire(context.Background(), "vendor/one", false)
		wantCode(t, err, "key_rejected")
	})
	t.Run("outlives its tier", func(t *testing.T) {
		w := newWorld(t)
		w.expiresIn = 3600
		source, _, _ := w.newSource(t, 2, 0)
		_, err := source.Acquire(context.Background(), "vendor/one", false)
		wantCode(t, err, "key_rejected")
	})
}

func TestVerifierRefusalsKeepTicketsSpent(t *testing.T) {
	cases := map[string]func(key, station string) (int, any){
		"explicit refusal": func(string, string) (int, any) { return 200, map[string]string{"status": "rejected"} },
		"pending":          func(string, string) (int, any) { return 200, map[string]string{"status": "pending"} },
		"wrong station": func(key, _ string) (int, any) {
			sum := sha256.Sum256([]byte(key))
			return 200, map[string]string{"status": "verified", "station_id": "other", "key_hash": hex.EncodeToString(sum[:])[:16]}
		},
		"wrong key hash": func(_, station string) (int, any) {
			return 200, map[string]string{"status": "verified", "station_id": station, "key_hash": strings.Repeat("0", 16)}
		},
		"short key hash": func(key, station string) (int, any) {
			sum := sha256.Sum256([]byte(key))
			return 200, map[string]string{"status": "verified", "station_id": station, "key_hash": hex.EncodeToString(sum[:])[:8]}
		},
		"privacy failure": func(string, string) (int, any) { return 403, map[string]string{"message": "privacy toggle off"} },
		"not recently attested outage": func(string, string) (int, any) {
			return 503, map[string]string{"status": "unavailable"}
		},
	}
	for name, verdict := range cases {
		t.Run(name, func(t *testing.T) {
			w := newWorld(t)
			w.verifierStatus = verdict
			source, store, _ := w.newSource(t, 2, 0)
			_, err := source.Acquire(context.Background(), "vendor/one", false)
			wantCode(t, err, "key_rejected")
			if _, archive, _ := counts(t, store); archive != 1 {
				t.Fatal("tickets must stay spent")
			}
		})
	}
}

func TestBannedStationStaysBannedInThisProcess(t *testing.T) {
	w := newWorld(t)
	banned := true
	w.verifierStatus = func(key, station string) (int, any) {
		if banned {
			return 200, map[string]string{"status": "banned"}
		}
		sum := sha256.Sum256([]byte(key))
		return 200, map[string]string{"status": "verified", "station_id": station, "key_hash": hex.EncodeToString(sum[:])[:16]}
	}
	source, _, _ := w.newSource(t, 3, 0)
	if _, err := source.Acquire(context.Background(), "vendor/one", false); err == nil {
		t.Fatal("banned station accepted")
	}
	banned = false
	_, err := source.Acquire(context.Background(), "vendor/one", false)
	wantCode(t, err, "key_rejected")
}

func TestOutageNeedsAttestationAndACheckableSignature(t *testing.T) {
	outage := func(string, string) (int, any) { return 429, map[string]string{} }
	w := newWorld(t)
	w.verifierStatus = outage
	source, _, _ := w.newSource(t, 2, 0)
	credential, err := source.Acquire(context.Background(), "vendor/one", false)
	if err != nil || credential.VerificationStatus != "verifier-unavailable" {
		t.Fatalf("credential=%+v err=%v", credential.VerificationStatus, err)
	}
	w = newWorld(t)
	w.verifierStatus = outage
	w.noOrgKey = true
	source, _, _ = w.newSource(t, 2, 0)
	_, err = source.Acquire(context.Background(), "vendor/one", false)
	wantCode(t, err, "key_rejected")
}

func TestReuseSharesOneKeyPerTierAndFreshBypasses(t *testing.T) {
	w := newWorld(t)
	source, store, _ := w.newSource(t, 10, time.Minute)
	ctx := context.Background()
	first, _ := source.Acquire(ctx, "vendor/one", false)
	second, _ := source.Acquire(ctx, "vendor/one", false)
	if first.Key == "" || first.Key != second.Key {
		t.Fatalf("keys %q %q", first.Key, second.Key)
	}
	other, _ := source.Acquire(ctx, "vendor/three", false)
	if other.Key == first.Key {
		t.Fatal("a different tier must get its own key")
	}
	fresh, _ := source.Acquire(ctx, "vendor/one", true)
	if fresh.Key == first.Key {
		t.Fatal("fresh must not reuse")
	}
	again, _ := source.Acquire(ctx, "vendor/one", false)
	if again.Key != first.Key {
		t.Fatal("fresh must not replace the cached key")
	}
	source.Invalidate(first.Key)
	replaced, _ := source.Acquire(ctx, "vendor/one", false)
	if replaced.Key == first.Key {
		t.Fatal("an invalidated key was reused")
	}
	if active, _, _ := counts(t, store); active != 10-1-3-1-1 {
		t.Fatalf("active = %d", active)
	}
}

func TestConcurrentAcquisitionNeverDoubleSpends(t *testing.T) {
	w := newWorld(t)
	source, store, _ := w.newSource(t, 30, 0)
	var wg sync.WaitGroup
	keys := make(chan string, 30)
	for i := 0; i < 30; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			credential, err := source.Acquire(context.Background(), "vendor/one", false)
			if err != nil {
				t.Error(err)
				return
			}
			keys <- credential.Key
		}()
	}
	wg.Wait()
	close(keys)
	seen := map[string]bool{}
	for key := range keys {
		if seen[key] {
			t.Fatal("one key was handed to two requests: tickets were shared")
		}
		seen[key] = true
	}
	if len(seen) != 30 || len(w.spent) != 30 {
		t.Fatalf("keys=%d spent=%d", len(seen), len(w.spent))
	}
	if active, archive, pending := counts(t, store); active != 0 || archive != 30 || pending != 0 {
		t.Fatalf("active=%d archive=%d pending=%d", active, archive, pending)
	}
}

func TestRevokedComputerStopsSpending(t *testing.T) {
	w := newWorld(t)
	source, store, _ := w.newSource(t, 2, time.Minute)
	source.cfg.Authorized = func(context.Context) error { return errors.New("revoked") }
	_, err := source.Acquire(context.Background(), "vendor/one", false)
	wantCode(t, err, "authorization_required")
	if len(w.redeemCalls) != 0 {
		t.Fatal("a revoked computer redeemed tickets")
	}
	if active, _, _ := counts(t, store); active != 2 {
		t.Fatal("tickets must stay in place for the next login")
	}
}

func TestNothingRedeemsWithoutARequest(t *testing.T) {
	w := newWorld(t)
	w.dropRedeem = 3
	source, store, dir := w.newSource(t, 3, 0)
	_, err := source.Acquire(context.Background(), "vendor/one", false)
	wantCode(t, err, "key_request_interrupted")
	calls := len(w.redeemCalls)
	// A restart resolves nothing by itself: an unspent reservation stays unspent.
	reopened, _ := wallet.Open(dir)
	if _, err := New(Config{OrgURL: testOrg, VerifierURL: testVerifier, Store: reopened, Client: oatest.Client(w)}); err != nil {
		t.Fatal(err)
	}
	if len(w.redeemCalls) != calls {
		t.Fatal("redeemed without a request")
	}
	if _, _, pending := counts(t, store); pending != 1 {
		t.Fatalf("pending = %d", pending)
	}
}

func TestDeadStationDoesNotBlockLaterRequests(t *testing.T) {
	w := newWorld(t)
	source, store, _ := w.newSource(t, 3, 0)
	var bound string
	w.mu.Lock()
	w.redeemFail = func(tokens []string) (int, any) {
		if bound == "" {
			bound = tokens[0]
		}
		if tokens[0] == bound {
			return 503, map[string]string{"detail": "Tried 1 station(s), all failed."}
		}
		return 0, nil
	}
	w.mu.Unlock()
	var credential Credential
	var err error
	for i := 0; i < 4 && credential.Key == ""; i++ {
		credential, err = source.Acquire(context.Background(), "vendor/one", false)
		if err == nil {
			break
		}
		wantCode(t, err, "key_request_interrupted")
	}
	if credential.Key == "" {
		t.Fatalf("still blocked: %v", err)
	}
	if active, archive, pending := counts(t, store); active != 1 || archive != 1 || pending != 1 {
		t.Fatalf("active=%d archive=%d pending=%d", active, archive, pending)
	}
	// Later, the parked reservation is tried again and resolves.
	w.mu.Lock()
	w.redeemFail = nil
	w.mu.Unlock()
	source.now = func() time.Time { return time.Now().Add(parkFor + time.Second) }
	if _, err := source.Acquire(context.Background(), "vendor/one", false); err != nil {
		t.Fatal(err)
	}
	if active, archive, pending := counts(t, store); active != 1 || archive != 2 || pending != 0 {
		t.Fatalf("after retry active=%d archive=%d pending=%d", active, archive, pending)
	}
}

func TestOutageCannotReserveTheWholeWallet(t *testing.T) {
	w := newWorld(t)
	source, store, _ := w.newSource(t, 20, 0)
	w.mu.Lock()
	w.redeemFail = func([]string) (int, any) { return 503, map[string]string{"detail": "down"} }
	w.mu.Unlock()
	for i := 0; i < 20; i++ {
		_, err := source.Acquire(context.Background(), "vendor/one", false)
		wantCode(t, err, "key_request_interrupted")
	}
	if _, _, pending := counts(t, store); pending > maxParkedPerCost+1 {
		t.Fatalf("an outage reserved %d tickets", pending)
	}
}

func TestRefusedTicketRestsSoOthersAreUsed(t *testing.T) {
	w := newWorld(t)
	source, store, _ := w.newSource(t, 2, 0)
	var refused string
	w.mu.Lock()
	w.redeemFail = func(tokens []string) (int, any) {
		if refused == "" || tokens[0] == refused {
			refused = tokens[0]
			return 401, map[string]any{"detail": ticketError("TICKET_INVALID", 1, 0, "Invalid ticket")}
		}
		return 0, nil
	}
	w.mu.Unlock()
	_, err := source.Acquire(context.Background(), "vendor/one", false)
	wantCode(t, err, "key_request_refused")
	if _, err := source.Acquire(context.Background(), "vendor/one", false); err != nil {
		t.Fatal(err)
	}
	if active, archive, _ := counts(t, store); active != 1 || archive != 1 {
		t.Fatalf("active=%d archive=%d", active, archive)
	}
}

func TestErrorsNeverCarryTickets(t *testing.T) {
	w := newWorld(t)
	source, store, _ := w.newSource(t, 2, 0)
	w.mu.Lock()
	w.redeemFail = func(tokens []string) (int, any) {
		return 400, map[string]any{"detail": "bad token " + tokens[0]}
	}
	w.mu.Unlock()
	_, err := source.Acquire(context.Background(), "vendor/one", false)
	if err == nil {
		t.Fatal("expected failure")
	}
	store.View(context.Background(), func(st *wallet.State) error {
		if wallet.ContainsSecret([]byte(err.Error()), st.Active) {
			t.Fatalf("ticket in error: %v", err)
		}
		return nil
	})
}

// The rest of the path: the shared local API, this gateway and the provider.
func apiFor(t *testing.T, w *world, source *TicketSource) *server.API {
	t.Helper()
	gateway := &Gateway{Source: source, BaseURL: testProvider, Client: AnonymousClient(oatest.Client(w))}
	api, err := server.New(gateway, strings.Repeat("k", 32), 4)
	if err != nil {
		t.Fatal(err)
	}
	api.DefaultModel = "vendor/one"
	api.WebSearch = false
	api.Identity = server.Identity{InvalidKeyMessage: "A valid local oa-clientd API key is required.", AccessFailedMessage: "tickets", DelegatePath: server.OADelegatePath, RewriteName: "oa"}
	return api
}

func call(api *server.API, method, path, body string, headers map[string]string) *httptest.ResponseRecorder {
	request := httptest.NewRequest(method, "http://127.0.0.1:8797"+path, strings.NewReader(body))
	request.RemoteAddr = "127.0.0.1:50000"
	request.Header.Set("Content-Type", "application/json")
	for name, value := range headers {
		request.Header.Set(name, value)
	}
	recorder := httptest.NewRecorder()
	api.ServeHTTP(recorder, request)
	return recorder
}

func TestLocalAPICompletionReachesProviderWithOnlyTheEphemeralKey(t *testing.T) {
	w := newWorld(t)
	source, _, _ := w.newSource(t, 2, 0)
	response := call(apiFor(t, w, source), http.MethodPost, "/v1/chat/completions",
		`{"model":"vendor/one","messages":[{"role":"user","content":"PROMPT-CANARY"}],"user":"should-be-removed"}`, nil)
	if response.Code != 200 {
		t.Fatalf("status = %d: %s", response.Code, response.Body)
	}
	if response.Header().Get("X-OA-Verification-Status") != "verified" {
		t.Fatalf("verification header = %q", response.Header().Get("X-OA-Verification-Status"))
	}
	if len(w.providerAuth) != 1 || w.providerAuth[0] != "Bearer sk-test-1" {
		t.Fatalf("provider auth = %v", w.providerAuth)
	}
	if strings.Contains(w.providerBodies[0], "should-be-removed") {
		t.Fatal("user field crossed the boundary")
	}
	for _, request := range w.requests {
		if request.Host != "provider.test" {
			body, _ := io.ReadAll(request.Body)
			if strings.Contains(string(body), "PROMPT-CANARY") {
				t.Fatalf("prompt reached %s", request.URL)
			}
		}
	}
}

func TestLocalAPIStreamsUnmodified(t *testing.T) {
	w := newWorld(t)
	w.providerType = "text/event-stream"
	w.providerBody = "data: {\"a\":1}\n\ndata: [DONE]\n\n"
	source, _, _ := w.newSource(t, 2, 0)
	response := call(apiFor(t, w, source), http.MethodPost, "/v1/chat/completions",
		`{"messages":[{"role":"user","content":"hi"}],"stream":true}`, nil)
	if response.Code != 200 || response.Body.String() != w.providerBody {
		t.Fatalf("status=%d body=%q", response.Code, response.Body)
	}
}

func TestLocalAPIExplainsShortageAndModels(t *testing.T) {
	w := newWorld(t)
	source, _, _ := w.newSource(t, 0, 0)
	api := apiFor(t, w, source)
	response := call(api, http.MethodPost, "/v1/chat/completions", `{"model":"vendor/one","messages":[{"role":"user","content":"hi"}]}`, nil)
	if response.Code != 402 || !strings.Contains(response.Body.String(), "insufficient_tickets") {
		t.Fatalf("status=%d body=%s", response.Code, response.Body)
	}
	models := call(api, http.MethodGet, "/v1/models", "", nil)
	if models.Code != 200 || !strings.Contains(models.Body.String(), `"oa_ticket_cost":3`) {
		t.Fatalf("models = %s", models.Body)
	}
}

func TestLocalAPIKeepsItsSharedGuards(t *testing.T) {
	w := newWorld(t)
	source, _, _ := w.newSource(t, 2, 0)
	api := apiFor(t, w, source)
	body := `{"model":"vendor/one","messages":[{"role":"user","content":"hi"}]}`
	if response := call(api, http.MethodPost, "/v1/chat/completions", body, map[string]string{"Origin": "https://evil.example"}); response.Code != 403 {
		t.Fatalf("browser origin allowed: %d", response.Code)
	}
	rebinding := httptest.NewRequest(http.MethodPost, "http://evil.example/v1/chat/completions", strings.NewReader(body))
	rebinding.RemoteAddr = "127.0.0.1:50000"
	rebinding.Header.Set("Content-Type", "application/json")
	recorder := httptest.NewRecorder()
	api.ServeHTTP(recorder, rebinding)
	if recorder.Code != 403 {
		t.Fatalf("DNS rebinding allowed: %d", recorder.Code)
	}
	api.RequireAPIKey = true
	response := call(api, http.MethodPost, "/v1/chat/completions", body, nil)
	if response.Code != 401 || !strings.Contains(response.Body.String(), "oa-clientd") || strings.Contains(response.Body.String(), "zkAPI") {
		t.Fatalf("unauthorized = %d %s", response.Code, response.Body)
	}
	if response := call(api, http.MethodPost, "/v1/chat/completions", body, map[string]string{"Authorization": "Bearer " + strings.Repeat("k", 32)}); response.Code != 200 {
		t.Fatalf("authorized = %d %s", response.Code, response.Body)
	}
	if len(w.redeemCalls) != 1 {
		t.Fatalf("redeemed %d times", len(w.redeemCalls))
	}
}

func TestDelegationRequiresIsolationAndNeverReusesAKey(t *testing.T) {
	w := newWorld(t)
	source, _, _ := w.newSource(t, 4, time.Minute)
	api := apiFor(t, w, source)
	body := `{"task":"two plus two","model":"vendor/one"}`
	refused := call(api, http.MethodPost, server.OADelegatePath, body, nil)
	if refused.Code != 412 || !strings.Contains(refused.Body.String(), "delegation_requires_tor") {
		t.Fatalf("refused = %d %s", refused.Code, refused.Body)
	}
	if len(w.redeemCalls) != 0 {
		t.Fatal("a refused delegation spent tickets")
	}
	if response := call(api, http.MethodPost, server.DelegatePath, body, map[string]string{"Authorization": "Bearer " + strings.Repeat("k", 32)}); response.Code != 404 {
		t.Fatalf("the zkAPI delegation route must not exist on this API: %d", response.Code)
	}
	gateway := &Gateway{Source: source, BaseURL: testProvider, Client: AnonymousClient(oatest.Client(w)), PrepareRoute: FreshTorRoute}
	first, err := gateway.Delegate(context.Background(), json.RawMessage(`{"model":"vendor/one","messages":[]}`))
	if err != nil {
		t.Fatal(err)
	}
	first.Body.Close()
	second, err := gateway.Delegate(context.Background(), json.RawMessage(`{"model":"vendor/one","messages":[]}`))
	if err != nil {
		t.Fatal(err)
	}
	second.Body.Close()
	if w.providerAuth[0] == w.providerAuth[1] {
		t.Fatal("delegations must not share a key")
	}
}

func TestProviderFailureInvalidatesAndNeverRetries(t *testing.T) {
	w := newWorld(t)
	w.providerStatus = 500
	source, _, _ := w.newSource(t, 4, time.Minute)
	api := apiFor(t, w, source)
	body := `{"model":"vendor/one","messages":[{"role":"user","content":"hi"}]}`
	response := call(api, http.MethodPost, "/v1/chat/completions", body, nil)
	if response.Code != 500 || len(w.providerAuth) != 1 {
		t.Fatalf("status=%d calls=%d", response.Code, len(w.providerAuth))
	}
	w.providerStatus = 200
	call(api, http.MethodPost, "/v1/chat/completions", body, nil)
	if w.providerAuth[0] == w.providerAuth[1] {
		t.Fatal("a failed key must not be reused")
	}
}

func TestOldServerFailsClosedWithNoLegacyFallback(t *testing.T) {
	w := newWorld(t)
	w.oldServer = true
	source, store, _ := w.newSource(t, 3, 0)
	response := call(apiFor(t, w, source), http.MethodPost, "/v1/chat/completions", `{"model":"vendor/three","messages":[{"role":"user","content":"hi"}]}`, nil)
	if response.Code != 502 || !strings.Contains(response.Body.String(), "org_unsupported") {
		t.Fatalf("status=%d body=%s", response.Code, response.Body)
	}
	if w.legacyCalls != 0 || len(w.redeemCalls) != 0 {
		t.Fatalf("legacy route used: %d", w.legacyCalls)
	}
	if len(w.providerAuth) != 0 {
		t.Fatal("the provider was contacted")
	}
	if active, archive, pending := counts(t, store); active != 3 || archive != 0 || pending != 0 {
		t.Fatalf("tickets moved: active=%d archive=%d pending=%d", active, archive, pending)
	}
}

func TestWalletAndSessionMismatchStopsAllSpending(t *testing.T) {
	account := "1234567890123456"
	w := newWorld(t)
	source, store, _ := w.newSource(t, 3, time.Minute)
	source.cfg.Account = func() (string, error) { return account, nil }
	first, err := source.Acquire(context.Background(), "vendor/one", false)
	if err != nil {
		t.Fatal(err)
	}
	calls := len(w.redeemCalls)
	// The session now says another account, as a lost login race would leave it.
	account = "6543210987654321"
	_, err = source.Acquire(context.Background(), "vendor/one", false)
	wantCode(t, err, "account_mismatch")
	_, err = source.Acquire(context.Background(), "vendor/three", true)
	wantCode(t, err, "account_mismatch")
	if len(w.redeemCalls) != calls {
		t.Fatal("spent across accounts")
	}
	account = "1234567890123456"
	again, err := source.Acquire(context.Background(), "vendor/one", false)
	if err != nil || again.Key != first.Key {
		t.Fatalf("same account must keep working: %v", err)
	}
	source.cfg.Account = func() (string, error) { return "", errors.New("signed out") }
	_, err = source.Acquire(context.Background(), "vendor/one", true)
	wantCode(t, err, "account_mismatch")
	store.Update(context.Background(), func(state *wallet.State) error { state.OrgURL = "https://other.test"; return nil })
	source.cfg.Account = func() (string, error) { return "1234567890123456", nil }
	_, err = source.Acquire(context.Background(), "vendor/one", true)
	wantCode(t, err, "account_mismatch")
}

func TestVerifierHashMatching(t *testing.T) {
	key := "sk-test"
	sum := sha256.Sum256([]byte(key))
	full := hex.EncodeToString(sum[:])
	for value, want := range map[string]bool{full: true, full[:16]: true, full[:8]: false, full[:32]: false, "": false, strings.Repeat("0", 16): false} {
		if verifierKeyHashMatches(value, key) != want {
			t.Errorf("%q: want %v", value, want)
		}
	}
	if verifierKeyHashMatches(full, "") {
		t.Error("empty key must not match")
	}
}

func TestCrossClientRequestsGetIndependentKeysAndUntouchedTicketsSurvive(t *testing.T) {
	w := newWorld(t)
	tickets := []wallet.Ticket{w.ticket(), w.ticket(), w.ticket(), w.ticket()}
	build := func() (*TicketSource, *wallet.Store) {
		source, store, _ := w.newSource(t, 0, 0)
		store.Update(context.Background(), func(st *wallet.State) error {
			st.Active = append([]wallet.Ticket{}, tickets...)
			return nil
		})
		return source, store
	}
	// Two clients with stale replicas pick the same tickets.
	first, _ := build()
	second, secondStore := build()
	a, err := first.Acquire(context.Background(), "vendor/one", false)
	if err != nil {
		t.Fatal(err)
	}
	b, err := second.Acquire(context.Background(), "vendor/one", false)
	if err != nil {
		t.Fatal(err)
	}
	if a.Key == b.Key {
		t.Fatal("two requests received one provider key")
	}
	if w.nonces[0] == "" || w.nonces[0] == w.nonces[1] {
		t.Fatalf("nonces = %v", w.nonces)
	}
	if active, archive, pending := counts(t, secondStore); active != 2 || archive != 2 || pending != 0 {
		t.Fatalf("active=%d archive=%d pending=%d", active, archive, pending)
	}
	if w.keyCounter != 2 || len(w.spent) != 2 {
		t.Fatalf("keys=%d spent=%d", w.keyCounter, len(w.spent))
	}
}

func TestFreshRequestsUseNewNoncesAndRetriesKeepTheirs(t *testing.T) {
	w := newWorld(t)
	w.dropRedeem = 3
	source, store, dir := w.newSource(t, 4, 0)
	_, err := source.Acquire(context.Background(), "vendor/one", false)
	wantCode(t, err, "key_request_interrupted")
	first := w.nonces[0]
	if len(first) < 32 {
		t.Fatalf("nonce = %q", first)
	}
	for _, nonce := range w.nonces {
		if nonce != first {
			t.Fatal("a network retry changed the nonce")
		}
	}
	store.View(context.Background(), func(st *wallet.State) error {
		if st.Pending[0].Nonce != first {
			t.Fatal("the nonce must be durable before the first send")
		}
		return nil
	})
	reopened, _ := wallet.Open(dir)
	next, _ := New(Config{OrgURL: testOrg, VerifierURL: testVerifier, Store: reopened, Client: oatest.Client(w)})
	recovered, err := next.Acquire(context.Background(), "vendor/one", false)
	if err != nil {
		t.Fatal(err)
	}
	if recovered.Key != "sk-test-1" || w.nonces[len(w.nonces)-1] != first {
		t.Fatalf("recovery key=%s", recovered.Key)
	}
	fresh, err := next.Acquire(context.Background(), "vendor/one", false)
	if err != nil {
		t.Fatal(err)
	}
	if fresh.Key == recovered.Key || w.nonces[len(w.nonces)-1] == first {
		t.Fatal("a new request reused the nonce")
	}
}

func TestTicketHeldByAnotherRequestIsKeptAndOthersAreUsed(t *testing.T) {
	w := newWorld(t)
	source, store, _ := w.newSource(t, 3, 0)
	var last string
	store.View(context.Background(), func(st *wallet.State) error {
		last = st.Active[2].Token
		return nil
	})
	w.held = map[string]bool{last: true}
	if _, err := source.Acquire(context.Background(), "vendor/one", false); err != nil {
		t.Fatal(err)
	}
	if active, archive, pending := counts(t, store); active != 2 || archive != 1 || pending != 0 {
		t.Fatalf("active=%d archive=%d pending=%d", active, archive, pending)
	}
	store.View(context.Background(), func(st *wallet.State) error {
		found := false
		for _, ticket := range st.Active {
			found = found || ticket.Token == last
		}
		if !found || st.Spent[wallet.Fingerprint(last)] {
			t.Fatal("a provisionally held ticket must stay in the wallet")
		}
		return nil
	})
}

func TestEveryTicketHeldLosesNothing(t *testing.T) {
	w := newWorld(t)
	source, store, _ := w.newSource(t, 2, 0)
	w.held = map[string]bool{}
	store.View(context.Background(), func(st *wallet.State) error {
		for _, ticket := range st.Active {
			w.held[ticket.Token] = true
		}
		return nil
	})
	_, err := source.Acquire(context.Background(), "vendor/one", false)
	wantCode(t, err, "tickets_in_use")
	if active, archive, pending := counts(t, store); active != 2 || archive != 0 || pending != 0 {
		t.Fatalf("active=%d archive=%d pending=%d", active, archive, pending)
	}
	// The holder rolled back: a later request gets them.
	w.held = nil
	source.now = func() time.Time { return time.Now().Add(heldRestFor + time.Second) }
	if _, err := source.Acquire(context.Background(), "vendor/one", false); err != nil {
		t.Fatal(err)
	}
}

func TestRewriterRunsBeforeAnyTicketAndSeesNoReuse(t *testing.T) {
	w := newWorld(t)
	source, store, _ := w.newSource(t, 2, 0)
	gateway := &Gateway{Source: source, BaseURL: testProvider, Client: AnonymousClient(oatest.Client(w)),
		Rewriter: rewriter.Config{URL: "http://127.0.0.1:1/v1", Model: "m"}}
	_, err := gateway.Complete(context.Background(), json.RawMessage(`{"model":"vendor/one","messages":[{"role":"user","content":"hello"}]}`))
	if !errors.Is(err, rewriter.ErrFailed) {
		t.Fatalf("err = %v", err)
	}
	if len(w.redeemCalls) != 0 {
		t.Fatal("a failed rewrite spent tickets")
	}
	if active, _, _ := counts(t, store); active != 2 {
		t.Fatal("tickets moved")
	}
}

func TestRewriteNoticeUsesTheProductName(t *testing.T) {
	w := newWorld(t)
	source, _, _ := w.newSource(t, 2, 0)
	api := apiFor(t, w, source)
	if api.Identity.RewriteName != "oa" {
		t.Fatalf("name = %q", api.Identity.RewriteName)
	}
}

func TestParseRemoteErrorReadsTheOrgContract(t *testing.T) {
	remote := parseRemoteError(401, []byte(`{"detail":{"error_code":"TICKET_ALREADY_SPENT","message":"m","tickets_submitted":3,"tickets_consumed":0,"failed_ticket":{"index":2,"preview":"x","reason":"Ticket already spent"}}}`))
	if remote.Code != "TICKET_ALREADY_SPENT" || remote.FailedIndex != 2 || remote.transient() {
		t.Fatalf("remote = %+v", remote)
	}
	invalidated := parseRemoteError(401, []byte(`{"detail":{"error_code":"TICKET_KEY_INVALIDATED","invalidated_key_id":"abc","failed_ticket":{"index":0}}}`))
	if invalidated.InvalidatedKeyID != "abc" || invalidated.FailedIndex != 0 {
		t.Fatalf("invalidated = %+v", invalidated)
	}
	own := parseRemoteError(503, []byte(`{"detail":{"error_code":"TICKET_REQUEST_IN_PROGRESS"}}`))
	if own.heldByOther() || !own.transient() {
		t.Fatalf("own attempt = %+v", own)
	}
	held := parseRemoteError(503, []byte(`{"detail":{"error_code":"TICKET_REQUEST_IN_PROGRESS","failed_ticket":{"index":1,"reason":"held_by_other_request"}}}`))
	if !held.heldByOther() {
		t.Fatalf("held = %+v", held)
	}
	completed := parseRemoteError(409, []byte(`{"detail":{"error_code":"TICKET_ALREADY_SPENT","tickets_submitted":2,"tickets_consumed":0}}`))
	if completed.FailedIndex != -1 {
		t.Fatalf("completed = %+v", completed)
	}
	if plain := parseRemoteError(500, []byte("oops")); !plain.transient() || plain.FailedIndex != -1 {
		t.Fatalf("plain = %+v", plain)
	}
}
