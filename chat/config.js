/**
 * Shared Configuration
 * Centralized constants used across multiple services.
 */

// Organization API -- orchestrates ticket issuance and ephemeral API key requests.
// Does NOT need to be trusted for unlinkability: all blinding/unblinding runs
// client-side (@cloudflare/privacypass-ts), the org cannot correlate issuance to redemption (blind
// signatures), and it is never in the inference data path (never sees prompts
// or responses). Being closed-source is irrelevant -- its worst case is denial
// of service, not privacy breach. See docs/PRIVACY_MODEL.md.
import { ORG_API_BASE, ORG_AUTH_ORIGIN } from './services/orgEndpoints.js';
export { ORG_API_BASE, ORG_AUTH_ORIGIN };

// Verifier service -- hardware-attested (AMD SEV-SNP) station compliance
// enforcer. Open-source and auditable. Enforces privacy toggles and key
// ownership on stations. Not in the inference data path.
const disposableDemoVerifierBypass = (
    typeof __OA_DEMO_VERIFIER_BYPASS__ !== 'undefined' &&
    __OA_DEMO_VERIFIER_BYPASS__ === true
);
const disposableDemoProxyUrl = (
    typeof __OA_DEMO_PROXY_URL__ !== 'undefined' &&
    typeof __OA_DEMO_PROXY_URL__ === 'string'
) ? __OA_DEMO_PROXY_URL__ : '';
const configuredVerifierOrigin = (
    typeof __OA_VERIFIER_ORIGIN__ !== 'undefined' &&
    typeof __OA_VERIFIER_ORIGIN__ === 'string'
) ? __OA_VERIFIER_ORIGIN__ : '';
// A deliberately unverified disposable demo never contacts the production
// verifier. Its same-origin endpoint will fail closed for ordinary verifier
// calls while the explicit demo policy marks local mock keys as unverified.
export const VERIFIER_URL = disposableDemoVerifierBypass
    ? ORG_API_BASE
    : configuredVerifierOrigin || 'https://verifier2.openanonymity.ai';

// Explicit operator trust for unverified continuation, independent of the org's
// recently-attested flag and verifier broadcasts. Changing a pin invalidates
// previously saved fallback approvals. This is not verifier approval.
export const TRUSTED_VERIFIER_STATIONS = Object.freeze([Object.freeze({
    stationId: 'oa-station',
    publicKey: '20019ebb3cfa61a34ac75879bca8ccf9168ce435c6007d5279b84ebeb83fd097',
    verifierOrigin: 'https://verifier2.openanonymity.ai'
})]);

// Verifier outage policy -- what the client does when the verifier cannot give
// an explicit approval for a freshly issued key. Set at build time with
// OA_VERIFIER_OUTAGE_POLICY; tests and unbuilt sources default to strict.
// Every continuation below additionally requires a pinned trusted station and a
// valid local Ed25519 signature binding that station to this key and expiry.
//   strict:   continue only when the org marked the station recently attested
//             (or on a temporary 429 / ownership-check error); anything else blocks.
//   tolerant: continue on any outage -- unreachable, timeout, 5xx, 429, pending
//             or malformed reply -- whatever the attestation flag. An explicit
//             "unverified" verdict from a reachable verifier still blocks.
//   advisory: tolerant, plus an explicit "unverified" verdict continues too.
// A banned station, an expired key and a station/key mismatch block under every
// policy. Keys admitted this way are marked unverified in the Activity Timeline,
// are re-verified in the background where that makes sense, and are never shared.
export const VERIFIER_OUTAGE_POLICIES = Object.freeze(['strict', 'tolerant', 'advisory']);
export const VERIFIER_OUTAGE_POLICY = (
    typeof __OA_VERIFIER_OUTAGE_POLICY__ === 'string' &&
    VERIFIER_OUTAGE_POLICIES.includes(__OA_VERIFIER_OUTAGE_POLICY__)
) ? __OA_VERIFIER_OUTAGE_POLICY__ : 'strict';

// WebSocket proxy -- a shared IP-hiding relay for all users (not a secret).
// The "secret" parameter is a shared access token, not per-user. The proxy
// operator sees connection metadata (timing, connecting IPs) but not request
// content (TLS terminates at the destination). For stronger IP privacy, users
// can use their own VPN/Tor instead of or in addition to this relay.
const configuredProxyUrl = typeof __OA_PROXY_URL__ === 'string' ? __OA_PROXY_URL__ : '';
export const PROXY_URL = disposableDemoProxyUrl || configuredProxyUrl || 'wss://oa-1.refraction.network/?secret=1f45ceecf768790c8389ff704612d5cf/';
export const DEMO_PROXY_FETCH_TIMEOUT_MS = disposableDemoProxyUrl ? 10000 : null;

// Base URL for shared chat links
export const SHARE_BASE_URL = 'https://chat.openanonymity.ai';

// Cloudflare Turnstile -- browser verification for free access requests.
// Public site key only; the secret key lives server-side.
export const TURNSTILE_SITE_KEY = '0x4AAAAAACumDp8HcWWXKNzk';

// Retry up to this fraction of available tickets when tickets are already-used
export const TICKET_RETRY_RATIO = 0.5;

// Council mode is available for explicit session-level opt-in only.
// New sessions still default to normal chat (`responseMode: 'single'`), so this
// does not change behavior unless a session is deliberately configured for it.
export const COUNCIL_MODE_FEATURE_FLAG = true;

// Debug logging -- enabled in development (localhost), disabled in production builds.
// The build script (scripts/build.mjs) replaces __DEV__ with false at build time.
const __DEV_DEFAULT__ = typeof window !== 'undefined' &&
    (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1');
export const DEBUG = typeof __DEV__ !== 'undefined' ? __DEV__ : __DEV_DEFAULT__;
