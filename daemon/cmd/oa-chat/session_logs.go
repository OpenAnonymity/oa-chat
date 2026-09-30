package main

import (
	"context"
	"log"
	"time"

	"github.com/OpenAnonymity/oa-chat/daemon/internal/zkapi"
)

type sessionEventReader interface {
	SessionEvents(context.Context) (zkapi.SessionEvents, error)
}

// These cursors and local display numbers are intentionally not persisted.
// A companion restart loses its event history; never reconstruct billing from
// a cap, current balance, or a previously printed cost.
type sessionLogCursor struct {
	instance string
	next     uint64
	serial   uint64
	active   map[string]uint64
}

func (s *sessionLogCursor) report(logger *log.Logger, feed zkapi.SessionEvents) {
	if s.instance != feed.InstanceID {
		s.instance, s.next = feed.InstanceID, 1
		s.active = make(map[string]uint64)
	}
	if feed.FirstSequence > s.next {
		logger.Print("Some session history is no longer available; showing retained sessions.")
		s.active = make(map[string]uint64)
		s.next = feed.FirstSequence
	}
	for _, event := range feed.Events {
		if event.Sequence < s.next {
			continue
		}
		s.next = event.Sequence + 1
		switch event.Kind {
		case "started":
			if _, exists := s.active[event.SessionID]; exists {
				continue
			}
			s.serial++
			s.active[event.SessionID] = s.serial
			logger.Printf("zkAPI OpenRouter key session %d started", s.serial)
		case "settled":
			cost, balance := fundingUnits(*event.ChargeUnits, 9), fundingUnits(*event.BalanceUnits, 9)
			if serial, exists := s.active[event.SessionID]; exists {
				logger.Printf("zkAPI OpenRouter key session %d ended (settled); cost: %s ETH; balance remaining: %s ETH", serial, cost, balance)
			} else {
				logger.Printf("Previous zkAPI OpenRouter key session ended (settled); cost: %s ETH; balance remaining: %s ETH", cost, balance)
			}
			delete(s.active, event.SessionID)
		}
	}
}

func monitorSessions(ctx context.Context, logger *log.Logger, reader sessionEventReader, interval time.Duration) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	var cursor sessionLogCursor
	failures := 0
	for {
		if ctx.Err() != nil {
			return
		}
		check, cancel := context.WithTimeout(ctx, 3*time.Second)
		feed, err := reader.SessionEvents(check)
		cancel()
		if ctx.Err() != nil {
			return
		}
		if err == nil {
			cursor.report(logger, feed)
			failures = 0
		} else {
			failures++
			// Startup and transient retries are quiet. A sustained failure must
			// not silently masquerade as working cost reporting. Never print
			// raw endpoint errors, which may contain private wallet details.
			if failures == 12 {
				logger.Print("Session cost reporting is unavailable. Run oa-chat config to check the installation; both binaries must be up to date.")
			}
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}
