// Package delegatemcp is the stdio MCP adapter for an already running
// zkapi-clientd daemon. It exposes strict delegation and public model
// discovery only. It never starts, funds or configures the daemon, never sees
// the management credential, and talks only to the daemon's numeric loopback
// address.
package delegatemcp

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/OpenAnonymity/oa-chat/oa-clientd/pkg/server"
)

const (
	modelsTimeout   = 4 * time.Minute
	delegateTimeout = 11 * time.Minute // the daemon bounds delegation at 10 minutes
	maxModelsBody   = 16 << 20
	maxResultBody   = 8 << 20
	maxErrorMessage = 600
)

// daemon is a client of the local API only. Requests carry nothing but the
// local inference API key; there is no proxy, redirect, cookie or keep-alive.
type daemon struct {
	product *Product
	origin  string
	apiKey  string
	client  *http.Client
}

var errRedirect = errors.New("redirect refused")

// newDaemon accepts only a numeric loopback IP and explicit port. A non-nil
// transport replaces the loopback dialer (tests only).
func newDaemon(listen, apiKey string, transport http.RoundTripper) (*daemon, error) {
	host, port, err := net.SplitHostPort(listen)
	ip := net.ParseIP(host)
	number, portErr := strconv.ParseUint(port, 10, 16)
	if err != nil || ip == nil || !ip.IsLoopback() || portErr != nil || number == 0 {
		return nil, errors.New("the saved listen address must be a numeric loopback IP and port")
	}
	if strings.ContainsAny(apiKey, "\r\n") {
		return nil, errors.New("invalid local API key")
	}
	address := net.JoinHostPort(ip.String(), port)
	if transport == nil {
		dialer := &net.Dialer{Timeout: 5 * time.Second}
		transport = &http.Transport{
			Proxy: nil, // never an environment proxy
			DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
				return dialer.DialContext(ctx, "tcp", address)
			},
			DisableKeepAlives:      true,
			DisableCompression:     true,
			MaxResponseHeaderBytes: 64 << 10,
		}
	}
	client := &http.Client{Transport: transport, CheckRedirect: func(*http.Request, []*http.Request) error { return errRedirect }}
	return &daemon{product: zkapiProduct(), origin: "http://" + address, apiKey: apiKey, client: client}, nil
}

// toolError is a fixed or sanitized message that is safe to show the model.
type toolError struct{ message string }

func (e *toolError) Error() string { return e.message }

// commError is a failure to exchange a complete request and reply with the
// daemon. For a paid POST it does not show that the request was unprocessed.
type commError struct{ toolError }

func (d *daemon) do(ctx context.Context, method, path string, body []byte, limit int64) ([]byte, int, error) {
	request, err := http.NewRequestWithContext(ctx, method, d.origin+path, bytes.NewReader(body))
	if err != nil {
		return nil, 0, &toolError{"Could not build the local daemon request."}
	}
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	request.Header.Set("Accept", "application/json")
	if d.apiKey != "" {
		request.Header.Set("Authorization", "Bearer "+d.apiKey)
	}
	// One attempt only: POST bodies are not replayable, keep-alives are off,
	// and nothing here loops on failure.
	response, err := d.client.Do(request)
	if err != nil {
		if ctx.Err() != nil {
			return nil, 0, ctx.Err()
		}
		if errors.Is(err, errRedirect) {
			return nil, 0, &commError{toolError{"The local daemon answered with a redirect, which is refused. Check the profile's listen address."}}
		}
		return nil, 0, &commError{toolError{fmt.Sprintf("The %[1]s daemon at %[2]s could not be reached or the connection failed. Check that %[1]s serve is running for this profile; this tool never starts, funds or configures it.", d.product.Binary, d.origin)}}
	}
	defer response.Body.Close()
	data, err := io.ReadAll(io.LimitReader(response.Body, limit+1))
	if err != nil {
		if ctx.Err() != nil {
			return nil, 0, ctx.Err()
		}
		return nil, 0, &commError{toolError{"The local daemon response was incomplete."}}
	}
	if int64(len(data)) > limit {
		return nil, 0, &commError{toolError{"The local daemon response was too large."}}
	}
	return data, response.StatusCode, nil
}

// daemonError turns an error envelope into a short, single-line message. The
// daemon's messages are fixed local text; they are still bounded and stripped
// of control characters because any local process could own the port.
func (d *daemon) daemonError(status int, data []byte, delegation bool) error {
	var envelope struct {
		Error struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}
	_ = json.Unmarshal(data, &envelope)
	code, message := envelope.Error.Code, sanitize(envelope.Error.Message)
	switch {
	case delegation && (status == http.StatusNotFound || (status == http.StatusMethodNotAllowed && code == "")):
		return &toolError{fmt.Sprintf("The running %[1]s daemon does not provide strict delegation (an older build). Upgrade %[1]s and restart serve. Nothing was spent.", d.product.Binary)}
	case code == "invalid_api_key":
		return &toolError{fmt.Sprintf("The daemon rejected this profile's local API key. Run %s mcp with the same --config-dir as the running daemon.", d.product.Binary)}
	case code == "browser_origin_denied" || code == "local_connection_required":
		return &toolError{"The daemon refused this connection as non-local."}
	}
	if !validCode(code) {
		code = "daemon_error"
	}
	if message == "" {
		message = fmt.Sprintf("The local daemon returned HTTP %d.", status)
	}
	return &toolError{fmt.Sprintf("%s (%s)", message, code)}
}

func validCode(code string) bool {
	if code == "" || len(code) > 64 {
		return false
	}
	for _, r := range code {
		if (r < 'a' || r > 'z') && (r < '0' || r > '9') && r != '_' {
			return false
		}
	}
	return true
}

// identifier matches long hex values such as nullifiers, keys and hashes.
var identifier = regexp.MustCompile(`(?i)(0x)?[0-9a-f]{16,}`)

func sanitize(text string) string {
	// Defense in depth behind the daemon's own boundary: never hand a wallet
	// or protocol identifier to the model, which could put it in a task.
	text = identifier.ReplaceAllString(text, "[withheld]")
	text = strings.Map(func(r rune) rune {
		if r < 32 || r == 127 || (r >= 0x80 && r < 0xa0) {
			return ' '
		}
		return r
	}, strings.ToValidUTF8(text, ""))
	if len(text) > maxErrorMessage {
		cut := maxErrorMessage
		for cut > 0 && (text[cut]&0xc0) == 0x80 {
			cut--
		}
		text = text[:cut] + "…"
	}
	return strings.TrimSpace(text)
}

type catalogModel struct {
	ID     string `json:"id"`
	Budget uint64 `json:"oa_request_limit_micro_usd"`
	// TicketCost is set by a daemon that pays in inference tickets.
	TicketCost int `json:"oa_ticket_cost"`
}

// models reads the daemon's public catalog. The daemon serves it from public
// model policy without acquiring a key, so discovery spends nothing.
func (d *daemon) models(ctx context.Context) ([]catalogModel, error) {
	ctx, cancel := context.WithTimeout(ctx, modelsTimeout)
	defer cancel()
	data, status, err := d.do(ctx, http.MethodGet, "/v1/models", nil, maxModelsBody)
	if err != nil {
		return nil, err
	}
	if status != http.StatusOK {
		return nil, d.daemonError(status, data, false)
	}
	var catalog struct {
		Data []catalogModel `json:"data"`
	}
	if json.Unmarshal(data, &catalog) != nil {
		return nil, &toolError{"The daemon returned an invalid model catalog."}
	}
	return catalog.Data, nil
}

// uncertain reports a delegation whose outcome is unknown: the daemon may
// have processed and charged it before the exchange failed.
func uncertain(cause string) error {
	return &toolError{cause + " The delegation's outcome is unknown: it may have been processed and charged. It was not retried; do not repeat it unless the user or host already allows another paid attempt."}
}

// delegate performs exactly one delegation request and never retries it.
func (d *daemon) delegate(ctx context.Context, request server.DelegationRequest) (server.DelegationResult, error) {
	body, err := json.Marshal(request)
	if err != nil {
		return server.DelegationResult{}, &toolError{"Invalid delegation request."}
	}
	ctx, cancel := context.WithTimeout(ctx, delegateTimeout)
	defer cancel()
	data, status, err := d.do(ctx, http.MethodPost, d.product.DelegatePath, body, maxResultBody)
	if err != nil {
		if ctx.Err() != nil {
			return server.DelegationResult{}, &toolError{"The delegation was canceled or timed out. It was not retried; if it reached the provider it may have been charged."}
		}
		var comm *commError
		if errors.As(err, &comm) {
			return server.DelegationResult{}, uncertain(comm.message)
		}
		return server.DelegationResult{}, err
	}
	if status != http.StatusOK {
		return server.DelegationResult{}, d.daemonError(status, data, true)
	}
	var result server.DelegationResult
	if json.Unmarshal(data, &result) != nil {
		return server.DelegationResult{}, uncertain("The daemon returned an invalid delegation result.")
	}
	return result, nil
}
