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
export const ORG_API_BASE = 'https://org.openanonymity.ai';

// Verifier service -- hardware-attested (AMD SEV-SNP) station compliance
// enforcer. Open-source and auditable. Enforces privacy toggles and key
// ownership on stations. Not in the inference data path.
export const VERIFIER_URL = 'https://verifier.openanonymity.ai';

// WebSocket proxy -- a shared IP-hiding relay for all users (not a secret).
// The "secret" parameter is a shared access token, not per-user. The proxy
// operator sees connection metadata (timing, connecting IPs) but not request
// content (TLS terminates at the destination). For stronger IP privacy, users
// can use their own VPN/Tor instead of or in addition to this relay.
// export const PROXY_URL = 'wss://proxy.openanonymity.ai/?secret=8d4fc1b2e7a9035f14c8d92afe6730bb';
export const PROXY_URL = 'wss://websocket-proxy-server-twilight-feather-9805.fly.dev/?secret=8d4fc1b2e7a9035f14c8d92afe6730bb';

// Base URL for shared chat links
export const SHARE_BASE_URL = 'https://chat.openanonymity.ai';

// Retry up to this fraction of available tickets when tickets are already-used
export const TICKET_RETRY_RATIO = 0.5;
