package zkapi

import (
	"crypto/sha256"
	"embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

// These public manifests match the reviewed frontend deployment profiles. A
// mutable remote manifest must not silently change the vault, signer or oracle
// that owns an existing wallet. Updating deployments requires a source release.
//
//go:embed deployments/*.json
var deploymentFiles embed.FS

type deploymentIdentity struct {
	ID       string             `json:"deployment_id"`
	ChainID  uint64             `json:"chain_id"`
	Contract string             `json:"contract_address"`
	Asset    string             `json:"billing_asset"`
	Unit     string             `json:"billing_unit"`
	Proof    proofSetupIdentity `json:"proof_setup"`
	Privacy  struct {
		IssuerURL string `json:"issuer_url"`
	} `json:"privacy_mode"`
}

type proofSetupIdentity struct {
	Circuit                      string `json:"circuit_id"`
	RequestProvingKeySHA256      string `json:"request_proving_key_sha256"`
	RequestVerifyingKeySHA256    string `json:"request_verifying_key_sha256"`
	WithdrawalProvingKeySHA256   string `json:"withdrawal_proving_key_sha256"`
	WithdrawalVerifyingKeySHA256 string `json:"withdrawal_verifying_key_sha256"`
}

// MatchesDeployment checks a public management response against this release's
// immutable network/vault identity without a network read or wallet operation.
func MatchesDeployment(network, deploymentID, contract string) bool {
	deployment, _, err := pinnedDeployment(network)
	return err == nil && deployment.ID == deploymentID && strings.EqualFold(deployment.Contract, contract)
}

func pinnedDeployment(network string) (deploymentIdentity, []byte, error) {
	if network == "" {
		network = "mainnet"
	}
	chain, err := ChainID(network)
	if err != nil {
		return deploymentIdentity{}, nil, err
	}
	raw, err := deploymentFiles.ReadFile("deployments/" + network + ".json")
	var identity deploymentIdentity
	if err != nil || json.Unmarshal(raw, &identity) != nil || identity.ChainID != chain || identity.ID == "" || identity.Asset != "native_eth" || identity.Unit != "gwei" || identity.Proof.Circuit != "zkapi-v2-note-bound-v1" {
		return deploymentIdentity{}, nil, errors.New("invalid packaged zkAPI deployment")
	}
	return identity, raw, nil
}

// The companion reads this local, package-pinned manifest. It still validates
// its contents and local proving keys before opening any wallet state.
func writeDeploymentManifest(dir string, raw []byte) (string, error) {
	path := filepath.Join(dir, "deployment-manifest.json")
	if info, err := os.Lstat(path); err == nil {
		if !info.Mode().IsRegular() || info.Mode().Perm() != 0600 {
			return "", errors.New("zkAPI deployment manifest must be a private regular file")
		}
		saved, err := os.ReadFile(path)
		if err != nil || string(saved) != string(raw) {
			return "", errors.New("saved zkAPI deployment differs from this release; preserve the wallet and use a separate configuration directory")
		}
		return path, nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return "", errors.New("cannot read saved zkAPI deployment")
	}
	f, err := os.CreateTemp(dir, ".deployment-*")
	if err != nil {
		return "", err
	}
	defer os.Remove(f.Name())
	if err = f.Chmod(0600); err == nil {
		_, err = f.Write(raw)
	}
	if err == nil {
		err = f.Sync()
	}
	closeErr := f.Close()
	if err == nil {
		err = closeErr
	}
	if err == nil {
		err = os.Rename(f.Name(), path)
	}
	if err == nil {
		err = syncDirectoryChain(dir)
	}
	return path, err
}

// Validate the installed proving assets before the companion opens its wallet.
// A structurally valid key for another setup is not evidence for the pinned
// vault: all four artifacts must match the immutable deployment manifest.
func verifyProofSetup(setupDir string, proof proofSetupIdentity) error {
	files := []struct{ name, digest string }{
		{"request.pk", proof.RequestProvingKeySHA256},
		{"request.vk", proof.RequestVerifyingKeySHA256},
		{"withdrawal.pk", proof.WithdrawalProvingKeySHA256},
		{"withdrawal.vk", proof.WithdrawalVerifyingKeySHA256},
	}
	for _, asset := range files {
		if decoded, err := hex.DecodeString(asset.digest); err != nil || len(decoded) != sha256.Size || asset.digest != hex.EncodeToString(decoded) {
			return fmt.Errorf("zkAPI proving setup pin for %s is invalid", asset.name)
		}
		path := filepath.Join(setupDir, asset.name)
		info, err := os.Stat(path)
		if err != nil || !info.Mode().IsRegular() {
			return fmt.Errorf("zkAPI proving setup file %s is missing or not regular", asset.name)
		}
		file, err := os.Open(path)
		if err != nil {
			return fmt.Errorf("cannot read zkAPI proving setup file %s", asset.name)
		}
		info, statErr := file.Stat()
		if statErr != nil || !info.Mode().IsRegular() {
			_ = file.Close()
			return fmt.Errorf("zkAPI proving setup file %s is not regular", asset.name)
		}
		hash := sha256.New()
		_, readErr := io.Copy(hash, file)
		closeErr := file.Close()
		if readErr != nil || closeErr != nil || hex.EncodeToString(hash.Sum(nil)) != asset.digest {
			return fmt.Errorf("zkAPI proving setup file %s does not match the deployment SHA-256 pin", asset.name)
		}
	}
	return nil
}
