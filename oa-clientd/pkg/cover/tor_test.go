package cover

import (
	"context"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/OpenAnonymity/oa-chat/oa-clientd/pkg/relay"
)

func TestCoverRemoteDNSIndependentIdentityAndVerifiedTLS(t *testing.T) {
	var httpCalls atomic.Int32
	target := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { httpCalls.Add(1) }))
	defer target.Close()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	identities := make(chan string, 16)
	hosts := make(chan string, 16)
	var wg sync.WaitGroup
	acceptDone := make(chan struct{})
	go func() {
		defer close(acceptDone)
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			wg.Add(1)
			go func() {
				defer wg.Done()
				defer conn.Close()
				conn.SetDeadline(time.Now().Add(3 * time.Second))
				var greeting [3]byte
				if _, err := io.ReadFull(conn, greeting[:]); err != nil || greeting != [3]byte{5, 1, 2} {
					return
				}
				conn.Write([]byte{5, 2})
				var header [2]byte
				if _, err := io.ReadFull(conn, header[:]); err != nil || header[0] != 1 {
					return
				}
				user := make([]byte, int(header[1]))
				if _, err := io.ReadFull(conn, user); err != nil {
					return
				}
				var length [1]byte
				if _, err := io.ReadFull(conn, length[:]); err != nil {
					return
				}
				if _, err := io.CopyN(io.Discard, conn, int64(length[0])); err != nil {
					return
				}
				identities <- string(user)
				conn.Write([]byte{1, 0})
				var request [5]byte
				if _, err := io.ReadFull(conn, request[:]); err != nil || request[3] != 3 {
					return
				}
				host := make([]byte, int(request[4]))
				if _, err := io.ReadFull(conn, host); err != nil {
					return
				}
				if _, err := io.CopyN(io.Discard, conn, 2); err != nil {
					return
				}
				hosts <- string(host)
				upstream, err := net.DialTimeout("tcp", strings.TrimPrefix(target.URL, "https://"), time.Second)
				if err != nil {
					return
				}
				defer upstream.Close()
				upstream.SetDeadline(time.Now().Add(3 * time.Second))
				conn.Write([]byte{5, 0, 0, 1, 127, 0, 0, 1, 0, 0})
				done := make(chan struct{})
				go func() { io.Copy(upstream, conn); upstream.Close(); close(done) }()
				io.Copy(conn, upstream)
				conn.Close()
				<-done
			}()
		}
	}()
	defer func() { listener.Close(); <-acceptDone; wg.Wait() }()
	c := settings()
	c.Concurrency = 1
	parent, cancel := context.WithTimeout(relay.WithTorIdentity(context.Background(), "SECRET-INFERENCE-IDENTITY"), 8*time.Second)
	defer cancel()
	r, err := Start(parent, c, "tor://"+listener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close()
	var first string
	for i := range 2 {
		select {
		case id := <-identities:
			if len(id) != 64 || id == "SECRET-INFERENCE-IDENTITY" {
				t.Fatal("inherited inference identity")
			}
			if i == 0 {
				first = id
			} else if first != id {
				t.Fatal("unnecessary circuit identity churn")
			}
		case <-parent.Done():
			t.Fatal("missing authenticated SOCKS connect")
		}
		select {
		case host := <-hosts:
			if host != "cover.example" {
				t.Fatal("wrong remote DNS name")
			}
		case <-parent.Done():
			t.Fatal("destination locally resolved or not sent")
		}
	}
	r.Close()
	if r.Stats().Succeeded != 0 || r.Stats().Failed == 0 || httpCalls.Load() != 0 {
		t.Fatal("untrusted destination TLS was accepted")
	}
}
