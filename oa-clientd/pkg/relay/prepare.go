package relay

import (
	"context"
	"errors"
	"net"
	"net/url"
	"time"
)

// PrepareTor requests an isolated SOCKS stream while text is being rewritten.
// No HTTP request, prompt or credential is sent. The stream is closed when
// ready; inference later uses the same isolation identity, not a global NEWNYM.
// Tor decides circuit construction/reuse and can replace it before inference.
func PrepareTor(ctx context.Context, endpoint, destination, identity string) error {
	if !IsTor(endpoint) || identity == "" {
		return errors.New("Tor preparation requires an isolation identity")
	}
	dial, err := destinationDialer(endpoint)
	if err != nil {
		return err
	}
	u, err := url.Parse(destination)
	if err != nil || u.Scheme != "https" || u.Hostname() == "" || u.User != nil {
		return errors.New("invalid Tor preparation destination")
	}
	port := u.Port()
	if port == "" {
		port = "443"
	}
	ctx, cancel := context.WithTimeout(WithTorIdentity(ctx, identity), 25*time.Second)
	defer cancel()
	conn, err := dial(ctx, "tcp", net.JoinHostPort(u.Hostname(), port))
	if err != nil {
		return err
	}
	return conn.Close()
}
