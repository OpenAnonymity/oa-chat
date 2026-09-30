package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/OpenAnonymity/oa-chat/daemon/internal/server"
	"github.com/OpenAnonymity/oa-chat/daemon/internal/zkapi"
)

// Exercise the complete loopback gateway with Open WebUI's overlapping streamed
// chat and background-title request pattern, without any real wallet or funds.
func TestOpenWebUIConcurrentRequestsWaitForStreamAndSettlement(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	var leaseCalls, providerCalls atomic.Int32
	pending := make(chan struct{})
	bridge := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer "+strings.Repeat("b", 32) {
			t.Error("companion lost its authentication")
		}
		switch r.URL.Path {
		case "/oa/v1/status":
			_ = json.NewEncoder(w).Encode(map[string]any{"bridge_version": 4, "chain_id": 1, "mode": "direct_openrouter", "require_oa_org_key_source": true, "deployment_id": "zkapi-native-eth-mainnet-note-bound-v1-fresh-20260928", "contract_address": "0x4bDC8718c4F39289455a3C15F8Bd2C345AA51a41", "billing_asset": "native_eth", "billing_unit": "gwei", "circuit_id": "zkapi-v2-note-bound-v1"})
		case "/oa/v1/lease":
			body, _ := io.ReadAll(r.Body)
			if string(body) != `{"request_limit_micro_usd":1000000}` {
				t.Error("prompt or identity crossed the companion boundary")
			}
			n := leaseCalls.Add(1)
			if n == 2 {
				w.WriteHeader(http.StatusConflict)
				_, _ = io.WriteString(w, `{"error":{"code":"lease_pending"}}`)
				close(pending)
				return
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"api_key": fmt.Sprintf("fresh-key-%d", n), "base_url": zkapi.DefaultInferenceBaseURL, "expires_at": time.Now().Unix() + 60, "verified": true, "verification_status": "verified"})
		default:
			t.Error("unexpected companion route")
			w.WriteHeader(404)
		}
	}))
	defer bridge.Close()
	finish := make(chan struct{})
	var finishOnce sync.Once
	release := func() { finishOnce.Do(func() { close(finish) }) }
	defer release()
	remote := &http.Client{Transport: ticketInferenceTransport(func(r *http.Request) (*http.Response, error) {
		header := make(http.Header)
		header.Set("Content-Type", "application/json")
		body := ""
		switch r.URL.Path {
		case "/chat/model-tickets":
			body = `{"test/model":1}`
		case "/chat/pinned-models":
			body = `{"disabled_models":[]}`
		case "/api/v1/chat/completions":
			n := providerCalls.Add(1)
			wantKey := "Bearer fresh-key-1"
			if n == 2 {
				wantKey = "Bearer fresh-key-3"
			}
			if r.Header.Get("Authorization") != wantKey || r.Header.Get("Cookie") != "" {
				t.Error("inference reused a lease or forwarded client credentials")
			}
			if n == 1 {
				header.Set("Content-Type", "text/event-stream")
				reader, writer := io.Pipe()
				go func() {
					defer writer.Close()
					_, _ = io.WriteString(writer, "data: {\"choices\":[{\"delta\":{\"content\":\"first\"}}]}\n\n")
					select {
					case <-finish:
						_, _ = io.WriteString(writer, "data: [DONE]\n\n")
					case <-ctx.Done():
					}
				}()
				return &http.Response{StatusCode: 200, Header: header, Body: reader}, nil
			}
			body = `{"choices":[{"message":{"role":"assistant","content":"Chat title"}}]}`
		default:
			return nil, fmt.Errorf("unexpected fixture request")
		}
		return &http.Response{StatusCode: 200, Header: header, Body: io.NopCloser(strings.NewReader(body))}, nil
	})}
	wallet, err := zkapi.New(zkapi.Config{ClientURL: bridge.URL, BridgeToken: strings.Repeat("b", 32), HTTPClient: remote})
	if err != nil {
		t.Fatal(err)
	}
	api, err := server.New(zkInference{wallet}, strings.Repeat("a", 32), 1)
	if err != nil {
		t.Fatal(err)
	}
	local := httptest.NewServer(api)
	defer local.Close()
	client := local.Client()
	post := func(stream bool) (*http.Response, error) {
		payload := fmt.Sprintf(`{"model":"test/model","messages":[{"role":"user","content":"private request"}],"stream":%t,"user":"strip-me"}`, stream)
		r, err := http.NewRequestWithContext(ctx, http.MethodPost, local.URL+"/v1/chat/completions", strings.NewReader(payload))
		if err != nil {
			return nil, err
		}
		r.Header.Set("Content-Type", "application/json")
		// The first request has no key; a UI's placeholder key also works.
		if !stream {
			r.Header.Set("Authorization", "Bearer unused")
		}
		return client.Do(r)
	}
	first, err := post(true)
	if err != nil {
		t.Fatal(err)
	}
	defer first.Body.Close()
	if first.StatusCode != 200 {
		t.Fatalf("chat status %d", first.StatusCode)
	}
	chunk := make([]byte, 128)
	n, err := first.Body.Read(chunk)
	if err != nil || !bytes.Contains(chunk[:n], []byte("first")) {
		t.Fatal("streaming token was buffered", err)
	}
	secondDone := make(chan error, 1)
	go func() {
		response, err := post(false)
		if err == nil {
			defer response.Body.Close()
			data, readErr := io.ReadAll(response.Body)
			if readErr != nil || response.StatusCode != 200 || !bytes.Contains(data, []byte("Chat title")) {
				err = fmt.Errorf("background request failed: status %d, read %v", response.StatusCode, readErr)
			}
		}
		secondDone <- err
	}()
	select {
	case err := <-secondDone:
		t.Fatalf("background request returned before stream completed: %v", err)
	case <-time.After(100 * time.Millisecond):
	}
	if leaseCalls.Load() != 1 || providerCalls.Load() != 1 {
		t.Fatal("background request acquired access while the chat stream was active")
	}
	release()
	if _, err := io.ReadAll(first.Body); err != nil {
		t.Fatal(err)
	}
	select {
	case <-pending:
	case <-ctx.Done():
		t.Fatal("background request did not reach settlement wait")
	}
	select {
	case err := <-secondDone:
		if err != nil {
			t.Fatal(err)
		}
	case <-ctx.Done():
		t.Fatal("background request did not finish after settlement")
	}
	if leaseCalls.Load() != 3 || providerCalls.Load() != 2 {
		t.Fatal("wrong number of fresh leases or provider requests")
	}
}
