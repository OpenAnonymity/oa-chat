package relay

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"strings"
)

// Tor mode uses SOCKS authentication isolation, not global SIGNAL NEWNYM.
// The SOCKS port must be configured with IsolateSOCKSAuth. Tor can replace a
// circuit and can choose the same exit for different isolation identities.
func IsTor(endpoint string) bool { return strings.HasPrefix(strings.ToLower(endpoint), "tor://") }

type torIdentityKey struct{}

func NewTorIdentity() (string, error) {
	var entropy [32]byte
	if _, err := rand.Read(entropy[:]); err != nil {
		return "", err
	}
	return hex.EncodeToString(entropy[:]), nil
}

// WithTorIdentity scopes only this request's network dials. No identity is
// sent in HTTP headers, and payment/companion traffic never inherits it.
func WithTorIdentity(ctx context.Context, identity string) context.Context {
	return context.WithValue(ctx, torIdentityKey{}, identity)
}

// TorIdentity reports the isolation identity scoped to ctx, if any. It lets
// callers and tests confirm which identity a request carries; it never
// creates one.
func TorIdentity(ctx context.Context) string {
	identity, _ := ctx.Value(torIdentityKey{}).(string)
	return identity
}
