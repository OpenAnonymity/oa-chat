package zkapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"
)

// ServeAdminHTTP must be mounted behind server.API's bearer/origin checks.
// Only explicit deposit requests can sign transactions; address reads cannot.
func (h *FundingHandler) ServeAdminHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	timeout := time.Minute
	if r.Method == http.MethodPost && r.URL.Path == "/admin/withdrawal" {
		timeout = 10 * time.Minute
	}
	ctx, cancel := context.WithTimeout(r.Context(), timeout)
	defer cancel()
	var result any
	var err error
	switch {
	case r.Method == http.MethodPost && r.URL.Path == "/admin/fund":
		var link string
		link, err = h.NewSession()
		result = map[string]string{"url": link}
	case r.Method == http.MethodGet && r.URL.Path == "/admin/funding/address":
		result, err = h.Address(ctx)
	case r.Method == http.MethodGet && r.URL.Path == "/admin/withdrawal":
		result, err = h.AddressWithdrawal(ctx)
	case r.Method == http.MethodPost && r.URL.Path == "/admin/withdrawal":
		if !strings.HasPrefix(r.Header.Get("Content-Type"), "application/json") {
			w.WriteHeader(http.StatusUnsupportedMediaType)
			_ = json.NewEncoder(w).Encode(map[string]string{"error": "JSON required"})
			return
		}
		var body struct {
			Destination                 string  `json:"destination"`
			NoteID                      *uint64 `json:"note_id"`
			RetryTransactionHash        string  `json:"retry_transaction_hash,omitempty"`
			ConfirmationTransactionHash string  `json:"confirmation_transaction_hash,omitempty"`
		}
		if err = decodeJSON(http.MaxBytesReader(w, r.Body, 1024), &body); err == nil {
			if body.NoteID == nil {
				err = errors.New("withdrawal requires the selected private note ID")
			} else {
				result, err = h.WithdrawAddress(ctx, body.Destination, *body.NoteID, body.RetryTransactionHash, body.ConfirmationTransactionHash)
			}
		}
	case r.Method == http.MethodPost && r.URL.Path == "/admin/funding/deposit":
		if !strings.HasPrefix(r.Header.Get("Content-Type"), "application/json") {
			w.WriteHeader(http.StatusUnsupportedMediaType)
			_ = json.NewEncoder(w).Encode(map[string]string{"error": "JSON required"})
			return
		}
		var body struct {
			Amount uint64 `json:"amount"`
		}
		if err = decodeJSON(http.MaxBytesReader(w, r.Body, 1024), &body); err == nil {
			result, err = h.FundAddress(ctx, body.Amount)
		}
	default:
		w.WriteHeader(http.StatusNotFound)
		_ = json.NewEncoder(w).Encode(map[string]string{"error": "unknown management endpoint"})
		return
	}
	if err != nil {
		// Funding errors are deliberately local, redacted messages. RPC bodies,
		// private keys and signed transactions never cross this boundary.
		w.WriteHeader(http.StatusBadGateway)
		_ = json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
		return
	}
	_ = json.NewEncoder(w).Encode(result)
}
