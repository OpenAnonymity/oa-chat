/**
 * Account service: passkey-backed master key management.
 *
 * SECURITY ARCHITECTURE
 * ---------------------
 * Master Key: 256-bit random key generated client-side via crypto.getRandomValues().
 * Never leaves the browser in plaintext; only wrapped forms are sent to the server.
 *
 * SSO accounts follow a Confer-style split:
 *   1. OAuth authenticates the account and authorizes access to ciphertext.
 *   2. A local WebAuthn PRF result derives an AES-GCM wrapping key.
 *   3. That wrapping key decrypts the random account master key.
 *
 * Legacy passkey-only accounts retain their account-number/recovery flow only
 * for compatibility and migration.
 *
 * Server stores: credential public keys, wrapped keys (ciphertext only).
 * Server never sees: master key, PRF output, recovery code.
 *
 * Threat model:
 *   - Compromised server cannot decrypt data (no plaintext keys).
 *   - A fresh device or a logged-out browser requires the encryption passkey.
 *   - An unlocked browser keeps non-extractable CryptoKeys in IndexedDB so a
 *     page reload does not repeatedly prompt for the passkey.
 *   - Legacy recovery-code brute force is mitigated by Argon2id.
 */

import { ORG_API_BASE, ORG_AUTH_ORIGIN } from './orgEndpoints.js';
import { chatDB } from '../db.js';
import { generateRecoveryCode, isValidRecoveryCode, normalizeRecoveryCode } from './recoveryCode.js';
import sessionService from './sessionService.js';
import syncService from './encryptedSyncService.js';
import {
    createEncryptionKeyWrapper,
    createEncryptionKeyWrapperFromPrf,
    unlockEncryptionKeyring,
    unlockEncryptionKeyringFromPrf
} from './encryptionPasskey.js';
import { withAccountDataLock } from './accountDataLock.js';

const ACCOUNT_SETTINGS_KEY = 'account-settings';
const ACCOUNT_KEY_BUNDLE = 'account-key-bundle-v1';
const ACCOUNT_MASTER_CRYPTO_KEY = 'account-master-crypto-key';
const ACCOUNT_MASTER_KEY_BYTES = 'account-master-key-bytes';  // Legacy; removed after migration
const ACCOUNT_SYNC_DERIVATION_KEY = 'account-sync-derivation-key';
const ACCOUNT_SYNC_ID_KEY = 'account-sync-id-key';
const ACCOUNT_REQUEST_TIMEOUT_MS = 10000;
const OAUTH_COMPLETION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const OAUTH_PROVIDERS = Object.freeze({
    google: Object.freeze({ label: 'Google' })
});

export function inferPersistedEncryptionMode(settings) {
    if (settings?.encryptionMode) return settings.encryptionMode;
    if (settings?.credentialId) return 'LEGACY_PASSKEY';
    if (
        settings?.encryptionCredentialId &&
        settings?.googleLinked
    ) {
        return 'PRF';
    }
    return null;
}

export function oauthSessionNeedsEmailRefresh(session) {
    const mode = session?.encryptionMode;
    const email = typeof session?.email === 'string'
        ? session.email.trim()
        : '';
    return !email && (mode === 'PRF_PENDING' || mode === 'LEGACY_SSO');
}

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

/**
 * Fetch JSON from the auth API.
 * SuperTokens adds cookie/header session state and performs one refresh/retry
 * automatically when a protected request has an expired access token.
 */
async function fetchJson(
    path,
    body,
    {
        timeoutMs = ACCOUNT_REQUEST_TIMEOUT_MS,
        method = 'POST'
    } = {}
) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
        response = await sessionService.fetch(`${ORG_API_BASE}${path}`, {
            method,
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: method === 'GET' || method === 'HEAD'
                ? undefined
                : JSON.stringify(body || {}),
            signal: controller.signal
        });
    } finally {
        clearTimeout(timeoutId);
    }
    let data = null;
    try {
        data = await response.json();
    } catch (error) {
        data = null;
    }
    if (!response.ok) {
        // Detect token invalidation (e.g., after recovery on another device)
        if (response.status === 401 && data?.code === 'INVALID_TOKEN') {
            throw new TokenInvalidatedError(data?.error || data?.message);
        }
        const detail = data?.detail;
        const message = data?.error ||
            data?.message ||
            (typeof detail === 'object' ? detail?.error || detail?.message : detail) ||
            response.statusText ||
            'Request failed';
        const requestError = new Error(message);
        requestError.status = response.status;
        throw requestError;
    }
    return data || {};
}

function getOAuthProvider(provider) {
    const config = OAUTH_PROVIDERS[provider];
    if (!config) throw new Error('Unsupported sign-in provider');
    return config;
}

function waitForOAuthPopup(popup, provider, timeoutMs = 5 * 60 * 1000) {
    const providerConfig = getOAuthProvider(provider);
    const orgOrigin = ORG_AUTH_ORIGIN;

    return new Promise((resolve, reject) => {
        let settled = false;
        const finish = (callback) => {
            if (settled) return;
            settled = true;
            window.removeEventListener('message', handleMessage);
            clearInterval(closePoll);
            clearTimeout(timeout);
            callback();
        };
        const handleMessage = (event) => {
            if (
                event.origin !== orgOrigin ||
                event.source !== popup ||
                event.data?.type !== `oa-${provider}-auth`
            ) {
                return;
            }
            if (event.data.ok) {
                const completionToken = event.data.completionToken;
                if (!OAUTH_COMPLETION_TOKEN_PATTERN.test(completionToken)) {
                    finish(() => reject(new Error(
                        `${providerConfig.label} sign in completion was invalid`
                    )));
                    return;
                }
                finish(() => resolve(completionToken));
            } else {
                finish(() => reject(new Error(
                    event.data.error || `${providerConfig.label} sign in failed`
                )));
            }
        };
        const closePoll = setInterval(() => {
            if (popup.closed) {
                finish(() => reject(new Error(
                    `${providerConfig.label} sign in was cancelled`
                )));
            }
        }, 500);
        const timeout = setTimeout(() => {
            try {
                popup.close();
            } catch (error) {
                // The popup may already have navigated or closed.
            }
            finish(() => reject(new Error(
                `${providerConfig.label} sign in timed out`
            )));
        }, timeoutMs);

        window.addEventListener('message', handleMessage);
    });
}

export function toFriendlyAccountError(error) {
    if (!error) return 'Unexpected error';
    if (error.name === 'AbortError') return 'Request timed out, please try again';
    if (error.name === 'NotAllowedError') return 'Passkey prompt was cancelled';
    if (error.code === 'ENCRYPTION_PASSKEY_NOT_AVAILABLE') return error.message;
    if (error.code === 'ACCOUNT_KEY_PERSIST_FAILED') return error.message;
    if (error.name === 'OperationError') return 'Invalid recovery code, please check and try again';
    if (error.name === 'TokenInvalidatedError') return 'Session expired, please sign in again';
    return error.message || 'Unexpected error';
}

const toFriendlyError = toFriendlyAccountError;

export function toFriendlyOAuthError(error) {
    if (Number(error?.status) >= 500) {
        return 'Google sign-in is temporarily unavailable. Please retry.';
    }
    return toFriendlyError(error);
}

/**
 * Complete a popup OAuth handoff through an intercepted account API request.
 *
 * The callback is a top-level navigation, so the browser SDK cannot observe a
 * SuperTokens front-token response header there. The callback instead sends a
 * short-lived, single-use completion token to its exact opener. Posting that
 * token through the SDK creates the HttpOnly session in an intercepted
 * response, after which normal session verification and reads are reliable.
 */
export async function bootstrapOAuthSession(
    provider,
    completionToken,
    {
        completeSession = () => fetchJson(`/auth/${provider}/complete`, {
            completionToken
        }),
        fetchSession = () => fetchJson(`/auth/${provider}/session`, null, {
            method: 'GET'
        }),
        verifySession = () => sessionService.verifySession()
    } = {}
) {
    const providerConfig = getOAuthProvider(provider);
    if (!OAUTH_COMPLETION_TOKEN_PATTERN.test(completionToken)) {
        throw new Error(`${providerConfig.label} sign in completion was invalid`);
    }

    await completeSession();
    const verified = await verifySession().catch(() => false);
    if (!verified) {
        throw new Error(
            `${providerConfig.label} session could not be established`
        );
    }
    return fetchSession();
}

export async function bootstrapDesktopOAuthSession(
    provider,
    expectedAccountId,
    {
        bridge = window.electronAPI,
        initializeSession = () => sessionService.init(),
        verifySession = () => sessionService.verifySession(),
        fetchSession = () => fetchJson(`/auth/${provider}/session`, null, {
            method: 'GET'
        })
    } = {}
) {
    const providerConfig = getOAuthProvider(provider);
    if (
        bridge?.isElectron !== true ||
        typeof bridge.authStartBrowserSignIn !== 'function'
    ) {
        throw new Error('Secure desktop sign-in bridge is unavailable');
    }
    await initializeSession();
    const desktopResult = await bridge.authStartBrowserSignIn(
        provider,
        expectedAccountId || null
    );
    const verified = await verifySession().catch(() => false);
    if (!verified) {
        throw new Error(`${providerConfig.label} session could not be established`);
    }
    const session = await fetchSession();
    const passkey = desktopResult?.passkey;
    if (
        passkey
        && (passkey.operation === 'create' || passkey.operation === 'get')
        && typeof passkey.credentialId === 'string'
        && passkey.credentialId
        && typeof passkey.prf === 'string'
        && passkey.prf
    ) {
        return { ...session, desktopPasskey: { ...passkey } };
    }
    return session;
}

class AccountService {
    constructor() {
        this.state = {
            isReady: false,
            authBootstrapComplete: false,
            accountId: null,
            credentialId: null,
            encryptionCredentialId: null,
            encryptionMode: null,
            recoveryConfirmed: false,
            recoveryCode: null,
            recoveryRequired: false,
            busy: false,
            action: null,
            error: null,
            status: 'none',
            sessionVerified: false,  // True after SuperTokens confirms a current session
            // Becomes true only after the account-bound local wallet scope is active.
            accountScopeReady: false,
            // Becomes true after this account's first encrypted sync has settled successfully.
            ticketSyncReady: false,
            googleLinked: false,
            oauthProvider: null,
            oauthEmail: null,
            oauthSetupRequired: false,
            oauthRecoveryRequired: false,
            oauthKeyringRequired: false,
            oauthLegacyPasskeyRequired: false,
            passkeySupported: typeof window !== 'undefined' && !!window.PublicKeyCredential,
            prfSupported: null,
            rateLimited: false,
            rateLimitResetAt: null
        };
        this.masterKey = null;
        this.recoveryPayload = null;
        this.keyringWrappers = [];
        this.subscribers = new Set();

        // Rate limiting state (not persisted - resets on page reload)
        this.failedAttempts = [];
        this.lockedUntil = 0;

        // Pending account for multi-step creation flow
        // Holds { accountId, masterKey, credential, prfBytes, recoveryCode } during creation
        this.pendingAccount = null;
        // The encryption key is persisted locally. Session tokens are owned by
        // SuperTokens (HttpOnly cookies in web, isolated preload/main in Electron).
        this.cryptoKey = null;  // Non-extractable CryptoKey for encryption
        this.syncDerivationKey = null;
        this.syncIdKey = null;
        this.localAccountContinuity = false;
        // Invalidates async scope activation/sync work across lock, logout,
        // account switching, and a newer initialization attempt.
        this.syncInitializationGeneration = 0;

        sessionService.onSessionExpired(() => this.handleTokenInvalidation());

        syncService.subscribe(({ event }) => {
            if (!['sync_complete', 'status_checked'].includes(event)) return;
            if (
                !this.state.accountId ||
                syncService.accountId !== this.state.accountId ||
                this.state.sessionVerified !== true ||
                this.state.accountScopeReady !== true ||
                this.state.ticketSyncReady === true
            ) return;
            this.state.ticketSyncReady = true;
            this.notify();
        });
    }

    getState() {
        return {
            ...this.state,
            // The Account UI only needs to know whether an explicit local reset
            // is available. Do not make rendering the recovery action depend on
            // exposing or formatting the persisted account identifier itself.
            hasSavedAccountBinding: Boolean(
                this.state.accountId || this.localAccountContinuity
            )
        };
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

    getSyncKeyMaterial() {
        if (!this.syncDerivationKey || !this.syncIdKey) return null;
        return {
            derivationKey: this.syncDerivationKey,
            idKey: this.syncIdKey
        };
    }
    // =========================================================================
    // Master Key Persistence (Non-Extractable CryptoKey in IndexedDB)
    // =========================================================================

    /**
     * Persist the master key in IndexedDB.
     * Stores only non-extractable CryptoKeys. Raw master-key bytes are never
     * persisted. Separate imports give each primitive the minimum key usages it
     * needs while preserving the existing encrypted-sync format.
     */
    async persistMasterKey(
        masterKeyBytes,
        accountId = this.state.accountId,
        { isCurrent = null } = {}
    ) {
        if (!chatDB) return;
        const normalizedAccountId = normalizeAccountId(accountId);
        if (!normalizedAccountId) {
            throw new Error('Cannot persist an encryption key without an account');
        }
        
        const [cryptoKey, syncDerivationKey, syncIdKey] = await Promise.all([
            crypto.subtle.importKey(
                'raw',
                masterKeyBytes,
                { name: 'AES-GCM' },
                false,
                ['encrypt', 'decrypt']
            ),
            crypto.subtle.importKey(
                'raw',
                masterKeyBytes,
                { name: 'HKDF' },
                false,
                ['deriveKey']
            ),
            crypto.subtle.importKey(
                'raw',
                masterKeyBytes,
                { name: 'HMAC', hash: 'SHA-256' },
                false,
                ['sign']
            )
        ]);

        const persisted = await this.persistCryptoKeyBundle(
            normalizedAccountId,
            cryptoKey,
            syncDerivationKey,
            syncIdKey,
            isCurrent
        );
        if (persisted === false || (isCurrent && !isCurrent())) return false;
        this.cryptoKey = cryptoKey;
        this.syncDerivationKey = syncDerivationKey;
        this.syncIdKey = syncIdKey;
        return true;
    }

    async persistCryptoKeyBundle(
        accountId,
        cryptoKey,
        syncDerivationKey,
        syncIdKey,
        isCurrent = null
    ) {
        return withAccountDataLock(async () => {
            const settings = await chatDB.getSetting(ACCOUNT_SETTINGS_KEY);
            if (
                normalizeAccountId(settings?.accountId) !==
                normalizeAccountId(accountId)
            ) {
                throw new Error(
                    'Account changed before the encryption key could be saved'
                );
            }
            if (isCurrent && !isCurrent()) return false;
            await chatDB.updateSettings(
                [{
                    key: ACCOUNT_KEY_BUNDLE,
                    value: {
                        accountId: normalizeAccountId(accountId),
                        cryptoKey,
                        derivationKey: syncDerivationKey,
                        idKey: syncIdKey,
                        version: 1
                    }
                }],
                [
                    ACCOUNT_MASTER_CRYPTO_KEY,
                    ACCOUNT_MASTER_KEY_BYTES,
                    ACCOUNT_SYNC_DERIVATION_KEY,
                    ACCOUNT_SYNC_ID_KEY
                ]
            );
            return true;
        });
    }

    /**
     * Load the persisted master key from IndexedDB.
     * Called during init() to restore session on page refresh.
     * @returns {Promise<boolean>} True if key was loaded, false otherwise
     */
    async loadMasterKey() {
        if (!chatDB) return false;
        
        try {
            const [
                bundle,
                cryptoKey,
                syncDerivationKey,
                syncIdKey,
                legacyKeyBytes
            ] = await Promise.all([
                chatDB.getSetting(ACCOUNT_KEY_BUNDLE),
                chatDB.getSetting(ACCOUNT_MASTER_CRYPTO_KEY),
                chatDB.getSetting(ACCOUNT_SYNC_DERIVATION_KEY),
                chatDB.getSetting(ACCOUNT_SYNC_ID_KEY),
                chatDB.getSetting(ACCOUNT_MASTER_KEY_BYTES)
            ]);

            const expectedAccountId = normalizeAccountId(this.state.accountId);
            if (
                bundle?.accountId === expectedAccountId &&
                bundle.cryptoKey instanceof CryptoKey &&
                bundle.derivationKey instanceof CryptoKey &&
                bundle.idKey instanceof CryptoKey
            ) {
                this.cryptoKey = bundle.cryptoKey;
                this.syncDerivationKey = bundle.derivationKey;
                this.syncIdKey = bundle.idKey;
                return true;
            }

            // Once a bundle exists, never fall back to the old unbound key
            // records. A mismatched or malformed bundle is safer to reject than
            // to guess which account the legacy records belong to.
            if (bundle !== undefined && bundle !== null) {
                return false;
            }

            if (
                expectedAccountId &&
                this.localAccountContinuity &&
                cryptoKey instanceof CryptoKey &&
                syncDerivationKey instanceof CryptoKey &&
                syncIdKey instanceof CryptoKey
            ) {
                await this.persistCryptoKeyBundle(
                    expectedAccountId,
                    cryptoKey,
                    syncDerivationKey,
                    syncIdKey
                );
                this.cryptoKey = cryptoKey;
                this.syncDerivationKey = syncDerivationKey;
                this.syncIdKey = syncIdKey;
                return true;
            }

            // One-time migration from builds that persisted raw key bytes.
            if (
                expectedAccountId &&
                this.localAccountContinuity &&
                legacyKeyBytes instanceof Uint8Array
            ) {
                const migrated = new Uint8Array(legacyKeyBytes);
                try {
                    await this.persistMasterKey(migrated, expectedAccountId);
                    return true;
                } finally {
                    migrated.fill(0);
                }
            }
        } catch (error) {
            console.warn('Failed to load master key from IndexedDB:', error);
        }
        return false;
    }

    /**
     * Clear the persisted master key from IndexedDB.
     * Called during logout to fully clear the session.
     */
    async clearPersistedMasterKey(accountId = this.state.accountId) {
        if (!chatDB) return;
        
        try {
            await withAccountDataLock(async () => {
                const expectedAccountId = normalizeAccountId(accountId);
                const bundle = await chatDB.getSetting(ACCOUNT_KEY_BUNDLE);
                if (
                    bundle?.accountId &&
                    normalizeAccountId(bundle.accountId) !== expectedAccountId
                ) {
                    // Another tab/account owns the persisted bundle. Leave it
                    // untouched, but still clear this instance's memory below.
                    return;
                }
                await chatDB.updateSettings(
                    [],
                    [
                        ACCOUNT_KEY_BUNDLE,
                        ACCOUNT_MASTER_CRYPTO_KEY,
                        ACCOUNT_MASTER_KEY_BYTES,
                        ACCOUNT_SYNC_DERIVATION_KEY,
                        ACCOUNT_SYNC_ID_KEY
                    ]
                );
            });
        } catch (error) {
            console.warn('Failed to delete master key from IndexedDB:', error);
        }
        this.cryptoKey = null;
        this.syncDerivationKey = null;
        this.syncIdKey = null;
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
        } else if (this.cryptoKey && this.getSyncKeyMaterial()) {
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

    completeAuthBootstrap() {
        if (this.state.authBootstrapComplete === true) return;
        this.state.authBootstrapComplete = true;
        this.notify();
    }

    async waitForAuthBootstrap() {
        await this.init();
        if (this.state.authBootstrapComplete === true) return this.getState();
        return new Promise(resolve => {
            const unsubscribe = this.subscribe(snapshot => {
                if (snapshot.authBootstrapComplete !== true) return;
                unsubscribe();
                resolve(snapshot);
            });
        });
    }

    async init() {
        if (this.state.isReady) return;
        try {
            await sessionService.init();
            if (!chatDB) {
                this.setState({ isReady: true });
                this.completeAuthBootstrap();
                return;
            }
            if (!chatDB.db && typeof chatDB.init === 'function') {
                await chatDB.init();
            }
            // Load account settings (accountId, credentialId, etc.)
            const settings = await chatDB.getSetting(ACCOUNT_SETTINGS_KEY).catch(() => null);
            if (settings?.accountId) {
                this.localAccountContinuity = true;
                this.state.accountId = settings.accountId;
                syncService.setLocalAccountScope(settings.accountId);
                this.state.credentialId = settings.credentialId || null;
                this.state.encryptionCredentialId =
                    settings.encryptionCredentialId || null;
                this.state.encryptionMode = inferPersistedEncryptionMode(settings);
                this.state.recoveryConfirmed = !!settings.recoveryConfirmed;
                this.state.googleLinked = !!settings.googleLinked;
                this.state.oauthProvider = settings.lastOAuthProvider || null;
                this.state.oauthEmail = typeof settings.oauthEmail === 'string'
                    ? settings.oauthEmail.trim() || null
                    : null;

                // Try to restore session from persisted CryptoKey.
                const hasKey = await this.loadMasterKey();
                if (hasKey) {
                    // Expose the cached identity immediately, but keep the
                    // account control non-interactive until verification ends.
                    this.state.isReady = true;
                    this.updateStatus();
                    this.notify();

                    void this.verifySessionInBackground();
                    return;
                }
                // No persisted key - the verified OAuth session may need a passkey.
            } else {
                // A previous account can leave its active data scope behind if the
                // browser closes between clearing account settings and completing
                // logout. Preserve that account-bound wallet in its scoped snapshot
                // and restore the anonymous wallet before extensions can observe a
                // billing-ready zero balance.
                await syncService.deactivateAccountScope(null);
                syncService.setLocalAccountScope(null);
            }

            this.state.isReady = true;
            this.updateStatus();
            this.notify();

            if (this.state.accountId && this.state.googleLinked) {
                void this.restoreOAuthLockedSession()
                    .catch(() => false)
                    .finally(() => this.completeAuthBootstrap());
                return;
            }
            this.completeAuthBootstrap();
        } catch (error) {
            this.completeAuthBootstrap();
            throw error;
        }
    }

    /** Verify the persisted SuperTokens session without blocking app startup. */
    async verifySessionInBackground() {
        try {
            const expectedAccountId = normalizeAccountId(this.state.accountId);
            const sessionVerified = await sessionService.verifySession().catch(() => false);
            if (
                !sessionVerified ||
                !expectedAccountId ||
                normalizeAccountId(this.state.accountId) !== expectedAccountId
            ) return;

            // Restore the account footer as soon as the existing session is
            // confirmed. The account-bound cached email avoids holding the
            // visible identity behind a second profile request.
            this.state.sessionVerified = true;
            this.updateStatus();
            this.notify();
            this.completeAuthBootstrap();

            // Existing cached identities can refresh quietly after the prior
            // burst-protection delay. Older settings without an email migrate
            // immediately so their first upgraded load is also responsive.
            if (this.state.oauthEmail) {
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
            if (
                this.state.sessionVerified !== true ||
                normalizeAccountId(this.state.accountId) !== expectedAccountId
            ) return;

            await this.refreshOAuthLinkStatuses();
            if (
                this.state.sessionVerified !== true ||
                normalizeAccountId(this.state.accountId) !== expectedAccountId
            ) return;
            await this.persistSettings();
            this.notify();
            // Initialize sync for restored session
            this.initializeSync(false).catch(() => {});
            // If verification failed, local data remains usable until re-authentication.
        } catch (error) {
            console.warn('[AccountService] Background session verification failed:', error);
        } finally {
            this.completeAuthBootstrap();
        }
    }

    getLinkedOAuthProviders() {
        return Object.keys(OAUTH_PROVIDERS).filter(
            provider => this.state[`${provider}Linked`]
        );
    }

    async fetchOAuthKeyring() {
        if (!this.state.sessionVerified) {
            throw new Error('Sign in before unlocking encrypted data');
        }
        const keyring = await fetchJson('/auth/keyring', null, {
            method: 'GET'
        });
        if (
            this.state.accountId &&
            normalizeAccountId(keyring.accountId) !== this.state.accountId
        ) {
            throw new Error('The encrypted keyring belongs to a different account');
        }
        this.keyringWrappers = Array.isArray(keyring.wrappers)
            ? keyring.wrappers
            : [];
        this.state.encryptionMode = keyring.encryptionMode || null;
        this.recoveryPayload = keyring.legacyWrappedKeyRecovery
            ? normalizeWrappedKeyPayload(keyring.legacyWrappedKeyRecovery)
            : null;
        return keyring;
    }

    async restoreOAuthLockedSession() {
        const linkedProviders = this.getLinkedOAuthProviders();
        if (
            !this.state.accountId ||
            linkedProviders.length === 0 ||
            this.getSyncKeyMaterial()
        ) {
            return false;
        }
        if (!await sessionService.verifySession().catch(() => false)) {
            return false;
        }

        const preferredProvider = linkedProviders.includes(this.state.oauthProvider)
            ? this.state.oauthProvider
            : linkedProviders[0];
        const providers = [
            preferredProvider,
            ...linkedProviders.filter(provider => provider !== preferredProvider)
        ];

        for (const provider of providers) {
            try {
                const session = await fetchJson(`/auth/${provider}/session`, null, {
                    method: 'GET'
                });
                if (normalizeAccountId(session.accountId) !== this.state.accountId) {
                    continue;
                }
                const keyring = await this.fetchOAuthKeyring();
                const mode = keyring.encryptionMode;
                if (oauthSessionNeedsEmailRefresh({
                    ...session,
                    encryptionMode: mode
                })) {
                    this.setState({
                        sessionVerified: false,
                        oauthProvider: provider,
                        oauthEmail: null,
                        encryptionMode: mode,
                        oauthSetupRequired: false,
                        oauthRecoveryRequired: false,
                        oauthKeyringRequired: false,
                        oauthLegacyPasskeyRequired: false,
                        error: `Continue with ${OAUTH_PROVIDERS[provider].label} again so OA can label your encryption passkey`
                    });
                    return true;
                }
                this.setState({
                    sessionVerified: true,
                    oauthProvider: provider,
                    oauthEmail: session.email || null,
                    encryptionMode: mode,
                    oauthSetupRequired: mode === 'PRF_PENDING',
                    oauthRecoveryRequired: mode === 'LEGACY_SSO',
                    oauthKeyringRequired: mode === 'PRF',
                    oauthLegacyPasskeyRequired:
                        mode === 'LEGACY_PASSKEY',
                    error: null
                });
                return true;
            } catch (error) {
                // Try the next locally known linked provider.
            }
        }
        return false;
    }

    async refreshOAuthLinkStatuses() {
        if (!this.state.sessionVerified || !this.state.accountId) return false;
        let anyLinked = false;
        for (const provider of Object.keys(OAUTH_PROVIDERS)) {
            try {
                const session = await fetchJson(`/auth/${provider}/session`, null, {
                    method: 'GET'
                });
                this.state[`${provider}Linked`] = true;
                if (session.email) {
                    this.state.oauthEmail = session.email;
                }
                anyLinked = true;
            } catch (error) {
                if (error?.status === 404) {
                    this.state[`${provider}Linked`] = false;
                }
            }
        }
        return anyLinked;
    }

    async persistSettings() {
        if (!chatDB) return;
        const payload = {
            accountId: this.state.accountId,
            credentialId: this.state.credentialId,
            encryptionCredentialId: this.state.encryptionCredentialId,
            encryptionMode: this.state.encryptionMode,
            recoveryConfirmed: this.state.recoveryConfirmed,
            googleLinked: this.state.googleLinked,
            lastOAuthProvider: this.state.oauthProvider,
            oauthEmail: this.state.oauthEmail,
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
        await fetchJson('/auth/register', {
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

        this.state.sessionVerified = await sessionService.doesSessionExist();
        
        // Clear pending account (don't zero masterKey since we're using it)
        this.pendingAccount = null;

        await this.persistSettings();
        // Persist only after account settings bind the bundle to this account.
        await this.persistMasterKey(masterKey);
        this.updateStatus();
        this.notify();

        // Initialize and enable sync for new account
        await this.initializeSync(true);

        return true;
    }

    /**
     * Initialize sync service after login/unlock.
     * @param {boolean} enableForNewAccount - If true, enables sync (for new accounts)
     * @param {{awaitInitialSync?: boolean, throwOnFailure?: boolean}} options
     *   Recovery callers can await the first sync and observe failures so they can
     *   retry. Startup callers keep the historical fire-and-forget behavior.
     */
    async initializeSync(
        enableForNewAccount = false,
        { awaitInitialSync = false, throwOnFailure = false } = {}
    ) {
        const initializationGeneration = ++this.syncInitializationGeneration;
        const expectedAccountId = this.state.accountId;
        const assertInitializationCurrent = () => {
            if (
                this.syncInitializationGeneration !== initializationGeneration ||
                this.state.accountId !== expectedAccountId ||
                this.state.sessionVerified !== true
            ) {
                const error = new Error('Account changed while encrypted sync was starting');
                error.code = 'ACCOUNT_SYNC_CONTEXT_CHANGED';
                throw error;
            }
        };
        let accountScopeActivated = false;
        if (this.state.ticketSyncReady) {
            this.state.ticketSyncReady = false;
            this.notify();
        }
        try {
            // Set credentials on sync service (avoids circular dependency)
            const keyMaterial = this.getSyncKeyMaterial();
            
            if (!keyMaterial || !this.state.sessionVerified) {
                const error = new Error('Cannot initialize sync without credentials');
                error.code = 'ACCOUNT_SYNC_CREDENTIALS_UNAVAILABLE';
                throw error;
            }
            assertInitializationCurrent();

            await syncService.activateAccountScope(this.state.accountId, {
                // Match the legacy account flow: creating an account from a
                // device with an existing wallet adopts that wallet. Returning
                // accounts adopt only when local continuity proves ownership.
                adoptUnscoped: enableForNewAccount ||
                    this.localAccountContinuity
            });
            assertInitializationCurrent();
            accountScopeActivated = true;
            if (this.state.accountScopeReady !== true) {
                this.state.accountScopeReady = true;
                this.notify();
            }
            this.localAccountContinuity = true;
            syncService.setCredentials(
                keyMaterial,
                this.state.accountId,
                {
                    identityBacked: !!(
                        this.state.googleLinked ||
                        ['PRF', 'PRF_PENDING', 'LEGACY_SSO'].includes(
                            this.state.encryptionMode
                        )
                    )
                }
            );
            await syncService.init();
            assertInitializationCurrent();
            
            // Sync is automatically enabled when credentials are set
            // Start sync immediately
            const syncAccountId = this.state.accountId;
            const initialSync = syncService.sync().then(result => {
                assertInitializationCurrent();
                if (result?.success !== true) {
                    const error = new Error('Initial encrypted sync did not complete');
                    error.code = 'ACCOUNT_INITIAL_SYNC_FAILED';
                    error.cause = result?.error || null;
                    throw error;
                }
                if (
                    this.state.accountId === syncAccountId &&
                    this.state.sessionVerified === true &&
                    this.state.accountScopeReady === true &&
                    this.state.ticketSyncReady !== true
                ) {
                    this.state.ticketSyncReady = true;
                    this.notify();
                }
            });
            syncService.startPeriodicSync();
            if (awaitInitialSync) {
                await initialSync;
            } else {
                void initialSync.catch(err => {
                    console.warn('[AccountService] Initial sync failed:', err);
                });
            }
            return true;
        } catch (error) {
            console.warn('[AccountService] Failed to initialize sync:', error);
            if (throwOnFailure) throw error;
            return false;
        } finally {
            if (
                this.syncInitializationGeneration === initializationGeneration &&
                this.state.accountId === expectedAccountId &&
                this.state.sessionVerified === true &&
                this.state.accountScopeReady !== accountScopeActivated
            ) {
                this.state.accountScopeReady = accountScopeActivated;
                this.notify();
            }
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
    // Google OAuth Authentication
    // =========================================================================

    async authenticateWithOAuth(provider, { link = false } = {}) {
        const providerConfig = getOAuthProvider(provider);
        const isDesktopOAuth = window.electronAPI?.isElectron === true;
        if (this.state.busy) return null;
        if (link) {
            this.setError(
                `${providerConfig.label} uses a separate privacy partition and cannot be connected to an existing OA account`
            );
            return null;
        }
        if (link && !this.state.accountId) {
            this.setError(
                `Sign in to your OA account before connecting ${providerConfig.label}`
            );
            return null;
        }

        // Open synchronously from the click handler so popup blockers allow it,
        // before the optional asynchronous passkey step-up.
        let popup = null;
        if (!isDesktopOAuth) {
            popup = window.open(
                '',
                `oa-${provider}-auth`,
                'popup,width=600,height=720'
            );
            if (!popup) {
                this.setError(`Allow popups to continue with ${providerConfig.label}`);
                return null;
            }
            popup.document.title = `Connecting to ${providerConfig.label}...`;
            popup.document.body.textContent = `Connecting to ${providerConfig.label}...`;
        }

        if (link) {
            if (this.state.status !== 'unlocked') {
                popup.close();
                this.setError('Unlock your encrypted data before connecting another sign-in method');
                return null;
            }
        }

        const previousAccountId = this.state.accountId;
        const previousCredentialId = this.state.credentialId;
        const previousEncryptionCredentialId =
            this.state.encryptionCredentialId;
        const previousProviderLinked = this.state[`${provider}Linked`];
        const previousOAuthProvider = this.state.oauthProvider;
        const previousOAuthEmail = this.state.oauthEmail;
        const syncSuspended = !link && !!previousAccountId;

        this.setState({
            busy: true,
            action: link ? `${provider}_link` : `${provider}_login`,
            accountScopeReady: link ? this.state.accountScopeReady : false,
            error: null,
            oauthProvider: provider,
            oauthSetupRequired: false,
            oauthRecoveryRequired: false,
            oauthKeyringRequired: false,
            oauthLegacyPasskeyRequired: false
        });

        try {
            if (syncSuspended) {
                syncService.clearCredentials();
                await syncService.deactivateAccountScope(previousAccountId);
                await syncService.clearAll();
            }
            let session;
            if (isDesktopOAuth) {
                session = await bootstrapDesktopOAuthSession(
                    provider,
                    previousAccountId
                );
            } else {
                popup.document.title = `Connecting to ${providerConfig.label}...`;
                popup.document.body.textContent = `Connecting to ${providerConfig.label}...`;

                const startData = await fetchJson(`/auth/${provider}/start`, {
                    mode: link ? 'link' : 'login',
                    returnOrigin: window.location.origin,
                    expectedAccountId: link ? undefined : previousAccountId || undefined
                });
                if (!startData.authorizationUrl) {
                    throw new Error(
                        `${providerConfig.label} authorization URL was missing`
                    );
                }

                popup.location.replace(startData.authorizationUrl);
                const completionToken = await waitForOAuthPopup(popup, provider);
                session = await bootstrapOAuthSession(
                    provider,
                    completionToken
                );
            }
            const accountId = normalizeAccountId(session.accountId);
            if (!accountId) {
                throw new Error(
                    `${providerConfig.label} session did not include an OA account`
                );
            }
            if (oauthSessionNeedsEmailRefresh(session)) {
                throw new Error(
                    `Continue with ${providerConfig.label} again so OA can label your encryption passkey`
                );
            }
            if (!link && previousAccountId && accountId !== previousAccountId) {
                throw new Error(
                    `This ${providerConfig.label} login belongs to a different OA account. ` +
                    'Log out locally before switching accounts.'
                );
            }

            if (link) {
                if (accountId !== this.state.accountId) {
                    throw new Error(
                        `${providerConfig.label} was connected to a different OA account`
                    );
                }
                this.state[`${provider}Linked`] = true;
                this.state.oauthProvider = provider;
                this.state.busy = false;
                this.state.action = null;
                this.state.sessionVerified = true;
                await this.persistSettings();
                this.updateStatus();
                this.notify();
                return { status: 'linked', accountId };
            }

            this.state.accountId = accountId;
            this.state[`${provider}Linked`] = true;
            this.state.oauthProvider = provider;
            this.state.oauthEmail = session.email || null;
            this.state.encryptionMode = session.encryptionMode ||
                this.state.encryptionMode;
            this.state.sessionVerified = true;
            this.state.busy = false;
            this.state.action = null;
            this.state.error = null;

            const localSettings = await chatDB.getSetting(ACCOUNT_SETTINGS_KEY).catch(() => null);
            this.localAccountContinuity =
                localSettings?.accountId === accountId;
            const hasLocalKey =
                this.state.encryptionMode !== 'LEGACY_SSO' &&
                localSettings?.accountId === accountId
                ? await this.loadMasterKey()
                : false;
            if (hasLocalKey) {
                this.state.credentialId = localSettings?.credentialId || null;
                this.state.encryptionCredentialId =
                    localSettings?.encryptionCredentialId || null;
                this.state.encryptionMode =
                    session.encryptionMode ||
                    inferPersistedEncryptionMode(localSettings);
                this.state.recoveryConfirmed = !!localSettings?.recoveryConfirmed;
                this.state.oauthSetupRequired = false;
                this.state.oauthRecoveryRequired = false;
                this.state.oauthKeyringRequired = false;
                this.state.oauthLegacyPasskeyRequired = false;
                await this.persistSettings();
                this.updateStatus();
                this.notify();
                await this.initializeSync(false);
                return { status: 'unlocked', accountId };
            }

            await this.clearPersistedMasterKey();
            this.state.credentialId = null;
            this.state.encryptionCredentialId = null;
            const keyring = await this.fetchOAuthKeyring();
            const mode = keyring.encryptionMode;
            const desktopPasskey = isDesktopOAuth
                ? session.desktopPasskey
                : null;

            if (mode === 'PRF') {
                if (desktopPasskey?.operation === 'get') {
                    try {
                        const { credentialId, masterKey } =
                            await unlockEncryptionKeyringFromPrf(
                                this.keyringWrappers,
                                desktopPasskey.credentialId,
                                desktopPasskey.prf
                            );
                        if (!await this.finishOAuthKeyUnlock(masterKey, credentialId)) {
                            return null;
                        }
                        return { status: 'unlocked', accountId };
                    } catch {
                        // Fall back to the existing explicit passkey control.
                    }
                }
                this.state.oauthKeyringRequired = true;
                await this.persistSettings();
                this.updateStatus();
                this.notify();
                return { status: 'keyring_unlock', accountId };
            }

            if (mode === 'LEGACY_PASSKEY') {
                this.state.oauthLegacyPasskeyRequired = true;
                await this.persistSettings();
                this.updateStatus();
                this.notify();
                return { status: 'legacy_passkey', accountId };
            }

            if (mode === 'LEGACY_SSO') {
                // One-time compatibility path for SSO accounts created before
                // encryption passkeys. Recovery is not used by new accounts.
                this.state.oauthSetupRequired = false;
                this.state.oauthRecoveryRequired = true;
                this.state.oauthKeyringRequired = false;
                await this.persistSettings();
                this.updateStatus();
                this.notify();
                return { status: 'migration', accountId };
            }

            if (desktopPasskey?.operation === 'create') {
                const masterKey = crypto.getRandomValues(new Uint8Array(32));
                let wrapper = null;
                try {
                    wrapper = await createEncryptionKeyWrapperFromPrf(
                        masterKey,
                        desktopPasskey.credentialId,
                        desktopPasskey.prf
                    );
                    await fetchJson('/auth/keyring', wrapper);
                } catch {
                    // A stale/raced context falls back to the ordinary setup UI.
                    masterKey.fill(0);
                    wrapper = null;
                }
                if (wrapper) {
                    this.keyringWrappers = [wrapper];
                    // The server now owns this wrapper. If local persistence or
                    // sync fails, surface that failure instead of incorrectly
                    // offering to create a second keyring.
                    const unlocked = await this.finishOAuthKeyUnlock(
                        masterKey,
                        wrapper.credentialId,
                        { newAccount: true }
                    );
                    if (!unlocked) return null;
                    return { status: 'unlocked', accountId, newAccount: true };
                }
            }

            this.state.oauthSetupRequired = true;
            await this.persistSettings();
            this.updateStatus();
            this.notify();
            return { status: 'keyring_setup', accountId };
        } catch (error) {
            try {
                popup?.close();
            } catch (closeError) {
                // Ignore popup cleanup failures.
            }
            const restorePreviousAccount = !link &&
                this.state.accountId &&
                this.state.accountId !== previousAccountId &&
                !this.getSyncKeyMaterial();
            let previousSessionRestored = false;
            if (syncSuspended && this.getSyncKeyMaterial()) {
                previousSessionRestored = await sessionService.verifySession()
                    .catch(() => false);
            }
            this.setState({
                accountId: restorePreviousAccount ? previousAccountId : this.state.accountId,
                credentialId: restorePreviousAccount
                    ? previousCredentialId
                    : this.state.credentialId,
                encryptionCredentialId: restorePreviousAccount
                    ? previousEncryptionCredentialId
                    : this.state.encryptionCredentialId,
                [`${provider}Linked`]: restorePreviousAccount
                    ? previousProviderLinked
                    : this.state[`${provider}Linked`],
                oauthProvider: restorePreviousAccount
                    ? previousOAuthProvider
                    : this.state.oauthProvider,
                oauthEmail: restorePreviousAccount
                    ? previousOAuthEmail
                    : this.state.oauthEmail,
                sessionVerified: syncSuspended
                    ? previousSessionRestored
                    : restorePreviousAccount
                        ? false
                        : this.state.sessionVerified,
                busy: false,
                action: null,
                oauthSetupRequired: false,
                oauthRecoveryRequired: false,
                oauthKeyringRequired: false,
                oauthLegacyPasskeyRequired: false,
                error: toFriendlyOAuthError(error)
            });
            if (
                syncSuspended &&
                this.getSyncKeyMaterial() &&
                previousSessionRestored
            ) {
                await this.initializeSync(false);
            }
            return null;
        }
    }

    authenticateWithGoogle(options = {}) {
        return this.authenticateWithOAuth('google', options);
    }

    async finishOAuthKeyUnlock(masterKey, credentialId, { newAccount = false } = {}) {
        const expectedAccountId = this.state.accountId;
        const unlockGeneration = this.syncInitializationGeneration;
        const unlockIsCurrent = () => (
            this.syncInitializationGeneration === unlockGeneration &&
            this.state.accountId === expectedAccountId &&
            this.state.sessionVerified === true
        );
        try {
            try {
                const persisted = await this.persistMasterKey(
                    masterKey,
                    expectedAccountId,
                    { isCurrent: unlockIsCurrent }
                );
                if (persisted === false) return false;
            } catch (cause) {
                const error = new Error(
                    'The passkey worked, but this browser could not save the encrypted data key. Try again.'
                );
                error.name = 'AccountKeyPersistError';
                error.code = 'ACCOUNT_KEY_PERSIST_FAILED';
                error.cause = cause;
                throw error;
            }
        } finally {
            masterKey.fill(0);
        }
        if (!unlockIsCurrent()) return false;
        this.masterKey = null;
        this.state.encryptionCredentialId = credentialId;
        this.state.encryptionMode = 'PRF';
        this.state.recoveryConfirmed = false;
        this.state.oauthSetupRequired = false;
        this.state.oauthRecoveryRequired = false;
        this.state.oauthKeyringRequired = false;
        this.state.oauthLegacyPasskeyRequired = false;
        this.state.sessionVerified = true;
        this.state.busy = false;
        this.state.action = null;
        this.state.error = null;
        await this.persistSettings();
        if (!unlockIsCurrent()) return false;
        this.updateStatus();
        this.notify();
        const expectedInitializationGeneration =
            this.syncInitializationGeneration + 1;
        try {
            await this.initializeSync(newAccount, {
                awaitInitialSync: true,
                throwOnFailure: true
            });
        } catch (error) {
            console.warn(
                '[Account] Encrypted data unlocked; initial restoration deferred:',
                String(error?.code || error?.name || 'UNKNOWN')
            );
            // The durable key is already saved. Keep the account unlocked and
            // retry restoration instead of presenting this as a passkey error.
            // A lock, logout, account switch, or newer initialization cancels
            // this retry before it can touch the replacement account scope.
            if (
                this.syncInitializationGeneration !== expectedInitializationGeneration ||
                this.state.accountId !== expectedAccountId ||
                this.state.sessionVerified !== true
            ) return false;
            setTimeout(() => {
                if (
                    this.syncInitializationGeneration !== expectedInitializationGeneration ||
                    this.state.accountId !== expectedAccountId ||
                    this.state.sessionVerified !== true
                ) return;
                void this.initializeSync(newAccount, {
                    awaitInitialSync: true,
                    throwOnFailure: true
                }).catch(retryError => {
                    console.warn(
                        '[Account] Encrypted data restoration retry paused:',
                        String(retryError?.code || retryError?.name || 'UNKNOWN')
                    );
                });
            }, 1000);
        }
        return true;
    }

    async setupOAuthKeyring() {
        if (!this.state.accountId || !this.state.sessionVerified) {
            this.setError('Sign in before creating an encryption passkey');
            return false;
        }
        this.setState({
            busy: true,
            action: `${this.state.oauthProvider || 'oauth'}_key_setup`,
            error: null
        });
        const masterKey = crypto.getRandomValues(new Uint8Array(32));
        try {
            const wrapper = await createEncryptionKeyWrapper(
                masterKey,
                this.state.oauthEmail,
                this.keyringWrappers.map(item => item.credentialId)
            );
            await fetchJson('/auth/keyring', wrapper);
            this.keyringWrappers = [...this.keyringWrappers, wrapper];
            const unlocked = await this.finishOAuthKeyUnlock(masterKey, wrapper.credentialId, {
                newAccount: true
            });
            if (!unlocked) return false;
            return true;
        } catch (error) {
            masterKey.fill(0);
            if (error?.status === 409) {
                try {
                    const keyring = await this.fetchOAuthKeyring();
                    if (this.keyringWrappers.length > 0) {
                        this.setState({
                            busy: false,
                            action: null,
                            oauthSetupRequired: false,
                            oauthKeyringRequired: true,
                            error: null
                        });
                        return this.unlockOAuthKeyring(keyring);
                    }
                } catch (refreshError) {
                    error = refreshError;
                }
            }
            this.setState({
                busy: false,
                action: null,
                error: toFriendlyError(error)
            });
            return false;
        }
    }

    completeOAuthAccountSetup() {
        return this.setupOAuthKeyring();
    }

    async unlockOAuthKeyring(keyring = null) {
        if (this.state.busy) return false;
        this.setState({
            busy: true,
            action: `${this.state.oauthProvider || 'oauth'}_key_unlock`,
            error: null
        });
        try {
            if (!keyring) {
                keyring = await this.fetchOAuthKeyring();
            } else if (Array.isArray(keyring.wrappers)) {
                this.keyringWrappers = keyring.wrappers;
            }
            const { credentialId, masterKey } = await unlockEncryptionKeyring(
                this.keyringWrappers
            );
            this.setState({
                action: `${this.state.oauthProvider || 'oauth'}_key_restoring`,
                error: null
            });
            if (!await this.finishOAuthKeyUnlock(masterKey, credentialId)) return false;
            return true;
        } catch (error) {
            this.setState({
                busy: false,
                action: null,
                oauthKeyringRequired: true,
                error: toFriendlyError(error)
            });
            return false;
        }
    }

    /**
     * One-time migration for SSO accounts created by the recovery-code build.
     * The recovered master key is immediately re-wrapped with a PRF passkey.
     */
    async unlockOAuthWithRecoveryCode(recoveryCodeInput) {
        if (this.state.busy || !this.state.oauthRecoveryRequired) return false;
        const recoveryCode = normalizeRecoveryCode(recoveryCodeInput);
        if (!isValidRecoveryCode(recoveryCode)) {
            this.setError('Enter the legacy 5-word recovery code for this account');
            return false;
        }
        if (!this.recoveryPayload || !this.state.sessionVerified) {
            this.setError('Sign in before migrating encrypted data');
            return false;
        }

        this.setState({
            busy: true,
            action: `${this.state.oauthProvider || 'oauth'}_migration`,
            error: null
        });
        let masterKey = null;
        try {
            const decoded = decodeWrappedKey(this.recoveryPayload);
            const recoveryKey = await deriveRecoveryKey(
                recoveryCode,
                base64ToBytes(decoded.salt)
            );
            masterKey = await decryptBytes(recoveryKey, decoded);
            const wrapper = await createEncryptionKeyWrapper(
                masterKey,
                this.state.oauthEmail
            );
            wrapper.legacyRecoveryCodeHash = await computeRecoveryCodeHash(
                recoveryCode,
                this.state.accountId
            );
            await fetchJson('/auth/keyring', wrapper);
            this.keyringWrappers = [wrapper];
            if (!await this.finishOAuthKeyUnlock(masterKey, wrapper.credentialId)) {
                return false;
            }
            masterKey = null;
            this.recoveryPayload = null;
            return true;
        } catch (error) {
            this.setState({
                busy: false,
                action: null,
                error: toFriendlyError(error)
            });
            return false;
        } finally {
            masterKey?.fill(0);
        }
    }

    cancelPendingOAuthAccount() {
        this.state.oauthSetupRequired = false;
        this.state.oauthKeyringRequired = false;
        this.state.oauthLegacyPasskeyRequired = false;
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

            await fetchJson('/auth/register', {
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
            
            this.state.sessionVerified = await sessionService.doesSessionExist();
            
            await this.persistSettings();
            // Persist only after account settings bind the bundle to this account.
            await this.persistMasterKey(masterKey);
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

    async unlockWithPasskey(
        accountIdInput,
        { mediation, silent = false, action = 'unlock' } = {}
    ) {
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

        this.setState({ busy: true, action, error: null, recoveryRequired: false });
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
            this.state.encryptionMode = 'LEGACY_PASSKEY';
            this.state.busy = false;
            this.state.action = null;
            this.state.error = null;
            this.state.recoveryRequired = false;
            this.state.oauthLegacyPasskeyRequired = false;
            
            this.state.sessionVerified = await sessionService.doesSessionExist();
            
            await this.refreshOAuthLinkStatuses();
            await this.persistSettings();
            // Persist only after account settings bind the bundle to this account.
            await this.persistMasterKey(masterKey);
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
            await fetchJson('/auth/recovery/complete', {
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
            
            this.state.sessionVerified = await sessionService.doesSessionExist();
            
            await this.refreshOAuthLinkStatuses();
            await this.persistSettings();
            // Persist only after account settings bind the bundle to this account.
            await this.persistMasterKey(masterKey);
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
     * Handle token invalidation (e.g., after recovery on another device).
     * Clears all session data and forces re-authentication.
     * Called by the SuperTokens session event when refresh is expired/revoked.
     */
    async handleTokenInvalidation() {
        console.warn('[AccountService] Token invalidated - clearing session');
        this.syncInitializationGeneration += 1;

        try {
            await syncService.clearAll();
        } catch (error) {
            console.warn('[AccountService] Failed to stop sync after session expiry:', error);
        }
        
        syncService.clearCredentials();
        await syncService.deactivateAccountScope(this.state.accountId).catch(() => {});

        // Clear in-memory state
        if (this.masterKey) {
            this.masterKey.fill(0);
        }
        this.masterKey = null;
        this.cryptoKey = null;
        this.syncDerivationKey = null;
        this.syncIdKey = null;
        this.state.sessionVerified = false;
        this.state.accountScopeReady = false;
        this.state.ticketSyncReady = false;
        
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
        this.syncInitializationGeneration += 1;
        if (this.masterKey) {
            this.masterKey.fill(0);
        }
        this.masterKey = null;
        this.cryptoKey = null;  // Clear from memory (IndexedDB copy remains for re-unlock)
        this.syncDerivationKey = null;
        this.syncIdKey = null;
        this.state.sessionVerified = false;
        this.state.accountScopeReady = false;
        this.state.ticketSyncReady = false;
        this.state.oauthKeyringRequired =
            this.state.encryptionMode === 'PRF' &&
            this.state.googleLinked;
        this.state.oauthLegacyPasskeyRequired =
            this.state.encryptionMode === 'LEGACY_PASSKEY' &&
            this.state.googleLinked;
        syncService.clearCredentials();
        syncService.stopPeriodicSync();
        this.updateStatus();
        this.notify();
    }

    /**
     * Full logout - clears all session data and notifies server.
     * This is different from lock() in that it:
     * - Clears the persisted CryptoKey from IndexedDB
     * - Revokes the SuperTokens session on the server
     * - Requires full passkey re-authentication to log back in
     */
    async logout() {
        this.syncInitializationGeneration += 1;
        // Revoke the server session while its refresh token is still available.
        try {
            await sessionService.signOut();
        } catch (error) {
            // Local logout must still complete if the org is unavailable.
            console.warn('Server logout failed:', error);
        }

        // Snapshot and hide account-bound data before removing credentials.
        try {
            syncService.clearCredentials();
            await syncService.deactivateAccountScope(this.state.accountId);
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
        this.syncDerivationKey = null;
        this.syncIdKey = null;
        this.state.sessionVerified = false;
        this.state.accountScopeReady = false;
        this.state.ticketSyncReady = false;
        
        // Clear persisted CryptoKey from IndexedDB
        await this.clearPersistedMasterKey();
        
        this.updateStatus();
        this.notify();
    }

    async clearLocalAccount() {
        await this.logout();  // Use logout instead of lock for full cleanup
        this.cancelPendingOAuthAccount();
        this.state.accountId = null;
        this.state.credentialId = null;
        this.state.encryptionCredentialId = null;
        this.state.encryptionMode = null;
        this.state.recoveryConfirmed = false;
        this.state.recoveryCode = null;
        this.state.recoveryRequired = false;
        this.state.googleLinked = false;
        this.state.oauthProvider = null;
        this.state.oauthEmail = null;
        this.state.oauthSetupRequired = false;
        this.state.oauthRecoveryRequired = false;
        this.state.oauthKeyringRequired = false;
        this.state.oauthLegacyPasskeyRequired = false;
        this.state.accountScopeReady = false;
        this.state.ticketSyncReady = false;
        this.recoveryPayload = null;
        this.keyringWrappers = [];
        this.localAccountContinuity = false;
        // Delete account settings from IndexedDB (not just set to null)
        if (chatDB) {
            await chatDB.deleteSetting(ACCOUNT_SETTINGS_KEY).catch(() => {});
        }
        this.updateStatus();
        this.notify();
    }

    async maybeAutoUnlock() {
        // Skip if already unlocked (session restored from IndexedDB)
        if (this.getSyncKeyMaterial()) return;
        
        if (!this.state.accountId || !this.state.passkeySupported || this.state.busy) return;
        if (this.state.googleLinked) return;
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
