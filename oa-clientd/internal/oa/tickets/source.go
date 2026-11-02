// Package tickets redeems finalized OA inference tickets for verified ephemeral
// provider keys and sends inference with them. It implements the same redemption
// and verification protocol as the browser's ticketClient.js and verifier.js.
//
// Nothing here is identity-bound. Its HTTP client is anonymous, refuses the
// account routes and carries no cookie or session, so an account credential
// cannot accompany a finalized ticket or a prompt.
package tickets

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/OpenAnonymity/oa-chat/oa-clientd/internal/oa/wallet"
)

const (
	userAgent         = "OA-Clientd/1"
	maxOrgResponse    = 8 << 20
	issuerCacheFor    = 10 * time.Minute
	maxSpendAttempts  = 3
	maxKeyLength      = 1024
	heldRestFor       = 30 * time.Second
	refusedRestFor    = time.Hour
	parkAfterFailures = 3
	parkFor           = 5 * time.Minute
	maxParkedPerCost  = 2

	redemptionNonceHeader = "X-OA-Redemption-Nonce"
	// The route that requires the nonce. An older org answers 404 here before
	// touching a ticket, whereas it would ignore the header on /api/request_key and
	// could hand this client's key to a peer holding the same tickets. There is
	// deliberately no fallback to that route.
	redemptionPath = "/api/request_key/nonce"
)

// Credential is a verified provider key. It stays in process memory only.
type Credential struct {
	Key                string
	ExpiresAt          time.Time
	VerificationStatus string
	VerificationDetail string
	CreditLimit        float64
	Reused             bool
}

// Source is the credential interface a payment method implements for the shared
// inference path: list what can be bought and obtain a verified key for a model.
type Source interface {
	Models(context.Context) (json.RawMessage, error)
	Acquire(ctx context.Context, model string, fresh bool) (Credential, error)
	Invalidate(key string)
}

// Config wires one ticket source to an org, a verifier and a local wallet.
type Config struct {
	OrgURL         string
	VerifierURL    string
	Store          *wallet.Store
	Client         *http.Client
	KeyReuseWindow time.Duration
	// Account returns the account this computer is authorized for. Any error, or a
	// wallet bound to another account or org, stops spending. Local files only: no
	// per-inference request carries an identity.
	Account func() (string, error)
	// Authorized reports whether this computer's account authorization is
	// current. A revoked computer stops spending until it signs in again.
	Authorized func(context.Context) error
}

// TicketSource implements Source with the wallet replica.
type TicketSource struct {
	cfg    Config
	client *http.Client
	now    func() time.Time

	banned sync.Map

	// A burst redeems once when reuse is on. Inference and invalidation never
	// wait for this gate.
	acquireGate chan struct{}
	cacheMu     sync.Mutex
	cached      map[int]cachedCredential

	issuerMu      sync.Mutex
	issuer        wallet.IssuerKey
	issuerFetched time.Time

	orgKeyMu sync.Mutex
	orgKey   ed25519.PublicKey

	// inFlight marks reservations a request is sending now. Only an idle one
	// can be resumed: two requests sharing tokens would share one key.
	inFlightMu sync.Mutex
	inFlight   map[string]bool

	// Issuer checks per ticket are cached for one key generation, and tickets
	// another client's live request holds rest briefly before being tried again.
	selectMu      sync.Mutex
	verified      map[string]bool
	verifiedFor   string
	heldElsewhere map[string]time.Time
	// resumeFailures counts org refusals per reservation. A station that vanished
	// keeps its request's binding for a day, so such a reservation must not block
	// every later request at its price.
	resumeFailures map[string]int
	resumeAfter    map[string]time.Time
}

func (s *TicketSource) claim(id string) bool {
	s.inFlightMu.Lock()
	defer s.inFlightMu.Unlock()
	if s.inFlight[id] {
		return false
	}
	s.inFlight[id] = true
	return true
}

func (s *TicketSource) unclaim(id string) {
	s.inFlightMu.Lock()
	defer s.inFlightMu.Unlock()
	delete(s.inFlight, id)
}

type cachedCredential struct {
	credential Credential
	stationID  string
	reuseUntil time.Time
}

// anonymousTransport is the redemption boundary: it refuses any account route
// and strips anything that could identify an account, whatever a caller set.
type anonymousTransport struct{ next http.RoundTripper }

func (t anonymousTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	if strings.HasPrefix(r.URL.Path, "/auth") || strings.HasPrefix(r.URL.Path, "/api/billing") {
		return nil, errors.New("refused an account route on the anonymous client")
	}
	clean := r.Clone(r.Context())
	for _, name := range []string{"Cookie", "St-Access-Token", "St-Refresh-Token", "Front-Token", "St-Auth-Mode", "Rid", "Anti-Csrf"} {
		clean.Header.Del(name)
	}
	if auth := clean.Header.Get("Authorization"); auth != "" &&
		!strings.HasPrefix(auth, "InferenceTicket ") && !strings.HasPrefix(r.URL.Path, "/api/v1/") && !strings.HasSuffix(r.URL.Path, "/chat/completions") {
		clean.Header.Del("Authorization")
	}
	return t.next.RoundTrip(clean)
}

// AnonymousClient wraps a transport for redemption and provider traffic. It has
// no cookie jar, and redirects are refused so a ticket or key cannot be forwarded.
func AnonymousClient(base *http.Client) *http.Client {
	transport := base.Transport
	if transport == nil {
		transport = http.DefaultTransport
	}
	return &http.Client{
		Transport:     anonymousTransport{next: transport},
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
}

// New validates the endpoints and prepares a source.
func New(cfg Config) (*TicketSource, error) {
	if cfg.KeyReuseWindow < 0 || cfg.KeyReuseWindow > 5*time.Minute {
		return nil, errors.New("key reuse window must be between zero and five minutes")
	}
	for _, endpoint := range []string{cfg.OrgURL, cfg.VerifierURL} {
		u, err := url.Parse(endpoint)
		if err != nil || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || strings.Trim(u.Path, "/") != "" {
			return nil, errors.New("ticket endpoints must be exact origins")
		}
	}
	if cfg.Store == nil || cfg.Client == nil {
		return nil, errors.New("a wallet and an anonymous HTTP client are required")
	}
	cfg.OrgURL = strings.TrimRight(cfg.OrgURL, "/")
	cfg.VerifierURL = strings.TrimRight(cfg.VerifierURL, "/")
	return &TicketSource{cfg: cfg, client: AnonymousClient(cfg.Client), now: time.Now, acquireGate: make(chan struct{}, 1), cached: map[int]cachedCredential{}, inFlight: map[string]bool{}, verified: map[string]bool{}, heldElsewhere: map[string]time.Time{}, resumeFailures: map[string]int{}, resumeAfter: map[string]time.Time{}}, nil
}

// remoteError is a fixed description of an org refusal; bodies stay private.
type remoteError struct {
	Status           int
	Code             string
	InvalidatedKeyID string
	FailedIndex      int
	FailedReason     string
	RetryAfter       time.Duration
}

func (e *remoteError) Error() string { return fmt.Sprintf("OA service returned HTTP %d", e.Status) }

// transient reports a failure that says nothing about the tickets' fate, so the
// exact request must stay reserved for an identical retry.
func (e *remoteError) transient() bool {
	return e.Status == 408 || e.Status == 429 || e.Status >= 500
}

// parseRemoteError reads auth/ticket_auth.py's _build_ticket_error, which FastAPI
// nests under "detail". The failed ticket is failed_ticket.index; without one the
// org did not say which ticket, and -1 records that.
func parseRemoteError(status int, data []byte) *remoteError {
	remote := &remoteError{Status: status, FailedIndex: -1}
	type fields struct {
		Code             string `json:"error_code"`
		InvalidatedKeyID string `json:"invalidated_key_id"`
		FailedTicket     *struct {
			Index  *int   `json:"index"`
			Reason string `json:"reason"`
		} `json:"failed_ticket"`
	}
	var envelope struct {
		fields
		Detail json.RawMessage `json:"detail"`
	}
	_ = json.Unmarshal(data, &envelope)
	selected := envelope.fields
	var detail fields
	if json.Unmarshal(envelope.Detail, &detail) == nil && detail.Code != "" {
		selected = detail
	}
	remote.Code = selected.Code
	remote.InvalidatedKeyID = selected.InvalidatedKeyID
	if selected.FailedTicket != nil {
		remote.FailedReason = selected.FailedTicket.Reason
		if selected.FailedTicket.Index != nil && *selected.FailedTicket.Index >= 0 {
			remote.FailedIndex = *selected.FailedTicket.Index
		}
	}
	return remote
}

// heldByOther means another request holds one ticket provisionally. The org has
// already released the rest of this request and decided nothing about that one.
func (e *remoteError) heldByOther() bool {
	return e.Code == "TICKET_REQUEST_IN_PROGRESS" && e.FailedReason == "held_by_other_request" && e.FailedIndex >= 0
}

func (s *TicketSource) request(ctx context.Context, method, endpoint, authorization string, out any) error {
	return s.send(ctx, method, endpoint, authorization, "", out)
}

func (s *TicketSource) send(ctx context.Context, method, endpoint, authorization, nonce string, out any) error {
	var last error
	for attempt := 0; attempt < 3; attempt++ {
		if err := ctx.Err(); err != nil {
			return err
		}
		attemptCtx, cancel := context.WithTimeout(ctx, 45*time.Second)
		request, err := http.NewRequestWithContext(attemptCtx, method, endpoint, nil)
		if err != nil {
			cancel()
			return errors.New("cannot construct OA request")
		}
		request.Header.Set("User-Agent", userAgent)
		request.Header.Set("Accept", "application/json")
		if authorization != "" {
			request.Header.Set("Authorization", authorization)
		}
		if nonce != "" {
			request.Header.Set(redemptionNonceHeader, nonce)
		}
		response, err := s.client.Do(request)
		if err != nil {
			cancel()
			// URL and transport errors may include relay secrets or tickets.
			last = errors.New("OA request failed; check connectivity")
		} else {
			data, readErr := io.ReadAll(io.LimitReader(response.Body, maxOrgResponse+1))
			response.Body.Close()
			cancel()
			switch {
			case readErr != nil:
				last = errors.New("OA response was interrupted")
			case len(data) > maxOrgResponse:
				return errors.New("OA response exceeds its maximum size")
			case response.StatusCode >= 200 && response.StatusCode < 300:
				if err := json.Unmarshal(data, out); err != nil {
					return errors.New("OA service returned invalid JSON")
				}
				return nil
			default:
				remote := parseRemoteError(response.StatusCode, data)
				if !remote.transient() || remote.heldByOther() {
					return remote
				}
				last = remote
			}
		}
		if attempt < 2 {
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(time.Duration(attempt+1) * 200 * time.Millisecond):
			}
		}
	}
	return last
}

// prices reads live model pricing. Unknown models have no price, so a heuristic
// can never authorize spending.
func (s *TicketSource) prices(ctx context.Context) (map[string]int, error) {
	var prices map[string]int
	if err := s.request(ctx, http.MethodGet, s.cfg.OrgURL+"/chat/model-tickets", "", &prices); err != nil {
		return nil, err
	}
	if len(prices) == 0 {
		return nil, errors.New("live model pricing is unavailable")
	}
	for id, cost := range prices {
		if strings.TrimSpace(id) == "" || cost < 1 || cost > 100 {
			return nil, errors.New("invalid live model pricing")
		}
	}
	var availability struct {
		Disabled []string `json:"disabled_models"`
	}
	if err := s.request(ctx, http.MethodGet, s.cfg.OrgURL+"/chat/pinned-models", "", &availability); err != nil {
		return nil, err
	}
	for _, id := range availability.Disabled {
		delete(prices, id)
	}
	return prices, nil
}

// Models lists only explicitly priced, enabled models, in the OpenAI envelope.
// Each carries its ticket cost so a client can show it.
func (s *TicketSource) Models(ctx context.Context) (json.RawMessage, error) {
	prices, err := s.prices(ctx)
	if err != nil {
		return nil, err
	}
	ids := make([]string, 0, len(prices))
	for id := range prices {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	models := make([]map[string]any, 0, len(ids))
	for _, id := range ids {
		provider, _, _ := strings.Cut(id, "/")
		models = append(models, map[string]any{"id": id, "object": "model", "created": 0, "owned_by": provider, "oa_ticket_cost": prices[id]})
	}
	return json.Marshal(map[string]any{"object": "list", "data": models})
}

func (s *TicketSource) issuerKey(ctx context.Context) (wallet.IssuerKey, error) {
	s.issuerMu.Lock()
	defer s.issuerMu.Unlock()
	if s.issuer.Public != nil && s.now().Sub(s.issuerFetched) < issuerCacheFor {
		return s.issuer, nil
	}
	var public struct {
		PublicKey string `json:"public_key"`
		KeyID     string `json:"key_id"`
	}
	if err := s.request(ctx, http.MethodGet, s.cfg.OrgURL+"/api/ticket/issue/public-key", "", &public); err != nil {
		return wallet.IssuerKey{}, err
	}
	key, err := wallet.ParseIssuerKey(public.PublicKey, public.KeyID)
	if err != nil {
		return wallet.IssuerKey{}, err
	}
	s.issuer, s.issuerFetched = key, s.now()
	return key, nil
}

// orgVerifyKey fetches the org's public Ed25519 response-signing key once per
// process. A fetched key is always enforced. If the org publishes none, signature
// checking rests on the verifier and an outage cannot activate the key.
func (s *TicketSource) orgVerifyKey(ctx context.Context) ed25519.PublicKey {
	s.orgKeyMu.Lock()
	defer s.orgKeyMu.Unlock()
	if s.orgKey != nil {
		return s.orgKey
	}
	var response struct {
		PublicKey string `json:"public_key"`
		Algorithm string `json:"algorithm"`
	}
	if err := s.request(ctx, http.MethodGet, s.cfg.OrgURL+"/api/public_key", "", &response); err != nil {
		return nil
	}
	raw, err := hex.DecodeString(response.PublicKey)
	if err != nil || len(raw) != ed25519.PublicKeySize || (response.Algorithm != "" && response.Algorithm != "Ed25519") {
		return nil
	}
	s.orgKey = raw
	return s.orgKey
}

// keyResponse is the org's signed /api/request_key answer.
type keyResponse struct {
	Key              string  `json:"key"`
	StationID        string  `json:"station_id"`
	StationSignature string  `json:"station_signature"`
	OrgSignature     string  `json:"org_signature"`
	ExpiresAt        int64   `json:"expires_at_unix"`
	RecentlyAttested bool    `json:"station_recently_attested"`
	TicketsConsumed  int     `json:"tickets_consumed"`
	CreditLimit      float64 `json:"credit_limit"`
	DurationMinutes  int     `json:"duration_minutes"`
}

// insufficient is the one safe message for a shortage. No purchase ever happens.
func insufficient(need, have, heldElsewhere int) error {
	message := fmt.Sprintf("This model costs %d tickets and %d are available here. Add tickets in OA; they reach this computer on its next sync. Nothing is ever purchased automatically.", need, have)
	if heldElsewhere > 0 {
		message += fmt.Sprintf(" %d more are reserved by another of your clients.", heldElsewhere)
	}
	return &SafeError{Status: http.StatusPaymentRequired, Code: "insufficient_tickets", Message: message}
}

// SafeError carries a message written for local clients across the source.
type SafeError struct {
	Status  int
	Code    string
	Message string
}

func (e *SafeError) Error() string { return e.Message }

// randomNonce is anonymous: 256 random bits, unrelated to the account or wallet.
func randomNonce() (string, error) {
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		return "", errors.New("cannot generate redemption nonce")
	}
	return base64.RawURLEncoding.EncodeToString(raw), nil
}

func randomID() (string, error) {
	raw := make([]byte, 16)
	if _, err := rand.Read(raw); err != nil {
		return "", errors.New("cannot generate reservation ID")
	}
	return hex.EncodeToString(raw), nil
}

// Acquire returns a verified credential for a model. Fresh skips and bypasses
// the reuse cache, for requests that must not share a key.
func (s *TicketSource) Acquire(ctx context.Context, model string, fresh bool) (Credential, error) {
	reuse := s.cfg.KeyReuseWindow > 0 && !fresh
	if reuse {
		select {
		case s.acquireGate <- struct{}{}:
			defer func() { <-s.acquireGate }()
		case <-ctx.Done():
			return Credential{}, ctx.Err()
		}
	}
	if s.cfg.Authorized != nil {
		if err := s.cfg.Authorized(ctx); err != nil {
			return Credential{}, &SafeError{Status: http.StatusUnauthorized, Code: "authorization_required", Message: "This computer is not authorized for an OA account. Run oa-clientd login."}
		}
	}
	if err := s.checkBinding(ctx); err != nil {
		return Credential{}, err
	}
	prices, err := s.prices(ctx)
	if err != nil {
		return Credential{}, err
	}
	baseModel := strings.TrimSuffix(model, ":online")
	cost, ok := prices[baseModel]
	if !ok {
		return Credential{}, &SafeError{Status: http.StatusBadRequest, Code: "model_not_available", Message: "This model has no current OA ticket price. Select a model from /v1/models."}
	}
	if err := ctx.Err(); err != nil {
		return Credential{}, err
	}
	if reuse {
		s.cacheMu.Lock()
		cached := s.cached[cost]
		_, banned := s.banned.Load(cached.stationID)
		if cached.credential.Key != "" && s.now().Before(cached.reuseUntil) && !banned {
			s.cacheMu.Unlock()
			reused := cached.credential
			reused.Reused = true
			return reused, nil
		}
		delete(s.cached, cost)
		s.cacheMu.Unlock()
	}
	issuer, err := s.issuerKey(ctx)
	if err != nil {
		return Credential{}, err
	}
	response, err := s.redeem(ctx, cost, issuer)
	if err != nil {
		return Credential{}, err
	}
	return s.activate(ctx, response, cost, reuse)
}

// eligible reports whether this client may select a ticket now: valid for the
// current issuer, and not resting after another client's live request held it.
func (s *TicketSource) eligible(issuer wallet.IssuerKey) func(wallet.Ticket) bool {
	now := s.now()
	return func(t wallet.Ticket) bool {
		s.selectMu.Lock()
		defer s.selectMu.Unlock()
		if s.verifiedFor != issuer.KeyID {
			s.verified, s.verifiedFor = map[string]bool{}, issuer.KeyID
		}
		if until, ok := s.heldElsewhere[t.Token]; ok {
			if now.Before(until) {
				return false
			}
			delete(s.heldElsewhere, t.Token)
		}
		ok, seen := s.verified[t.Token]
		if !seen {
			ok = wallet.VerifyToken(t.Token, issuer) == nil
			s.verified[t.Token] = ok
		}
		return ok
	}
}

func (s *TicketSource) rest(token string, d time.Duration) {
	s.selectMu.Lock()
	defer s.selectMu.Unlock()
	s.heldElsewhere[token] = s.now().Add(d)
}

// parked reports a reservation the org keeps refusing, while it waits to be tried
// again. It stays reserved with its nonce and is never spent by this client alone.
func (s *TicketSource) parked(id string) bool {
	s.selectMu.Lock()
	defer s.selectMu.Unlock()
	return s.resumeFailures[id] >= parkAfterFailures && s.now().Before(s.resumeAfter[id])
}

func (s *TicketSource) recordRefusal(id string) (failures int) {
	s.selectMu.Lock()
	defer s.selectMu.Unlock()
	s.resumeFailures[id]++
	if s.resumeFailures[id] >= parkAfterFailures {
		s.resumeAfter[id] = s.now().Add(parkFor)
	}
	return s.resumeFailures[id]
}

func errHeldElsewhere() error {
	return &SafeError{Status: http.StatusServiceUnavailable, Code: "tickets_in_use", Message: "Another of your clients is using these tickets right now. None were lost; retry shortly."}
}

func errBindingMismatch() error {
	return &SafeError{Status: http.StatusConflict, Code: "account_mismatch", Message: "This profile's wallet and its authorized account do not match, so nothing was spent. Run oa-clientd status and oa-clientd logout."}
}

// bindingMatches compares a wallet to the session and this source's org.
func (s *TicketSource) bindingMatches(state *wallet.State) error {
	if s.cfg.Account == nil {
		return nil
	}
	account, err := s.cfg.Account()
	if err != nil {
		return errBindingMismatch()
	}
	if state.AccountID != account || state.OrgURL != s.cfg.OrgURL {
		return errBindingMismatch()
	}
	return nil
}

func (s *TicketSource) checkBinding(ctx context.Context) error {
	if s.cfg.Account == nil {
		return nil
	}
	err := s.cfg.Store.View(ctx, s.bindingMatches)
	if errors.Is(err, wallet.ErrNoWallet) {
		return &SafeError{Status: http.StatusServiceUnavailable, Code: "wallet_not_ready", Message: "The ticket wallet has not synced yet. Run oa-clientd setup or wait for the first sync."}
	}
	return err
}

// redeem reserves tickets durably, then asks the org for a key. A failure with
// an unknown outcome keeps the exact reservation and its nonce: the next request
// at this cost resumes it instead of spending new tickets, and the org replays
// its response to that nonce alone.
func (s *TicketSource) redeem(ctx context.Context, cost int, issuer wallet.IssuerKey) (*keyResponse, error) {
	var lastCollision error
	for attempt := 0; attempt < maxSpendAttempts; attempt++ {
		id, err := randomID()
		if err != nil {
			return nil, err
		}
		nonce, err := randomNonce()
		if err != nil {
			return nil, err
		}
		var reservation *wallet.Reservation
		eligible := s.eligible(issuer)
		err = s.cfg.Store.Update(ctx, func(state *wallet.State) error {
			if err := s.bindingMatches(state); err != nil {
				return err
			}
			parked := 0
			for _, pending := range state.Pending {
				if pending.Cost != cost {
					continue
				}
				if s.parked(pending.ID) {
					parked++
					continue
				}
				if s.claim(pending.ID) {
					reservation = pending
					return nil
				}
			}
			// An outage must not reserve the whole wallet, one request at a time.
			if parked >= maxParkedPerCost {
				return errTooManyParked
			}
			var err error
			if reservation, err = state.Reserve(id, nonce, cost, eligible, s.now()); err == nil {
				s.claim(reservation.ID)
			}
			return err
		})
		if err != nil {
			var short *wallet.InsufficientError
			if errors.As(err, &short) {
				var held *SafeError
				if errors.As(lastCollision, &held) && held.Code == "tickets_in_use" {
					return nil, lastCollision
				}
				return nil, insufficient(short.Need, short.Have, short.HeldElsewhere)
			}
			if errors.Is(err, errTooManyParked) {
				return nil, keepReserved()
			}
			var safe *SafeError
			if errors.As(err, &safe) {
				return nil, err
			}
			if errors.Is(err, wallet.ErrNoWallet) {
				return nil, &SafeError{Status: http.StatusServiceUnavailable, Code: "wallet_not_ready", Message: "The ticket wallet has not synced yet. Run oa-clientd setup or wait for the first sync."}
			}
			return nil, err
		}
		var response keyResponse
		err = s.send(ctx, http.MethodPost, s.cfg.OrgURL+redemptionPath, ticketHeader(reservation), reservation.Nonce, &response)
		// Only after the wallet records the outcome: another request must not
		// resume this reservation between the org's answer and that commit.
		defer s.unclaim(reservation.ID)
		update := func(apply func(*wallet.State)) error {
			return s.cfg.Store.Update(context.WithoutCancel(ctx), func(state *wallet.State) error {
				apply(state)
				return nil
			})
		}
		if err == nil {
			// The org spent them. Nothing later can restore them, including a
			// malformed response or a verifier refusal.
			if commitErr := update(func(state *wallet.State) { state.CommitSpent(reservation.ID, s.now()) }); commitErr != nil {
				return nil, commitErr
			}
			return &response, nil
		}
		var remote *remoteError
		if !errors.As(err, &remote) {
			return nil, keepReserved()
		}
		switch {
		case remote.Status == http.StatusNotFound || remote.Status == http.StatusMethodNotAllowed:
			// The org has no fenced route, so it read nothing and spent nothing.
			if commitErr := update(func(state *wallet.State) { state.RestorePending(reservation.ID) }); commitErr != nil {
				return nil, commitErr
			}
			return nil, &SafeError{Status: http.StatusBadGateway, Code: "org_unsupported", Message: "This OA deployment does not support oa-clientd redemption yet. No tickets were spent and nothing was sent to the provider."}
		case remote.heldByOther():
			// The org released this request, so these tickets go back untouched.
			// A later request tries them again with a new nonce.
			if remote.FailedIndex < len(reservation.Tickets) {
				s.rest(reservation.Tickets[remote.FailedIndex].Token, heldRestFor)
			}
			if commitErr := update(func(state *wallet.State) { state.RestorePending(reservation.ID) }); commitErr != nil {
				return nil, commitErr
			}
			lastCollision = errHeldElsewhere()
			continue
		case remote.transient():
			// Outcome unknown, or the org asked for a retry. Keep the reservation.
			// If retrying it keeps failing while the org answers, serve this request
			// from other tickets, and try this reservation again later.
			if s.recordRefusal(reservation.ID) >= parkAfterFailures {
				lastCollision = keepReserved()
				continue
			}
			return nil, keepReserved()
		case remote.Code == "TICKET_ALREADY_SPENT":
			if commitErr := update(func(state *wallet.State) { state.RejectAlreadySpent(reservation.ID, remote.FailedIndex, s.now()) }); commitErr != nil {
				return nil, commitErr
			}
			lastCollision = &SafeError{Status: http.StatusConflict, Code: "tickets_already_spent", Message: "Tickets were spent by another client. Sync again and retry."}
			continue
		case remote.Code == "TICKET_KEY_INVALIDATED":
			if commitErr := update(func(state *wallet.State) { state.RejectInvalidated(reservation.ID, remote.InvalidatedKeyID) }); commitErr != nil {
				return nil, commitErr
			}
			s.issuerMu.Lock()
			s.issuer = wallet.IssuerKey{}
			s.issuerMu.Unlock()
			issuer, err = s.issuerKey(ctx)
			if err != nil {
				return nil, err
			}
			lastCollision = &SafeError{Status: http.StatusConflict, Code: "ticket_generation_rotated", Message: "OA rotated its ticket signing key. Tickets from the old generation are no longer usable."}
			continue
		}
		// Any other definitive refusal spent nothing. A ticket the org named rests,
		// so one it will never accept cannot fail every request at this price.
		if remote.FailedIndex >= 0 && remote.FailedIndex < len(reservation.Tickets) {
			s.rest(reservation.Tickets[remote.FailedIndex].Token, refusedRestFor)
		}
		if commitErr := update(func(state *wallet.State) { state.RestorePending(reservation.ID) }); commitErr != nil {
			return nil, commitErr
		}
		return nil, &SafeError{Status: http.StatusBadGateway, Code: "key_request_refused", Message: "OA refused the key request. No tickets were spent."}
	}
	return nil, lastCollision
}

var errTooManyParked = errors.New("too many parked reservations")

func keepReserved() error {
	return &SafeError{Status: http.StatusBadGateway, Code: "key_request_interrupted", Message: "The key request did not finish. Its tickets stay reserved and the next request resumes it without spending new ones."}
}

// Exact-string message the org signs in marketplace/signing/org_signer.py.
func orgSignatureMessage(r *keyResponse) []byte {
	return []byte(r.StationID + "|" + r.Key + "|" + strconv.FormatInt(r.ExpiresAt, 10) + "|" + r.StationSignature)
}

func spentError(message string) error {
	return &SafeError{Status: http.StatusBadGateway, Code: "key_rejected", Message: message + " The tickets stay spent, and nothing was sent to the provider."}
}

// activate checks the key's constraints and signatures, then asks the verifier.
// Tickets are already spent, so a refusal discards the key and restores nothing.
func (s *TicketSource) activate(ctx context.Context, response *keyResponse, cost int, reuse bool) (Credential, error) {
	now := s.now()
	if response.Key == "" || len(response.Key) > maxKeyLength || strings.ContainsAny(response.Key, "\r\n ") ||
		response.StationID == "" || response.StationSignature == "" || response.OrgSignature == "" || response.ExpiresAt <= now.Unix() {
		return Credential{}, spentError("OA returned an invalid or expired key.")
	}
	if response.TicketsConsumed != 0 && response.TicketsConsumed != cost {
		return Credential{}, spentError("OA charged a different number of tickets than this model costs.")
	}
	if response.CreditLimit < 0 {
		return Credential{}, spentError("OA returned a key with an invalid spending cap.")
	}
	if response.DurationMinutes > 0 &&
		time.Unix(response.ExpiresAt, 0).After(now.Add(time.Duration(response.DurationMinutes)*time.Minute+5*time.Minute)) {
		return Credential{}, spentError("OA returned a key that outlives its tier.")
	}
	if _, banned := s.banned.Load(response.StationID); banned {
		return Credential{}, spentError("The station is banned.")
	}
	orgKey := s.orgVerifyKey(ctx)
	if orgKey != nil {
		signature, err := hex.DecodeString(response.OrgSignature)
		if err != nil || len(signature) != ed25519.SignatureSize || !ed25519.Verify(orgKey, orgSignatureMessage(response), signature) {
			return Credential{}, spentError("The org signature on the key is invalid.")
		}
	}
	body, err := json.Marshal(map[string]any{
		"station_id":        response.StationID,
		"api_key":           response.Key,
		"key_valid_till":    response.ExpiresAt,
		"station_signature": response.StationSignature,
		"org_signature":     response.OrgSignature,
	})
	if err != nil {
		return Credential{}, errors.New("cannot encode verifier request")
	}
	status, detail, err := s.verifyKey(ctx, body, response.StationID, response.Key, response.RecentlyAttested)
	if err != nil {
		if ctx.Err() != nil {
			return Credential{}, ctx.Err()
		}
		return Credential{}, spentError("The verifier did not approve this key.")
	}
	if status != "verified" && orgKey == nil {
		// An outage key has no independent check of any signature.
		return Credential{}, spentError("The verifier is unavailable and the org signature could not be checked.")
	}
	if err := ctx.Err(); err != nil {
		return Credential{}, err
	}
	acquired := s.now()
	if response.ExpiresAt <= acquired.Unix() {
		return Credential{}, spentError("The key expired during verification.")
	}
	if _, banned := s.banned.Load(response.StationID); banned {
		return Credential{}, spentError("The station is banned.")
	}
	credential := Credential{Key: response.Key, ExpiresAt: time.Unix(response.ExpiresAt, 0), VerificationStatus: status, VerificationDetail: detail, CreditLimit: response.CreditLimit}
	if reuse {
		until := acquired.Add(s.cfg.KeyReuseWindow)
		if beforeExpiry := credential.ExpiresAt.Add(-time.Second); beforeExpiry.Before(until) {
			until = beforeExpiry
		}
		if until.After(acquired) {
			s.cacheMu.Lock()
			s.cached[cost] = cachedCredential{credential: credential, stationID: response.StationID, reuseUntil: until}
			s.cacheMu.Unlock()
		}
	}
	return credential, nil
}

// Invalidate stops later requests reusing a key after a provider failure.
func (s *TicketSource) Invalidate(key string) {
	s.cacheMu.Lock()
	defer s.cacheMu.Unlock()
	for cost, cached := range s.cached {
		if cached.credential.Key == key {
			delete(s.cached, cost)
		}
	}
}

// ticketHeader sends the stored token strings unchanged, so a retry is the exact
// request the org replays.
func ticketHeader(reservation *wallet.Reservation) string {
	tokens := make([]string, 0, len(reservation.Tickets))
	for _, t := range reservation.Tickets {
		tokens = append(tokens, t.Token)
	}
	if len(tokens) > 1 {
		return "InferenceTicket tokens=" + strings.Join(tokens, ",")
	}
	return "InferenceTicket token=" + tokens[0]
}

// bytesReader keeps verifier bodies replayable within one attempt.
func bytesReader(data []byte) io.Reader { return bytes.NewReader(data) }
