package tickets

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"

	"github.com/OpenAnonymity/oa-chat/oa-clientd/pkg/activity"
	"github.com/OpenAnonymity/oa-chat/oa-clientd/pkg/relay"
	"github.com/OpenAnonymity/oa-chat/oa-clientd/pkg/rewriter"
	"github.com/OpenAnonymity/oa-chat/oa-clientd/pkg/server"
)

// DefaultInferenceBaseURL is OA's provider. Prompts go here directly, never
// through an OA service.
const DefaultInferenceBaseURL = "https://openrouter.ai/api/v1"

// Gateway is the server.Backend for any credential Source: it obtains a key and
// streams the provider's response unmodified. It never retries inference.
type Gateway struct {
	Source  Source
	BaseURL string
	Client  *http.Client
	// RequireIsolatedRoute gates strict delegation on a per-request network
	// identity; without one it fails before any ticket is spent.
	RequireIsolatedRoute bool
	// PrepareRoute scopes a request to a fresh network identity when one exists.
	PrepareRoute func(context.Context) (context.Context, error)
	// Rewriter, when enabled, normalizes user text before any ticket is spent,
	// through the shared transcript logic in pkg/rewriter.
	Rewriter   rewriter.Config
	rewriteMu  sync.Mutex
	transcript rewriter.Transcript
	keySerial  atomic.Uint64
}

// rewrite serializes the shared transcript. A failure stops the request before
// any ticket is selected.
func (g *Gateway) rewrite(ctx context.Context, body json.RawMessage, transcript *rewriter.Transcript) (json.RawMessage, error) {
	if !g.Rewriter.Enabled() {
		return body, nil
	}
	rewritten, notice, err := transcript.Rewrite(ctx, body, g.Rewriter)
	if err == nil && notice != nil {
		err = rewriter.Publish(ctx, *notice)
	}
	if err != nil {
		return nil, err
	}
	return rewritten, nil
}

// safeError maps a source error to the shared API's safe boundary.
func safeError(err error) error {
	var safe *SafeError
	if errors.As(err, &safe) {
		return &server.BackendError{Status: safe.Status, Code: safe.Code, Message: safe.Message}
	}
	return err
}

// Models implements server.Backend.
func (g *Gateway) Models(ctx context.Context) (json.RawMessage, error) {
	if g.PrepareRoute != nil {
		routed, err := g.PrepareRoute(ctx)
		if err != nil {
			return nil, err
		}
		ctx = routed
	}
	return g.Source.Models(ctx)
}

func requestedModel(body json.RawMessage) (string, error) {
	var selected struct {
		Model string `json:"model"`
	}
	if err := json.Unmarshal(body, &selected); err != nil || selected.Model == "" {
		return "", &server.BackendError{Status: http.StatusBadRequest, Code: "invalid_model", Message: "Select a model from /v1/models."}
	}
	return selected.Model, nil
}

func (g *Gateway) send(ctx context.Context, body json.RawMessage, credential Credential, reusable bool) (*http.Response, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, g.BaseURL+"/chat/completions", bytes.NewReader(body))
	if err != nil {
		g.Source.Invalidate(credential.Key)
		return nil, errors.New("cannot construct inference request")
	}
	// The provider sees only this ephemeral key and the request.
	request.Header.Set("Authorization", "Bearer "+credential.Key)
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Accept", "application/json, text/event-stream")
	serial := g.keySerial.Add(1)
	if credential.Reused {
		activity.Report(ctx, activity.Event{Kind: activity.KeyReused, Key: serial})
	} else {
		activity.Report(ctx, activity.Event{Kind: activity.KeyFresh, Key: serial})
	}
	response, err := g.Client.Do(request)
	if err != nil {
		g.Source.Invalidate(credential.Key)
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		return nil, &server.BackendError{Status: http.StatusBadGateway, Code: "inference_transport_failed", Message: "The provider connection failed after a key was acquired. The request was not retried."}
	}
	response.Header.Del("X-OA-Verification-Status")
	response.Header.Del("X-OA-Verification-Detail")
	response.Header.Set("X-OA-Verification-Status", credential.VerificationStatus)
	if credential.VerificationStatus == "verifier-unavailable" {
		response.Header.Set("X-OA-Verification-Detail", "trusted_station_fallback")
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		g.Source.Invalidate(credential.Key)
	}
	if !reusable {
		g.Source.Invalidate(credential.Key)
		return response, nil
	}
	// An early close or body error leaves provider usage ambiguous.
	response.Body = &invalidateOnFailure{ReadCloser: response.Body, invalidate: func() { g.Source.Invalidate(credential.Key) }}
	return response, nil
}

type invalidateOnFailure struct {
	io.ReadCloser
	invalidate func()
	finished   bool
	once       sync.Once
}

func (b *invalidateOnFailure) Read(p []byte) (int, error) {
	n, err := b.ReadCloser.Read(p)
	if err == io.EOF {
		b.finished = true
	} else if err != nil {
		b.once.Do(b.invalidate)
	}
	return n, err
}

func (b *invalidateOnFailure) Close() error {
	if !b.finished {
		b.once.Do(b.invalidate)
	}
	return b.ReadCloser.Close()
}

// Complete implements server.Backend. Calls within the reuse window can share a
// key and are linkable by the provider, as documented in README.md.
func (g *Gateway) Complete(ctx context.Context, body json.RawMessage) (*http.Response, error) {
	model, err := requestedModel(body)
	if err != nil {
		return nil, err
	}
	fresh := false
	if g.PrepareRoute != nil {
		// A per-request network identity means a per-request key too.
		fresh = true
		if ctx, err = g.PrepareRoute(ctx); err != nil {
			return nil, err
		}
	}
	g.rewriteMu.Lock()
	body, err = g.rewrite(ctx, body, &g.transcript)
	g.rewriteMu.Unlock()
	if err != nil {
		return nil, err
	}
	credential, err := g.Source.Acquire(ctx, model, fresh)
	if err != nil {
		return nil, safeError(err)
	}
	if err := ctx.Err(); err != nil {
		g.Source.Invalidate(credential.Key)
		return nil, err
	}
	return g.send(ctx, body, credential, !fresh)
}

// Delegate implements server.Delegator: one independent completion with a fresh
// key that never enters the cache, over a fresh network identity.
func (g *Gateway) Delegate(ctx context.Context, body json.RawMessage) (*http.Response, error) {
	if g.PrepareRoute == nil {
		return nil, &server.BackendError{Status: http.StatusPreconditionFailed, Code: "delegation_requires_tor", Message: "Delegation requires Tor routing; nothing was spent. Run Tor with IsolateSOCKSAuth, then set relay_url to tor://127.0.0.1:9050 and restart serve."}
	}
	model, err := requestedModel(body)
	if err != nil {
		return nil, err
	}
	routed, err := g.PrepareRoute(ctx)
	if err != nil {
		return nil, err
	}
	// A transcript for this call alone: delegation shares nothing with chat.
	var transcript rewriter.Transcript
	body, err = g.rewrite(routed, body, &transcript)
	if err != nil {
		return nil, err
	}
	credential, err := g.Source.Acquire(routed, model, true)
	if err != nil {
		return nil, safeError(err)
	}
	return g.send(routed, body, credential, false)
}

// FreshTorRoute scopes a request to a Tor identity used once.
func FreshTorRoute(ctx context.Context) (context.Context, error) {
	identity, err := relay.NewTorIdentity()
	if err != nil {
		return nil, err
	}
	return relay.WithTorIdentity(ctx, identity), nil
}

// AnonymousAuthClient carries the unauthenticated authorization handshake. It
// has no session or cookie, may only reach /auth/daemon/, and refuses redirects.
func AnonymousAuthClient(base *http.Client, orgURL string) *http.Client {
	transport := base.Transport
	if transport == nil {
		transport = http.DefaultTransport
	}
	return &http.Client{
		Transport:     authHandshakeTransport{next: transport, org: strings.TrimRight(orgURL, "/")},
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
}

type authHandshakeTransport struct {
	next http.RoundTripper
	org  string
}

func (t authHandshakeTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	if !strings.HasPrefix(r.URL.String(), t.org+"/auth/daemon/") {
		return nil, errors.New("refused a request outside the authorization handshake")
	}
	return t.next.RoundTrip(r)
}
