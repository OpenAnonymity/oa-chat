import storageEvents from './storageEvents.js';

const PREF_KEYS = {
    theme: 'pref-theme',
    wideMode: 'pref-wide-mode',
    flatMode: 'pref-flat-mode',
    fontMode: 'pref-font-mode',
    rightPanelVisible: 'pref-right-panel-visible',
    ticketInfoVisible: 'pref-ticket-info-visible',
    invitationFormVisible: 'pref-invitation-form-visible',
    proxySettings: 'pref-network-proxy-settings',
    sharePasswordMode: 'pref-share-password-mode',
    shareExpiryTtl: 'pref-share-expiry-ttl',
    shareCustomExpiryValue: 'pref-share-custom-expiry-value',
    shareCustomExpiryUnit: 'pref-share-custom-expiry-unit'
};

const LOCAL_STORAGE_KEYS = {
    theme: 'oa-theme-preference',
    wideMode: 'oa-wide-mode',
    flatMode: 'oa-flat-mode',
    fontMode: 'oa-font-mode',
    rightPanelVisible: 'oa-right-panel-visible',
    ticketInfoVisible: 'oa-ticket-info-visible',
    invitationFormVisible: 'oa-invitation-form-visible',
    proxySettings: 'oa-network-proxy-settings',
    sharePasswordMode: 'oa-share-password-mode',
    shareExpiryTtl: 'oa-share-expiry-ttl',
    shareCustomExpiryValue: 'oa-share-custom-expiry-value',
    shareCustomExpiryUnit: 'oa-share-custom-expiry-unit'
};

const DEFAULT_PREFERENCES = {
    [PREF_KEYS.theme]: 'system',
    [PREF_KEYS.wideMode]: false,
    [PREF_KEYS.flatMode]: true,
    [PREF_KEYS.fontMode]: 'sans',
    [PREF_KEYS.rightPanelVisible]: null,
    [PREF_KEYS.ticketInfoVisible]: true,
    [PREF_KEYS.invitationFormVisible]: null,
    [PREF_KEYS.proxySettings]: {
        enabled: false,
        fallbackToDirect: true
    },
    [PREF_KEYS.sharePasswordMode]: 'pin',
    [PREF_KEYS.shareExpiryTtl]: 604800,
    [PREF_KEYS.shareCustomExpiryValue]: 1,
    [PREF_KEYS.shareCustomExpiryUnit]: '86400'
};

const PREF_SNAPSHOT_KEYS = new Set([
    PREF_KEYS.theme,
    PREF_KEYS.wideMode,
    PREF_KEYS.flatMode,
    PREF_KEYS.fontMode,
    PREF_KEYS.rightPanelVisible,
    PREF_KEYS.ticketInfoVisible,
    PREF_KEYS.invitationFormVisible
]);

const PREF_SNAPSHOT_MAP = new Map([
    [PREF_KEYS.theme, LOCAL_STORAGE_KEYS.theme],
    [PREF_KEYS.wideMode, LOCAL_STORAGE_KEYS.wideMode],
    [PREF_KEYS.flatMode, LOCAL_STORAGE_KEYS.flatMode],
    [PREF_KEYS.fontMode, LOCAL_STORAGE_KEYS.fontMode],
    [PREF_KEYS.rightPanelVisible, LOCAL_STORAGE_KEYS.rightPanelVisible],
    [PREF_KEYS.ticketInfoVisible, LOCAL_STORAGE_KEYS.ticketInfoVisible],
    [PREF_KEYS.invitationFormVisible, LOCAL_STORAGE_KEYS.invitationFormVisible]
]);

class PreferencesStore {
    constructor() {
        this.cache = new Map();
        this.listeners = new Set();
        this.initPromise = null;
        this.storageUnsubscribe = null;
    }

    async init() {
        if (this.initPromise) {
            return this.initPromise;
        }

        this.initPromise = (async () => {
            await this.ensureDbReady();
            await this.migrateFromLocalStorage();
            await this.preloadKnownPreferences();

            if (!this.storageUnsubscribe) {
                this.storageUnsubscribe = storageEvents.on('preferences-updated', (payload) => {
                    if (!payload || !payload.key) return;
                    this.cache.set(payload.key, payload.value);
                    this.notify(payload.key, payload.value);
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

                const parsedValue = migration.parse(rawValue);
                if (parsedValue !== null && parsedValue !== undefined) {
                    const persisted = await this.savePreference(migration.key, parsedValue, { broadcast: false, skipInit: true });
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

        const keys = Object.keys(DEFAULT_PREFERENCES);
        await Promise.all(keys.map(async (key) => {
            try {
                const value = await chatDB.getSetting(key);
                if (value !== undefined) {
                    this.cache.set(key, value);
                }
            } catch (error) {
                console.warn('Failed to preload preference:', key, error);
            }
        }));
    }

    getDefaultValue(key, options = {}) {
        if (options.defaultValue !== undefined) {
            return options.defaultValue;
        }

        if (key === PREF_KEYS.rightPanelVisible && typeof options.isDesktop === 'boolean') {
            return options.isDesktop;
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
            const value = await chatDB.getSetting(key);
            if (value !== undefined) {
                this.cache.set(key, value);
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

        let persisted = false;
        try {
            if (typeof chatDB !== 'undefined' && chatDB.db) {
                await chatDB.saveSetting(key, value);
                persisted = true;
            }
        } catch (error) {
            console.warn('Failed to persist preference:', key, error);
        }

        this.cache.set(key, value);
        this.notify(key, value);
        if (options.broadcast !== false) {
            storageEvents.broadcast('preferences-updated', { key, value });
        }

        this.updateSnapshot(key, value);

        return persisted;
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
            } else if (key === PREF_KEYS.rightPanelVisible || key === PREF_KEYS.ticketInfoVisible || key === PREF_KEYS.invitationFormVisible || key === PREF_KEYS.wideMode) {
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
