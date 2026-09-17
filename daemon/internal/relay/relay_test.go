package relay

import (
	"context"
	"crypto/x509"
	"encoding/binary"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"
)

// A wire-level fixture forwards the exact destination byte stream. Its only
// plaintext inputs are Wisp destination metadata; the HTTP remains inside TLS.
func fixtureRelay(t *testing.T, destination string, packets *atomic.Int32) *httptest.Server {
	t.Helper()
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ws, err := websocket.Accept(w, r, &websocket.AcceptOptions{})
		if err != nil {
			return
		}
		defer ws.CloseNow()
		ws.SetReadLimit(1 << 20)
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		credit := make([]byte, 4)
		binary.LittleEndian.PutUint32(credit, 1)
		if ws.Write(ctx, websocket.MessageBinary, packet(3, 0, credit)) != nil {
			return
		}
		_, hello, err := ws.Read(ctx)
		if err != nil || len(hello) < 8 || hello[0] != 1 {
			return
		}
		if string(hello[8:]) != "127.0.0.1" {
			t.Error("destination hostname missing")
		}
		conn, err := net.Dial("tcp", destination)
		if err != nil {
			return
		}
		defer conn.Close()
		go func() {
			b := make([]byte, 4096)
			for {
				n, err := conn.Read(b)
				if n > 0 {
					if ws.Write(ctx, websocket.MessageBinary, packet(2, 1, b[:n])) != nil {
						return
					}
				}
				if err != nil {
					_ = ws.Write(ctx, websocket.MessageBinary, packet(4, 1, []byte{2}))
					return
				}
			}
		}()
		for {
			_, b, err := ws.Read(ctx)
			if err != nil {
				return
			}
			if len(b) < 5 || b[0] != 2 {
				return
			}
			packets.Add(1)
			if strings.Contains(string(b[5:]), "private-prompt") {
				t.Error("relay saw plaintext HTTP")
			}
			if _, err := conn.Write(b[5:]); err != nil {
				return
			}
			// A one-packet window forces the client to obey CONTINUE.
			if ws.Write(ctx, websocket.MessageBinary, packet(3, 1, credit)) != nil {
				return
			}
		}
	}))
	t.Cleanup(s.Close)
	return s
}

func TestTLSOverWispFlowControlAndStreaming(t *testing.T) {
	origin := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		if len(body) != 96*1024 {
			t.Errorf("body lost: %d", len(body))
		}
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = w.Write([]byte("data: first\n\n"))
		w.(http.Flusher).Flush()
		_, _ = w.Write([]byte("data: [DONE]\n\n"))
	}))
	defer origin.Close()
	var count atomic.Int32
	relay := fixtureRelay(t, origin.Listener.Addr().String(), &count)
	client, err := NewClient("ws" + strings.TrimPrefix(relay.URL, "http"))
	if err != nil {
		t.Fatal(err)
	}
	pool := x509.NewCertPool()
	pool.AddCert(origin.Certificate())
	client.Transport.(httpsOnly).base.(*http.Transport).TLSClientConfig.RootCAs = pool
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	r, _ := http.NewRequestWithContext(ctx, "POST", origin.URL, strings.NewReader(strings.Repeat("private-prompt", 8192)[:96*1024]))
	resp, err := client.Do(r)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil || !strings.Contains(string(body), "[DONE]") {
		t.Fatalf("stream failed %s %v", body, err)
	}
	if count.Load() < 6 {
		t.Fatalf("flow control not exercised: %d", count.Load())
	}
}

func TestRejectsUntrustedDestinationCertificate(t *testing.T) {
	origin := httptest.NewTLSServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { t.Error("untrusted request reached HTTP") }))
	defer origin.Close()
	var count atomic.Int32
	relay := fixtureRelay(t, origin.Listener.Addr().String(), &count)
	client, _ := NewClient("ws" + strings.TrimPrefix(relay.URL, "http"))
	client.Timeout = 5 * time.Second
	if resp, err := client.Get(origin.URL); err == nil {
		resp.Body.Close()
		t.Fatal("untrusted certificate accepted")
	}
}

func TestNoPlaintextOrDirectFallback(t *testing.T) {
	hits := atomic.Int32{}
	destination := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { hits.Add(1) }))
	defer destination.Close()
	client, _ := NewClient("ws://127.0.0.1:1/")
	client.Timeout = time.Second
	for _, target := range []string{destination.URL, "https" + strings.TrimPrefix(destination.URL, "http")} {
		if resp, err := client.Get(target); err == nil {
			resp.Body.Close()
			t.Fatal("unexpected direct fallback")
		}
	}
	if hits.Load() != 0 {
		t.Fatal("destination contacted directly")
	}
}

func TestLivePublicRelay(t *testing.T) {
	if os.Getenv("OA_LIVE_RELAY_TEST") != "1" {
		t.Skip("set OA_LIVE_RELAY_TEST=1 for public relay check")
	}
	endpoint := os.Getenv("OA_LIVE_RELAY_URL")
	if endpoint == "" {
		endpoint = DefaultURL
	}
	c, err := NewClient(endpoint)
	if err != nil {
		t.Fatal(err)
	}
	c.Timeout = 30 * time.Second
	resp, err := c.Get("https://openrouter.ai/api/v1/models")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	n, err := io.Copy(io.Discard, resp.Body)
	if err != nil || resp.StatusCode != 200 || n < 100 {
		t.Fatalf("public relay check status=%s bytes=%s err=%v", resp.Status, strconv.FormatInt(n, 10), err)
	}
	t.Logf("public relay TLS request returned HTTP %d (%d bytes)", resp.StatusCode, n)
}
