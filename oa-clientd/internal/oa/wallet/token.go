package wallet

import (
	"bytes"
	"crypto"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/sha512"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/asn1"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"errors"
)

// issuerName is the browser's constant RFC 9578 challenge, with an empty
// redemption context and origin. A server-provided challenge could tag a holder,
// so none is ever accepted.
const issuerName = "if you found this, email hi@openanonymity.ai with code OA-BLIND-2026 -- we need you :D"

const (
	tokenSize = 2 + 32 + 32 + 32 + 256
	inputSize = 2 + 32 + 32 + 32
	saltSize  = 48 // RSABSSA-SHA384-PSS-Deterministic
)

// DecodeToken accepts the base64 variants a wallet may hold.
func DecodeToken(token string) ([]byte, error) {
	for _, encoding := range []*base64.Encoding{base64.URLEncoding, base64.RawURLEncoding, base64.StdEncoding, base64.RawStdEncoding} {
		if raw, err := encoding.DecodeString(token); err == nil {
			return raw, nil
		}
	}
	return nil, errors.New("invalid ticket encoding")
}

func challengeDigest() [32]byte {
	raw := make([]byte, 4+len(issuerName)+3)
	binary.BigEndian.PutUint16(raw, 2)
	binary.BigEndian.PutUint16(raw[2:], uint16(len(issuerName)))
	copy(raw[4:], issuerName)
	return sha256.Sum256(raw)
}

// IssuerKey is the org's current blind-signature public key.
type IssuerKey struct {
	Public *rsa.PublicKey
	KeyID  string
}

// ParseIssuerKey checks the SPKI encoding and the 2048-bit RSA shape. The key ID
// is the SHA-256 of the exact DER bytes, matching token_key_id.
func ParseIssuerKey(encoded, claimedKeyID string) (IssuerKey, error) {
	der, err := DecodeToken(encoded)
	if err != nil {
		return IssuerKey{}, errors.New("invalid issuer public key")
	}
	var spki struct {
		Algorithm pkix.AlgorithmIdentifier
		PublicKey asn1.BitString
	}
	rest, err := asn1.Unmarshal(der, &spki)
	if err != nil || len(rest) != 0 || spki.PublicKey.BitLength%8 != 0 {
		return IssuerKey{}, errors.New("invalid issuer public key")
	}
	rsaOID := asn1.ObjectIdentifier{1, 2, 840, 113549, 1, 1, 1}
	pssOID := asn1.ObjectIdentifier{1, 2, 840, 113549, 1, 1, 10}
	if !spki.Algorithm.Algorithm.Equal(rsaOID) && !spki.Algorithm.Algorithm.Equal(pssOID) {
		return IssuerKey{}, errors.New("issuer key must be RSA")
	}
	key, err := x509.ParsePKCS1PublicKey(spki.PublicKey.Bytes)
	if err != nil || key.N.BitLen() != 2048 || key.E != 65537 {
		return IssuerKey{}, errors.New("issuer key must be 2048-bit RSA with exponent 65537")
	}
	sum := sha256.Sum256(der)
	keyID := hex.EncodeToString(sum[:])
	if claimedKeyID != "" && claimedKeyID != keyID {
		return IssuerKey{}, errors.New("issuer public key metadata mismatch")
	}
	return IssuerKey{Public: key, KeyID: keyID}, nil
}

// VerifyToken checks the token shape, the challenge, the issuer generation and
// the issuer's RSA-PSS signature. A forged or foreign ticket fails here, before
// any spend attempt. The org still decides whether it was already spent.
func VerifyToken(token string, issuer IssuerKey) error {
	raw, err := DecodeToken(token)
	if err != nil || len(raw) != tokenSize || binary.BigEndian.Uint16(raw) != 2 {
		return errors.New("not an RFC 9578 inference ticket")
	}
	challenge := challengeDigest()
	if !bytes.Equal(raw[34:66], challenge[:]) {
		return errors.New("ticket challenge does not match OA")
	}
	if hex.EncodeToString(raw[66:98]) != issuer.KeyID {
		return errors.New("ticket issuer generation does not match the current key")
	}
	digest := sha512.Sum384(raw[:inputSize])
	if err := rsa.VerifyPSS(issuer.Public, crypto.SHA384, digest[:], raw[inputSize:], &rsa.PSSOptions{SaltLength: saltSize, Hash: crypto.SHA384}); err != nil {
		return errors.New("ticket issuer signature is invalid")
	}
	return nil
}
