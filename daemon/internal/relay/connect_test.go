package relay

import (
	"bufio"
	"context"
	"encoding/base64"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestCompanionCONNECTAuthenticationTargetsAndShutdown(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	var dials atomic.Int32
	auth := "Basic " + base64.StdEncoding.EncodeToString([]byte("oa:private-local-proxy-token"))
	proxy := httptest.NewServer(connectHandler(ctx, auth, func(ctx context.Context, target string) (net.Conn, error) {
		dials.Add(1)
		if target != "provider.example:443" {
			t.Errorf("unexpected target %s", target)
		}
		left, right := net.Pipe()
		go func() { defer right.Close(); _, _ = io.Copy(right, right) }()
		return left, nil
	}))
	defer proxy.Close()
	for _, tc := range []struct {
		method, target, authorization string
		status                        int
	}{
		{"CONNECT", "provider.example:443", "", 407},
		{"GET", "provider.example:443", auth, 405},
		{"CONNECT", "127.0.0.1:443", auth, 403},
		{"CONNECT", "provider.example:80", auth, 400},
	} {
		conn, err := net.Dial("tcp", strings.TrimPrefix(proxy.URL, "http://"))
		if err != nil {
			t.Fatal(err)
		}
		_, _ = io.WriteString(conn, tc.method+" "+tc.target+" HTTP/1.1\r\nHost: "+tc.target+"\r\nProxy-Authorization: "+tc.authorization+"\r\n\r\n")
		resp, err := http.ReadResponse(bufio.NewReader(conn), nil)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		conn.Close()
		if resp.StatusCode != tc.status {
			t.Fatalf("status %d want %d", resp.StatusCode, tc.status)
		}
	}
	if dials.Load() != 0 {
		t.Fatal("unauthorized target reached relay")
	}
	conn, err := net.Dial("tcp", strings.TrimPrefix(proxy.URL, "http://"))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(3 * time.Second))
	_, _ = io.WriteString(conn, "CONNECT provider.example:443 HTTP/1.1\r\nHost: provider.example:443\r\nProxy-Authorization: "+auth+"\r\n\r\n")
	reader := bufio.NewReader(conn)
	resp, err := http.ReadResponse(reader, nil)
	if err != nil || resp.StatusCode != 200 {
		t.Fatal("CONNECT failed", err)
	}
	_, _ = conn.Write([]byte("TLS-bytes"))
	out := make([]byte, 9)
	if _, err := io.ReadFull(reader, out); err != nil || string(out) != "TLS-bytes" {
		t.Fatal("tunnel did not pass bytes", err)
	}
	cancel()
	if _, err := reader.ReadByte(); err == nil {
		t.Fatal("tunnel not closed on daemon shutdown")
	}
}
