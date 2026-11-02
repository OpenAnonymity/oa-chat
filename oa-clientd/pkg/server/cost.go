package server

import (
	"bytes"
	"encoding/json"
	"log"
	"math"
	"net/http"
	"strconv"
)

func logResponseCosts(next http.Handler, logger *log.Logger) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/v1/chat/completions" {
			next.ServeHTTP(w, r)
			return
		}
		cost := &costWriter{ResponseWriter: w}
		returned := false
		defer func() { cost.report(logger, returned) }()
		next.ServeHTTP(cost, r)
		returned = true
	})
}

// Observe only bytes already written to the caller. Bounded parsing never logs
// arbitrary provider strings, prompt data, or response bodies. Provider USD is
// not a verified wallet charge and is never converted to ETH here.
type costWriter struct {
	http.ResponseWriter
	pending                     []byte
	cost                        string
	seen, invalid, failed, done bool
	status                      int
}

const costRecordLimit = 1 << 20

func (w *costWriter) Unwrap() http.ResponseWriter { return w.ResponseWriter }
func (w *costWriter) WriteHeader(status int) {
	if w.status == 0 && status >= 200 {
		w.status = status
	}
	w.ResponseWriter.WriteHeader(status)
}
func (w *costWriter) FlushError() error {
	err := http.NewResponseController(w.ResponseWriter).Flush()
	if err != nil {
		w.failed = true
	}
	return err
}
func (w *costWriter) Write(p []byte) (int, error) {
	if w.status == 0 {
		w.status = 200
	}
	n, err := w.ResponseWriter.Write(p)
	if err != nil || n != len(p) {
		w.failed = true
	}
	w.observe(p[:n])
	return n, err
}
func (w *costWriter) observe(p []byte) {
	stream := bytes.Contains([]byte(w.Header().Get("Content-Type")), []byte("text/event-stream"))
	if !stream {
		if len(w.pending)+len(p) > costRecordLimit {
			w.invalid = true
			w.pending = nil
			return
		}
		if !w.invalid {
			w.pending = append(w.pending, p...)
		}
		return
	}
	for len(p) > 0 {
		i := bytes.IndexByte(p, '\n')
		end := len(p)
		if i >= 0 {
			end = i + 1
		}
		if len(w.pending)+end > costRecordLimit {
			w.invalid = true
			w.pending = nil
			return
		}
		if w.invalid {
			return
		}
		w.pending = append(w.pending, p[:end]...)
		p = p[end:]
		if i >= 0 {
			line := bytes.TrimSpace(w.pending)
			if bytes.HasPrefix(line, []byte("data:")) {
				data := bytes.TrimSpace(line[5:])
				if bytes.Equal(data, []byte("[DONE]")) {
					w.done = true
				} else {
					w.decode(data)
				}
			}
			w.pending = w.pending[:0]
		}
	}
}
func (w *costWriter) decode(data []byte) {
	var obj struct {
		Usage struct {
			Cost json.RawMessage `json:"cost"`
		} `json:"usage"`
		Error json.RawMessage `json:"error"`
	}
	if json.Unmarshal(data, &obj) != nil {
		w.invalid = true
		return
	}
	if len(obj.Error) > 0 && string(obj.Error) != "null" {
		w.failed = true
	}
	raw := obj.Usage.Cost
	if len(raw) == 0 || string(raw) == "null" {
		return
	}
	// Accept only JSON numbers, not strings, with a conservative size/range cap.
	if len(raw) > 48 || raw[0] == '"' {
		w.invalid = true
		return
	}
	var n json.Number
	if json.Unmarshal(raw, &n) != nil {
		w.invalid = true
		return
	}
	amount, err := strconv.ParseFloat(string(n), 64)
	if err != nil || math.IsNaN(amount) || math.IsInf(amount, 0) || amount < 0 || amount > 1000000 {
		w.invalid = true
		return
	}
	value := string(n)
	if w.seen && w.cost != value {
		w.invalid = true
		return
	}
	w.seen = true
	w.cost = value
}
func (w *costWriter) report(logger *log.Logger, returned bool) {
	if w.status < 200 || w.status >= 300 {
		return
	}
	stream := bytes.Contains([]byte(w.Header().Get("Content-Type")), []byte("text/event-stream"))
	if !stream && !w.invalid {
		w.decode(w.pending)
		w.done = !w.invalid
	}
	complete := returned && !w.failed && w.done
	if w.seen && !w.invalid && complete {
		logger.Printf("response cost: provider-reported USD=%s (unverified); verified ETH charge follows key-session settlement", w.cost)
	} else {
		logger.Printf("response cost: unavailable (missing/invalid provider usage or incomplete response); verified ETH charge follows key-session settlement")
	}
}
