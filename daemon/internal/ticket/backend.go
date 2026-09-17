// Package ticket implements OA's identity-free invitation and verified ephemeral
// key protocol. Inference content never enters this package or an OA org call.
package ticket

import (
	"bytes"
	"context"
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
	"time"
)

type Config struct {
	OrgURL      string
	VerifierURL string
	WalletPath  string
	Client      *http.Client
}

type Backend struct {
	cfg    Config
	client *http.Client
}

type Credential struct {
	Key       string
	ExpiresAt time.Time
}

func New(cfg Config) (*Backend, error) {
	for _, endpoint := range []string{cfg.OrgURL, cfg.VerifierURL} {
		u, err := url.Parse(endpoint)
		if err != nil || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || strings.Trim(u.Path, "/") != "" {
			return nil, errors.New("ticket endpoints must be exact HTTP(S) origins")
		}
		local := u.Hostname() == "127.0.0.1" || u.Hostname() == "localhost" || u.Hostname() == "::1"
		if u.Scheme != "https" && !(u.Scheme == "http" && local) {
			return nil, errors.New("ticket endpoints require HTTPS (HTTP only for loopback tests)")
		}
	}
	if cfg.WalletPath == "" || cfg.Client == nil {
		return nil, errors.New("ticket wallet path and anonymous HTTP client are required")
	}
	cfg.OrgURL = strings.TrimRight(cfg.OrgURL, "/")
	cfg.VerifierURL = strings.TrimRight(cfg.VerifierURL, "/")
	client := *cfg.Client
	// Even a caller's accidentally supplied cookie jar or redirect handler must
	// never attach account identity or leak a ticket/key to another destination.
	client.Jar = nil
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	return &Backend{cfg: cfg, client: &client}, nil
}

type remoteError struct {
	Status           int
	Code             string
	InvalidatedKeyID string
}

func (e *remoteError) Error() string {
	switch e.Code {
	case "TICKET_KEY_INVALIDATED":
		return "ticket signing key rotated; old-generation tickets were invalidated"
	case "TICKET_KEY_CHANGED":
		return "ticket signing key changed; invitation was not consumed; retry the code"
	case "TICKET_ALREADY_SPENT":
		return "one or more inference tickets were already spent"
	}
	return fmt.Sprintf("OA service returned HTTP %d", e.Status)
}

func (b *Backend) request(ctx context.Context, method, endpoint string, body []byte, auth string, out any) error {
	var last error
	for attempt := 0; attempt < 3; attempt++ {
		if err := ctx.Err(); err != nil {
			return err
		}
		attemptCtx, cancel := context.WithTimeout(ctx, 45*time.Second)
		req, err := http.NewRequestWithContext(attemptCtx, method, endpoint, bytes.NewReader(body))
		if err != nil {
			cancel()
			return errors.New("cannot construct OA request")
		}
		req.Header.Set("User-Agent", "OA-Chat/1")
		req.Header.Set("Accept", "application/json")
		if len(body) > 0 {
			req.Header.Set("Content-Type", "application/json")
		}
		if auth != "" {
			req.Header.Set("Authorization", auth)
		}
		res, err := b.client.Do(req)
		if err != nil {
			cancel()
			// URL/transport errors may include relay secrets or remote input.
			last = errors.New("OA request failed; check relay connectivity")
		} else {
			data, readErr := io.ReadAll(io.LimitReader(res.Body, 64<<20+1))
			res.Body.Close()
			cancel()
			if readErr != nil {
				last = errors.New("OA response interrupted")
			} else if len(data) > 64<<20 {
				return errors.New("OA response exceeds maximum size")
			} else if res.StatusCode >= 200 && res.StatusCode < 300 {
				if err := json.Unmarshal(data, out); err != nil {
					return errors.New("OA service returned invalid JSON")
				}
				return nil
			} else {
				var envelope struct {
					Code             string          `json:"error_code"`
					InvalidatedKeyID string          `json:"invalidated_key_id"`
					Detail           json.RawMessage `json:"detail"`
				}
				_ = json.Unmarshal(data, &envelope)
				var detail struct {
					Code             string `json:"error_code"`
					InvalidatedKeyID string `json:"invalidated_key_id"`
				}
				if json.Unmarshal(envelope.Detail, &detail) == nil && detail.Code != "" {
					envelope.Code = detail.Code
					envelope.InvalidatedKeyID = detail.InvalidatedKeyID
				}
				last = &remoteError{Status: res.StatusCode, Code: envelope.Code, InvalidatedKeyID: envelope.InvalidatedKeyID}
				if res.StatusCode != 429 && res.StatusCode < 500 {
					return last
				}
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

func (b *Backend) prices(ctx context.Context) (map[string]int, error) {
	var prices map[string]int
	if err := b.request(ctx, "GET", b.cfg.OrgURL+"/chat/model-tickets", nil, "", &prices); err != nil {
		return nil, err
	}
	if len(prices) == 0 {
		return nil, errors.New("live model pricing is unavailable")
	}
	for id, n := range prices {
		if strings.TrimSpace(id) == "" || n < 1 || n > 100 {
			return nil, errors.New("invalid live model pricing")
		}
	}
	return prices, nil
}

// Models exposes only explicitly priced models. Unknown models fail before any
// tickets are selected; heuristic prices cannot authorize spending.
func (b *Backend) Models(ctx context.Context) (json.RawMessage, error) {
	prices, err := b.prices(ctx)
	if err != nil {
		return nil, err
	}
	var availability struct {
		Disabled []string `json:"disabled_models"`
	}
	if err := b.request(ctx, "GET", b.cfg.OrgURL+"/chat/pinned-models", nil, "", &availability); err != nil {
		return nil, err
	}
	for _, id := range availability.Disabled {
		delete(prices, id)
	}
	ids := make([]string, 0, len(prices))
	for id := range prices {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	models := make([]map[string]any, 0, len(ids))
	for _, id := range ids {
		provider, _, _ := strings.Cut(id, "/")
		models = append(models, map[string]any{"id": id, "object": "model", "created": 0, "owned_by": provider})
	}
	data, err := json.Marshal(map[string]any{"object": "list", "data": models})
	return data, err
}

func (b *Backend) Acquire(ctx context.Context, model string) (Credential, error) {
	prices, err := b.prices(ctx)
	if err != nil {
		return Credential{}, err
	}
	baseModel := strings.TrimSuffix(model, ":online")
	cost, ok := prices[baseModel]
	if !ok {
		return Credential{}, errors.New("requested model has no live OA ticket price")
	}
	var availability struct {
		Disabled []string `json:"disabled_models"`
	}
	if err = b.request(ctx, "GET", b.cfg.OrgURL+"/chat/pinned-models", nil, "", &availability); err != nil {
		return Credential{}, err
	}
	for _, id := range availability.Disabled {
		if id == baseModel {
			return Credential{}, errors.New("requested model is disabled by OA")
		}
	}
	var key struct {
		Key              string `json:"key"`
		StationID        string `json:"station_id"`
		StationSignature string `json:"station_signature"`
		OrgSignature     string `json:"org_signature"`
		ExpiresAt        int64  `json:"expires_at_unix"`
	}
	err = b.withWallet(ctx, func(w *wallet) error {
		if w.Pending != nil && (w.Pending.Model != baseModel || len(w.Pending.Tickets) != cost) {
			return errors.New("an interrupted key request is reserved for another model; retry that model before requesting a different one")
		}
		if w.Pending == nil {
			if len(w.Active) < cost {
				return fmt.Errorf("insufficient inference tickets: need %d, have %d", cost, len(w.Active))
			}
			w.Pending = &reservation{Model: baseModel, Tickets: append([]record{}, w.Active[:cost]...)}
			w.Active = w.Active[cost:]
			for _, t := range w.Pending.Tickets {
				w.Spent[digest([]byte(t.Token))] = true
			}
			// Commit the reservation BEFORE sending any spend. A crash can never
			// resurrect these tokens or let a parallel importer spend them again.
			if err := b.saveWallet(w); err != nil {
				return err
			}
		}
		tokens := make([]string, 0, cost)
		for _, t := range w.Pending.Tickets {
			tokens = append(tokens, t.Token)
		}
		auth := "InferenceTicket token="
		if len(tokens) > 1 {
			auth = "InferenceTicket tokens="
		}
		err := b.request(ctx, "POST", b.cfg.OrgURL+"/api/request_key", nil, auth+strings.Join(tokens, ","), &key)
		if err != nil {
			var remote *remoteError
			if errors.As(err, &remote) && remote.Status != 429 && remote.Status < 500 {
				if remote.Code == "TICKET_KEY_INVALIDATED" {
					idBytes, idErr := hex.DecodeString(remote.InvalidatedKeyID)
					if idErr == nil && len(idBytes) == 32 {
						id := strings.ToLower(remote.InvalidatedKeyID)
						w.Invalidated[id] = true
						kept := w.Active[:0]
						for _, t := range w.Active {
							if t.KeyID != id {
								kept = append(kept, t)
							}
						}
						w.Active = kept
					}
				}
				w.Pending = nil
				if saveErr := b.saveWallet(w); saveErr != nil {
					return saveErr
				}
			}
			return err
		}
		// Remote spending has committed. Neither verification failure nor a
		// malformed success may restore tickets or reuse this provisional key.
		w.Pending = nil
		return b.saveWallet(w)
	})
	if err != nil {
		return Credential{}, err
	}
	if key.Key == "" || strings.ContainsAny(key.Key, "\r\n") || key.StationID == "" || key.StationSignature == "" || key.OrgSignature == "" || key.ExpiresAt <= time.Now().Unix() {
		return Credential{}, errors.New("OA returned an invalid or expired provisional key; tickets remain spent")
	}
	body, _ := json.Marshal(map[string]any{"station_id": key.StationID, "api_key": key.Key, "key_valid_till": key.ExpiresAt, "station_signature": key.StationSignature, "org_signature": key.OrgSignature})
	var proof struct {
		Status    string `json:"status"`
		StationID string `json:"station_id"`
		KeyHash   string `json:"key_hash"`
	}
	if err := b.request(ctx, "POST", b.cfg.VerifierURL+"/submit_key", body, "", &proof); err != nil {
		return Credential{}, fmt.Errorf("key verification failed; tickets remain spent: %w", err)
	}
	if proof.Status != "verified" || proof.StationID != key.StationID || !verifierKeyHashMatches(proof.KeyHash, key.Key) {
		return Credential{}, errors.New("verifier did not approve this exact station and key; tickets remain spent")
	}
	if key.ExpiresAt <= time.Now().Unix() {
		return Credential{}, errors.New("ephemeral key expired during verification")
	}
	return Credential{Key: key.Key, ExpiresAt: time.Unix(key.ExpiresAt, 0)}, nil
}

// verifierKeyHashMatches checks the identifier in this key's /submit_key
// response. oa-verifier validates signatures and ownership using the raw key
// and its full SHA-256, then returns the first eight digest bytes, as consumed
// by OA Chat's StationVerifier._hashKey. Also accept a full SHA-256 response,
// but never arbitrary prefix lengths or a full hash with a mismatched suffix.
// The short identifier is only a consistency check on the authenticated POST
// response; it must not be used as independent or cached verification proof.
func verifierKeyHashMatches(reported, key string) bool {
	if key == "" {
		return false
	}
	full := digest([]byte(key))
	return reported == full || reported == full[:16]
}

// RedeemCode resumes an interrupted issuance with its identical blinded batch.
// The invitation credential and blinding tape are removed atomically when the
// finalized wallet entries are published.
func (b *Backend) RedeemCode(ctx context.Context, code string) (int, error) {
	code = strings.TrimSpace(code)
	if strings.HasPrefix(code, "https://") || strings.HasPrefix(code, "http://") {
		u, err := url.Parse(code)
		if err != nil {
			return 0, errors.New("invalid ticket share URL")
		}
		code = u.Query().Get("tickets")
	}
	if len(code) != 24 {
		return 0, errors.New("ticket code must contain exactly 24 characters")
	}
	count, err := strconv.ParseUint(code[20:], 16, 16)
	if err != nil || count == 0 {
		return 0, errors.New("ticket code has an invalid count")
	}
	added := 0
	err = b.withWallet(ctx, func(w *wallet) error {
		if w.Issuance != nil && w.Issuance.Code != code {
			return errors.New("another invitation has an interrupted issuance; retry that code first")
		}
		if w.Issuance == nil {
			var public struct {
				PublicKey string `json:"public_key"`
				KeyID     string `json:"key_id"`
				CanIssue  *bool  `json:"can_issue"`
			}
			if err := b.request(ctx, "GET", b.cfg.OrgURL+"/api/ticket/issue/public-key", nil, "", &public); err != nil {
				return err
			}
			if public.CanIssue != nil && !*public.CanIssue {
				return errors.New("OA ticket issuance is temporarily unavailable")
			}
			key, der, err := parsePublicKey(public.PublicKey)
			if err != nil {
				return err
			}
			keyID := digest(der)
			if public.KeyID != "" && public.KeyID != keyID {
				return errors.New("issuer public key metadata mismatch")
			}
			pending := &issuance{Code: code, PublicKey: public.PublicKey, KeyID: keyID, States: make([]blindState, 0, int(count))}
			for i := 0; i < int(count); i++ {
				if err := ctx.Err(); err != nil {
					return err
				}
				state, err := newBlindState(key, der)
				if err != nil {
					return err
				}
				pending.States = append(pending.States, state)
			}
			w.Issuance = pending
			if err := b.saveWallet(w); err != nil {
				return err
			}
		}
		pending := w.Issuance
		indexed := make([][2]any, len(pending.States))
		for i, state := range pending.States {
			indexed[i] = [2]any{i, state.Request}
		}
		body, _ := json.Marshal(map[string]any{"credential": pending.Code, "blinded_requests": indexed, "expected_key_id": pending.KeyID})
		var signed struct {
			KeyID     string               `json:"key_id"`
			Responses [][2]json.RawMessage `json:"signed_responses"`
		}
		if err := b.request(ctx, "POST", b.cfg.OrgURL+"/api/alpha-register", body, "", &signed); err != nil {
			var remote *remoteError
			// A definitive bad/expired credential must not lock the wallet to a
			// mistyped code forever. Retain recovery for transient or conflicting
			// operations, where the issuer may already have committed the batch.
			if errors.As(err, &remote) && (remote.Code == "TICKET_KEY_CHANGED" || remote.Status == 400 || remote.Status == 401 || remote.Status == 403 || remote.Status == 404 || remote.Status == 410 || remote.Status == 422) {
				w.Issuance = nil
				if saveErr := b.saveWallet(w); saveErr != nil {
					return saveErr
				}
			}
			return err
		}
		if signed.KeyID != "" && signed.KeyID != pending.KeyID {
			return errors.New("issuer changed signing key during issuance")
		}
		if len(signed.Responses) != len(pending.States) {
			return errors.New("issuer returned an incomplete signature batch")
		}
		responses := make(map[int]string, len(signed.Responses))
		for _, row := range signed.Responses {
			var index int
			var sig string
			if json.Unmarshal(row[0], &index) != nil || json.Unmarshal(row[1], &sig) != nil || index < 0 || index >= len(pending.States) {
				return errors.New("invalid indexed signature response")
			}
			if _, ok := responses[index]; ok {
				return errors.New("duplicate issuer signature index")
			}
			responses[index] = sig
		}
		key, _, err := parsePublicKey(pending.PublicKey)
		if err != nil {
			return err
		}
		var finalized []record
		for i, state := range pending.States {
			token, err := finalize(key, state, responses[i])
			if err != nil {
				return err
			}
			finalized = append(finalized, record{Token: token, KeyID: pending.KeyID})
		}
		for _, t := range finalized {
			if !w.Spent[digest([]byte(t.Token))] && !w.Invalidated[t.KeyID] {
				w.Active = append(w.Active, t)
				added++
			}
		}
		w.Issuance = nil
		return b.saveWallet(w)
	})
	if err != nil {
		return 0, err
	}
	return added, nil
}
