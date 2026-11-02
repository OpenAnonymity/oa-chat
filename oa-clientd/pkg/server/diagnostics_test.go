package server

import (
	"bytes"
	"context"
	"log"
	"strings"
	"testing"

	"github.com/OpenAnonymity/oa-chat/oa-clientd/pkg/activity"
)

func TestDiagnosticsSSEAndUnicode(t *testing.T) {
	var out bytes.Buffer
	ctx := activity.WithDiagnostics(context.Background(), activity.SemiVerbose, log.New(&out, "", 0))
	d := newResponseDiagnostic(ctx, true)
	data := "data: {\"choices\":[{\"delta\":{\"content\":\"你好\"}}]}\n\ndata: {\"choices\":[{\"delta\":{\"content\":\" world\\n\"}}]}\n\ndata: [DONE]\n\n"
	for _, b := range []byte(data) {
		d.add([]byte{b})
	}
	d.finish(true)
	if !strings.Contains(out.String(), `你好 world\n`) || !strings.Contains(out.String(), "(9 chars)") || strings.Count(out.String(), "\n") != 1 {
		t.Fatal(out.String())
	}
}

func TestDiagnosticPromptPreviewAndNoDefaultCapture(t *testing.T) {
	var out bytes.Buffer
	ctx := activity.WithDiagnostics(context.Background(), activity.SemiVerbose, log.New(&out, "", 0))
	promptDiagnostic(ctx, []byte(`{"messages":[{"role":"user","content":"hello\nworld"}],"extra_headers":{"Authorization":"secret"}}`))
	if !strings.Contains(out.String(), `"hello\nworld" (11 chars)`) || strings.Contains(out.String(), "secret") {
		t.Fatal(out.String())
	}
	if newResponseDiagnostic(context.Background(), true) != nil {
		t.Fatal("normal mode captures response")
	}
}

func TestVerboseEscapesTerminalAndHandlesJSONTools(t *testing.T) {
	var out bytes.Buffer
	ctx := activity.WithDiagnostics(context.Background(), activity.Verbose, log.New(&out, "", 0))
	promptDiagnostic(ctx, []byte(`{"messages":[{"role":"user\nescape","content":"\u001b[31mprivate"}]}`))
	d := newResponseDiagnostic(ctx, false)
	d.add([]byte(`{"choices":[{"message":{"content":null,"tool_calls":[{"function":{"name":"test","arguments":"{}"}}]}}]}`))
	d.finish(true)
	if strings.Contains(out.String(), "\x1b") || strings.Contains(out.String(), "user\nescape") || !strings.Contains(out.String(), "test") {
		t.Fatal(out.String())
	}
}

func TestOversizeDiagnosticDoesNotBufferUnbounded(t *testing.T) {
	var out bytes.Buffer
	ctx := activity.WithDiagnostics(context.Background(), activity.SemiVerbose, log.New(&out, "", 0))
	for _, streaming := range []bool{false, true} {
		d := newResponseDiagnostic(ctx, streaming)
		d.add(bytes.Repeat([]byte{'x'}, diagnosticRecordLimit+1))
		if len(d.pending) > diagnosticRecordLimit {
			t.Fatal("unbounded capture")
		}
		d.add([]byte("\ndata: {\"choices\":[{\"delta\":{\"content\":\"recovered\"}}]}\n"))
		d.finish(false)
	}
	if !strings.Contains(out.String(), "preview_incomplete=true") || !strings.Contains(out.String(), "recovered") {
		t.Fatal(out.String())
	}
}
