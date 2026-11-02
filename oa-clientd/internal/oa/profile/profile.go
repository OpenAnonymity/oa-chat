// Package profile is oa-clientd's private configuration: its own directory,
// port and file set, so no other local client's files are read or charged.
package profile

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/OpenAnonymity/oa-chat/oa-clientd/internal/oa/securefile"
	"github.com/OpenAnonymity/oa-chat/oa-clientd/pkg/cover"
	"github.com/OpenAnonymity/oa-chat/oa-clientd/pkg/relay"
	"github.com/OpenAnonymity/oa-chat/oa-clientd/pkg/rewriter"
)

// DefaultListen avoids 8787 and 8790, ports other local OpenAnonymity clients use.
const DefaultListen = "127.0.0.1:8797"

const (
	DefaultKeyReuseWindowSeconds = 60
	MaxKeyReuseWindowSeconds     = 300
	DefaultLeaseSize             = 30
	MaxLeaseSize                 = 500
	configFile                   = "config.json"
	maxConfigBytes               = 1 << 20
)

// Environment is one reviewed OA deployment. The chat origin is where the
// browser authorizes; it comes only from here and never from a server answer.
type Environment struct {
	Name        string
	OrgURL      string
	ChatURL     string
	VerifierURL string
}

var environments = map[string]Environment{
	"production": {
		Name:        "production",
		OrgURL:      "https://org.openanonymity.ai",
		ChatURL:     "https://chat.openanonymity.ai",
		VerifierURL: "https://verifier-production-20260917.openanonymity.ai",
	},
	"staging": {
		Name:        "staging",
		OrgURL:      "https://org-staging.openanonymity.ai",
		ChatURL:     "https://staging.openanonymity.ai",
		VerifierURL: "https://verifier2.openanonymity.ai",
	},
}

// LookupEnvironment returns a reviewed deployment by name.
func LookupEnvironment(name string) (Environment, bool) {
	env, ok := environments[name]
	return env, ok
}

// Config is the saved profile. Tickets, the sync key and session tokens live
// in separate owner-only files; this one carries only the local API key.
type Config struct {
	// The optional privacy features, from the reusable pkg/ packages.
	Cover    cover.Config    `json:"cover,omitzero"`
	Rewriter rewriter.Config `json:"rewriter,omitzero"`

	Environment           string `json:"environment"`
	OrgURL                string `json:"org_url"`
	ChatURL               string `json:"chat_url"`
	VerifierURL           string `json:"verifier_url"`
	Listen                string `json:"listen"`
	APIKey                string `json:"api_key"`
	RequireAPIKey         bool   `json:"require_api_key"`
	DefaultModel          string `json:"default_model,omitempty"`
	KeyReuseWindowSeconds int    `json:"key_reuse_window_seconds"`
	WebSearch             bool   `json:"web_search"`
	RelayURL              string `json:"relay_url"`
	Concurrency           int    `json:"concurrency"`
	LeaseSize             int    `json:"ticket_lease_size"`
	// SyncIntervalSeconds is the base period of background wallet sync. Each
	// wait adds jitter, and redemption never triggers a sync.
	SyncIntervalSeconds int `json:"sync_interval_seconds"`
}

// DefaultDir has its own override, OA_CLIENTD_CONFIG_DIR, so another client's
// environment variable cannot point this binary at that client's files.
func DefaultDir() (string, error) {
	if dir := os.Getenv("OA_CLIENTD_CONFIG_DIR"); dir != "" {
		return filepath.Abs(dir)
	}
	base, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(base, "oa-clientd"), nil
}

// Default builds a fresh profile for a reviewed deployment.
func Default(env Environment) (Config, error) {
	secret := make([]byte, 32)
	if _, err := rand.Read(secret); err != nil {
		return Config{}, errors.New("cannot generate a local API key")
	}
	return Config{
		Environment:           env.Name,
		OrgURL:                env.OrgURL,
		ChatURL:               env.ChatURL,
		VerifierURL:           env.VerifierURL,
		Listen:                DefaultListen,
		APIKey:                hex.EncodeToString(secret),
		KeyReuseWindowSeconds: DefaultKeyReuseWindowSeconds,
		WebSearch:             true,
		Concurrency:           4,
		LeaseSize:             DefaultLeaseSize,
		SyncIntervalSeconds:   300,
	}, nil
}

func validOrigin(raw string) bool {
	u, err := url.Parse(raw)
	if err != nil || u.Hostname() == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || strings.Trim(u.Path, "/") != "" {
		return false
	}
	if u.Scheme == "https" {
		return true
	}
	if u.Scheme != "http" {
		return false
	}
	ip := net.ParseIP(u.Hostname())
	return u.Hostname() == "localhost" || (ip != nil && ip.IsLoopback())
}

// ValidModelID excludes whitespace and terminal control characters.
func ValidModelID(id string) bool {
	if len(id) == 0 || len(id) > 256 {
		return false
	}
	for _, r := range id {
		if r <= 32 || r >= 127 {
			return false
		}
	}
	return true
}

// Validate refuses anything that could widen the local API or send account
// material to an unintended origin.
func Validate(c Config) error {
	for name, value := range map[string]string{"org_url": c.OrgURL, "chat_url": c.ChatURL, "verifier_url": c.VerifierURL} {
		if !validOrigin(value) {
			return errors.New(name + " must be an HTTPS origin (HTTP only for loopback) without credentials, query or path")
		}
	}
	host, port, err := net.SplitHostPort(c.Listen)
	if err != nil {
		return errors.New("listen must be a numeric loopback IP and port")
	}
	number, err := strconv.Atoi(port)
	if err != nil || number < 1 || number > 65535 {
		return errors.New("listen port must be between 1 and 65535")
	}
	if ip := net.ParseIP(host); ip == nil || !ip.IsLoopback() {
		return errors.New("listen must be a numeric loopback IP; use an SSH tunnel for remote clients")
	}
	if len(c.APIKey) < 32 || strings.ContainsAny(c.APIKey, "\r\n ") {
		return errors.New("api_key must contain at least 32 non-space characters")
	}
	if c.DefaultModel != "" && !ValidModelID(c.DefaultModel) {
		return errors.New("invalid default model ID")
	}
	if c.KeyReuseWindowSeconds < 0 || c.KeyReuseWindowSeconds > MaxKeyReuseWindowSeconds {
		return errors.New("key_reuse_window_seconds must be between 0 and 300 (0 disables reuse)")
	}
	if c.Concurrency < 1 || c.Concurrency > 64 {
		return errors.New("concurrency must be between 1 and 64")
	}
	if c.LeaseSize < 1 || c.LeaseSize > MaxLeaseSize {
		return errors.New("ticket_lease_size must be between 1 and 500")
	}
	if c.SyncIntervalSeconds < 60 || c.SyncIntervalSeconds > 3600 {
		return errors.New("sync_interval_seconds must be between 60 and 3600")
	}
	if _, err := relay.NewClient(c.RelayURL); err != nil {
		return err
	}
	if err := c.Cover.Validate(c.RelayURL); err != nil {
		return err
	}
	return c.Rewriter.Validate()
}

// Save writes the profile atomically after validating it.
func Save(dir string, c Config) error {
	if err := Validate(c); err != nil {
		return err
	}
	if err := securefile.EnsureDir(dir); err != nil {
		return err
	}
	data, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return err
	}
	return securefile.WriteAtomic(filepath.Join(dir, configFile), append(data, '\n'))
}

// ErrMissing means no profile exists yet.
var ErrMissing = errors.New("oa-clientd is not set up; run oa-clientd setup")

// Load reads and validates the saved profile.
func Load(dir string) (Config, error) {
	if err := securefile.EnsureDir(dir); err != nil {
		return Config{}, err
	}
	data, err := securefile.Read(filepath.Join(dir, configFile), maxConfigBytes)
	if errors.Is(err, os.ErrNotExist) {
		return Config{}, ErrMissing
	}
	if err != nil {
		return Config{}, err
	}
	var c Config
	decoder := json.NewDecoder(strings.NewReader(string(data)))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&c); err != nil {
		return Config{}, errors.New("config.json is invalid")
	}
	if err := Validate(c); err != nil {
		return Config{}, err
	}
	return c, nil
}
