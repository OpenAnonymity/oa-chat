package server

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestWebSearchRequestsAndCitationResponses(t *testing.T) {
	for _, enabled := range []bool{true, false} {
		for _, stream := range []bool{false, true} {
			for _, model := range []string{"test/model", "test/model:free:online"} {
				t.Run(fmt.Sprintf("enabled=%t/stream=%t/model=%s", enabled, stream, model), func(t *testing.T) {
					response := `{"choices":[{"message":{"role":"assistant","content":"[Source](https://example.com)","annotations":[{"type":"url_citation","url_citation":{"url":"https://example.com","title":"Source"}}]}}]}`
					contentType := "application/json"
					if stream {
						response = "data: " + response + "\n\ndata: [DONE]\n\n"
						contentType = "text/event-stream"
					}
					backend := &fakeBackend{complete: func(_ context.Context, raw json.RawMessage) (*http.Response, error) {
						var body map[string]json.RawMessage
						if err := json.Unmarshal(raw, &body); err != nil {
							t.Fatal(err)
						}
						if enabled {
							if string(body["plugins"]) != `[{"id":"web"}]` {
								t.Errorf("missing or unexpected plugins: %s", body["plugins"])
							}
						} else if _, exists := body["plugins"]; exists {
							t.Error("disabled search added a plugin or forwarded caller plugins")
						}
						if string(body["model"]) != fmt.Sprintf("%q", model) || string(body["stream"]) != fmt.Sprint(stream) || string(body["tools"]) != "[]" || string(body["max_tokens"]) != "128" {
							t.Error("search changed the model, streaming, tools, or token limit")
						}
						if _, exists := body["user"]; exists {
							t.Error("search forwarded caller identity")
						}
						return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": {contentType}}, Body: io.NopCloser(strings.NewReader(response))}, nil
					}}
					api, err := New(backend, testKey, 1)
					if err != nil {
						t.Fatal(err)
					}
					if !api.WebSearch {
						t.Fatal("gateway must default to web search enabled")
					}
					api.WebSearch = enabled
					payload := fmt.Sprintf(`{"model":%q,"messages":[{"role":"user","content":"latest news"}],"stream":%t,"tools":[],"max_tokens":128,"user":"private-identity","plugins":[{"id":"untrusted-plugin"}]}`, model, stream)
					r := httptest.NewRequest(http.MethodPost, "http://127.0.0.1:8787/v1/chat/completions", strings.NewReader(payload))
					r.RemoteAddr = "127.0.0.1:12345"
					r.Header.Set("Content-Type", "application/json")
					w := httptest.NewRecorder()
					api.ServeHTTP(w, r)
					if backend.calls.Load() != 1 || w.Code != http.StatusOK || w.Body.String() != response {
						t.Fatalf("completion or citations changed: status=%d body=%s", w.Code, w.Body.String())
					}
				})
			}
		}
	}
}
