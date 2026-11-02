package server

import (
	"bytes"
	"log"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestResponseCosts(t *testing.T) {
	for _, tc := range []struct {
		name, body, want string
		stream           bool
	}{
		{"json", `{"usage":{"cost":0.0123},"choices":[]}`, "USD=0.0123", false},
		{"zero", `{"usage":{"cost":0}}`, "USD=0", false},
		{"missing", `{"choices":[]}`, "unavailable", false},
		{"secret", `{"usage":{"cost":"private-secret"}}`, "unavailable", false},
		{"negative", `{"usage":{"cost":-1}}`, "unavailable", false},
		{"stream", "data: {\"usage\":{\"cost\":0.02}}\n\ndata: [DONE]\n\n", "USD=0.02", true},
		{"truncated", "data: {\"usage\":{\"cost\":0.02}}\n\n", "unavailable", true},
		{"error", "data: {\"error\":{\"message\":\"private-secret\"}}\n\ndata: [DONE]\n\n", "unavailable", true},
		{"oversize", strings.Repeat("x", costRecordLimit+1), "unavailable", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var output bytes.Buffer
			h := LogRequests(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				ct := "application/json"
				if tc.stream {
					ct = "text/event-stream"
				}
				w.Header().Set("Content-Type", ct)
				for i := 0; i < len(tc.body); i += 7 {
					end := i + 7
					if end > len(tc.body) {
						end = len(tc.body)
					}
					w.Write([]byte(tc.body[i:end]))
				}
			}), log.New(&output, "", 0))
			rec := httptest.NewRecorder()
			h.ServeHTTP(rec, httptest.NewRequest("POST", "/v1/chat/completions", nil))
			if rec.Body.String() != tc.body {
				t.Fatal("modified response")
			}
			if !strings.Contains(output.String(), tc.want) || strings.Count(output.String(), "response cost:") != 1 || strings.Contains(output.String(), "private-secret") {
				t.Fatal(output.String())
			}
		})
	}
}
func TestStreamingAlwaysRequestsUsage(t *testing.T) {
	for _, extra := range []string{"", `,"stream_options":{"include_usage":false,"extra":true}`} {
		body, _, err := sanitize([]byte(`{"model":"m","messages":[{"role":"user","content":"x"}],"stream":true`+extra+`}`), true)
		if err != nil || !bytes.Contains(body, []byte(`"include_usage":true`)) {
			t.Fatal(string(body), err)
		}
	}
}
