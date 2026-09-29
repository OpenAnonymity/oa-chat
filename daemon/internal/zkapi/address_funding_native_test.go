package zkapi

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"math/big"
	"net/http"
	"os"
	"strings"
	"testing"

	"github.com/ethereum/go-ethereum/core/types"
	"github.com/ethereum/go-ethereum/crypto"
)

func TestNativeFundingExactPayableDepositAndFinalizedRecovery(t *testing.T) {
	f := newAddressFixture(t, true)
	initial, err := f.h.Address(context.Background())
	if err != nil || initial.BillingAsset != "native_eth" || initial.BillingUnit != "gwei" || initial.TokenDecimals != 9 || initial.TokenAddress != "" || initial.TokenBalance != "1000000000" || initial.WeiPerUnit != "1000000000" {
		t.Fatalf("invalid native address status: %+v %v", initial, err)
	}
	f.ambiguous = true
	const amount = 747268
	deposit, err := f.fundNative(t, amount)
	if err != nil || deposit.Phase != "deposit_pending" || f.prepared != 1 || f.paths != 2 || len(f.accepted) != 1 {
		t.Fatalf("native deposit failed: %+v %v", deposit, err)
	}
	tx := f.accepted[deposit.TransactionHash]
	expected := new(big.Int).Mul(big.NewInt(amount), big.NewInt(1_000_000_000))
	simulated, _ := new(big.Int).SetString(strings.TrimPrefix(f.estimateValue, "0x"), 16)
	if tx.Nonce() != 0 || !strings.EqualFold(tx.To().Hex(), addressTestVault) || tx.Value().Cmp(expected) != 0 || simulated == nil || simulated.Cmp(expected) != 0 || len(tx.Data()) != 4+34*32 || hex.EncodeToString(tx.Data()[:4]) != "c588341c" {
		t.Fatal("native signed value, calldata, or simulated value is incorrect")
	}
	if tx.Type() != types.DynamicFeeTxType || f.overrideReads != 2 {
		t.Fatal("native quote/signing did not use state override quote and EIP-1559")
	}

	f.h = &FundingHandler{client: f.h.client, statePath: f.h.statePath}
	again, err := f.fundNative(t, amount)
	if err != nil || again.TransactionHash != deposit.TransactionHash || len(f.submitted) != 2 || f.submitted[0] != f.submitted[1] || len(f.accepted) != 1 {
		t.Fatalf("native ambiguous recovery changed transaction: %v", err)
	}
	f.mine(t, deposit.TransactionHash, false)
	f.finalized = "0x1"
	pending, err := f.fundNative(t, amount)
	if err != nil || pending.Phase != "deposit_pending" || f.activated != 0 {
		t.Fatal("native deposit activated before finality")
	}
	f.finalized = "0x20"
	active, err := f.fundNative(t, amount)
	if err != nil || active.Phase != "active" || f.activated != 1 {
		t.Fatalf("native activation failed: %+v %v", active, err)
	}
	f.h = &FundingHandler{client: f.h.client, statePath: f.h.statePath}
	active, err = f.fundNative(t, amount)
	if err != nil || active.Phase != "active" || f.activated != 1 || len(f.accepted) != 1 {
		t.Fatal("restart reinitialized native note")
	}
}

func TestNativeFundingRequiresPrincipalAndFees(t *testing.T) {
	f := newAddressFixture(t, true)
	const amount = 747268
	principal := new(big.Int).Mul(big.NewInt(amount), big.NewInt(1_000_000_000))
	f.eth = "0x" + principal.Text(16)
	status, err := f.fundNative(t, amount)
	if err != nil || status.Phase != "waiting_funds" || len(f.accepted) != 0 || !strings.Contains(status.Message, "more") {
		t.Fatalf("principal-only balance allowed deposit or lost actionable message: %+v %v", status, err)
	}
	f.eth = "0x" + new(big.Int).Sub(principal, big.NewInt(1)).Text(16)
	status, err = f.h.Address(context.Background())
	if err != nil || status.TokenBalance != "747267" {
		t.Fatalf("native balance rounded up: %+v %v", status, err)
	}
}

func TestNativeFundingRecoveryRejectsDeploymentUnitAndValueChanges(t *testing.T) {
	for _, mutation := range []string{"deployment", "unit", "scale", "legacy_version", "signed_value", "saved_amount", "saved_commitment", "token_approval"} {
		t.Run(mutation, func(t *testing.T) {
			f := newAddressFixture(t, true)
			if _, err := f.fundNative(t, 100000); err != nil {
				t.Fatal(err)
			}
			raw, err := os.ReadFile(f.h.addressStatePath())
			if err != nil {
				t.Fatal(err)
			}
			var record addressFundingRecord
			if json.Unmarshal(raw, &record) != nil {
				t.Fatal("bad fixture journal")
			}
			switch mutation {
			case "deployment":
				record.DeploymentID = "other-deployment"
			case "unit":
				record.BillingUnit = "wei"
			case "scale":
				record.WeiPerUnit = "1"
			case "legacy_version":
				record.Version = 1
			case "saved_amount":
				record.Amount++
			case "saved_commitment":
				record.Commitment = "0x5678"
			case "token_approval":
				record.Pending.Kind = "approval"
			case "signed_value":
				original := f.accepted[record.Pending.Hash]
				key, _ := crypto.HexToECDSA(record.PrivateKey)
				replacement := types.NewTransaction(original.Nonce(), *original.To(), big.NewInt(1), original.Gas(), original.GasPrice(), original.Data())
				signed, err := types.SignTx(replacement, types.NewEIP155Signer(big.NewInt(1)), key)
				if err != nil {
					t.Fatal(err)
				}
				encoded, _ := signed.MarshalBinary()
				record.Pending.Raw, record.Pending.Hash = "0x"+hex.EncodeToString(encoded), signed.Hash().Hex()
			}
			if err := f.h.saveAddress(&record); err != nil {
				t.Fatal(err)
			}
			before, _ := os.ReadFile(f.h.addressStatePath())
			if _, err := f.fundNative(t, 100000); err == nil {
				t.Fatal("mismatched native recovery accepted")
			}
			after, _ := os.ReadFile(f.h.addressStatePath())
			if string(before) != string(after) || len(f.submitted) != 1 {
				t.Fatal("invalid recovery modified or rebroadcast")
			}
		})
	}
}

func TestNativeFundingDoesNotSilentlyRebindLegacySignerOrDeposit(t *testing.T) {
	for _, signer := range []bool{true, false} {
		f := newAddressFixture(t)
		if signer {
			if _, err := f.h.Address(context.Background()); err != nil {
				t.Fatal(err)
			}
		} else if err := f.h.save(depositRecord{ChainID: 1, Contract: addressTestVault, Amount: 100000, Secret: "0x123", Commitment: "0x1234"}); err != nil {
			t.Fatal(err)
		}
		f.native = true
		if _, err := f.fundNative(t, 100000); err == nil {
			t.Fatal("legacy state silently rebound to native deployment")
		}
		if f.prepared != 0 || len(f.submitted) != 0 {
			t.Fatal("migration created or broadcast another note")
		}
	}
}

func TestNativeFundingConfigurationMustMatchPackagedDeploymentAndGwei(t *testing.T) {
	for _, mutation := range []string{"deployment_id", "contract_address", "billing_unit", "native_asset_wei_per_unit", "token"} {
		t.Run(mutation, func(t *testing.T) {
			f := newAddressFixture(t, true)
			upstream := f.h.client.local.Transport
			f.h.client.local.Transport = withdrawalRoundTripper(func(r *http.Request) (*http.Response, error) {
				response, err := upstream.RoundTrip(r)
				if err != nil || r.URL.Path != "/funding/config" {
					return response, err
				}
				defer response.Body.Close()
				var body map[string]any
				if err := json.NewDecoder(response.Body).Decode(&body); err != nil {
					t.Fatal(err)
				}
				switch mutation {
				case "deployment_id":
					body[mutation] = "other-native-deployment"
				case "contract_address":
					body[mutation] = addressTestToken
				case "billing_unit":
					body[mutation] = "wei"
				case "native_asset_wei_per_unit":
					body[mutation] = "1"
				case "token":
					body["demo_billing_token_address"] = addressTestToken
				}
				return withdrawalJSONResponse(r, 200, body), nil
			})
			if _, err := f.h.Address(context.Background()); err == nil {
				t.Fatal("invalid native funding configuration accepted")
			}
			if _, err := os.Stat(f.h.addressStatePath()); !os.IsNotExist(err) {
				t.Fatal("invalid deployment created custody state")
			}
		})
	}
}

func TestNativeManualConfirmationRequiresFinalityWithoutSignerJournal(t *testing.T) {
	f := newAddressFixture(t, true)
	if _, err := f.h.prepare(context.Background(), 100000); err != nil {
		t.Fatal(err)
	}
	hash := "0x" + strings.Repeat("a", 64)
	f.receipts[hash] = map[string]any{
		"transactionHash": hash, "status": "0x1", "blockNumber": "0x10", "blockHash": addressTestBlock,
		"to": addressTestVault, "logs": sampleReceipt(depositRecord{Contract: addressTestVault, Commitment: "0x1234", Amount: 100000}).Logs,
	}
	f.finalized = "0x1"
	if _, err := f.h.confirm(context.Background(), hash); err == nil || f.activated != 0 {
		t.Fatal("manual native receipt bypassed finality")
	}
	f.finalized = "0x20"
	if _, err := f.h.confirm(context.Background(), hash); err != nil || f.activated != 1 {
		t.Fatalf("final native receipt rejected: %v", err)
	}
}
