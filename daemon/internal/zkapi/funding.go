package zkapi

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"embed"
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
	"strconv"
	"strings"
	"sync"
	"time"
)

//go:embed funding.html funding.js
var fundingAssets embed.FS

const depositEventTopic = "0x7c83dba8534bea9e30d6444f9ca6462dc906897f9938d220dbbe4358c1f7a063"

type FundingHandler struct {
	client    *Client
	origin    string
	statePath string
	mu        sync.Mutex
	sessions  map[[32]byte]time.Time
}

type fundingConfig struct {
	ChainID         uint64 `json:"chain_id"`
	Contract        string `json:"contract_address"`
	Token           string `json:"token_address"`
	RPC             string `json:"rpc_url"`
	DemoMintEnabled bool   `json:"demo_mint_enabled"`
}
type depositRecord struct {
	ChainID         uint64   `json:"chain_id"`
	Contract        string   `json:"contract_address"`
	Amount          uint64   `json:"amount"`
	Secret          string   `json:"secret"`
	Commitment      string   `json:"commitment"`
	ZeroPath        []string `json:"zero_path"`
	TransactionHash string   `json:"transaction_hash,omitempty"`
	Active          bool     `json:"active,omitempty"`
}

// NewFundingHandler serves only self-hosted assets and a capability-scoped
// funding API. The daemon's authenticated admin API calls NewSession; local
// chat API credentials are never exposed to browser JavaScript.
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
	return &FundingHandler{client: client, origin: strings.TrimRight(publicOrigin, "/"), statePath: filepath.Join(stateDir, "pending-deposit.json"), sessions: make(map[[32]byte]time.Time)}, nil
}

func (h *FundingHandler) NewSession() (string, error) {
	nonce := make([]byte, 32)
	if _, err := rand.Read(nonce); err != nil {
		return "", err
	}
	token := hex.EncodeToString(nonce)
	h.mu.Lock()
	defer h.mu.Unlock()
	for hash, expiry := range h.sessions {
		if time.Now().After(expiry) {
			delete(h.sessions, hash)
		}
	}
	h.sessions[sha256.Sum256([]byte(token))] = time.Now().Add(30 * time.Minute)
	return h.origin + "/funding#" + token, nil
}

func (h *FundingHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), time.Minute)
	defer cancel()
	r = r.WithContext(ctx)
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Referrer-Policy", "no-referrer")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'")
	origin, _ := url.Parse(h.origin)
	if r.Host != origin.Host || (r.Header.Get("Origin") != "" && r.Header.Get("Origin") != h.origin) {
		http.Error(w, "invalid funding origin", http.StatusForbidden)
		return
	}
	if r.Method == http.MethodGet && (r.URL.Path == "/funding" || r.URL.Path == "/funding/" || r.URL.Path == "/funding/app.js") {
		file, contentType := "funding.html", "text/html; charset=utf-8"
		if r.URL.Path == "/funding/app.js" {
			file, contentType = "funding.js", "text/javascript; charset=utf-8"
		}
		data, _ := fundingAssets.ReadFile(file)
		w.Header().Set("Content-Type", contentType)
		_, _ = w.Write(data)
		return
	}
	token := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
	h.mu.Lock()
	defer h.mu.Unlock()
	expiry, ok := h.sessions[sha256.Sum256([]byte(token))]
	if !ok || time.Now().After(expiry) {
		http.Error(w, "funding session expired; run oa-chat fund again", http.StatusUnauthorized)
		return
	}
	if r.Method == http.MethodPost && !strings.HasPrefix(r.Header.Get("Content-Type"), "application/json") {
		http.Error(w, "JSON required", http.StatusUnsupportedMediaType)
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 16<<10)
	var result any
	var err error
	switch {
	case r.Method == http.MethodGet && r.URL.Path == "/funding/api/address":
		result, err = h.addressLocked(r.Context())
	case r.Method == http.MethodPost && r.URL.Path == "/funding/api/address/deposit":
		var body struct {
			Amount uint64 `json:"amount"`
		}
		if err = decodeJSON(r.Body, &body); err == nil {
			result, err = h.fundAddressLocked(r.Context(), body.Amount)
		}
	case r.Method == http.MethodGet && r.URL.Path == "/funding/api/config":
		result, err = h.config(r.Context())
	case r.Method == http.MethodGet && r.URL.Path == "/funding/api/path":
		result, err = h.depositPath(r.Context())
	case r.Method == http.MethodGet && r.URL.Path == "/funding/api/status":
		var data json.RawMessage
		data, err = h.client.WalletStatus(r.Context())
		if err == nil {
			var status struct {
				HasNote bool `json:"has_note"`
				Pending bool `json:"pending_request"`
				Note    struct {
					Balance json.Number `json:"current_balance"`
				} `json:"note"`
			}
			if json.Unmarshal(data, &status) != nil {
				err = errors.New("invalid wallet status")
			} else {
				result = map[string]any{"has_note": status.HasNote, "pending_request": status.Pending, "balance": status.Note.Balance}
			}
		}
	case r.Method == http.MethodPost && r.URL.Path == "/funding/api/prepare":
		var body struct {
			Amount uint64 `json:"amount"`
		}
		if err = decodeJSON(r.Body, &body); err == nil {
			result, err = h.prepare(r.Context(), body.Amount)
		}
	case r.Method == http.MethodPost && r.URL.Path == "/funding/api/confirm":
		var body struct {
			TransactionHash string `json:"transaction_hash"`
		}
		if err = decodeJSON(r.Body, &body); err == nil {
			result, err = h.confirm(r.Context(), body.TransactionHash)
		}
	default:
		http.NotFound(w, r)
		return
	}
	if err != nil {
		status := http.StatusBadGateway
		var bridgeErr *Error
		if errors.As(err, &bridgeErr) {
			status = bridgeErr.Status
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_ = json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(result)
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
	if wire.ChainID != expected || !isHex(wire.Contract, 20) || !isHex(wire.Token, 20) || err != nil || rpc.Scheme != "https" || rpc.Host == "" || rpc.User != nil || rpc.Fragment != "" {
		return fundingConfig{}, errors.New("invalid funding network or contract")
	}
	return fundingConfig{
		ChainID: wire.ChainID, Contract: wire.Contract, Token: wire.Token, RPC: wire.RPC,
		DemoMintEnabled: wire.DemoMintEnabled && wire.ChainID == 11155111,
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
		HasNote bool `json:"has_note"`
	}
	if json.Unmarshal(status, &wallet) != nil {
		return nil, errors.New("invalid wallet status")
	}
	var record depositRecord
	raw, err := os.ReadFile(h.statePath)
	if err == nil {
		if json.Unmarshal(raw, &record) != nil {
			return nil, errors.New("pending deposit recovery data is invalid; preserve the file for recovery")
		}
		if record.ChainID != config.ChainID || !strings.EqualFold(record.Contract, config.Contract) {
			return nil, errors.New("pending deposit belongs to another deployment; preserve it for recovery")
		}
		if record.Active && !wallet.HasNote {
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
		} else {
			if record.Amount != amount {
				return nil, fmt.Errorf("a deposit for %s USDC is pending; resume that amount first", strconv.FormatFloat(float64(record.Amount)/1e6, 'f', 6, 64))
			}
			return publicDeposit(record), nil
		}
	}
	if !errors.Is(err, os.ErrNotExist) {
		return nil, errors.New("cannot read pending deposit recovery data")
	}
	if wallet.HasNote {
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
	if json.Unmarshal(raw, &record) != nil || record.ChainID != config.ChainID || !strings.EqualFold(record.Contract, config.Contract) {
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
	for _, log := range receipt.Logs {
		if !strings.EqualFold(log.Address, record.Contract) || len(log.Topics) != 3 || !strings.EqualFold(log.Topics[0], depositEventTopic) {
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
		return uint32(note.Uint64()), expiry.Uint64(), nil
	}
	return 0, 0, errors.New("deposit receipt has no event matching this private note")
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
