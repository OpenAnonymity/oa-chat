/**
 * Encrypted Sync Service
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

import { ORG_API_BASE } from './orgEndpoints.js';
import { chatDB } from '../db.js';
import { fetchRetry } from './fetchRetry.js';
import storageEvents from './storageEvents.js';
import { withAccountDataLock } from './accountDataLock.js';
import {
    filterTicketsByTombstones,
    mergeTicketTombstones
} from './ticketTombstones.js';
import {
    filterTicketsByInvalidatedKeyIds,
    normalizeInvalidatedTicketKeyIds,
    normalizeTicketKeyId
} from '../domain/ticketKeys.js';

const SYNC_SALT = 'oa-sync-v1';
const HMAC_SALT = 'oa-sync-id-v1';
const SYNC_ACCOUNT_SCOPE_KEY = 'sync-account-scope';
const SYNC_ACCOUNT_SCOPE_PREFIX = 'sync-account-data:';
const SYNC_UNCLAIMED_SCOPE_KEY = 'sync-unclaimed-data';
const ACCOUNT_SETTINGS_KEY = 'account-settings';

// Settings keys for sync metadata (local only)
const SYNC_LAST_TIME_KEY = 'sync-lastSyncTime';
const SYNC_SCHEMA_VERSION_KEY = 'sync-schema-version';
const CURRENT_SYNC_SCHEMA_VERSION = 2;

// Settings keys for syncable data
const TICKETS_ACTIVE_KEY = 'tickets-active';
const TICKETS_ARCHIVE_KEY = 'tickets-archive';
const TICKETS_TOMBSTONES_KEY = 'tickets-tombstones';
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
    TICKETS_TOMBSTONES: 'tickets-tombstones',
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
async function deriveOpaqueBlobId(keyMaterial, logicalId) {
    const key = keyMaterial?.idKey instanceof CryptoKey
        ? keyMaterial.idKey
        : await crypto.subtle.importKey(
            'raw',
            keyMaterial,
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
async function deriveItemKey(keyMaterial, logicalId) {
    const baseKey = keyMaterial?.derivationKey instanceof CryptoKey
        ? keyMaterial.derivationKey
        : await crypto.subtle.importKey(
            'raw',
            keyMaterial,
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
async function encryptBlob(keyMaterial, logicalId, payload) {
    const itemKey = await deriveItemKey(keyMaterial, logicalId);
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
async function decryptBlob(keyMaterial, logicalId, ciphertext, iv) {
    const itemKey = await deriveItemKey(keyMaterial, logicalId);
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
        this.keyMaterial = null;
        this.accessToken = null;
        this.refreshTokenCallback = null;
        this.accountId = null;
        this.localScopeAccountId = null;
        this.identityBacked = false;
        this.credentialGeneration = 0;

        // Cache: opaque ID -> logical ID mapping (computed on init)
        this.idMapping = null;
        this.idMappingGeneration = null;

        // Debounce for local change sync
        this.localChangeDebounceTimer = null;
        this.lastSyncTime = null;
        this.lastSyncResult = null;
    }

    setCredentials(
        keyMaterial,
        accessToken,
        refreshCallback,
        accountId,
        { identityBacked = false } = {}
    ) {
        this.credentialGeneration += 1;
        this.keyMaterial = keyMaterial;
        this.accessToken = accessToken;
        this.refreshTokenCallback = refreshCallback;
        this.accountId = accountId;
        this.localScopeAccountId = accountId;
        this.identityBacked = identityBacked;
        this.idMapping = null; // Reset mapping when credentials change
        this.idMappingGeneration = null;
    }

    updateAccessToken(accessToken) {
        this.accessToken = accessToken;
    }

    clearCredentials() {
        this.credentialGeneration += 1;
        if (this.localChangeDebounceTimer) {
            clearTimeout(this.localChangeDebounceTimer);
            this.localChangeDebounceTimer = null;
        }
        this.keyMaterial = null;
        this.accessToken = null;
        this.refreshTokenCallback = null;
        this.accountId = null;
        this.identityBacked = false;
        this.idMapping = null;
        this.idMappingGeneration = null;
        this.stopPeriodicSync();
    }

    async init() {
        if (!chatDB.db && typeof chatDB.init === 'function') {
            await chatDB.init();
        }
        // No separate enabled flag - sync is enabled when we have credentials
    }

    getAccountScopedSettingKeys() {
        return [
            TICKETS_ACTIVE_KEY,
            TICKETS_ARCHIVE_KEY,
            TICKETS_TOMBSTONES_KEY,
            TICKETS_INVALIDATED_KEYS_KEY,
            SYNC_LAST_TIME_KEY,
            SYNC_SCHEMA_VERSION_KEY,
            ...SYNCABLE_PREF_KEYS,
            ...SYNCABLE_PREF_KEYS.map(key => this.getPreferenceTimestampKey(key))
        ];
    }

    getAccountScopeStorageKey(accountId) {
        return `${SYNC_ACCOUNT_SCOPE_PREFIX}${accountId}`;
    }

    async readActiveAccountData() {
        const snapshot = {};
        for (const key of this.getAccountScopedSettingKeys()) {
            const value = await chatDB.getSetting(key);
            if (value !== undefined) {
                snapshot[key] = value;
            }
        }
        return snapshot;
    }

    buildActiveAccountDataChanges(snapshot = {}) {
        const entries = [];
        const deleteKeys = [];
        for (const key of this.getAccountScopedSettingKeys()) {
            if (Object.prototype.hasOwnProperty.call(snapshot, key)) {
                entries.push({ key, value: snapshot[key] });
            } else {
                deleteKeys.push(key);
            }
        }
        return { entries, deleteKeys };
    }

    snapshotHasValues(snapshot) {
        return Object.keys(snapshot || {}).length > 0;
    }

    async withSyncLock(callback) {
        return withAccountDataLock(callback);
    }

    setLocalAccountScope(accountId) {
        this.localScopeAccountId = accountId || null;
    }

    async bootstrapLocalAccountScope() {
        if (this.localScopeAccountId) {
            return this.localScopeAccountId;
        }
        const settings = await chatDB.getSetting(ACCOUNT_SETTINGS_KEY)
            .catch(() => null);
        this.setLocalAccountScope(settings?.accountId || null);
        return this.localScopeAccountId;
    }

    async assertAccountDataAccess() {
        const persistedAccountId = (
            await chatDB.getSetting(SYNC_ACCOUNT_SCOPE_KEY)
        ) || null;
        const localAccountId = this.localScopeAccountId;
        if (persistedAccountId !== localAccountId) {
            throw new Error('Account data scope changed in another tab');
        }
        return persistedAccountId;
    }

    canAccessAccountScope(accountId) {
        return (accountId || null) === this.localScopeAccountId;
    }

    getLocalAccountScope() {
        return this.localScopeAccountId;
    }

    async notifyLocalAccountScopeInvalidated() {
        const notifications = [];
        this.listeners.forEach(handler => {
            try {
                notifications.push(
                    Promise.resolve(handler({
                        event: 'account_scope_invalidated',
                        data: null,
                        timestamp: Date.now()
                    }))
                );
            } catch (error) {
                console.warn('Sync listener error:', error);
            }
        });
        await Promise.allSettled(notifications);
    }

    async notifyAccountScopeChanged(accountId) {
        const payload = { accountId: accountId || null };
        const notifications = [];
        this.listeners.forEach(handler => {
            try {
                notifications.push(
                    Promise.resolve(handler({
                        event: 'account_scope_changed',
                        data: payload,
                        timestamp: Date.now()
                    }))
                );
            } catch (error) {
                console.warn('Sync listener error:', error);
            }
        });
        await Promise.allSettled(notifications);
        storageEvents.init();
        storageEvents.broadcast('account-scope-changed', payload);
    }

    /**
     * Put the account's tickets/preferences into the shared live settings keys.
     *
     * Older builds had no scope marker. On the first activation after upgrade,
     * existing live values are adopted by the already-authenticated account.
     */
    async activateAccountScope(accountId, { adoptUnscoped = false } = {}) {
        if (!accountId) throw new Error('Cannot activate an empty account scope');
        return this.withSyncLock(async () => {
            const currentAccountId = await chatDB.getSetting(
                SYNC_ACCOUNT_SCOPE_KEY
            );
            if (currentAccountId === accountId) {
                this.setLocalAccountScope(accountId);
                await this.notifyAccountScopeChanged(accountId);
                return;
            }

            const liveSnapshot = await this.readActiveAccountData();
            const targetSnapshot = await chatDB.getSetting(
                this.getAccountScopeStorageKey(accountId)
            );
            const entries = [];
            const deleteKeys = [];
            if (currentAccountId) {
                entries.push({
                    key: this.getAccountScopeStorageKey(currentAccountId),
                    value: liveSnapshot
                });
            }

            let nextSnapshot = {};
            if (targetSnapshot && typeof targetSnapshot === 'object') {
                if (!currentAccountId && this.snapshotHasValues(liveSnapshot)) {
                    entries.push({
                        key: SYNC_UNCLAIMED_SCOPE_KEY,
                        value: liveSnapshot
                    });
                }
                nextSnapshot = targetSnapshot;
            } else if (!currentAccountId && adoptUnscoped) {
                nextSnapshot = liveSnapshot;
                if (this.snapshotHasValues(liveSnapshot)) {
                    deleteKeys.push(SYNC_UNCLAIMED_SCOPE_KEY);
                }
            } else if (!currentAccountId && this.snapshotHasValues(liveSnapshot)) {
                entries.push({
                    key: SYNC_UNCLAIMED_SCOPE_KEY,
                    value: liveSnapshot
                });
            }

            const liveChanges = this.buildActiveAccountDataChanges(nextSnapshot);
            entries.push(
                ...liveChanges.entries,
                { key: SYNC_ACCOUNT_SCOPE_KEY, value: accountId }
            );
            deleteKeys.push(...liveChanges.deleteKeys);
            await chatDB.updateSettings(entries, [...new Set(deleteKeys)]);
            this.setLocalAccountScope(accountId);
            await this.notifyAccountScopeChanged(accountId);
        });
    }

    /**
     * Snapshot and hide account-bound data at logout. A later login to the same
     * account restores it before remote sync begins.
     */
    async deactivateAccountScope(accountId) {
        return this.withSyncLock(async () => {
            const currentAccountId = await chatDB.getSetting(
                SYNC_ACCOUNT_SCOPE_KEY
            );
            if (!currentAccountId) {
                if (
                    accountId &&
                    this.localScopeAccountId === accountId
                ) {
                    this.setLocalAccountScope(null);
                    await this.notifyLocalAccountScopeInvalidated();
                }
                return;
            }
            if (accountId && currentAccountId !== accountId) {
                if (this.localScopeAccountId === accountId) {
                    this.setLocalAccountScope(null);
                    await this.notifyLocalAccountScopeInvalidated();
                }
                return;
            }

            const liveSnapshot = await this.readActiveAccountData();
            const unclaimedSnapshot = await chatDB.getSetting(
                SYNC_UNCLAIMED_SCOPE_KEY
            );
            const nextSnapshot =
                unclaimedSnapshot && typeof unclaimedSnapshot === 'object'
                    ? unclaimedSnapshot
                    : {};
            const liveChanges = this.buildActiveAccountDataChanges(nextSnapshot);
            await chatDB.updateSettings(
                [
                    {
                        key: this.getAccountScopeStorageKey(currentAccountId),
                        value: liveSnapshot
                    },
                    ...liveChanges.entries
                ],
                [
                    ...liveChanges.deleteKeys,
                    SYNC_ACCOUNT_SCOPE_KEY
                ]
            );
            if (this.localScopeAccountId === currentAccountId) {
                this.setLocalAccountScope(null);
            }
            await this.notifyAccountScopeChanged(null);
        });
    }

    async isAccountScopeActive(accountId = this.accountId) {
        if (!accountId) return false;
        return await chatDB.getSetting(SYNC_ACCOUNT_SCOPE_KEY) === accountId;
    }

    /**
     * Build the mapping of opaque IDs to logical IDs.
     * This lets us identify what a blob is when we pull it.
     */
    async _buildIdMapping(
        keyMaterial,
        credentialGeneration = this.credentialGeneration
    ) {
        if (
            this.idMapping &&
            this.idMappingGeneration === credentialGeneration
        ) {
            return this.idMapping;
        }

        const mapping = new Map();
        
        const ticketsActiveId = await deriveOpaqueBlobId(keyMaterial, LOGICAL_IDS.TICKETS_ACTIVE);
        const ticketsArchiveId = await deriveOpaqueBlobId(keyMaterial, LOGICAL_IDS.TICKETS_ARCHIVE);
        const ticketsTombstonesId = await deriveOpaqueBlobId(
            keyMaterial,
            LOGICAL_IDS.TICKETS_TOMBSTONES
        );
        const invalidatedKeysId = await deriveOpaqueBlobId(
            keyMaterial,
            LOGICAL_IDS.TICKETS_INVALIDATED_KEYS
        );
        mapping.set(ticketsActiveId, LOGICAL_IDS.TICKETS_ACTIVE);
        mapping.set(ticketsArchiveId, LOGICAL_IDS.TICKETS_ARCHIVE);
        mapping.set(
            ticketsTombstonesId,
            LOGICAL_IDS.TICKETS_TOMBSTONES
        );
        mapping.set(
            invalidatedKeysId,
            LOGICAL_IDS.TICKETS_INVALIDATED_KEYS
        );

        // Preferences
        for (const key of SYNCABLE_PREF_KEYS) {
            const opaqueId = await deriveOpaqueBlobId(keyMaterial, key);
            mapping.set(opaqueId, key);
        }

        this.assertCredentialsCurrent(credentialGeneration);
        this.idMapping = mapping;
        this.idMappingGeneration = credentialGeneration;
        return mapping;
    }

    /**
     * Sync is enabled when we have credentials (logged in).
     * No separate flag needed.
     */
    isEnabled() {
        return !!(this.keyMaterial && this.accessToken && this.accountId);
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

    triggerTicketSync(delayMs = 2000) {
        this.triggerSync(delayMs);
    }

    shouldDeferRedemptionSync() {
        return this.identityBacked;
    }

    /**
     * Quick check if server has newer data than local.
     * Returns true if we need to pull, false if up-to-date.
     */
    async hasRemoteChanges() {
        if (!this.isEnabled()) {
            return false;
        }
        if (!await this.isAccountScopeActive()) {
            return false;
        }
        const credentialGeneration = this.credentialGeneration;
        const accessToken = this.accessToken;

        try {
            const response = await fetch(
                `${ORG_API_BASE}/auth/sync/status`,
                {
                    method: 'GET',
                    headers: {
                        'Authorization': `Bearer ${accessToken}`,
                        'Content-Type': 'application/json'
                    },
                    credentials: 'include'
                }
            );
            if (!this.credentialsAreCurrent(credentialGeneration)) return false;

            if (!response.ok) return false;

            const { last_sync: serverLastSync } = await response.json();
            if (!this.credentialsAreCurrent(credentialGeneration)) return false;
            const localLastSync = await chatDB.getSetting(SYNC_LAST_TIME_KEY) || 0;
            if (!this.credentialsAreCurrent(credentialGeneration)) return false;

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
        return this.keyMaterial;
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

    credentialsAreCurrent(generation) {
        return generation === this.credentialGeneration;
    }

    assertCredentialsCurrent(generation) {
        if (!this.credentialsAreCurrent(generation)) {
            throw new Error('Sync credentials changed');
        }
    }

    async refreshAccessToken(generation = this.credentialGeneration) {
        if (!this.credentialsAreCurrent(generation)) return false;
        if (!this.refreshTokenCallback) return false;
        try {
            const result = await this.refreshTokenCallback();
            if (this.credentialsAreCurrent(generation) && result?.accessToken) {
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
        const accountId = this.accountId;
        const credentialGeneration = this.credentialGeneration;

        // Set syncing state immediately for UI feedback
        this.syncInProgress = true;
        this.notify('sync_start');

        return this.withSyncLock(
            () => this._doSync(
                masterKey,
                accessToken,
                accountId,
                credentialGeneration
            )
        );
    }

    async _doSync(
        masterKey,
        accessToken,
        accountId,
        credentialGeneration
    ) {

        try {
            this.assertCredentialsCurrent(credentialGeneration);
            if (!await this.isAccountScopeActive(accountId)) {
                throw new Error('Sync account scope changed');
            }
            this.assertCredentialsCurrent(credentialGeneration);
            // Build ID mapping first
            const idMapping = await this._buildIdMapping(
                masterKey,
                credentialGeneration
            );
            this.assertCredentialsCurrent(credentialGeneration);

            const pullResult = await this._pull(
                masterKey,
                accessToken,
                credentialGeneration,
                idMapping
            );
            this.assertCredentialsCurrent(credentialGeneration);
            const pushResult = await this._push(
                masterKey,
                accessToken,
                credentialGeneration
            );
            this.assertCredentialsCurrent(credentialGeneration);

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
            if (!this.credentialsAreCurrent(credentialGeneration)) {
                return {
                    success: false,
                    error: 'Sync credentials changed',
                    stale: true
                };
            }
            console.error('[SyncService] Sync failed:', error);
            const result = { success: false, error: error.message };
            this.lastSyncResult = result;
            this.notify('sync_error', { error: error.message });
            return result;
        } finally {
            this.syncInProgress = false;
            if (this.credentialsAreCurrent(credentialGeneration)) {
                this.notify('sync_end');
            }
        }
    }

    async _pull(
        masterKey,
        accessToken,
        credentialGeneration = this.credentialGeneration,
        idMapping = this.idMapping || new Map()
    ) {
        this.assertCredentialsCurrent(credentialGeneration);
        const localSchemaVersion = Number(
            await chatDB.getSetting(SYNC_SCHEMA_VERSION_KEY)
        ) || 0;
        // Version 2 introduced dynamically addressed per-generation
        // invalidation records. Each account performs one full pull after
        // upgrade so blobs skipped as unknown by an older client are found.
        const lastSync = localSchemaVersion < CURRENT_SYNC_SCHEMA_VERSION
            ? 0
            : await chatDB.getSetting(SYNC_LAST_TIME_KEY) || 0;
        this.assertCredentialsCurrent(credentialGeneration);

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
        this.assertCredentialsCurrent(credentialGeneration);

        if (!response.ok) {
            if (response.status === 401) {
                const refreshed = await this.refreshAccessToken(credentialGeneration);
                if (!refreshed) throw new Error('Authentication failed');
                return this._pull(
                    masterKey,
                    this.getAccessToken(),
                    credentialGeneration,
                    idMapping
                );
            }
            throw new Error(`Pull failed: ${response.status}`);
        }

        const { blobs, server_time } = await response.json();
        this.assertCredentialsCurrent(credentialGeneration);
        let mergedCount = 0;

        for (const serverBlob of blobs || []) {
            this.assertCredentialsCurrent(credentialGeneration);
            const applied = await this._applyServerBlob(
                masterKey,
                serverBlob,
                credentialGeneration,
                idMapping
            );
            this.assertCredentialsCurrent(credentialGeneration);
            if (applied) mergedCount++;
        }

        const syncMetadata = [{
            key: SYNC_SCHEMA_VERSION_KEY,
            value: CURRENT_SYNC_SCHEMA_VERSION
        }];
        if (server_time) {
            syncMetadata.push({ key: SYNC_LAST_TIME_KEY, value: server_time });
        }
        this.assertCredentialsCurrent(credentialGeneration);
        if (typeof chatDB.saveSettings === 'function') {
            await chatDB.saveSettings(syncMetadata);
        } else {
            for (const entry of syncMetadata) {
                await chatDB.saveSetting(entry.key, entry.value);
                this.assertCredentialsCurrent(credentialGeneration);
            }
        }
        this.assertCredentialsCurrent(credentialGeneration);

        return { count: mergedCount };
    }

    async _applyServerBlob(
        masterKey,
        serverBlob,
        credentialGeneration = this.credentialGeneration,
        idMapping = this.idMapping || new Map()
    ) {
        this.assertCredentialsCurrent(credentialGeneration);
        if (!serverBlob.ciphertext || !serverBlob.iv) return false;

        // Fixed records map directly. Per-generation invalidation records use
        // distinct opaque IDs so concurrent devices cannot overwrite one
        // another; unknown IDs are therefore probed with the shared item key.
        const mappedLogicalId = idMapping.get(serverBlob.id);
        const logicalId = mappedLogicalId || LOGICAL_IDS.TICKET_INVALIDATION_ITEM;

        let payload;
        try {
            // Decrypt - the payload contains type and data
            payload = await decryptBlob(
                masterKey,
                logicalId,
                serverBlob.ciphertext,
                serverBlob.iv
            );
            if (!mappedLogicalId) {
                const keyId = normalizeTicketKeyId(payload?.key_id);
                if (payload?.type !== 'ticket-invalidation' || !keyId) {
                    console.warn('[SyncService] Unknown blob ID:', serverBlob.id);
                    return false;
                }
                const expectedOpaqueId = await deriveOpaqueBlobId(
                    masterKey,
                    `${LOGICAL_IDS.TICKET_INVALIDATION_ITEM}:${keyId}`
                );
                if (expectedOpaqueId !== serverBlob.id) {
                    console.warn('[SyncService] Invalid ticket tombstone ID');
                    return false;
                }
            }
        } catch (error) {
            if (mappedLogicalId) {
                console.warn('[SyncService] Failed to decrypt blob:', serverBlob.id, error);
            } else {
                console.warn('[SyncService] Unknown blob ID:', serverBlob.id);
            }
            return false;
        }
        this.assertCredentialsCurrent(credentialGeneration);

        // Apply based on type (stored inside encrypted payload)
        let applied = false;
        if (payload.type === 'tickets') {
            await this._mergeTickets(
                logicalId,
                payload.data,
                credentialGeneration
            );
            applied = true;
        } else if (payload.type === 'ticket-invalidations') {
            await this._mergeTicketInvalidations(
                payload.data,
                credentialGeneration
            );
            applied = true;
        } else if (payload.type === 'ticket-invalidation') {
            await this._mergeTicketInvalidations(
                [payload.key_id],
                credentialGeneration
            );
            applied = true;
        } else if (payload.type === 'preference') {
            applied = await this._mergePreference(
                payload.key,
                payload.value,
                payload.updatedAt,
                credentialGeneration
            );
        }
        this.assertCredentialsCurrent(credentialGeneration);

        if (applied) {
            this.notify('blob_received', { type: payload.type, logicalId });
            if (
                payload.type === 'tickets' ||
                payload.type === 'ticket-invalidations' ||
                payload.type === 'ticket-invalidation'
            ) {
                storageEvents.broadcast(
                    'tickets-updated',
                    {
                        accountId: this.accountId,
                        updatedAt: Date.now()
                    }
                );
            }
        }
        return applied;
    }

    /**
     * CRDT merge for tickets.
     * Key principle: consumed state ALWAYS wins.
     * If a ticket is in archive (consumed) anywhere, it's consumed everywhere.
     */
    async _mergeTickets(
        logicalId,
        serverTickets,
        credentialGeneration = this.credentialGeneration
    ) {
        this.assertCredentialsCurrent(credentialGeneration);
        const isArchive = logicalId === LOGICAL_IDS.TICKETS_ARCHIVE;
        const isTombstones =
            logicalId === LOGICAL_IDS.TICKETS_TOMBSTONES;
        const incomingTickets = Array.isArray(serverTickets) ? serverTickets : [];

        // Every ticket merge honors both per-ticket cash-transfer tombstones
        // and global issuer-generation invalidation tombstones.
        const [localActive, localArchive, localTombstones, rawInvalidatedKeyIds] =
            await Promise.all([
                chatDB.getSetting(TICKETS_ACTIVE_KEY),
                chatDB.getSetting(TICKETS_ARCHIVE_KEY),
                chatDB.getSetting(TICKETS_TOMBSTONES_KEY),
                chatDB.getSetting(TICKETS_INVALIDATED_KEYS_KEY)
            ]);
        this.assertCredentialsCurrent(credentialGeneration);
        const active = Array.isArray(localActive) ? localActive : [];
        const archive = Array.isArray(localArchive) ? localArchive : [];
        const tombstones = Array.isArray(localTombstones) ? localTombstones : [];
        const invalidatedKeyIds = normalizeInvalidatedTicketKeyIds(
            rawInvalidatedKeyIds
        );

        const filterAllTombstones = async (tickets, ticketTombstones = tombstones) =>
            filterTicketsByTombstones(
                filterTicketsByInvalidatedKeyIds(tickets, invalidatedKeyIds),
                ticketTombstones
            );

        if (isTombstones) {
            const mergedTombstones = mergeTicketTombstones(
                tombstones,
                incomingTickets
            );
            const [filteredActive, filteredArchive] = await Promise.all([
                filterAllTombstones(active, mergedTombstones),
                filterAllTombstones(archive, mergedTombstones)
            ]);
            this.assertCredentialsCurrent(credentialGeneration);
            await chatDB.saveSettings([
                {
                    key: TICKETS_TOMBSTONES_KEY,
                    value: mergedTombstones
                },
                { key: TICKETS_ACTIVE_KEY, value: filteredActive },
                { key: TICKETS_ARCHIVE_KEY, value: filteredArchive }
            ]);
            this.assertCredentialsCurrent(credentialGeneration);
            return;
        }

        const [tickets, filteredLocalActive, filteredLocalArchive] =
            await Promise.all([
                filterAllTombstones(incomingTickets),
                filterAllTombstones(active),
                filterAllTombstones(archive)
            ]);
        this.assertCredentialsCurrent(credentialGeneration);

        if (isArchive) {
            // Merging archive (consumed tickets) - union of all consumed
            const consumedIds = new Set(
                filteredLocalArchive.map(ticket => ticket.finalized_ticket)
            );
            const mergedArchive = [...filteredLocalArchive];

            for (const ticket of tickets) {
                if (ticket.finalized_ticket && !consumedIds.has(ticket.finalized_ticket)) {
                    mergedArchive.push(ticket);
                    consumedIds.add(ticket.finalized_ticket);
                }
            }

            // CRDT: consumed state wins over active state.
            const filteredActive = filteredLocalActive.filter(ticket =>
                !consumedIds.has(ticket.finalized_ticket)
            );
            this.assertCredentialsCurrent(credentialGeneration);
            await chatDB.saveSettings([
                { key: TICKETS_ARCHIVE_KEY, value: mergedArchive },
                { key: TICKETS_ACTIVE_KEY, value: filteredActive }
            ]);
            this.assertCredentialsCurrent(credentialGeneration);
        } else {
            // Merging active tickets - add new ones, but respect consumed state
            const consumedIds = new Set(
                filteredLocalArchive.map(ticket => ticket.finalized_ticket)
            );
            const activeIds = new Set(
                filteredLocalActive.map(ticket => ticket.finalized_ticket)
            );
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

            this.assertCredentialsCurrent(credentialGeneration);
            await chatDB.saveSettings([
                { key: TICKETS_ACTIVE_KEY, value: mergedActive },
                { key: TICKETS_ARCHIVE_KEY, value: filteredLocalArchive }
            ]);
            this.assertCredentialsCurrent(credentialGeneration);
        }
    }

    async _mergeTicketInvalidations(
        serverKeyIds,
        credentialGeneration = this.credentialGeneration
    ) {
        this.assertCredentialsCurrent(credentialGeneration);
        const [rawLocalKeyIds, localActive, localArchive, localTombstones] =
            await Promise.all([
                chatDB.getSetting(TICKETS_INVALIDATED_KEYS_KEY),
                chatDB.getSetting(TICKETS_ACTIVE_KEY),
                chatDB.getSetting(TICKETS_ARCHIVE_KEY),
                chatDB.getSetting(TICKETS_TOMBSTONES_KEY)
            ]);
        this.assertCredentialsCurrent(credentialGeneration);

        const mergedKeyIds = normalizeInvalidatedTicketKeyIds([
            ...normalizeInvalidatedTicketKeyIds(rawLocalKeyIds),
            ...(Array.isArray(serverKeyIds) ? serverKeyIds : [])
        ]);
        const tombstones = Array.isArray(localTombstones) ? localTombstones : [];
        const [filteredActive, filteredArchive] = await Promise.all([
            filterTicketsByTombstones(
                filterTicketsByInvalidatedKeyIds(localActive, mergedKeyIds),
                tombstones
            ),
            filterTicketsByTombstones(
                filterTicketsByInvalidatedKeyIds(localArchive, mergedKeyIds),
                tombstones
            )
        ]);
        this.assertCredentialsCurrent(credentialGeneration);

        await chatDB.saveSettings([
            { key: TICKETS_INVALIDATED_KEYS_KEY, value: mergedKeyIds },
            { key: TICKETS_ACTIVE_KEY, value: filteredActive },
            { key: TICKETS_ARCHIVE_KEY, value: filteredArchive }
        ]);
        this.assertCredentialsCurrent(credentialGeneration);
    }

    async _mergePreference(
        key,
        value,
        incomingUpdatedAt = null,
        credentialGeneration
    ) {
        this.assertCredentialsCurrent(credentialGeneration);
        if (!key) return false;

        const timestampKey = this.getPreferenceTimestampKey(key);
        const [localUpdatedAtRaw] = await Promise.all([
            chatDB.getSetting(timestampKey)
        ]);
        this.assertCredentialsCurrent(credentialGeneration);

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

        this.assertCredentialsCurrent(credentialGeneration);
        if (typeof chatDB.saveSettings === 'function') {
            await chatDB.saveSettings([
                { key, value },
                { key: timestampKey, value: resolvedUpdatedAt }
            ]);
        } else {
            await chatDB.saveSetting(key, value);
            this.assertCredentialsCurrent(credentialGeneration);
            await chatDB.saveSetting(timestampKey, resolvedUpdatedAt);
        }
        this.assertCredentialsCurrent(credentialGeneration);

        return true;
    }

    async _push(
        masterKey,
        accessToken,
        credentialGeneration = this.credentialGeneration
    ) {
        if (!this.credentialsAreCurrent(credentialGeneration)) {
            throw new Error('Sync credentials changed');
        }
        const blobs = await this._collectLocalBlobs(masterKey);
        if (!this.credentialsAreCurrent(credentialGeneration)) {
            throw new Error('Sync credentials changed');
        }
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
            this.assertCredentialsCurrent(credentialGeneration);
            const batch = blobs.slice(
                offset,
                offset + MAX_SYNC_BLOBS_PER_REQUEST
            );
            const sendBatch = token => this.fetchWithRetry(
                `${ORG_API_BASE}/auth/sync`,
                {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${token}`,
                        'Content-Type': 'application/json'
                    },
                    credentials: 'include',
                    body: JSON.stringify({ blobs: batch })
                },
                'Sync push'
            );

            let response = await sendBatch(currentAccessToken);
            this.assertCredentialsCurrent(credentialGeneration);
            if (response.status === 401) {
                const refreshed = await this.refreshAccessToken(
                    credentialGeneration
                );
                if (!refreshed) throw new Error('Authentication failed');
                currentAccessToken = this.getAccessToken();
                response = await sendBatch(currentAccessToken);
                this.assertCredentialsCurrent(credentialGeneration);
            }
            if (!response.ok) {
                throw new Error(`Push failed: ${response.status}`);
            }

            const { accepted } = await response.json();
            this.assertCredentialsCurrent(credentialGeneration);
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
        if (Array.isArray(activeTickets)) {
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
        if (Array.isArray(archivedTickets)) {
            const opaqueId = await deriveOpaqueBlobId(masterKey, LOGICAL_IDS.TICKETS_ARCHIVE);
            const { ciphertext, iv } = await encryptBlob(
                masterKey,
                LOGICAL_IDS.TICKETS_ARCHIVE,
                { type: 'tickets', data: archivedTickets }  // Type is INSIDE
            );
            blobs.push({ id: opaqueId, ciphertext, iv, version: 1 });
        }

        // Removed/exported tickets are represented only by encrypted hashes.
        // This preserves cash-style local deletion while preventing a stale
        // device from resurrecting the ticket.
        const tombstones = await chatDB.getSetting(TICKETS_TOMBSTONES_KEY);
        if (Array.isArray(tombstones)) {
            const opaqueId = await deriveOpaqueBlobId(
                masterKey,
                LOGICAL_IDS.TICKETS_TOMBSTONES
            );
            const { ciphertext, iv } = await encryptBlob(
                masterKey,
                LOGICAL_IDS.TICKETS_TOMBSTONES,
                { type: 'tickets', data: tombstones }
            );
            blobs.push({ id: opaqueId, ciphertext, iv, version: 1 });
        }

        // Invalidated issuer generations are encrypted, append-only
        // tombstones. The aggregate record supports migration; one immutable
        // record per generation prevents concurrent devices from losing a
        // tombstone through last-write-wins updates of the aggregate blob.
        const invalidatedKeyIds = normalizeInvalidatedTicketKeyIds(
            await chatDB.getSetting(TICKETS_INVALIDATED_KEYS_KEY)
        );
        if (invalidatedKeyIds.length > 0) {
            const aggregateId = await deriveOpaqueBlobId(
                masterKey,
                LOGICAL_IDS.TICKETS_INVALIDATED_KEYS
            );
            const aggregate = await encryptBlob(
                masterKey,
                LOGICAL_IDS.TICKETS_INVALIDATED_KEYS,
                { type: 'ticket-invalidations', data: invalidatedKeyIds }
            );
            blobs.push({
                id: aggregateId,
                ciphertext: aggregate.ciphertext,
                iv: aggregate.iv,
                version: 1
            });

            for (const keyId of invalidatedKeyIds) {
                const itemId = await deriveOpaqueBlobId(
                    masterKey,
                    `${LOGICAL_IDS.TICKET_INVALIDATION_ITEM}:${keyId}`
                );
                const item = await encryptBlob(
                    masterKey,
                    LOGICAL_IDS.TICKET_INVALIDATION_ITEM,
                    { type: 'ticket-invalidation', key_id: keyId }
                );
                blobs.push({
                    id: itemId,
                    ciphertext: item.ciphertext,
                    iv: item.iv,
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
        this.lastSyncTime = null;
        this.lastSyncResult = null;
        this.notify('cleared');
    }
}

const syncService = new SyncService();

export default syncService;
