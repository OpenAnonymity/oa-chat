/**
 * Shared Configuration
 * Centralized constants used across multiple services.
 */

// Organization API base URL
export const ORG_API_BASE = 'https://org.openanonymity.ai';

// Verifier service URL
export const VERIFIER_URL = 'https://verifier.openanonymity.ai';

// WebSocket proxy URL (includes secret - not user-configurable)
// export const PROXY_URL = 'wss://proxy.openanonymity.ai/?secret=8d4fc1b2e7a9035f14c8d92afe6730bb';
export const PROXY_URL = 'wss://websocket-proxy-server-twilight-feather-9805.fly.dev/?secret=8d4fc1b2e7a9035f14c8d92afe6730bb';

// Base URL for shared chat links
export const SHARE_BASE_URL = 'https://alpha.openanonymity.ai/chat';

// Retry up to this fraction of available tickets when tickets are already-used
export const TICKET_RETRY_RATIO = 0.5;
