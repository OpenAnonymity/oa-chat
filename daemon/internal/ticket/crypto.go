package ticket

import (
	"bytes"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/asn1"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"io"

	"github.com/cloudflare/circl/blindsign/blindrsa"
)

// This exact challenge matches the browser, including empty redemption context
// and origin. Never accept a server-provided challenge: it can tag the holder.
const issuerName = "if you found this, email hi@openanonymity.ai with code OA-BLIND-2026 -- we need you :D"

const tokenSize = 2 + 32 + 32 + 32 + 256

type blindState struct {
	Input   []byte `json:"input"`
	Entropy []byte `json:"entropy"`
	Request string `json:"request"`
}

func decode64(s string) ([]byte, error) {
	for _, enc := range []*base64.Encoding{base64.URLEncoding, base64.RawURLEncoding, base64.StdEncoding, base64.RawStdEncoding} {
		if b, err := enc.DecodeString(s); err == nil {
			return b, nil
		}
	}
	return nil, errors.New("invalid ticket base64 encoding")
}

func digest(b []byte) string { h := sha256.Sum256(b); return hex.EncodeToString(h[:]) }

func parsePublicKey(encoded string) (*rsa.PublicKey, []byte, error) {
	der, err := decode64(encoded)
	if err != nil {
		return nil, nil, err
	}
	var spki struct {
		Algorithm pkix.AlgorithmIdentifier
		PublicKey asn1.BitString
	}
	rest, err := asn1.Unmarshal(der, &spki)
	if err != nil || len(rest) != 0 || spki.PublicKey.BitLength%8 != 0 {
		return nil, nil, errors.New("invalid issuer public key")
	}
	rsaOID := asn1.ObjectIdentifier{1, 2, 840, 113549, 1, 1, 1}
	pssOID := asn1.ObjectIdentifier{1, 2, 840, 113549, 1, 1, 10}
	if !spki.Algorithm.Algorithm.Equal(rsaOID) && !spki.Algorithm.Algorithm.Equal(pssOID) {
		return nil, nil, errors.New("issuer key must be RSA")
	}
	key, err := x509.ParsePKCS1PublicKey(spki.PublicKey.Bytes)
	if err != nil || key.N.BitLen() != 2048 || key.E != 65537 {
		return nil, nil, errors.New("issuer key must be 2048-bit RSA with exponent 65537")
	}
	return key, der, nil
}

func challengeDigest() [32]byte {
	b := make([]byte, 4+len(issuerName)+3)
	binary.BigEndian.PutUint16(b, 2)
	binary.BigEndian.PutUint16(b[2:], uint16(len(issuerName)))
	copy(b[4:], issuerName)
	return sha256.Sum256(b)
}

func newBlindState(key *rsa.PublicKey, keyDER []byte) (blindState, error) {
	input := make([]byte, 98)
	binary.BigEndian.PutUint16(input, 2)
	if _, err := io.ReadFull(rand.Reader, input[2:34]); err != nil {
		return blindState{}, err
	}
	challenge, keyID := challengeDigest(), sha256.Sum256(keyDER)
	copy(input[34:66], challenge[:])
	copy(input[66:], keyID[:])
	client, err := blindrsa.NewClient(blindrsa.SHA384PSSDeterministic, key)
	if err != nil {
		return blindState{}, err
	}
	// Record the cryptographic library's random tape for crash recovery instead
	// of implementing RSA arithmetic or inventing a deterministic RNG. This tape
	// is secret, mode 0600, and is removed once finalized tickets are committed.
	var tape bytes.Buffer
	blind, _, err := client.Blind(io.TeeReader(rand.Reader, &tape), input)
	if err != nil {
		return blindState{}, err
	}
	request := append([]byte{0, 2, keyID[31]}, blind...)
	return blindState{Input: input, Entropy: tape.Bytes(), Request: base64.URLEncoding.EncodeToString(request)}, nil
}

func finalize(key *rsa.PublicKey, state blindState, signed string) (string, error) {
	if len(state.Input) != 98 || len(state.Entropy) < 48 {
		return "", errors.New("invalid issuance recovery state")
	}
	client, err := blindrsa.NewClient(blindrsa.SHA384PSSDeterministic, key)
	if err != nil {
		return "", err
	}
	blinded, finalState, err := client.Blind(bytes.NewReader(state.Entropy), state.Input)
	if err != nil {
		return "", errors.New("cannot restore issuance recovery state")
	}
	want, err := decode64(state.Request)
	if err != nil || len(want) != 259 || !bytes.Equal(want[:3], []byte{0, 2, state.Input[97]}) || !bytes.Equal(want[3:], blinded) {
		return "", errors.New("issuance recovery state does not match original request")
	}
	sig, err := decode64(signed)
	if err != nil {
		return "", err
	}
	unblinded, err := client.Finalize(finalState, sig)
	if err != nil {
		return "", errors.New("issuer blind signature verification failed")
	}
	if err := client.Verify(state.Input, unblinded); err != nil {
		return "", errors.New("issuer token verification failed")
	}
	return base64.URLEncoding.EncodeToString(append(append([]byte{}, state.Input...), unblinded...)), nil
}

func normalizeToken(encoded string) (string, string, error) {
	b, err := decode64(encoded)
	if err != nil || len(b) != tokenSize || binary.BigEndian.Uint16(b) != 2 {
		return "", "", errors.New("invalid RFC 9578 inference ticket")
	}
	challenge := challengeDigest()
	if !bytes.Equal(b[34:66], challenge[:]) {
		return "", "", errors.New("ticket challenge does not match OA Chat")
	}
	return base64.URLEncoding.EncodeToString(b), hex.EncodeToString(b[66:98]), nil
}
