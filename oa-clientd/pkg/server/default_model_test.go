package server

import (
	"encoding/json"
	"testing"
)

func TestDefaultModel(t *testing.T) {
	for _, test := range []struct {
		body, fallback, want string
		fail                 bool
	}{
		{`{"messages":[{"role":"user","content":"hi"}]}`, "saved/model", "saved/model", false},
		{`{"model":"explicit/model","messages":[{"role":"user","content":"hi"}]}`, "saved/model", "explicit/model", false},
		{`{"model":null,"messages":[{"role":"user","content":"hi"}]}`, "saved/model", "", true},
		{`{"messages":[{"role":"user","content":"hi"}]}`, "", "", true},
		{`null`, "saved/model", "", true},
	} {
		raw, _, err := sanitizeWithDefault([]byte(test.body), test.fallback, true)
		if (err != nil) != test.fail {
			t.Fatal(test, err)
		}
		if err != nil {
			continue
		}
		var got struct {
			Model string `json:"model"`
		}
		_ = json.Unmarshal(raw, &got)
		if got.Model != test.want {
			t.Fatal(got.Model, test.want)
		}
	}
}
