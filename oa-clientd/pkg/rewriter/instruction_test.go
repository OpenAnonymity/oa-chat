package rewriter

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestCustomInstructionRetainsResponseContract(t *testing.T) {
	for _, custom := range []string{"", "Use compact impersonal task statements."} {
		t.Run(custom, func(t *testing.T) {
			called := false
			s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				called = true
				var body struct {
					Messages []struct{ Role, Content string }
				}
				if json.NewDecoder(r.Body).Decode(&body) != nil || len(body.Messages) != 2 {
					t.Error("bad editor request")
					return
				}
				want := custom
				if want == "" {
					want = DefaultInstruction
				}
				if body.Messages[0].Content != want+"\n\n"+responseContract {
					t.Error("instruction or contract missing")
				}
				w.Header().Set("Content-Type", "application/json")
				w.Write([]byte(`{"choices":[{"finish_reason":"stop","message":{"content":"{\"texts\":[\"Explain dogs.\"]}"}}]}`))
			}))
			defer s.Close()
			draft, _ := Select(json.RawMessage(`{"messages":[{"role":"user","content":"tell me about dogs"}]}`))
			if _, _, err := draft.Rewrite(context.Background(), Config{URL: s.URL, Model: "m", Instruction: custom}); err != nil {
				t.Fatal(err)
			}
			if !called {
				t.Fatal("no rewrite")
			}
		})
	}
	for _, instruction := range []string{" ", strings.Repeat("a", MaxInstructionBytes+1), "x\x00y", string([]byte{255})} {
		if (Config{Instruction: instruction}).Validate() == nil {
			t.Fatal("accepted invalid instruction")
		}
	}
}
