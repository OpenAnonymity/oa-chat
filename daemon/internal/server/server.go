// Package server exposes a small OpenAI-compatible inference API. Client
// credentials, headers, and account metadata never cross the backend boundary.
package server

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"
	"strings"
	"time"
)

type Backend interface {
	Models(context.Context) (json.RawMessage, error)
	Complete(context.Context, json.RawMessage) (*http.Response, error)
}

// BackendError carries an explicitly safe error across a backend boundary.
// Arbitrary transport, filesystem and remote error strings remain private.
type BackendError struct {
	Status  int
	Code    string
	Message string
}

func (e *BackendError) Error() string { return e.Message }

type API struct {
	backend Backend
	key     [32]byte
	slots   chan struct{}
	// Admin is optional local management. Withdrawal additionally requires the
	// private CLI credential; an inference API key cannot authorize payouts.
	Admin           http.Handler
	ManagementToken string
}

func New(backend Backend, key string, concurrency int) (*API, error) {
	if backend == nil || len(key) < 32 {
		return nil, errors.New("backend and API key of at least 32 characters required")
	}
	if concurrency < 1 || concurrency > 64 {
		return nil, errors.New("concurrency must be between 1 and 64")
	}
	return &API{backend: backend, key: sha256.Sum256([]byte(key)), slots: make(chan struct{}, concurrency)}, nil
}

func (a *API) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	// This is a server-to-server endpoint. Browser clients use their own UI
	// backend, preventing arbitrary web origins from spending local balance.
	if r.Header.Get("Origin") != "" || r.Header.Get("Sec-Fetch-Site") == "cross-site" {
		writeError(w, 403, "browser_origin_denied", "Connect through your UI's server-side OpenAI connection.")
		return
	}
	if r.URL.Path == "/healthz" && r.Method == http.MethodGet {
		writeJSON(w, 200, []byte(`{"status":"ok"}`))
		return
	}
	header := r.Header.Get("Authorization")
	key := sha256.Sum256([]byte(strings.TrimPrefix(header, "Bearer ")))
	if !strings.HasPrefix(header, "Bearer ") || subtle.ConstantTimeCompare(key[:], a.key[:]) != 1 {
		w.Header().Set("WWW-Authenticate", "Bearer")
		writeError(w, 401, "invalid_api_key", "A valid local OA Chat API key is required.")
		return
	}
	if strings.HasPrefix(r.URL.Path, "/admin/") && a.Admin != nil {
		if r.URL.Path == "/admin/withdrawal" {
			provided := sha256.Sum256([]byte(r.Header.Get("X-OA-Management-Token")))
			expected := sha256.Sum256([]byte(a.ManagementToken))
			if len(a.ManagementToken) < 32 || subtle.ConstantTimeCompare(expected[:], a.key[:]) == 1 ||
				len(r.Header.Values("X-OA-Management-Token")) != 1 || subtle.ConstantTimeCompare(provided[:], expected[:]) != 1 {
				writeError(w, 403, "management_auth_required", "Withdrawal management requires the private local CLI credential.")
				return
			}
		}
		a.Admin.ServeHTTP(w, r)
		return
	}
	switch {
	case r.URL.Path == "/v1/models" && r.Method == http.MethodGet:
		ctx, cancel := context.WithTimeout(r.Context(), time.Minute)
		defer cancel()
		data, err := a.backend.Models(ctx)
		if err != nil {
			writeError(w, 502, "models_unavailable", "Unable to load the anonymous model catalog.")
			return
		}
		writeJSON(w, 200, data)
	case r.URL.Path == "/v1/chat/completions" && r.Method == http.MethodPost:
		a.complete(w, r)
	case r.URL.Path == "/v1/chat/completions" || r.URL.Path == "/v1/models":
		writeError(w, 405, "method_not_allowed", "Method not allowed.")
	default:
		writeError(w, 404, "not_found", "Use /v1/models or /v1/chat/completions.")
	}
}

// Only inference inputs cross the boundary. In particular user, metadata,
// safety_identifier, prompt_cache_key, store, and extra transport headers do not.
var fields = map[string]bool{
	"model": true, "messages": true, "stream": true, "stream_options": true,
	"temperature": true, "top_p": true, "top_k": true, "n": true,
	"presence_penalty": true, "frequency_penalty": true, "repetition_penalty": true,
	"logit_bias": true, "logprobs": true, "top_logprobs": true,
	"max_tokens": true, "max_completion_tokens": true, "stop": true, "seed": true,
	"tools": true, "tool_choice": true, "parallel_tool_calls": true,
	"functions": true, "function_call": true, "response_format": true,
	"reasoning": true, "reasoning_effort": true, "include_reasoning": true,
	"modalities": true, "audio": true, "prediction": true,
}

func sanitize(body []byte) (json.RawMessage, bool, error) {
	var values map[string]json.RawMessage
	if err := json.Unmarshal(body, &values); err != nil || values == nil {
		return nil, false, errors.New("body must be a JSON object")
	}
	var model string
	if json.Unmarshal(values["model"], &model) != nil || strings.TrimSpace(model) == "" || len(model) > 256 {
		return nil, false, errors.New("model is required")
	}
	var messages []json.RawMessage
	if json.Unmarshal(values["messages"], &messages) != nil || len(messages) == 0 {
		return nil, false, errors.New("messages must be a nonempty array")
	}
	for _, raw := range messages {
		var message map[string]json.RawMessage
		if json.Unmarshal(raw, &message) != nil || message == nil {
			return nil, false, errors.New("invalid message")
		}
		var role string
		if json.Unmarshal(message["role"], &role) != nil || role == "" {
			return nil, false, errors.New("each message needs a role")
		}
	}
	stream := false
	if v, ok := values["stream"]; ok && string(v) != "true" && string(v) != "false" {
		return nil, false, errors.New("stream must be a boolean")
	}
	if v := values["stream"]; v != nil {
		_ = json.Unmarshal(v, &stream)
	}
	for key := range values {
		if !fields[key] {
			delete(values, key)
		}
	}
	clean, err := json.Marshal(values)
	return clean, stream, err
}

func (a *API) complete(w http.ResponseWriter, r *http.Request) {
	media, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || media != "application/json" {
		writeError(w, 415, "unsupported_media_type", "Use Content-Type: application/json.")
		return
	}
	select {
	case a.slots <- struct{}{}:
		defer func() { <-a.slots }()
	default:
		writeError(w, 429, "busy", "Too many concurrent requests. Retry after a running request finishes.")
		return
	}
	// Bound slow uploads separately from long-running inference/streaming.
	control := http.NewResponseController(w)
	_ = control.SetReadDeadline(time.Now().Add(30 * time.Second))
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 16<<20))
	_ = control.SetReadDeadline(time.Time{})
	if err != nil {
		writeError(w, 413, "invalid_body", "Request body is too large or unreadable (16 MiB maximum).")
		return
	}
	clean, streaming, err := sanitize(body)
	if err != nil {
		writeError(w, 400, "invalid_request_error", err.Error())
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Minute)
	defer cancel()
	response, err := a.backend.Complete(ctx, clean)
	if err != nil {
		// Transport/issuer errors may include secrets, submitted JSON or URLs.
		// Do not expose them to either HTTP clients or service logs.
		var safe *BackendError
		if errors.As(err, &safe) && safe.Status >= 400 && safe.Status <= 599 {
			writeError(w, safe.Status, safe.Code, safe.Message)
			return
		}
		writeError(w, 502, "anonymous_access_failed", "Anonymous access could not be prepared. Check ticket balance or funding with oa-chat status; relay and verifier availability are also required.")
		return
	}
	if response == nil || response.Body == nil {
		writeError(w, 502, "invalid_upstream_response", "The inference provider returned an invalid response.")
		return
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		status := response.StatusCode
		if status < 400 || status > 599 {
			status = 502
		}
		if retry := response.Header.Get("Retry-After"); retry != "" {
			w.Header().Set("Retry-After", retry)
		}
		writeError(w, status, "upstream_error", "The inference provider rejected the request.")
		return
	}
	contentType, _, _ := mime.ParseMediaType(response.Header.Get("Content-Type"))
	if streaming && contentType != "text/event-stream" {
		writeError(w, 502, "stream_unavailable", "The inference provider did not return an event stream.")
		return
	}
	if !streaming && contentType != "application/json" {
		writeError(w, 502, "invalid_upstream_response", "The inference provider did not return JSON.")
		return
	}
	w.Header().Set("Content-Type", response.Header.Get("Content-Type"))
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(response.StatusCode)
	if streaming {
		if err := control.Flush(); err != nil {
			return
		}
	}
	buffer := make([]byte, 16*1024)
	for {
		n, readErr := response.Body.Read(buffer)
		if n > 0 {
			_ = control.SetWriteDeadline(time.Now().Add(30 * time.Second))
			if _, err := w.Write(buffer[:n]); err != nil {
				return
			}
			// Forward partial SSE frames too: no Scanner, event aggregation,
			// token batching, compressor, or wait for [DONE].
			if streaming {
				if err := control.Flush(); err != nil {
					return
				}
			}
		}
		if readErr != nil {
			if readErr != io.EOF {
				panic(http.ErrAbortHandler)
			}
			return
		}
	}
}

func writeJSON(w http.ResponseWriter, status int, body []byte) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_, _ = w.Write(body)
}

func writeError(w http.ResponseWriter, status int, code, message string) {
	data, _ := json.Marshal(map[string]any{"error": map[string]any{"message": message, "type": code, "code": code, "param": nil}})
	writeJSON(w, status, data)
}
