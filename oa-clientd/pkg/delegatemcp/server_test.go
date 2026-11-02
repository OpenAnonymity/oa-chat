package delegatemcp

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/OpenAnonymity/oa-chat/oa-clientd/pkg/server"
)

const testAPIKey = "local-inference-key-0123456789abcdef"

type roundTrip func(*http.Request) (*http.Response, error)

func (f roundTrip) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func jsonResponse(r *http.Request, status int, body string) (*http.Response, error) {
	return &http.Response{StatusCode: status, Header: http.Header{"Content-Type": {"application/json"}}, Body: io.NopCloser(strings.NewReader(body)), Request: r}, nil
}

// fakeDaemon records every request the adapter makes.
type fakeDaemon struct {
	mu       sync.Mutex
	requests []*http.Request
	bodies   []string
	respond  func(*http.Request) (*http.Response, error)
}

func (f *fakeDaemon) RoundTrip(r *http.Request) (*http.Response, error) {
	body := ""
	if r.Body != nil {
		data, _ := io.ReadAll(r.Body)
		body = string(data)
	}
	f.mu.Lock()
	f.requests = append(f.requests, r)
	f.bodies = append(f.bodies, body)
	f.mu.Unlock()
	return f.respond(r)
}

func (f *fakeDaemon) count() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.requests)
}

func connect(t *testing.T, daemon http.RoundTripper, defaultModel string) *mcp.ClientSession {
	t.Helper()
	return connectProduct(t, daemon, defaultModel, nil)
}

func connectProduct(t *testing.T, daemon http.RoundTripper, defaultModel string, product *Product) *mcp.ClientSession {
	t.Helper()
	s, err := NewServer(Options{Listen: "127.0.0.1:43133", APIKey: testAPIKey, DefaultModel: defaultModel, Version: "test", Transport: daemon, Product: product})
	if err != nil {
		t.Fatal(err)
	}
	serverTransport, clientTransport := mcp.NewInMemoryTransports()
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	go func() { _ = s.Run(ctx, serverTransport) }()
	client := mcp.NewClient(&mcp.Implementation{Name: "test-host", Version: "1"}, nil)
	session, err := client.Connect(ctx, clientTransport, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = session.Close() })
	return session
}

func resultText(result *mcp.CallToolResult) string {
	var b strings.Builder
	for _, content := range result.Content {
		if text, ok := content.(*mcp.TextContent); ok {
			b.WriteString(text.Text)
		}
	}
	return b.String()
}

func TestToolsAreListedWithAccurateAnnotationsAndClosedSchemas(t *testing.T) {
	session := connect(t, &fakeDaemon{}, "")
	tools, err := session.ListTools(context.Background(), nil)
	if err != nil {
		t.Fatal(err)
	}
	byName := map[string]*mcp.Tool{}
	for _, tool := range tools.Tools {
		byName[tool.Name] = tool
	}
	if len(byName) != 2 || byName[DelegateTool] == nil || byName[ListModelsTool] == nil {
		t.Fatalf("tools = %v", byName)
	}
	delegate := byName[DelegateTool].Annotations
	if delegate.ReadOnlyHint || delegate.IdempotentHint || delegate.DestructiveHint == nil || !*delegate.DestructiveHint || delegate.OpenWorldHint == nil || !*delegate.OpenWorldHint {
		t.Fatalf("delegate annotations = %+v", delegate)
	}
	if list := byName[ListModelsTool].Annotations; !list.ReadOnlyHint || !list.IdempotentHint {
		t.Fatalf("list annotations = %+v", list)
	}
	schema, _ := json.Marshal(byName[DelegateTool].InputSchema)
	for _, want := range []string{`"additionalProperties":false`, `"required":["task"]`, `"enum":["low","medium","high"]`, `"maxLength":32768`} {
		if !strings.Contains(string(schema), want) {
			t.Fatalf("schema lacks %s: %s", want, schema)
		}
	}
	for _, field := range []string{"url", "header", "api_key", "metadata", "messages", "tools", "plugins", "stream", "relay"} {
		if strings.Contains(string(schema), `"`+field+`"`) {
			t.Fatalf("schema exposes %s", field)
		}
	}
}

func listedModelDescription(t *testing.T, session *mcp.ClientSession, delegateTool string) string {
	t.Helper()
	tools, err := session.ListTools(context.Background(), nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, tool := range tools.Tools {
		if tool.Name != delegateTool {
			continue
		}
		data, _ := json.Marshal(tool.InputSchema)
		var schema struct {
			Properties map[string]struct {
				Description string `json:"description"`
			} `json:"properties"`
		}
		if err := json.Unmarshal(data, &schema); err != nil {
			t.Fatal(err)
		}
		return schema.Properties["model"].Description
	}
	t.Fatalf("%s is not listed", delegateTool)
	return ""
}

// The model argument names the list tool of the product being served; the
// default product keeps its original wording exactly.
func TestDelegateSchemaNamesTheProductsListTool(t *testing.T) {
	const legacy = "Optional model ID from zkapi_list_models (for example a provider/model ID). Omit to use the daemon's default model."
	if got := listedModelDescription(t, connect(t, &fakeDaemon{}, ""), DelegateTool); got != legacy {
		t.Fatalf("default model description = %q", got)
	}
	product := &Product{Label: "x", Binary: "x-clientd", ServerName: "x-clientd", ServerTitle: "X", DelegateTool: "x_delegate", ListModelsTool: "x_list_models", DelegatePath: server.OADelegatePath}
	got := listedModelDescription(t, connectProduct(t, &fakeDaemon{}, "", product), "x_delegate")
	if got != "Optional model ID from x_list_models (for example a provider/model ID). Omit to use the daemon's default model." {
		t.Fatalf("product model description = %q", got)
	}
}

func TestDelegateCallsTheDaemonOnceWithOnlyLocalInferenceAuth(t *testing.T) {
	daemon := &fakeDaemon{respond: func(r *http.Request) (*http.Response, error) {
		return jsonResponse(r, 200, `{"model":"a/b","answer":"Use induction.","finish_reason":"stop","truncated":false,"usage":{"prompt_tokens":5,"completion_tokens":3,"total_tokens":8},"credential_verification":"verified"}`)
	}}
	session := connect(t, daemon, "")
	result, err := session.CallTool(context.Background(), &mcp.CallToolParams{Name: DelegateTool, Arguments: map[string]any{
		"task": "Prove the sum formula.", "context": "n is at least 1", "model": "a/b", "max_output_tokens": 800, "reasoning_effort": "medium",
	}})
	if err != nil || result.IsError {
		t.Fatalf("err=%v result=%+v", err, result)
	}
	if resultText(result) != "Use induction." {
		t.Fatalf("text = %q", resultText(result))
	}
	structured, _ := json.Marshal(result.StructuredContent)
	if !strings.Contains(string(structured), `"finish_reason":"stop"`) || !strings.Contains(string(structured), `"total_tokens":8`) {
		t.Fatalf("structured = %s", structured)
	}
	if daemon.count() != 1 {
		t.Fatalf("requests = %d", daemon.count())
	}
	r := daemon.requests[0]
	if r.Method != http.MethodPost || r.URL.String() != "http://127.0.0.1:43133"+server.DelegatePath {
		t.Fatalf("request = %s %s", r.Method, r.URL)
	}
	if r.Header.Get("Authorization") != "Bearer "+testAPIKey || r.Header.Get("X-OA-Management-Token") != "" {
		t.Fatal("wrong local credentials")
	}
	for name := range r.Header {
		switch name {
		case "Authorization", "Content-Type", "Accept":
		default:
			t.Fatalf("unexpected header %s", name)
		}
	}
	want := `{"task":"Prove the sum formula.","context":"n is at least 1","model":"a/b","max_output_tokens":800,"reasoning_effort":"medium"}`
	if daemon.bodies[0] != want {
		t.Fatalf("body = %s", daemon.bodies[0])
	}
}

func TestDelegateFailuresAreSingleAttemptAndRedacted(t *testing.T) {
	for name, test := range map[string]struct {
		respond func(*http.Request) (*http.Response, error)
		want    string
	}{
		"old_daemon": {func(r *http.Request) (*http.Response, error) {
			return jsonResponse(r, 404, `{"error":{"code":"not_found","message":"Use /v1/models or /v1/chat/completions."}}`)
		}, "does not provide strict delegation"},
		"legacy_engine": {func(r *http.Request) (*http.Response, error) {
			return jsonResponse(r, 501, `{"error":{"code":"delegation_unsupported","message":"This daemon's protocol engine does not support strict delegation."}}`)
		}, "(delegation_unsupported)"},
		"no_tor": {func(r *http.Request) (*http.Response, error) {
			return jsonResponse(r, 412, `{"error":{"code":"delegation_requires_tor","message":"Delegation requires daemon-native Tor routing; nothing was spent."}}`)
		}, "nothing was spent"},
		"provider": {func(r *http.Request) (*http.Response, error) {
			return jsonResponse(r, 502, `{"error":{"code":"upstream_error\u001b[31m","message":"bad\u001b[2J\r\nline"}}`)
		}, "(daemon_error)"},
		"wrong_key": {func(r *http.Request) (*http.Response, error) {
			return jsonResponse(r, 401, `{"error":{"code":"invalid_api_key","message":"x"}}`)
		}, "same --config-dir"},
		"redirect": {func(r *http.Request) (*http.Response, error) {
			return &http.Response{StatusCode: 307, Header: http.Header{"Location": {"https://evil.example/collect"}}, Body: io.NopCloser(strings.NewReader("")), Request: r}, nil
		}, "redirect"},
		"down": {func(*http.Request) (*http.Response, error) {
			return nil, errors.New("dial tcp 127.0.0.1:43133: connect: connection refused")
		}, "zkapi-clientd serve"},
		// The daemon has recorded (processed) the request in each case below
		// before the exchange fails, so the outcome must be reported unknown.
		"processed_then_reset": {func(*http.Request) (*http.Response, error) {
			return nil, errors.New("read tcp 127.0.0.1:50000->127.0.0.1:43133: read: connection reset by peer")
		}, "may have been processed and charged. It was not retried"},
		"processed_then_broken_body": {func(r *http.Request) (*http.Response, error) {
			body := io.MultiReader(strings.NewReader(`{"model":"a/b","answer":"partial`), brokenReader{})
			return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": {"application/json"}}, Body: io.NopCloser(body), Request: r}, nil
		}, "may have been processed and charged. It was not retried"},
		"processed_then_garbage": {func(r *http.Request) (*http.Response, error) {
			return jsonResponse(r, 200, `{"model":"a/b","answer":"trunc`)
		}, "may have been processed and charged. It was not retried"},
	} {
		t.Run(name, func(t *testing.T) {
			daemon := &fakeDaemon{respond: test.respond}
			session := connect(t, daemon, "")
			result, err := session.CallTool(context.Background(), &mcp.CallToolParams{Name: DelegateTool, Arguments: map[string]any{"task": "t"}})
			if err != nil || !result.IsError {
				t.Fatalf("err=%v result=%+v", err, result)
			}
			text := resultText(result)
			if !strings.Contains(text, test.want) || strings.ContainsAny(text, "\x1b\r\n") || strings.Contains(text, "evil.example") {
				t.Fatalf("text = %q", text)
			}
			if daemon.count() != 1 {
				t.Fatalf("attempts = %d", daemon.count())
			}
		})
	}
}

func TestDelegateRejectsInvalidArgumentsWithoutCallingDaemon(t *testing.T) {
	daemon := &fakeDaemon{respond: func(r *http.Request) (*http.Response, error) { return jsonResponse(r, 200, `{}`) }}
	session := connect(t, daemon, "")
	for _, arguments := range []map[string]any{
		{},
		{"task": ""},
		{"task": "   "},
		{"task": "t", "url": "https://evil.example"},
		{"task": "t", "headers": map[string]any{"X": "y"}},
		{"task": "t", "reasoning_effort": "extreme"},
		{"task": "t", "max_output_tokens": 0},
		{"task": "t", "max_output_tokens": 40000},
		{"task": strings.Repeat("é", server.MaxDelegationTaskBytes/2+1)},
		{"task": "t", "context": strings.Repeat("x", server.MaxDelegationContextBytes+1)},
	} {
		result, err := session.CallTool(context.Background(), &mcp.CallToolParams{Name: DelegateTool, Arguments: arguments})
		if err == nil && !result.IsError {
			t.Fatalf("accepted %v", arguments)
		}
	}
	if daemon.count() != 0 {
		t.Fatalf("daemon called %d times", daemon.count())
	}
}

func TestDelegateCancellationReachesTheDaemonAndIsNotRetried(t *testing.T) {
	started := make(chan struct{})
	var canceled atomic.Bool
	daemon := &fakeDaemon{respond: func(r *http.Request) (*http.Response, error) {
		close(started)
		<-r.Context().Done()
		canceled.Store(true)
		return nil, r.Context().Err()
	}}
	session := connect(t, daemon, "")
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		_, err := session.CallTool(ctx, &mcp.CallToolParams{Name: DelegateTool, Arguments: map[string]any{"task": "t"}})
		done <- err
	}()
	<-started
	cancel() // the SDK client sends notifications/cancelled
	if err := <-done; err == nil {
		t.Fatal("canceled call returned success")
	}
	deadline := time.Now().Add(5 * time.Second)
	for !canceled.Load() && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if !canceled.Load() || daemon.count() != 1 {
		t.Fatalf("daemon request not canceled once: canceled=%t attempts=%d", canceled.Load(), daemon.count())
	}
}

func TestListModelsIsFreeFilteredAndBounded(t *testing.T) {
	var models []string
	for _, id := range []string{"openai/gpt-x", "openai/gpt-x:online", "anthropic/claude-y", "bad id", "zero/budget"} {
		budget := 1500000
		if id == "zero/budget" {
			budget = 0
		}
		raw, _ := json.Marshal(map[string]any{"id": id, "oa_request_limit_micro_usd": budget})
		models = append(models, string(raw))
	}
	for i := range 150 {
		models = append(models, `{"id":"bulk/model-`+string(rune('a'+i%26))+strings.Repeat("x", i)+`","oa_request_limit_micro_usd":1000000}`)
	}
	daemon := &fakeDaemon{respond: func(r *http.Request) (*http.Response, error) {
		return jsonResponse(r, 200, `{"object":"list","data":[`+strings.Join(models, ",")+`]}`)
	}}
	session := connect(t, daemon, "openai/gpt-x")
	result, err := session.CallTool(context.Background(), &mcp.CallToolParams{Name: ListModelsTool, Arguments: map[string]any{"search": "OPENAI"}})
	if err != nil || result.IsError {
		t.Fatalf("err=%v %+v", err, result)
	}
	text := resultText(result)
	if !strings.Contains(text, "Saved default model: openai/gpt-x") || !strings.Contains(text, "openai/gpt-x  cap $1.5") || strings.Contains(text, ":online") || strings.Contains(text, "anthropic") {
		t.Fatalf("text = %q", text)
	}
	result, err = session.CallTool(context.Background(), &mcp.CallToolParams{Name: ListModelsTool, Arguments: map[string]any{}})
	if err != nil || result.IsError {
		t.Fatal(err)
	}
	var output ListModelsOutput
	raw, _ := json.Marshal(result.StructuredContent)
	if json.Unmarshal(raw, &output) != nil || len(output.Models) != maxListed || !output.Truncated || output.Matched != 152 {
		t.Fatalf("output = %+v", output)
	}
	for _, r := range daemon.requests {
		if r.Method != http.MethodGet || r.URL.Path != "/v1/models" {
			t.Fatalf("discovery made %s %s", r.Method, r.URL.Path)
		}
	}
}

func TestDaemonAddressMustBeNumericLoopback(t *testing.T) {
	for _, listen := range []string{"localhost:43133", "10.0.0.1:43133", "0.0.0.0:43133", "127.0.0.1", "127.0.0.1:0", "[::1]:99999", "example.com:80"} {
		if _, err := NewServer(Options{Listen: listen, APIKey: testAPIKey}); err == nil {
			t.Fatalf("accepted %s", listen)
		}
	}
	for _, listen := range []string{"127.0.0.1:43133", "[::1]:43133"} {
		if _, err := NewServer(Options{Listen: listen, APIKey: testAPIKey}); err != nil {
			t.Fatalf("rejected %s: %v", listen, err)
		}
	}
}

func TestProductionTransportIgnoresProxiesAndDialsOnlyTheDaemon(t *testing.T) {
	t.Setenv("HTTP_PROXY", "http://192.0.2.1:3128")
	t.Setenv("HTTPS_PROXY", "http://192.0.2.1:3128")
	t.Setenv("ALL_PROXY", "socks5://192.0.2.1:1080")
	d, err := newDaemon("127.0.0.1:43133", testAPIKey, nil)
	if err != nil {
		t.Fatal(err)
	}
	transport := d.client.Transport.(*http.Transport)
	if transport.Proxy != nil || !transport.DisableKeepAlives || d.client.Jar != nil {
		t.Fatal("transport may use a proxy, cookies or keep-alives")
	}
	// The dialer ignores the requested address: a URL can never steer it.
	conn, err := transport.DialContext(context.Background(), "tcp", "example.com:80")
	if conn != nil {
		conn.Close()
	}
	if err == nil || !strings.Contains(err.Error(), "127.0.0.1:43133") {
		t.Fatalf("dial was not pinned to the daemon: %v", err)
	}
}

// rawSession speaks newline-delimited JSON-RPC to the server, as a host
// implementing an older protocol revision would.
func rawSession(t *testing.T) (func(string), func() map[string]any) {
	t.Helper()
	s, err := NewServer(Options{Listen: "127.0.0.1:43133", APIKey: testAPIKey, Transport: &fakeDaemon{}})
	if err != nil {
		t.Fatal(err)
	}
	inReader, inWriter := io.Pipe()
	outReader, outWriter := io.Pipe()
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(func() { cancel(); inWriter.Close(); outReader.Close() })
	go func() {
		_ = s.Run(ctx, &mcp.IOTransport{Reader: inReader, Writer: outWriter, MaxLineLength: MaxFrameBytes})
	}()
	lines := bufio.NewScanner(outReader)
	lines.Buffer(make([]byte, 1<<20), MaxFrameBytes)
	send := func(frame string) {
		if _, err := io.WriteString(inWriter, frame+"\n"); err != nil {
			t.Fatal(err)
		}
	}
	receive := func() map[string]any {
		if !lines.Scan() {
			t.Fatal("no response frame")
		}
		var frame map[string]any
		if err := json.Unmarshal(lines.Bytes(), &frame); err != nil || frame["jsonrpc"] != "2.0" {
			t.Fatalf("non-JSON-RPC output: %q", lines.Text())
		}
		return frame
	}
	return send, receive
}

func TestProtocolVersionNegotiation(t *testing.T) {
	for requested, want := range map[string]string{
		"2024-11-05": "2024-11-05",
		"2025-03-26": "2025-03-26",
		"2025-06-18": "2025-06-18",
		"2025-11-25": "2025-11-25",
		"2099-01-01": "2025-11-25", // unknown future revision: answer with a supported one
	} {
		t.Run(requested, func(t *testing.T) {
			send, receive := rawSession(t)
			send(`{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"` + requested + `","capabilities":{},"clientInfo":{"name":"raw","version":"0"}}}`)
			response := receive()
			result, _ := response["result"].(map[string]any)
			if result == nil || result["protocolVersion"] != want {
				t.Fatalf("response = %v", response)
			}
			capabilities, _ := result["capabilities"].(map[string]any)
			if _, ok := capabilities["tools"]; !ok || len(capabilities) != 1 {
				t.Fatalf("capabilities = %v", capabilities)
			}
			send(`{"jsonrpc":"2.0","method":"notifications/initialized"}`)
			send(`{"jsonrpc":"2.0","id":2,"method":"tools/list"}`)
			list := receive()
			tools, _ := list["result"].(map[string]any)["tools"].([]any)
			if len(tools) != 2 {
				t.Fatalf("tools/list = %v", list)
			}
		})
	}
}

type brokenReader struct{}

func (brokenReader) Read([]byte) (int, error) { return 0, errors.New("unexpected EOF") }
