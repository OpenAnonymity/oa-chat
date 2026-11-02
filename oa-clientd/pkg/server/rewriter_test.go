package server

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/OpenAnonymity/oa-chat/oa-clientd/pkg/rewriter"
)

func TestRewritePreviewFlushesBeforeTargetAndStreamError(t *testing.T) {
	for _, fail := range []bool{false, true} {
		release := make(chan struct{})
		b := &fakeBackend{complete: func(ctx context.Context, body json.RawMessage) (*http.Response, error) {
			if err := rewriter.Publish(ctx, rewriter.Notice{MessageIndex: 0, Texts: []string{"Normalized prompt."}, Source: "zkapi-rewriter"}); err != nil {
				return nil, err
			}
			select {
			case <-release:
			case <-ctx.Done():
				return nil, ctx.Err()
			}
			if fail {
				return nil, errors.New("SECRET remote error")
			}
			return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": []string{"text/event-stream"}}, Body: io.NopCloser(strings.NewReader("data: {\"choices\":[{\"index\":0,\"delta\":{\"reasoning_content\":\"TARGET_THINKING\"}}]}\n\ndata: [DONE]\n\n"))}, nil
		}}
		s := apiServer(t, b)
		client := &http.Client{Timeout: 3 * time.Second}
		req, _ := http.NewRequest("POST", s.URL+"/v1/chat/completions", strings.NewReader(`{"model":"test/model","messages":[{"role":"user","content":"original"}],"stream":true}`))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Authorization", "Bearer "+testKey)
		resp, err := client.Do(req)
		if err != nil {
			close(release)
			s.Close()
			t.Fatal(err)
		}
		reader := bufio.NewReader(resp.Body)
		line, err := reader.ReadString('\n')
		if err != nil || !strings.Contains(line, "Normalized prompt.") || !strings.Contains(line, "reasoning_content") || !strings.Contains(line, "zkapi_rewrite") {
			close(release)
			resp.Body.Close()
			s.Close()
			t.Fatal("missing immediate preview", line, err)
		}
		close(release)
		rest, _ := io.ReadAll(reader)
		resp.Body.Close()
		s.Close()
		if fail {
			if !strings.Contains(string(rest), `"error"`) || strings.Contains(string(rest), "SECRET") || !strings.Contains(string(rest), "data: [DONE]") {
				t.Fatal("invalid streamed error", string(rest))
			}
		} else if !strings.Contains(string(rest), "TARGET_THINKING") {
			t.Fatal("lost target stream")
		}
	}
}

func TestRewriteNoticeModesAndNonstreamContent(t *testing.T) {
	for _, mode := range []string{"reasoning", "metadata", "off"} {
		for _, streaming := range []bool{true, false} {
			w := httptest.NewRecorder()
			n := &completionNotice{streaming: streaming, mode: mode, model: "target"}
			if err := rewriter.Publish(n.context(context.Background(), w), rewriter.Notice{Texts: []string{"rewritten"}}); err != nil {
				t.Fatal(err)
			}
			if streaming {
				if strings.Contains(w.Body.String(), "reasoning_content") != (mode == "reasoning") {
					t.Fatal("incorrect reasoning mode")
				}
				if strings.Contains(w.Body.String(), "zkapi_rewrite") != (mode != "off") {
					t.Fatal("incorrect metadata mode")
				}
			} else if mode != "off" {
				raw, err := n.annotateJSON(strings.NewReader(`{"choices":[{"message":{"content":"ANSWER","tool_calls":[{"id":"tool"}]}}]}`))
				if err != nil || !strings.Contains(string(raw), `"content":"ANSWER"`) || !strings.Contains(string(raw), `"tool_calls"`) || !strings.Contains(string(raw), "zkapi_rewrite") {
					t.Fatal("nonstream answer corrupted", err)
				}
			}
		}
	}
}
