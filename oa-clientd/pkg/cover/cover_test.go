package cover

import (
	"context"
	"io"
	"math"
	"net"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

type transportFunc func(*http.Request) (*http.Response, error)

func (f transportFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }
func settings() Config                                                    { return Config{Rate: 5, Concurrency: 2, URLs: "https://cover.example/static"} }

func TestValidation(t *testing.T) {
	good := settings()
	if err := good.Validate("tor://127.0.0.1:9050"); err != nil {
		t.Fatal(err)
	}
	for _, route := range []string{"", "socks5://127.0.0.1:9050", "wss://relay.example", "tor://remote.example:9050"} {
		if good.Validate(route) == nil {
			t.Fatal("accepted unsafe route")
		}
	}
	for _, url := range []string{"http://example.com", "https://user:password@example.com", "https://example.com?key=secret", "https://example.com?", "https://example.com/#x", "https://example.com:8443", "https://127.0.0.1", "https://10.0.0.1", "https://[::1]", "https://localhost", "https://box.local", "https://localhost.", ""} {
		c := good
		c.URLs = url
		if c.Validate("tor://127.0.0.1:9050") == nil {
			t.Fatal("accepted unsafe destination", url)
		}
	}
	for _, rate := range []float64{-1, 0, 0.001, 6, math.Inf(1), math.NaN()} {
		c := good
		c.Rate = rate
		if c.Validate("tor://127.0.0.1:9050") == nil {
			t.Fatal("accepted invalid rate")
		}
	}
	for _, n := range []int{0, 9} {
		c := good
		c.Concurrency = n
		if c.Validate("tor://127.0.0.1:9050") == nil {
			t.Fatal("invalid concurrency")
		}
	}
	if (Config{}).Validate("") != nil {
		t.Fatal("disabled config needs route")
	}
}

func TestSaturationDropsAndShutdownJoinsWorkers(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	var active, peak atomic.Int32
	started := make(chan struct{}, 2)
	client := &http.Client{Transport: transportFunc(func(req *http.Request) (*http.Response, error) {
		n := active.Add(1)
		defer active.Add(-1)
		for {
			old := peak.Load()
			if n <= old || peak.CompareAndSwap(old, n) {
				break
			}
		}
		started <- struct{}{}
		<-req.Context().Done()
		return nil, req.Context().Err()
	})}
	r := &Runner{}
	done := make(chan struct{})
	go func() {
		defer close(done)
		r.run(ctx, settings(), client, []string{"cover-one", "cover-two"}, func() float64 { return 0.001 })
	}()
	for range 2 {
		select {
		case <-started:
		case <-time.After(2 * time.Second):
			t.Fatal("worker did not start")
		}
	}
	deadline := time.Now().Add(time.Second)
	for r.Stats().Skipped < 2 && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	cancel()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("shutdown did not cancel/join")
	}
	if active.Load() != 0 || peak.Load() != 2 || r.Stats().Attempted != 2 || r.Stats().Skipped < 2 {
		t.Fatal("unbounded or unjoined jobs", r.Stats(), peak.Load())
	}
}

func TestFetchBoundedAndCredentialFree(t *testing.T) {
	for _, size := range []int{16, ResponseLimit, ResponseLimit + 100} {
		client := &http.Client{Transport: transportFunc(func(r *http.Request) (*http.Response, error) {
			if r.Method != "GET" || r.Body != nil || r.Header.Get("Authorization") != "" || r.Header.Get("Cookie") != "" || r.Header.Get("Referer") != "" {
				t.Error("cover disclosed state or sent data")
			}
			return &http.Response{StatusCode: 200, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(strings.Repeat("x", size)))}, nil
		})}
		n, ok := fetch(context.Background(), client, "https://cover.example/static")
		if n > ResponseLimit+1 || ok != (size <= ResponseLimit) {
			t.Fatal("response limit not enforced", n, ok)
		}
	}
}

func TestStartRejectsSOCKSAuthenticationDowngrade(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	greeting := make(chan [3]byte, 1)
	go func() {
		conn, err := listener.Accept()
		if err != nil {
			return
		}
		defer conn.Close()
		conn.SetDeadline(time.Now().Add(2 * time.Second))
		var b [3]byte
		io.ReadFull(conn, b[:])
		greeting <- b
		conn.Write([]byte{5, 0})
	}()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	r, err := Start(ctx, settings(), "tor://"+listener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close()
	select {
	case g := <-greeting:
		if g != [3]byte{5, 1, 2} {
			t.Fatal("no required SOCKS authentication")
		}
	case <-ctx.Done():
		t.Fatal("no cover traffic")
	}
	deadline := time.Now().Add(time.Second)
	for r.Stats().Failed == 0 && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if r.Stats().Succeeded != 0 || r.Stats().Failed == 0 {
		t.Fatal("downgrade succeeded", r.Stats())
	}
}

func TestPoissonGaps(t *testing.T) {
	var total float64
	const n = 10000
	for i := range n {
		total += gap(2, (float64(i)+0.5)/n).Seconds()
	}
	if math.Abs(total/n-0.5) > 0.001 {
		t.Fatal("incorrect exponential mean", total/n)
	}
	if gap(2, 0.1) == gap(2, 0.9) {
		t.Fatal("fixed cadence")
	}
}
