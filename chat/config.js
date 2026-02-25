/**
 * Shared Configuration
 * Centralized constants used across multiple services.
 */

const readRuntimeConfigValue = (key) => {
    if (typeof globalThis === 'undefined') return '';

    const config = globalThis.__OA_CONFIG__;
    if (config && typeof config[key] === 'string') {
        return config[key].trim();
    }

    const directValue = globalThis[key];
    return typeof directValue === 'string' ? directValue.trim() : '';
};

// Organization API base URL
export const ORG_API_BASE = 'https://org.openanonymity.ai';

// Verifier service URL
export const VERIFIER_URL = 'https://verifier.openanonymity.ai';

// WebSocket proxy URL (includes secret - not user-configurable)
// export const PROXY_URL = 'wss://proxy.openanonymity.ai/?secret=8d4fc1b2e7a9035f14c8d92afe6730bb';
export const PROXY_URL = 'wss://websocket-proxy-server-twilight-feather-9805.fly.dev/?secret=8d4fc1b2e7a9035f14c8d92afe6730bb';

// Base URL for shared chat links
export const SHARE_BASE_URL = 'https://chat.openanonymity.ai';

// Retry up to this fraction of available tickets when tickets are already-used
export const TICKET_RETRY_RATIO = 0.5;

// Optional runtime override for static Tinfoil key (empty by default)
export const TINFOIL_API_KEY = readRuntimeConfigValue('TINFOIL_API_KEY');
