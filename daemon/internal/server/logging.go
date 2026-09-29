package server

import (
	"log"
	"net/http"
	"strings"
	"time"
)

// LogRequests reports only fixed route/method labels, response status and timing.
// Never add request data or arbitrary error values here: local funding URLs,
// transport errors and companion output can contain private capabilities.
func LogRequests(next http.Handler, logger *log.Logger) http.Handler {
	if logger == nil {
		return next
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Health polling is frequent and carries no useful inference activity.
		if r.Method == http.MethodGet && r.URL.Path == "/healthz" {
			next.ServeHTTP(w, r)
			return
		}
		method, route := logMethod(r.Method), logRoute(r.URL.Path)
		started := time.Now()
		response := &logResponseWriter{ResponseWriter: w}
		returned := false
		logger.Printf("request started method=%s route=%s", method, route)
		defer func() {
			if response.Header().Get("X-OA-Verification-Status") == "verifier-unavailable" {
				logger.Print("Verification unavailable: inference used an outage-eligible key; this key is not verified")
			}
			result := "finished"
			if !returned || response.failed || r.Context().Err() != nil {
				result = "aborted"
			} else if response.status == 0 {
				response.status = http.StatusOK
			}
			logger.Printf("request %s method=%s route=%s status=%d duration=%s", result, method, route, response.status, time.Since(started).Round(time.Millisecond))
		}()
		// A panic propagates normally; the deferred log never formats its value
		// and never mistakes a partially written response for successful work.
		next.ServeHTTP(response, r)
		returned = true
	})
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
	case "/healthz", "/v1/models", "/v1/chat/completions", "/admin/fund",
		"/admin/withdrawal", "/admin/funding/address", "/admin/funding/deposit":
		return path
	}
	if path == "/funding" || strings.HasPrefix(path, "/funding/") {
		return "/funding/*"
	}
	return "OTHER"
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
