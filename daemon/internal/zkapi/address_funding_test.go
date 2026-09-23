package zkapi

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"math/big"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/ethereum/go-ethereum/core/types"
)

const addressTestVault = "0x1111111111111111111111111111111111111111"
const addressTestToken = "0x2222222222222222222222222222222222222222"
const addressTestBlock = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

type addressFixture struct {
	mu                                                             sync.Mutex
	h                                                              *FundingHandler
	chain, decimals, gas, gasPrice, balance, eth, allowance, nonce string
	finalized, canonical                                           string
	accepted                                                       map[string]*types.Transaction
	receipts                                                       map[string]map[string]any
	submitted                                                      []string
	ambiguous                                                      bool
	active                                                         bool
	prepared, activated, paths                                     int
	rpcCalls                                                       []string
}

func newAddressFixture(t *testing.T) *addressFixture {
	t.Helper()
	f := &addressFixture{chain: "0x1", decimals: "0x6", gas: "0x10000", gasPrice: "0x3b9aca00", balance: "0xf4240", eth: "0xde0b6b3a7640000", allowance: "0x0", nonce: "0x0", finalized: "0x20", canonical: addressTestBlock, accepted: map[string]*types.Transaction{}, receipts: map[string]map[string]any{}}
	rpc := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		defer f.mu.Unlock()
		if r.Header.Get("Authorization") != "" || r.Header.Get("Cookie") != "" {
			t.Error("identity reached payment RPC")
		}
		if r.Method != http.MethodPost {
			t.Error("unexpected RPC method")
		}
		var request struct {
			ID     int               `json:"id"`
			Method string            `json:"method"`
			Params []json.RawMessage `json:"params"`
		}
		if json.NewDecoder(r.Body).Decode(&request) != nil {
			t.Error("invalid RPC request")
			return
		}
		f.rpcCalls = append(f.rpcCalls, request.Method)
		var result any
		switch request.Method {
		case "eth_chainId":
			result = f.chain
		case "eth_getBalance":
			result = f.eth
		case "eth_getTransactionCount":
			result = f.nonce
		case "eth_estimateGas":
			result = f.gas
		case "eth_gasPrice":
			result = f.gasPrice
		case "eth_call":
			var call struct {
				To   string `json:"to"`
				Data string `json:"data"`
			}
			_ = json.Unmarshal(request.Params[0], &call)
			if !strings.EqualFold(call.To, addressTestToken) {
				t.Error("unexpected token contract")
			}
			switch call.Data[:10] {
			case "0x313ce567":
				result = f.decimals
			case "0x70a08231":
				result = f.balance
			case "0xdd62ed3e":
				result = f.allowance
			default:
				t.Errorf("unexpected call %s", call.Data[:10])
			}
		case "eth_getTransactionReceipt":
			var hash string
			_ = json.Unmarshal(request.Params[0], &hash)
			if found, ok := f.receipts[hash]; ok {
				result = found
			}
		case "eth_getBlockByNumber":
			var number string
			_ = json.Unmarshal(request.Params[0], &number)
			if number == "finalized" {
				number = f.finalized
			}
			if number == "latest" {
				number = "0x20"
			}
			result = map[string]string{"number": number, "hash": f.canonical}
		case "eth_sendRawTransaction":
			var raw string
			_ = json.Unmarshal(request.Params[0], &raw)
			encoded, err := hex.DecodeString(strings.TrimPrefix(raw, "0x"))
			var tx types.Transaction
			if err != nil || tx.UnmarshalBinary(encoded) != nil {
				t.Error("invalid signed transaction")
				return
			}
			stored, err := os.ReadFile(f.h.addressStatePath())
			if err != nil {
				t.Error("transaction broadcast before durable journal")
				return
			}
			var journal addressFundingRecord
			_ = json.Unmarshal(stored, &journal)
			journaled := false
			for _, entry := range append(append([]addressTransaction{}, journal.History...), pendingAddressTransaction(journal.Pending)...) {
				if entry.Raw == raw && entry.Hash == tx.Hash().Hex() {
					journaled = true
				}
			}
			if !journaled {
				t.Error("broadcast does not match durable journal")
			}
			from, err := types.Sender(types.NewEIP155Signer(big.NewInt(1)), &tx)
			if err != nil || !strings.EqualFold(from.Hex(), journal.Address) || tx.Value().Sign() != 0 {
				t.Error("invalid EIP-155 signature or value")
			}
			f.accepted[tx.Hash().Hex()] = &tx
			f.submitted = append(f.submitted, raw)
			if f.ambiguous {
				w.WriteHeader(502)
				_, _ = io.WriteString(w, "do not expose raw signed transaction: "+raw)
				return
			}
			result = tx.Hash().Hex()
		default:
			t.Errorf("unexpected RPC %s", request.Method)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"jsonrpc": "2.0", "id": request.ID, "result": result})
	}))
	t.Cleanup(rpc.Close)
	client := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		defer f.mu.Unlock()
		switch r.URL.Path {
		case "/funding/config":
			_ = json.NewEncoder(w).Encode(map[string]any{"chain_id": 1, "contract_address": addressTestVault, "demo_billing_token_address": addressTestToken, "demo_rpc_url": rpc.URL})
		case "/wallet/status":
			_ = json.NewEncoder(w).Encode(map[string]any{"has_note": f.active, "note": map[string]any{"note_id": 12, "current_balance": 99999}})
		case "/funding/api/deposit/prepare":
			f.prepared++
			var input struct {
				Amount uint64 `json:"amount"`
			}
			_ = json.NewDecoder(r.Body).Decode(&input)
			path := make([]string, 32)
			for i := range path {
				path[i] = "0x0"
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"amount": input.Amount, "secret": "0xabcdef", "commitment": "0x1234", "zero_path": path})
		case "/oa/v1/deposit/path":
			f.paths++
			path := make([]string, 32)
			for i := range path {
				path[i] = "0xa"
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"zero_path": path})
		case "/funding/api/deposit/confirm":
			f.activated++
			f.active = true
			_, _ = io.WriteString(w, `{}`)
		default:
			t.Errorf("unexpected companion path %s", r.URL.Path)
		}
	}, rpc)
	var err error
	f.h, err = NewFundingHandler(client, "http://127.0.0.1:8787", t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	return f
}

func (f *addressFixture) mine(t *testing.T, hash string, reverted bool) {
	t.Helper()
	f.mu.Lock()
	defer f.mu.Unlock()
	tx := f.accepted[hash]
	if tx == nil {
		t.Fatal("transaction was not broadcast")
	}
	status := "0x1"
	if reverted {
		status = "0x0"
	}
	receipt := map[string]any{"transactionHash": hash, "status": status, "blockNumber": "0x10", "blockHash": addressTestBlock, "to": tx.To().Hex()}
	if !reverted {
		data := hex.EncodeToString(tx.Data())
		if strings.HasPrefix(data, "095ea7b3") {
			value, _ := new(big.Int).SetString(data[72:], 16)
			f.allowance = "0x" + value.Text(16)
		} else {
			amount, _ := new(big.Int).SetString(data[72:136], 16)
			record := depositRecord{Contract: addressTestVault, Commitment: "0x1234", Amount: amount.Uint64()}
			receipt["logs"] = sampleReceipt(record).Logs
			f.allowance = "0x0"
		}
	}
	f.nonce = fmt.Sprintf("0x%x", tx.Nonce()+1)
	f.receipts[hash] = receipt
}

func TestAddressFundingPersistsBeforeReturningAndSurvivesRestart(t *testing.T) {
	f := newAddressFixture(t)
	status, err := f.h.Address(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if status.Phase != "ready" || !isHex(status.Address, 20) || status.TokenBalance != "1000000" || status.ETHBalance != "1000000000000000000" {
		t.Fatalf("invalid public address status: %+v", status)
	}
	info, err := os.Stat(f.h.addressStatePath())
	if err != nil || info.Mode().Perm() != 0600 {
		t.Fatal("funding key was not durably saved privately")
	}
	raw, _ := os.ReadFile(f.h.addressStatePath())
	var saved addressFundingRecord
	_ = json.Unmarshal(raw, &saved)
	public, _ := json.Marshal(status)
	if strings.Contains(string(public), saved.PrivateKey) || strings.Contains(string(public), "private_key") {
		t.Fatal("private key exposed")
	}
	restarted := &FundingHandler{client: f.h.client, statePath: f.h.statePath}
	again, err := restarted.Address(context.Background())
	if err != nil || again.Address != status.Address {
		t.Fatalf("restart changed address: %v", err)
	}
	if len(f.submitted) != 0 {
		t.Fatal("read-only address lookup submitted a transaction")
	}
}

func TestAddressFundingPersistenceFailureExposesNoAddress(t *testing.T) {
	f := newAddressFixture(t)
	if err := os.Mkdir(f.h.addressStatePath(), 0700); err != nil {
		t.Fatal(err)
	}
	status, err := f.h.Address(context.Background())
	if err == nil || status.Address != "" || len(f.submitted) != 0 {
		t.Fatal("address escaped failed storage")
	}
}

func TestAddressFundingRejectsNetworkDecimalsAndDeploymentMismatch(t *testing.T) {
	for _, scenario := range []string{"chain", "decimals", "deployment", "permissions", "damaged key"} {
		t.Run(scenario, func(t *testing.T) {
			f := newAddressFixture(t)
			if _, err := f.h.Address(context.Background()); err != nil {
				t.Fatal(err)
			}
			f.mu.Lock()
			switch scenario {
			case "chain":
				f.chain = "0xaa36a7"
			case "decimals":
				f.decimals = "0x12"
			case "permissions":
				_ = os.Chmod(f.h.addressStatePath(), 0644)
			default:
				raw, _ := os.ReadFile(f.h.addressStatePath())
				var record addressFundingRecord
				_ = json.Unmarshal(raw, &record)
				if scenario == "deployment" {
					record.Token = addressTestVault
				} else {
					record.PrivateKey = "bad"
				}
				if err := f.h.saveAddress(&record); err != nil {
					t.Fatal(err)
				}
			}
			f.mu.Unlock()
			if _, err := f.h.FundAddress(context.Background(), 100000); err == nil {
				t.Fatal("invalid funding context accepted")
			}
			if len(f.submitted) != 0 {
				t.Fatal("invalid context broadcast")
			}
		})
	}
}

func TestAddressFundingWaitingDoesNotPrepareOrSend(t *testing.T) {
	f := newAddressFixture(t)
	f.balance = "0x0"
	status, err := f.h.FundAddress(context.Background(), 100000)
	if err != nil || status.Phase != "waiting_funds" || status.Amount != 100000 || f.prepared != 0 || len(f.submitted) != 0 {
		t.Fatalf("bad waiting state: %+v %v", status, err)
	}
	if _, err := f.h.FundAddress(context.Background(), 200000); err == nil {
		t.Fatal("changed an authorized amount")
	}
}

func TestAddressFundingAmbiguousApprovalReplaysExactBytesAcrossRestart(t *testing.T) {
	f := newAddressFixture(t)
	f.ambiguous = true
	first, err := f.h.FundAddress(context.Background(), 100000)
	if err != nil || first.Phase != "approval_pending" || !isHex(first.TransactionHash, 32) {
		t.Fatalf("ambiguous submit lost hash: %+v %v", first, err)
	}
	f.h = &FundingHandler{client: f.h.client, statePath: f.h.statePath}
	again, err := f.h.FundAddress(context.Background(), 100000)
	if err != nil || again.TransactionHash != first.TransactionHash || len(f.submitted) != 2 || f.submitted[0] != f.submitted[1] || len(f.accepted) != 1 {
		t.Fatalf("ambiguous approval replaced: %v", err)
	}
	if strings.Contains(again.Message, "raw") {
		t.Fatal("raw RPC error exposed")
	}
	before := len(f.submitted)
	if _, err := f.h.Address(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(f.submitted) != before {
		t.Fatal("GET rebroadcast a transaction")
	}
}

func TestAddressFundingApprovesExactAmountRefreshesPathAndDepositsOnce(t *testing.T) {
	f := newAddressFixture(t)
	approval, err := f.h.FundAddress(context.Background(), 100000)
	if err != nil {
		t.Fatal(err)
	}
	tx := f.accepted[approval.TransactionHash]
	if tx == nil || !strings.EqualFold(tx.To().Hex(), addressTestToken) || hex.EncodeToString(tx.Data()) != "095ea7b3"+addressABIWord(addressTestVault)+fmt.Sprintf("%064x", 100000) {
		t.Fatal("approval is not exact configured vault amount")
	}
	f.mine(t, approval.TransactionHash, false)
	f.finalized = "0x1" // A canonical approval can progress before finality.
	deposit, err := f.h.FundAddress(context.Background(), 100000)
	if err != nil {
		t.Fatal(err)
	}
	if deposit.Phase != "deposit_pending" || f.paths != 1 || f.prepared != 1 {
		t.Fatalf("deposit did not use refreshed saved note: %+v", deposit)
	}
	tx = f.accepted[deposit.TransactionHash]
	if tx == nil || tx.Nonce() != 1 || !strings.EqualFold(tx.To().Hex(), addressTestVault) {
		t.Fatal("invalid deposit transaction")
	}
	data := hex.EncodeToString(tx.Data())
	if len(data) != 8+64*34 || !strings.HasSuffix(data, strings.Repeat(addressABIWord("0xa"), 32)) {
		t.Fatal("deposit witness was not refreshed")
	}
	f.mine(t, deposit.TransactionHash, false)
	before := len(f.submitted)
	pending, err := f.h.FundAddress(context.Background(), 100000)
	if err != nil || pending.Phase != "deposit_pending" || f.activated != 0 {
		t.Fatal("activated non-final deposit")
	}
	if len(f.submitted) != before {
		t.Fatal("mined pending transaction broadcast again")
	}
	f.finalized = "0x20"
	active, err := f.h.FundAddress(context.Background(), 100000)
	if err != nil || active.Phase != "active" || f.activated != 1 {
		t.Fatalf("activation failed: %+v %v", active, err)
	}
	for range 3 {
		status, err := f.h.FundAddress(context.Background(), 100000)
		if err != nil || status.Phase != "active" {
			t.Fatal(err)
		}
	}
	if f.activated != 1 || len(f.accepted) != 2 || f.prepared != 1 {
		t.Fatal("retry deposited or initialized twice")
	}
}

func TestAddressFundingResetsInsufficientAllowanceAndDoesNotRepeatUnresolvedReset(t *testing.T) {
	f := newAddressFixture(t)
	f.allowance = "0xc350"
	reset, err := f.h.FundAddress(context.Background(), 100000)
	if err != nil {
		t.Fatal(err)
	}
	tx := f.accepted[reset.TransactionHash]
	if !strings.HasSuffix(hex.EncodeToString(tx.Data()), strings.Repeat("0", 64)) {
		t.Fatal("excess allowance not reset")
	}
	_, err = f.h.FundAddress(context.Background(), 100000)
	if err != nil {
		t.Fatal(err)
	}
	if len(f.accepted) != 1 {
		t.Fatal("unresolved reset generated a replacement")
	}
	f.mine(t, reset.TransactionHash, false)
	approval, err := f.h.FundAddress(context.Background(), 100000)
	if err != nil {
		t.Fatal(err)
	}
	if approval.Phase != "approval_pending" || f.accepted[approval.TransactionHash].Nonce() != 1 {
		t.Fatal("exact approval did not follow reset")
	}
}

func TestAddressFundingRevertRequiresExplicitRetryAndLegacyRecordIsNotAdopted(t *testing.T) {
	for _, legacy := range []bool{false, true} {
		t.Run(fmt.Sprint(legacy), func(t *testing.T) {
			f := newAddressFixture(t)
			if legacy {
				if err := f.h.save(depositRecord{ChainID: 1, Contract: addressTestVault, Amount: 200000, Secret: "0x1", Commitment: "0x2"}); err != nil {
					t.Fatal(err)
				}
				status, err := f.h.FundAddress(context.Background(), 100000)
				if err != nil || status.Phase != "legacy_recovery" || status.Amount != 200000 || len(f.submitted) != 0 {
					t.Fatalf("legacy note adopted: %+v %v", status, err)
				}
			} else {
				status, err := f.h.FundAddress(context.Background(), 100000)
				if err != nil {
					t.Fatal(err)
				}
				f.mine(t, status.TransactionHash, true)
				status, err = f.h.FundAddress(context.Background(), 100000)
				if err != nil || status.Phase != "reverted" {
					t.Fatalf("revert not preserved: %v", err)
				}
				if len(f.accepted) != 1 {
					t.Fatal("reverted transaction replaced before explicit retry")
				}
				f.finalized = "0x1"
				status, err = f.h.FundAddress(context.Background(), 100000)
				if err != nil || status.Phase != "reverted" || len(f.accepted) != 1 {
					t.Fatal("retry replaced unfinalized revert")
				}
				f.finalized = "0x20"
				status, err = f.h.FundAddress(context.Background(), 100000)
				if err != nil || status.Phase != "approval_pending" || len(f.accepted) != 2 || f.accepted[status.TransactionHash].Nonce() != 1 {
					t.Fatalf("explicit safe retry did not progress: %v", err)
				}
			}
		})
	}
}

func TestAddressFundingBoundsGasFeesAndNonce(t *testing.T) {
	for _, scenario := range []string{"gas", "gas buffer", "fee", "fee budget", "nonce"} {
		t.Run(scenario, func(t *testing.T) {
			f := newAddressFixture(t)
			switch scenario {
			case "gas":
				f.gas = "0x2000000"
			case "gas buffer":
				f.gas = "0x1000000"
			case "fee":
				f.gasPrice = "0x100000000000"
			case "fee budget":
				f.gas = "0x800000"
				f.gasPrice = "0x2540be400"
			case "nonce":
				f.nonce = "0xffffffffffffffff"
			}
			if _, err := f.h.FundAddress(context.Background(), 100000); err == nil {
				t.Fatal("unsafe transaction was accepted")
			}
			if len(f.submitted) != 0 {
				t.Fatal("unsafe transaction was sent")
			}
		})
	}
}

func TestAddressFundingChangedCanonicalBlockStopsProgress(t *testing.T) {
	f := newAddressFixture(t)
	first, err := f.h.FundAddress(context.Background(), 100000)
	if err != nil {
		t.Fatal(err)
	}
	f.mine(t, first.TransactionHash, false)
	f.canonical = "0x" + strings.Repeat("b", 64)
	if _, err := f.h.FundAddress(context.Background(), 100000); err == nil {
		t.Fatal("noncanonical receipt progressed")
	}
	if len(f.accepted) != 1 {
		t.Fatal("new transaction after noncanonical receipt")
	}
}

func TestAddressFundingCannotExposeAddressAfterDirectoryLoss(t *testing.T) {
	f := newAddressFixture(t)
	f.h.statePath = filepath.Join(t.TempDir(), "missing", "pending-deposit.json")
	status, err := f.h.Address(context.Background())
	if err == nil || status.Address != "" {
		t.Fatal("unsaved generated key exposed")
	}
}

func TestAddressFundingWaitsForEnoughETHAndReusesSufficientAllowance(t *testing.T) {
	f := newAddressFixture(t)
	f.allowance = "0xf4240"
	f.eth = "0x1"
	waiting, err := f.h.FundAddress(context.Background(), 100000)
	if err != nil || waiting.Phase != "waiting_funds" || len(f.submitted) != 0 {
		t.Fatalf("insufficient ETH did not wait: %+v %v", waiting, err)
	}
	f.eth = "0xde0b6b3a7640000"
	deposit, err := f.h.FundAddress(context.Background(), 100000)
	if err != nil || deposit.Phase != "deposit_pending" || len(f.accepted) != 1 {
		t.Fatalf("sufficient allowance triggered approval: %+v %v", deposit, err)
	}
}

func TestAddressFundingManualConfirmationCannotBypassFinality(t *testing.T) {
	f := newAddressFixture(t)
	f.allowance = "0xf4240"
	deposit, err := f.h.FundAddress(context.Background(), 100000)
	if err != nil {
		t.Fatal(err)
	}
	f.mine(t, deposit.TransactionHash, false)
	f.finalized = "0x1"
	if _, err := f.h.confirm(context.Background(), deposit.TransactionHash); err == nil || !strings.Contains(err.Error(), "finality") {
		t.Fatalf("manual recovery bypassed finality: %v", err)
	}
	if f.activated != 0 {
		t.Fatal("unfinalized note activated")
	}
	f.finalized = "0x20"
	if _, err := f.h.confirm(context.Background(), deposit.TransactionHash); err != nil {
		t.Fatal(err)
	}
	if _, err := f.h.FundAddress(context.Background(), 100000); err != nil {
		t.Fatal(err)
	}
	if f.activated != 1 || len(f.accepted) != 1 {
		t.Fatal("manual recovery duplicated activation or deposit")
	}
}

func TestAddressFundingMissingActivatedCompanionNoteNeverRefills(t *testing.T) {
	f := newAddressFixture(t)
	f.allowance = "0xf4240"
	deposit, err := f.h.FundAddress(context.Background(), 100000)
	if err != nil {
		t.Fatal(err)
	}
	f.mine(t, deposit.TransactionHash, false)
	if _, err := f.h.FundAddress(context.Background(), 100000); err != nil {
		t.Fatal(err)
	}
	f.active = false
	for _, readOnly := range []bool{true, false} {
		var status AddressFundingStatus
		if readOnly {
			status, err = f.h.Address(context.Background())
		} else {
			status, err = f.h.FundAddress(context.Background(), 200000)
		}
		if err != nil || status.Phase != "recovery_required" || status.Amount != 100000 {
			t.Fatalf("missing note offered refill: %+v %v", status, err)
		}
	}
	if f.prepared != 1 || f.activated != 1 || len(f.accepted) != 1 {
		t.Fatal("lost state triggered second deposit")
	}
}

func TestAddressFundingAmbiguousDepositNeverChoosesNewNonce(t *testing.T) {
	f := newAddressFixture(t)
	f.allowance = "0xf4240"
	f.ambiguous = true
	first, err := f.h.FundAddress(context.Background(), 100000)
	if err != nil {
		t.Fatal(err)
	}
	for range 3 {
		status, err := f.h.FundAddress(context.Background(), 100000)
		if err != nil || status.TransactionHash != first.TransactionHash {
			t.Fatal("ambiguous deposit changed identity")
		}
	}
	if len(f.accepted) != 1 || f.prepared != 1 || f.paths != 1 {
		t.Fatal("ambiguous deposit regenerated note/path/transaction")
	}
	for _, raw := range f.submitted {
		if raw != f.submitted[0] {
			t.Fatal("deposit replay changed signed bytes")
		}
	}
}

func TestAddressFundingRejectsRPCNonceRollbackAfterApproval(t *testing.T) {
	f := newAddressFixture(t)
	first, err := f.h.FundAddress(context.Background(), 100000)
	if err != nil {
		t.Fatal(err)
	}
	f.mine(t, first.TransactionHash, false)
	f.nonce = "0x0"
	if _, err := f.h.FundAddress(context.Background(), 100000); err == nil || !strings.Contains(err.Error(), "caught up") {
		t.Fatalf("nonce rollback not blocked: %v", err)
	}
	if len(f.accepted) != 1 {
		t.Fatal("signed with consumed nonce")
	}
}

func TestAddressFundingConcurrentCallsShareOneAddressAndTransaction(t *testing.T) {
	f := newAddressFixture(t)
	var group sync.WaitGroup
	for range 4 {
		group.Add(1)
		go func() {
			defer group.Done()
			if _, err := f.h.FundAddress(context.Background(), 100000); err != nil {
				t.Error(err)
			}
		}()
	}
	group.Wait()
	if len(f.accepted) != 1 || f.prepared != 1 {
		t.Fatal("concurrent calls generated conflicting funding state")
	}
}

func TestAddressFundingRevertedDepositRetainsNoteAndRefreshesWitnessOnExplicitRetry(t *testing.T) {
	f := newAddressFixture(t)
	f.allowance = "0xf4240"
	first, err := f.h.FundAddress(context.Background(), 100000)
	if err != nil {
		t.Fatal(err)
	}
	f.mine(t, first.TransactionHash, true)
	reverted, err := f.h.FundAddress(context.Background(), 100000)
	if err != nil || reverted.Phase != "reverted" {
		t.Fatal("reverted deposit not reported")
	}
	second, err := f.h.FundAddress(context.Background(), 100000)
	if err != nil {
		t.Fatal(err)
	}
	if second.Phase != "deposit_pending" || second.TransactionHash == first.TransactionHash || f.prepared != 1 || f.paths != 2 || len(f.accepted) != 2 {
		t.Fatalf("safe retry did not retain note: %+v", second)
	}
	raw, _ := os.ReadFile(f.h.statePath)
	var note depositRecord
	_ = json.Unmarshal(raw, &note)
	if note.Secret != "0xabcdef" || note.Commitment != "0x1234" {
		t.Fatal("reverted deposit lost note secret")
	}
}

func TestAddressFundingApprovalReorgReplaysPriorSignedBytesBeforeDependentDeposit(t *testing.T) {
	f := newAddressFixture(t)
	approval, err := f.h.FundAddress(context.Background(), 100000)
	if err != nil {
		t.Fatal(err)
	}
	f.mine(t, approval.TransactionHash, false)
	deposit, err := f.h.FundAddress(context.Background(), 100000)
	if err != nil {
		t.Fatal(err)
	}
	originalApproval, originalDeposit := f.submitted[0], f.submitted[1]
	f.nonce = "0x0"
	delete(f.receipts, approval.TransactionHash)
	status, err := f.h.FundAddress(context.Background(), 100000)
	if err != nil {
		t.Fatal(err)
	}
	if status.TransactionHash != deposit.TransactionHash || len(f.submitted) != 4 || f.submitted[2] != originalApproval || f.submitted[3] != originalDeposit || len(f.accepted) != 2 {
		t.Fatal("reorg recovery changed signed approvals/deposit")
	}
}

func TestAddressFundingApprovalReorgAfterArchivalWithoutSignedSuccessor(t *testing.T) {
	f := newAddressFixture(t)
	approval, err := f.h.FundAddress(context.Background(), 100000)
	if err != nil {
		t.Fatal(err)
	}
	original := f.submitted[0]
	f.mine(t, approval.TransactionHash, false)
	f.eth = "0x1" // Interrupt after archiving approval, before signing a successor.
	waiting, err := f.h.FundAddress(context.Background(), 100000)
	if err != nil || waiting.Phase != "waiting_funds" {
		t.Fatalf("did not pause between stages: %+v %v", waiting, err)
	}
	raw, _ := os.ReadFile(f.h.addressStatePath())
	var saved addressFundingRecord
	_ = json.Unmarshal(raw, &saved)
	if saved.Pending != nil || len(saved.History) != 1 || len(f.accepted) != 1 {
		t.Fatal("fixture did not isolate archived approval")
	}
	f.eth = "0xde0b6b3a7640000"
	f.allowance = "0x0"
	f.nonce = "0x0"
	delete(f.receipts, approval.TransactionHash)
	retrying, err := f.h.FundAddress(context.Background(), 100000)
	if err != nil || retrying.Phase != "approval_pending" || retrying.TransactionHash != approval.TransactionHash || len(f.accepted) != 1 || f.submitted[len(f.submitted)-1] != original {
		t.Fatalf("archived approval recovery stalled or replaced: %+v %v", retrying, err)
	}
	f.mine(t, approval.TransactionHash, false)
	deposit, err := f.h.FundAddress(context.Background(), 100000)
	if err != nil || deposit.Phase != "deposit_pending" || len(f.accepted) != 2 || f.accepted[deposit.TransactionHash].Nonce() != 1 {
		t.Fatalf("replayed approval did not unblock deposit: %+v %v", deposit, err)
	}
}

func TestAddressFundingUnfinalizedFailedApprovalMayDisappearOrBecomeSuccessful(t *testing.T) {
	for _, scenario := range []string{"disappears", "becomes successful"} {
		t.Run(scenario, func(t *testing.T) {
			f := newAddressFixture(t)
			approval, err := f.h.FundAddress(context.Background(), 100000)
			if err != nil {
				t.Fatal(err)
			}
			f.mine(t, approval.TransactionHash, true)
			f.finalized = "0x1"
			pending, err := f.h.FundAddress(context.Background(), 100000)
			if err != nil || pending.Phase != "approval_pending" || len(f.accepted) != 1 {
				t.Fatalf("provisional failure became terminal: %+v %v", pending, err)
			}
			if scenario == "disappears" {
				delete(f.receipts, approval.TransactionHash)
				f.nonce = "0x0"
				pending, err = f.h.FundAddress(context.Background(), 100000)
				if err != nil || pending.TransactionHash != approval.TransactionHash || f.submitted[0] != f.submitted[len(f.submitted)-1] || len(f.accepted) != 1 {
					t.Fatalf("failed receipt disappearance lost replay: %+v %v", pending, err)
				}
			}
			f.mine(t, approval.TransactionHash, false)
			deposit, err := f.h.FundAddress(context.Background(), 100000)
			if err != nil || deposit.Phase != "deposit_pending" || len(f.accepted) != 2 {
				t.Fatalf("formerly failed approval could not succeed: %+v %v", deposit, err)
			}
		})
	}
}

func TestAddressFundingRejectsRetiredTransactionInPendingJournal(t *testing.T) {
	f := newAddressFixture(t)
	if _, err := f.h.FundAddress(context.Background(), 100000); err != nil {
		t.Fatal(err)
	}
	raw, _ := os.ReadFile(f.h.addressStatePath())
	var saved addressFundingRecord
	_ = json.Unmarshal(raw, &saved)
	saved.Pending.FinalizedRevert = true
	if err := f.h.saveAddress(&saved); err != nil {
		t.Fatal(err)
	}
	if _, err := f.h.FundAddress(context.Background(), 100000); err == nil || !strings.Contains(err.Error(), "retired") {
		t.Fatal("inconsistent pending journal accepted")
	}
	if len(f.submitted) != 1 {
		t.Fatal("inconsistent pending journal broadcast")
	}
}
