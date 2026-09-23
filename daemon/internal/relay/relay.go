// Package relay tunnels destination TLS through OA's Wisp v1 relay. The relay
// resolves destination names and forwards encrypted bytes; it never terminates
// the inner TLS connection. There is deliberately no direct-connect fallback.
package relay

import (
	"context"
	"crypto/tls"
	"encoding/binary"
	"errors"
	"io"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"sync"
	"time"

	"github.com/coder/websocket"
)

// DefaultURL is the same public, shared relay credential as chat/config.js.
const DefaultURL = "wss://oa-1.refraction.network/?secret=1f45ceecf768790c8389ff704612d5cf"

// NewClient creates an HTTPS-only, cookie-free client. One WebSocket per TCP
// connection avoids multiplexing separate inference credentials together.
func NewClient(relayURL string) (*http.Client, error) {
	u, err := url.Parse(relayURL)
	if err != nil || u.User != nil || u.Fragment != "" || u.Hostname() == "" || (u.Scheme != "wss" && !(u.Scheme == "ws" && loopback(u.Hostname()))) {
		return nil, errors.New("relay must use wss (ws is allowed only on loopback)")
	}
	t := &http.Transport{
		DialContext: func(ctx context.Context, network, address string) (net.Conn, error) {
			return dial(ctx, relayURL, address)
		},
		TLSClientConfig:       &tls.Config{MinVersion: tls.VersionTLS12},
		TLSHandshakeTimeout:   20 * time.Second,
		ResponseHeaderTimeout: 3 * time.Minute,
		// Keys are fresh per request, and the provider should not be able to
		// group requests under a persistent TLS connection or session ticket.
		DisableKeepAlives:      true,
		DisableCompression:     true,
		MaxResponseHeaderBytes: 1 << 20,
	}
	return &http.Client{
		Transport:     httpsOnly{t},
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}, nil
}

type httpsOnly struct{ base http.RoundTripper }

func (t httpsOnly) RoundTrip(r *http.Request) (*http.Response, error) {
	if r.URL.Scheme != "https" || r.URL.User != nil {
		return nil, errors.New("anonymous transport requires destination HTTPS")
	}
	return t.base.RoundTrip(r)
}

func loopback(host string) bool {
	return host == "localhost" || (net.ParseIP(host) != nil && net.ParseIP(host).IsLoopback())
}

func packet(kind byte, id uint32, payload []byte) []byte {
	b := make([]byte, 5+len(payload))
	b[0] = kind
	binary.LittleEndian.PutUint32(b[1:], id)
	copy(b[5:], payload)
	return b
}

func dial(ctx context.Context, relayURL, address string) (net.Conn, error) {
	host, port, err := net.SplitHostPort(address)
	if err != nil {
		return nil, errors.New("invalid relay destination")
	}
	p, err := strconv.ParseUint(port, 10, 16)
	if err != nil || p == 0 || len(host) > 253 {
		return nil, errors.New("invalid relay destination")
	}
	dialCtx, cancelDial := context.WithTimeout(ctx, 20*time.Second)
	defer cancelDial()
	// Do not inherit HTTP_PROXY, credentials, or a cookie jar from the user.
	wsHTTP := &http.Client{Transport: &http.Transport{Proxy: nil, TLSClientConfig: &tls.Config{MinVersion: tls.VersionTLS12}}, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	ws, resp, err := websocket.Dial(dialCtx, relayURL, &websocket.DialOptions{HTTPClient: wsHTTP, CompressionMode: websocket.CompressionDisabled})
	if err != nil {
		if resp != nil && resp.Body != nil {
			resp.Body.Close()
		}
		return nil, errors.New("encrypted relay connection failed")
	}
	ws.SetReadLimit(1 << 20)
	kind, initial, err := ws.Read(dialCtx)
	if err != nil || kind != websocket.MessageBinary || len(initial) != 9 || initial[0] != 3 || binary.LittleEndian.Uint32(initial[1:5]) != 0 {
		ws.CloseNow()
		return nil, errors.New("invalid Wisp relay handshake")
	}
	payload := make([]byte, 3+len(host))
	payload[0] = 1 // TCP
	binary.LittleEndian.PutUint16(payload[1:], uint16(p))
	copy(payload[3:], host)
	if err := ws.Write(dialCtx, websocket.MessageBinary, packet(1, 1, payload)); err != nil {
		ws.CloseNow()
		return nil, errors.New("relay stream creation failed")
	}
	local, remote := net.Pipe()
	life, cancel := context.WithCancel(context.Background())
	c := &conn{Conn: local, peer: remote, ws: ws, ctx: life, cancel: cancel, credit: binary.LittleEndian.Uint32(initial[5:]), notify: make(chan struct{}, 1)}
	go c.receive()
	go c.send()
	return c, nil
}

type conn struct {
	net.Conn
	peer   net.Conn
	ws     *websocket.Conn
	ctx    context.Context
	cancel context.CancelFunc
	once   sync.Once
	mu     sync.Mutex
	credit uint32
	notify chan struct{}
}

func (c *conn) Close() error {
	c.shutdown()
	return c.Conn.Close()
}

func (c *conn) shutdown() {
	c.once.Do(func() { c.cancel(); c.ws.CloseNow(); c.peer.Close() })
}

func (c *conn) receive() {
	defer c.shutdown()
	for {
		kind, b, err := c.ws.Read(c.ctx)
		if err != nil || kind != websocket.MessageBinary || len(b) < 5 {
			return
		}
		id := binary.LittleEndian.Uint32(b[1:5])
		if id != 1 {
			return
		}
		switch b[0] {
		case 2:
			if _, err := c.peer.Write(b[5:]); err != nil {
				return
			}
		case 3:
			if len(b) != 9 {
				return
			}
			c.mu.Lock()
			c.credit = binary.LittleEndian.Uint32(b[5:])
			c.mu.Unlock()
			select {
			case c.notify <- struct{}{}:
			default:
			}
		case 4:
			return
		default:
			return
		}
	}
}

func (c *conn) send() {
	defer c.shutdown()
	b := make([]byte, 16*1024)
	for {
		n, err := c.peer.Read(b)
		if n > 0 {
			for {
				c.mu.Lock()
				ready := c.credit > 0
				if ready {
					c.credit--
				}
				c.mu.Unlock()
				if ready {
					break
				}
				select {
				case <-c.notify:
				case <-c.ctx.Done():
					return
				}
			}
			if e := c.ws.Write(c.ctx, websocket.MessageBinary, packet(2, 1, b[:n])); e != nil {
				return
			}
		}
		if err != nil {
			return
		}
	}
}

var _ io.ReadWriteCloser = (*conn)(nil)
