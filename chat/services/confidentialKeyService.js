/**
 * Shared confidential model (Tinfoil/TEE) API key service.
 *
 * All consumers (memoryExtractor, agenticRetrieval, memoryCompactor)
 * share a single cached key so that a new key is only requested when
 * the current one expires.
 */
import { TINFOIL_API_KEY } from '../config.js';
import { localInferenceService } from '../../local_inference/index.js';
import ticketClient from './ticketClient.js';

const TINFOIL_BASE_URL = 'https://inference.tinfoil.sh';
const TINFOIL_BACKEND_ID = 'tinfoil';
const TINFOIL_KEY_TICKETS_REQUIRED = 2;

let _cachedKey = null;
let _cachedKeyInfo = null;

function _isKeyValid() {
    if (!_cachedKey || !_cachedKeyInfo) return false;
    const expiresAt = _cachedKeyInfo.expiresAt || _cachedKeyInfo.expires_at;
    if (!expiresAt) return false;
    const expiry = typeof expiresAt === 'number'
        ? new Date(expiresAt * 1000)
        : new Date(expiresAt);
    return expiry > new Date(Date.now() + 60000); // 60s grace period
}

function _configureBackend(apiKey) {
    localInferenceService.configureBackend(TINFOIL_BACKEND_ID, {
        baseUrl: TINFOIL_BASE_URL,
        apiKey
    });
}

/**
 * Return a valid confidential model API key, reusing the cached one if
 * it hasn't expired. Only requests a new key when necessary.
 *
 * @param {string} [purpose] — label for logging (e.g. 'memory', 'retrieval')
 * @returns {Promise<string|null>} API key or null if unavailable
 */
export async function ensureConfidentialKey(purpose = 'confidential') {
    // 1. Static / env key always wins
    const envKey = TINFOIL_API_KEY;
    if (envKey) {
        _configureBackend(envKey);
        return envKey;
    }

    // 2. Reuse cached key if still valid
    if (_isKeyValid()) {
        _configureBackend(_cachedKey);
        return _cachedKey;
    }

    // 3. Need enough tickets to request a new one
    const ticketCount = ticketClient.getTicketCount();
    if (ticketCount < TINFOIL_KEY_TICKETS_REQUIRED) {
        return null;
    }

    // 4. Request new key
    try {
        const keyData = await ticketClient.requestConfidentialApiKey(purpose, TINFOIL_KEY_TICKETS_REQUIRED);
        _cachedKey = keyData.key;
        _cachedKeyInfo = keyData;
        _configureBackend(keyData.key);
        console.log(`[ConfidentialKey] Acquired key (purpose: ${purpose})`);
        return keyData.key;
    } catch (error) {
        console.warn(`[ConfidentialKey] Failed to acquire key (purpose: ${purpose}):`, error);
        return null;
    }
}

/**
 * Check whether a key can be acquired (env key, cached, or enough tickets).
 */
export function canAcquireConfidentialKey() {
    if (TINFOIL_API_KEY) return true;
    if (_isKeyValid()) return true;
    return ticketClient.getTicketCount() >= TINFOIL_KEY_TICKETS_REQUIRED;
}

/**
 * Invalidate the cached key (e.g. on 401/403 errors).
 */
export function invalidateConfidentialKey() {
    _cachedKey = null;
    _cachedKeyInfo = null;
}

/** Number of tickets needed per key request. */
export const CONFIDENTIAL_KEY_TICKETS = TINFOIL_KEY_TICKETS_REQUIRED;
