// Package account holds oa-clientd's identity-bound traffic: browser
// authorization, the SuperTokens header-mode session, and encrypted wallet
// sync. Finalized tickets and prompts have no path through this package, and its
// HTTP client refuses every route outside the narrow account surface.
package account

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/OpenAnonymity/oa-chat/oa-clientd/internal/oa/securefile"
)

const (
	sessionFile     = "session.json"
	sessionLockFile = "session.lock"
	syncLockFile    = "sync.lock"
	maxSessionBytes = 1 << 16
	maxResponse     = 64 << 20
	userAgent       = "OA-Clientd/1"
)

// Identity is the persisted account binding and its secrets. MasterKey is the
// raw 32-byte sync key, the same material a browser derives its keys from.
type Identity struct {
	AccountID   string `json:"account_id"`
	AccountKind string `json:"account_kind"`
	Label       string `json:"label,omitempty"`
	OrgURL      string `json:"org_url"`
	DeviceID    string `json:"device_id"`
	MasterKey   []byte `json:"master_key"`
	Access      string `json:"access_token"`
	Refresh     string `json:"refresh_token"`
}

// ErrSignedOut means no usable account credentials exist on this computer.
var ErrSignedOut = errors.New("this computer is not authorized for an OA account; run oa-clientd login")

// ErrRevoked means the org refused to refresh: the session was signed out or
// revoked elsewhere. Local credentials have been erased.
var ErrRevoked = errors.New("this computer's authorization ended; run oa-clientd login")

// allowedAccountPath is the whole account surface this client may touch.
func allowedAccountPath(path string) bool {
	switch path {
	case "/auth/sync", "/auth/sync/status", "/auth/session/refresh", "/auth/signout":
		return true
	}
	return strings.HasPrefix(path, "/auth/daemon/")
}

// guardedTransport refuses any request outside the account surface, so a
// programming error cannot send an account credential beside a ticket or prompt.
type guardedTransport struct {
	next   http.RoundTripper
	origin *url.URL
}

func (t guardedTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	if r.URL.Scheme != t.origin.Scheme || r.URL.Host != t.origin.Host || !allowedAccountPath(r.URL.Path) {
		return nil, errors.New("refused account request outside the account surface")
	}
	return t.next.RoundTrip(r)
}

// AccountClient clones a transport into the account-only client.
func AccountClient(base *http.Client, orgURL string) (*http.Client, error) {
	origin, err := url.Parse(orgURL)
	if err != nil || origin.Host == "" {
		return nil, errors.New("invalid org origin")
	}
	transport := base.Transport
	if transport == nil {
		transport = http.DefaultTransport
	}
	return &http.Client{
		Transport:     guardedTransport{next: transport, origin: origin},
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}, nil
}

// Session reads and rotates credentials under a process-shared lock, so the
// service and a CLI command never race a refresh-token rotation.
type Session struct {
	dir    string
	org    string
	client *http.Client
	mu     sync.Mutex
}

// NewSession uses an AccountClient.
func NewSession(dir, orgURL string, client *http.Client) *Session {
	return &Session{dir: dir, org: strings.TrimRight(orgURL, "/"), client: client}
}

func (s *Session) lockPath() string { return filepath.Join(s.dir, sessionLockFile) }
func (s *Session) path() string     { return filepath.Join(s.dir, sessionFile) }

func (s *Session) syncLockPath() string { return filepath.Join(s.dir, syncLockFile) }

func (s *Session) withLock(ctx context.Context, fn func() error) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := securefile.EnsureDir(s.dir); err != nil {
		return err
	}
	lock, err := securefile.AcquireLock(ctx, s.lockPath())
	if err != nil {
		return err
	}
	defer lock.Release()
	return fn()
}

func (s *Session) read() (*Identity, error) {
	data, err := securefile.Read(s.path(), maxSessionBytes)
	if errors.Is(err, os.ErrNotExist) {
		return nil, ErrSignedOut
	}
	if err != nil {
		return nil, err
	}
	identity := &Identity{}
	if err := json.Unmarshal(data, identity); err != nil {
		return nil, errors.New("session.json is invalid; run oa-clientd login")
	}
	if identity.OrgURL != s.org {
		return nil, errors.New("this profile's account belongs to another OA deployment; use a separate --config-dir")
	}
	if len(identity.MasterKey) != 32 || identity.AccountID == "" || identity.Refresh == "" {
		return nil, ErrSignedOut
	}
	return identity, nil
}

func (s *Session) write(identity *Identity) error {
	data, err := json.Marshal(identity)
	if err != nil {
		return errors.New("cannot encode session")
	}
	return securefile.WriteAtomic(s.path(), data)
}

// Save persists a completed authorization.
func (s *Session) Save(ctx context.Context, identity *Identity) error {
	return s.withLock(ctx, func() error { return s.write(identity) })
}

// Load returns the saved identity.
func (s *Session) Load(ctx context.Context) (*Identity, error) {
	var identity *Identity
	err := s.withLock(ctx, func() error {
		var err error
		identity, err = s.read()
		return err
	})
	return identity, err
}

// Present reports whether this computer holds usable credentials. Saves replace
// the file atomically, so it needs no lock and a slow refresh cannot delay inference.
func (s *Session) Present() error {
	_, err := s.read()
	return err
}

// AccountID is the authorized account, read as Present does.
func (s *Session) AccountID() (string, error) {
	identity, err := s.read()
	if err != nil {
		return "", err
	}
	return identity.AccountID, nil
}

// RevokeIdentity ends one session using that identity's own tokens, never what is
// in session.json, and changes no local file. Best effort, on a bounded deadline of
// its own, so it still runs when ctx has ended. An expired access token is refreshed
// once in memory, because signing out needs a live one.
func (s *Session) RevokeIdentity(ctx context.Context, identity *Identity) {
	cleanup, cancel := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
	defer cancel()
	response, _, err := s.send(cleanup, http.MethodPost, "/auth/signout", []byte("{}"), identity.Access)
	if err != nil || response.StatusCode != http.StatusUnauthorized || identity.Refresh == "" {
		return
	}
	refreshed, _, err := s.send(cleanup, http.MethodPost, "/auth/session/refresh", nil, identity.Refresh)
	if err != nil || refreshed.StatusCode < 200 || refreshed.StatusCode >= 300 {
		return
	}
	if access := refreshed.Header.Get("st-access-token"); access != "" {
		_, _, _ = s.send(cleanup, http.MethodPost, "/auth/signout", []byte("{}"), access)
	}
}

// Erase deletes every account secret on this computer.
func (s *Session) Erase(ctx context.Context) error {
	return s.withLock(ctx, func() error { return securefile.Remove(s.path()) })
}

// statusError is a fixed description of an org answer. Bodies stay private.
type statusError struct {
	Status int
	Code   string
}

func (e *statusError) Error() string {
	if e.Code != "" {
		return fmt.Sprintf("OA account service refused the request (%s)", e.Code)
	}
	return fmt.Sprintf("OA account service returned HTTP %d", e.Status)
}

func errorCode(data []byte) string {
	var envelope struct {
		Code   string `json:"code"`
		Detail struct {
			Code string `json:"code"`
		} `json:"detail"`
	}
	if json.Unmarshal(data, &envelope) != nil {
		return ""
	}
	if envelope.Detail.Code != "" {
		return envelope.Detail.Code
	}
	return envelope.Code
}

func (s *Session) send(ctx context.Context, method, path string, body []byte, bearer string) (*http.Response, []byte, error) {
	var reader io.Reader
	if body != nil {
		reader = bytes.NewReader(body)
	}
	attempt, cancel := context.WithTimeout(ctx, 45*time.Second)
	defer cancel()
	request, err := http.NewRequestWithContext(attempt, method, s.org+path, reader)
	if err != nil {
		return nil, nil, errors.New("cannot construct OA account request")
	}
	request.Header.Set("User-Agent", userAgent)
	request.Header.Set("Accept", "application/json")
	request.Header.Set("st-auth-mode", "header")
	request.Header.Set("rid", "session")
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	if bearer != "" {
		request.Header.Set("Authorization", "Bearer "+bearer)
	}
	response, err := s.client.Do(request)
	if err != nil {
		if ctx.Err() != nil {
			return nil, nil, ctx.Err()
		}
		// URL and transport errors can carry relay credentials.
		return nil, nil, errors.New("OA account service could not be reached")
	}
	defer response.Body.Close()
	data, err := io.ReadAll(io.LimitReader(response.Body, maxResponse+1))
	if err != nil || len(data) > maxResponse {
		return nil, nil, errors.New("OA account response was interrupted or too large")
	}
	return response, data, nil
}

// rotate stores any tokens the org issued. SuperTokens keeps the previous
// refresh token usable until the next access token is used, so a crash between
// the org's rotation and this write recovers by refreshing again.
func (s *Session) rotate(identity *Identity, header http.Header) error {
	access, refresh := header.Get("st-access-token"), header.Get("st-refresh-token")
	if access == "" && refresh == "" {
		return nil
	}
	if access != "" {
		identity.Access = access
	}
	if refresh != "" {
		identity.Refresh = refresh
	}
	return s.write(identity)
}

func (s *Session) refreshLocked(ctx context.Context, identity *Identity) error {
	response, data, err := s.send(ctx, http.MethodPost, "/auth/session/refresh", nil, identity.Refresh)
	if err != nil {
		return err
	}
	switch {
	case response.StatusCode == http.StatusUnauthorized:
		// Definitive: revoked, signed out, or token theft detection fired.
		if err := securefile.Remove(s.path()); err != nil {
			return err
		}
		return ErrRevoked
	case response.StatusCode >= 200 && response.StatusCode < 300:
		if response.Header.Get("st-access-token") == "" {
			return errors.New("OA account service did not return a new session")
		}
		return s.rotate(identity, response.Header)
	default:
		return &statusError{Status: response.StatusCode, Code: errorCode(data)}
	}
}

// Do sends one authenticated request, refreshing once on an expired session. The
// lock covers only token reads and rotation, never the request itself, so a slow
// sync cannot hold up the local authorization check on an inference request.
func (s *Session) Do(ctx context.Context, method, path string, body []byte) (int, []byte, error) {
	identity, err := s.Load(ctx)
	if err != nil {
		return 0, nil, err
	}
	access := identity.Access
	for attempt := 0; ; attempt++ {
		response, payload, err := s.send(ctx, method, path, body, access)
		if err != nil {
			return 0, nil, err
		}
		if err := s.withLock(ctx, func() error {
			current, err := s.read()
			if err != nil {
				return err
			}
			if current.Access != access {
				return nil // Another caller rotated meanwhile; keep the newer tokens.
			}
			if err := s.rotate(current, response.Header); err != nil {
				return err
			}
			access = current.Access
			return nil
		}); err != nil {
			return 0, nil, err
		}
		if response.StatusCode != http.StatusUnauthorized {
			return response.StatusCode, payload, nil
		}
		if attempt > 0 {
			if err := s.Erase(ctx); err != nil {
				return 0, nil, err
			}
			return 0, nil, ErrRevoked
		}
		if err := s.withLock(ctx, func() error {
			current, err := s.read()
			if err != nil {
				return err
			}
			if current.Access == access {
				if err := s.refreshLocked(ctx, current); err != nil {
					return err
				}
			}
			access = current.Access
			return nil
		}); err != nil {
			return 0, nil, err
		}
	}
}

// SignOut revokes this session at the org. Local erasure is the caller's.
func (s *Session) SignOut(ctx context.Context) error {
	status, data, err := s.Do(ctx, http.MethodPost, "/auth/signout", []byte("{}"))
	if err != nil {
		return err
	}
	if status < 200 || status >= 300 {
		return &statusError{Status: status, Code: errorCode(data)}
	}
	return nil
}
