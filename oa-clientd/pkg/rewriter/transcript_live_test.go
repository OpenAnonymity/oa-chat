package rewriter

import (
	"context"
	"encoding/json"
	"os"
	"strings"
	"testing"
)

// Live semantic checks are deliberately partial: they cannot prove equivalence
// or resistance to stylometric identification. Inspect the logged reconstruction.
func TestLiveCanonicalReconstruction(t *testing.T) {
	if os.Getenv("ZKAPI_TEST_REWRITER") != "1" {
		t.Skip("set ZKAPI_TEST_REWRITER=1 for localhost:8012")
	}
	for _, sample := range []struct {
		name, text string
		retain     []string
	}{
		{"restaurants", "give me the top 5 best vegan restaurants in London, Ontario", []string{"5", "vegan", "London", "Ontario"}},
		{"privacy", "My goal is privacy preservation. Are there any other things other than skills that go into the structured prompt that I should disable? Maybe AGENTS.md? something else?", []string{"AGENTS.md", "skills", "privacy"}},
		{"constraints", "hey, I think this might be a cache issue, but I'm not sure. Could you suggest checks without running commands? Please don't change `/tmp/cache.json`. If a restart is needed, ask me first; otherwise just explain. Keep the answer under 100 words.", []string{"`/tmp/cache.json`", "100"}},
	} {
		t.Run(sample.name, func(t *testing.T) {
			body, _ := json.Marshal(map[string]any{"messages": []map[string]string{{"role": "user", "content": sample.text}}})
			draft, err := Select(body)
			if err != nil {
				t.Fatal(err)
			}
			_, notice, err := draft.Rewrite(context.Background(), Config{URL: "http://localhost:8012", Model: "qwen3.8-flash-next"})
			if err != nil {
				t.Fatal(err)
			}
			text := notice.Texts[0]
			for _, exact := range sample.retain {
				if !strings.Contains(text, exact) {
					t.Fatalf("lost protected detail %q in %q", exact, text)
				}
			}
			if sample.name == "restaurants" && strings.Contains(strings.ToLower(text), "top 5 best") {
				t.Fatal("retained redundant collocation", text)
			}
			if text == sample.text {
				t.Fatal("sample was not reconstructed")
			}
			t.Logf("Reconstructed: %s", text)
		})
	}
}

func TestLiveLocalTranscript(t *testing.T) {
	if os.Getenv("ZKAPI_TEST_REWRITER") != "1" {
		t.Skip("set ZKAPI_TEST_REWRITER=1 for localhost:8012")
	}
	c := Config{URL: "http://localhost:8012", Model: "qwen3.8-flash-next"}
	var transcript Transcript
	first := json.RawMessage(`{"messages":[{"role":"user","content":"hey, could ya explain what a hash map is? keep it to two sentences pls."}]}`)
	_, n, err := transcript.Rewrite(context.Background(), first, c)
	if err != nil {
		t.Fatal(err)
	}
	saved := string(transcript.entries[0].user)
	t.Logf("First synthetic rewrite: %q", n.Texts)
	next := json.RawMessage(`{"messages":[{"role":"user","content":"hey, could ya explain what a hash map is? keep it to two sentences pls."},{"role":"assistant","content":"A hash map stores key-value pairs using hashes for lookup."},{"role":"user","content":"ok cool, now gimme a tiny python example, no more than 5 lines tho"}]}`)
	out, n, err := transcript.Rewrite(context.Background(), next, c)
	if err != nil {
		t.Fatal(err)
	}
	var target struct{ Messages []json.RawMessage }
	if json.Unmarshal(out, &target) != nil || string(target.Messages[0]) != saved {
		t.Fatal("live continuation did not replay exact prior rewrite")
	}
	t.Logf("Second synthetic rewrite: %q", n.Texts)
	// No endpoint needed for an exact retry: both rewrites must already exist.
	c.URL = "http://127.0.0.1:1"
	retry, _, err := transcript.Rewrite(context.Background(), next, c)
	if err != nil || string(retry) != string(out) {
		t.Fatal("cached retry contacted rewriter or changed transcript", err)
	}
}
