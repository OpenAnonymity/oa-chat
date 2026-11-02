package tickets

import (
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"syscall"
	"time"
)

// verifyKey follows the browser's narrow availability policy (PRIVACY_MODEL.md
// section 4). Every new key gets one check. Reuse keeps the original status and
// never upgrades an outage credential.
func (s *TicketSource) verifyKey(ctx context.Context, body []byte, stationID, key string, recentlyAttested bool) (string, string, error) {
	attempt, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	request, err := http.NewRequestWithContext(attempt, http.MethodPost, s.cfg.VerifierURL+"/submit_key", bytesReader(body))
	if err != nil {
		return "", "", errors.New("cannot construct verifier request")
	}
	request.Header.Set("User-Agent", userAgent)
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Accept", "application/json")
	response, err := s.client.Do(request)
	if err != nil {
		if ctx.Err() != nil {
			return "", "", ctx.Err()
		}
		if recentlyAttested && verifierTransportUnavailable(err) {
			return "verifier-unavailable", "recently_attested_outage", nil
		}
		return "", "", errors.New("verifier request failed")
	}
	defer response.Body.Close()
	data, err := io.ReadAll(io.LimitReader(response.Body, 1<<20+1))
	if err != nil || len(data) > 1<<20 {
		return "", "", errors.New("verifier response was interrupted or too large")
	}
	var proof verifierResponse
	if json.Unmarshal(data, &proof) != nil || bytes.Equal(bytes.TrimSpace(data), []byte("null")) {
		return "", "", errors.New("verifier returned invalid JSON")
	}
	if proof.Status == "banned" || proof.hasBan() {
		s.banned.Store(stationID, true)
	}
	return classifyVerifierResponse(response.StatusCode, proof, stationID, key, recentlyAttested)
}

type verifierResponse struct {
	Status          string          `json:"status"`
	StationID       string          `json:"station_id"`
	KeyHash         string          `json:"key_hash"`
	Detail          json.RawMessage `json:"detail"`
	Error           json.RawMessage `json:"error"`
	Message         json.RawMessage `json:"message"`
	BannedStation   json.RawMessage `json:"banned_station"`
	OwnershipPassed *bool           `json:"ownership_passed"`
	Ownership       struct {
		Passed *bool `json:"ownership_passed"`
	} `json:"ownership"`
}

func (p verifierResponse) hasBan() bool {
	value := string(bytes.TrimSpace(p.BannedStation))
	return value != "" && value != "null" && value != "false"
}

var verifierRefusal = regexp.MustCompile(`(?i)invalid signature|signature mismatch|expired|invalid key|privacy|logging|training|ownership.*(?:mismatch|failed)|banned`)

func classifyVerifierResponse(httpStatus int, proof verifierResponse, stationID, key string, recentlyAttested bool) (string, string, error) {
	rejected := errors.New("verifier did not approve this exact station and key")
	// Even an error response cannot authorize a different station or key.
	if (proof.StationID != "" && proof.StationID != stationID) || (proof.KeyHash != "" && !verifierKeyHashMatches(proof.KeyHash, key)) {
		return "", "", rejected
	}
	var detail string
	_ = json.Unmarshal(proof.Detail, &detail)
	ownershipUnavailable := httpStatus == 503 && proof.Status == "unverified" && detail == "ownership_check_error"
	statusRefused := proof.Status == "banned" || proof.Status == "rejected" || proof.Status == "denied" || proof.Status == "invalid" || (proof.Status == "unverified" && !ownershipUnavailable)
	if statusRefused || proof.hasBan() || (proof.OwnershipPassed != nil && !*proof.OwnershipPassed) || (proof.Ownership.Passed != nil && !*proof.Ownership.Passed) || verifierRefusal.Match(bytes.Join([][]byte{proof.Detail, proof.Error, proof.Message}, []byte(" "))) {
		return "", "", rejected
	}
	if httpStatus >= 200 && httpStatus < 300 {
		if proof.Status == "verified" && proof.StationID == stationID && verifierKeyHashMatches(proof.KeyHash, key) {
			return "verified", "", nil
		}
		return "", "", rejected
	}
	// These two precise temporary responses match the production browser policy
	// and do not require the issuer's recently-attested claim.
	if httpStatus == 429 {
		return "verifier-unavailable", "rate_limited", nil
	}
	if ownershipUnavailable {
		return "verifier-unavailable", "ownership_check_error", nil
	}
	switch httpStatus {
	case 408, 500, 502, 503, 504:
		if recentlyAttested && (proof.Status == "" || proof.Status == "error" || proof.Status == "unavailable") {
			return "verifier-unavailable", "recently_attested_outage", nil
		}
	}
	return "", "", rejected
}

func verifierTransportUnavailable(err error) bool {
	// A canceled caller and TLS authentication errors are never outage approval.
	// Unwrap URL errors first: *url.Error is itself a net.Error whatever its cause.
	var urlErr *url.Error
	if errors.As(err, &urlErr) {
		err = urlErr.Err
	}
	var certErr *tls.CertificateVerificationError
	var unknownCA x509.UnknownAuthorityError
	var badName x509.HostnameError
	var invalidCert x509.CertificateInvalidError
	if errors.Is(err, context.Canceled) || errors.As(err, &certErr) || errors.As(err, &unknownCA) || errors.As(err, &badName) || errors.As(err, &invalidCert) {
		return false
	}
	var netErr net.Error
	if errors.As(err, &netErr) && netErr.Timeout() {
		return true
	}
	var opErr *net.OpError
	var dnsErr *net.DNSError
	return errors.As(err, &opErr) || errors.As(err, &dnsErr) || errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) || errors.Is(err, syscall.ECONNRESET) || errors.Is(err, syscall.ECONNREFUSED) || errors.Is(err, syscall.EPIPE)
}

// verifierKeyHashMatches checks the identifier in this key's /submit_key
// response. oa-verifier returns the first eight SHA-256 bytes, as the browser's
// StationVerifier._hashKey consumes them. A full digest is also accepted, but no
// other prefix length or mismatched suffix.
func verifierKeyHashMatches(reported, key string) bool {
	if key == "" {
		return false
	}
	sum := sha256.Sum256([]byte(key))
	full := hex.EncodeToString(sum[:])
	return reported == full || reported == full[:16]
}
