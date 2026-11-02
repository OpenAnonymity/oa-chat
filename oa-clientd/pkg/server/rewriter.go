package server

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/OpenAnonymity/oa-chat/oa-clientd/pkg/rewriter"
)

// completionNotice is request-local and called synchronously by the backend.
// Preview is flushed BEFORE lease acquisition/inference. Once sent, subsequent
// errors use SSE error frames (HTTP status can no longer be changed).
type completionNotice struct {
	model     string
	streaming bool
	mode      string
	started   bool
	notice    *rewriter.Notice
	name      string // product label; empty is zkapi
}

func (n *completionNotice) label() string {
	if n.name != "" {
		return n.name
	}
	return "zkapi"
}

func (n *completionNotice) context(ctx context.Context, w http.ResponseWriter) context.Context {
	return rewriter.WithNotice(ctx, func(notice rewriter.Notice) error {
		if n.mode == "off" {
			return nil
		}
		n.notice = &notice
		if !n.streaming {
			return nil
		}
		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("X-Accel-Buffering", "no")
		w.WriteHeader(http.StatusOK)
		n.started = true
		delta := map[string]any{"role": "assistant"}
		if n.mode != "metadata" {
			delta["reasoning_content"] = previewText(n.label(), notice)
		}
		raw, _ := json.Marshal(map[string]any{"id": "chatcmpl-" + n.label() + "-rewrite", "model": n.model, "object": "chat.completion.chunk", "created": time.Now().Unix(), "choices": []any{map[string]any{"index": 0, "delta": delta, "finish_reason": nil}}, n.label() + "_rewrite": notice})
		control := http.NewResponseController(w)
		_ = control.SetWriteDeadline(time.Now().Add(30 * time.Second))
		if _, err := fmt.Fprintf(w, "data: %s\n\n", raw); err != nil {
			return err
		}
		err := control.Flush()
		// Do not let the preview's write timeout expire while awaiting a
		// lease/settlement. Subsequent writes install their own bound.
		_ = control.SetWriteDeadline(time.Time{})
		return err
	})
}
func previewText(label string, n rewriter.Notice) string {
	// Quoted strings make control characters and delimiters unambiguous.
	var b strings.Builder
	b.WriteString("[" + label + " prompt rewrite — NOT target-model thinking]\n")
	for _, text := range n.Texts {
		fmt.Fprintf(&b, "%q\n", text)
	}
	b.WriteString("[end prompt rewrite]\n\n")
	return b.String()
}
func (n *completionNotice) writeError(w http.ResponseWriter, status int, code, message string) {
	if !n.started {
		writeError(w, status, code, message)
		return
	}
	_ = http.NewResponseController(w).SetWriteDeadline(time.Now().Add(30 * time.Second))
	raw, _ := json.Marshal(map[string]any{"error": map[string]any{"code": code, "type": code, "message": message}})
	_, _ = fmt.Fprintf(w, "data: %s\n\ndata: [DONE]\n\n", raw)
	_ = http.NewResponseController(w).Flush()
}
func (n *completionNotice) annotateJSON(body io.Reader) ([]byte, error) {
	raw, err := io.ReadAll(io.LimitReader(body, (16<<20)+1))
	if err != nil || len(raw) > 16<<20 {
		return nil, fmt.Errorf("invalid response")
	}
	var result map[string]json.RawMessage
	if json.Unmarshal(raw, &result) != nil || result == nil {
		return nil, fmt.Errorf("invalid response")
	}
	result[n.label()+"_rewrite"], _ = json.Marshal(n.notice)
	// Keep machine-readable answers intact. Non-streaming clients can read the
	// explicit metadata; no notice is injected into assistant content.
	return json.Marshal(result)
}
