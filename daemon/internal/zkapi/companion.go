package zkapi

import (
	"context"
	"errors"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
)

// CompanionConfig controls the pinned Rust wallet/prover process. Production
// uses Ethereum mainnet; no automatic funding transaction is ever submitted.
type CompanionConfig struct {
	ProxyURL    string `json:"-"` // authenticated local CONNECT proxy over the anonymity relay
	Binary      string `json:"binary"`
	SetupDir    string `json:"setup_dir"`
	StateDir    string `json:"state_dir"`
	VerifierURL string `json:"verifier_url"`
}

// CompanionCommand creates a supervised child process; the caller owns its
// stdout/stderr, Start, Wait and termination. StateDir is separated by network.
func CompanionCommand(ctx context.Context, config Config, companion CompanionConfig) (*exec.Cmd, error) {
	if _, err := New(config); err != nil {
		return nil, err
	}
	if config.ClientURL == "" {
		config.ClientURL = DefaultClientURL
	}
	if config.Network == "" {
		config.Network = "mainnet"
	}
	if config.InferenceBaseURL == "" {
		config.InferenceBaseURL = DefaultInferenceBaseURL
	}
	if companion.Binary == "" {
		companion.Binary = "oa-zkapi"
	}
	proxy, err := url.Parse(companion.ProxyURL)
	if err != nil || proxy.User == nil || proxy.User.Username() == "" {
		return nil, errors.New("zkAPI companion requires an authenticated loopback anonymity proxy")
	}
	proxyOrigin := *proxy
	proxyOrigin.User = nil
	if err := validateLoopbackURL(proxyOrigin.String()); err != nil {
		return nil, err
	}
	binary, err := exec.LookPath(companion.Binary)
	if err != nil {
		return nil, errors.New("oa-zkapi companion is not installed; install the zkAPI package or set zkapi companion binary")
	}
	if companion.SetupDir == "" {
		resolved, err := filepath.EvalSymlinks(binary)
		if err != nil {
			return nil, err
		}
		companion.SetupDir = filepath.Join(filepath.Dir(resolved), "..", "share", "oa-chat", "proof-setup")
	}
	info, err := os.Stat(companion.SetupDir)
	if err != nil || !info.IsDir() {
		return nil, errors.New("zkAPI proving setup directory is missing")
	}
	if companion.StateDir == "" {
		return nil, errors.New("zkAPI companion requires a private state directory")
	}
	stateDir := filepath.Join(companion.StateDir, config.Network)
	if err := os.MkdirAll(stateDir, 0700); err != nil {
		return nil, err
	}
	if err := os.Chmod(stateDir, 0700); err != nil {
		return nil, err
	}
	if err := syncDirectoryChain(stateDir); err != nil {
		return nil, errors.New("cannot sync private companion directory")
	}
	if companion.VerifierURL == "" {
		companion.VerifierURL = "https://verifier2.openanonymity.ai"
	}
	verifier, err := url.Parse(companion.VerifierURL)
	if err != nil || verifier.Scheme != "https" || verifier.Host == "" || verifier.User != nil || verifier.RawQuery != "" || verifier.Fragment != "" {
		return nil, errors.New("zkAPI verifier must be HTTPS")
	}
	deployment, _ := Manifest(config.Network)
	clientURL, _ := url.Parse(config.ClientURL)
	args := []string{"--require-oa-org-key-source", "--oa-verifier-url", companion.VerifierURL, "--openrouter-inference-base", config.InferenceBaseURL, "client", "--deployment", deployment, "--mode", "direct-openrouter", "--no-fund", "--listen", clientURL.Host, "--state-dir", stateDir}
	cmd := exec.CommandContext(ctx, binary, args...)
	// Explicit environment overrides prevent inherited testnet or legacy mode
	// settings from silently changing the network and verification policy.
	drop := []string{"OA_ZKAPI_BRIDGE_TOKEN=", "OA_ZKAPI_CHAIN_ID=", "ZKAPI_PROOF_SETUP_DIR=", "ZKAPI_REQUIRE_OA_ORG_KEY_SOURCE=", "HTTP_PROXY=", "HTTPS_PROXY=", "ALL_PROXY=", "NO_PROXY=", "http_proxy=", "https_proxy=", "all_proxy=", "no_proxy="}
	for _, entry := range os.Environ() {
		keep := true
		for _, prefix := range drop {
			if strings.HasPrefix(entry, prefix) {
				keep = false
				break
			}
		}
		if keep {
			cmd.Env = append(cmd.Env, entry)
		}
	}
	chain, _ := ChainID(config.Network)
	cmd.Env = append(cmd.Env, "OA_ZKAPI_BRIDGE_TOKEN="+config.BridgeToken, "OA_ZKAPI_CHAIN_ID="+strconv.FormatUint(chain, 10), "ZKAPI_PROOF_SETUP_DIR="+companion.SetupDir, "ZKAPI_REQUIRE_OA_ORG_KEY_SOURCE=true")
	for _, name := range []string{"HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"} {
		cmd.Env = append(cmd.Env, name+"="+companion.ProxyURL)
	}
	cmd.Env = append(cmd.Env, "NO_PROXY=", "no_proxy=")
	return cmd, nil
}
