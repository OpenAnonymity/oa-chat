package server

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/OpenAnonymity/oa-chat/oa-clientd/pkg/rewriter"
)

// DelegatePath is the local strict-delegation route. It accepts a narrow
// task description, never an OpenAI request: callers cannot choose messages,
// tools, plugins, streaming, headers, metadata or provider routing.
const DelegatePath = "/v1/zkapi/delegate"

// OADelegatePath is oa-clientd's strict-delegation route. A separate path keeps
// a client configured for one daemon from silently spending the other's balance.
const OADelegatePath = "/v1/oa/delegate"

// Delegation bounds. Text limits are UTF-8 bytes.
const (
	MaxDelegationTaskBytes    = 32 << 10
	MaxDelegationContextBytes = 192 << 10
	MaxDelegationOutputTokens = 32768
	DefaultDelegationTokens   = 4096
	maxDelegationBody         = 512 << 10
	maxDelegationResponse     = 8 << 20
	maxDelegationAnswer       = 1 << 20
	delegationTimeout         = 10 * time.Minute
)

// Delegator is an optional backend capability. A backend provides it only
// when every call is independent: a fresh provider credential and network
// identity, no shared rewriter transcript, and no key left for later reuse.
// Without it the route refuses, so an older protocol engine fails closed.
type Delegator interface {
	Delegate(context.Context, json.RawMessage) (*http.Response, error)
}

// DelegationRequest is the complete route input; unknown fields are rejected.
type DelegationRequest struct {
	Task            string `json:"task"`
	Context         string `json:"context,omitempty"`
	Model           string `json:"model,omitempty"`
	MaxOutputTokens int    `json:"max_output_tokens,omitempty"`
	ReasoningEffort string `json:"reasoning_effort,omitempty"`
}

type DelegationUsage struct {
	PromptTokens     int64 `json:"prompt_tokens"`
	CompletionTokens int64 `json:"completion_tokens"`
	TotalTokens      int64 `json:"total_tokens"`
}

// DelegationResult carries the answer text and coarse metadata only: no
// provider generation ID, routed provider name, reasoning text or credential.
type DelegationResult struct {
	Model        string           `json:"model"`
	Answer       string           `json:"answer"`
	FinishReason string           `json:"finish_reason"`
	Truncated    bool             `json:"truncated"`
	Usage        *DelegationUsage `json:"usage,omitempty"`
	Verification string           `json:"credential_verification,omitempty"`
}

func validDelegationText(text string, limit int) bool {
	return len(text) <= limit && utf8.ValidString(text) && !strings.ContainsRune(text, 0)
}

// delegationBody builds the only provider request a delegation can send: one
// user message, non-streaming, no plugins (so web search stays off whatever the
// daemon's chat default), no tools, and the optional reasoning effort.
func (a *API) delegationBody(request DelegationRequest) (json.RawMessage, string, *BackendError) {
	invalid := func(code, message string) *BackendError {
		return &BackendError{Status: http.StatusBadRequest, Code: code, Message: message}
	}
	if strings.TrimSpace(request.Task) == "" || !validDelegationText(request.Task, MaxDelegationTaskBytes) {
		return nil, "", invalid("invalid_task", "task must be nonblank UTF-8 text of at most 32 KiB.")
	}
	if !validDelegationText(request.Context, MaxDelegationContextBytes) {
		return nil, "", invalid("invalid_context", "context must be UTF-8 text of at most 192 KiB.")
	}
	model := request.Model
	if model == "" {
		model = a.DefaultModel
	}
	if model == "" {
		return nil, "", invalid("model_required", "No model was given and the daemon has no default model. Pass a model ID from the model list.")
	}
	if len(model) > 256 || strings.IndexFunc(model, func(r rune) bool { return r <= 32 || r >= 127 }) >= 0 {
		return nil, "", invalid("invalid_model", "Select a model ID from the model list.")
	}
	if strings.HasSuffix(strings.ToLower(model), ":online") {
		return nil, "", invalid("web_search_unavailable", "Web-search model variants (:online) are not available for delegation; use the base model ID.")
	}
	tokens := request.MaxOutputTokens
	if tokens == 0 {
		tokens = DefaultDelegationTokens
	}
	if tokens < 1 || tokens > MaxDelegationOutputTokens {
		return nil, "", invalid("invalid_max_output_tokens", "max_output_tokens must be between 1 and 32768.")
	}
	content := request.Task
	if request.Context != "" {
		content += "\n\nContext:\n" + request.Context
	}
	body := map[string]any{
		"model":      model,
		"messages":   []any{map[string]string{"role": "user", "content": content}},
		"max_tokens": tokens,
		"stream":     false,
	}
	switch request.ReasoningEffort {
	case "":
	case "low", "medium", "high":
		body["reasoning"] = map[string]string{"effort": request.ReasoningEffort}
	default:
		return nil, "", invalid("invalid_reasoning_effort", "reasoning_effort must be low, medium or high.")
	}
	data, err := json.Marshal(body)
	if err != nil {
		return nil, "", invalid("invalid_request_error", "Invalid delegation request.")
	}
	return data, model, nil
}

func (a *API) delegate(w http.ResponseWriter, r *http.Request) {
	delegator, ok := a.backend.(Delegator)
	if !ok {
		writeError(w, http.StatusNotImplemented, "delegation_unsupported", "This daemon's protocol engine does not support strict delegation. Use the concession engine with Tor routing.")
		return
	}
	media, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || media != "application/json" {
		writeError(w, 415, "unsupported_media_type", "Use Content-Type: application/json.")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), delegationTimeout)
	defer cancel()
	select {
	case a.pending <- struct{}{}:
		defer func() { <-a.pending }()
	default:
		writeError(w, 429, "busy", "The local request queue is full. Retry after a running request finishes.")
		return
	}
	control := http.NewResponseController(w)
	_ = control.SetReadDeadline(time.Now().Add(30 * time.Second))
	raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxDelegationBody))
	_ = control.SetReadDeadline(time.Time{})
	if err != nil {
		writeError(w, 413, "invalid_body", "Delegation request is too large or unreadable (512 KiB maximum).")
		return
	}
	var request DelegationRequest
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&request) != nil || decoder.Decode(new(any)) != io.EOF {
		writeError(w, 400, "invalid_request_error", "Body must be one JSON object with task and optional context, model, max_output_tokens and reasoning_effort.")
		return
	}
	body, model, invalid := a.delegationBody(request)
	if invalid != nil {
		writeError(w, invalid.Status, invalid.Code, invalid.Message)
		return
	}
	select {
	case a.slots <- struct{}{}:
		defer func() { <-a.slots }()
	case <-ctx.Done():
		writeError(w, 408, "request_cancelled", "The request was canceled while waiting for inference.")
		return
	}
	if ctx.Err() != nil {
		writeError(w, 408, "request_cancelled", "The request was canceled while waiting for inference.")
		return
	}
	response, err := delegator.Delegate(ctx, body)
	if err != nil {
		var safe *BackendError
		switch {
		case errors.Is(err, rewriter.ErrFailed):
			writeError(w, 502, "rewrite_failed", rewriter.ErrFailed.Error())
		case ctx.Err() != nil || errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded):
			writeError(w, 408, "request_cancelled", "The request was canceled or timed out. It was not retried; a canceled request may still have been charged.")
		case errors.As(err, &safe) && safe.Status >= 400 && safe.Status <= 599:
			writeError(w, safe.Status, safe.Code, safe.Message)
		default:
			writeError(w, 502, "anonymous_access_failed", a.accessFailedMessage())
		}
		return
	}
	if response == nil || response.Body == nil {
		writeError(w, 502, "invalid_upstream_response", "The inference provider returned an invalid response.")
		return
	}
	defer response.Body.Close()
	// Drain to EOF within the bound: only a complete body counts as complete
	// provider usage, and the answer is never streamed partially.
	data, readErr := io.ReadAll(io.LimitReader(response.Body, maxDelegationResponse+1))
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		status := response.StatusCode
		if status < 400 || status > 599 {
			status = 502
		}
		writeError(w, status, "upstream_error", "The inference provider rejected the request. It was not retried.")
		return
	}
	if readErr != nil || len(data) > maxDelegationResponse {
		if ctx.Err() != nil {
			writeError(w, 408, "request_cancelled", "The request was canceled or timed out. It was not retried; a canceled request may still have been charged.")
			return
		}
		writeError(w, 502, "invalid_upstream_response", "The provider response was incomplete or too large. It was not retried.")
		return
	}
	if media, _, _ := mime.ParseMediaType(response.Header.Get("Content-Type")); media != "application/json" {
		writeError(w, 502, "invalid_upstream_response", "The inference provider did not return JSON.")
		return
	}
	result, ok := delegationResult(data)
	if !ok {
		writeError(w, 502, "invalid_upstream_response", "The inference provider returned no usable answer. It was not retried.")
		return
	}
	result.Model = model
	switch status := response.Header.Get("X-OA-Verification-Status"); status {
	case "verified", "verifier-unavailable":
		result.Verification = status
		w.Header().Set("X-OA-Verification-Status", status)
	}
	encoded, err := json.Marshal(result)
	if err != nil {
		writeError(w, 502, "invalid_upstream_response", "The inference provider returned no usable answer.")
		return
	}
	writeJSON(w, http.StatusOK, encoded)
}

// delegationResult extracts the first choice's text. Reasoning fields and
// provider identifiers are ignored; an error object or missing choice fails.
func delegationResult(data []byte) (DelegationResult, bool) {
	var parsed struct {
		Error   json.RawMessage `json:"error"`
		Choices []struct {
			FinishReason *string `json:"finish_reason"`
			Message      struct {
				Content json.RawMessage `json:"content"`
				Refusal *string         `json:"refusal"`
			} `json:"message"`
		} `json:"choices"`
		Usage *struct {
			PromptTokens     *int64 `json:"prompt_tokens"`
			CompletionTokens *int64 `json:"completion_tokens"`
			TotalTokens      *int64 `json:"total_tokens"`
		} `json:"usage"`
	}
	if json.Unmarshal(data, &parsed) != nil || (len(parsed.Error) > 0 && string(parsed.Error) != "null") || len(parsed.Choices) == 0 {
		return DelegationResult{}, false
	}
	choice := parsed.Choices[0]
	answer, ok := messageText(choice.Message.Content)
	if !ok {
		return DelegationResult{}, false
	}
	if answer == "" && choice.Message.Refusal != nil {
		answer = *choice.Message.Refusal
	}
	result := DelegationResult{FinishReason: "unknown"}
	if choice.FinishReason != nil && validFinishReason(*choice.FinishReason) {
		result.FinishReason = *choice.FinishReason
	}
	result.Truncated = result.FinishReason == "length"
	answer = strings.ToValidUTF8(answer, "�")
	if len(answer) > maxDelegationAnswer {
		cut := maxDelegationAnswer
		for cut > 0 && !utf8.RuneStart(answer[cut]) {
			cut--
		}
		answer, result.Truncated = answer[:cut], true
	}
	result.Answer = answer
	if u := parsed.Usage; u != nil && u.PromptTokens != nil && u.CompletionTokens != nil {
		result.Usage = &DelegationUsage{PromptTokens: max(*u.PromptTokens, 0), CompletionTokens: max(*u.CompletionTokens, 0)}
		result.Usage.TotalTokens = result.Usage.PromptTokens + result.Usage.CompletionTokens
		if u.TotalTokens != nil && *u.TotalTokens >= 0 {
			result.Usage.TotalTokens = *u.TotalTokens
		}
	}
	return result, answer != "" || result.Truncated
}

func messageText(raw json.RawMessage) (string, bool) {
	if len(raw) == 0 || string(raw) == "null" {
		return "", true
	}
	var text string
	if json.Unmarshal(raw, &text) == nil {
		return text, true
	}
	var parts []struct {
		Type string `json:"type"`
		Text string `json:"text"`
	}
	if json.Unmarshal(raw, &parts) != nil {
		return "", false
	}
	var b strings.Builder
	for _, part := range parts {
		if part.Type == "text" {
			b.WriteString(part.Text)
		}
	}
	return b.String(), true
}

func validFinishReason(reason string) bool {
	if reason == "" || len(reason) > 32 {
		return false
	}
	for _, r := range reason {
		if (r < 'a' || r > 'z') && r != '_' {
			return false
		}
	}
	return true
}
