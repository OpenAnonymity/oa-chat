/**
 * Sync Service
 * E2E encrypted sync for tickets and preferences across devices.
 * 
 * TRUE E2E ARCHITECTURE - Server sees NOTHING but opaque blobs
 * ------------------------------------------------------------
 * - Blob IDs are HMAC-derived (opaque to server)
 * - All metadata (type, key) is INSIDE the encrypted payload
 * - Server only stores: { id, ciphertext, iv, version }
 * - Per-blob HKDF key derivation from master key
 * - AES-256-GCM encryption
 * - Web Locks prevent multi-tab race conditions
 */

import { ORG_API_BASE } from '../config.js';
import { chatDB } from '../db.js';
import { fetchRetry } from './fetchRetry.js';
import { withTicketStorageLock } from './ticketStorageLock.js';
import {
    filterTicketsByInvalidatedKeyIds,
    normalizeInvalidatedTicketKeyIds
} from '../domain/ticketKeys.js';

const SYNC_LOCK_NAME = 'oa-sync';
const SYNC_SALT = 'oa-sync-v1';
const HMAC_SALT = 'oa-sync-id-v1';

// Settings keys for sync metadata (local only)
const SYNC_LAST_TIME_KEY = 'sync-lastSyncTime';
const SYNC_SCHEMA_VERSION_KEY = 'sync-schema-version';
const CURRENT_SYNC_SCHEMA_VERSION = 2;

// Settings keys for syncable data
const TICKETS_ACTIVE_KEY = 'tickets-active';
const TICKETS_ARCHIVE_KEY = 'tickets-archive';
const TICKETS_INVALIDATED_KEYS_KEY = 'tickets-invalidated-key-ids';

// Preference keys to sync
const SYNCABLE_PREF_KEYS = [
    'pref-theme',
    'pref-wide-mode',
    'pref-flat-mode',
    'pref-font-mode',
    'pref-network-proxy-settings'
];
const SYNC_PREF_UPDATED_AT_PREFIX = 'sync-pref-updated-at:';

// Logical IDs (client-side only, never sent to server)
const LOGICAL_IDS = {
    TICKETS_ACTIVE: 'tickets-active',
    TICKETS_ARCHIVE: 'tickets-archive',
    TICKETS_INVALIDATED_KEYS: 'tickets-invalidated-key-ids',
    TICKET_INVALIDATION_ITEM: 'ticket-invalidation-item',
    // Preferences use their key as logical ID
};
const MAX_SYNC_BLOBS_PER_REQUEST = 100;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

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

/**
 * Derive an opaque blob ID using HMAC.
 * Server sees only this hash, not the logical ID.
 */
async function deriveOpaqueBlobId(masterKey, logicalId) {
    const key = await crypto.subtle.importKey(
        'raw',
        masterKey,
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign']
    );

    const signature = await crypto.subtle.sign(
        'HMAC',
        key,
        textEncoder.encode(HMAC_SALT + ':' + logicalId)
    );

    // Use first 16 bytes as hex string (32 chars)
    const bytes = new Uint8Array(signature).slice(0, 16);
    return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Derive a unique AES-256 key for a specific blob using HKDF.
 */
async function deriveItemKey(masterKey, logicalId) {
    const baseKey = await crypto.subtle.importKey(
        'raw',
        masterKey,
        { name: 'HKDF' },
        false,
        ['deriveKey']
    );

    return crypto.subtle.deriveKey(
        {
            name: 'HKDF',
            hash: 'SHA-256',
            salt: textEncoder.encode(SYNC_SALT),
            info: textEncoder.encode(logicalId),
        },
        baseKey,
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt']
    );
}

/**
 * Encrypt data. Type and all metadata go INSIDE the ciphertext.
 */
async function encryptBlob(masterKey, logicalId, payload) {
    const itemKey = await deriveItemKey(masterKey, logicalId);
    const iv = crypto.getRandomValues(new Uint8Array(12));

    // Everything is inside the encrypted payload - server sees nothing
    const plaintext = JSON.stringify(payload);

    const ciphertext = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv },
        itemKey,
        textEncoder.encode(plaintext)
    );

    return {
        ciphertext: bytesToBase64(new Uint8Array(ciphertext)),
        iv: bytesToBase64(iv)
    };
}

/**
 * Decrypt data. Returns the full payload including type.
 */
async function decryptBlob(masterKey, logicalId, ciphertext, iv) {
    const itemKey = await deriveItemKey(masterKey, logicalId);
    const ivBytes = base64ToBytes(iv);
    const ciphertextBytes = base64ToBytes(ciphertext);

    const plaintext = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: ivBytes },
        itemKey,
        ciphertextBytes
    );

    return JSON.parse(textDecoder.decode(plaintext));
}

export class SyncService {
    constructor() {
        this.syncInProgress = false;
        this.listeners = new Set();
        this.syncTimer = null;
        
        // Credentials (set by accountService)
        this.masterKey = null;
        this.accessToken = null;
        this.refreshTokenCallback = null;

        // Cache: opaque ID -> logical ID mapping (computed on init)
        this.idMapping = null;

        // Debounce for local change sync
        this.localChangeDebounceTimer = null;
        this.lastSyncTime = null;
        this.lastSyncResult = null;
    }

    setCredentials(masterKey, accessToken, refreshCallback) {
        this.masterKey = masterKey;
        this.accessToken = accessToken;
        this.refreshTokenCallback = refreshCallback;
        this.idMapping = null; // Reset mapping when credentials change
    }

    updateAccessToken(accessToken) {
        this.accessToken = accessToken;
    }

    clearCredentials() {
        this.masterKey = null;
        this.accessToken = null;
        this.refreshTokenCallback = null;
        this.idMapping = null;
    }

    async init() {
        if (!chatDB.db && typeof chatDB.init === 'function') {
            await chatDB.init();
        }
        // No separate enabled flag - sync is enabled when we have credentials
    }

    /**
     * Build the mapping of opaque IDs to logical IDs.
     * This lets us identify what a blob is when we pull it.
     */
    async _buildIdMapping(masterKey) {
        if (this.idMapping) return this.idMapping;

        const mapping = new Map();
        
        // Tickets
        const ticketsActiveId = await deriveOpaqueBlobId(masterKey, LOGICAL_IDS.TICKETS_ACTIVE);
        const ticketsArchiveId = await deriveOpaqueBlobId(masterKey, LOGICAL_IDS.TICKETS_ARCHIVE);
        const invalidatedKeysId = await deriveOpaqueBlobId(
            masterKey,
            LOGICAL_IDS.TICKETS_INVALIDATED_KEYS
        );
        mapping.set(ticketsActiveId, LOGICAL_IDS.TICKETS_ACTIVE);
        mapping.set(ticketsArchiveId, LOGICAL_IDS.TICKETS_ARCHIVE);
        mapping.set(invalidatedKeysId, LOGICAL_IDS.TICKETS_INVALIDATED_KEYS);

        // Preferences
        for (const key of SYNCABLE_PREF_KEYS) {
            const opaqueId = await deriveOpaqueBlobId(masterKey, key);
            mapping.set(opaqueId, key);
        }

        this.idMapping = mapping;
        return mapping;
    }

    /**
     * Sync is enabled when we have credentials (logged in).
     * No separate flag needed.
     */
    isEnabled() {
        return !!(this.masterKey && this.accessToken);
    }

    /**
     * Get current sync status for UI display.
     */
    getStatus() {
        return {
            enabled: this.isEnabled(),
            syncing: this.syncInProgress,
            lastSyncTime: this.lastSyncTime,
            lastSyncResult: this.lastSyncResult
        };
    }

    /**
     * Trigger sync after local changes (debounced).
     * Call this when tickets or preferences change locally.
     */
    triggerSync(delayMs = 2000) {
        if (!this.isEnabled()) return;

        if (this.localChangeDebounceTimer) {
            clearTimeout(this.localChangeDebounceTimer);
        }

        this.localChangeDebounceTimer = setTimeout(() => {
            this.localChangeDebounceTimer = null;
            this.sync().catch(err => {
                console.warn('[SyncService] Triggered sync failed:', err);
            });
        }, delayMs);
    }

    /**
     * Quick check if server has newer data than local.
     * Returns true if we need to pull, false if up-to-date.
     */
    async hasRemoteChanges() {
        if (!this.isEnabled()) {
            return false;
        }

        try {
            const response = await fetch(
                `${ORG_API_BASE}/auth/sync/status`,
                {
                    method: 'GET',
                    headers: {
                        'Authorization': `Bearer ${this.accessToken}`,
                        'Content-Type': 'application/json'
                    },
                    credentials: 'include'
                }
            );

            if (!response.ok) return false;

            const { last_sync: serverLastSync } = await response.json();
            const localLastSync = await chatDB.getSetting(SYNC_LAST_TIME_KEY) || 0;

            const hasChanges = serverLastSync > localLastSync;
            
            // If no changes, we're confirmed in sync - update lastSyncTime
            if (!hasChanges) {
                this.lastSyncTime = Date.now();
                this.lastSyncResult = { success: true, pulled: 0, pushed: 0 };
                this.notify('status_checked');
            }
            
            return hasChanges;
        } catch (error) {
            console.warn('[SyncService] Status check failed:', error);
            return false;
        }
    }

    /**
     * Sync only if server has newer data.
     * Fast path: skip sync if already up-to-date.
     */
    async syncIfNeeded() {
        if (!this.isEnabled()) return { skipped: true, reason: 'not logged in' };

        const hasChanges = await this.hasRemoteChanges();
        if (!hasChanges) {
            return { skipped: true, reason: 'up-to-date' };
        }

        return this.sync();
    }

    subscribe(handler) {
        this.listeners.add(handler);
        return () => this.listeners.delete(handler);
    }

    notify(event, data = null) {
        const payload = { event, data, timestamp: Date.now() };
        this.listeners.forEach(handler => {
            try {
                handler(payload);
            } catch (error) {
                console.warn('Sync listener error:', error);
            }
        });
    }

    getMasterKey() {
        return this.masterKey;
    }

    getAccessToken() {
        return this.accessToken;
    }

    getPreferenceTimestampKey(key) {
        return `${SYNC_PREF_UPDATED_AT_PREFIX}${key}`;
    }

    normalizeTimestamp(value) {
        const timestamp = Number(value);
        if (!Number.isFinite(timestamp) || timestamp <= 0) {
            return null;
        }
        return Math.floor(timestamp);
    }

    async refreshAccessToken() {
        if (!this.refreshTokenCallback) return false;
        try {
            const result = await this.refreshTokenCallback();
            if (result?.accessToken) {
                this.accessToken = result.accessToken;
                return true;
            }
        } catch (error) {
            console.warn('[SyncService] Token refresh failed:', error);
        }
        return false;
    }

    async fetchWithRetry(url, options, context = 'Sync') {
        // Use shared retry utility with native fetch (default)
        // Sync operations are idempotent (version-based) - safe to retry
        return fetchRetry(url, options, {
            context,
            maxAttempts: 3,
            timeoutMs: 30000
        });
    }

    async sync() {
        if (!this.isEnabled()) {
            return { success: false, error: 'Not logged in' };
        }

        if (this.syncInProgress) {
            return { success: false, error: 'Sync already in progress' };
        }

        const masterKey = this.getMasterKey();
        if (!masterKey) {
            return { success: false, error: 'Account not unlocked' };
        }

        const accessToken = this.getAccessToken();
        if (!accessToken) {
            return { success: false, error: 'No access token' };
        }

        // Set syncing state immediately for UI feedback
        this.syncInProgress = true;
        this.notify('sync_start');

        if (navigator.locks) {
            return navigator.locks.request(SYNC_LOCK_NAME, { mode: 'exclusive' },
                () => this._doSync(masterKey, accessToken)
            );
        }

        return this._doSync(masterKey, accessToken);
    }

    async _doSync(masterKey, accessToken) {

        try {
            // Build ID mapping first
            await this._buildIdMapping(masterKey);

            const pullResult = await this._pull(masterKey, accessToken);
            const pushResult = await this._push(masterKey, accessToken);

            const result = {
                success: true,
                pulled: pullResult.count,
                pushed: pushResult.count
            };

            this.lastSyncTime = Date.now();
            this.lastSyncResult = result;
            this.notify('sync_complete', { pulled: pullResult, pushed: pushResult });

            return result;
        } catch (error) {
            console.error('[SyncService] Sync failed:', error);
            const result = { success: false, error: error.message };
            this.lastSyncResult = result;
            this.notify('sync_error', { error: error.message });
            return result;
        } finally {
            this.syncInProgress = false;
            this.notify('sync_end');  // Always notify UI to update
        }
    }

    async _pull(masterKey, accessToken) {
        const localSchemaVersion = Number(
            await chatDB.getSetting(SYNC_SCHEMA_VERSION_KEY)
        ) || 0;
        // Version 2 introduced dynamically addressed per-generation
        // tombstones. A one-time full pull lets upgraded clients reconsider
        // records that an older version skipped as unknown.
        const lastSync = localSchemaVersion < CURRENT_SYNC_SCHEMA_VERSION
            ? 0
            : await chatDB.getSetting(SYNC_LAST_TIME_KEY) || 0;

        const response = await this.fetchWithRetry(
            `${ORG_API_BASE}/auth/sync?since=${lastSync}`,
            {
                method: 'GET',
                headers: {
                    'Authorization': `Bearer ${accessToken}`,
                    'Content-Type': 'application/json'
                },
                credentials: 'include'
            },
            'Sync pull'
        );

        if (!response.ok) {
            if (response.status === 401) {
                const refreshed = await this.refreshAccessToken();
                if (!refreshed) throw new Error('Authentication failed');
                return this._pull(masterKey, this.getAccessToken());
            }
            throw new Error(`Pull failed: ${response.status}`);
        }

        const { blobs, server_time } = await response.json();
        let mergedCount = 0;

        for (const serverBlob of blobs || []) {
            const applied = await this._applyServerBlob(masterKey, serverBlob);
            if (applied) mergedCount++;
        }

        const syncMetadata = [
            {
                key: SYNC_SCHEMA_VERSION_KEY,
                value: CURRENT_SYNC_SCHEMA_VERSION
            }
        ];
        if (server_time) {
            syncMetadata.push({
                key: SYNC_LAST_TIME_KEY,
                value: server_time
            });
        }
        if (typeof chatDB.saveSettings === 'function') {
            await chatDB.saveSettings(syncMetadata);
        } else {
            for (const entry of syncMetadata) {
                await chatDB.saveSetting(entry.key, entry.value);
            }
        }

        return { count: mergedCount };
    }

    async _applyServerBlob(masterKey, serverBlob) {
        if (!serverBlob.ciphertext || !serverBlob.iv) return false;

        // Fixed records can be mapped directly. Per-generation invalidation
        // records deliberately use distinct opaque IDs so concurrent devices
        // cannot overwrite one another; unknown IDs are therefore probed with
        // the shared invalidation-item encryption key.
        const mappedLogicalId = this.idMapping?.get(serverBlob.id);
        let logicalId = mappedLogicalId || LOGICAL_IDS.TICKET_INVALIDATION_ITEM;

        try {
            // Decrypt - the payload contains type and data
            const payload = await decryptBlob(
                masterKey,
                logicalId,
                serverBlob.ciphertext,
                serverBlob.iv
            );
            if (
                !mappedLogicalId &&
                payload.type !== 'ticket-invalidation'
            ) {
                console.warn('[SyncService] Unknown blob ID:', serverBlob.id);
                return false;
            }

            // Apply based on type (stored inside encrypted payload)
            let applied = false;
            if (payload.type === 'tickets') {
                await this._mergeTickets(logicalId, payload.data);
                applied = true;
            } else if (payload.type === 'ticket-invalidations') {
                await this._mergeTicketInvalidations(payload.data);
                applied = true;
            } else if (payload.type === 'ticket-invalidation') {
                await this._mergeTicketInvalidations([payload.key_id]);
                applied = true;
            } else if (payload.type === 'preference') {
                applied = await this._mergePreference(payload.key, payload.value, payload.updatedAt);
            }

            if (applied) {
                this.notify('blob_received', { type: payload.type, logicalId });
            }
            return applied;
        } catch (error) {
            if (mappedLogicalId) {
                console.warn('[SyncService] Failed to decrypt blob:', serverBlob.id, error);
            } else {
                // Unknown records may belong to a newer client version. A
                // failed invalidation-key probe is expected and is skipped.
                console.warn('[SyncService] Unknown blob ID:', serverBlob.id);
            }
            return false;
        }
    }

    /**
     * CRDT merge for tickets.
     * Key principle: consumed state ALWAYS wins.
     * If a ticket is in archive (consumed) anywhere, it's consumed everywhere.
     */
    async _mergeTickets(logicalId, serverTickets) {
        return withTicketStorageLock(async () => {
            const isArchive = logicalId === LOGICAL_IDS.TICKETS_ARCHIVE;

            // Get both local lists
            const localActive = await chatDB.getSetting(TICKETS_ACTIVE_KEY) || [];
            const localArchive = await chatDB.getSetting(TICKETS_ARCHIVE_KEY) || [];
            const invalidatedKeyIds = normalizeInvalidatedTicketKeyIds(
                await chatDB.getSetting(TICKETS_INVALIDATED_KEYS_KEY)
            );
            const tickets = filterTicketsByInvalidatedKeyIds(
                serverTickets,
                invalidatedKeyIds
            );
            const filteredLocalActive = filterTicketsByInvalidatedKeyIds(
                localActive,
                invalidatedKeyIds
            );
            const filteredLocalArchive = filterTicketsByInvalidatedKeyIds(
                localArchive,
                invalidatedKeyIds
            );

            if (isArchive) {
                // Merging archive (consumed tickets) - union of all consumed
                const consumedIds = new Set(filteredLocalArchive.map(t => t.finalized_ticket));
                const mergedArchive = [...filteredLocalArchive];

                for (const ticket of tickets) {
                    if (ticket.finalized_ticket && !consumedIds.has(ticket.finalized_ticket)) {
                        mergedArchive.push(ticket);
                        consumedIds.add(ticket.finalized_ticket);
                    }
                }

                // CRDT: Remove any newly-consumed tickets from active
                const filteredActive = filteredLocalActive.filter(t =>
                    !consumedIds.has(t.finalized_ticket)
                );

                await chatDB.saveSetting(TICKETS_ARCHIVE_KEY, mergedArchive);
                if (filteredActive.length !== localActive.length) {
                    await chatDB.saveSetting(TICKETS_ACTIVE_KEY, filteredActive);
                }
            } else {
                // Merging active tickets - add new ones, but respect consumed state
                const consumedIds = new Set(filteredLocalArchive.map(t => t.finalized_ticket));
                const activeIds = new Set(filteredLocalActive.map(t => t.finalized_ticket));
                const mergedActive = [...filteredLocalActive];

                for (const ticket of tickets) {
                    // Only add if not already active AND not consumed
                    if (ticket.finalized_ticket &&
                        !activeIds.has(ticket.finalized_ticket) &&
                        !consumedIds.has(ticket.finalized_ticket)) {
                        mergedActive.push(ticket);
                        activeIds.add(ticket.finalized_ticket);
                    }
                }

                await chatDB.saveSetting(TICKETS_ACTIVE_KEY, mergedActive);
                if (filteredLocalArchive.length !== localArchive.length) {
                    await chatDB.saveSetting(TICKETS_ARCHIVE_KEY, filteredLocalArchive);
                }
            }
        });
    }

    async _mergeTicketInvalidations(serverKeyIds) {
        return withTicketStorageLock(async () => {
            const localKeyIds = normalizeInvalidatedTicketKeyIds(
                await chatDB.getSetting(TICKETS_INVALIDATED_KEYS_KEY)
            );
            const mergedKeyIds = normalizeInvalidatedTicketKeyIds([
                ...localKeyIds,
                ...(Array.isArray(serverKeyIds) ? serverKeyIds : [])
            ]);
            const [localActive, localArchive] = await Promise.all([
                chatDB.getSetting(TICKETS_ACTIVE_KEY),
                chatDB.getSetting(TICKETS_ARCHIVE_KEY)
            ]);
            const filteredActive = filterTicketsByInvalidatedKeyIds(
                localActive,
                mergedKeyIds
            );
            const filteredArchive = filterTicketsByInvalidatedKeyIds(
                localArchive,
                mergedKeyIds
            );

            if (typeof chatDB.saveSettings === 'function') {
                await chatDB.saveSettings([
                    { key: TICKETS_INVALIDATED_KEYS_KEY, value: mergedKeyIds },
                    { key: TICKETS_ACTIVE_KEY, value: filteredActive },
                    { key: TICKETS_ARCHIVE_KEY, value: filteredArchive }
                ]);
            } else {
                await chatDB.saveSetting(TICKETS_INVALIDATED_KEYS_KEY, mergedKeyIds);
                await chatDB.saveSetting(TICKETS_ACTIVE_KEY, filteredActive);
                await chatDB.saveSetting(TICKETS_ARCHIVE_KEY, filteredArchive);
            }
        });
    }

    async _mergePreference(key, value, incomingUpdatedAt = null) {
        if (!key) return false;

        const timestampKey = this.getPreferenceTimestampKey(key);
        const [localUpdatedAtRaw] = await Promise.all([
            chatDB.getSetting(timestampKey)
        ]);

        const localUpdatedAt = this.normalizeTimestamp(localUpdatedAtRaw);
        const remoteUpdatedAt = this.normalizeTimestamp(incomingUpdatedAt);

        // Legacy payloads may not include timestamps.
        // If we have local timestamped data, keep it to avoid clobbering recent local edits.
        if (remoteUpdatedAt === null && localUpdatedAt !== null) {
            return false;
        }
        if (remoteUpdatedAt !== null && localUpdatedAt !== null && remoteUpdatedAt < localUpdatedAt) {
            return false;
        }

        const resolvedUpdatedAt = remoteUpdatedAt || Date.now();

        if (typeof chatDB.saveSettings === 'function') {
            await chatDB.saveSettings([
                { key, value },
                { key: timestampKey, value: resolvedUpdatedAt }
            ]);
        } else {
            await chatDB.saveSetting(key, value);
            await chatDB.saveSetting(timestampKey, resolvedUpdatedAt);
        }

        return true;
    }

    async _push(masterKey, accessToken) {
        const blobs = await this._collectLocalBlobs(masterKey);
        if (blobs.length === 0) {
            return { count: 0 };
        }

        let acceptedCount = 0;
        let currentAccessToken = accessToken;
        for (
            let offset = 0;
            offset < blobs.length;
            offset += MAX_SYNC_BLOBS_PER_REQUEST
        ) {
            const batch = blobs.slice(
                offset,
                offset + MAX_SYNC_BLOBS_PER_REQUEST
            );
            let response = await this.fetchWithRetry(
                `${ORG_API_BASE}/auth/sync`,
                {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${currentAccessToken}`,
                        'Content-Type': 'application/json'
                    },
                    credentials: 'include',
                    body: JSON.stringify({ blobs: batch })
                },
                'Sync push'
            );
            if (response.status === 401) {
                const refreshed = await this.refreshAccessToken();
                if (!refreshed) throw new Error('Authentication failed');
                currentAccessToken = this.getAccessToken();
                response = await this.fetchWithRetry(
                    `${ORG_API_BASE}/auth/sync`,
                    {
                        method: 'POST',
                        headers: {
                            'Authorization': `Bearer ${currentAccessToken}`,
                            'Content-Type': 'application/json'
                        },
                        credentials: 'include',
                        body: JSON.stringify({ blobs: batch })
                    },
                    'Sync push'
                );
            }
            if (!response.ok) {
                throw new Error(`Push failed: ${response.status}`);
            }

            const { accepted } = await response.json();
            acceptedCount += accepted?.length || 0;
        }
        return { count: acceptedCount };
    }

    /**
     * Collect local data, encrypt with type INSIDE, use opaque IDs.
     */
    async _collectLocalBlobs(masterKey) {
        const blobs = [];

        // Tickets (active)
        const activeTickets = await chatDB.getSetting(TICKETS_ACTIVE_KEY);
        if (activeTickets && activeTickets.length > 0) {
            const opaqueId = await deriveOpaqueBlobId(masterKey, LOGICAL_IDS.TICKETS_ACTIVE);
            const { ciphertext, iv } = await encryptBlob(
                masterKey,
                LOGICAL_IDS.TICKETS_ACTIVE,
                { type: 'tickets', data: activeTickets }  // Type is INSIDE
            );
            blobs.push({ id: opaqueId, ciphertext, iv, version: 1 });
        }

        // Tickets (archived)
        const archivedTickets = await chatDB.getSetting(TICKETS_ARCHIVE_KEY);
        if (archivedTickets && archivedTickets.length > 0) {
            const opaqueId = await deriveOpaqueBlobId(masterKey, LOGICAL_IDS.TICKETS_ARCHIVE);
            const { ciphertext, iv } = await encryptBlob(
                masterKey,
                LOGICAL_IDS.TICKETS_ARCHIVE,
                { type: 'tickets', data: archivedTickets }  // Type is INSIDE
            );
            blobs.push({ id: opaqueId, ciphertext, iv, version: 1 });
        }

        // Invalidated generation fingerprints are encrypted tombstones. They
        // prevent union-based ticket sync from resurrecting deleted tickets.
        const invalidatedKeyIds = normalizeInvalidatedTicketKeyIds(
            await chatDB.getSetting(TICKETS_INVALIDATED_KEYS_KEY)
        );
        if (invalidatedKeyIds.length > 0) {
            // Keep the aggregate record for migration and older clients.
            const opaqueId = await deriveOpaqueBlobId(
                masterKey,
                LOGICAL_IDS.TICKETS_INVALIDATED_KEYS
            );
            const { ciphertext, iv } = await encryptBlob(
                masterKey,
                LOGICAL_IDS.TICKETS_INVALIDATED_KEYS,
                { type: 'ticket-invalidations', data: invalidatedKeyIds }
            );
            blobs.push({ id: opaqueId, ciphertext, iv, version: 1 });

            // Each generation also gets an immutable logical record with its
            // own HMAC-derived opaque ID. LWW updates of the same key are safe,
            // while different devices invalidating different generations can
            // no longer overwrite each other's tombstones.
            for (const keyId of invalidatedKeyIds) {
                const itemLogicalId = (
                    `${LOGICAL_IDS.TICKET_INVALIDATION_ITEM}:${keyId}`
                );
                const itemOpaqueId = await deriveOpaqueBlobId(
                    masterKey,
                    itemLogicalId
                );
                const encryptedItem = await encryptBlob(
                    masterKey,
                    LOGICAL_IDS.TICKET_INVALIDATION_ITEM,
                    { type: 'ticket-invalidation', key_id: keyId }
                );
                blobs.push({
                    id: itemOpaqueId,
                    ciphertext: encryptedItem.ciphertext,
                    iv: encryptedItem.iv,
                    version: 1
                });
            }
        }

        // Preferences
        for (const key of SYNCABLE_PREF_KEYS) {
            const value = await chatDB.getSetting(key);
            if (value !== undefined) {
                const updatedAt = this.normalizeTimestamp(
                    await chatDB.getSetting(this.getPreferenceTimestampKey(key))
                );
                const opaqueId = await deriveOpaqueBlobId(masterKey, key);
                const { ciphertext, iv } = await encryptBlob(
                    masterKey,
                    key,
                    { type: 'preference', key, value, updatedAt }  // Type and key are INSIDE
                );
                blobs.push({ id: opaqueId, ciphertext, iv, version: 1 });
            }
        }

        return blobs;
    }

    // =========================================================================
    // Background polling - keeps local DB fresh
    // =========================================================================

    startPeriodicSync(options = {}) {
        this.stopPeriodicSync();

        const statusCheckInterval = options.statusCheckInterval || 5 * 60 * 1000;   // 5min default
        const fullSyncInterval = options.fullSyncInterval || 30 * 60 * 1000;       // 30min full sync fallback

        // Fast status polling - check if server has newer data
        const doStatusCheck = async () => {
            if (document.visibilityState !== 'visible' || !this.isEnabled()) return;
            
            try {
                const hasChanges = await this.hasRemoteChanges();
                if (hasChanges) {
                    await this.sync();
                }
            } catch (err) {
                console.warn('[SyncService] Background status check failed:', err);
            }
        };

        // Full sync periodically as fallback
        const doFullSync = async () => {
            if (document.visibilityState === 'visible' && this.isEnabled()) {
                await this.sync().catch(() => {});
            }
        };

        this.statusCheckTimer = setInterval(doStatusCheck, statusCheckInterval);
        this.fullSyncTimer = setInterval(doFullSync, fullSyncInterval);

        // Sync when tab becomes visible
        this.visibilityHandler = () => {
            if (document.visibilityState === 'visible' && this.isEnabled()) {
                doStatusCheck();
            }
        };
        document.addEventListener('visibilitychange', this.visibilityHandler);

        // Initial status check
        doStatusCheck();
    }

    stopPeriodicSync() {
        if (this.statusCheckTimer) {
            clearInterval(this.statusCheckTimer);
            this.statusCheckTimer = null;
        }
        if (this.fullSyncTimer) {
            clearInterval(this.fullSyncTimer);
            this.fullSyncTimer = null;
        }
        if (this.visibilityHandler) {
            document.removeEventListener('visibilitychange', this.visibilityHandler);
            this.visibilityHandler = null;
        }
    }

    // =========================================================================
    // Cleanup
    // =========================================================================

    async clearAll() {
        this.stopPeriodicSync();
        this.clearCredentials();
        await chatDB.deleteSetting(SYNC_LAST_TIME_KEY);
        this.lastSyncTime = null;
        this.lastSyncResult = null;
        this.notify('cleared');
    }
}

const syncService = new SyncService();

export default syncService;
