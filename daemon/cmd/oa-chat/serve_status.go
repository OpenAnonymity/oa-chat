package main

import (
	"context"
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
			return "Ticket wallet unavailable or busy; run oa-chat config to check"
		}
		if count == 0 {
			return "Ticket wallet: 0 tickets; run oa-chat config to import or redeem tickets"
		}
		return fmt.Sprintf("Ticket wallet: %d tickets available", count)
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
