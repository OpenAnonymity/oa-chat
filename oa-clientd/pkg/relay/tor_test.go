package relay

import (
	"bytes"
	"context"
	"github.com/OpenAnonymity/oa-chat/oa-clientd/pkg/activity"
	"io"
	"log"
	"net"
	"strings"
	"testing"
	"time"
)

func TestTorAuthenticationIsolation(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	identities := make(chan string, 4)
	failures := make(chan error, 1)
	go func() {
		for range 4 {
			conn, err := listener.Accept()
			if err != nil {
				failures <- err
				return
			}
			err = func() error {
				defer conn.Close()
				conn.SetDeadline(time.Now().Add(5 * time.Second))
				var header [3]byte
				if _, err := io.ReadFull(conn, header[:]); err != nil {
					return err
				}
				if header != [3]byte{5, 1, 2} {
					identities <- "bad greeting"
					return nil
				}
				conn.Write([]byte{5, 2})
				var auth [2]byte
				if _, err := io.ReadFull(conn, auth[:]); err != nil {
					return err
				}
				user := make([]byte, int(auth[1]))
				if _, err := io.ReadFull(conn, user); err != nil {
					return err
				}
				var length [1]byte
				if _, err := io.ReadFull(conn, length[:]); err != nil {
					return err
				}
				if _, err := io.CopyN(io.Discard, conn, int64(length[0])); err != nil {
					return err
				}
				identities <- string(user)
				conn.Write([]byte{1, 0})
				var connect [5]byte
				if _, err := io.ReadFull(conn, connect[:]); err != nil {
					return err
				}
				if connect[3] != 3 {
					identities <- "DNS leaked"
					return nil
				}
				if _, err := io.CopyN(io.Discard, conn, int64(connect[4])+2); err != nil {
					return err
				}
				_, err := conn.Write([]byte{5, 0, 0, 1, 127, 0, 0, 1, 0, 0})
				return err
			}()
			if err != nil {
				failures <- err
				return
			}
		}
	}()
	dial, err := destinationDialer("tor://" + listener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	id, err := NewTorIdentity()
	if err != nil {
		t.Fatal(err)
	}
	var logs bytes.Buffer
	var got []string
	for i := 0; i < 4; i++ {
		ctx, cancel := context.WithTimeout(activity.WithDiagnostics(context.Background(), activity.Verbose, log.New(&logs, "", 0)), 5*time.Second)
		if i < 2 {
			ctx = WithTorIdentity(ctx, id)
		}
		conn, err := dial(ctx, "tcp", "does-not-resolve.invalid:443")
		cancel()
		if err != nil {
			t.Fatal(err)
		}
		conn.Close()
		if strings.Contains(logs.String(), "Tor connection") {
			t.Fatal("successful Tor dial logged", logs.String())
		}
		select {
		case identity := <-identities:
			got = append(got, identity)
		case err := <-failures:
			t.Fatal(err)
		case <-time.After(5 * time.Second):
			t.Fatal("missing SOCKS identity")
		}
	}
	if got[0] != id || got[1] != id || got[2] == id || got[3] == id || got[2] == got[3] || len(got[2]) != 64 {
		t.Fatalf("wrong isolation identities: %v", got)
	}
}

func TestTorRejectsNoAuthDowngrade(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	go func() {
		conn, err := listener.Accept()
		if err != nil {
			return
		}
		defer conn.Close()
		conn.SetDeadline(time.Now().Add(time.Second))
		io.CopyN(io.Discard, conn, 3)
		conn.Write([]byte{5, 0})
	}()
	dial, err := destinationDialer("tor://" + listener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	if conn, err := dial(context.Background(), "tcp", "example.invalid:443"); err == nil {
		conn.Close()
		t.Fatal("accepted unauthenticated Tor connection")
	}
}

func TestTorRequiresLoopbackProxy(t *testing.T) {
	for _, endpoint := range []string{"tor://example.com:9050", "tor://127.0.0.1", "tor://127.0.0.1:0", "tor://u:p@127.0.0.1:9050", "tor://127.0.0.1:9050/path", "tor://127.0.0.1:9050/?x=1"} {
		if _, err := NewClient(endpoint); err == nil {
			t.Fatalf("accepted %s", endpoint)
		}
	}
}
