package zkapi

import (
	"context"
	"encoding/json"
	"net/http"
	"strconv"
)

// WalletReadiness contains only the local state needed by guided setup. It
// omits note identifiers, destinations, proofs, and recovery material.
type WalletReadiness struct {
	HasNote           bool
	PendingRequest    bool
	Balance           uint64
	WithdrawalPending bool
}

// Readiness never creates a lease or prepares a transaction. Withdrawal
// reservations are checked independently because they can survive an
// interruption before the Go funding journal records them.
func (c *Client) Readiness(ctx context.Context) (WalletReadiness, error) {
	invalid := func() (WalletReadiness, error) {
		return WalletReadiness{}, &Error{http.StatusBadGateway, "invalid_wallet_readiness"}
	}
	raw, err := c.WalletStatus(ctx)
	if err != nil {
		return WalletReadiness{}, err
	}
	var wallet struct {
		HasNote        *bool `json:"has_note"`
		PendingRequest *bool `json:"pending_request"`
		Note           *struct {
			ID      *uint64 `json:"note_id"`
			Balance *uint64 `json:"current_balance"`
		} `json:"note"`
	}
	if json.Unmarshal(raw, &wallet) != nil || wallet.HasNote == nil || wallet.PendingRequest == nil {
		return invalid()
	}
	result := WalletReadiness{HasNote: *wallet.HasNote, PendingRequest: *wallet.PendingRequest}
	if result.HasNote {
		if wallet.Note == nil || wallet.Note.ID == nil || *wallet.Note.ID > 0xffffffff || wallet.Note.Balance == nil {
			return invalid()
		}
		result.Balance = *wallet.Note.Balance
	} else if wallet.Note != nil {
		return invalid()
	}
	raw, err = c.request(ctx, http.MethodGet, "/oa/v1/withdraw/status", nil)
	if err != nil {
		return WalletReadiness{}, err
	}
	var withdrawal struct {
		Phase   string  `json:"phase"`
		NoteID  *uint64 `json:"note_id"`
		Balance string  `json:"final_balance"`
	}
	if json.Unmarshal(raw, &withdrawal) != nil {
		return invalid()
	}
	switch withdrawal.Phase {
	case "none":
		if withdrawal.NoteID != nil || withdrawal.Balance != "" {
			return invalid()
		}
	case "reserved", "complete":
		balance, parseErr := strconv.ParseUint(withdrawal.Balance, 10, 64)
		if withdrawal.NoteID == nil || *withdrawal.NoteID > 0xffffffff || parseErr != nil || strconv.FormatUint(balance, 10) != withdrawal.Balance {
			return invalid()
		}
		if withdrawal.Phase == "reserved" {
			if result.HasNote && (*wallet.Note.ID != *withdrawal.NoteID || result.Balance != balance) {
				return invalid()
			}
			result.WithdrawalPending = true
		} else if result.HasNote && *wallet.Note.ID == *withdrawal.NoteID {
			// A completed record for an older note is normal. An apparently
			// active copy of the closed note is not ready to spend.
			return invalid()
		}
	default:
		return invalid()
	}
	return result, nil
}
