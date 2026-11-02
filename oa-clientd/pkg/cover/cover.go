// Package cover provides optional, bounded background HTTPS noise over Tor.
// It does not simulate paid inference or promise resistance to traffic analysis.
package cover

import (
	"context"
	"crypto/rand"
	"encoding/binary"
	"errors"
	"io"
	"math"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/OpenAnonymity/oa-chat/oa-clientd/pkg/relay"
)

const DefaultRate = 5
const DefaultConcurrency = 4
const ResponseLimit = 64 << 10
const RequestTimeout = 20 * time.Second

// URLs are deliberately explicit: use small static resources you control or
// have permission to poll. No public service is opted into load by default.
type Config struct {
	Rate        float64 `json:"rate,omitempty"`
	Concurrency int     `json:"concurrency,omitempty"`
	URLs        string  `json:"urls,omitempty"` // whitespace-separated, deliberately comparable config
}

func (c Config) Enabled() bool { return c.Rate > 0 }
func (c Config) Validate(endpoint string) error {
	if c.Rate == 0 && c.Concurrency == 0 && c.URLs == "" {
		return nil
	}
	if math.IsNaN(c.Rate) || math.IsInf(c.Rate, 0) || c.Rate < 0.01 || c.Rate > 5 {
		return errors.New("cover rate must be between 0.01 and 5 requests/second; clear settings to disable")
	}
	if c.Concurrency < 1 || c.Concurrency > 8 {
		return errors.New("cover concurrency must be between 1 and 8")
	}
	if !relay.IsTor(endpoint) {
		return errors.New("cover traffic requires authenticated tor:// routing; no direct or socks5 fallback")
	}
	client, err := relay.NewClient(endpoint)
	if err != nil {
		return errors.New("invalid cover Tor endpoint")
	}
	client.CloseIdleConnections()
	if len(c.URLs) > 32768 || len(strings.Fields(c.URLs)) < 1 || len(strings.Fields(c.URLs)) > 16 {
		return errors.New("cover requires 1 to 16 explicit HTTPS URLs")
	}
	for _, raw := range strings.Fields(c.URLs) {
		u, err := url.Parse(raw)
		if err != nil || len(raw) > 2048 || u.Scheme != "https" || u.Hostname() == "" || u.User != nil || u.RawQuery != "" || u.ForceQuery || u.Fragment != "" || u.Opaque != "" || (u.Port() != "" && u.Port() != "443") {
			return errors.New("cover URLs must be HTTPS on port 443 without credentials, query or fragment")
		}
		host := strings.ToLower(strings.TrimSuffix(u.Hostname(), "."))
		if host == "localhost" || strings.HasSuffix(host, ".localhost") || strings.HasSuffix(host, ".local") || !strings.Contains(host, ".") {
			return errors.New("cover URLs must name public destinations")
		}
		if ip := net.ParseIP(host); ip != nil && (!ip.IsGlobalUnicast() || ip.IsPrivate() || ip.IsLoopback()) {
			return errors.New("cover URLs must name public destinations")
		}
	}
	return nil
}

type Stats struct{ Attempted, Succeeded, Failed, Skipped, Bytes uint64 }
type Runner struct {
	cancel                                       context.CancelFunc
	done                                         chan struct{}
	attempted, succeeded, failed, skipped, bytes atomic.Uint64
}

func (r *Runner) Stats() Stats {
	return Stats{r.attempted.Load(), r.succeeded.Load(), r.failed.Load(), r.skipped.Load(), r.bytes.Load()}
}
func (r *Runner) Close() { r.cancel(); <-r.done }

// Start creates its own credential-free client and context. It never inherits
// conversation identities, private diagnostics or wallet/inference clients.
func Start(parent context.Context, c Config, endpoint string) (*Runner, error) {
	if err := c.Validate(endpoint); err != nil {
		return nil, err
	}
	if !c.Enabled() {
		return nil, errors.New("cover is disabled")
	}
	client, err := relay.NewClient(endpoint)
	if err != nil {
		return nil, err
	}
	identities := make([]string, c.Concurrency)
	for i := range identities {
		identities[i], err = relay.NewTorIdentity()
		if err != nil {
			return nil, errors.New("cover entropy unavailable")
		}
	}
	// Inherit cancellation only, never values from an inference/diagnostics scope.
	ctx, cancel := context.WithCancel(context.Background())
	stop := context.AfterFunc(parent, cancel)
	if parent.Err() != nil {
		cancel()
	}
	r := &Runner{cancel: cancel, done: make(chan struct{})}
	go func() {
		defer close(r.done)
		defer cancel()
		defer stop()
		defer client.CloseIdleConnections()
		r.run(ctx, c, client, identities, randomUnit)
	}()
	return r, nil
}

func randomUnit() float64 {
	var raw [8]byte
	// crypto/rand.Read terminates on entropy failure; no predictable fallback.
	rand.Read(raw[:])
	return (float64(binary.LittleEndian.Uint64(raw[:])>>12) + 0.5) / (1 << 52)
}
func gap(rate, unit float64) time.Duration {
	d := -math.Log1p(-unit) / rate * float64(time.Second)
	if d < float64(time.Millisecond) {
		d = float64(time.Millisecond)
	}
	return time.Duration(d)
}

func (r *Runner) run(ctx context.Context, c Config, client *http.Client, identities []string, unit func() float64) {
	// A zero-buffer worker queue drops arrivals during saturation. Never spawn
	// additional workers, forget in-flight jobs, or replay a backlog/burst later.
	urls := strings.Fields(c.URLs)
	jobs := make(chan string)
	var wg sync.WaitGroup
	for _, identity := range identities {
		wg.Add(1)
		go func(identity string) {
			defer wg.Done()
			for {
				select {
				case <-ctx.Done():
					return
				case endpoint, ok := <-jobs:
					if !ok || ctx.Err() != nil {
						return
					}
					r.attempted.Add(1)
					n, ok := fetch(relay.WithTorIdentity(ctx, identity), client, endpoint)
					r.bytes.Add(uint64(n))
					if ok {
						r.succeeded.Add(1)
					} else {
						r.failed.Add(1)
					}
				}
			}
		}(identity)
	}
	defer wg.Wait()
	defer close(jobs)
	timer := time.NewTimer(gap(c.Rate, unit()))
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-timer.C:
			if ctx.Err() != nil {
				return
			}
			index := int(unit() * float64(len(urls)))
			if index >= len(urls) {
				index = len(urls) - 1
			}
			select {
			case jobs <- urls[index]:
			default:
				r.skipped.Add(1)
			}
			timer.Reset(gap(c.Rate, unit()))
		}
	}
}

func fetch(ctx context.Context, client *http.Client, endpoint string) (int64, bool) {
	ctx, cancel := context.WithTimeout(ctx, RequestTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return 0, false
	}
	req.Header.Set("User-Agent", "Mozilla/5.0")
	req.Header.Set("Accept", "*/*")
	resp, err := client.Do(req)
	if err != nil {
		return 0, false
	}
	defer resp.Body.Close()
	n, err := io.Copy(io.Discard, io.LimitReader(resp.Body, ResponseLimit+1))
	return n, err == nil && n <= ResponseLimit && resp.StatusCode >= 200 && resp.StatusCode < 300
}
