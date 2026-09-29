package zkapi

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestNativeDeploymentManifestsMatchReviewedBrowserProfiles(t *testing.T) {
	for _, network := range []string{"mainnet", "sepolia"} {
		t.Run(network, func(t *testing.T) {
			identity, raw, err := pinnedDeployment(network)
			if err != nil {
				t.Fatal(err)
			}
			var manifest map[string]any
			if err := json.Unmarshal(raw, &manifest); err != nil {
				t.Fatal(err)
			}
			profileRaw, err := os.ReadFile(filepath.Join("..", "..", "..", "deployments", "zkapi", "fresh-20260928", network+".json"))
			if err != nil {
				t.Fatal(err)
			}
			var profile struct {
				Trusted     map[string]any `json:"trusted_deployment"`
				ManifestURL string         `json:"deployment_manifest_url"`
			}
			if err := json.Unmarshal(profileRaw, &profile); err != nil {
				t.Fatal(err)
			}
			for _, field := range []string{"deployment_id", "chain_id", "contract_address", "billing_asset", "billing_unit", "billing_token_address", "native_asset_wei_per_unit", "native_price_feed_address", "native_price_feed_decimals", "native_price_max_age_seconds", "protocol_server_url", "indexer_url", "rpc_url", "request_charge_cap", "state_signing_key", "clearance_signing_key"} {
				if !reflect.DeepEqual(manifest[field], profile.Trusted[field]) {
					t.Errorf("%s differs from reviewed browser profile", field)
				}
			}
			proof := manifest["proof_setup"].(map[string]any)
			for _, field := range []string{"circuit_id", "request_proving_key_sha256", "withdrawal_proving_key_sha256"} {
				if proof[field] != profile.Trusted[field] {
					t.Errorf("%s differs from reviewed browser proof pin", field)
				}
			}
			privacy := manifest["privacy_mode"].(map[string]any)
			if privacy["verifier_url"] != profile.Trusted["verifier_url"] || privacy["openrouter_inference_base"] != profile.Trusted["openrouter_inference_base"] || privacy["ephemeral_key_source"] != "oa_org" {
				t.Fatal("deployment changed OA issuer/verifier boundary")
			}
			expectedURL, err := Manifest(network)
			if err != nil || expectedURL != profile.ManifestURL || manifest["config_url"] != expectedURL {
				t.Fatal("deployment manifest URL does not match reviewed origin")
			}
			if identity.Asset != "native_eth" || identity.Unit != "gwei" || identity.Proof.Circuit != "zkapi-v2-note-bound-v1" {
				t.Fatal("wrong native deployment identity")
			}
		})
	}
	mainnet, mainnetRaw, err := pinnedDeployment("mainnet")
	if err != nil {
		t.Fatal(err)
	}
	fallback, fallbackRaw, err := pinnedDeployment("")
	if err != nil || mainnet != fallback || string(mainnetRaw) != string(fallbackRaw) {
		t.Fatal("empty network stopped selecting mainnet")
	}
	if _, _, err := pinnedDeployment("../sepolia"); err == nil {
		t.Fatal("unsupported network path accepted")
	}
}

func TestDeploymentManifestPersistenceIsPrivateAndNeverRebinds(t *testing.T) {
	_, raw, err := pinnedDeployment("sepolia")
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	path, err := writeDeploymentManifest(dir, raw)
	if err != nil {
		t.Fatal(err)
	}
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() || info.Mode().Perm() != 0600 {
		t.Fatal("manifest is not a private regular file")
	}
	before, err := os.ReadFile(path)
	if err != nil || string(before) != string(raw) {
		t.Fatal("saved manifest differs from pin")
	}
	if again, err := writeDeploymentManifest(dir, raw); err != nil || again != path {
		t.Fatalf("same deployment did not resume: %v", err)
	}
	_, other, err := pinnedDeployment("mainnet")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := writeDeploymentManifest(dir, other); err == nil {
		t.Fatal("existing manifest silently rebound")
	}
	after, _ := os.ReadFile(path)
	if string(before) != string(after) {
		t.Fatal("mismatch overwrote existing manifest")
	}
}

func TestDeploymentManifestRejectsSymlinksAndUnsafeFiles(t *testing.T) {
	_, raw, err := pinnedDeployment("sepolia")
	if err != nil {
		t.Fatal(err)
	}
	for _, kind := range []string{"symlink", "public", "directory", "malformed"} {
		t.Run(kind, func(t *testing.T) {
			dir := t.TempDir()
			path := filepath.Join(dir, "deployment-manifest.json")
			target := filepath.Join(dir, "original.json")
			switch kind {
			case "symlink":
				if err := os.WriteFile(target, raw, 0600); err != nil {
					t.Fatal(err)
				}
				if err := os.Symlink(target, path); err != nil {
					t.Fatal(err)
				}
			case "public":
				if err := os.WriteFile(path, raw, 0644); err != nil {
					t.Fatal(err)
				}
				if err := os.Chmod(path, 0644); err != nil {
					t.Fatal(err)
				}
			case "directory":
				if err := os.Mkdir(path, 0700); err != nil {
					t.Fatal(err)
				}
			case "malformed":
				if err := os.WriteFile(path, []byte(`{"deployment_id":"unrelated"}`), 0600); err != nil {
					t.Fatal(err)
				}
			}
			if _, err := writeDeploymentManifest(dir, raw); err == nil {
				t.Fatalf("accepted %s manifest", kind)
			}
			if kind == "symlink" {
				info, err := os.Lstat(path)
				contents, readErr := os.ReadFile(target)
				if err != nil || info.Mode()&os.ModeSymlink == 0 || readErr != nil || string(contents) != string(raw) {
					t.Fatal("refusal modified symlink or target")
				}
			}
			if kind == "malformed" {
				contents, _ := os.ReadFile(path)
				if !strings.Contains(string(contents), "unrelated") {
					t.Fatal("refusal overwrote recovery manifest")
				}
			}
		})
	}
}

func testProofSetup(t *testing.T) (string, proofSetupIdentity) {
	t.Helper()
	dir := t.TempDir()
	hashes := make(map[string]string)
	for _, name := range []string{"request.pk", "request.vk", "withdrawal.pk", "withdrawal.vk"} {
		contents := []byte("distinct test proving artifact " + name)
		if err := os.WriteFile(filepath.Join(dir, name), contents, 0600); err != nil {
			t.Fatal(err)
		}
		digest := sha256.Sum256(contents)
		hashes[name] = hex.EncodeToString(digest[:])
	}
	return dir, proofSetupIdentity{Circuit: "zkapi-v2-note-bound-v1", RequestProvingKeySHA256: hashes["request.pk"], RequestVerifyingKeySHA256: hashes["request.vk"], WithdrawalProvingKeySHA256: hashes["withdrawal.pk"], WithdrawalVerifyingKeySHA256: hashes["withdrawal.vk"]}
}

func TestProofSetupRequiresEveryPinnedArtifact(t *testing.T) {
	dir, proof := testProofSetup(t)
	if err := verifyProofSetup(dir, proof); err != nil {
		t.Fatalf("matching setup rejected: %v", err)
	}
	for _, name := range []string{"request.pk", "request.vk", "withdrawal.pk", "withdrawal.vk"} {
		for _, mutation := range []string{"modified", "missing", "directory"} {
			t.Run(name+"/"+mutation, func(t *testing.T) {
				dir, proof := testProofSetup(t)
				path := filepath.Join(dir, name)
				switch mutation {
				case "modified":
					if err := os.WriteFile(path, []byte("different proof setup"), 0600); err != nil {
						t.Fatal(err)
					}
				case "missing":
					if err := os.Remove(path); err != nil {
						t.Fatal(err)
					}
				case "directory":
					if err := os.Remove(path); err != nil {
						t.Fatal(err)
					}
					if err := os.Mkdir(path, 0700); err != nil {
						t.Fatal(err)
					}
				}
				if err := verifyProofSetup(dir, proof); err == nil || !strings.Contains(err.Error(), name) {
					t.Fatalf("%s %s accepted or wrong error: %v", mutation, name, err)
				}
			})
		}
	}
	for _, invalid := range []string{"", "abc", strings.Repeat("g", 64), strings.ToUpper(proof.RequestProvingKeySHA256)} {
		mutated := proof
		mutated.RequestProvingKeySHA256 = invalid
		if err := verifyProofSetup(dir, mutated); err == nil {
			t.Fatal("invalid artifact pin accepted")
		}
	}
}

func TestCompanionCommandChecksInstalledProofsBeforeCreatingWallet(t *testing.T) {
	binary, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	setupDir, _ := testProofSetup(t) // Valid files from a different setup must fail too.
	for _, dir := range []string{t.TempDir(), setupDir} {
		stateDir := filepath.Join(t.TempDir(), "must-not-exist")
		cmd, err := CompanionCommand(context.Background(), Config{Network: "sepolia", BridgeToken: testBridgeToken, HTTPClient: &http.Client{}}, CompanionConfig{Binary: binary, SetupDir: dir, StateDir: stateDir, ProxyURL: "http://bridge:private-local-token@127.0.0.1:8791"})
		if err == nil || cmd != nil || !strings.Contains(err.Error(), "request.pk") {
			t.Fatalf("companion did not reject wrong installed proofs: %v", err)
		}
		if _, err := os.Stat(stateDir); !os.IsNotExist(err) {
			t.Fatal("invalid setup created or opened private wallet state")
		}
	}
}

func TestMatchesDeploymentUsesExactNetworkIDAndVault(t *testing.T) {
	for _, network := range []string{"mainnet", "sepolia"} {
		deployment, _, err := pinnedDeployment(network)
		if err != nil {
			t.Fatal(err)
		}
		if !MatchesDeployment(network, deployment.ID, strings.ToLower(deployment.Contract)) {
			t.Fatal("matching deployment rejected")
		}
		if MatchesDeployment("unknown", deployment.ID, deployment.Contract) || MatchesDeployment(network, deployment.ID+"-other", deployment.Contract) || MatchesDeployment(network, deployment.ID, "0x1111111111111111111111111111111111111111") {
			t.Fatal("mismatched deployment accepted")
		}
	}
}
