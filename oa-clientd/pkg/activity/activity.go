// Package activity carries safe, process-local key lifecycle events to the
// inference request logger. It never carries credentials or wallet identifiers.
package activity

import (
	"context"
	"time"
)

type Kind uint8

const (
	KeyFresh Kind = iota
	KeyReused
	KeyReleased
	SettlementWaiting
	SettlementStarted
	SettlementFinished
)

type Event struct {
	Kind     Kind
	Key      uint64
	Complete bool
	Reusable bool
	Duration time.Duration
}

type reporterKey struct{}

func WithReporter(ctx context.Context, report func(Event)) context.Context {
	return context.WithValue(ctx, reporterKey{}, report)
}

func Report(ctx context.Context, event Event) {
	if report, ok := ctx.Value(reporterKey{}).(func(Event)); ok && report != nil {
		report(event)
	}
}
