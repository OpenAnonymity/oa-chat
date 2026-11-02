// Package oatest holds in-memory test doubles. A handler answers requests with no
// listener, so these tests also run where binding a local port is not allowed.
package oatest

import (
	"bytes"
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/sha512"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/asn1"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

// Transport serves requests through an http.Handler in process.
type Transport struct{ Handler http.Handler }

func (t Transport) RoundTrip(r *http.Request) (*http.Response, error) {
	body := []byte{}
	if r.Body != nil {
		body, _ = io.ReadAll(r.Body)
	}
	inner := r.Clone(r.Context())
	inner.Body = io.NopCloser(bytes.NewReader(body))
	inner.RequestURI = r.URL.RequestURI()
	recorder := httptest.NewRecorder()
	t.Handler.ServeHTTP(recorder, inner)
	if err := r.Context().Err(); err != nil {
		return nil, err
	}
	response := recorder.Result()
	response.Request = r
	return response, nil
}

// PrivateDir returns a directory the strict profile checks accept.
func PrivateDir(t testing.TB) string {
	t.Helper()
	dir := filepath.Join(t.TempDir(), "profile")
	if err := os.Mkdir(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	return dir
}

// Client returns an HTTP client bound to a handler.
func Client(handler http.Handler) *http.Client {
	return &http.Client{Transport: Transport{Handler: handler}}
}

const issuerName = "if you found this, email hi@openanonymity.ai with code OA-BLIND-2026 -- we need you :D"

// Issuer signs real RFC 9578 tokens with a throwaway 2048-bit key.
type Issuer struct {
	Key     *rsa.PrivateKey
	Encoded string
	KeyID   string
	raw     []byte
}

// NewIssuer generates a key encoded as the org publishes it.
func NewIssuer(t testing.TB) *Issuer {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	der, err := asn1.Marshal(struct {
		Algorithm pkix.AlgorithmIdentifier
		PublicKey asn1.BitString
	}{
		pkix.AlgorithmIdentifier{Algorithm: asn1.ObjectIdentifier{1, 2, 840, 113549, 1, 1, 1}, Parameters: asn1.RawValue{Tag: 5}},
		asn1.BitString{Bytes: x509.MarshalPKCS1PublicKey(&key.PublicKey), BitLength: 8 * len(x509.MarshalPKCS1PublicKey(&key.PublicKey))},
	})
	if err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(der)
	return &Issuer{Key: key, Encoded: base64.URLEncoding.EncodeToString(der), KeyID: hex.EncodeToString(sum[:]), raw: sum[:]}
}

// Token mints a finalized ticket.
func (i *Issuer) Token(t testing.TB) string {
	t.Helper()
	input := make([]byte, 98)
	binary.BigEndian.PutUint16(input, 2)
	if _, err := rand.Read(input[2:34]); err != nil {
		t.Fatal(err)
	}
	challenge := make([]byte, 4+len(issuerName)+3)
	binary.BigEndian.PutUint16(challenge, 2)
	binary.BigEndian.PutUint16(challenge[2:], uint16(len(issuerName)))
	copy(challenge[4:], issuerName)
	digest := sha256.Sum256(challenge)
	copy(input[34:66], digest[:])
	copy(input[66:], i.raw)
	hash := sha512.Sum384(input)
	signature, err := rsa.SignPSS(rand.Reader, i.Key, crypto.SHA384, hash[:], &rsa.PSSOptions{SaltLength: 48, Hash: crypto.SHA384})
	if err != nil {
		t.Fatal(err)
	}
	return base64.URLEncoding.EncodeToString(append(input, signature...))
}
