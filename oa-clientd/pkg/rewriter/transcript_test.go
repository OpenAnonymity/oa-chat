package rewriter

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
)

func TestTranscriptReplaysRewritesAndOnlyReadsNewText(t *testing.T) {
	var inputs [][]string
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var request struct{ Messages []struct{ Content string } }
		json.NewDecoder(r.Body).Decode(&request)
		var input struct{ Texts []string }
		json.Unmarshal([]byte(request.Messages[1].Content), &input)
		inputs = append(inputs, append([]string(nil), input.Texts...))
		for i := range input.Texts {
			input.Texts[i] = "NORMALIZED_" + string(rune('A'+len(inputs)-1))
		}
		raw, _ := json.Marshal(map[string]any{"texts": input.Texts})
		reply(w, string(raw))
	}))
	defer s.Close()
	c := Config{URL: s.URL, Model: "m"}
	var transcript Transcript
	first := `{"model":"target","messages":[{"role":"system","content":"system"},{"role":"user","content":"RAW_A"}]}`
	second := `{"model":"target","messages":[{"role":"system","content":"system"},{"role":"user","content":"RAW_A"},{"role":"assistant","content":"answer"},{"role":"user","content":"RAW_B"}]}`
	tool := `{"model":"target","messages":[{"role":"system","content":"system"},{"role":"user","content":"RAW_A"},{"role":"assistant","content":"answer"},{"role":"user","content":"RAW_B"},{"role":"assistant","tool_calls":[{"id":"call"}]},{"role":"tool","tool_call_id":"call","content":"result"}]}`
	for i, body := range []string{first, first, second, tool, tool} {
		raw, notice, err := transcript.Rewrite(context.Background(), json.RawMessage(body), c)
		if err != nil {
			t.Fatal(err)
		}
		if strings.Contains(string(raw), "RAW_") || !strings.Contains(string(raw), "NORMALIZED_A") {
			t.Fatal("raw history leaked", string(raw))
		}
		if i >= 2 && !strings.Contains(string(raw), "NORMALIZED_B") {
			t.Fatal("lost rewrite")
		}
		if i >= 3 && notice != nil {
			t.Fatal("tool continuation repeated preview")
		}
	}
	if !reflect.DeepEqual(inputs, [][]string{{"RAW_A"}, {"RAW_B"}}) {
		t.Fatal("rewriter read prior history or retried cached turn", inputs)
	}
}

func TestColdEditedAndTruncatedHistoryNeverPassesRaw(t *testing.T) {
	calls := 0
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { calls++; reply(w, `{"texts":["normalized"]}`) }))
	defer s.Close()
	c := Config{URL: s.URL, Model: "m"}
	var transcript Transcript
	for _, body := range []string{
		`{"messages":[{"role":"user","content":"RAW_OLD"},{"role":"assistant","content":"answer"},{"role":"user","content":"RAW_NEW"},{"role":"tool","content":"result"}]}`,
		`{"messages":[{"role":"user","content":"RAW_EDITED"},{"role":"assistant","content":"answer"},{"role":"user","content":"RAW_NEW"}]}`,
		`{"messages":[{"role":"user","content":"RAW_EDITED"}]}`,
	} {
		raw, _, err := transcript.Rewrite(context.Background(), json.RawMessage(body), c)
		if err != nil || strings.Contains(string(raw), "RAW_") {
			t.Fatal("cache miss leaked original", err)
		}
	}
	if calls != 5 {
		t.Fatal("did not rewrite all unknown turns", calls)
	}
}

func TestTranscriptFailureIsAtomic(t *testing.T) {
	calls := 0
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if calls == 2 {
			http.Error(w, "secret", 500)
			return
		}
		reply(w, `{"texts":["normalized"]}`)
	}))
	defer s.Close()
	var transcript Transcript
	body := json.RawMessage(`{"messages":[{"role":"user","content":"RAW_1"},{"role":"assistant","content":"a"},{"role":"user","content":"RAW_2"}]}`)
	raw, _, err := transcript.Rewrite(context.Background(), body, Config{URL: s.URL, Model: "m"})
	if err == nil || raw != nil || len(transcript.entries) != 0 {
		t.Fatal("partial rewrite committed")
	}
}

func TestTranscriptPreservesNumbersAndNonUserValues(t *testing.T) {
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, `{"choices":[{"finish_reason":"stop","message":{"content":"{\"texts\":[\"normalized\"]}"}}]}`)
	}))
	defer s.Close()
	var transcript Transcript
	body := json.RawMessage(`{"messages":[{"role":"user","content":"raw"},{"role":"tool","content":{"n":9007199254740993}}],"seed":9007199254740993}`)
	raw, _, err := transcript.Rewrite(context.Background(), body, Config{URL: s.URL, Model: "m"})
	if err != nil || strings.Count(string(raw), "9007199254740993") != 2 {
		t.Fatal("changed large numeric values", err)
	}
}
