package server

import (
	"log"
	"net/http"
	"sync/atomic"
	"time"

	"github.com/OpenAnonymity/oa-chat/oa-clientd/pkg/activity"
)

// LogRequests reports only inference API activity using fixed route/method
// labels, response status and timing. Internal status and management polling
// stays quiet during routine operation.
// Never add request data or arbitrary error values here: local funding URLs,
// transport errors and companion output can contain private capabilities.
func LogRequests(next http.Handler, logger *log.Logger) http.Handler {
	if logger == nil {
		return next
	}
	var sequence atomic.Uint64
	return logResponseCosts(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if activity.DiagnosticLevel(r.Context()) == activity.SemiVerbose {
			// Content and key/settlement diagnostics provide the compact view.
			// Keep a one-line status for failures, without raw error strings.
			response := &logResponseWriter{ResponseWriter: w}
			defer func() {
				if response.status >= 400 || response.failed || r.Context().Err() != nil {
					activity.Diagnostic(r.Context(), "request failed status=%d", response.status)
				}
				if response.Header().Get("X-OA-Verification-Status") == "verifier-unavailable" {
					logger.Print("Station not verified: trusted-station fallback used")
				}
			}()
			next.ServeHTTP(response, r)
			return
		}
		route := logRoute(r.URL.Path)
		if route == "" {
			next.ServeHTTP(w, r)
			return
		}
		method := logMethod(r.Method)
		request := sequence.Add(1)
		r = r.WithContext(activity.WithReporter(r.Context(), func(event activity.Event) {
			switch event.Kind {
			case activity.KeyFresh:
				logger.Printf("request key selected request=%d key_ref=%d source=fresh", request, event.Key)
			case activity.KeyReused:
				logger.Printf("request key selected request=%d key_ref=%d source=reused", request, event.Key)
			case activity.KeyReleased:
				state := "retired locally; wallet settlement may still be pending"
				if event.Reusable {
					state = "available for reuse within configured window"
				}
				logger.Printf("request key released request=%d key_ref=%d response_complete=%t; %s", request, event.Key, event.Complete, state)
			case activity.SettlementWaiting:
				logger.Printf("request waiting request=%d reason=previous_key_settlement", request)
			case activity.SettlementStarted:
				logger.Printf("request settling request=%d action=retire_previous_key", request)
			case activity.SettlementFinished:
				logger.Printf("request settlement result request=%d ready=%t duration=%s", request, event.Complete, event.Duration.Round(time.Millisecond))
			}
		}))
		started := time.Now()
		response := &logResponseWriter{ResponseWriter: w}
		returned := false
		logger.Printf("request started method=%s route=%s request=%d", method, route, request)
		defer func() {
			if response.Header().Get("X-OA-Verification-Status") == "verifier-unavailable" {
				logger.Print("Station not verified: inference used a trusted station key; provider ownership and privacy settings were not confirmed")
			}
			result := "finished"
			if !returned || response.failed || r.Context().Err() != nil {
				result = "aborted"
			} else if response.status == 0 {
				response.status = http.StatusOK
			}
			logger.Printf("request %s method=%s route=%s status=%d duration=%s request=%d", result, method, route, response.status, time.Since(started).Round(time.Millisecond), request)
		}()
		// A panic propagates normally; the deferred log never formats its value
		// and never mistakes a partially written response for successful work.
		next.ServeHTTP(response, r)
		returned = true
	}), logger)
}

func logMethod(method string) string {
	switch method {
	case http.MethodGet, http.MethodHead, http.MethodPost, http.MethodPut,
		http.MethodPatch, http.MethodDelete, http.MethodConnect,
		http.MethodOptions, http.MethodTrace:
		return method
	default:
		return "OTHER"
	}
}

func logRoute(path string) string {
	switch path {
	case "/v1/models", "/v1/chat/completions", DelegatePath, OADelegatePath:
		return path
	}
	return ""
}

type logResponseWriter struct {
	http.ResponseWriter
	status int
	failed bool
}

// ResponseController traverses Unwrap for read/write deadlines and other
// capabilities, preserving the API's immediate SSE delivery and slow-client bounds.
func (w *logResponseWriter) Unwrap() http.ResponseWriter { return w.ResponseWriter }

func (w *logResponseWriter) WriteHeader(status int) {
	w.ResponseWriter.WriteHeader(status)
	if w.status == 0 && (status >= 200 || status == http.StatusSwitchingProtocols) {
		w.status = status
	}
}

func (w *logResponseWriter) Write(body []byte) (int, error) {
	if w.status == 0 {
		w.status = http.StatusOK
	}
	n, err := w.ResponseWriter.Write(body)
	if err != nil {
		w.failed = true
	}
	return n, err
}

func (w *logResponseWriter) FlushError() error {
	err := http.NewResponseController(w.ResponseWriter).Flush()
	if err != nil {
		w.failed = true
	} else if w.status == 0 {
		w.status = http.StatusOK
	}
	return err
}
