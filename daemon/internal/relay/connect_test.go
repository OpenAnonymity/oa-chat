package relay

import (
	"bufio"
	"context"
	"crypto/x509"
	"encoding/base64"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestDirectCompanionBridgeRejectsPlaintext(t *testing.T) {
	proxy, err := StartConnectProxy(context.Background(), "")
	if err != nil {
		t.Fatal(err)
	}
	defer proxy.Close()
	proxyURL, err := url.Parse(proxy.URL)
	if err != nil {
		t.Fatal("invalid local proxy URL")
	}
	client := &http.Client{Transport: &http.Transport{Proxy: http.ProxyURL(proxyURL)}, Timeout: 5 * time.Second}
	defer client.CloseIdleConnections()
	response, err := client.Get("http://destination.invalid/proof")
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != http.StatusMethodNotAllowed {
		t.Fatal("direct bridge allowed plaintext HTTP")
	}
}

func TestDirectCompanionTLSAndDowngradeRejection(t *testing.T) {
	var plaintextHits atomic.Int32
	plaintext := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { plaintextHits.Add(1) }))
	defer plaintext.Close()
	origin := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/redirect" {
			http.Redirect(w, r, plaintext.URL, http.StatusTemporaryRedirect)
			return
		}
		_, _ = io.WriteString(w, "TLS response")
	}))
	defer origin.Close()
	dialContext, err := destinationDialer("")
	if err != nil {
		t.Fatal(err)
	}
	auth := "Basic " + base64.StdEncoding.EncodeToString([]byte("oa:test-password"))
	proxy := httptest.NewServer(connectHandler(context.Background(), auth, func(ctx context.Context, target string) (net.Conn, error) {
		if target != "example.com:443" {
			t.Errorf("unexpected target %s", target)
		}
		return dialContext(ctx, "tcp", origin.Listener.Addr().String())
	}))
	defer proxy.Close()
	proxyURL, _ := url.Parse(proxy.URL)
	proxyURL.User = url.UserPassword("oa", "test-password")
	pool := x509.NewCertPool()
	pool.AddCert(origin.Certificate())
	transport := origin.Client().Transport.(*http.Transport).Clone()
	transport.TLSClientConfig.RootCAs = pool
	transport.Proxy = http.ProxyURL(proxyURL)
	// Like the companion's reqwest default clients, this client follows redirects.
	client := &http.Client{Transport: transport, Timeout: 5 * time.Second}
	defer client.CloseIdleConnections()
	response, err := client.Get("https://example.com/")
	if err != nil {
		t.Fatal(err)
	}
	body, err := io.ReadAll(response.Body)
	response.Body.Close()
	if err != nil || string(body) != "TLS response" {
		t.Fatalf("direct companion TLS failed: %q, %v", body, err)
	}
	response, err = client.Post("https://example.com/redirect", "application/json", strings.NewReader(`{"proof":"private"}`))
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != http.StatusMethodNotAllowed || plaintextHits.Load() != 0 {
		t.Fatal("companion bridge allowed a plaintext redirect")
	}
}

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
