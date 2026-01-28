/**
 * Account service: passkey-backed master key management.
 *
 * SECURITY ARCHITECTURE
 * ---------------------
 * Master Key: 256-bit random key generated client-side via crypto.getRandomValues().
 * Never leaves the browser in plaintext; only wrapped forms are sent to the server.
 *
 * Two independent unlock paths:
 *   1. Passkey + PRF: Master key wrapped with AES-GCM using key material derived
 *      from WebAuthn PRF extension output. PRF input is SHA-256(accountId).
 *   2. Recovery Code: Master key wrapped with AES-GCM using Argon2id-derived key
 *      from the 4-word recovery code + random salt.
 *
 * Server stores: credential public keys, wrapped keys (ciphertext only).
 * Server never sees: master key, PRF output, recovery code.
 *
 * Threat model:
 *   - Compromised server cannot decrypt data (no plaintext keys).
 *   - Stolen device requires passkey biometric/PIN to unlock.
 *   - Recovery code brute-force mitigated by Argon2id (64MB, 3 iterations).
 */

import { ORG_API_BASE } from '../config.js';
import { chatDB } from '../db.js';
import { generateRecoveryCode, isValidRecoveryCode, normalizeRecoveryCode } from './recoveryCode.js';
import syncService from './syncService.js';

const ACCOUNT_SETTINGS_KEY = 'account-settings';
const MASTER_CRYPTO_KEY = 'master-crypto-key';
const MASTER_KEY_BYTES = 'master-key-bytes';  // Raw bytes for sync HKDF
const REFRESH_TOKEN_KEY = 'account-refresh-token';  // Electron-only: refresh token persistence
const ACCOUNT_REQUEST_TIMEOUT_MS = 10000;

// Platform detection for auth token handling
// Check electronAPI.isElectron (context-isolated) or process.versions.electron (non-isolated)
const PLATFORM = (typeof window !== 'undefined' && (window.electronAPI?.isElectron || window?.process?.versions?.electron)) ? 'electron' : 'web';

// Argon2id parameters for recovery code KDF.
// These values balance security vs. UX on mobile devices.
// 64 MB memory makes GPU/ASIC attacks expensive; 4 iterations adds ~0.7s on modern devices.
const ARGON2_MEMORY = 65536;      // 64 MB
const ARGON2_ITERATIONS = 4;      // Time cost (bumped from 3 for extra margin)
const ARGON2_PARALLELISM = 1;     // Single thread for cross-device consistency
const ARGON2_HASH_LENGTH = 32;    // 256 bits for AES-256-GCM

// Rate limiting for failed unlock attempts (client-side defense in depth)
const RATE_LIMIT_MAX_ATTEMPTS = 5;          // Max failures before lockout
const RATE_LIMIT_WINDOW_MS = 60000;         // 1 minute window
const RATE_LIMIT_LOCKOUT_MS = 30000;        // 30 second lockout after max failures
const RATE_LIMIT_BACKOFF_BASE_MS = 1000;    // Base delay, doubles each failure

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function normalizeAccountId(accountId) {
    if (!accountId) return '';
    return accountId.toString().replace(/[\s-]+/g, '').toUpperCase();
}

function formatAccountId(accountId) {
    const normalized = normalizeAccountId(accountId);
    if (!normalized) return '';
    return normalized.match(/.{1,4}/g)?.join(' ') || normalized;
}

function bytesToBase64(bytes) {
    let binary = '';
    for (let i = 0; i < bytes.length; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
}

function base64ToBytes(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
}

function bytesToBase64Url(bytes) {
    return bytesToBase64(bytes)
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/g, '');
}

function base64UrlToBytes(input) {
    if (!input) return new Uint8Array();
    let base64 = input.replace(/-/g, '+').replace(/_/g, '/');
    const padding = base64.length % 4;
    if (padding) base64 += '='.repeat(4 - padding);
    return base64ToBytes(base64);
}

function decodeBase64String(input) {
    if (!input) return new Uint8Array();
    const hasUrlChars = input.includes('-') || input.includes('_');
    return hasUrlChars ? base64UrlToBytes(input) : base64ToBytes(input);
}

function encodeWrappedKey(payload) {
    const json = JSON.stringify(payload);
    return bytesToBase64(textEncoder.encode(json));
}

function decodeWrappedKey(payload) {
    if (!payload) return null;
    if (typeof payload === 'object') return payload;
    const bytes = base64ToBytes(payload);
    return JSON.parse(textDecoder.decode(bytes));
}

function normalizeWrappedKeyPayload(payload) {
    if (!payload) return null;
    return typeof payload === 'string' ? payload : encodeWrappedKey(payload);
}

async function digestAccountId(accountId) {
    const normalized = normalizeAccountId(accountId);
    const hash = await crypto.subtle.digest('SHA-256', textEncoder.encode(normalized));
    return new Uint8Array(hash);
}

async function importAesKey(bytes) {
    return crypto.subtle.importKey(
        'raw',
        bytes,
        { name: 'AES-GCM' },
        false,
        ['encrypt', 'decrypt']
    );
}

/**
 * Encrypt bytes with AES-256-GCM.
 * Uses a fresh 96-bit IV per encryption (NIST recommended for GCM).
 * GCM provides authenticated encryption: ciphertext tampering will cause decryption to fail.
 */
async function encryptBytes(key, plaintextBytes) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv },
        key,
        plaintextBytes
    );
    return {
        iv: bytesToBase64(new Uint8Array(iv)),
        ciphertext: bytesToBase64(new Uint8Array(ciphertext))
    };
}

async function decryptBytes(key, payload) {
    const ivBytes = base64ToBytes(payload.iv);
    const ciphertextBytes = base64ToBytes(payload.ciphertext);
    const plaintext = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: ivBytes },
        key,
        ciphertextBytes
    );
    return new Uint8Array(plaintext);
}

/**
 * Derive an AES key from the recovery code using Argon2id.
 * Argon2id is memory-hard, making brute-force attacks expensive even with GPUs/ASICs.
 * The salt is stored alongside the wrapped key (not secret, but ensures unique derivation).
 */
async function deriveRecoveryKey(code, saltBytes) {
    if (!window.argon2id) {
        if (typeof window.initHashWasm !== 'function') {
            throw new Error('Hash library not loaded, please refresh the page');
        }
        await window.initHashWasm();
    }
    if (typeof window.argon2id !== 'function') {
        throw new Error('Argon2 not available, please refresh the page');
    }
    const derivedBytes = await window.argon2id({
        password: code,
        salt: saltBytes,
        parallelism: ARGON2_PARALLELISM,
        iterations: ARGON2_ITERATIONS,
        memorySize: ARGON2_MEMORY,
        hashLength: ARGON2_HASH_LENGTH,
        outputType: 'binary'
    });
    return importAesKey(derivedBytes);
}

/**
 * Compute a hash of the recovery code for server-side verification.
 * Uses Argon2id with accountId as salt (same params as deriveRecoveryKey).
 * This proves knowledge of the recovery code without revealing it.
 * Server stores this hash and verifies it before returning wrapped key.
 */
async function computeRecoveryCodeHash(recoveryCode, accountId) {
    if (!window.argon2id) {
        if (typeof window.initHashWasm !== 'function') {
            throw new Error('Hash library not loaded, please refresh the page');
        }
        await window.initHashWasm();
    }
    if (typeof window.argon2id !== 'function') {
        throw new Error('Argon2 not available, please refresh the page');
    }
    const saltBytes = textEncoder.encode(accountId);
    const hash = await window.argon2id({
        password: recoveryCode,
        salt: saltBytes,
        parallelism: ARGON2_PARALLELISM,
        iterations: ARGON2_ITERATIONS,
        memorySize: ARGON2_MEMORY,
        hashLength: ARGON2_HASH_LENGTH,
        outputType: 'hex'
    });
    return hash;
}

/**
 * Extract PRF (Pseudo-Random Function) output from a WebAuthn credential.
 * PRF extension (WebAuthn Level 3) derives key material from the authenticator's
 * internal secret, bound to the credential. Output is deterministic for the same
 * input but unpredictable without the authenticator.
 *
 * Security: PRF output never leaves the authenticator; we only see the derived bytes.
 */
function getPrfOutput(credential) {
    if (!credential?.getClientExtensionResults) return null;
    const results = credential.getClientExtensionResults();
    const prf = results?.prf;
    const output = prf?.results?.first || prf?.first;
    if (!output) return null;
    return new Uint8Array(output);
}

function mapCredentials(credentials = []) {
    return credentials.map(cred => ({
        ...cred,
        id: cred.id instanceof ArrayBuffer || ArrayBuffer.isView(cred.id)
            ? cred.id
            : decodeBase64String(cred.id)
    }));
}

function buildCreationOptions(data, accountId, prfInput) {
    const source = data?.publicKey || data?.options?.publicKey || data?.publicKeyOptions || {};
    let publicKey = { ...source };

    if (typeof publicKey.challenge === 'string') {
        publicKey.challenge = decodeBase64String(publicKey.challenge);
    } else if (!publicKey.challenge && typeof data?.challenge === 'string') {
        publicKey.challenge = decodeBase64String(data.challenge);
    }

    if (!publicKey.rp && (data?.rpId || data?.rp_id)) {
        publicKey.rp = { id: data.rpId || data.rp_id, name: 'Open Anonymity' };
    } else if (publicKey.rp && !publicKey.rp.id && (data?.rpId || data?.rp_id)) {
        publicKey.rp = { ...publicKey.rp, id: data.rpId || data.rp_id };
    }
    if (!publicKey.user) {
        const display = formatAccountId(accountId) || accountId;
        publicKey.user = {
            id: textEncoder.encode(accountId),
            name: accountId,
            displayName: `OA ${display}`
        };
    } else if (publicKey.user.id && typeof publicKey.user.id === 'string') {
        publicKey.user.id = decodeBase64String(publicKey.user.id);
    }

    if (!publicKey.pubKeyCredParams) {
        publicKey.pubKeyCredParams = [{ type: 'public-key', alg: -7 }];
    }

    publicKey.authenticatorSelection = {
        residentKey: 'required',
        userVerification: 'required',
        ...publicKey.authenticatorSelection
    };
    publicKey.attestation = publicKey.attestation || 'none';
    publicKey.timeout = publicKey.timeout || 60000;

    if (publicKey.excludeCredentials) {
        publicKey.excludeCredentials = mapCredentials(publicKey.excludeCredentials);
    }

    publicKey.extensions = {
        ...(publicKey.extensions || {}),
        prf: { eval: { first: prfInput } }
    };

    return publicKey;
}

function buildRequestOptions(data, prfInput) {
    const source = data?.publicKey || data?.options?.publicKey || data?.publicKeyOptions || {};
    let publicKey = { ...source };

    if (typeof publicKey.challenge === 'string') {
        publicKey.challenge = decodeBase64String(publicKey.challenge);
    } else if (!publicKey.challenge && typeof data?.challenge === 'string') {
        publicKey.challenge = decodeBase64String(data.challenge);
    }

    if (publicKey.allowCredentials) {
        publicKey.allowCredentials = mapCredentials(publicKey.allowCredentials);
    } else if (data?.allowCredentials) {
        publicKey.allowCredentials = mapCredentials(data.allowCredentials);
    }

    if (!publicKey.rpId && (data?.rpId || data?.rp_id)) {
        publicKey.rpId = data.rpId || data.rp_id;
    }

    publicKey.userVerification = publicKey.userVerification || 'required';
    publicKey.timeout = publicKey.timeout || 60000;

    publicKey.extensions = {
        ...(publicKey.extensions || {}),
        prf: { eval: { first: prfInput } }
    };

    return publicKey;
}

function credentialToJSON(credential) {
    return {
        id: credential.id,
        rawId: bytesToBase64Url(new Uint8Array(credential.rawId)),
        type: credential.type,
        response: {
            clientDataJSON: bytesToBase64Url(new Uint8Array(credential.response.clientDataJSON)),
            attestationObject: bytesToBase64Url(new Uint8Array(credential.response.attestationObject))
        }
    };
}

function assertionToJSON(assertion) {
    return {
        id: assertion.id,
        rawId: bytesToBase64Url(new Uint8Array(assertion.rawId)),
        type: assertion.type,
        response: {
            clientDataJSON: bytesToBase64Url(new Uint8Array(assertion.response.clientDataJSON)),
            authenticatorData: bytesToBase64Url(new Uint8Array(assertion.response.authenticatorData)),
            signature: bytesToBase64Url(new Uint8Array(assertion.response.signature)),
            userHandle: assertion.response.userHandle
                ? bytesToBase64Url(new Uint8Array(assertion.response.userHandle))
                : null
        }
    };
}

/**
 * Custom error for token invalidation (e.g., after recovery on another device).
 * Callers should catch this and trigger re-authentication.
 */
class TokenInvalidatedError extends Error {
    constructor(message = 'Session invalidated, please sign in again') {
        super(message);
        this.name = 'TokenInvalidatedError';
        this.code = 'INVALID_TOKEN';
    }
}

// Global callback for token invalidation - set by AccountService
let onTokenInvalidated = null;

/**
 * Fetch JSON from the auth API.
 * CSRF protection provided by SameSite=Strict cookie + WebAuthn challenge-response.
 */
async function fetchJson(path, body, { timeoutMs = ACCOUNT_REQUEST_TIMEOUT_MS } = {}) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    const response = await fetch(`${ORG_API_BASE}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Client-Platform': PLATFORM },
        credentials: 'include',
        body: JSON.stringify(body || {}),
        signal: controller.signal
    });
    clearTimeout(timeoutId);
    let data = null;
    try {
        data = await response.json();
    } catch (error) {
        data = null;
    }
    if (!response.ok) {
        // Detect token invalidation (e.g., after recovery on another device)
        if (response.status === 401 && data?.code === 'INVALID_TOKEN') {
            if (onTokenInvalidated) {
                onTokenInvalidated();
            }
            throw new TokenInvalidatedError(data?.error || data?.message);
        }
        const message = data?.error || data?.message || response.statusText || 'Request failed';
        throw new Error(message);
    }
    return data || {};
}

function toFriendlyError(error) {
    if (!error) return 'Unexpected error';
    if (error.name === 'AbortError') return 'Request timed out, please try again';
    if (error.name === 'NotAllowedError') return 'Passkey prompt was cancelled';
    if (error.name === 'NotFoundError') return 'No passkey found for this account on this device';
    if (error.name === 'OperationError') return 'Invalid recovery code, please check and try again';
    if (error.name === 'TokenInvalidatedError') return 'Session expired, please sign in again';
    return error.message || 'Unexpected error';
}

class AccountService {
    constructor() {
        this.state = {
            isReady: false,
            accountId: null,
            credentialId: null,
            recoveryConfirmed: false,
            recoveryCode: null,
            recoveryRequired: false,
            busy: false,
            action: null,
            error: null,
            status: 'none',
            passkeySupported: typeof window !== 'undefined' && !!window.PublicKeyCredential,
            prfSupported: null,
            rateLimited: false,
            rateLimitResetAt: null
        };
        this.masterKey = null;
        this.recoveryPayload = null;
        this.subscribers = new Set();

        // Rate limiting state (not persisted - resets on page reload)
        this.failedAttempts = [];
        this.lockedUntil = 0;

        // Pending account for multi-step creation flow
        // Holds { accountId, masterKey, credential, prfBytes, recoveryCode } during creation
        this.pendingAccount = null;

        // Session persistence: access token (memory) and CryptoKey (IndexedDB)
        this.accessToken = null;
        this.refreshToken = null;  // Electron-only: refresh token for Bearer auth
        this.cryptoKey = null;  // Non-extractable CryptoKey for encryption

        // Set up global callback for token invalidation
        onTokenInvalidated = () => this.handleTokenInvalidation();
    }

    getState() {
        return { ...this.state };
    }

    // =========================================================================
    // Rate Limiting (client-side defense in depth)
    // =========================================================================

    /**
     * Check if currently rate limited. Returns remaining wait time in ms, or 0 if ok.
     */
    getRateLimitDelay() {
        const now = Date.now();

        // Check hard lockout
        if (this.lockedUntil > now) {
            return this.lockedUntil - now;
        }

        // Prune old attempts outside the window
        this.failedAttempts = this.failedAttempts.filter(
            t => now - t < RATE_LIMIT_WINDOW_MS
        );

        // If at max attempts, enforce lockout
        if (this.failedAttempts.length >= RATE_LIMIT_MAX_ATTEMPTS) {
            this.lockedUntil = now + RATE_LIMIT_LOCKOUT_MS;
            return RATE_LIMIT_LOCKOUT_MS;
        }

        // Exponential backoff based on recent failures
        if (this.failedAttempts.length > 0) {
            const backoff = RATE_LIMIT_BACKOFF_BASE_MS * Math.pow(2, this.failedAttempts.length - 1);
            const lastAttempt = this.failedAttempts[this.failedAttempts.length - 1];
            const elapsed = now - lastAttempt;
            if (elapsed < backoff) {
                return backoff - elapsed;
            }
        }

        return 0;
    }

    /**
     * Record a failed unlock attempt.
     */
    recordFailedAttempt() {
        this.failedAttempts.push(Date.now());

        // Update state for UI
        const delay = this.getRateLimitDelay();
        if (delay > 0) {
            this.state.rateLimited = true;
            this.state.rateLimitResetAt = Date.now() + delay;
        }
    }

    /**
     * Clear rate limiting state (call on successful unlock).
     */
    clearRateLimit() {
        this.failedAttempts = [];
        this.lockedUntil = 0;
        this.state.rateLimited = false;
        this.state.rateLimitResetAt = null;
    }

    /**
     * Check rate limit and return error message if limited, or null if ok.
     */
    checkRateLimit() {
        const delay = this.getRateLimitDelay();
        if (delay > 0) {
            const seconds = Math.ceil(delay / 1000);
            return `Too many attempts. Please wait ${seconds} second${seconds === 1 ? '' : 's'}.`;
        }
        return null;
    }

    getMasterKey() {
        return this.masterKey ? new Uint8Array(this.masterKey) : null;
    }

    /**
     * Get the non-extractable CryptoKey for encryption operations.
     * Returns the CryptoKey if available, null otherwise.
     */
    getCryptoKey() {
        return this.cryptoKey;
    }

    /**
     * Get the current access token for API authentication.
     */
    getAccessToken() {
        return this.accessToken;
    }

    // =========================================================================
    // Master Key Persistence (Non-Extractable CryptoKey in IndexedDB)
    // =========================================================================

    /**
     * Persist the master key in IndexedDB.
     * Stores both:
     * - Non-extractable CryptoKey (for local AES-GCM encryption)
     * - Raw bytes (for sync HKDF key derivation)
     */
    async persistMasterKey(masterKeyBytes) {
        if (!chatDB) return;
        
        // Import as non-extractable CryptoKey for local encryption
        const cryptoKey = await crypto.subtle.importKey(
            'raw',
            masterKeyBytes,
            { name: 'AES-GCM' },
            false,  // extractable = false
            ['encrypt', 'decrypt']
        );
        
        // Store both in IndexedDB
        await chatDB.saveSetting(MASTER_CRYPTO_KEY, cryptoKey);
        await chatDB.saveSetting(MASTER_KEY_BYTES, new Uint8Array(masterKeyBytes));
        this.cryptoKey = cryptoKey;
    }

    /**
     * Load the persisted master key from IndexedDB.
     * Called during init() to restore session on page refresh.
     * @returns {Promise<boolean>} True if key was loaded, false otherwise
     */
    async loadMasterKey() {
        if (!chatDB) return false;
        
        try {
            const [cryptoKey, keyBytes] = await Promise.all([
                chatDB.getSetting(MASTER_CRYPTO_KEY),
                chatDB.getSetting(MASTER_KEY_BYTES)
            ]);
            
            if (cryptoKey && cryptoKey instanceof CryptoKey) {
                this.cryptoKey = cryptoKey;
            }
            
            if (keyBytes && keyBytes instanceof Uint8Array) {
                this.masterKey = new Uint8Array(keyBytes);
            }
            
            return !!(this.cryptoKey && this.masterKey);
        } catch (error) {
            console.warn('Failed to load master key from IndexedDB:', error);
        }
        return false;
    }

    /**
     * Clear the persisted master key from IndexedDB.
     * Called during logout to fully clear the session.
     */
    async clearPersistedMasterKey() {
        if (!chatDB) return;
        
        try {
            await Promise.all([
                chatDB.deleteSetting(MASTER_CRYPTO_KEY),
                chatDB.deleteSetting(MASTER_KEY_BYTES)
            ]);
        } catch (error) {
            console.warn('Failed to delete master key from IndexedDB:', error);
        }
        this.cryptoKey = null;
    }

    // =========================================================================
    // Access Token Management
    // =========================================================================

    /**
     * Refresh the access token using the refresh token.
     * - Web: Uses HttpOnly cookie (sent automatically via credentials: include)
     * - Electron: Uses Bearer token in Authorization header (no cookies)
     * Called during init() to restore session, and when access token expires.
     * @returns {Promise<boolean>} True if token was refreshed, false otherwise
     */
    async refreshAccessToken() {
        try {
            const headers = {
                'Content-Type': 'application/json',
                'X-Client-Platform': PLATFORM
            };
            
            // Electron: send refresh token as Bearer (no cookie available)
            if (PLATFORM === 'electron') {
                if (!this.refreshToken) {
                    return false;  // No refresh token to use
                }
                headers['Authorization'] = `Bearer ${this.refreshToken}`;
            }
            
            const response = await fetch(`${ORG_API_BASE}/auth/refresh`, {
                method: 'POST',
                headers,
                credentials: 'include'  // Still needed for web (harmless for Electron)
            });
            
            if (!response.ok) {
                this.accessToken = null;
                return false;
            }
            
            const data = await response.json();
            if (data.accessToken) {
                this.accessToken = data.accessToken;
                return true;
            }
            return false;
        } catch (error) {
            console.warn('Failed to refresh access token:', error);
            this.accessToken = null;
            return false;
        }
    }

    /**
     * Clear the access token from memory.
     */
    clearAccessToken() {
        this.accessToken = null;
    }

    getFormattedAccountId() {
        return formatAccountId(this.state.accountId);
    }

    subscribe(handler) {
        this.subscribers.add(handler);
        return () => this.subscribers.delete(handler);
    }

    notify() {
        const snapshot = this.getState();
        this.subscribers.forEach(handler => handler(snapshot));
    }

    updateStatus() {
        if (this.state.busy) {
            this.state.status = 'busy';
        } else if (this.masterKey || this.cryptoKey) {
            // Unlocked if we have either raw masterKey or persisted CryptoKey
            this.state.status = 'unlocked';
        } else if (this.state.accountId) {
            this.state.status = 'locked';
        } else {
            this.state.status = 'none';
        }
    }

    setState(patch) {
        Object.assign(this.state, patch);
        this.updateStatus();
        this.notify();
    }

    async init() {
        if (this.state.isReady) return;
        if (!chatDB) {
            this.setState({ isReady: true });
            return;
        }
        if (!chatDB.db && typeof chatDB.init === 'function') {
            await chatDB.init();
        }
        // Load account settings (accountId, credentialId, etc.)
        const settings = await chatDB.getSetting(ACCOUNT_SETTINGS_KEY).catch(() => null);
        if (settings?.accountId) {
            this.state.accountId = settings.accountId;
            this.state.credentialId = settings.credentialId || null;
            this.state.recoveryConfirmed = !!settings.recoveryConfirmed;
            
            // Try to restore session from persisted CryptoKey
            const hasKey = await this.loadMasterKey();
            if (hasKey) {
                // Electron: load refresh token from IndexedDB before attempting refresh
                if (PLATFORM === 'electron') {
                    this.refreshToken = await chatDB.getSetting(REFRESH_TOKEN_KEY).catch(() => null);
                }
                // Small delay to prevent rate limiting on burst page refreshes
                await new Promise(resolve => setTimeout(resolve, 1000));
                // Try to refresh the access token
                const tokenRefreshed = await this.refreshAccessToken().catch(() => false);
                if (tokenRefreshed) {
                    // Session fully restored - no passkey needed!
                    this.state.isReady = true;
                    this.updateStatus();
                    this.notify();
                    
                    // Initialize sync for restored session
                    this.initializeSync(false).catch(() => {});
                    
                    return;
                }
                // Token refresh failed but we have the key - might be offline
                // Keep the cryptoKey, user can still work locally
            }
            // No persisted key or token refresh failed - will need passkey
        }
        
        this.state.isReady = true;
        this.updateStatus();
        this.notify();
    }

    async persistSettings() {
        if (!chatDB) return;
        const payload = {
            accountId: this.state.accountId,
            credentialId: this.state.credentialId,
            recoveryConfirmed: this.state.recoveryConfirmed,
            updatedAt: Date.now()
        };
        await chatDB.saveSetting(ACCOUNT_SETTINGS_KEY, payload);
    }

    clearErrors() {
        this.setState({ error: null });
    }

    setError(error) {
        this.setState({ error: error });
    }

    // =========================================================================
    // Multi-Step Account Creation (New Flow)
    // =========================================================================

    /**
     * Step 1: Prepare a new account by requesting an ID from the server.
     * Calls /auth/init to get server-generated account ID and challenge.
     * Also generates the master key client-side.
     * @returns {Promise<string>} The server-generated account ID
     */
    async prepareAccount() {
        // Clean up any previous pending account
        this.cancelPendingAccount();

        // Request account ID and challenge from server
        const initData = await fetchJson('/auth/init', {});

        const accountId = normalizeAccountId(initData.accountId || initData.account_id);
        if (!accountId) {
            throw new Error('Server did not return an account ID.');
        }

        // Generate master key client-side (never sent to server)
        const masterKey = crypto.getRandomValues(new Uint8Array(32));

        this.pendingAccount = {
            accountId,
            masterKey,
            initData,       // Store server response for passkey registration
            credential: null,
            prfBytes: null,
            recoveryCode: null
        };

        return accountId;
    }

    /**
     * Step 2: Register a passkey for the pending account.
     * Uses the challenge from prepareAccount(), creates credential.
     * @returns {Promise<boolean>} True on success
     */
    async registerPasskeyForPreparedAccount() {
        if (!this.pendingAccount) {
            throw new Error('No pending account. Call prepareAccount() first.');
        }
        if (!this.state.passkeySupported) {
            throw new Error('Passkeys are not supported in this browser');
        }

        const { accountId, initData } = this.pendingAccount;

        // Build passkey creation options with PRF extension
        // Uses the challenge from the stored initData (from prepareAccount)
        const prfInput = await digestAccountId(accountId);
        const publicKey = buildCreationOptions(initData, accountId, prfInput);

        // Trigger passkey creation (user interaction required)
        let credential;
        try {
            credential = await navigator.credentials.create({ publicKey });
        } catch (error) {
            // User cancelled or other WebAuthn error - don't clear pending account
            // so they can retry with the same account number
            if (error.name === 'NotAllowedError') {
                this.state.error = 'Passkey creation was cancelled';
                this.notify();
                return false;
            }
            this.state.error = error.message || 'Passkey creation failed';
            this.notify();
            return false;
        }

        if (!credential) {
            this.state.error = 'Passkey creation failed';
            this.notify();
            return false;
        }

        // Extract PRF output
        const prfBytes = getPrfOutput(credential);
        if (!prfBytes) {
            this.state.prfSupported = false;
            this.state.error = 'Passkey did not return PRF output, your authenticator may not support this feature';
            this.notify();
            return false;
        }
        this.state.prfSupported = true;

        // Store credential for later registration
        this.pendingAccount.credential = credential;
        this.pendingAccount.prfBytes = prfBytes;

        return true;
    }

    /**
     * Step 3: Generate recovery code for the pending account.
     * @returns {string} The generated recovery code (5 words)
     */
    generateRecoveryForPreparedAccount() {
        if (!this.pendingAccount?.masterKey) {
            throw new Error('No pending account with master key.');
        }

        const recoveryCode = generateRecoveryCode();
        this.pendingAccount.recoveryCode = recoveryCode;
        return recoveryCode;
    }

    /**
     * Step 4: Complete account registration with the server.
     * Wraps master key, calls /auth/register, updates state.
     * @returns {Promise<boolean>} True on success
     */
    async completeAccountRegistration() {
        if (!this.pendingAccount) {
            throw new Error('No pending account.');
        }

        const { accountId, masterKey, credential, prfBytes, recoveryCode } = this.pendingAccount;

        if (!credential || !prfBytes) {
            throw new Error('Passkey not registered. Call registerPasskeyForPreparedAccount() first.');
        }
        if (!recoveryCode) {
            throw new Error('Recovery code not generated. Call generateRecoveryForPreparedAccount() first.');
        }

        // Wrap master key with passkey PRF
        const prfKey = await importAesKey(prfBytes);
        const wrappedPasskey = encodeWrappedKey(
            await encryptBytes(prfKey, masterKey)
        );

        // Wrap master key with recovery code
        const recoverySalt = crypto.getRandomValues(new Uint8Array(16));
        const recoveryKey = await deriveRecoveryKey(recoveryCode, recoverySalt);
        const recoveryPayload = await encryptBytes(recoveryKey, masterKey);
        const wrappedRecovery = encodeWrappedKey({
            ...recoveryPayload,
            salt: bytesToBase64(recoverySalt)
        });

        // Compute recovery code hash for server verification
        const recoveryCodeHash = await computeRecoveryCodeHash(recoveryCode, accountId);

        // Register with server
        const registerData = await fetchJson('/auth/register', {
            accountId,
            credential: credentialToJSON(credential),
            wrappedKeyPasskey: wrappedPasskey,
            wrappedKeyRecovery: wrappedRecovery,
            recoveryCodeHash
        });

        // Success - update state
        this.masterKey = masterKey;
        this.recoveryPayload = wrappedRecovery;
        this.state.accountId = accountId;
        this.state.credentialId = credential.id;
        this.state.recoveryConfirmed = true;  // User already confirmed before this step
        this.state.recoveryCode = null;

        // Handle access token from response
        if (registerData?.accessToken) {
            this.accessToken = registerData.accessToken;
        }
        // Electron: capture and persist refresh token to IndexedDB
        if (PLATFORM === 'electron' && registerData?.refreshToken) {
            this.refreshToken = registerData.refreshToken;
            await chatDB.saveSetting(REFRESH_TOKEN_KEY, registerData.refreshToken);
        }
        
        // Persist master key as non-extractable CryptoKey for session restoration
        await this.persistMasterKey(masterKey);

        // Clear pending account (don't zero masterKey since we're using it)
        this.pendingAccount = null;

        await this.persistSettings();
        this.updateStatus();
        this.notify();

        // Initialize and enable sync for new account
        await this.initializeSync(true);

        return true;
    }

    /**
     * Initialize sync service after login/unlock.
     * @param {boolean} enableForNewAccount - If true, enables sync (for new accounts)
     */
    async initializeSync(enableForNewAccount = false) {
        try {
            // Set credentials on sync service (avoids circular dependency)
            const masterKey = this.getMasterKey();
            const accessToken = this.getAccessToken();
            
            if (!masterKey || !accessToken) {
                console.warn('[AccountService] Cannot initialize sync without credentials');
                return;
            }
            
            // Provide refresh callback that syncService can call
            const refreshCallback = async () => {
                const success = await this.refreshAccessToken();
                if (success) {
                    return { accessToken: this.accessToken };
                }
                return null;
            };
            
            syncService.setCredentials(masterKey, accessToken, refreshCallback);
            await syncService.init();
            
            // Sync is automatically enabled when credentials are set
            // Start sync immediately
            syncService.sync().catch(err => {
                console.warn('[AccountService] Initial sync failed:', err);
            });
            syncService.startPeriodicSync();
        } catch (error) {
            console.warn('[AccountService] Failed to initialize sync:', error);
        }
    }

    /**
     * Cancel pending account creation and cleanup.
     * Zeros out the master key for security.
     */
    cancelPendingAccount() {
        if (this.pendingAccount?.masterKey) {
            this.pendingAccount.masterKey.fill(0);
        }
        this.pendingAccount = null;
    }

    /**
     * Check if there's a pending account in progress.
     * @returns {boolean}
     */
    hasPendingAccount() {
        return this.pendingAccount !== null;
    }

    /**
     * Get the pending account ID (for display during creation flow).
     * @returns {string|null}
     */
    getPendingAccountId() {
        return this.pendingAccount?.accountId || null;
    }

    // =========================================================================
    // Legacy Account Creation (single-step, kept for compatibility)
    // =========================================================================

    async createAccount() {
        if (!this.state.passkeySupported) {
            this.setError('Passkeys are not supported in this browser');
            return false;
        }
        if (this.state.busy) return false;
        this.setState({
            busy: true,
            action: 'create',
            error: null,
            recoveryCode: null,
            recoveryRequired: false
        });

        try {
            const masterKey = crypto.getRandomValues(new Uint8Array(32));
            const initData = await fetchJson('/auth/init', {});
            const accountId = normalizeAccountId(initData.accountId || initData.account_id);
            if (!accountId) {
                throw new Error('Account ID missing from server.');
            }

            const prfInput = await digestAccountId(accountId);
            const publicKey = buildCreationOptions(initData, accountId, prfInput);
            const credential = await navigator.credentials.create({ publicKey });
            if (!credential) {
                throw new Error('Passkey creation failed');
            }

            const prfBytes = getPrfOutput(credential);
            if (!prfBytes) {
                this.state.prfSupported = false;
                throw new Error('Passkey did not return PRF output');
            }
            this.state.prfSupported = true;

            const prfKey = await importAesKey(prfBytes);
            const wrappedPasskey = encodeWrappedKey(
                await encryptBytes(prfKey, masterKey)
            );

            const recoveryCode = generateRecoveryCode();
            const recoverySalt = crypto.getRandomValues(new Uint8Array(16));
            const recoveryKey = await deriveRecoveryKey(recoveryCode, recoverySalt);
            const recoveryPayload = await encryptBytes(recoveryKey, masterKey);
            const wrappedRecovery = encodeWrappedKey({
                ...recoveryPayload,
                salt: bytesToBase64(recoverySalt)
            });

            // Compute recovery code hash for server verification
            const recoveryCodeHash = await computeRecoveryCodeHash(recoveryCode, accountId);

            const registerData = await fetchJson('/auth/register', {
                accountId,
                credential: credentialToJSON(credential),
                wrappedKeyPasskey: wrappedPasskey,
                wrappedKeyRecovery: wrappedRecovery,
                recoveryCodeHash
            });

            this.masterKey = masterKey;
            this.recoveryPayload = wrappedRecovery;
            this.state.accountId = accountId;
            this.state.credentialId = credential.id;
            this.state.recoveryConfirmed = false;
            this.state.recoveryCode = recoveryCode;
            this.state.busy = false;
            this.state.action = null;
            this.state.error = null;
            
            // Handle access token from response
            if (registerData?.accessToken) {
                this.accessToken = registerData.accessToken;
            }
            // Electron: capture and persist refresh token to IndexedDB
            if (PLATFORM === 'electron' && registerData?.refreshToken) {
                this.refreshToken = registerData.refreshToken;
                await chatDB.saveSetting(REFRESH_TOKEN_KEY, registerData.refreshToken);
            }
            
            // Persist master key as non-extractable CryptoKey for session restoration
            await this.persistMasterKey(masterKey);
            
            await this.persistSettings();
            this.updateStatus();
            this.notify();
            
            // Initialize and enable sync for new account
            await this.initializeSync(true);
            
            return true;
        } catch (error) {
            this.setState({ busy: false, action: null });
            this.setError(toFriendlyError(error));
            return false;
        }
    }

    async unlockWithPasskey(accountIdInput, { mediation, silent = false } = {}) {
        if (this.state.busy) return false;
        if (!this.state.passkeySupported) {
            if (!silent) this.setError('Passkeys are not supported in this browser');
            return false;
        }

        // Check rate limit (skip for silent/auto-unlock attempts)
        if (!silent) {
            const rateLimitError = this.checkRateLimit();
            if (rateLimitError) {
                this.setError(rateLimitError);
                return false;
            }
        }

        const accountId = normalizeAccountId(accountIdInput || this.state.accountId);
        if (!accountId) {
            if (!silent) this.setError('Enter your account ID to continue');
            return false;
        }

        this.setState({ busy: true, action: 'unlock', error: null, recoveryRequired: false });
        try {
            const challengeData = await fetchJson('/auth/challenge', {
                accountId,
                credentialId: this.state.credentialId || undefined
            });
            if (challengeData?.wrappedKeyRecovery) {
                this.recoveryPayload = normalizeWrappedKeyPayload(challengeData.wrappedKeyRecovery);
            }

            const prfInput = await digestAccountId(accountId);
            const publicKey = buildRequestOptions(challengeData, prfInput);
            const assertion = await navigator.credentials.get({
                publicKey,
                mediation
            });

            if (!assertion) {
                throw new Error('Passkey request was cancelled');
            }

            const prfBytes = getPrfOutput(assertion);
            if (!prfBytes) {
                this.state.prfSupported = false;
                this.setState({
                    busy: false,
                    action: null,
                    recoveryRequired: true,
                    error: 'This passkey does not provide PRF output, use your recovery code'
                });
                return false;
            }
            this.state.prfSupported = true;

            const loginData = await fetchJson('/auth/login', {
                accountId,
                credentialId: assertion.id,
                assertion: assertionToJSON(assertion)
            });

            if (loginData?.wrappedKeyRecovery) {
                this.recoveryPayload = normalizeWrappedKeyPayload(loginData.wrappedKeyRecovery);
            }

            const wrappedPasskey = decodeWrappedKey(loginData?.wrappedKeyPasskey);
            if (!wrappedPasskey?.ciphertext || !wrappedPasskey?.iv) {
                throw new Error('Passkey unwrap data missing.');
            }

            const prfKey = await importAesKey(prfBytes);
            const masterKey = await decryptBytes(prfKey, wrappedPasskey);

            // Success - clear rate limit and update state
            this.clearRateLimit();
            this.masterKey = masterKey;
            this.state.accountId = accountId;
            this.state.credentialId = assertion.id;
            this.state.busy = false;
            this.state.action = null;
            this.state.error = null;
            this.state.recoveryRequired = false;
            
            // Handle access token from response
            if (loginData.accessToken) {
                this.accessToken = loginData.accessToken;
            }
            // Electron: capture and persist refresh token to IndexedDB
            if (PLATFORM === 'electron' && loginData.refreshToken) {
                this.refreshToken = loginData.refreshToken;
                await chatDB.saveSetting(REFRESH_TOKEN_KEY, loginData.refreshToken);
            }
            
            // Persist master key as non-extractable CryptoKey for session restoration
            await this.persistMasterKey(masterKey);
            
            await this.persistSettings();
            this.updateStatus();
            this.notify();
            
            // Initialize sync for existing account
            await this.initializeSync(false);
            
            return true;
        } catch (error) {
            // Record failed attempt for rate limiting (unless silent)
            if (!silent) {
                this.recordFailedAttempt();
            }

            const message = toFriendlyError(error);
            const shouldOfferRecovery = !!this.recoveryPayload ||
                message.includes('No passkey') ||
                message.toLowerCase().includes('prf') ||
                message.toLowerCase().includes('unwrap') ||
                message.toLowerCase().includes('decrypt');
            if (!silent && shouldOfferRecovery) {
                this.setState({
                    busy: false,
                    action: null,
                    recoveryRequired: true,
                    error: message
                });
            } else if (!silent) {
                this.setState({ busy: false, action: null, error: message });
            } else {
                this.setState({ busy: false, action: null });
            }
            return false;
        }
    }

    async unlockWithRecoveryCode(accountIdInput, recoveryCodeInput) {
        if (this.state.busy) return false;

        // Check rate limit
        const rateLimitError = this.checkRateLimit();
        if (rateLimitError) {
            this.setError(rateLimitError);
            return false;
        }

        const accountId = normalizeAccountId(accountIdInput || this.state.accountId);
        if (!accountId) {
            this.setError('Enter your account ID to continue');
            return false;
        }
        const normalizedCode = normalizeRecoveryCode(recoveryCodeInput);
        if (!isValidRecoveryCode(normalizedCode)) {
            this.setError('Recovery code should be five words');
            return false;
        }

        // Passkey is required for recovery (single passkey per account)
        if (!this.state.passkeySupported) {
            this.setError('Passkeys are required for account recovery but not supported in this browser');
            return false;
        }

        this.setState({ busy: true, action: 'recover', error: null });
        try {
            // 1. Compute recovery code hash to prove knowledge
            const recoveryCodeHash = await computeRecoveryCodeHash(normalizedCode, accountId);

            // 2. Call /auth/recovery with hash - server verifies before returning data
            const recoveryData = await fetchJson('/auth/recovery', { 
                accountId, 
                recoveryCodeHash 
            });
            
            const wrappedRecovery = normalizeWrappedKeyPayload(recoveryData?.wrappedKeyRecovery);
            const decoded = decodeWrappedKey(wrappedRecovery);
            if (!decoded?.ciphertext || !decoded?.iv || !decoded?.salt) {
                throw new Error('Recovery data missing from server.');
            }

            // 3. Decrypt master key using recovery code
            const saltBytes = base64ToBytes(decoded.salt);
            const recoveryKey = await deriveRecoveryKey(normalizedCode, saltBytes);
            const masterKey = await decryptBytes(recoveryKey, decoded);

            // 4. Create new passkey using challenge from recovery response
            const prfInput = await digestAccountId(accountId);
            const publicKey = buildCreationOptions(recoveryData, accountId, prfInput);
            
            const credential = await navigator.credentials.create({ publicKey });
            if (!credential) {
                throw new Error('Passkey creation was cancelled');
            }

            const prfBytes = getPrfOutput(credential);
            if (!prfBytes) {
                this.state.prfSupported = false;
                throw new Error('Passkey did not return PRF output, recovery requires a passkey with PRF support');
            }
            this.state.prfSupported = true;

            // 5. Wrap master key with new passkey's PRF
            const prfKey = await importAesKey(prfBytes);
            const wrappedPasskey = encodeWrappedKey(
                await encryptBytes(prfKey, masterKey)
            );

            // 6. Complete recovery with new passkey
            const completeData = await fetchJson('/auth/recovery/complete', {
                accountId,
                credential: credentialToJSON(credential),
                wrappedKeyPasskey: wrappedPasskey
            });

            // 7. Success - clear rate limit and update state
            this.clearRateLimit();
            this.masterKey = masterKey;
            this.recoveryPayload = wrappedRecovery;
            this.state.accountId = accountId;
            this.state.credentialId = credential.id;
            this.state.busy = false;
            this.state.action = null;
            this.state.error = null;
            this.state.recoveryRequired = false;
            
            // Handle access token from response
            if (completeData?.accessToken) {
                this.accessToken = completeData.accessToken;
            }
            // Electron: capture and persist refresh token to IndexedDB
            if (PLATFORM === 'electron' && completeData?.refreshToken) {
                this.refreshToken = completeData.refreshToken;
                await chatDB.saveSetting(REFRESH_TOKEN_KEY, completeData.refreshToken);
            }
            
            // Persist master key as non-extractable CryptoKey for session restoration
            await this.persistMasterKey(masterKey);
            
            await this.persistSettings();
            this.updateStatus();
            this.notify();

            // Initialize sync for existing account
            await this.initializeSync(false);

            return true;
        } catch (error) {
            console.error('[AccountService] Recovery failed:', error);
            // Record failed attempt for rate limiting
            this.recordFailedAttempt();
            this.setState({ busy: false, action: null });
            this.setError(toFriendlyError(error));
            return false;
        }
    }

    confirmRecoveryCodeSaved() {
        this.state.recoveryConfirmed = true;
        this.state.recoveryCode = null;
        this.persistSettings().catch(() => {});
        this.updateStatus();
        this.notify();
    }

    /**
     * Clear the master key from memory.
     * We zero the buffer to reduce exposure window, though JS GC may retain copies.
     * This is the best-effort approach available in browser environments.
     */
    /**
     * Handle token invalidation (e.g., after recovery on another device).
     * Clears all session data and forces re-authentication.
     * Called automatically by fetchJson when 401 INVALID_TOKEN is detected.
     */
    async handleTokenInvalidation() {
        console.warn('[AccountService] Token invalidated - clearing session');
        
        // Clear in-memory state
        if (this.masterKey) {
            this.masterKey.fill(0);
        }
        this.masterKey = null;
        this.cryptoKey = null;
        this.accessToken = null;
        // Electron: clear invalid refresh token
        if (PLATFORM === 'electron') {
            this.refreshToken = null;
            await chatDB.deleteSetting(REFRESH_TOKEN_KEY).catch(() => {});
        }
        
        // Clear persisted CryptoKey from IndexedDB
        await this.clearPersistedMasterKey();
        
        // Update status to 'locked' and notify UI
        this.updateStatus();
        this.notify();
    }

    /**
     * Lock the account - clears keys from memory but keeps persisted data.
     * User can re-unlock with passkey without needing to re-login to server.
     */
    lock() {
        if (this.masterKey) {
            this.masterKey.fill(0);
        }
        this.masterKey = null;
        this.cryptoKey = null;  // Clear from memory (IndexedDB copy remains for re-unlock)
        this.accessToken = null;
        this.updateStatus();
        this.notify();
    }

    /**
     * Full logout - clears all session data and notifies server.
     * This is different from lock() in that it:
     * - Clears the persisted CryptoKey from IndexedDB
     * - Invalidates the refresh token on the server
     * - Requires full passkey re-authentication to log back in
     */
    async logout() {
        // Stop sync and clear sync data
        try {
            await syncService.clearAll();
        } catch (error) {
            console.warn('Failed to clear sync data:', error);
        }
        
        // Clear local state
        if (this.masterKey) {
            this.masterKey.fill(0);
        }
        this.masterKey = null;
        this.cryptoKey = null;
        this.accessToken = null;
        // Electron: clear persisted refresh token
        if (PLATFORM === 'electron') {
            this.refreshToken = null;
            await chatDB.deleteSetting(REFRESH_TOKEN_KEY).catch(() => {});
        }
        
        // Clear persisted CryptoKey from IndexedDB
        await this.clearPersistedMasterKey();
        
        // Notify server to invalidate refresh token
        try {
            await fetch(`${ORG_API_BASE}/auth/logout`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Client-Platform': PLATFORM
                },
                credentials: 'include'  // Sends HttpOnly cookie to be invalidated
            });
        } catch (error) {
            // Server logout failure shouldn't prevent local logout
            console.warn('Server logout failed:', error);
        }
        
        this.updateStatus();
        this.notify();
    }

    async clearLocalAccount() {
        await this.logout();  // Use logout instead of lock for full cleanup
        this.state.accountId = null;
        this.state.credentialId = null;
        this.state.recoveryConfirmed = false;
        this.state.recoveryCode = null;
        this.state.recoveryRequired = false;
        this.recoveryPayload = null;
        // Delete account settings from IndexedDB (not just set to null)
        if (chatDB) {
            await chatDB.deleteSetting(ACCOUNT_SETTINGS_KEY).catch(() => {});
        }
        this.updateStatus();
        this.notify();
    }

    async maybeAutoUnlock() {
        // Skip if already unlocked (session restored from IndexedDB)
        if (this.masterKey || this.cryptoKey) return;
        
        if (!this.state.accountId || !this.state.passkeySupported || this.state.busy) return;
        if (typeof PublicKeyCredential?.isConditionalMediationAvailable !== 'function') return;
        const supportsConditional = await PublicKeyCredential.isConditionalMediationAvailable();
        if (!supportsConditional) return;
        await this.unlockWithPasskey(this.state.accountId, { mediation: 'silent', silent: true });
    }

    formatAccountId(accountId) {
        return formatAccountId(accountId);
    }

    normalizeAccountId(accountId) {
        return normalizeAccountId(accountId);
    }
}

export default new AccountService();
