package zkapi

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/big"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

const depositEventTopic = "0x7c83dba8534bea9e30d6444f9ca6462dc906897f9938d220dbbe4358c1f7a063"

type FundingHandler struct {
	client    *Client
	statePath string
	mu        sync.Mutex
}

type fundingConfig struct {
	DeploymentID    string `json:"deployment_id,omitempty"`
	BillingAsset    string `json:"billing_asset,omitempty"`
	BillingUnit     string `json:"billing_unit,omitempty"`
	WeiPerUnit      string `json:"native_asset_wei_per_unit,omitempty"`
	ChainID         uint64 `json:"chain_id"`
	Contract        string `json:"contract_address"`
	Token           string `json:"token_address"`
	RPC             string `json:"rpc_url"`
	DemoMintEnabled bool   `json:"demo_mint_enabled"`
}
type depositRecord struct {
	DeploymentID    string   `json:"deployment_id,omitempty"`
	BillingAsset    string   `json:"billing_asset,omitempty"`
	BillingUnit     string   `json:"billing_unit,omitempty"`
	WeiPerUnit      string   `json:"native_asset_wei_per_unit,omitempty"`
	ChainID         uint64   `json:"chain_id"`
	Contract        string   `json:"contract_address"`
	Amount          uint64   `json:"amount"`
	Secret          string   `json:"secret"`
	Commitment      string   `json:"commitment"`
	ZeroPath        []string `json:"zero_path"`
	TransactionHash string   `json:"transaction_hash,omitempty"`
	Active          bool     `json:"active,omitempty"`
}

// NewFundingHandler manages local custody through the authenticated CLI admin API.
func NewFundingHandler(client *Client, publicOrigin, stateDir string) (*FundingHandler, error) {
	if client == nil {
		return nil, errors.New("funding needs a zkAPI client")
	}
	if err := validateLoopbackURL(publicOrigin); err != nil {
		return nil, err
	}
	if stateDir == "" {
		return nil, errors.New("funding needs a private state directory")
	}
	stateDir = filepath.Join(stateDir, client.config.Network)
	if err := os.MkdirAll(stateDir, 0700); err != nil {
		return nil, err
	}
	if err := os.Chmod(stateDir, 0700); err != nil {
		return nil, err
	}
	if err := syncDirectoryChain(stateDir); err != nil {
		return nil, errors.New("cannot sync private funding directory")
	}
	return &FundingHandler{client: client, statePath: filepath.Join(stateDir, "pending-deposit.json")}, nil
}

func decodeJSON(r io.Reader, v any) error {
	d := json.NewDecoder(r)
	d.DisallowUnknownFields()
	if err := d.Decode(v); err != nil {
		return errors.New("invalid funding request")
	}
	if err := d.Decode(new(any)); err != io.EOF {
		return errors.New("invalid funding request")
	}
	return nil
}

func (h *FundingHandler) config(ctx context.Context) (fundingConfig, error) {
	if err := h.client.Check(ctx); err != nil {
		return fundingConfig{}, err
	}
	raw, err := h.client.request(ctx, http.MethodGet, "/funding/config", nil)
	if err != nil {
		return fundingConfig{}, err
	}
	var wire struct {
		DeploymentID    string `json:"deployment_id"`
		BillingAsset    string `json:"billing_asset"`
		BillingUnit     string `json:"billing_unit"`
		WeiPerUnit      string `json:"native_asset_wei_per_unit"`
		ChainID         uint64 `json:"chain_id"`
		Contract        string `json:"contract_address"`
		Token           string `json:"demo_billing_token_address"`
		RPC             string `json:"demo_rpc_url"`
		DemoMintEnabled bool   `json:"demo_mint_enabled"`
	}
	if json.Unmarshal(raw, &wire) != nil {
		return fundingConfig{}, errors.New("invalid funding configuration")
	}
	expected, _ := ChainID(h.client.config.Network)
	rpc, err := url.Parse(wire.RPC)
	if wire.ChainID != expected || !isHex(wire.Contract, 20) || err != nil || rpc.Scheme != "https" || rpc.Host == "" || rpc.User != nil || rpc.Fragment != "" {
		return fundingConfig{}, errors.New("invalid funding network or contract")
	}
	if wire.BillingAsset == "native_eth" {
		deployment, _, deploymentErr := pinnedDeployment(h.client.config.Network)
		if deploymentErr != nil || wire.DeploymentID != deployment.ID || wire.ChainID != deployment.ChainID || !strings.EqualFold(wire.Contract, deployment.Contract) || wire.BillingAsset != deployment.Asset || wire.BillingUnit != deployment.Unit {
			return fundingConfig{}, errors.New("native funding configuration does not match the packaged deployment")
		}
		if wire.DeploymentID == "" || wire.Token != "" || wire.BillingUnit != "gwei" || wire.WeiPerUnit != "1000000000" {
			return fundingConfig{}, errors.New("invalid native ETH funding units or deployment")
		}
	} else if (wire.BillingAsset != "" && wire.BillingAsset != "erc20") || !isHex(wire.Token, 20) || wire.WeiPerUnit != "" {
		return fundingConfig{}, errors.New("invalid billing asset configuration")
	}
	return fundingConfig{
		DeploymentID: wire.DeploymentID, BillingAsset: wire.BillingAsset, BillingUnit: wire.BillingUnit, WeiPerUnit: wire.WeiPerUnit,
		ChainID: wire.ChainID, Contract: wire.Contract, Token: wire.Token, RPC: wire.RPC,
		DemoMintEnabled: wire.DemoMintEnabled && wire.ChainID == 11155111 && wire.BillingAsset != "native_eth",
	}, nil
}

func (h *FundingHandler) prepare(ctx context.Context, amount uint64) (any, error) {
	if amount == 0 || amount > 1_000_000_000_000 {
		return nil, errors.New("invalid deposit amount")
	}
	config, err := h.config(ctx)
	if err != nil {
		return nil, err
	}
	if err := h.checkWithdrawalFunding(config); err != nil {
		return nil, err
	}
	status, err := h.client.WalletStatus(ctx)
	if err != nil {
		return nil, err
	}
	var wallet struct {
		HasNote *bool `json:"has_note"`
		Pending bool  `json:"pending_request"`
	}
	if json.Unmarshal(status, &wallet) != nil || wallet.HasNote == nil {
		return nil, errors.New("invalid wallet status")
	}
	var record depositRecord
	raw, err := os.ReadFile(h.statePath)
	if err == nil {
		if json.Unmarshal(raw, &record) != nil {
			return nil, errors.New("pending deposit recovery data is invalid; preserve the file for recovery")
		}
		if !depositDeploymentMatches(record, config) {
			return nil, errors.New("pending deposit belongs to another deployment; preserve it for recovery")
		}
		if record.Active && !*wallet.HasNote && !wallet.Pending {
			// Keep completed recovery notes in a private archive rather than
			// blocking every later deposit or deleting the old note secret.
			digest := sha256.Sum256([]byte(record.TransactionHash))
			archive := h.statePath + ".completed-" + hex.EncodeToString(digest[:])
			if err := os.Rename(h.statePath, archive); err != nil {
				return nil, errors.New("cannot archive completed deposit recovery data")
			}
			directory, archiveOpenErr := os.Open(filepath.Dir(h.statePath))
			if archiveOpenErr != nil {
				return nil, errors.New("cannot sync archived deposit recovery data")
			}
			syncErr := directory.Sync()
			_ = directory.Close()
			if syncErr != nil {
				return nil, errors.New("cannot sync archived deposit recovery data")
			}
			record = depositRecord{}
			err = os.ErrNotExist
		} else if record.Amount == amount {
			return publicDeposit(record), nil
		} else {
			// An explicit amount edit may replace only a definitely unsigned
			// native draft. Both journals must agree that no transaction exists.
			if !config.nativeETH() || *wallet.HasNote || wallet.Pending || record.Active || record.TransactionHash != "" {
				return nil, fmt.Errorf("a deposit for %d billing units is pending; resume that amount first", record.Amount)
			}
			address, addressErr := h.loadAddress(config)
			if addressErr != nil || address.Pending != nil || (address.Phase != "ready" && address.Phase != "waiting_funds") {
				return nil, fmt.Errorf("a deposit for %d billing units is pending; resume that amount first", record.Amount)
			}
			digest := sha256.Sum256([]byte(record.Commitment))
			archive := h.statePath + ".unsigned-" + hex.EncodeToString(digest[:])
			if err := os.Rename(h.statePath, archive); err != nil {
				return nil, errors.New("cannot archive the previous unsigned deposit draft")
			}
			if err := syncDirectoryChain(filepath.Dir(h.statePath)); err != nil {
				return nil, errors.New("cannot sync the previous unsigned deposit draft")
			}
			record = depositRecord{}
			err = os.ErrNotExist
		}
	}
	if !errors.Is(err, os.ErrNotExist) {
		return nil, errors.New("cannot read pending deposit recovery data")
	}
	if *wallet.HasNote || wallet.Pending {
		return nil, errors.New("a private note is already active; preserve or withdraw it before funding a new note")
	}
	body, _ := json.Marshal(map[string]uint64{"amount": amount})
	raw, err = h.client.request(ctx, http.MethodPost, "/funding/api/deposit/prepare", body)
	if err != nil {
		return nil, err
	}
	if json.Unmarshal(raw, &record) != nil || record.Amount != amount || !isField(record.Secret) || !isField(record.Commitment) || len(record.ZeroPath) != 32 {
		return nil, errors.New("invalid deposit preparation")
	}
	for _, sibling := range record.ZeroPath {
		if !isField(sibling) {
			return nil, errors.New("invalid deposit path")
		}
	}
	record.ChainID, record.Contract = config.ChainID, config.Contract
	record.DeploymentID, record.BillingAsset, record.BillingUnit, record.WeiPerUnit = config.DeploymentID, config.BillingAsset, config.BillingUnit, config.WeiPerUnit
	if err := h.save(record); err != nil {
		return nil, err
	}
	return publicDeposit(record), nil
}

func publicDeposit(r depositRecord) any {
	return map[string]any{"amount": r.Amount, "commitment": r.Commitment, "zero_path": r.ZeroPath, "transaction_hash": r.TransactionHash, "active": r.Active}
}
func isHex(s string, n int) bool {
	if len(s) != 2+n*2 || !strings.HasPrefix(s, "0x") {
		return false
	}
	_, err := hex.DecodeString(s[2:])
	return err == nil
}
func isField(s string) bool {
	if !strings.HasPrefix(s, "0x") || len(s) < 3 || len(s) > 66 {
		return false
	}
	for _, digit := range s[2:] {
		if !((digit >= '0' && digit <= '9') || (digit >= 'a' && digit <= 'f') || (digit >= 'A' && digit <= 'F')) {
			return false
		}
	}
	return true
}

func (h *FundingHandler) save(record depositRecord) error {
	raw, err := json.Marshal(record)
	if err != nil {
		return err
	}
	temp, err := os.CreateTemp(filepath.Dir(h.statePath), ".deposit-*")
	if err != nil {
		return errors.New("cannot persist deposit recovery data")
	}
	defer os.Remove(temp.Name())
	if err = temp.Chmod(0600); err == nil {
		_, err = temp.Write(raw)
	}
	if err == nil {
		err = temp.Sync()
	}
	closeErr := temp.Close()
	if err == nil {
		err = closeErr
	}
	if err == nil {
		err = os.Rename(temp.Name(), h.statePath)
	}
	if err == nil {
		dir, e := os.Open(filepath.Dir(h.statePath))
		if e == nil {
			err = dir.Sync()
			_ = dir.Close()
		} else {
			err = e
		}
	}
	if err != nil {
		return errors.New("cannot persist deposit recovery data")
	}
	return nil
}

func (h *FundingHandler) confirm(ctx context.Context, tx string) (any, error) {
	if !isHex(tx, 32) {
		return nil, errors.New("invalid deposit transaction hash")
	}
	config, err := h.config(ctx)
	if err != nil {
		return nil, err
	}
	if err := h.checkWithdrawalFunding(config); err != nil {
		return nil, err
	}
	if err := h.confirmAddressFinality(ctx, config, tx); err != nil {
		return nil, err
	}
	raw, err := os.ReadFile(h.statePath)
	if err != nil {
		return nil, errors.New("no pending deposit to confirm")
	}
	var record depositRecord
	if json.Unmarshal(raw, &record) != nil || !depositDeploymentMatches(record, config) {
		return nil, errors.New("pending deposit does not match the deployment")
	}
	// Preserve the first submitted hash immediately for crash recovery. A
	// corrected hash may replace it only after its receipt matches our note.
	if record.TransactionHash == "" {
		record.TransactionHash = tx
		if err := h.save(record); err != nil {
			return nil, err
		}
	}
	receipt, err := h.receipt(ctx, config.RPC, tx)
	if err != nil {
		return nil, err
	}
	noteID, expiry, err := validateReceipt(receipt, record)
	if err != nil {
		// A mined revert or unrelated receipt cannot fund this note. Clear
		// its retry hint, retaining the secret and commitment for resubmission.
		if strings.EqualFold(record.TransactionHash, tx) && !record.Active {
			record.TransactionHash = ""
			if saveErr := h.save(record); saveErr != nil {
				return nil, saveErr
			}
		}
		return nil, err
	}
	record.TransactionHash = tx
	if err := h.save(record); err != nil {
		return nil, err
	}
	// A retry must never reinitialize an already used note to its deposit
	// balance. Read the companion before calling its initialization endpoint.
	walletRaw, err := h.client.WalletStatus(ctx)
	if err != nil {
		return nil, err
	}
	var wallet struct {
		HasNote bool `json:"has_note"`
		Note    struct {
			NoteID uint32 `json:"note_id"`
		} `json:"note"`
	}
	if json.Unmarshal(walletRaw, &wallet) != nil {
		return nil, errors.New("invalid wallet status")
	}
	if wallet.HasNote {
		if wallet.Note.NoteID != noteID {
			return nil, errors.New("another private note is active; refusing to replace it")
		}
		record.Active = true
		if err := h.save(record); err != nil {
			return nil, err
		}
		if err := h.adoptPostWithdrawalDeposit(config, record, noteID); err != nil {
			return nil, err
		}
		return map[string]any{"active": true, "note_id": noteID}, nil
	}
	if record.Active {
		return nil, errors.New("this deposit was already activated; restore its wallet state instead of reinitializing it")
	}
	body, _ := json.Marshal(map[string]any{"secret": record.Secret, "note_id": noteID, "amount": record.Amount, "expiry_ts": expiry})
	_, err = h.client.request(ctx, http.MethodPost, "/funding/api/deposit/confirm", body)
	if err != nil {
		return nil, err
	}
	record.Active = true
	if err := h.save(record); err != nil {
		return nil, err
	}
	if err := h.adoptPostWithdrawalDeposit(config, record, noteID); err != nil {
		return nil, err
	}
	// Keep the recovery record after activation: losing a crash-raced reply
	// must not discard the only durable record of the deposit transaction.
	return map[string]any{"active": true, "note_id": noteID}, nil
}

type ethReceipt struct {
	Status          string `json:"status"`
	To              string `json:"to"`
	TransactionHash string `json:"transactionHash"`
	Logs            []struct {
		Address string   `json:"address"`
		Topics  []string `json:"topics"`
		Data    string   `json:"data"`
		Removed bool     `json:"removed"`
	} `json:"logs"`
}

func (h *FundingHandler) receipt(ctx context.Context, rpc, tx string) (ethReceipt, error) {
	body, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": 1, "method": "eth_getTransactionReceipt", "params": []string{tx}})
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost, rpc, bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	response, err := h.client.inference.Do(req)
	if err != nil {
		return ethReceipt{}, errors.New("cannot read deposit receipt; retry confirmation")
	}
	defer response.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(response.Body, 1<<20))
	if err != nil || response.StatusCode != 200 {
		return ethReceipt{}, errors.New("cannot read deposit receipt; retry confirmation")
	}
	var result struct {
		Result *ethReceipt `json:"result"`
	}
	if json.Unmarshal(raw, &result) != nil || result.Result == nil {
		return ethReceipt{}, errors.New("deposit is not confirmed yet; retry confirmation")
	}
	if !strings.EqualFold(result.Result.TransactionHash, tx) {
		return ethReceipt{}, errors.New("deposit receipt transaction mismatch")
	}
	return *result.Result, nil
}

func validateReceipt(receipt ethReceipt, record depositRecord) (uint32, uint64, error) {
	if receipt.Status != "0x1" {
		return 0, 0, errors.New("deposit transaction reverted; no private balance was activated")
	}
	// A wallet may wrap the vault call in a router or smart-account transaction.
	// The outer destination is not the deposit's identity: only a matching event
	// emitted by the configured vault proves that this private note was funded.
	commitment, ok := new(big.Int).SetString(strings.TrimPrefix(record.Commitment, "0x"), 16)
	if !ok {
		return 0, 0, errors.New("invalid pending commitment")
	}
	var matchingNote uint32
	var matchingExpiry uint64
	matches := 0
	for _, log := range receipt.Logs {
		if log.Removed || !strings.EqualFold(log.Address, record.Contract) || len(log.Topics) != 3 || !strings.EqualFold(log.Topics[0], depositEventTopic) {
			continue
		}
		if !isHex(log.Topics[1], 32) || !isHex(log.Topics[2], 32) || !isHex(log.Data, 96) {
			continue
		}
		eventCommitment, _ := new(big.Int).SetString(log.Topics[2][2:], 16)
		if eventCommitment.Cmp(commitment) != 0 {
			continue
		}
		note, _ := new(big.Int).SetString(log.Topics[1][2:], 16)
		amount, _ := new(big.Int).SetString(log.Data[2:66], 16)
		expiry, _ := new(big.Int).SetString(log.Data[66:130], 16)
		if !note.IsUint64() || note.Uint64() > 0xffffffff || !amount.IsUint64() || amount.Uint64() != record.Amount || !expiry.IsUint64() || expiry.Uint64() <= uint64(time.Now().Unix()) {
			return 0, 0, errors.New("deposit event values do not match the pending note")
		}
		matchingNote, matchingExpiry = uint32(note.Uint64()), expiry.Uint64()
		matches++
	}
	if matches == 1 {
		return matchingNote, matchingExpiry, nil
	}
	return 0, 0, errors.New("deposit receipt must contain exactly one event matching this private note")
}

// Deposit witnesses describe the current shared tree, not private wallet
// material. Refresh after token approval so other deposits do not leave a
// restored preparation permanently stuck with an obsolete empty-leaf path.
func (h *FundingHandler) depositPath(ctx context.Context) (any, error) {
	if err := h.client.Check(ctx); err != nil {
		return nil, err
	}
	raw, err := h.client.request(ctx, http.MethodGet, "/oa/v1/deposit/path", nil)
	if err != nil {
		return nil, err
	}
	var result struct {
		ZeroPath []string `json:"zero_path"`
	}
	if json.Unmarshal(raw, &result) != nil || len(result.ZeroPath) != 32 {
		return nil, errors.New("invalid refreshed deposit path")
	}
	for _, sibling := range result.ZeroPath {
		if !isField(sibling) {
			return nil, errors.New("invalid refreshed deposit path")
		}
	}
	return result, nil
}

func syncDirectoryChain(path string) error {
	path, err := filepath.Abs(path)
	if err != nil {
		return err
	}
	for {
		directory, err := os.Open(path)
		if err != nil {
			return err
		}
		err = directory.Sync()
		closeErr := directory.Close()
		if err != nil {
			return err
		}
		if closeErr != nil {
			return closeErr
		}
		parent := filepath.Dir(path)
		if parent == path {
			return nil
		}
		path = parent
	}
}

// Old ERC-20 recovery files remain readable only under their original contract.
// Native records require explicit deployment and unit binding: a chain match
// alone must never reinterpret a private balance from another deployment.
func depositDeploymentMatches(record depositRecord, config fundingConfig) bool {
	if record.ChainID != config.ChainID || !strings.EqualFold(record.Contract, config.Contract) {
		return false
	}
	if config.nativeETH() {
		return record.DeploymentID == config.DeploymentID && record.BillingAsset == config.BillingAsset && record.BillingUnit == config.BillingUnit && record.WeiPerUnit == config.WeiPerUnit
	}
	return record.BillingAsset != "native_eth" && (record.DeploymentID == "" || record.DeploymentID == config.DeploymentID)
}

func (config fundingConfig) nativeETH() bool { return config.BillingAsset == "native_eth" }
