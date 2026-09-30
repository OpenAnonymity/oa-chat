package main

import (
	"context"
	"io"
	"sync"
	"sync/atomic"
)

// Pass provider bytes through unchanged. A failed or abandoned response retires
// its reusable credential; successful EOF preserves it until its fixed deadline.
type ticketResponseBody struct {
	io.ReadCloser
	ctx         context.Context
	invalidate  func()
	invalidOnce sync.Once
	closeOnce   sync.Once
	complete    atomic.Bool
	stopMu      sync.Mutex
	stop        func() bool
	closed      bool
}

func watchTicketResponse(ctx context.Context, body io.ReadCloser, invalidate func()) io.ReadCloser {
	wrapped := &ticketResponseBody{ReadCloser: body, ctx: ctx, invalidate: invalidate}
	stop := context.AfterFunc(ctx, func() {
		wrapped.invalidOnce.Do(wrapped.invalidate)
		_ = wrapped.Close()
	})
	wrapped.stopMu.Lock()
	if wrapped.closed {
		stop()
	} else {
		wrapped.stop = stop
	}
	wrapped.stopMu.Unlock()
	return wrapped
}

func (b *ticketResponseBody) Read(p []byte) (int, error) {
	n, err := b.ReadCloser.Read(p)
	if err != nil {
		if err == io.EOF {
			b.complete.Store(true)
		}
		_ = b.Close()
	}
	return n, err
}

func (b *ticketResponseBody) Close() error {
	var err error
	b.closeOnce.Do(func() {
		b.stopMu.Lock()
		b.closed = true
		if b.stop != nil {
			b.stop()
		}
		b.stopMu.Unlock()
		if !b.complete.Load() || b.ctx.Err() != nil {
			b.invalidOnce.Do(b.invalidate)
		}
		err = b.ReadCloser.Close()
		if err != nil {
			b.invalidOnce.Do(b.invalidate)
		}
	})
	return err
}
