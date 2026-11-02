package rewriter

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
)

// Transcript holds only the immediately preceding original-history digests and
// rewritten user messages. Access must be serialized through the response body.
// No raw source text is retained, persisted, or shared between conversations.
// A non-prefix history starts fresh; unknown user turns are NEVER passed through.
type Transcript struct {
	entries []transcriptEntry
}
type transcriptEntry struct {
	digest [32]byte
	user   json.RawMessage
	notice *Notice
}

const maxTranscriptBytes = 8 << 20
const maxTranscriptMessages = 4096

func canonicalDigest(raw json.RawMessage) ([32]byte, error) {
	d := json.NewDecoder(bytes.NewReader(raw))
	d.UseNumber()
	var value map[string]any
	if d.Decode(&value) != nil || value == nil {
		return [32]byte{}, ErrFailed
	}
	b, err := json.Marshal(value)
	if err != nil {
		return [32]byte{}, ErrFailed
	}
	return sha256.Sum256(b), nil
}

// Rewrite replays already-normalized user turns verbatim. On a cache miss it
// normalizes each unknown user turn independently, without exposing previous
// turns to the rewriter. Normal continuations thus read only new user text.
// State is committed atomically after ALL turns succeed, never partially.
func (t *Transcript) Rewrite(ctx context.Context, body json.RawMessage, c Config) (json.RawMessage, *Notice, error) {
	var request map[string]json.RawMessage
	var messages []json.RawMessage
	if json.Unmarshal(body, &request) != nil || json.Unmarshal(request["messages"], &messages) != nil || len(messages) == 0 || len(messages) > maxTranscriptMessages {
		return nil, nil, ErrFailed
	}
	next := make([]transcriptEntry, len(messages))
	for i, m := range messages {
		digest, err := canonicalDigest(m)
		if err != nil {
			return nil, nil, err
		}
		next[i].digest = digest
	}
	continues := len(t.entries) <= len(next)
	if continues {
		for i, e := range t.entries {
			if e.digest != next[i].digest {
				continues = false
				break
			}
		}
	}
	var notice *Notice
	size := 0
	for i, m := range messages {
		if err := ctx.Err(); err != nil {
			return nil, nil, err
		}
		var message map[string]json.RawMessage
		if json.Unmarshal(m, &message) != nil {
			return nil, nil, ErrFailed
		}
		var role string
		if json.Unmarshal(message["role"], &role) != nil {
			return nil, nil, ErrFailed
		}
		if role != "user" {
			continue
		}
		if continues && i < len(t.entries) && t.entries[i].user != nil {
			next[i] = t.entries[i]
		} else {
			// Use a one-message envelope so no history or target settings reach the
			// rewriter, even when recovering a cold/resumed/edited conversation.
			single, _ := json.Marshal(map[string]any{"messages": []json.RawMessage{m}})
			draft, err := Select(single)
			if err != nil {
				return nil, nil, err
			}
			next[i].user = m // image-only/empty user messages contain no prose to rewrite.
			if draft != nil {
				normalized, n, err := draft.Rewrite(ctx, c)
				if err != nil {
					return nil, nil, err
				}
				var envelope struct {
					Messages []json.RawMessage `json:"messages"`
				}
				if json.Unmarshal(normalized, &envelope) != nil || len(envelope.Messages) != 1 {
					return nil, nil, ErrFailed
				}
				next[i].user = envelope.Messages[0]
				n.MessageIndex = i
				next[i].notice = &n
			}
		}
		messages[i] = next[i].user
		size += len(next[i].user)
		if next[i].notice != nil {
			notice = next[i].notice
			for _, s := range notice.Texts {
				size += len(s)
			}
		}
		if size > maxTranscriptBytes {
			return nil, nil, ErrFailed
		}
	}
	request["messages"], _ = json.Marshal(messages)
	result, err := json.Marshal(request)
	if err != nil {
		return nil, nil, ErrFailed
	}
	if err := ctx.Err(); err != nil {
		return nil, nil, err
	}
	t.entries = next
	// Tool continuations replay normalized history without repeating UI previews.
	if notice != nil && notice.MessageIndex != len(messages)-1 {
		notice = nil
	}
	return result, notice, nil
}
