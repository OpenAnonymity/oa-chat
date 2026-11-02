package relay

import (
	"context"
	"io"
	"net"
	"os"
	"strings"
	"testing"
	"time"
)

func TestSOCKS5SendsDestinationNameToProxyAndFailsClosed(t *testing.T) {
	proxy, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	seen := make(chan string, 1)
	go func() {
		conn, err := proxy.Accept()
		if err != nil {
			return
		}
		defer conn.Close()
		_ = conn.SetDeadline(time.Now().Add(5 * time.Second))
		greeting := make([]byte, 3)
		if _, err := io.ReadFull(conn, greeting); err != nil || string(greeting) != string([]byte{5, 1, 0}) {
			seen <- "invalid greeting"
			return
		}
		_, _ = conn.Write([]byte{5, 0})
		header := make([]byte, 5)
		if _, err := io.ReadFull(conn, header); err != nil || string(header[:4]) != string([]byte{5, 1, 0, 3}) {
			seen <- "invalid connect request"
			return
		}
		nameAndPort := make([]byte, int(header[4])+2)
		if _, err := io.ReadFull(conn, nameAndPort); err != nil {
			seen <- "truncated destination"
			return
		}
		seen <- string(nameAndPort[:len(nameAndPort)-2])
		_, _ = conn.Write([]byte{5, 0, 0, 1, 127, 0, 0, 1, 0, 0})
		_, _ = conn.Write([]byte("connected"))
	}()
	endpoint := "socks5://" + proxy.Addr().String()
	dial, err := destinationDialer(endpoint)
	if err != nil {
		t.Fatal(err)
	}
	conn, err := dial(context.Background(), "tcp", "unresolved.example.invalid:443")
	if err != nil {
		t.Fatal(err)
	}
	data := make([]byte, len("connected"))
	if _, err := io.ReadFull(conn, data); err != nil || string(data) != "connected" {
		t.Fatalf("SOCKS5 connection unusable: %q, %v", data, err)
	}
	conn.Close()
	if name := <-seen; name != "unresolved.example.invalid" {
		t.Fatalf("destination DNS did not stay with proxy: %q", name)
	}
	proxy.Close()
	if conn, err := dial(context.Background(), "tcp", "unresolved.example.invalid:443"); err == nil {
		conn.Close()
		t.Fatal("proxy outage fell back to direct TCP")
	}
}

func TestSOCKS5RequiresLoopbackProxy(t *testing.T) {
	for _, endpoint := range []string{"socks5://example.com:9050", "socks5://127.0.0.1", "socks5://127.0.0.1:0", "socks5://user:pass@127.0.0.1:9050", "socks5://127.0.0.1:9050/path", "socks5://127.0.0.1:9050/?x=1"} {
		if _, err := NewClient(endpoint); err == nil {
			t.Fatalf("accepted unsafe SOCKS5 endpoint %q", endpoint)
		}
	}
}

func TestLiveTorSOCKS5(t *testing.T) {
	endpoint := os.Getenv("ZKAPI_LIVE_TOR_SOCKS5")
	if endpoint == "" {
		t.Skip("set ZKAPI_LIVE_TOR_SOCKS5 for a live Tor check")
	}
	client, err := NewClient(endpoint)
	if err != nil {
		t.Fatal(err)
	}
	client.Timeout = 45 * time.Second
	response, err := client.Get("https://check.torproject.org/api/ip")
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	body, err := io.ReadAll(io.LimitReader(response.Body, 1024))
	if err != nil || response.StatusCode != 200 || !strings.Contains(string(body), `"IsTor":true`) {
		t.Fatalf("Tor check failed: status=%d body=%q err=%v", response.StatusCode, body, err)
	}
}
