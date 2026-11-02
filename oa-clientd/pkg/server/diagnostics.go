package server

import (
	"bytes"
	"context"
	"encoding/json"

	"github.com/OpenAnonymity/oa-chat/oa-clientd/pkg/activity"
)

// Diagnostics observes copies of forwarded bytes; it never consumes ahead of
// streaming delivery. Oversize JSON/SSE records are dropped, not buffered
// without bound. The final preview explicitly marks any missing content.
type responseDiagnostic struct {
	ctx      context.Context
	stream   bool
	pending  []byte
	summary  activity.Summary
	skipped  bool
	dropping bool
}

const diagnosticRecordLimit = 1 << 20

func promptDiagnostic(ctx context.Context, body []byte) {
	if activity.DiagnosticLevel(ctx) == activity.Normal {
		return
	}
	var request struct {
		Messages []map[string]json.RawMessage `json:"messages"`
	}
	if json.Unmarshal(body, &request) != nil {
		return
	}
	var summary activity.Summary
	for i, message := range request.Messages {
		if i > 0 {
			summary.Add("\n")
		}
		for _, field := range []string{"content", "tool_calls", "function_call"} {
			raw := message[field]
			if len(raw) == 0 || bytes.Equal(raw, []byte("null")) {
				continue
			}
			var text string
			if json.Unmarshal(raw, &text) != nil {
				text = string(raw)
			}
			summary.Add(text)
			if activity.DiagnosticLevel(ctx) == activity.Verbose {
				activity.Message(ctx, "prompt "+field, text)
			}
		}
	}
	activity.Diagnostic(ctx, "prompt received %s", summary.String())
}
func newResponseDiagnostic(ctx context.Context, stream bool) *responseDiagnostic {
	if activity.DiagnosticLevel(ctx) == activity.Normal {
		return nil
	}
	return &responseDiagnostic{ctx: ctx, stream: stream}
}
func (d *responseDiagnostic) add(data []byte) {
	if d == nil {
		return
	}
	if !d.stream {
		if len(d.pending)+len(data) > diagnosticRecordLimit {
			d.skipped = true
			d.pending = nil
		}
		if !d.skipped {
			d.pending = append(d.pending, data...)
		}
		return
	}
	for len(data) > 0 {
		end := bytes.IndexByte(data, '\n')
		part := data
		if end >= 0 {
			part = data[:end]
		}
		if !d.dropping {
			if len(d.pending)+len(part) > diagnosticRecordLimit {
				d.pending = nil
				d.skipped = true
				d.dropping = true
			} else {
				d.pending = append(d.pending, part...)
			}
		}
		if end < 0 {
			return
		}
		if !d.dropping {
			d.line(d.pending)
		}
		d.pending = nil
		d.dropping = false
		data = data[end+1:]
	}
}
func (d *responseDiagnostic) line(line []byte) {
	line = bytes.TrimSuffix(line, []byte{'\r'})
	if !bytes.HasPrefix(line, []byte("data:")) {
		return
	}
	payload := bytes.TrimSpace(line[5:])
	if bytes.Equal(payload, []byte("[DONE]")) {
		return
	}
	d.decode(payload)
}
func (d *responseDiagnostic) decode(data []byte) {
	var response struct {
		Choices []struct {
			Delta   json.RawMessage `json:"delta"`
			Message json.RawMessage `json:"message"`
			Text    string          `json:"text"`
		} `json:"choices"`
	}
	if json.Unmarshal(data, &response) != nil {
		d.skipped = true
		return
	}
	for _, choice := range response.Choices {
		text := choice.Text
		raw := choice.Message
		if d.stream {
			raw = choice.Delta
		}
		if len(raw) > 0 {
			var message map[string]json.RawMessage
			if json.Unmarshal(raw, &message) != nil {
				d.skipped = true
				continue
			}
			// Include reasoning and tool calls as well as ordinary content.
			for _, field := range []string{"reasoning", "reasoning_content", "content", "tool_calls", "function_call", "audio"} {
				value := message[field]
				if len(value) == 0 || bytes.Equal(value, []byte("null")) {
					continue
				}
				var s string
				if json.Unmarshal(value, &s) == nil {
					text += s
				} else {
					text += string(value)
				}
			}
		}
		d.summary.Add(text)
		if activity.DiagnosticLevel(d.ctx) == activity.Verbose {
			activity.Message(d.ctx, "response content", text)
		}
	}
}
func (d *responseDiagnostic) finish(complete bool) {
	if d == nil {
		return
	}
	if d.stream {
		if len(d.pending) > 0 && !d.dropping {
			d.line(d.pending)
		}
	} else if !d.skipped {
		d.decode(d.pending)
	}
	activity.Diagnostic(d.ctx, "response finished complete=%t preview_incomplete=%t %s", complete, d.skipped, d.summary.String())
}
