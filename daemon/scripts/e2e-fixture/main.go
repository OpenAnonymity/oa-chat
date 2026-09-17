// e2e-fixture is a deterministic mock backend for Open WebUI integration tests.
// It exercises the real daemon HTTP server without spending tickets or funds.
// Production oa-chat has no switch that enables this backend.
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/OpenAnonymity/oa-chat/daemon/internal/server"
)

const model = "oa-e2e-streaming"
const answer = "Streaming works: tokens arrive before the response finishes. This is a deterministic integration test."

type fixture struct{}

func (fixture) Models(context.Context) (json.RawMessage, error) {
	return json.RawMessage(`{"object":"list","data":[{"id":"oa-e2e-streaming","object":"model","created":0,"owned_by":"oa-e2e-fixture"}]}`), nil
}

func response(status int, contentType string, reader io.ReadCloser) *http.Response {
	return &http.Response{StatusCode: status, Header: http.Header{"Content-Type": []string{contentType}}, Body: reader}
}

func (fixture) Complete(ctx context.Context, body json.RawMessage) (*http.Response, error) {
	var request struct {
		Model  string `json:"model"`
		Stream bool   `json:"stream"`
	}
	if err := json.Unmarshal(body, &request); err != nil {
		return nil, err
	}
	if request.Model != model {
		return response(http.StatusNotFound, "application/json", io.NopCloser(strings.NewReader(`{"error":{"message":"Unknown fixture model","type":"invalid_request_error","code":"model_not_found"}}`))), nil
	}
	created := time.Now().Unix()
	if !request.Stream {
		payload, _ := json.Marshal(map[string]any{
			"id": "chatcmpl-oa-fixture", "object": "chat.completion", "created": created, "model": model,
			"choices": []any{map[string]any{"index": 0, "message": map[string]string{"role": "assistant", "content": answer}, "finish_reason": "stop"}},
			"usage":   map[string]int{"prompt_tokens": 8, "completion_tokens": 16, "total_tokens": 24},
		})
		return response(http.StatusOK, "application/json", io.NopCloser(bytes.NewReader(payload))), nil
	}
	reader, writer := io.Pipe()
	go func() {
		defer writer.Close()
		started := time.Now()
		emit := func(delta map[string]string, finish any) error {
			payload, _ := json.Marshal(map[string]any{
				"id": "chatcmpl-oa-fixture", "object": "chat.completion.chunk", "created": created, "model": model,
				"choices": []any{map[string]any{"index": 0, "delta": delta, "finish_reason": finish}},
			})
			_, err := fmt.Fprintf(writer, "data: %s\n\n", payload)
			return err
		}
		if err := emit(map[string]string{"role": "assistant", "content": ""}, nil); err != nil {
			return
		}
		for index, token := range strings.Split(answer, " ") {
			if index > 0 {
				token = " " + token
			}
			if err := emit(map[string]string{"content": token}, nil); err != nil {
				log.Print("fixture stream canceled by client")
				return
			}
			select {
			case <-ctx.Done():
				return
			case <-time.After(450 * time.Millisecond):
			}
		}
		if emit(map[string]string{}, "stop") == nil {
			fmt.Fprint(writer, "data: [DONE]\n\n")
		}
		log.Printf("fixture stream complete after %s", time.Since(started).Round(time.Millisecond))
	}()
	return response(http.StatusOK, "text/event-stream", reader), nil
}

func main() {
	api, err := server.New(fixture{}, os.Getenv("OA_E2E_API_KEY"), 4)
	if err != nil {
		log.Fatal("set OA_E2E_API_KEY to a random token of at least 32 characters")
	}
	srv := &http.Server{Addr: "127.0.0.1:8787", Handler: api, ReadHeaderTimeout: 5 * time.Second}
	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer cancel()
	go func() {
		<-ctx.Done()
		shutdown, stop := context.WithTimeout(context.Background(), 5*time.Second)
		defer stop()
		srv.Shutdown(shutdown)
	}()
	log.Print("MOCK ONLY: OA streaming fixture at 127.0.0.1:8787")
	if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatal(err)
	}
}
