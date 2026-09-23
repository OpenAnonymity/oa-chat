package relay

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"io"
	"log"
	"net"
	"net/http"
	"strings"
	"time"
)

// ConnectProxy lets the Rust prover's HTTPS client use the same encrypted relay
// without porting its proof implementation. It accepts authenticated CONNECT
// only, and neither sees nor terminates the destination's TLS session.
type ConnectProxy struct {
	URL    string // contains a process-local credential; do not log
	server *http.Server
	cancel context.CancelFunc
}

func StartConnectProxy(ctx context.Context, relayURL string) (*ConnectProxy, error) {
	if _, err := NewClient(relayURL); err != nil {
		return nil, err
	}
	secret := make([]byte, 32)
	if _, err := rand.Read(secret); err != nil {
		return nil, err
	}
	password := hex.EncodeToString(secret)
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, err
	}
	life, cancel := context.WithCancel(ctx)
	auth := "Basic " + base64.StdEncoding.EncodeToString([]byte("oa:"+password))
	server := &http.Server{Handler: connectHandler(life, auth, func(ctx context.Context, target string) (net.Conn, error) { return dial(ctx, relayURL, target) }), ReadHeaderTimeout: 10 * time.Second, IdleTimeout: time.Minute, MaxHeaderBytes: 8192, ErrorLog: log.New(io.Discard, "", 0)}
	proxy := &ConnectProxy{URL: "http://oa:" + password + "@" + listener.Addr().String(), server: server, cancel: cancel}
	go func() { _ = server.Serve(listener) }()
	return proxy, nil
}

func (p *ConnectProxy) Close() error { p.cancel(); return p.server.Close() }

func connectHandler(life context.Context, authorization string, dialer func(context.Context, string) (net.Conn, error)) http.Handler {
	expected := sha256.Sum256([]byte(authorization))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		actual := sha256.Sum256([]byte(r.Header.Get("Proxy-Authorization")))
		if subtle.ConstantTimeCompare(actual[:], expected[:]) != 1 || r.Header.Get("Origin") != "" {
			w.Header().Set("Proxy-Authenticate", `Basic realm="OA local prover"`)
			http.Error(w, "Proxy authentication required", 407)
			return
		}
		if r.Method != "CONNECT" {
			http.Error(w, "HTTPS CONNECT required", 405)
			return
		}
		host, port, err := net.SplitHostPort(r.Host)
		if err != nil || port != "443" || len(host) == 0 || len(host) > 253 || strings.ContainsAny(host, "/?#@ \\%\r\n") {
			http.Error(w, "HTTPS destination required", 400)
			return
		}
		if ip := net.ParseIP(host); ip != nil && (ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast() || ip.IsUnspecified()) {
			http.Error(w, "Public destination required", 403)
			return
		}
		if host == "localhost" {
			http.Error(w, "Public destination required", 403)
			return
		}
		upstream, err := dialer(r.Context(), r.Host)
		if err != nil {
			http.Error(w, "Encrypted relay unavailable", 502)
			return
		}
		defer upstream.Close()
		hijacker, ok := w.(http.Hijacker)
		if !ok {
			http.Error(w, "CONNECT unavailable", 500)
			return
		}
		downstream, buffer, err := hijacker.Hijack()
		if err != nil {
			return
		}
		defer downstream.Close()
		stop := context.AfterFunc(life, func() { downstream.Close(); upstream.Close() })
		defer stop()
		_, err = buffer.WriteString("HTTP/1.1 200 Connection Established\r\n\r\n")
		if err != nil {
			return
		}
		if buffer.Flush() != nil {
			return
		}
		done := make(chan struct{})
		go func() { _, _ = io.Copy(upstream, buffer); upstream.Close(); downstream.Close(); close(done) }()
		_, _ = io.Copy(downstream, upstream)
		downstream.Close()
		upstream.Close()
		<-done
	})
}
