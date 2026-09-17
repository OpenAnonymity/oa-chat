package config

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/OpenAnonymity/oa-chat/daemon/internal/relay"
)

type ZKAPI struct {
	ClientURL         string `json:"client_url"`
	BridgeToken       string `json:"bridge_token"`
	Network           string `json:"network"`
	Binary            string `json:"binary,omitempty"`
	ProofSetupDir     string `json:"proof_setup_dir,omitempty"`
	ExternalCompanion bool   `json:"external_companion,omitempty"`
}

type Config struct {
	Listen      string `json:"listen"`
	APIKey      string `json:"api_key"`
	Backend     string `json:"backend"`
	OrgURL      string `json:"org_url"`
	VerifierURL string `json:"verifier_url"`
	RelayURL    string `json:"relay_url"`
	Concurrency int    `json:"concurrency"`
	ZKAPI       ZKAPI  `json:"zkapi"`
}

func DefaultDir() (string, error) {
	if dir := os.Getenv("OA_CHAT_CONFIG_DIR"); dir != "" {
		return filepath.Abs(dir)
	}
	base, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(base, "oa-chat"), nil
}

func Secret() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}

func Default() (Config, error) {
	key, err := Secret()
	if err != nil {
		return Config{}, err
	}
	bridge, err := Secret()
	return Config{Listen: "127.0.0.1:8787", APIKey: key, Backend: "ticket", OrgURL: "https://org.openanonymity.ai", VerifierURL: "https://verifier2.openanonymity.ai", RelayURL: relay.DefaultURL, Concurrency: 4, ZKAPI: ZKAPI{ClientURL: "http://127.0.0.1:8790", BridgeToken: bridge, Network: "mainnet"}}, err
}

func Validate(c Config) error {
	host, port, err := net.SplitHostPort(c.Listen)
	if err != nil || port == "" {
		return errors.New("listen must be a loopback IP and port")
	}
	if number, err := strconv.Atoi(port); err != nil || number < 1 || number > 65535 {
		return errors.New("listen port must be between 1 and 65535")
	}
	ip := net.ParseIP(host)
	if ip == nil || !ip.IsLoopback() {
		return errors.New("listen must be a numeric loopback IP; use a shared Docker network namespace or an SSH tunnel for remote clients")
	}
	if len(c.APIKey) < 32 || strings.ContainsAny(c.APIKey, "\r\n ") {
		return errors.New("api_key must contain at least 32 non-space characters")
	}
	if c.Backend != "ticket" && c.Backend != "zkapi" {
		return errors.New("backend must be ticket or zkapi")
	}
	if c.Concurrency < 1 || c.Concurrency > 64 {
		return errors.New("concurrency must be between 1 and 64")
	}
	for _, endpoint := range []string{c.OrgURL, c.VerifierURL} {
		u, err := url.Parse(endpoint)
		if err != nil || u.Scheme != "https" || u.Hostname() == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || (u.Path != "" && u.Path != "/") {
			return errors.New("org_url and verifier_url must be HTTPS origins without credentials, query, or path")
		}
	}
	if _, err := relay.NewClient(c.RelayURL); err != nil {
		return err
	}
	if c.ZKAPI.Network != "mainnet" && c.ZKAPI.Network != "sepolia" {
		return errors.New("ZKAPI network must be mainnet or sepolia")
	}
	if len(c.ZKAPI.BridgeToken) < 32 {
		return errors.New("ZKAPI bridge_token must have at least 32 characters")
	}
	u, err := url.Parse(c.ZKAPI.ClientURL)
	if err != nil || u.Scheme != "http" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || u.Path != "" {
		return errors.New("ZKAPI client_url must be a local HTTP origin")
	}
	if ip := net.ParseIP(u.Hostname()); ip == nil || !ip.IsLoopback() {
		return errors.New("ZKAPI client_url must use a numeric loopback IP")
	}
	return nil
}

func Init(dir string, c Config) error {
	if err := Validate(c); err != nil {
		return err
	}
	if err := EnsureDir(dir); err != nil {
		return err
	}
	data, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return err
	}
	// O_EXCL means init never overwrites an existing wallet configuration.
	f, err := os.OpenFile(filepath.Join(dir, "config.json"), os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return errors.New("configuration already exists or cannot be created")
	}
	defer f.Close()
	if _, err := f.Write(append(data, '\n')); err != nil {
		return err
	}
	if err := f.Sync(); err != nil {
		return err
	}
	return syncDir(dir)
}

func EnsureDir(dir string) error {
	if err := os.MkdirAll(dir, 0700); err != nil {
		return err
	}
	info, err := os.Lstat(dir)
	if err != nil {
		return err
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return errors.New("config directory must be a real directory")
	}
	if info.Mode().Perm()&0077 != 0 {
		return fmt.Errorf("config directory must be private: chmod 700 %q", dir)
	}
	return nil
}

func Load(dir string) (Config, error) {
	if err := EnsureDir(dir); err != nil {
		return Config{}, err
	}
	path := filepath.Join(dir, "config.json")
	info, err := os.Lstat(path)
	if err != nil {
		return Config{}, errors.New("configuration missing; run oa-chat init first")
	}
	if !info.Mode().IsRegular() || info.Mode().Perm()&0077 != 0 {
		return Config{}, errors.New("config.json must be a regular owner-only file (chmod 600)")
	}
	f, err := os.Open(path)
	if err != nil {
		return Config{}, err
	}
	defer f.Close()
	var c Config
	d := json.NewDecoder(io.LimitReader(f, 1<<20))
	d.DisallowUnknownFields()
	if err := d.Decode(&c); err != nil {
		return Config{}, errors.New("invalid config.json; check the configuration field names and values")
	}
	var trailing any
	if d.Decode(&trailing) != io.EOF {
		return Config{}, errors.New("config.json must contain one JSON object")
	}
	return c, Validate(c)
}

func syncDir(dir string) error {
	f, err := os.Open(dir)
	if err != nil {
		return err
	}
	defer f.Close()
	return f.Sync()
}
