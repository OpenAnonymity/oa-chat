package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"time"
)

type ticketCounter interface {
	CountContext(context.Context) (int, error)
}

func ticketReadiness(wallet ticketCounter) func(context.Context) string {
	return func(ctx context.Context) string {
		count, err := wallet.CountContext(ctx)
		if err != nil {
			return "Ticket wallet unavailable or busy; run oa-chat status to check"
		}
		if count == 0 {
			return "Ticket wallet: 0 tickets; import or redeem tickets before inference"
		}
		return fmt.Sprintf("Ticket wallet: %d tickets available", count)
	}
}

type walletStatusReader interface {
	WalletStatus(context.Context) (json.RawMessage, error)
}

func zkReadiness(wallet walletStatusReader) func(context.Context) string {
	return func(ctx context.Context) string {
		// WalletStatus also checks the companion's network and key-source policy.
		data, err := wallet.WalletStatus(ctx)
		if err != nil {
			return "zkAPI companion unavailable or not ready; retrying status"
		}
		// Only typed, allowlisted readiness flags may reach stdout. Never log the
		// raw wallet JSON, balances, note IDs, proof details, or remote errors.
		var state struct {
			HasNote        *bool `json:"has_note"`
			PendingRequest bool  `json:"pending_request"`
		}
		if json.Unmarshal(data, &state) != nil || state.HasNote == nil {
			return "zkAPI wallet status unavailable; retrying status"
		}
		if state.PendingRequest {
			return "zkAPI companion ready; private wallet awaiting settlement"
		}
		if !*state.HasNote {
			return "zkAPI companion ready; no private balance loaded; run oa-chat fund"
		}
		return "zkAPI companion ready; private balance loaded"
	}
}

// Status checks are read-only, bounded, and independent of request handling.
// Report the initial snapshot and subsequent changes without idle log spam.
func monitorReadiness(ctx context.Context, logger *log.Logger, read func(context.Context) string, interval time.Duration) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	last := ""
	for {
		if ctx.Err() != nil {
			return
		}
		checkCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
		current := read(checkCtx)
		cancel()
		if ctx.Err() != nil {
			return
		}
		if current != last {
			logger.Printf("Status: %s", current)
			last = current
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}
