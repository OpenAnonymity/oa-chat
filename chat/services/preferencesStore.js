import storageEvents from './storageEvents.js';
import { chatDB } from '../db.js';
import syncService from './encryptedSyncService.js';
import { withAccountDataLock } from './accountDataLock.js';

const PREF_KEYS = {
    theme: 'pref-theme',
    wideMode: 'pref-wide-mode',
    leftSidebarVisible: 'pref-left-sidebar-visible',
    leftSidebarWidth: 'pref-left-sidebar-width',
    flatMode: 'pref-flat-mode',
    fontMode: 'pref-font-mode',
    rightPanelVisible: 'pref-right-panel-visible',
    ticketInfoVisible: 'pref-ticket-info-visible',
    invitationFormVisible: 'pref-invitation-form-visible',
    welcomeDismissed: 'pref-welcome-dismissed',
    hadTicketsBefore: 'pref-had-tickets-before',
    freeAccessRequested: 'pref-free-access-requested',
    proxySettings: 'pref-network-proxy-settings',
    sharePasswordMode: 'pref-share-password-mode',
    shareExpiryTtl: 'pref-share-expiry-ttl',
    shareCustomExpiryValue: 'pref-share-custom-expiry-value',
    shareCustomExpiryUnit: 'pref-share-custom-expiry-unit',
    agentTraceExpanded: 'pref-agent-trace-expanded'
};

const LOCAL_STORAGE_KEYS = {
    theme: 'oa-theme-preference',
    wideMode: 'oa-wide-mode',
    leftSidebarVisible: 'oa-left-sidebar-visible',
    leftSidebarWidth: 'oa-left-sidebar-width',
    flatMode: 'oa-flat-mode',
    fontMode: 'oa-font-mode',
    rightPanelVisible: 'oa-right-panel-visible',
    ticketInfoVisible: 'oa-ticket-info-visible',
    invitationFormVisible: 'oa-invitation-form-visible',
    welcomeDismissed: 'oa-welcome-dismissed',
    proxySettings: 'oa-network-proxy-settings',
    sharePasswordMode: 'oa-share-password-mode',
    shareExpiryTtl: 'oa-share-expiry-ttl',
    shareCustomExpiryValue: 'oa-share-custom-expiry-value',
    shareCustomExpiryUnit: 'oa-share-custom-expiry-unit'
};

const DEFAULT_PREFERENCES = {
    [PREF_KEYS.theme]: 'system',
    [PREF_KEYS.wideMode]: false,
    [PREF_KEYS.leftSidebarVisible]: null,
    [PREF_KEYS.leftSidebarWidth]: 220,
    [PREF_KEYS.flatMode]: true,
    [PREF_KEYS.fontMode]: 'sans',
    [PREF_KEYS.rightPanelVisible]: null,
    [PREF_KEYS.ticketInfoVisible]: true,
    [PREF_KEYS.invitationFormVisible]: null,
    [PREF_KEYS.welcomeDismissed]: false,
    [PREF_KEYS.hadTicketsBefore]: false,
    [PREF_KEYS.freeAccessRequested]: false,
    [PREF_KEYS.proxySettings]: {
        enabled: true,
        fallbackToDirect: true
    },
    [PREF_KEYS.sharePasswordMode]: 'pin',
    [PREF_KEYS.shareExpiryTtl]: 604800,
    [PREF_KEYS.shareCustomExpiryValue]: 1,
    [PREF_KEYS.shareCustomExpiryUnit]: '86400',
    [PREF_KEYS.agentTraceExpanded]: false
};

const PREF_SNAPSHOT_KEYS = new Set([
    PREF_KEYS.theme,
    PREF_KEYS.wideMode,
    PREF_KEYS.leftSidebarVisible,
    PREF_KEYS.leftSidebarWidth,
    PREF_KEYS.flatMode,
    PREF_KEYS.fontMode,
    PREF_KEYS.rightPanelVisible,
    PREF_KEYS.ticketInfoVisible,
    PREF_KEYS.invitationFormVisible,
    PREF_KEYS.welcomeDismissed
]);

const PREF_SNAPSHOT_MAP = new Map([
    [PREF_KEYS.theme, LOCAL_STORAGE_KEYS.theme],
    [PREF_KEYS.wideMode, LOCAL_STORAGE_KEYS.wideMode],
    [PREF_KEYS.leftSidebarVisible, LOCAL_STORAGE_KEYS.leftSidebarVisible],
    [PREF_KEYS.leftSidebarWidth, LOCAL_STORAGE_KEYS.leftSidebarWidth],
    [PREF_KEYS.flatMode, LOCAL_STORAGE_KEYS.flatMode],
    [PREF_KEYS.fontMode, LOCAL_STORAGE_KEYS.fontMode],
    [PREF_KEYS.rightPanelVisible, LOCAL_STORAGE_KEYS.rightPanelVisible],
    [PREF_KEYS.ticketInfoVisible, LOCAL_STORAGE_KEYS.ticketInfoVisible],
    [PREF_KEYS.invitationFormVisible, LOCAL_STORAGE_KEYS.invitationFormVisible],
    [PREF_KEYS.welcomeDismissed, LOCAL_STORAGE_KEYS.welcomeDismissed]
]);

const SYNCABLE_PREF_KEYS = new Set([
    PREF_KEYS.theme,
    PREF_KEYS.wideMode,
    PREF_KEYS.flatMode,
    PREF_KEYS.fontMode,
    PREF_KEYS.proxySettings
]);

const SYNC_PREF_UPDATED_AT_PREFIX = 'sync-pref-updated-at:';

class PreferencesStore {
    constructor() {
        this.cache = new Map();
        this.listeners = new Set();
        this.initPromise = null;
        this.storageUnsubscribe = null;
        this.scopeStorageUnsubscribe = null;
        this.syncUnsubscribe = null;
    }

    async init() {
        if (this.initPromise) {
            return this.initPromise;
        }

        this.initPromise = (async () => {
            await this.ensureDbReady();
            await syncService.bootstrapLocalAccountScope();
            await this.migrateFromLocalStorage();
            await this.preloadKnownPreferences();

            if (!this.storageUnsubscribe) {
                this.storageUnsubscribe = storageEvents.on('preferences-updated', (payload) => {
                    this.handleExternalPreferenceUpdate(payload).catch(() => {});
                });
            }
            if (!this.scopeStorageUnsubscribe) {
                this.scopeStorageUnsubscribe = storageEvents.on(
                    'account-scope-changed',
                    payload => this.handleAccountScopeChange(payload, {
                        external: true
                    })
                );
            }

            // Reload preferences when sync completes (sync writes directly to settings)
            if (!this.syncUnsubscribe) {
                this.syncUnsubscribe = syncService.subscribe((payload) => {
                    if (payload.event === 'account_scope_invalidated') {
                        return this.clearAccountScopedCache();
                    }
                    if (payload.event === 'account_scope_changed') {
                        return this.handleAccountScopeChange(payload.data);
                    }
                    if (payload.event === 'blob_received' && payload.data?.type === 'preference' && payload.data?.logicalId) {
                        return this.reloadPreferenceFromDatabase(
                            payload.data.logicalId
                        );
                    }
                });
            }
        })();

        return this.initPromise;
    }

    async ensureDbReady() {
        if (typeof chatDB === 'undefined') return;
        if (!chatDB.db && typeof chatDB.init === 'function') {
            try {
                await chatDB.init();
            } catch (error) {
                console.warn('Failed to initialize preferences store:', error);
            }
        }
    }

    async migrateFromLocalStorage() {
        if (typeof localStorage === 'undefined') return;

        const migrations = [
            {
                key: PREF_KEYS.theme,
                storageKey: LOCAL_STORAGE_KEYS.theme,
                parse: (value) => (value === 'light' || value === 'dark' || value === 'system') ? value : null
            },
            {
                key: PREF_KEYS.wideMode,
                storageKey: LOCAL_STORAGE_KEYS.wideMode,
                parse: (value) => value === 'true'
            },
            {
                key: PREF_KEYS.leftSidebarVisible,
                storageKey: LOCAL_STORAGE_KEYS.leftSidebarVisible,
                parse: (value) => value === 'true'
            },
            {
                key: PREF_KEYS.leftSidebarWidth,
                storageKey: LOCAL_STORAGE_KEYS.leftSidebarWidth,
                parse: (value) => {
                    const parsed = parseInt(value, 10);
                    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
                }
            },
            {
                key: PREF_KEYS.flatMode,
                storageKey: LOCAL_STORAGE_KEYS.flatMode,
                parse: (value) => value !== 'false'
            },
            {
                key: PREF_KEYS.fontMode,
                storageKey: LOCAL_STORAGE_KEYS.fontMode,
                parse: (value) => value === 'serif' ? 'serif' : 'sans'
            },
            {
                key: PREF_KEYS.rightPanelVisible,
                storageKey: LOCAL_STORAGE_KEYS.rightPanelVisible,
                parse: (value) => value === 'true'
            },
            {
                key: PREF_KEYS.ticketInfoVisible,
                storageKey: LOCAL_STORAGE_KEYS.ticketInfoVisible,
                parse: (value) => value === 'true'
            },
            {
                key: PREF_KEYS.invitationFormVisible,
                storageKey: LOCAL_STORAGE_KEYS.invitationFormVisible,
                parse: (value) => value === 'true'
            },
            {
                key: PREF_KEYS.welcomeDismissed,
                storageKey: LOCAL_STORAGE_KEYS.welcomeDismissed,
                parse: (value) => value === 'true'
            },
            {
                key: PREF_KEYS.proxySettings,
                storageKey: LOCAL_STORAGE_KEYS.proxySettings,
                parse: (value) => {
                    try {
                        return JSON.parse(value);
                    } catch (error) {
                        return null;
                    }
                }
            },
            {
                key: PREF_KEYS.sharePasswordMode,
                storageKey: LOCAL_STORAGE_KEYS.sharePasswordMode,
                parse: (value) => value || 'pin'
            },
            {
                key: PREF_KEYS.shareExpiryTtl,
                storageKey: LOCAL_STORAGE_KEYS.shareExpiryTtl,
                parse: (value) => {
                    const parsed = parseInt(value, 10);
                    return Number.isFinite(parsed) ? parsed : null;
                }
            },
            {
                key: PREF_KEYS.shareCustomExpiryValue,
                storageKey: LOCAL_STORAGE_KEYS.shareCustomExpiryValue,
                parse: (value) => {
                    const parsed = parseInt(value, 10);
                    return Number.isFinite(parsed) ? parsed : null;
                }
            },
            {
                key: PREF_KEYS.shareCustomExpiryUnit,
                storageKey: LOCAL_STORAGE_KEYS.shareCustomExpiryUnit,
                parse: (value) => value || null
            }
        ];

        for (const migration of migrations) {
            try {
                const rawValue = localStorage.getItem(migration.storageKey);
                if (rawValue === null) continue;

                if (typeof chatDB !== 'undefined' && chatDB.db) {
                    const existingValue = await chatDB.getSetting(migration.key);
                    if (existingValue !== undefined) {
                        this.cache.set(migration.key, existingValue);
                        this.updateSnapshot(migration.key, existingValue);
                        continue;
                    }
                }

                const parsedValue = migration.parse(rawValue);
                if (parsedValue !== null && parsedValue !== undefined) {
                    const persisted = await this.savePreference(migration.key, parsedValue, {
                        broadcast: false,
                        skipInit: true,
                        skipSync: true
                    });
                    if (persisted && !PREF_SNAPSHOT_KEYS.has(migration.key)) {
                        localStorage.removeItem(migration.storageKey);
                    }
                }
            } catch (error) {
                console.warn('Failed to migrate preference:', migration.key, error);
            }
        }
    }

    async preloadKnownPreferences() {
        if (typeof chatDB === 'undefined' || !chatDB.db) return;

        const preload = async (keys) => Promise.all(keys.map(async (key) => {
            try {
                const value = await chatDB.getSetting(key);
                if (value !== undefined) {
                    this.cache.set(key, value);
                    this.updateSnapshot(key, value);
                }
            } catch (error) {
                console.warn('Failed to preload preference:', key, error);
            }
        }));

        const keys = Object.keys(DEFAULT_PREFERENCES);
        await preload(keys.filter(key => !this.isSyncablePreference(key)));
        try {
            await withAccountDataLock(async () => {
                await syncService.assertAccountDataAccess();
                await preload(keys.filter(key => this.isSyncablePreference(key)));
            });
        } catch (error) {
            this.clearAccountScopedCache();
        }
    }

    getDefaultValue(key, options = {}) {
        if (options.defaultValue !== undefined) {
            return options.defaultValue;
        }

        if (key === PREF_KEYS.rightPanelVisible && typeof options.isDesktop === 'boolean') {
            return options.isDesktop;
        }

        if (key === PREF_KEYS.leftSidebarVisible && typeof options.isMobile === 'boolean') {
            return !options.isMobile;
        }

        return DEFAULT_PREFERENCES[key];
    }

    async getPreference(key, options = {}) {
        await this.init();

        if (this.cache.has(key)) {
            return this.cache.get(key);
        }

        if (typeof chatDB === 'undefined' || !chatDB.db) {
            return this.getDefaultValue(key, options);
        }

        try {
            const readValue = async () => chatDB.getSetting(key);
            const value = this.isSyncablePreference(key)
                ? await withAccountDataLock(async () => {
                    await syncService.assertAccountDataAccess();
                    return readValue();
                })
                : await readValue();
            if (value !== undefined) {
                this.cache.set(key, value);
                this.updateSnapshot(key, value);
                return value;
            }
        } catch (error) {
            console.warn('Failed to read preference:', key, error);
        }

        return this.getDefaultValue(key, options);
    }

    async savePreference(key, value, options = {}) {
        if (!options.skipInit) {
            await this.init();
        }

        if (this.isSyncablePreference(key) && !options.accountDataLockHeld) {
            return withAccountDataLock(async () => {
                await syncService.assertAccountDataAccess();
                return this.savePreference(key, value, {
                    ...options,
                    skipInit: true,
                    accountDataLockHeld: true
                });
            });
        }

        const shouldPersistSyncTimestamp = this.isSyncablePreference(key);
        const updatedAt = shouldPersistSyncTimestamp
            ? this.normalizeTimestamp(options.updatedAt) || Date.now()
            : null;

        let persisted = false;
        try {
            if (typeof chatDB !== 'undefined' && chatDB.db) {
                const entries = [{ key, value }];
                if (updatedAt !== null) {
                    entries.push({
                        key: this.getSyncTimestampKey(key),
                        value: updatedAt
                    });
                }

                if (typeof chatDB.saveSettings === 'function') {
                    await chatDB.saveSettings(entries);
                } else {
                    await chatDB.saveSetting(key, value);
                    if (updatedAt !== null) {
                        await chatDB.saveSetting(this.getSyncTimestampKey(key), updatedAt);
                    }
                }
                persisted = true;
            }
        } catch (error) {
            console.warn('Failed to persist preference:', key, error);
        }

        this.cache.set(key, value);
        this.notify(key, value);
        if (options.broadcast !== false) {
            storageEvents.broadcast('preferences-updated', {
                accountId: shouldPersistSyncTimestamp
                    ? syncService.getLocalAccountScope()
                    : undefined,
                key,
                value
            });
        }

        this.updateSnapshot(key, value);

        // Trigger sync on local changes (debounced)
        if (!options.skipSync) {
            syncService.triggerSync();
        }

        return persisted;
    }

    async handleAccountScopeChange(payload, { external = false } = {}) {
        const accountId = payload?.accountId || null;
        if (external) {
            try {
                await withAccountDataLock(async () => {
                    if (!syncService.canAccessAccountScope(accountId)) {
                        throw new Error('Stale account scope event');
                    }
                    await syncService.assertAccountDataAccess();
                    await this.handleAccountScopeChange(payload);
                });
            } catch (error) {
                this.clearAccountScopedCache();
            }
            return;
        }

        await Promise.all(
            [...SYNCABLE_PREF_KEYS].map(key =>
                this.reloadPreferenceFromDatabase(key, {
                    useDefaultWhenMissing: true
                })
            )
        );
    }

    async handleExternalPreferenceUpdate(payload) {
        if (!payload || !payload.key) return;
        if (!this.isSyncablePreference(payload.key)) {
            this.cache.set(payload.key, payload.value);
            this.notify(payload.key, payload.value);
            return;
        }

        try {
            await withAccountDataLock(async () => {
                if (!syncService.canAccessAccountScope(payload.accountId)) {
                    throw new Error('Stale account-scoped preference update');
                }
                await syncService.assertAccountDataAccess();
                this.cache.set(payload.key, payload.value);
                this.notify(payload.key, payload.value);
            });
        } catch (error) {
            const value = this.getDefaultValue(payload.key);
            this.cache.set(payload.key, value);
            this.notify(payload.key, value);
        }
    }

    clearAccountScopedCache() {
        SYNCABLE_PREF_KEYS.forEach(key => {
            const value = this.getDefaultValue(key);
            const changed = !this.valuesEqual(this.cache.get(key), value);
            this.cache.set(key, value);
            if (changed) this.notify(key, value);
        });
    }

    async reloadPreferenceFromDatabase(key, { useDefaultWhenMissing = false } = {}) {
        if (!key) return;
        if (typeof chatDB === 'undefined' || !chatDB.db) return;

        try {
            let value = await chatDB.getSetting(key);
            if (value === undefined) {
                if (!useDefaultWhenMissing) return;
                value = this.getDefaultValue(key);
            }

            const previous = this.cache.get(key);
            const changed = !this.valuesEqual(previous, value);

            this.cache.set(key, value);
            this.updateSnapshot(key, value);

            if (changed) {
                this.notify(key, value);
            }
        } catch (error) {
            console.warn('Failed to reload synced preference:', key, error);
        }
    }

    valuesEqual(a, b) {
        if (Object.is(a, b)) return true;
        if (!a || !b) return false;
        if (typeof a !== 'object' || typeof b !== 'object') return false;
        try {
            return JSON.stringify(a) === JSON.stringify(b);
        } catch (error) {
            return false;
        }
    }

    isSyncablePreference(key) {
        return SYNCABLE_PREF_KEYS.has(key);
    }

    getSyncTimestampKey(key) {
        return `${SYNC_PREF_UPDATED_AT_PREFIX}${key}`;
    }

    normalizeTimestamp(value) {
        const timestamp = Number(value);
        if (!Number.isFinite(timestamp) || timestamp <= 0) {
            return null;
        }
        return Math.floor(timestamp);
    }

    onChange(listener) {
        if (typeof listener !== 'function') return () => {};
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    notify(key, value) {
        this.listeners.forEach((listener) => {
            try {
                listener(key, value);
            } catch (error) {
                console.warn('Preference listener failed:', error);
            }
        });
    }

    updateSnapshot(key, value) {
        if (!PREF_SNAPSHOT_KEYS.has(key)) return;
        try {
            if (typeof localStorage === 'undefined') return;
            const targetKey = PREF_SNAPSHOT_MAP.get(key);
            if (!targetKey) return;

            let serialized = null;
            if (key === PREF_KEYS.theme) {
                serialized = (value === 'light' || value === 'dark') ? value : null;
            } else if (key === PREF_KEYS.fontMode) {
                serialized = value === 'serif' ? 'serif' : 'sans';
            } else if (key === PREF_KEYS.flatMode) {
                serialized = value === false ? 'false' : 'true';
            } else if (key === PREF_KEYS.leftSidebarWidth) {
                const parsed = Number(value);
                serialized = Number.isFinite(parsed) && parsed > 0 ? String(Math.round(parsed)) : null;
            } else if (key === PREF_KEYS.rightPanelVisible || key === PREF_KEYS.leftSidebarVisible || key === PREF_KEYS.ticketInfoVisible || key === PREF_KEYS.invitationFormVisible || key === PREF_KEYS.wideMode || key === PREF_KEYS.welcomeDismissed) {
                if (value === null || value === undefined) {
                    serialized = null;
                } else {
                    serialized = value ? 'true' : 'false';
                }
            }

            if (serialized === null) {
                localStorage.removeItem(targetKey);
            } else {
                localStorage.setItem(targetKey, serialized);
            }
        } catch (error) {
            console.warn('Failed to update preference snapshot:', key, error);
        }
    }
}

const preferencesStore = new PreferencesStore();

export { PREF_KEYS };
export default preferencesStore;
