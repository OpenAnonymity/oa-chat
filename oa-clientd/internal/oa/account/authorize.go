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
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"regexp"
	"runtime"
	"strings"
	"time"
)

// Wire labels of the daemon authorization envelope, shared with the browser's
// chat/services/daemonAuthorization.js. The construction matches phone pairing:
// P-256 ECDH, HKDF-SHA256, AES-256-GCM.
const (
	envelopeVersion  = 1
	envelopeInfo     = "oa-daemon-auth/v1/browser->daemon"
	envelopeAADLabel = "oa-daemon-auth/v1/envelope"
	maxAuthDeadline  = 15 * time.Minute
	minPoll          = 2 * time.Second
	maxPoll          = 15 * time.Second
)

var (
	transactionPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{43}$`)
	userCodePattern    = regexp.MustCompile(`^[A-Z2-9]{4}-[A-Z2-9]{4}$`)
	accountPattern     = regexp.MustCompile(`^[0-9]{16}$`)
)

// Prompter shows setup progress. Implementations must not log the URL's
// fragment beyond the terminal that requested it.
type Prompter interface {
	Authorize(url, userCode string, opened bool, expires time.Duration)
}

// Authorizer runs one browser authorization. Org access is anonymous until the
// final step, which returns a new header-mode session for this computer only.
type Authorizer struct {
	OrgURL   string
	ChatURL  string
	Client   *http.Client
	Prompter Prompter
	// OpenBrowser defaults to the platform opener; tests replace it.
	OpenBrowser func(string) error
	// ClientName is shown to the person approving; never a typed hostname.
	ClientName string
	Version    string
	// ExpectedAccount refuses a different account before any session exists.
	ExpectedAccount string
	now             func() time.Time
	sleep           func(context.Context, time.Duration) error
}

// Result is a completed authorization. The caller persists it.
type Result struct {
	Identity *Identity
}

func (a *Authorizer) clock() time.Time {
	if a.now != nil {
		return a.now()
	}
	return time.Now()
}

func defaultSleep(ctx context.Context, d time.Duration) error {
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-time.After(d):
		return nil
	}
}

func randomToken(n int) (string, error) {
	raw := make([]byte, n)
	if _, err := rand.Read(raw); err != nil {
		return "", errors.New("cannot generate authorization secret")
	}
	return base64.RawURLEncoding.EncodeToString(raw), nil
}

func (a *Authorizer) post(ctx context.Context, path string, body any) (*http.Response, []byte, error) {
	payload, err := json.Marshal(body)
	if err != nil {
		return nil, nil, errors.New("cannot encode authorization request")
	}
	attempt, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	request, err := http.NewRequestWithContext(attempt, http.MethodPost, strings.TrimRight(a.OrgURL, "/")+path, bytes.NewReader(payload))
	if err != nil {
		return nil, nil, errors.New("cannot construct authorization request")
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Accept", "application/json")
	request.Header.Set("User-Agent", userAgent)
	request.Header.Set("st-auth-mode", "header")
	response, err := a.Client.Do(request)
	if err != nil {
		if ctx.Err() != nil {
			return nil, nil, ctx.Err()
		}
		return nil, nil, errors.New("OA account service could not be reached")
	}
	defer response.Body.Close()
	data, err := io.ReadAll(io.LimitReader(response.Body, 1<<20))
	if err != nil {
		return nil, nil, errors.New("OA account response was interrupted")
	}
	return response, data, nil
}

// ErrCancelled, ErrDenied and ErrExpired are the terminal outcomes a person can
// cause. None leaves a session or secret behind.
var (
	ErrDenied  = errors.New("authorization was declined in the browser")
	ErrExpired = errors.New("authorization expired before it was approved; run oa-clientd login to try again")
)

// BuildURL places the transaction and public key in the fragment, which browsers
// never send to a server. The key must not come from the org, or the org could
// substitute its own and receive the sync key.
func BuildURL(chatURL, transaction string, publicKey []byte) (string, error) {
	base, err := url.Parse(chatURL)
	if err != nil || base.Host == "" {
		return "", errors.New("invalid chat origin")
	}
	payload, err := json.Marshal(map[string]any{
		"v": envelopeVersion,
		"t": transaction,
		"k": base64.RawURLEncoding.EncodeToString(publicKey),
	})
	if err != nil {
		return "", errors.New("cannot encode authorization link")
	}
	return strings.TrimRight(chatURL, "/") + "/#oa-daemon=" + base64.RawURLEncoding.EncodeToString(payload), nil
}

type sealedEnvelope struct {
	EphemeralKey string `json:"ephemeralPublicKey"`
	Nonce        string `json:"nonce"`
	Ciphertext   string `json:"ciphertext"`
}

type envelopePlaintext struct {
	Version     int    `json:"v"`
	AccountID   string `json:"accountId"`
	Transaction string `json:"transaction"`
	Origin      string `json:"origin"`
	MasterKey   string `json:"masterKey"`
}

// openEnvelope decrypts the browser's message and checks every binding. The
// additional data ties it to this transaction and this key, so a replayed or
// re-pointed ciphertext fails before anything is parsed.
func openEnvelope(private *ecdh.PrivateKey, transaction, chatOrigin string, sealed sealedEnvelope) (*envelopePlaintext, error) {
	fail := errors.New("the authorization message could not be opened")
	ephemeralRaw, err := base64.RawURLEncoding.DecodeString(sealed.EphemeralKey)
	if err != nil {
		return nil, fail
	}
	ephemeral, err := ecdh.P256().NewPublicKey(ephemeralRaw)
	if err != nil {
		return nil, fail
	}
	shared, err := private.ECDH(ephemeral)
	if err != nil {
		return nil, fail
	}
	publicRaw := private.PublicKey().Bytes()
	salt := sha256.Sum256([]byte(transaction))
	key, err := hkdf.Key(sha256.New, shared, salt[:], envelopeInfo+"|"+hex.EncodeToString(publicRaw)+"|"+hex.EncodeToString(ephemeralRaw), 32)
	if err != nil {
		return nil, fail
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, fail
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, fail
	}
	nonce, err := base64.RawURLEncoding.DecodeString(sealed.Nonce)
	if err != nil || len(nonce) != 12 {
		return nil, fail
	}
	ciphertext, err := base64.RawURLEncoding.DecodeString(sealed.Ciphertext)
	if err != nil {
		return nil, fail
	}
	plaintext, err := aead.Open(nil, nonce, ciphertext, []byte(envelopeAADLabel+"|"+transaction))
	if err != nil {
		return nil, fail
	}
	var message envelopePlaintext
	if err := json.Unmarshal(plaintext, &message); err != nil || message.Version != envelopeVersion {
		return nil, fail
	}
	if subtle.ConstantTimeCompare([]byte(message.Transaction), []byte(transaction)) != 1 {
		return nil, errors.New("the authorization message belongs to another request")
	}
	// The app origin, not the org's: staging browsers reach the org through a
	// same-origin rewrite, so this is what the page itself can state truthfully.
	if !strings.EqualFold(strings.TrimRight(message.Origin, "/"), strings.TrimRight(chatOrigin, "/")) {
		return nil, errors.New("the authorization message came from another OA app")
	}
	return &message, nil
}

// Run performs the authorization. Cancelling ctx withdraws the request.
func (a *Authorizer) Run(ctx context.Context) (*Result, error) {
	sleep := a.sleep
	if sleep == nil {
		sleep = defaultSleep
	}
	private, err := ecdh.P256().GenerateKey(rand.Reader)
	if err != nil {
		return nil, errors.New("cannot generate authorization key")
	}
	publicKey := private.PublicKey().Bytes()
	verifier, err := randomToken(32)
	if err != nil {
		return nil, err
	}
	challengeSum := sha256.Sum256([]byte(verifier))
	response, data, err := a.post(ctx, "/auth/daemon/start", map[string]any{
		"codeChallenge":   base64.RawURLEncoding.EncodeToString(challengeSum[:]),
		"daemonPublicKey": base64.RawURLEncoding.EncodeToString(publicKey),
		"clientName":      a.ClientName,
		"clientVersion":   a.Version,
		"platform":        runtime.GOOS + "/" + runtime.GOARCH,
	})
	if err != nil {
		return nil, err
	}
	if response.StatusCode == http.StatusNotFound {
		return nil, errors.New("this OA deployment does not offer daemon authorization yet")
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return nil, &statusError{Status: response.StatusCode, Code: errorCode(data)}
	}
	var started struct {
		Transaction string `json:"transaction"`
		UserCode    string `json:"userCode"`
		ExpiresIn   int    `json:"expiresIn"`
		Interval    int    `json:"pollInterval"`
	}
	if err := json.Unmarshal(data, &started); err != nil || !transactionPattern.MatchString(started.Transaction) || !userCodePattern.MatchString(started.UserCode) || started.ExpiresIn < 1 {
		return nil, errors.New("OA account service returned an invalid authorization response")
	}
	lifetime := time.Duration(started.ExpiresIn) * time.Second
	if lifetime > maxAuthDeadline {
		lifetime = maxAuthDeadline
	}
	deadline := a.clock().Add(lifetime)
	interval := time.Duration(started.Interval) * time.Second
	if interval < minPoll {
		interval = minPoll
	}
	if interval > maxPoll {
		interval = maxPoll
	}
	link, err := BuildURL(a.ChatURL, started.Transaction, publicKey)
	if err != nil {
		return nil, err
	}
	opener := a.OpenBrowser
	if opener == nil {
		opener = OpenDefaultBrowser
	}
	openErr := opener(link)
	a.Prompter.Authorize(link, started.UserCode, openErr == nil, lifetime)

	withdraw := func() {
		// Best effort, on its own short deadline: the transaction expires anyway.
		cleanup, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_, _, _ = a.post(cleanup, "/auth/daemon/cancel", map[string]string{"transaction": started.Transaction, "codeVerifier": verifier})
	}

	var sealed sealedEnvelope
	var accountID, kind, label string
	for {
		if !a.clock().Before(deadline) {
			withdraw()
			return nil, ErrExpired
		}
		if err := sleep(ctx, interval); err != nil {
			withdraw()
			return nil, err
		}
		response, data, err := a.post(ctx, "/auth/daemon/poll", map[string]string{"transaction": started.Transaction, "codeVerifier": verifier})
		if err != nil {
			if ctx.Err() != nil {
				withdraw()
				return nil, ctx.Err()
			}
			// A network loss during the wait is retried until the deadline.
			continue
		}
		code := errorCode(data)
		switch {
		case response.StatusCode == http.StatusOK:
			var ready struct {
				Status      string         `json:"status"`
				AccountID   string         `json:"accountId"`
				AccountKind string         `json:"accountKind"`
				Label       string         `json:"label"`
				Sealed      sealedEnvelope `json:"sealed"`
			}
			if err := json.Unmarshal(data, &ready); err != nil {
				return nil, errors.New("OA account service returned an invalid authorization response")
			}
			if ready.Status == "pending" {
				continue
			}
			if ready.Status != "approved" || !accountPattern.MatchString(ready.AccountID) {
				return nil, errors.New("OA account service returned an invalid authorization response")
			}
			sealed, accountID, kind, label = ready.Sealed, ready.AccountID, ready.AccountKind, ready.Label
		case response.StatusCode == http.StatusTooManyRequests || response.StatusCode >= 500:
			interval = min(interval*2, maxPoll)
			continue
		case code == "DAEMON_AUTH_DENIED":
			return nil, ErrDenied
		case code == "DAEMON_AUTH_EXPIRED" || response.StatusCode == http.StatusGone:
			return nil, ErrExpired
		default:
			return nil, &statusError{Status: response.StatusCode, Code: code}
		}
		break
	}

	message, err := openEnvelope(private, started.Transaction, a.ChatURL, sealed)
	if err != nil {
		withdraw()
		return nil, err
	}
	// The envelope's account comes from the browser and the poll's from the org.
	// Both must agree, and both must match a profile bound to an account.
	if message.AccountID != accountID {
		withdraw()
		return nil, errors.New("the browser and the OA service disagree about the approved account")
	}
	if a.ExpectedAccount != "" && a.ExpectedAccount != accountID {
		withdraw()
		return nil, errors.New("the browser approved a different account than this profile's; run oa-clientd logout first or use a separate --config-dir")
	}
	master, err := base64.RawURLEncoding.DecodeString(message.MasterKey)
	if err != nil || len(master) != 32 {
		withdraw()
		return nil, errors.New("the authorization message holds an invalid key")
	}

	// A busy account lock consumed nothing, so only that answer is retried. Any
	// other retry would make the org treat this as a replay and end the session.
	for tries := 0; ; tries++ {
		response, data, err = a.post(ctx, "/auth/daemon/complete", map[string]string{"transaction": started.Transaction, "codeVerifier": verifier})
		if err != nil {
			// The org may have issued a session whose tokens never arrived. A second
			// call ends it, so no live session is left with nobody holding it.
			cleanup, cancel := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
			defer cancel()
			_, _, _ = a.post(cleanup, "/auth/daemon/complete", map[string]string{"transaction": started.Transaction, "codeVerifier": verifier})
			return nil, fmt.Errorf("the final authorization step failed; run oa-clientd login to try again: %w", err)
		}
		if response.StatusCode != http.StatusServiceUnavailable || errorCode(data) != "ACCOUNT_AUTH_BUSY" || tries >= 5 {
			break
		}
		if err := sleep(ctx, minPoll); err != nil {
			return nil, err
		}
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return nil, &statusError{Status: response.StatusCode, Code: errorCode(data)}
	}
	access, refresh := response.Header.Get("st-access-token"), response.Header.Get("st-refresh-token")
	if access == "" || refresh == "" {
		return nil, errors.New("OA account service did not issue a session")
	}
	device := make([]byte, 16)
	if _, err := rand.Read(device); err != nil {
		return nil, errors.New("cannot generate a device identifier")
	}
	return &Result{Identity: &Identity{
		AccountID:   accountID,
		AccountKind: kind,
		Label:       label,
		OrgURL:      strings.TrimRight(a.OrgURL, "/"),
		DeviceID:    hex.EncodeToString(device),
		MasterKey:   master,
		Access:      access,
		Refresh:     refresh,
	}}, nil
}

// OpenDefaultBrowser starts the platform's URL handler. The URL is one argv
// element, never parsed by a shell. Returning nil only means the handler started.
func OpenDefaultBrowser(link string) error {
	if !strings.HasPrefix(link, "https://") && !strings.HasPrefix(link, "http://") {
		return errors.New("refused to open a non-web URL")
	}
	var candidates [][]string
	switch runtime.GOOS {
	case "darwin":
		candidates = [][]string{{"open", link}}
	case "linux":
		if os.Getenv("DISPLAY") == "" && os.Getenv("WAYLAND_DISPLAY") == "" && os.Getenv("WSL_DISTRO_NAME") == "" {
			return errors.New("no graphical session")
		}
		candidates = [][]string{{"xdg-open", link}, {"gio", "open", link}, {"wslview", link}}
	default:
		return errors.New("unsupported platform")
	}
	var last error
	for _, candidate := range candidates {
		path, err := exec.LookPath(candidate[0])
		if err != nil {
			last = err
			continue
		}
		command := exec.Command(path, candidate[1:]...)
		command.Stdin, command.Stdout, command.Stderr = nil, nil, nil
		if err := command.Start(); err != nil {
			last = err
			continue
		}
		go func() { _ = command.Wait() }()
		return nil
	}
	return last
}
