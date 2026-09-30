package zkapi

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"math/big"
	"net/http"
)

// SessionEvents is a bounded operational feed from the authenticated local
// wallet. IDs are only for in-memory correlation and must never be logged.
type SessionEvents struct {
	Version       int            `json:"version"`
	InstanceID    string         `json:"instance_id"`
	FirstSequence uint64         `json:"first_sequence"`
	NextSequence  uint64         `json:"next_sequence"`
	Events        []SessionEvent `json:"events"`
}

type SessionEvent struct {
	Sequence     uint64  `json:"sequence"`
	Kind         string  `json:"kind"`
	SessionID    string  `json:"session_id"`
	ChargeUnits  *string `json:"charge_units,omitempty"`
	BalanceUnits *string `json:"balance_units,omitempty"`
}

// SessionEvents reads accounting already verified and installed by the wallet.
// It never creates access, triggers settlement, or estimates a charge from a cap
// or a balance difference. The pinned native deployments account in gwei.
func (c *Client) SessionEvents(ctx context.Context) (SessionEvents, error) {
	if err := c.Check(ctx); err != nil {
		return SessionEvents{}, err
	}
	data, err := c.request(ctx, http.MethodGet, "/oa/v1/session-events", nil)
	if err != nil {
		return SessionEvents{}, err
	}
	var feed SessionEvents
	if json.Unmarshal(data, &feed) != nil || !validSessionEvents(feed) {
		return SessionEvents{}, errors.New("session accounting unavailable")
	}
	return feed, nil
}

func validSessionEvents(feed SessionEvents) bool {
	if feed.Version != 1 || !fixedHex(feed.InstanceID, 16) || feed.FirstSequence == 0 || feed.NextSequence < feed.FirstSequence || len(feed.Events) > 128 || feed.NextSequence-feed.FirstSequence != uint64(len(feed.Events)) {
		return false
	}
	for i, event := range feed.Events {
		if event.Sequence != feed.FirstSequence+uint64(i) || !fixedHex(event.SessionID, 32) {
			return false
		}
		switch event.Kind {
		case "started":
			if event.ChargeUnits != nil || event.BalanceUnits != nil {
				return false
			}
		case "settled":
			if !canonicalUnits(event.ChargeUnits) || !canonicalUnits(event.BalanceUnits) {
				return false
			}
		default:
			return false
		}
	}
	return true
}

func fixedHex(s string, size int) bool {
	if len(s) != size*2 {
		return false
	}
	_, err := hex.DecodeString(s)
	return err == nil
}

func canonicalUnits(raw *string) bool {
	if raw == nil || len(*raw) == 0 || len(*raw) > 39 {
		return false
	}
	value, ok := new(big.Int).SetString(*raw, 10)
	return ok && value.Sign() >= 0 && value.BitLen() <= 128 && value.String() == *raw
}
