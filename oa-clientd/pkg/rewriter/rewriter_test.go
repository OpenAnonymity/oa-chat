package rewriter

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func reply(w http.ResponseWriter, content string) {
	_ = json.NewEncoder(w).Encode(map[string]any{"choices": []any{map[string]any{"finish_reason": "stop", "message": map[string]any{"content": content}}}})
}
func TestLatestUserTextOnly(t *testing.T) {
	for _, multi := range []bool{false, true} {
		latest := `"hey plz fix it"`
		if multi {
			latest = `[{"type":"image_url","image_url":{"url":"data:SECRET_IMAGE"}},{"type":"text","text":"hey plz fix it"}]`
		}
		body := json.RawMessage(`{"model":"target","tools":[{"secret":"TOOLS"}],"temperature":0.7,"messages":[{"role":"system","content":"SYSTEM_SECRET"},{"role":"user","content":"OLD_STYLE"},{"role":"assistant","content":"PRIOR_RESPONSE"},{"role":"user","name":"USER_NAME","content":` + latest + `}]}`)
		service := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Path != "/v1/chat/completions" || r.Header.Get("Authorization") != "" {
				t.Error("wrong endpoint or leaked key")
			}
			raw, _ := io.ReadAll(r.Body)
			for _, secret := range []string{"SYSTEM_SECRET", "OLD_STYLE", "PRIOR_RESPONSE", "USER_NAME", "SECRET_IMAGE", "TOOLS", "target"} {
				if strings.Contains(string(raw), secret) {
					t.Errorf("disclosed %s", secret)
				}
			}
			var req struct {
				Model    string
				Stream   bool
				Messages []struct{ Role, Content string }
			}
			if json.Unmarshal(raw, &req) != nil || req.Model != "rewriter-model" || req.Stream || len(req.Messages) != 2 {
				t.Error("invalid rewriter request")
			}
			reply(w, `{"texts":["Please fix it."]}`)
		}))
		d, err := Select(body)
		if err != nil {
			t.Fatal(err)
		}
		result, notice, err := d.Rewrite(context.Background(), Config{URL: service.URL, Model: "rewriter-model"})
		service.Close()
		if err != nil {
			t.Fatal(err)
		}
		var before, after map[string]any
		json.Unmarshal(body, &before)
		json.Unmarshal(result, &after)
		msgs := before["messages"].([]any)
		if multi {
			msgs[3].(map[string]any)["content"].([]any)[1].(map[string]any)["text"] = "Please fix it."
		} else {
			msgs[3].(map[string]any)["content"] = "Please fix it."
		}
		if !reflect.DeepEqual(before, after) || notice.MessageIndex != 3 || notice.Texts[0] != "Please fix it." {
			t.Fatal("modified unrelated history or parameters")
		}
	}
}

func TestSkipToolContinuationsAndImageOnly(t *testing.T) {
	for _, body := range []string{
		`{"messages":[{"role":"user","content":"old"},{"role":"tool","content":"result"}]}`,
		`{"messages":[{"role":"user","content":[{"type":"image_url","image_url":{"url":"image"}}]}]}`,
		`{"messages":[{"role":"user","content":"  "}]}`,
	} {
		d, err := Select(json.RawMessage(body))
		if d != nil || err != nil {
			t.Fatal("rewrote historical or nontext content", err)
		}
	}
}

func TestFailClosedOnInvalidRewriterResponses(t *testing.T) {
	for _, content := range []string{``, `not JSON`, "```json\n{\"texts\":[\"hi\"]}\n```", `{"texts":[]}`, `{"texts":[""]}`, `{"texts":["a","b"]}`, `{"texts":["hi"],"extra":true}`, `{"texts":["hi"]} {}`, `{"texts":["\u001b[31m"]}`} {
		s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { reply(w, content) }))
		d, _ := Select(json.RawMessage(`{"messages":[{"role":"user","content":"original"}]}`))
		got, _, err := d.Rewrite(context.Background(), Config{URL: s.URL, Model: "model"})
		s.Close()
		if err != ErrFailed || got != nil {
			t.Fatal("accepted invalid rewrite", content, err)
		}
	}
	for _, raw := range []string{
		`{"choices":[{"finish_reason":"length","message":{"content":"{\"texts\":[\"partial\"]}"}}]}`,
		`{"choices":[{"finish_reason":"stop","message":{"content":"{\"texts\":[\"ok\"]}","tool_calls":[{}]}}]}`,
		strings.Repeat("x", maxResponse+1),
	} {
		s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { io.WriteString(w, raw) }))
		d, _ := Select(json.RawMessage(`{"messages":[{"role":"user","content":"original"}]}`))
		got, _, err := d.Rewrite(context.Background(), Config{URL: s.URL, Model: "model"})
		s.Close()
		if err != ErrFailed || got != nil {
			t.Fatal("accepted truncated/tool/oversize rewrite", err)
		}
	}
}

func TestNoRedirectOrEnvironmentProxyAndKeyIsolation(t *testing.T) {
	var redirected atomic.Int32
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { redirected.Add(1) }))
	defer target.Close()
	t.Setenv("HTTP_PROXY", target.URL)
	t.Setenv("HTTPS_PROXY", target.URL)
	t.Setenv("ALL_PROXY", target.URL)
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer REWRITER_ONLY" {
			t.Error("missing rewriter key")
		}
		http.Redirect(w, r, target.URL, http.StatusTemporaryRedirect)
	}))
	defer s.Close()
	d, _ := Select(json.RawMessage(`{"messages":[{"role":"user","content":"original"}]}`))
	_, _, err := d.Rewrite(context.Background(), Config{URL: s.URL, Model: "model", APIKey: "REWRITER_ONLY"})
	if err != ErrFailed || redirected.Load() != 0 {
		t.Fatal("redirected prompt/key or used environment proxy")
	}
}

func TestCancellation(t *testing.T) {
	started := make(chan struct{})
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.Copy(io.Discard, r.Body)
		close(started)
		<-r.Context().Done()
	}))
	defer s.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() {
		d, _ := Select(json.RawMessage(`{"messages":[{"role":"user","content":"original"}]}`))
		_, _, err := d.Rewrite(ctx, Config{URL: s.URL, Model: "model"})
		done <- err
	}()
	<-started
	cancel()
	select {
	case err := <-done:
		if err != ErrFailed {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("rewrite did not cancel")
	}
}

func TestConfigValidation(t *testing.T) {
	for _, endpoint := range []string{"http://remote.example/v1", "https://user:secret@example.com", "https://example.com?key=secret", "https://example.com/#fragment", "localhost:8011"} {
		if (Config{URL: endpoint, Model: "m"}).Validate() == nil {
			t.Fatal("accepted unsafe URL", endpoint)
		}
	}
	for _, endpoint := range []string{"http://localhost:8011", "http://127.0.0.1:8011/v1", "https://example.com/api/v1"} {
		if err := (Config{URL: endpoint, Model: "m"}).Validate(); err != nil {
			t.Fatal(err)
		}
	}
	if (Config{URL: "http://localhost:8011", Model: "m", APIKey: "secret\n"}).Validate() == nil {
		t.Fatal("accepted header injection")
	}
}

// Explicit opt-in uses only this synthetic prompt, never a wallet or zkAPI.
func TestLiveLocalRewriter(t *testing.T) {
	if os.Getenv("ZKAPI_TEST_REWRITER") != "1" {
		t.Skip("set ZKAPI_TEST_REWRITER=1 for localhost:8012")
	}
	d, _ := Select(json.RawMessage(`{"messages":[{"role":"user","content":"hey, could ya explain what a hash map is? keep it to two sentences pls."}]}`))
	_, notice, err := d.Rewrite(context.Background(), Config{URL: "http://localhost:8012", Model: "qwen3.8-flash-next"})
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("Synthetic rewrite: %q", notice.Texts)
}
