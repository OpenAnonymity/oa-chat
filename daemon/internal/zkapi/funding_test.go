package zkapi

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestFundingCapabilityOriginAndNoThirdPartyScripts(t *testing.T) {
	upstream := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	defer upstream.Close()
	client := newTestClient(t, func(w http.ResponseWriter, r *http.Request) { _, _ = io.WriteString(w, `{"has_note":false}`) }, upstream)
	handler, err := NewFundingHandler(client, "http://127.0.0.1:8787", t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	link, err := handler.NewSession()
	if err != nil {
		t.Fatal(err)
	}
	u, _ := url.Parse(link)
	for _, scenario := range []struct {
		name, origin, host, token string
		status                    int
	}{
		{"no token", "", "127.0.0.1:8787", "", 401},
		{"malicious origin", "https://attacker.invalid", "127.0.0.1:8787", u.Fragment, 403},
		{"dns rebinding", "", "attacker.invalid", u.Fragment, 403},
		{"authorized", u.Scheme + "://" + u.Host, "127.0.0.1:8787", u.Fragment, 200},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			req := httptest.NewRequest("GET", "http://127.0.0.1:8787/funding/api/status", nil)
			req.Host = scenario.host
			req.Header.Set("Origin", scenario.origin)
			req.Header.Set("Authorization", "Bearer "+scenario.token)
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, req)
			if response.Code != scenario.status {
				t.Fatalf("got %d: %s", response.Code, response.Body.String())
			}
		})
	}
	req := httptest.NewRequest("GET", "http://127.0.0.1:8787/funding", nil)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, req)
	if strings.Contains(response.Body.String(), "https://") || strings.Contains(response.Body.String(), "cdn") {
		t.Fatal("funding page loads external assets")
	}
	if !strings.Contains(response.Header().Get("Content-Security-Policy"), "connect-src 'self'") {
		t.Fatal("funding connect policy missing")
	}
}

func TestPreparePersistsSecretAndNeverSendsItToBrowser(t *testing.T) {
	upstream := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	defer upstream.Close()
	var generated atomic.Int32
	client := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/funding/config":
			_ = json.NewEncoder(w).Encode(map[string]any{"chain_id": 1, "contract_address": "0x1111111111111111111111111111111111111111", "demo_billing_token_address": "0x2222222222222222222222222222222222222222", "demo_rpc_url": upstream.URL, "demo_private_key": "must never leave companion"})
		case "/wallet/status":
			_, _ = io.WriteString(w, `{"has_note":false}`)
		case "/funding/api/deposit/prepare":
			generated.Add(1)
			path := make([]string, 32)
			for i := range path {
				path[i] = "0x0"
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"amount": 100000, "secret": "0xabcdef", "commitment": "0x1234", "zero_path": path})
		default:
			t.Errorf("unexpected path: %s", r.URL.Path)
		}
	}, upstream)
	handler, err := NewFundingHandler(client, "http://127.0.0.1:8787", t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	result, err := handler.prepare(context.Background(), 100000)
	if err != nil {
		t.Fatal(err)
	}
	exposed, _ := json.Marshal(result)
	if strings.Contains(string(exposed), "secret") || strings.Contains(string(exposed), "abcdef") {
		t.Fatal("note secret exposed to browser")
	}
	persisted, err := os.ReadFile(handler.statePath)
	if err != nil || !strings.Contains(string(persisted), "abcdef") {
		t.Fatal("secret not persisted before response")
	}
	info, _ := os.Stat(handler.statePath)
	if info.Mode().Perm() != 0600 {
		t.Fatal("note recovery file permissions")
	}
	_, err = handler.prepare(context.Background(), 100000)
	if err != nil {
		t.Fatal(err)
	}
	if generated.Load() != 1 {
		t.Fatal("reload generated a new secret and abandoned previous deposit")
	}
	if _, err = handler.prepare(context.Background(), 200000); err == nil {
		t.Fatal("pending amount silently replaced")
	}
	cfg, err := handler.config(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	cfgData, _ := json.Marshal(cfg)
	if strings.Contains(string(cfgData), "private_key") {
		t.Fatal("demo private key exposed")
	}
}

func TestDemoMintEnabledOnlyForAdvertisedSepoliaDeployment(t *testing.T) {
	for _, scenario := range []struct {
		name    string
		network string
		chain   uint64
		flag    any
		want    bool
		wantErr bool
	}{
		{"Sepolia enabled", "sepolia", 11155111, true, true, false},
		{"Sepolia disabled", "sepolia", 11155111, false, false, false},
		{"mainnet flag ignored", "mainnet", 1, true, false, false},
		{"non-boolean flag rejected", "sepolia", 11155111, "true", false, true},
		{"wrong deployment chain rejected", "mainnet", 11155111, true, false, true},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			local := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Header.Get("Authorization") != "Bearer "+testBridgeToken {
					t.Error("missing companion authentication")
					w.WriteHeader(http.StatusUnauthorized)
					return
				}
				switch r.URL.Path {
				case "/oa/v1/status":
					expectedChain, _ := ChainID(scenario.network)
					_ = json.NewEncoder(w).Encode(map[string]any{"bridge_version": 1, "chain_id": expectedChain, "mode": "direct_openrouter", "require_oa_org_key_source": true})
				case "/funding/config":
					_ = json.NewEncoder(w).Encode(map[string]any{"chain_id": scenario.chain, "contract_address": "0x1111111111111111111111111111111111111111", "demo_billing_token_address": "0x2222222222222222222222222222222222222222", "demo_rpc_url": "https://rpc.example", "demo_mint_enabled": scenario.flag})
				default:
					t.Errorf("unexpected companion request: %s", r.URL.Path)
				}
			}))
			defer local.Close()
			client, err := New(Config{ClientURL: local.URL, BridgeToken: testBridgeToken, Network: scenario.network, HTTPClient: &http.Client{}})
			if err != nil {
				t.Fatal(err)
			}
			handler, err := NewFundingHandler(client, "http://127.0.0.1:8787", t.TempDir())
			if err != nil {
				t.Fatal(err)
			}
			config, err := handler.config(context.Background())
			if scenario.wantErr {
				if err == nil {
					t.Fatal("invalid funding configuration accepted")
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if config.DemoMintEnabled != scenario.want {
				t.Fatalf("mint enabled = %v, want %v", config.DemoMintEnabled, scenario.want)
			}
		})
	}
}

func sampleReceipt(record depositRecord) ethReceipt {
	raw := fmt.Sprintf(`{"status":"0x1","to":%q,"logs":[{"address":%q,"topics":[%q,"0x%064x","0x%064x"],"data":"0x%064x%064x%064x"}]}`, record.Contract, record.Contract, depositEventTopic, 12, 0x1234, record.Amount, time.Now().Unix()+3600, 0)
	var receipt ethReceipt
	_ = json.Unmarshal([]byte(raw), &receipt)
	return receipt
}
func TestDepositReceiptRequiresMatchingVaultCommitmentAmountAndSuccess(t *testing.T) {
	record := depositRecord{Contract: "0x1111111111111111111111111111111111111111", Commitment: "0x1234", Amount: 100000}
	for _, destination := range []string{record.Contract, "0xdb9b1e94b5b69df7e401ddbede43491141047db3"} {
		valid := sampleReceipt(record)
		valid.To = destination
		valid.Logs = append(valid.Logs, valid.Logs[0])
		valid.Logs[0].Address = "0x2222222222222222222222222222222222222222"
		if note, _, err := validateReceipt(valid, record); err != nil || note != 12 {
			t.Fatalf("valid vault event via outer destination %s rejected: %v", destination, err)
		}
	}
	for _, mutation := range []string{"reverted", "log address", "event topic", "commitment", "amount", "note overflow", "expired", "no event", "malformed"} {
		receipt := sampleReceipt(record)
		receipt.To = "0xdb9b1e94b5b69df7e401ddbede43491141047db3"
		switch mutation {
		case "reverted":
			receipt.Status = "0x0"
		case "log address":
			receipt.Logs[0].Address = receipt.To // A wrapper cannot impersonate the vault emitter.
		case "event topic":
			receipt.Logs[0].Topics[0] = "0x" + strings.Repeat("0", 64)
		case "commitment":
			receipt.Logs[0].Topics[2] = fmt.Sprintf("0x%064x", 9)
		case "amount":
			receipt.Logs[0].Data = fmt.Sprintf("0x%064x%064x%064x", 1, time.Now().Unix()+3600, 0)
		case "note overflow":
			receipt.Logs[0].Topics[1] = fmt.Sprintf("0x%064x", uint64(1)<<32)
		case "expired":
			receipt.Logs[0].Data = fmt.Sprintf("0x%064x%064x%064x", record.Amount, time.Now().Unix()-1, 0)
		case "no event":
			receipt.Logs = nil
		case "malformed":
			receipt.Logs[0].Data = "0xff"
		}
		if _, _, err := validateReceipt(receipt, record); err == nil {
			t.Errorf("accepted %s event", mutation)
		}
	}
}

func TestWrappedDepositReceiptRetainsTransactionHashBinding(t *testing.T) {
	record := depositRecord{Contract: "0x1111111111111111111111111111111111111111", Commitment: "0x1234", Amount: 100000}
	requested := "0x" + strings.Repeat("a", 64)
	for _, returned := range []string{requested, "0x" + strings.Repeat("b", 64)} {
		t.Run(returned, func(t *testing.T) {
			upstream := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				receipt := sampleReceipt(record)
				receipt.To = "0xdb9b1e94b5b69df7e401ddbede43491141047db3"
				receipt.TransactionHash = returned
				_ = json.NewEncoder(w).Encode(map[string]any{"result": receipt})
			}))
			defer upstream.Close()
			client := newTestClient(t, func(http.ResponseWriter, *http.Request) {}, upstream)
			handler, err := NewFundingHandler(client, "http://127.0.0.1:8787", t.TempDir())
			if err != nil {
				t.Fatal(err)
			}
			receipt, err := handler.receipt(context.Background(), upstream.URL, requested)
			if returned != requested {
				if err == nil || !strings.Contains(err.Error(), "transaction mismatch") {
					t.Fatalf("mismatched receipt accepted: %v", err)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if _, _, err := validateReceipt(receipt, record); err != nil {
				t.Fatalf("matching wrapped receipt rejected: %v", err)
			}
		})
	}
}

func TestFundingConfirmationRetryDoesNotReinitializeSpentNote(t *testing.T) {
	record := depositRecord{ChainID: 1, Contract: "0x1111111111111111111111111111111111111111", Amount: 100000, Secret: "0x5678", Commitment: "0x1234"}
	hash := "0x" + strings.Repeat("a", 64)
	var confirmed atomic.Int32
	upstream := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		receipt := sampleReceipt(record)
		receipt.TransactionHash = hash
		_ = json.NewEncoder(w).Encode(map[string]any{"result": receipt})
	}))
	defer upstream.Close()
	client := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/funding/config":
			_ = json.NewEncoder(w).Encode(map[string]any{"chain_id": 1, "contract_address": record.Contract, "demo_billing_token_address": "0x2222222222222222222222222222222222222222", "demo_rpc_url": upstream.URL})
		case "/wallet/status":
			_, _ = io.WriteString(w, `{"has_note":true,"note":{"note_id":12,"current_balance":1}}`)
		case "/funding/api/deposit/confirm":
			confirmed.Add(1)
			_, _ = io.WriteString(w, `{}`)
		}
	}, upstream)
	handler, err := NewFundingHandler(client, "http://127.0.0.1:8787", t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if err = handler.save(record); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 2; i++ {
		if _, err := handler.confirm(context.Background(), hash); err != nil {
			t.Fatal(err)
		}
	}
	if confirmed.Load() != 0 {
		t.Fatal("reinitialized already spent note on browser retry")
	}
}

func TestWrongOrRevertedDepositHashCanBeCorrected(t *testing.T) {
	for _, scenario := range []string{"unknown", "reverted", "foreign"} {
		t.Run(scenario, func(t *testing.T) {
			record := depositRecord{ChainID: 1, Contract: "0x1111111111111111111111111111111111111111", Amount: 100000, Secret: "0x5678", Commitment: "0x1234"}
			wrong := "0x" + strings.Repeat("b", 64)
			correct := "0x" + strings.Repeat("c", 64)
			upstream := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				var request struct {
					Params []string `json:"params"`
				}
				_ = json.NewDecoder(r.Body).Decode(&request)
				receipt := sampleReceipt(record)
				receipt.TransactionHash = request.Params[0]
				if request.Params[0] == wrong {
					if scenario == "unknown" {
						_, _ = io.WriteString(w, `{"result":null}`)
						return
					}
					if scenario == "reverted" {
						receipt.Status = "0x0"
					} else {
						receipt.To = "0x2222222222222222222222222222222222222222"
						receipt.Logs[0].Address = receipt.To
					}
				}
				_ = json.NewEncoder(w).Encode(map[string]any{"result": receipt})
			}))
			defer upstream.Close()
			var confirmed atomic.Int32
			client := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
				switch r.URL.Path {
				case "/funding/config":
					_ = json.NewEncoder(w).Encode(map[string]any{"chain_id": 1, "contract_address": record.Contract, "demo_billing_token_address": "0x2222222222222222222222222222222222222222", "demo_rpc_url": upstream.URL})
				case "/wallet/status":
					_, _ = io.WriteString(w, `{"has_note":false}`)
				case "/funding/api/deposit/confirm":
					confirmed.Add(1)
					_, _ = io.WriteString(w, `{}`)
				}
			}, upstream)
			handler, _ := NewFundingHandler(client, "http://127.0.0.1:8787", t.TempDir())
			if err := handler.save(record); err != nil {
				t.Fatal(err)
			}
			if _, err := handler.confirm(context.Background(), wrong); err == nil {
				t.Fatal("wrong receipt accepted")
			}
			raw, _ := os.ReadFile(handler.statePath)
			var pending depositRecord
			_ = json.Unmarshal(raw, &pending)
			if pending.Secret != record.Secret {
				t.Fatal("lost recovery secret after wrong hash")
			}
			if scenario != "unknown" && pending.TransactionHash != "" {
				t.Fatal("demonstrably failed hash blocks resubmission")
			}
			if _, err := handler.confirm(context.Background(), correct); err != nil {
				t.Fatalf("could not correct deposit hash: %v", err)
			}
			if confirmed.Load() != 1 {
				t.Fatal("wrong deposit initialized wallet")
			}
		})
	}
}

func TestCompletedDepositIsArchivedBeforeNewNote(t *testing.T) {
	upstream := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	defer upstream.Close()
	client := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/funding/config":
			_ = json.NewEncoder(w).Encode(map[string]any{"chain_id": 1, "contract_address": "0x1111111111111111111111111111111111111111", "demo_billing_token_address": "0x2222222222222222222222222222222222222222", "demo_rpc_url": upstream.URL})
		case "/wallet/status":
			_, _ = io.WriteString(w, `{"has_note":false}`)
		case "/funding/api/deposit/prepare":
			path := make([]string, 32)
			for i := range path {
				path[i] = "0x0"
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"amount": 200000, "secret": "0x2222", "commitment": "0x3333", "zero_path": path})
		}
	}, upstream)
	handler, _ := NewFundingHandler(client, "http://127.0.0.1:8787", t.TempDir())
	prior := depositRecord{ChainID: 1, Contract: "0x1111111111111111111111111111111111111111", Amount: 100000, Secret: "0x1111", Commitment: "0x1234", TransactionHash: "0x" + strings.Repeat("f", 64), Active: true}
	if err := handler.save(prior); err != nil {
		t.Fatal(err)
	}
	result, err := handler.prepare(context.Background(), 200000)
	if err != nil {
		t.Fatal(err)
	}
	data, _ := json.Marshal(result)
	if !strings.Contains(string(data), "200000") {
		t.Fatal("new deposit not prepared")
	}
	archives, _ := filepath.Glob(handler.statePath + ".completed-*")
	if len(archives) != 1 {
		t.Fatal("prior note was not archived")
	}
	data, _ = os.ReadFile(archives[0])
	if !strings.Contains(string(data), "0x1111") {
		t.Fatal("prior recovery note lost")
	}
}

func TestDepositPathRefreshDoesNotExposeSecrets(t *testing.T) {
	upstream := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	defer upstream.Close()
	var invalid atomic.Bool
	client := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/oa/v1/deposit/path" {
			t.Fatal("unexpected path")
		}
		path := make([]string, 32)
		for i := range path {
			path[i] = "0xa"
		}
		if invalid.Load() {
			path[0] = "0x-1"
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"zero_path": path, "secret": "must-be-discarded"})
	}, upstream)
	handler, _ := NewFundingHandler(client, "http://127.0.0.1:8787", t.TempDir())
	result, err := handler.depositPath(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal(result)
	if strings.Contains(string(raw), "secret") {
		t.Fatal("secret exposed while refreshing path")
	}
	invalid.Store(true)
	if _, err = handler.depositPath(context.Background()); err == nil {
		t.Fatal("invalid field accepted")
	}
}
