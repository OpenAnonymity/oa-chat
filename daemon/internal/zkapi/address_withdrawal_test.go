package zkapi

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"testing"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/crypto"
)

const withdrawalTestDestination = "0x3333333333333333333333333333333333333333"

type withdrawalRoundTripper func(*http.Request) (*http.Response, error)

func (f withdrawalRoundTripper) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

// This fixture extends the funding fixture without teaching its RPC server to
// accept arbitrary methods. Each withdrawal assertion still passes through the
// real HTTP/RPC parser, durable signer, and receipt-validation code.
type withdrawalFixture struct {
	*addressFixture
	prepareCalls, confirmCalls int
	pending                    bool
	confirmFailure             bool
	capability                 bool
	planMutation               func(map[string]any)
	reservedDestination        string
	completedHash              string
	walletBalance              uint64
	planBalance                uint64
	reservedBalance            uint64
	noteID                     uint64
	reservedNoteID             uint64
	reservedNullifier          string
}

func withdrawalJSONResponse(r *http.Request, status int, value any) *http.Response {
	raw, _ := json.Marshal(value)
	return &http.Response{StatusCode: status, Header: make(http.Header), Body: io.NopCloser(bytes.NewReader(raw)), Request: r}
}

func newWithdrawalFixture(t *testing.T) *withdrawalFixture {
	t.Helper()
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
	f.mine(t, deposit.TransactionHash, false)
	active, err := f.h.FundAddress(context.Background(), 100000)
	if err != nil || active.Phase != "active" {
		t.Fatalf("fixture deposit did not activate: %+v %v", active, err)
	}
	w := &withdrawalFixture{addressFixture: f, capability: true, walletBalance: 99999, planBalance: 99999, noteID: 12}
	upstream := f.h.client.local.Transport
	f.h.client.local.Transport = withdrawalRoundTripper(func(r *http.Request) (*http.Response, error) {
		if r.Header.Get("Authorization") != "Bearer "+testBridgeToken {
			t.Error("withdrawal bridge request was not authenticated")
		}
		switch r.URL.Path {
		case "/oa/v1/status":
			version := 1
			if !w.capability {
				version = 0
			}
			return withdrawalJSONResponse(r, 200, map[string]any{"bridge_version": 1, "chain_id": 1, "mode": "direct_openrouter", "require_oa_org_key_source": true, "withdrawal_bridge_version": version}), nil
		case "/wallet/status":
			return withdrawalJSONResponse(r, 200, map[string]any{"has_note": f.active, "pending_request": w.pending, "note": map[string]any{"note_id": w.noteID, "deposit_amount": 100000, "current_balance": w.walletBalance, "expiry_ts": 2000000000, "current_anchor": "0x55", "current_commitment_x": "0x66", "current_commitment_y": "0x77"}}), nil
		case "/funding/api/deposit/prepare":
			f.prepared++
			var body struct {
				Amount uint64 `json:"amount"`
			}
			if json.NewDecoder(r.Body).Decode(&body) != nil {
				t.Error("invalid refill prepare request")
			}
			path := make([]string, 32)
			for i := range path {
				path[i] = "0x0"
			}
			return withdrawalJSONResponse(r, 200, map[string]any{"amount": body.Amount, "secret": "0xdefabc", "commitment": "0x5678", "zero_path": path}), nil
		case "/funding/api/deposit/confirm":
			f.activated++
			var body struct {
				NoteID uint64 `json:"note_id"`
				Amount uint64 `json:"amount"`
			}
			if json.NewDecoder(r.Body).Decode(&body) != nil {
				t.Error("invalid refill confirmation request")
			}
			w.noteID, w.walletBalance, w.planBalance, f.active = body.NoteID, body.Amount, body.Amount, true
			return withdrawalJSONResponse(r, 200, map[string]any{}), nil
		case "/oa/v1/withdraw/status":
			return withdrawalJSONResponse(r, 200, w.bridgeStatus()), nil
		case "/oa/v1/withdraw/prepare":
			if w.pending {
				return withdrawalJSONResponse(r, 409, map[string]any{"error": map[string]string{"code": "pending_settlement", "message": "private companion diagnostics"}}), nil
			}
			w.prepareCalls++
			var body struct {
				Destination string `json:"destination"`
			}
			if json.NewDecoder(r.Body).Decode(&body) != nil {
				t.Error("invalid withdrawal prepare request")
			}
			if w.completedHash != "" && w.reservedNoteID != w.noteID {
				w.completedHash, w.reservedDestination = "", ""
			}
			if w.reservedDestination != "" && !strings.EqualFold(w.reservedDestination, body.Destination) {
				return withdrawalJSONResponse(r, 409, map[string]any{"error": "reserved destination changed"}), nil
			}
			if w.reservedDestination == "" {
				w.reservedBalance = w.planBalance
				w.reservedNoteID = w.noteID
				w.reservedNullifier = fmt.Sprintf("0x%x", 0x123+w.noteID-12)
			}
			w.reservedDestination, w.walletBalance = body.Destination, w.planBalance
			plan := withdrawalTestPlan(body.Destination)
			plan["public_inputs"].(map[string]any)["final_balance"] = w.planBalance
			plan["public_inputs"].(map[string]any)["note_id"] = w.noteID
			plan["public_inputs"].(map[string]any)["withdrawal_nullifier"] = w.reservedNullifier
			if w.planMutation != nil {
				w.planMutation(plan)
			}
			return withdrawalJSONResponse(r, 200, plan), nil
		case "/oa/v1/withdraw/confirm":
			w.confirmCalls++
			if w.confirmFailure {
				return withdrawalJSONResponse(r, 503, map[string]any{"error": "temporary bridge failure"}), nil
			}
			var body struct {
				TransactionHash string `json:"transaction_hash"`
			}
			if json.NewDecoder(r.Body).Decode(&body) != nil || !isHex(body.TransactionHash, 32) {
				t.Error("invalid withdrawal confirmation request")
			}
			f.active = false
			w.completedHash = body.TransactionHash
			return withdrawalJSONResponse(r, 200, w.bridgeStatus()), nil
		default:
			return upstream.RoundTrip(r)
		}
	})
	return w
}

func (f *withdrawalFixture) bridgeStatus() map[string]any {
	if f.reservedDestination == "" {
		return map[string]any{"phase": "none"}
	}
	status := map[string]any{"phase": "reserved", "note_id": f.reservedNoteID, "destination": f.reservedDestination, "final_balance": fmt.Sprint(f.reservedBalance), "withdrawal_nullifier": f.reservedNullifier}
	if f.completedHash != "" {
		status["phase"], status["transaction_hash"] = "complete", f.completedHash
	}
	return status
}

func withdrawalTestPlan(destination string) map[string]any {
	decoded, _ := hex.DecodeString(strings.TrimPrefix(destination, "0x"))
	address := make([]int, len(decoded))
	for i, b := range decoded {
		address[i] = int(b)
	}
	siblings := make([]string, 32)
	for i := range siblings {
		siblings[i] = "0xa"
	}
	return map[string]any{
		"mode": "mutual",
		"public_inputs": map[string]any{
			"protocol_version": 2, "chain_id": 1, "contract_address": addressTestVault,
			"active_root": "0x9", "state_signing_key_x": "0x1", "state_signing_key_y": "0x2",
			"clearance_signing_key_x": "0x3", "clearance_signing_key_y": "0x4",
			"note_id": 12, "final_balance": 99999, "destination": address,
			"withdrawal_nullifier": "0x123", "has_clearance": true, "withdrawal_tag": "0x456",
		},
		"siblings": siblings,
		"proof":    map[string]any{"backend": "groth16_bn254", "proof": base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{0x5a}, 256))},
	}
}

func (f *withdrawalFixture) journal(t *testing.T) addressFundingRecord {
	t.Helper()
	raw, err := os.ReadFile(f.h.addressStatePath())
	if err != nil {
		t.Fatal(err)
	}
	var record addressFundingRecord
	if err := json.Unmarshal(raw, &record); err != nil {
		t.Fatal(err)
	}
	return record
}

func (f *withdrawalFixture) withdraw(t *testing.T, retryHash ...string) string {
	t.Helper()
	if _, err := f.h.WithdrawAddress(context.Background(), withdrawalTestDestination, f.noteID, retryHash...); err != nil {
		t.Fatal(err)
	}
	record := f.journal(t)
	if record.Pending == nil || record.Pending.Kind != "withdrawal" {
		t.Fatalf("no signed withdrawal journal: %+v", record.Pending)
	}
	return record.Pending.Hash
}

func (f *withdrawalFixture) mineWithdrawal(t *testing.T, hash string, destination string, reverted bool) {
	t.Helper()
	f.mu.Lock()
	defer f.mu.Unlock()
	tx := f.accepted[hash]
	if tx == nil {
		t.Fatal("withdrawal was not broadcast")
	}
	status := "0x1"
	if reverted {
		status = "0x0"
	}
	logs := []map[string]any{{"address": addressTestVault, "topics": []string{crypto.Keccak256Hash([]byte("MutualClose(uint32,uint256,uint128,address)")).Hex(), fmt.Sprintf("0x%064x", f.reservedNoteID)}, "data": "0x" + addressABIWord(f.reservedNullifier) + fmt.Sprintf("%064x", f.reservedBalance) + addressABIWord(destination)}}
	f.receipts[hash] = map[string]any{"transactionHash": hash, "status": status, "blockNumber": "0x10", "blockHash": addressTestBlock, "to": addressTestVault, "logs": logs}
	f.nonce = fmt.Sprintf("0x%x", tx.Nonce()+1)
}

func TestAddressWithdrawalSignsExactBoundCallAndPreservesDepositHistory(t *testing.T) {
	f := newWithdrawalFixture(t)
	hash := f.withdraw(t)
	tx := f.accepted[hash]
	if tx.Nonce() != 2 || tx.Value().Sign() != 0 || !strings.EqualFold(tx.To().Hex(), addressTestVault) {
		t.Fatal("withdrawal escaped local signer nonce, zero value, or configured vault")
	}
	signature := "mutualClose((uint16,uint64,address,uint256,uint256,uint256,uint256,uint256,uint32,uint128,address,uint256,bool,uint256),bytes,uint256[32])"
	expected := hex.EncodeToString(crypto.Keccak256([]byte(signature))[:4])
	for _, value := range []string{"0x2", "0x1", addressTestVault, "0x9", "0x1", "0x2", "0x3", "0x4", "0xc", "0x1869f", withdrawalTestDestination, "0x123", "0x1", "0x456", "0x5e0"} {
		expected += addressABIWord(value)
	}
	expected += strings.Repeat(addressABIWord("0xa"), 32) + addressABIWord("0x100") + strings.Repeat("5a", 256)
	if got := hex.EncodeToString(tx.Data()); got != expected {
		t.Fatalf("withdrawal calldata differs from the pinned contract ABI: got %d bytes, want %d", len(tx.Data()), len(expected)/2)
	}
	record := f.journal(t)
	if len(record.History) != 2 || record.History[1].Kind != "deposit" {
		t.Fatal("activating withdrawal discarded or replaced the deposit nonce history")
	}
}

func TestAddressWithdrawalAmbiguousBroadcastSurvivesRestartAndRejectsNewRecipient(t *testing.T) {
	f := newWithdrawalFixture(t)
	f.ambiguous = true
	hash := f.withdraw(t)
	raw := f.journal(t).Pending.Raw
	f.h = &FundingHandler{client: f.h.client, statePath: f.h.statePath}
	if again := f.withdraw(t); again != hash || f.journal(t).Pending.Raw != raw {
		t.Fatal("withdrawal retry changed signed bytes or hash")
	}
	if len(f.accepted) != 3 || len(f.submitted) != 4 || f.submitted[2] != f.submitted[3] || f.prepareCalls != 1 {
		t.Fatal("ambiguous withdrawal was proved or signed a second time")
	}
	before := len(f.submitted)
	if _, err := f.h.WithdrawAddress(context.Background(), addressTestToken, f.noteID); err == nil {
		t.Fatal("pending withdrawal destination changed")
	}
	if len(f.submitted) != before {
		t.Fatal("different destination triggered a transaction")
	}
	if _, err := f.h.FundAddress(context.Background(), 100000); err == nil {
		t.Fatal("funding proceeded while withdrawal was unresolved")
	}
}

func TestAddressWithdrawalChecksummedDestinationSurvivesSignedJournalRestart(t *testing.T) {
	f := newWithdrawalFixture(t)
	destination := common.HexToAddress("0x5f8BD2eF77f58601a700af3deB7c2aaa0a3ebBDA").Hex()
	if destination == strings.ToLower(destination) {
		t.Fatal("fixture must exercise a mixed-case Ethereum checksum")
	}
	if _, err := f.h.WithdrawAddress(context.Background(), destination, f.noteID); err != nil {
		t.Fatal(err)
	}
	first := f.journal(t)
	if first.Pending == nil || first.Withdrawal.Destination != destination {
		t.Fatal("checksummed destination was not persisted")
	}
	hash, signed := first.Pending.Hash, first.Pending.Raw
	f.h = &FundingHandler{client: f.h.client, statePath: f.h.statePath}
	status, err := f.h.AddressWithdrawal(context.Background())
	if err != nil || status.Destination != destination || status.TransactionHash != hash {
		t.Fatalf("valid signed EIP-55 destination failed restart validation: %+v %v", status, err)
	}
	// The CLI accepts a lowercase spelling of the same address on resume. The
	// saved authorization must compare the address bytes, not checksum casing.
	if _, err := f.h.WithdrawAddress(context.Background(), strings.ToLower(destination), f.noteID); err != nil {
		t.Fatal(err)
	}
	again := f.journal(t)
	if again.Pending.Hash != hash || again.Pending.Raw != signed || f.prepareCalls != 1 || len(f.accepted) != 3 {
		t.Fatal("destination casing changed signed withdrawal authorization")
	}
	f.mineWithdrawal(t, hash, destination, false)
	status, err = f.h.WithdrawAddress(context.Background(), destination, f.noteID)
	if err != nil || status.Phase != "complete" {
		t.Fatalf("checksummed withdrawal could not close: %+v %v", status, err)
	}
}

func TestAddressWithdrawalRejectsUnsafePlanBeforeSigning(t *testing.T) {
	for _, mutation := range []string{"chain", "contract", "version", "note", "balance", "destination", "clearance", "siblings", "proof_backend", "proof_length", "field_overflow"} {
		t.Run(mutation, func(t *testing.T) {
			f := newWithdrawalFixture(t)
			f.planMutation = func(plan map[string]any) {
				pi := plan["public_inputs"].(map[string]any)
				switch mutation {
				case "chain":
					pi["chain_id"] = 11155111
				case "contract":
					pi["contract_address"] = addressTestToken
				case "version":
					pi["protocol_version"] = 1
				case "note":
					pi["note_id"] = 13
				case "balance":
					pi["final_balance"] = 100000
				case "destination":
					pi["destination"] = make([]int, 20)
				case "clearance":
					pi["has_clearance"] = false
				case "siblings":
					plan["siblings"] = []string{"0xa"}
				case "proof_backend":
					plan["proof"].(map[string]any)["backend"] = "stwo_cairo"
				case "proof_length":
					plan["proof"].(map[string]any)["proof"] = "AA=="
				case "field_overflow":
					pi["withdrawal_nullifier"] = "0x" + strings.Repeat("f", 64)
				}
			}
			if _, err := f.h.WithdrawAddress(context.Background(), withdrawalTestDestination, f.noteID); err == nil {
				t.Fatal("unsafe withdrawal proof plan accepted")
			}
			if len(f.accepted) != 2 || len(f.submitted) != 2 {
				t.Fatal("invalid plan caused a signed transaction")
			}
		})
	}
}

func TestAddressWithdrawalRequiresFinalityBeforeArchivingAndCompletesOnce(t *testing.T) {
	f := newWithdrawalFixture(t)
	hash := f.withdraw(t)
	f.mineWithdrawal(t, hash, withdrawalTestDestination, false)
	f.finalized = "0x1"
	if _, err := f.h.WithdrawAddress(context.Background(), withdrawalTestDestination, f.noteID); err != nil {
		t.Fatal(err)
	}
	if f.confirmCalls != 0 || !f.active || f.journal(t).Pending == nil {
		t.Fatal("unfinalized withdrawal cleared private note state")
	}
	before := len(f.submitted)
	f.finalized = "0x20"
	if _, err := f.h.WithdrawAddress(context.Background(), withdrawalTestDestination, f.noteID); err != nil {
		t.Fatal(err)
	}
	record := f.journal(t)
	if f.active || record.Pending != nil || record.Amount != 0 || record.Commitment != "" || len(record.History) != 3 || record.History[2].Kind != "withdrawal" {
		t.Fatal("confirmed withdrawal did not close exactly one note while preserving signer history")
	}
	for range 2 {
		f.h = &FundingHandler{client: f.h.client, statePath: f.h.statePath}
		if _, err := f.h.WithdrawAddress(context.Background(), withdrawalTestDestination, f.noteID); err != nil {
			t.Fatal(err)
		}
	}
	if len(f.submitted) != before || len(f.accepted) != 3 || f.prepareCalls != 1 {
		t.Fatal("completed withdrawal repeated proving or payment after restart")
	}
	refill, err := f.h.FundAddress(context.Background(), 50000)
	if err != nil || refill.Phase != "approval_pending" {
		t.Fatalf("completed withdrawal blocked explicit refill: %+v %v", refill, err)
	}
	if tx := f.accepted[refill.TransactionHash]; tx == nil || tx.Nonce() != 3 {
		t.Fatal("refill forgot the withdrawal nonce")
	}
	if f.prepared != 2 {
		t.Fatal("refill reused the closed note instead of preparing a new one")
	}
}

func TestAddressWithdrawalRejectsWrongEventOrNoncanonicalReceipt(t *testing.T) {
	for _, mutation := range []string{"destination", "note", "amount", "nullifier", "emitter", "event", "no_event", "duplicate", "removed", "canonical"} {
		t.Run(mutation, func(t *testing.T) {
			f := newWithdrawalFixture(t)
			hash := f.withdraw(t)
			f.mineWithdrawal(t, hash, withdrawalTestDestination, false)
			log := f.receipts[hash]["logs"].([]map[string]any)[0]
			switch mutation {
			case "destination":
				log["data"] = fmt.Sprintf("0x%064x%064x%s", 0x123, 99999, addressABIWord(addressTestToken))
			case "note":
				log["topics"].([]string)[1] = fmt.Sprintf("0x%064x", 13)
			case "amount":
				log["data"] = fmt.Sprintf("0x%064x%064x%s", 0x123, 100000, addressABIWord(withdrawalTestDestination))
			case "nullifier":
				log["data"] = fmt.Sprintf("0x%064x%064x%s", 0x124, 99999, addressABIWord(withdrawalTestDestination))
			case "emitter":
				log["address"] = addressTestToken
			case "event":
				log["topics"].([]string)[0] = crypto.Keccak256Hash([]byte("ExpiredClaimed(uint32,uint128,uint256)")).Hex()
			case "no_event":
				f.receipts[hash]["logs"] = []map[string]any{}
			case "duplicate":
				f.receipts[hash]["logs"] = []map[string]any{log, log}
			case "removed":
				log["removed"] = true
			case "canonical":
				f.canonical = "0x" + strings.Repeat("b", 64)
			}
			if _, err := f.h.WithdrawAddress(context.Background(), withdrawalTestDestination, f.noteID); err == nil {
				t.Fatal("unrelated withdrawal receipt cleared the note")
			}
			if f.confirmCalls != 0 || !f.active || f.journal(t).Pending == nil || len(f.accepted) != 3 {
				t.Fatal("invalid close evidence mutated the active note or signed a replacement")
			}
		})
	}
}

func TestAddressWithdrawalRefreshesOnlyAfterExplicitFinalizedRevertRetry(t *testing.T) {
	f := newWithdrawalFixture(t)
	hash := f.withdraw(t)
	f.mineWithdrawal(t, hash, withdrawalTestDestination, true)
	f.finalized = "0x1"
	status, err := f.h.WithdrawAddress(context.Background(), withdrawalTestDestination, f.noteID)
	if err != nil || status.Phase == "reverted" || f.prepareCalls != 1 || len(f.accepted) != 3 {
		t.Fatalf("provisional revert authorized a replacement: %+v %v", status, err)
	}
	f.finalized = "0x20"
	status, err = f.h.WithdrawAddress(context.Background(), withdrawalTestDestination, f.noteID)
	if err != nil || status.Phase != "reverted" || f.prepareCalls != 1 || len(f.accepted) != 3 {
		t.Fatalf("finalized revert did not stop for explicit retry: %+v %v", status, err)
	}
	f.planMutation = func(plan map[string]any) {
		plan["public_inputs"].(map[string]any)["active_root"] = "0xb"
	}
	for range 2 {
		status, err = f.h.WithdrawAddress(context.Background(), withdrawalTestDestination, f.noteID)
		if err != nil || status.Phase != "reverted" || f.prepareCalls != 1 || len(f.accepted) != 3 {
			t.Fatal("a repeated poll authorized a reverted transaction retry")
		}
	}
	again := f.withdraw(t, hash)
	record := f.journal(t)
	if again == hash || f.accepted[again].Nonce() != 3 || f.prepareCalls != 2 || len(record.History) != 3 || !record.History[2].FinalizedRevert {
		t.Fatal("explicit retry did not preserve failed transaction history and use a fresh proof/nonce")
	}
	if got := hex.EncodeToString(f.accepted[again].Data()[4+3*32 : 4+4*32]); got != addressABIWord("0xb") {
		t.Fatal("stale-root retry did not refresh the root")
	}
}

func TestAddressWithdrawalSavedProofBindingRejectsChangeDuringGasWait(t *testing.T) {
	for _, field := range []string{"state_signing_key_x", "clearance_signing_key_y", "withdrawal_nullifier", "withdrawal_tag"} {
		t.Run(field, func(t *testing.T) {
			f := newWithdrawalFixture(t)
			f.eth = "0x0"
			status, err := f.h.WithdrawAddress(context.Background(), withdrawalTestDestination, f.noteID)
			if err != nil || status.Phase != "waiting_funds" {
				t.Fatalf("gas wait did not persist proof authorization: %+v %v", status, err)
			}
			f.eth = "0xde0b6b3a7640000"
			f.planMutation = func(plan map[string]any) { plan["public_inputs"].(map[string]any)[field] = "0x9876" }
			if _, err := f.h.WithdrawAddress(context.Background(), withdrawalTestDestination, f.noteID); err == nil {
				t.Fatal("retry changed the saved withdrawal authorization")
			}
			if len(f.accepted) != 2 {
				t.Fatal("changed authorization was signed")
			}
		})
	}
}

func (f *withdrawalFixture) competingClose(t *testing.T, original, other string) {
	t.Helper()
	f.mineWithdrawal(t, original, withdrawalTestDestination, true)
	status, err := f.h.WithdrawAddress(context.Background(), withdrawalTestDestination, f.noteID)
	if err != nil || status.Phase != "reverted" {
		t.Fatalf("original transaction did not reach finalized revert: %+v %v", status, err)
	}
	encoded, _ := json.Marshal(f.receipts[original])
	var receipt map[string]any
	if err := json.Unmarshal(encoded, &receipt); err != nil {
		t.Fatal(err)
	}
	receipt["status"], receipt["transactionHash"] = "0x1", other
	f.receipts[other] = receipt
}

func TestAddressWithdrawalConfirmsCompetingPayoutThenRefillsWithoutSigningAgain(t *testing.T) {
	f := newWithdrawalFixture(t)
	original := f.withdraw(t)
	other := "0x" + strings.Repeat("c", 64)
	f.competingClose(t, original, other)
	before := len(f.submitted)
	status, err := f.h.WithdrawAddress(context.Background(), withdrawalTestDestination, f.noteID, "", other)
	if err != nil || status.Phase != "complete" || f.active {
		t.Fatalf("exact competing payout could not finish the note: %+v %v", status, err)
	}
	record := f.journal(t)
	if record.Withdrawal.TransactionHash != original || record.Withdrawal.SettlementHash != other || record.Pending != nil || len(record.History) != 3 || record.History[2].Hash != original || !record.History[2].FinalizedRevert {
		t.Fatal("alternate payout discarded the original failed transaction or its winning settlement identity")
	}
	if len(f.submitted) != before || len(f.accepted) != 3 || f.prepareCalls != 1 {
		t.Fatal("alternate payout recovery signed or broadcast a replacement")
	}
	refill, err := f.h.FundAddress(context.Background(), 50000)
	if err != nil || refill.Phase != "approval_pending" || f.accepted[refill.TransactionHash].Nonce() != 3 {
		t.Fatalf("alternate payout did not release refill with preserved nonce: %+v %v", refill, err)
	}
}

func TestAddressWithdrawalConfirmsWrappedPayoutOnlyWithExactVaultEmitter(t *testing.T) {
	for _, forged := range []bool{false, true} {
		t.Run(fmt.Sprintf("forged_emitter_%t", forged), func(t *testing.T) {
			f := newWithdrawalFixture(t)
			original := f.withdraw(t)
			other := "0x" + strings.Repeat("d", 64)
			f.competingClose(t, original, other)
			f.receipts[other]["to"] = addressTestToken // The outer wrapper is not the vault.
			if forged {
				f.receipts[other]["logs"].([]any)[0].(map[string]any)["address"] = addressTestToken
			}
			before := len(f.submitted)
			status, err := f.h.WithdrawAddress(context.Background(), withdrawalTestDestination, f.noteID, "", other)
			if forged {
				if err == nil || f.journal(t).Withdrawal.Phase != "reverted" || !f.active {
					t.Fatal("a wrapper-forged payout event was accepted")
				}
			} else if err != nil || status.Phase != "complete" || f.active {
				t.Fatalf("valid wrapped vault payout could not complete: %+v %v", status, err)
			}
			if len(f.submitted) != before {
				t.Fatal("wrapped payout confirmation submitted a transaction")
			}
		})
	}
}

func TestAddressWithdrawalFailedRetryPreservesAlternateConfirmation(t *testing.T) {
	for _, failure := range []string{"proof", "simulation", "gas_balance"} {
		t.Run(failure, func(t *testing.T) {
			f := newWithdrawalFixture(t)
			original := f.withdraw(t)
			other := "0x" + strings.Repeat("e", 64)
			f.competingClose(t, original, other)
			before := f.journal(t)
			switch failure {
			case "proof":
				f.planMutation = func(plan map[string]any) { plan["mode"] = "escape" }
			case "simulation":
				f.gas = "0x0"
			case "gas_balance":
				f.eth = "0x0"
			}
			if _, err := f.h.WithdrawAddress(context.Background(), withdrawalTestDestination, f.noteID, original); err == nil {
				t.Fatal("failed retry unexpectedly succeeded")
			}
			preserved := f.journal(t)
			if preserved.Pending == nil || preserved.Pending.Raw != before.Pending.Raw || preserved.Withdrawal.Phase != "reverted" || preserved.Withdrawal.TransactionHash != original || len(preserved.History) != len(before.History) {
				t.Fatal("unsuccessful retry discarded the confirmable failed attempt")
			}
			f.h = &FundingHandler{client: f.h.client, statePath: f.h.statePath}
			status, err := f.h.WithdrawAddress(context.Background(), withdrawalTestDestination, f.noteID, "", other)
			if err != nil || status.Phase != "complete" || f.active || len(f.accepted) != 3 || f.journal(t).Pending != nil {
				t.Fatalf("failed retry disabled alternate payout confirmation after restart: %+v %v", status, err)
			}
		})
	}
}

func TestAddressWithdrawalRejectsUnprovenCompetingPayoutWithoutChangingJournal(t *testing.T) {
	for _, mutation := range []string{"wrong_destination", "wrong_hash", "missing", "unfinalized", "simultaneous_retry"} {
		t.Run(mutation, func(t *testing.T) {
			f := newWithdrawalFixture(t)
			original := f.withdraw(t)
			other := "0x" + strings.Repeat("c", 64)
			f.competingClose(t, original, other)
			retry := ""
			switch mutation {
			case "wrong_destination":
				f.receipts[other]["logs"].([]any)[0].(map[string]any)["data"] = "0x" + addressABIWord(f.reservedNullifier) + fmt.Sprintf("%064x", f.reservedBalance) + addressABIWord(addressTestToken)
			case "wrong_hash":
				f.receipts[other]["transactionHash"] = "0x" + strings.Repeat("d", 64)
			case "missing":
				delete(f.receipts, other)
			case "unfinalized":
				f.receipts[other]["blockNumber"] = "0x30"
			case "simultaneous_retry":
				retry = original
			}
			before := f.journal(t)
			submissions := len(f.submitted)
			status, err := f.h.WithdrawAddress(context.Background(), withdrawalTestDestination, f.noteID, retry, other)
			if err == nil && status.Phase == "complete" {
				t.Fatal("unproven competing payout was accepted")
			}
			after := f.journal(t)
			if !f.active || after.Pending == nil || after.Pending.Hash != original || after.Pending.Raw != before.Pending.Raw || after.Withdrawal.Phase != "reverted" || after.Withdrawal.SettlementHash != "" || len(f.submitted) != submissions || f.confirmCalls != 0 || f.prepareCalls != 1 {
				t.Fatal("invalid competing payout changed recovery state, closed the note, or signed again")
			}
		})
	}
}

func TestAddressWithdrawalCompetingPayoutConfirmationSurvivesLostReplyAndRestart(t *testing.T) {
	f := newWithdrawalFixture(t)
	original := f.withdraw(t)
	other := "0x" + strings.Repeat("c", 64)
	f.competingClose(t, original, other)
	f.confirmFailure = true
	if _, err := f.h.WithdrawAddress(context.Background(), withdrawalTestDestination, f.noteID, "", other); err == nil {
		t.Fatal("lost confirmation reply reported completed recovery")
	}
	pending := f.journal(t)
	if pending.Pending == nil || pending.Pending.Hash != original || pending.Withdrawal.SettlementHash != other || pending.Withdrawal.Phase != "confirming" {
		t.Fatal("winning payout was not journaled before contacting the companion")
	}
	submissions := len(f.submitted)
	if _, err := f.h.WithdrawAddress(context.Background(), withdrawalTestDestination, f.noteID, "", "0x"+strings.Repeat("d", 64)); err == nil {
		t.Fatal("saved alternate settlement was silently replaced")
	}
	f.confirmFailure, f.active, f.completedHash = false, false, other
	f.h = &FundingHandler{client: f.h.client, statePath: f.h.statePath}
	status, err := f.h.WithdrawAddress(context.Background(), withdrawalTestDestination, f.noteID)
	if err != nil || status.Phase != "complete" || f.journal(t).Pending != nil || len(f.submitted) != submissions || f.prepareCalls != 1 {
		t.Fatalf("restart did not resume the saved competing payout: %+v %v", status, err)
	}
	if record := f.journal(t); record.Withdrawal.SettlementHash != other || !record.History[2].FinalizedRevert {
		t.Fatal("restart lost competing settlement or failed signed transaction history")
	}
}

func TestAddressWithdrawalConfirmationRetryToleratesCompanionAlreadyClosed(t *testing.T) {
	f := newWithdrawalFixture(t)
	hash := f.withdraw(t)
	f.mineWithdrawal(t, hash, withdrawalTestDestination, false)
	f.confirmFailure = true
	if _, err := f.h.WithdrawAddress(context.Background(), withdrawalTestDestination, f.noteID); err == nil {
		t.Fatal("failed companion confirmation reported completion")
	}
	if f.journal(t).Pending == nil {
		t.Fatal("failed confirmation discarded signed recovery journal")
	}
	// The companion can durably close the note and lose its reply while the Go
	// daemon still holds the signed withdrawal. A fresh process must reconcile it.
	f.confirmFailure, f.active, f.completedHash = false, false, hash
	f.h = &FundingHandler{client: f.h.client, statePath: f.h.statePath}
	if _, err := f.h.WithdrawAddress(context.Background(), withdrawalTestDestination, f.noteID); err != nil {
		t.Fatalf("could not resume after companion archived the note: %v", err)
	}
	if f.journal(t).Pending != nil || len(f.accepted) != 3 {
		t.Fatal("confirmation retry failed to close or sent another transaction")
	}
}

func TestAddressWithdrawalLegacyFundingCannotBypassUnfinishedGoConfirmation(t *testing.T) {
	f := newWithdrawalFixture(t)
	hash := f.withdraw(t)
	f.mineWithdrawal(t, hash, withdrawalTestDestination, false)
	f.confirmFailure = true
	if _, err := f.h.WithdrawAddress(context.Background(), withdrawalTestDestination, f.noteID); err == nil {
		t.Fatal("fixture confirmation should lose its bridge reply")
	}
	// The Rust companion finished, but the Go daemon still needs to archive its
	// matching deposit and retire the signed withdrawal. A legacy browser
	// capability must not observe no-note and start replacing recovery state.
	f.active, f.completedHash = false, hash
	addressBefore, err := os.ReadFile(f.h.addressStatePath())
	if err != nil {
		t.Fatal(err)
	}
	depositBefore, err := os.ReadFile(f.h.statePath)
	if err != nil {
		t.Fatal(err)
	}
	record := f.journal(t)
	depositHash := record.History[1].Hash
	prepared, activated, calls := f.prepared, f.activated, len(f.rpcCalls)
	if _, err := f.h.prepare(context.Background(), 50000); err == nil || !strings.Contains(err.Error(), "withdrawal") {
		t.Fatalf("legacy prepare bypassed pending withdrawal: %v", err)
	}
	if _, err := f.h.confirm(context.Background(), depositHash); err == nil || !strings.Contains(err.Error(), "withdrawal") {
		t.Fatalf("legacy confirm bypassed pending withdrawal: %v", err)
	}
	addressAfter, _ := os.ReadFile(f.h.addressStatePath())
	depositAfter, _ := os.ReadFile(f.h.statePath)
	if !bytes.Equal(addressBefore, addressAfter) || !bytes.Equal(depositBefore, depositAfter) {
		t.Fatal("legacy funding changed recovery state before withdrawal bookkeeping finished")
	}
	if f.prepared != prepared || f.activated != activated || len(f.rpcCalls) != calls || len(f.accepted) != 3 {
		t.Fatal("blocked legacy funding reached deposit preparation, confirmation, or RPC")
	}
}

func TestAddressWithdrawalAllowsSecondWithdrawalAfterLegacyRefill(t *testing.T) {
	f := newWithdrawalFixture(t)
	firstHash := f.withdraw(t)
	f.mineWithdrawal(t, firstHash, withdrawalTestDestination, false)
	if _, err := f.h.WithdrawAddress(context.Background(), withdrawalTestDestination, f.noteID); err != nil {
		t.Fatal(err)
	}
	if _, err := f.h.prepare(context.Background(), 50000); err != nil {
		t.Fatalf("legacy refill preparation failed: %v", err)
	}
	raw, err := os.ReadFile(f.h.statePath)
	if err != nil {
		t.Fatal(err)
	}
	var deposit depositRecord
	if err := json.Unmarshal(raw, &deposit); err != nil {
		t.Fatal(err)
	}
	legacyHash := "0x" + strings.Repeat("e", 64)
	receipt := sampleReceipt(deposit)
	receipt.TransactionHash = legacyHash
	receipt.Logs[0].Topics[1] = fmt.Sprintf("0x%064x", 13)
	receipt.Logs[0].Topics[2] = "0x" + addressABIWord(deposit.Commitment)
	receiptRaw, _ := json.Marshal(receipt)
	var storedReceipt map[string]any
	if err := json.Unmarshal(receiptRaw, &storedReceipt); err != nil {
		t.Fatal(err)
	}
	storedReceipt["blockNumber"], storedReceipt["blockHash"] = "0x10", addressTestBlock
	f.receipts[legacyHash] = storedReceipt
	if _, err := f.h.confirm(context.Background(), legacyHash); err != nil {
		t.Fatalf("legacy refill confirmation failed: %v", err)
	}
	if !f.active || f.noteID != 13 || f.walletBalance != 50000 {
		t.Fatal("legacy refill did not activate a distinct note")
	}
	prepared, submissions := f.prepareCalls, len(f.submitted)
	newNoteRecovery, err := os.ReadFile(f.h.statePath)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.h.WithdrawAddress(context.Background(), withdrawalTestDestination, 12); err == nil {
		t.Fatal("stale withdrawal poll authorized closing the replacement note")
	}
	afterStalePoll, _ := os.ReadFile(f.h.statePath)
	if f.prepareCalls != prepared || len(f.submitted) != submissions || !f.active || f.noteID != 13 || f.walletBalance != 50000 || !bytes.Equal(newNoteRecovery, afterStalePoll) {
		t.Fatal("stale withdrawal poll modified or spent the new note")
	}
	f.h = &FundingHandler{client: f.h.client, statePath: f.h.statePath}
	secondHash := f.withdraw(t)
	record := f.journal(t)
	if record.Withdrawal.NoteID != 13 || record.Withdrawal.Amount != 50000 || secondHash == firstHash || f.accepted[secondHash].Nonce() != 3 {
		t.Fatal("old completion contaminated the second note's withdrawal or signer history")
	}
	f.mineWithdrawal(t, secondHash, withdrawalTestDestination, false)
	status, err := f.h.WithdrawAddress(context.Background(), withdrawalTestDestination, f.noteID)
	if err != nil || status.Phase != "complete" || f.active || f.prepareCalls != 2 {
		t.Fatalf("second note could not finish withdrawal: %+v %v", status, err)
	}
}

func TestAddressWithdrawalRestartRejectsIntentTamperingWithUnchangedSignedBytes(t *testing.T) {
	for _, field := range []string{"destination", "amount", "binding", "note_id"} {
		t.Run(field, func(t *testing.T) {
			f := newWithdrawalFixture(t)
			hash := f.withdraw(t)
			record := f.journal(t)
			signed := record.Pending.Raw
			switch field {
			case "destination":
				record.Withdrawal.Destination = addressTestToken
			case "amount":
				record.Withdrawal.Amount--
			case "binding":
				record.Withdrawal.Binding = "0x" + strings.Repeat("b", 64)
			case "note_id":
				record.Withdrawal.NoteID++
			}
			if err := f.h.saveAddress(&record); err != nil {
				t.Fatal(err)
			}
			f.h = &FundingHandler{client: f.h.client, statePath: f.h.statePath}
			if _, err := f.h.AddressWithdrawal(context.Background()); err == nil {
				t.Fatal("restart accepted an intent that differs from its signed transaction")
			}
			before := len(f.submitted)
			if _, err := f.h.WithdrawAddress(context.Background(), record.Withdrawal.Destination, f.noteID); err == nil {
				t.Fatal("tampered withdrawal intent authorized a broadcast")
			}
			preserved := f.journal(t)
			if len(f.submitted) != before || preserved.Pending.Raw != signed || preserved.Pending.Hash != hash {
				t.Fatal("tamper rejection changed or broadcast the original signed transaction")
			}
		})
	}
}

func TestAddressWithdrawalInsufficientGasPreservesIntentAndCanResume(t *testing.T) {
	f := newWithdrawalFixture(t)
	f.eth = "0x0"
	_, _ = f.h.WithdrawAddress(context.Background(), withdrawalTestDestination, f.noteID)
	if len(f.accepted) != 2 || f.journal(t).Pending != nil {
		t.Fatal("withdrawal signed without enough gas")
	}
	f.eth = "0xde0b6b3a7640000"
	f.withdraw(t)
	if len(f.accepted) != 3 || f.accepted[f.journal(t).Pending.Hash].Nonce() != 2 {
		t.Fatal("gas top-up changed or duplicated the withdrawal nonce")
	}
}

func TestAddressWithdrawalPreconditionsRejectBeforeProofOrBroadcast(t *testing.T) {
	for _, condition := range []string{"zero_destination", "invalid_destination", "no_note", "unsupported_companion"} {
		t.Run(condition, func(t *testing.T) {
			f := newWithdrawalFixture(t)
			destination := withdrawalTestDestination
			switch condition {
			case "zero_destination":
				destination = "0x" + strings.Repeat("0", 40)
			case "invalid_destination":
				destination = "0x1234"
			case "no_note":
				f.active = false
			case "unsupported_companion":
				f.capability = false
			}
			if _, err := f.h.WithdrawAddress(context.Background(), destination, f.noteID); err == nil {
				t.Fatal("unsafe withdrawal precondition accepted")
			}
			if f.prepareCalls != 0 || len(f.accepted) != 2 {
				t.Fatal("unsafe withdrawal precondition reached proving or signing")
			}
		})
	}
}

func TestAddressWithdrawalWaitsForOutstandingInferenceSettlement(t *testing.T) {
	f := newWithdrawalFixture(t)
	f.pending = true
	status, err := f.h.WithdrawAddress(context.Background(), withdrawalTestDestination, f.noteID)
	if err != nil || status.Phase != "waiting_settlement" {
		t.Fatalf("pending inference did not defer withdrawal: %+v %v", status, err)
	}
	if f.prepareCalls != 0 || f.reservedDestination != "" || len(f.accepted) != 2 {
		t.Fatal("withdrawal reserved clearance or signed before inference settlement")
	}
	f.pending = false
	f.withdraw(t)
	if f.prepareCalls != 1 || len(f.accepted) != 3 {
		t.Fatal("settled inference could not resume saved withdrawal")
	}
}

func TestAddressWithdrawalClosesZeroBalanceAndAcceptsNewlySettledLowerBalance(t *testing.T) {
	for _, scenario := range []struct {
		name             string
		initial, settled uint64
	}{
		{name: "zero_balance", initial: 0, settled: 0},
		{name: "settled_between_status_and_prepare", initial: 99999, settled: 90000},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			f := newWithdrawalFixture(t)
			f.walletBalance, f.planBalance = scenario.initial, scenario.settled
			hash := f.withdraw(t)
			record := f.journal(t)
			if record.Withdrawal.Amount != scenario.settled {
				t.Fatal("withdrawal ignored the companion's durably reserved balance")
			}
			f.mineWithdrawal(t, hash, withdrawalTestDestination, false)
			status, err := f.h.WithdrawAddress(context.Background(), withdrawalTestDestination, f.noteID)
			if err != nil || status.Phase != "complete" || status.Amount != scenario.settled || f.active || f.journal(t).Pending != nil {
				t.Fatalf("balance could not close through the normal lifecycle: %+v %v", status, err)
			}
		})
	}
}

func TestAddressWithdrawalStatusIsReadOnlyAndDoesNotExposeRecoveryMaterial(t *testing.T) {
	f := newWithdrawalFixture(t)
	f.withdraw(t)
	before, proofs := len(f.submitted), f.prepareCalls
	status, err := f.h.AddressWithdrawal(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	encoded, _ := json.Marshal(status)
	record := f.journal(t)
	if strings.Contains(string(encoded), record.PrivateKey) || strings.Contains(string(encoded), record.Pending.Raw) || strings.Contains(string(encoded), "private_key") || strings.Contains(string(encoded), "0xabcdef") {
		t.Fatal("withdrawal status leaked private recovery material")
	}
	if before != len(f.submitted) || proofs != f.prepareCalls {
		t.Fatal("withdrawal status caused proving or transaction broadcast")
	}
}
