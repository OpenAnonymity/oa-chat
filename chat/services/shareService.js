/**
 * Share Service - Business logic and API for sharing chat sessions
 * Handles payload construction, encryption/decryption, and API communication
 */

import { encrypt, decrypt } from './shareEncryption.js';
import networkProxy from './networkProxy.js';
import { ORG_API_BASE, SHARE_BASE_URL } from '../config.js';
import inferenceService from './inference/inferenceService.js';

// ========== Share ID Normalization ==========

/**
 * Normalize a share ID for consistent server communication and storage.
 * Handles case variations and dash formatting to ensure URLs are case-insensitive.
 *
 * Examples:
 *   '01J7X-KQNP2-4MVWT-GHR85C' → '01j7x-kqnp2-4mvwt-ghr85c'
 *   '01j7xkqnp24mvwtghr85c'    → '01j7x-kqnp2-4mvwt-ghr85c'
 *   '01J7XKQNP24MVWTGHR85C'    → '01j7x-kqnp2-4mvwt-ghr85c'
 *
 * @param {string} id - Share ID (may be uppercase, with/without dashes)
 * @returns {string} Normalized share ID (lowercase, with dashes for 21-char IDs)
 */
export function normalizeShareId(id) {
    if (!id || typeof id !== 'string') return id;

    // Strip dashes and convert to lowercase
    const stripped = id.replace(/-/g, '').toLowerCase();

    // For 21-char IDs (new ULID format), add dashes in 5-5-5-6 format
    // This matches the format from generateId() in app.js
    if (stripped.length === 21) {
        return `${stripped.slice(0, 5)}-${stripped.slice(5, 10)}-${stripped.slice(10, 15)}-${stripped.slice(15)}`;
    }

    // For other lengths (old format or invalid), return lowercase without dashes
    return stripped;
}

// ========== Share API ==========

/**
 * Create a new session share
 * POST /chat/share
 * @param {string} shareId - Client-generated share ID
 * @param {Object} encryptedData - {salt, iv, ciphertext}
 * @param {number} [expiresInSeconds=604800] - TTL in seconds (default: 7 days)
 * @returns {Promise<{id: string, token: string, created_at: number, expires_at: number}>}
 */
async function createShareApi(shareId, encryptedData, expiresInSeconds = 604800) {
    const normalizedId = normalizeShareId(shareId);
    const url = `${ORG_API_BASE}/chat/share`;
    const requestBody = {
        id: normalizedId,
        salt: encryptedData.salt,
        iv: encryptedData.iv,
        ciphertext: encryptedData.ciphertext
    };

    // Only include expires_in if it's a positive value (0 = indefinite, omit to let server decide)
    if (expiresInSeconds > 0) {
        requestBody.expires_in = expiresInSeconds;
    }

    const response = await networkProxy.fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody)
    });

    if (!response.ok) {
        const errorText = await response.text().catch(() => 'Unable to read error body');
        console.error('[shareService] Share creation failed:', response.status, errorText);
        throw new Error(`Failed to create share (${response.status}): ${errorText}`);
    }

    const data = await response.json();
    return {
        id: data.id,
        token: data.token,
        created_at: data.created_at,
        expires_at: data.expires_at
    };
}

/**
 * Update an existing session share
 * PATCH /chat/share/{share_id}
 * @param {string} shareId - Share ID to update
 * @param {string} token - Token for ownership proof
 * @param {Object} encryptedData - {salt, iv, ciphertext}
 * @param {number} [expiresInSeconds=604800] - TTL in seconds
 * @returns {Promise<{id: string, created_at: number, expires_at: number}>}
 */
async function updateShareApi(shareId, token, encryptedData, expiresInSeconds = 604800) {
    const normalizedId = normalizeShareId(shareId);
    const url = `${ORG_API_BASE}/chat/share/${normalizedId}`;
    const requestBody = {
        salt: encryptedData.salt,
        iv: encryptedData.iv,
        ciphertext: encryptedData.ciphertext
    };

    // Only include expires_in if it's a positive value (0 = indefinite, omit to let server decide)
    if (expiresInSeconds > 0) {
        requestBody.expires_in = expiresInSeconds;
    }

    const response = await networkProxy.fetch(url, {
        method: 'PATCH',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify(requestBody)
    });

    if (!response.ok) {
        if (response.status === 403) throw new Error('Invalid token - cannot update share');
        if (response.status === 404) throw new Error('Share not found');
        throw new Error(`Failed to update share (${response.status})`);
    }

    const data = await response.json();
    return {
        id: data.id,
        created_at: data.created_at,
        expires_at: data.expires_at
    };
}

/**
 * Delete a session share
 * DELETE /chat/share/{share_id}
 * @param {string} shareId - Share ID to delete
 * @param {string} token - Token for ownership proof
 * @returns {Promise<void>}
 */
async function deleteShareApi(shareId, token) {
    const normalizedId = normalizeShareId(shareId);
    const url = `${ORG_API_BASE}/chat/share/${normalizedId}`;
    const response = await networkProxy.fetch(url, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${token}` }
    });

    if (!response.ok) {
        if (response.status === 404) throw new Error('Share not found or already deleted');
        if (response.status === 403) throw new Error('Invalid token - cannot delete share');
        throw new Error(`Failed to delete share (${response.status})`);
    }
}

/**
 * Download a session share
 * GET /chat/share/{share_id}
 * @param {string} shareId - Share ID from URL
 * @returns {Promise<{id: string, salt: string, iv: string, ciphertext: string, created_at: number, expires_at: number}>}
 */
async function downloadShareApi(shareId) {
    const normalizedId = normalizeShareId(shareId);
    const url = `${ORG_API_BASE}/chat/share/${normalizedId}`;
    const response = await networkProxy.fetch(url, { method: 'GET' });

    if (!response.ok) {
        if (response.status === 404) throw new Error('Share not found or has expired');
        throw new Error(`Failed to download share (${response.status})`);
    }

    const data = await response.json();
    if (!data.ciphertext) {
        throw new Error('Invalid share data received');
    }

    return {
        id: data.id,
        salt: data.salt || '',
        iv: data.iv || '',
        ciphertext: data.ciphertext,
        created_at: data.created_at,
        expires_at: data.expires_at
    };
}

// ========== Share Business Logic ==========

/**
 * Check if share data is plaintext (not encrypted)
 * @param {Object} shareData - Share data with salt, iv, ciphertext
 * @returns {boolean}
 */
export function isPlaintextShare(shareData) {
    return !shareData.salt || !shareData.iv;
}

/**
 * Build share payload from session and messages
 * @param {Object} session - Session object
 * @param {Array} messages - Array of messages
 * @param {Object} opts - Options {shareApiKeyMetadata: boolean}
 * @returns {Object} Share payload
 */
export function buildSharePayload(session, messages, opts = {}) {
    const payload = {
        version: 1,
        session: {
            title: session.title,
            model: session.model,
            createdAt: session.createdAt,
            updatedAt: session.updatedAt,
            searchEnabled: session.searchEnabled,
            inferenceBackend: session.inferenceBackend || inferenceService.getDefaultBackendId()
        },
        messages: messages.map(m => ({
            role: m.role,
            content: m.content,
            timestamp: m.timestamp,
            model: m.model,
            images: m.images,
            reasoning: m.reasoning,
            reasoningDuration: m.reasoningDuration,
            tokenCount: m.tokenCount
        }))
    };

    // Include shared access payload (legacy sharedApiKey preserved for compatibility)
    if (opts.shareApiKeyMetadata) {
        const sharedAccess = inferenceService.buildSharedAccessPayload(session);
        if (sharedAccess) {
            payload.sharedAccess = sharedAccess;
            const legacySharedApiKey = inferenceService.buildLegacySharedApiKey(session, sharedAccess);
            if (legacySharedApiKey) {
                payload.sharedApiKey = legacySharedApiKey;
            }
        }
    }

    return payload;
}

/**
 * Encode share data (encrypt with password or base64 for plaintext)
 * @param {Object} payload - Share payload
 * @param {string|null} password - Password for encryption, null for plaintext
 * @returns {Promise<{salt: string, iv: string, ciphertext: string}>}
 */
export async function encodeShareData(payload, password) {
    // Ensure hash-wasm is loaded before encryption
    if (password && !window.argon2id) {
        console.log('[shareService] Loading Argon2id for encryption...');
        await window.initHashWasm();
    }

    if (password) {
        return encrypt(payload, password);
    }

    // Plaintext mode - encode as base64 JSON
    const jsonStr = JSON.stringify(payload);
    return {
        salt: '',
        iv: '',
        ciphertext: btoa(unescape(encodeURIComponent(jsonStr)))
    };
}

/**
 * Decode share data (decrypt with password or decode base64 for plaintext)
 * @param {Object} shareData - {salt, iv, ciphertext}
 * @param {string|null} password - Password for decryption, null for plaintext
 * @returns {Promise<Object>} Decoded payload
 */
export async function decodeShareData(shareData, password) {
    if (isPlaintextShare(shareData)) {
        // Plaintext - decode directly from base64
        const jsonStr = decodeURIComponent(escape(atob(shareData.ciphertext)));
        return JSON.parse(jsonStr);
    }

    // Ensure hash-wasm is loaded before decryption
    if (!window.argon2id) {
        console.log('[shareService] Loading Argon2id for decryption...');
        await window.initHashWasm();
    }

    return decrypt(shareData.salt, shareData.iv, shareData.ciphertext, password);
}

/**
 * Validate imported payload structure
 * @param {Object} payload - Decoded payload
 * @throws {Error} If payload is invalid
 */
export function validatePayload(payload) {
    if (!payload.version || !payload.session || !payload.messages) {
        throw new Error('Invalid share format');
    }
    if (!Array.isArray(payload.messages)) {
        throw new Error('Invalid messages format');
    }
}

/**
 * Build shareable URL for a share ID
 * @param {string} shareId - Share ID
 * @returns {string} Full shareable URL
 */
export function buildShareUrl(shareId) {
    const normalizedId = normalizeShareId(shareId);
    return `${SHARE_BASE_URL}?s=${normalizedId}`;
}

/**
 * Create session object from imported payload
 * @param {Object} payload - Decoded share payload
 * @param {string} shareId - Original share ID
 * @param {string} ciphertext - Original ciphertext for update detection
 * @param {Function} generateId - ID generator function
 * @returns {Object} Session object ready for saving
 */
export function createSessionFromPayload(payload, shareId, ciphertext, generateId) {
    const backendId = payload.session?.inferenceBackend || payload.sharedAccess?.backendId || inferenceService.getDefaultBackendId();
    const sharedAccess = payload.sharedAccess || inferenceService.legacySharedApiKeyToSharedAccess(payload.sharedApiKey, backendId);
    const sessionAccess = sharedAccess
        ? inferenceService.sharedAccessToSessionAccess(backendId, sharedAccess)
        : null;

    const session = {
        id: generateId(),
        title: payload.session.title || 'Imported Chat',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        model: payload.session.model,
        inferenceBackend: backendId,
        apiKey: sessionAccess?.token || null,
        apiKeyInfo: sessionAccess?.info || null,
        expiresAt: sessionAccess?.expiresAt || null,
        searchEnabled: payload.session.searchEnabled ?? true,
        importedFrom: normalizeShareId(shareId),
        importedMessageCount: payload.messages.length,
        importedCiphertext: ciphertext
    };

    return session;
}

/**
 * Create messages from imported payload
 * @param {Array} payloadMessages - Messages from payload
 * @param {string} sessionId - Target session ID
 * @param {Function} generateId - ID generator function
 * @returns {Array} Message objects ready for saving
 */
export function createMessagesFromPayload(payloadMessages, sessionId, generateId) {
    return payloadMessages.map(m => ({
        ...m,
        id: generateId(),
        sessionId
    }));
}

/**
 * Build shareInfo object from API result
 * @param {Object} result - API response
 * @param {string} shareId - Share ID
 * @param {number} messageCount - Number of messages shared
 * @param {boolean} isPlaintext - Whether share is unencrypted
 * @param {boolean} apiKeyShared - Whether API key was included
 * @param {number} ttlSeconds - TTL in seconds
 * @returns {Object} shareInfo object
 */
export function buildShareInfo(result, shareId, messageCount, isPlaintext, apiKeyShared, ttlSeconds) {
    // Convert expires_at to milliseconds if it's in seconds (Unix epoch)
    const expiresAtMs = result.expires_at < 1e12 ? result.expires_at * 1000 : result.expires_at;

    return {
        shareId: normalizeShareId(shareId),
        token: result.token,
        createdAt: result.created_at,
        expiresAt: expiresAtMs,
        messageCount,
        isPlaintext,
        apiKeyShared,
        ttlSeconds
    };
}

/**
 * Create or update a share
 * @param {Object} session - Session to share
 * @param {Array} messages - Messages to include
 * @param {Object} settings - {password, ttlSeconds, shareApiKeyMetadata}
 * @returns {Promise<{shareInfo: Object, shareUrl: string}>}
 */
export async function createOrUpdateShare(session, messages, settings) {
    const { password, ttlSeconds, shareApiKeyMetadata } = settings;

    // Build and encode payload
    const payload = buildSharePayload(session, messages, { shareApiKeyMetadata });
    const shareData = await encodeShareData(payload, password);

    const shareId = session.id;
    const isExpired = session.shareInfo?.expiresAt && Date.now() > session.shareInfo.expiresAt;

    let result;
    // Use POST for new shares or expired shares, PATCH for active shares
    if (session.shareInfo?.shareId && session.shareInfo?.token && !isExpired) {
        result = await updateShareApi(shareId, session.shareInfo.token, shareData, ttlSeconds);
        result.token = session.shareInfo.token;
    } else {
        result = await createShareApi(shareId, shareData, ttlSeconds);
    }

    const shareInfo = buildShareInfo(
        result,
        shareId,
        messages.length,
        !password,
        shareApiKeyMetadata,
        ttlSeconds
    );

    return {
        shareInfo,
        shareUrl: buildShareUrl(shareId)
    };
}

/**
 * Download and decode a share
 * @param {string} shareId - Share ID to download
 * @param {string|null} password - Password for decryption (null will fail for encrypted shares)
 * @returns {Promise<{payload: Object, shareData: Object}>}
 */
export async function downloadAndDecodeShare(shareId, password) {
    const shareData = await downloadShareApi(shareId);

    // For plaintext shares, no password needed
    if (isPlaintextShare(shareData)) {
        const payload = await decodeShareData(shareData, null);
        validatePayload(payload);
        return { payload, shareData };
    }

    // For encrypted shares, password is required
    if (!password) {
        throw new Error('PASSWORD_REQUIRED');
    }

    const payload = await decodeShareData(shareData, password);
    validatePayload(payload);
    return { payload, shareData };
}

/**
 * Check if a share has updates compared to stored ciphertext
 * @param {string} shareId - Share ID to check
 * @param {string} storedCiphertext - Previously stored ciphertext
 * @returns {Promise<{hasUpdates: boolean, shareData: Object|null}>}
 */
export async function checkForUpdates(shareId, storedCiphertext) {
    try {
        const shareData = await downloadShareApi(shareId);
        const hasUpdates = shareData.ciphertext !== storedCiphertext;
        return { hasUpdates, shareData };
    } catch (error) {
        console.warn('[shareService] Could not check for updates:', error.message);
        return { hasUpdates: false, shareData: null };
    }
}

/**
 * Delete a share
 * @param {string} shareId - Share ID
 * @param {string} token - Auth token for the share
 * @returns {Promise<void>}
 */
export { downloadShareApi as downloadShare, deleteShareApi as deleteShare };

// Default export for convenient importing
export default {
    normalizeShareId,
    isPlaintextShare,
    buildSharePayload,
    encodeShareData,
    decodeShareData,
    validatePayload,
    buildShareUrl,
    createSessionFromPayload,
    createMessagesFromPayload,
    buildShareInfo,
    createOrUpdateShare,
    downloadAndDecodeShare,
    checkForUpdates,
    downloadShare: downloadShareApi,
    deleteShare: deleteShareApi
};
