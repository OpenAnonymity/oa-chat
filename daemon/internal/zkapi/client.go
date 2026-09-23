// Package zkapi connects the Go API gateway to the pinned local zkAPI wallet
// and prover. Prompts never cross this bridge: only a verified short-lived
// provider credential does. Inference uses the caller's anonymous transport.
package zkapi

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

const (
	MainnetManifest         = "https://d27v1dvkaxfc09.cloudfront.net/config.json"
	SepoliaManifest         = "https://d33l4w2z2nh4cg.cloudfront.net/config.json"
	CompanionRevision       = "b89365f7050e376f55e489c4d60b623cf224a4d8"
	DefaultClientURL        = "http://127.0.0.1:43134"
	DefaultInferenceBaseURL = "https://openrouter.ai/api/v1"
)

// Config is the Go-side bridge configuration. A companion must be built with
// companion.patch; unpatched or unauthenticated daemons are rejected.
type Config struct {
	ClientURL        string       `json:"client_url"`
	BridgeToken      string       `json:"bridge_token"`
	Network          string       `json:"network"` // empty means mainnet; Sepolia is explicit
	InferenceBaseURL string       `json:"inference_base_url"`
	HTTPClient       *http.Client `json:"-"` // inference only; typically TLS over Wisp
}

type Client struct {
	leaseMu    sync.Mutex
	usedLeases map[[32]byte]uint64
	config     Config
	local      *http.Client
	inference  *http.Client
}

// Error is safe to return to API consumers: raw companion/provider messages
// may contain credentials or protocol state and are deliberately discarded.
type Error struct {
	Status int
	Code   string
}

func (e *Error) Error() string {
	if e.Status == http.StatusPaymentRequired {
		return "zkAPI private balance needs funding; run oa-chat fund"
	}
	if e.Status == http.StatusConflict {
		return "zkAPI wallet has a pending lease; wait for settlement or recover it"
	}
	return "zkAPI " + e.Code
}

func New(config Config) (*Client, error) {
	if config.ClientURL == "" {
		config.ClientURL = DefaultClientURL
	}
	config.ClientURL = strings.TrimRight(config.ClientURL, "/")
	if err := validateLoopbackURL(config.ClientURL); err != nil {
		return nil, err
	}
	if len(config.BridgeToken) < 32 || strings.ContainsAny(config.BridgeToken, "\r\n") {
		return nil, errors.New("zkAPI bridge token must contain at least 32 characters")
	}
	if config.Network == "" {
		config.Network = "mainnet"
	}
	if _, err := ChainID(config.Network); err != nil {
		return nil, err
	}
	if config.InferenceBaseURL == "" {
		config.InferenceBaseURL = DefaultInferenceBaseURL
	}
	config.InferenceBaseURL = strings.TrimRight(config.InferenceBaseURL, "/")
	u, err := url.Parse(config.InferenceBaseURL)
	if err != nil || u.Scheme != "https" || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return nil, errors.New("zkAPI inference base must be an HTTPS URL without credentials, query, or fragment")
	}
	if config.HTTPClient == nil {
		return nil, errors.New("zkAPI inference requires an explicit anonymous HTTP transport")
	}
	inference := *config.HTTPClient
	inference.CheckRedirect = noRedirect
	inference.Jar = nil
	local := &http.Client{Transport: &http.Transport{Proxy: nil, DialContext: (&net.Dialer{Timeout: 5 * time.Second}).DialContext}, CheckRedirect: noRedirect, Timeout: 4 * time.Minute}
	return &Client{config: config, local: local, inference: &inference, usedLeases: make(map[[32]byte]uint64)}, nil
}

func noRedirect(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
func validateLoopbackURL(raw string) error {
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "http" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || (u.Path != "" && u.Path != "/") {
		return errors.New("zkAPI companion URL must be a plain HTTP loopback origin")
	}
	ip := net.ParseIP(u.Hostname())
	if ip == nil || !ip.IsLoopback() || u.Port() == "" {
		return errors.New("zkAPI companion must use a literal loopback IP and explicit port")
	}
	return nil
}

func ChainID(network string) (uint64, error) {
	switch network {
	case "", "mainnet":
		return 1, nil
	case "sepolia":
		return 11155111, nil
	default:
		return 0, errors.New("zkAPI network must be mainnet or sepolia")
	}
}
func Manifest(network string) (string, error) {
	if _, err := ChainID(network); err != nil {
		return "", err
	}
	if network == "sepolia" {
		return SepoliaManifest, nil
	}
	return MainnetManifest, nil
}

func (c *Client) request(ctx context.Context, method, path string, body []byte) (json.RawMessage, error) {
	req, err := http.NewRequestWithContext(ctx, method, c.config.ClientURL+path, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+c.config.BridgeToken)
	req.Header.Set("Content-Type", "application/json")
	response, err := c.local.Do(req)
	if err != nil {
		return nil, &Error{http.StatusBadGateway, "companion_unavailable"}
	}
	defer response.Body.Close()
	data, err := io.ReadAll(io.LimitReader(response.Body, 2<<20+1))
	if err != nil || len(data) > 2<<20 {
		return nil, &Error{http.StatusBadGateway, "invalid_companion_response"}
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return nil, &Error{response.StatusCode, "companion_request_failed"}
	}
	if !json.Valid(data) {
		return nil, &Error{http.StatusBadGateway, "invalid_companion_response"}
	}
	return json.RawMessage(data), nil
}

// Check verifies chain and independent OA key-source policy before funding,
// model discovery, or proof work. It does not spend any credits.
func (c *Client) Check(ctx context.Context) error {
	data, err := c.request(ctx, http.MethodGet, "/oa/v1/status", nil)
	if err != nil {
		return err
	}
	var result struct {
		ChainID       uint64 `json:"chain_id"`
		Mode          string `json:"mode"`
		RequireOA     bool   `json:"require_oa_org_key_source"`
		BridgeVersion int    `json:"bridge_version"`
	}
	if json.Unmarshal(data, &result) != nil {
		return &Error{http.StatusBadGateway, "invalid_companion_response"}
	}
	expected, _ := ChainID(c.config.Network)
	if result.ChainID != expected || result.Mode != "direct_openrouter" || !result.RequireOA || result.BridgeVersion != 1 {
		return &Error{http.StatusBadGateway, "companion_policy_mismatch"}
	}
	return nil
}

func (c *Client) Models(ctx context.Context) (json.RawMessage, error) {
	if err := c.Check(ctx); err != nil {
		return nil, err
	}
	return c.request(ctx, http.MethodGet, "/v1/models", nil)
}

// Complete passes the caller's JSON unchanged over the anonymous HTTP client.
// Raw SSE bytes remain available to the gateway immediately; no fake streaming
// or complete-response buffering occurs in either Go or the proof companion.
func (c *Client) Complete(ctx context.Context, body json.RawMessage) (*http.Response, error) {
	if err := c.Check(ctx); err != nil {
		return nil, err
	}
	leaseJSON, err := c.request(ctx, http.MethodPost, "/oa/v1/lease", []byte("{}"))
	if err != nil {
		return nil, err
	}
	var lease struct {
		APIKey    string `json:"api_key"`
		BaseURL   string `json:"base_url"`
		ExpiresAt uint64 `json:"expires_at"`
		Verified  bool   `json:"verified"`
	}
	if json.Unmarshal(leaseJSON, &lease) != nil || !lease.Verified || lease.APIKey == "" || strings.ContainsAny(lease.APIKey, "\r\n") || lease.ExpiresAt <= uint64(time.Now().Unix()+1) || strings.TrimRight(lease.BaseURL, "/") != c.config.InferenceBaseURL {
		return nil, &Error{http.StatusBadGateway, "invalid_verified_lease"}
	}
	// The companion enforces this durably; the Go layer also rejects a
	// buggy bridge returning one provider key to unrelated API requests.
	hash := sha256.Sum256([]byte(lease.APIKey))
	c.leaseMu.Lock()
	for oldHash, expiry := range c.usedLeases {
		if expiry <= uint64(time.Now().Unix()) {
			delete(c.usedLeases, oldHash)
		}
	}
	if _, used := c.usedLeases[hash]; used {
		c.leaseMu.Unlock()
		return nil, &Error{http.StatusConflict, "lease_already_used"}
	}
	c.usedLeases[hash] = lease.ExpiresAt
	c.leaseMu.Unlock()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.config.InferenceBaseURL+"/chat/completions", bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("create inference request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+lease.APIKey)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json, text/event-stream")
	response, err := c.inference.Do(req)
	if err != nil {
		return nil, &Error{http.StatusBadGateway, "inference_transport_failed"}
	}
	return response, nil
}

func (c *Client) WalletStatus(ctx context.Context) (json.RawMessage, error) {
	if err := c.Check(ctx); err != nil {
		return nil, err
	}
	return c.request(ctx, http.MethodGet, "/wallet/status", nil)
}
