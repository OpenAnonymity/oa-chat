package zkapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"
)

// ServeAdminHTTP is mounted behind API bearer, browser-origin, and owner
// management-token checks. Quoting cannot sign; approval names a saved quote.
func (h *FundingHandler) ServeAdminHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Minute)
	defer cancel()
	if r.Method == http.MethodPost && !strings.HasPrefix(r.Header.Get("Content-Type"), "application/json") {
		w.WriteHeader(http.StatusUnsupportedMediaType)
		_ = json.NewEncoder(w).Encode(map[string]string{"error": "JSON required"})
		return
	}
	decode := func(body any) error { return decodeJSON(http.MaxBytesReader(w, r.Body, 1024), body) }
	var result any
	var err error
	switch {
	case r.Method == http.MethodGet && r.URL.Path == "/admin/funding/address":
		result, err = h.Address(ctx)
	case r.Method == http.MethodGet && r.URL.Path == "/admin/withdrawal":
		result, err = h.AddressWithdrawal(ctx)
	case r.Method == http.MethodGet && r.URL.Path == "/admin/return":
		result, err = h.AddressReturn(ctx)
	case r.Method == http.MethodGet && (r.URL.Path == "/admin/funding/quote" || r.URL.Path == "/admin/withdrawal/quote" || r.URL.Path == "/admin/return/quote"):
		kind := "deposit"
		if r.URL.Path == "/admin/withdrawal/quote" {
			kind = "withdrawal"
		} else if r.URL.Path == "/admin/return/quote" {
			kind = "return"
		}
		result, err = h.SavedAddressQuote(ctx, kind)
	case r.Method == http.MethodPost && r.URL.Path == "/admin/funding/quote":
		var body struct {
			Amount   uint64 `json:"amount"`
			MicroUSD uint64 `json:"micro_usd"`
		}
		if err = decode(&body); err == nil {
			if (body.Amount == 0) == (body.MicroUSD == 0) {
				err = errors.New("choose one positive ETH or USD principal")
			} else if body.MicroUSD != 0 {
				result, err = h.QuoteAddressDepositUSD(ctx, body.MicroUSD)
			} else {
				result, err = h.QuoteAddressDeposit(ctx, body.Amount)
			}
		}
	case r.Method == http.MethodPost && (r.URL.Path == "/admin/funding/approve" || r.URL.Path == "/admin/withdrawal/approve" || r.URL.Path == "/admin/return/approve"):
		var body struct {
			QuoteID string `json:"quote_id"`
		}
		if err = decode(&body); err == nil {
			if len(body.QuoteID) != 64 {
				err = errors.New("invalid quote ID")
			} else {
				switch r.URL.Path {
				case "/admin/funding/approve":
					result, err = h.ApproveAddressDeposit(ctx, body.QuoteID)
				case "/admin/withdrawal/approve":
					result, err = h.ApproveAddressWithdrawal(ctx, body.QuoteID)
				case "/admin/return/approve":
					result, err = h.ApproveAddressReturn(ctx, body.QuoteID)
				}
			}
		}
	case r.Method == http.MethodPost && (r.URL.Path == "/admin/withdrawal" || r.URL.Path == "/admin/withdrawal/quote"):
		var body struct {
			Destination                 string  `json:"destination"`
			NoteID                      *uint64 `json:"note_id"`
			RetryTransactionHash        string  `json:"retry_transaction_hash,omitempty"`
			ConfirmationTransactionHash string  `json:"confirmation_transaction_hash,omitempty"`
		}
		if err = decode(&body); err == nil {
			if body.NoteID == nil {
				err = errors.New("withdrawal requires the selected private note ID")
			} else if r.URL.Path == "/admin/withdrawal/quote" {
				if body.ConfirmationTransactionHash != "" {
					err = errors.New("receipt adoption cannot create a quote")
				} else {
					result, err = h.QuoteAddressWithdrawal(ctx, body.Destination, *body.NoteID, body.RetryTransactionHash)
				}
			} else {
				result, err = h.WithdrawAddress(ctx, body.Destination, *body.NoteID, body.RetryTransactionHash, body.ConfirmationTransactionHash)
			}
		}
	case r.Method == http.MethodPost && r.URL.Path == "/admin/funding/deposit":
		var body struct {
			Amount uint64 `json:"amount"`
		}
		if err = decode(&body); err == nil {
			if body.Amount == 0 {
				err = errors.New("missing saved deposit amount")
			} else {
				result, err = h.FundAddress(ctx, body.Amount)
			}
		}
	case r.Method == http.MethodPost && r.URL.Path == "/admin/return/quote":
		var body struct {
			Destination string `json:"destination"`
			AmountWei   string `json:"amount_wei"`
		}
		if err = decode(&body); err == nil {
			result, err = h.QuoteAddressReturn(ctx, body.Destination, body.AmountWei)
		}
	case r.Method == http.MethodPost && r.URL.Path == "/admin/return":
		// The replay endpoint accepts no instructions that could change value,
		// destination, nonce, or fees of the saved signed transaction.
		if r.ContentLength > 0 {
			var body struct{}
			err = decode(&body)
		}
		if err == nil {
			result, err = h.ResumeAddressReturn(ctx)
		}
	default:
		w.WriteHeader(http.StatusNotFound)
		_ = json.NewEncoder(w).Encode(map[string]string{"error": "unknown management endpoint"})
		return
	}
	if err != nil {
		w.WriteHeader(http.StatusBadGateway)
		_ = json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
		return
	}
	_ = json.NewEncoder(w).Encode(result)
}
