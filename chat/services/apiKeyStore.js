/**
 * API Key Store
 * Legacy access key lifecycle with IndexedDB persistence.
 */

const ACCESS_STORAGE_KEY = 'oa_access_key_data';
const ACCESS_DB_KEY = 'apiKeyData';

class ApiKeyStore {
    constructor() {
        this.listeners = [];
        this.state = {
            apiKey: null,
            apiKeyInfo: null,
            expiresAt: null,
            ticketUsed: null
        };
    }

    getState() {
        return { ...this.state };
    }

    subscribe(listener) {
        this.listeners.push(listener);
    }

    unsubscribe(listener) {
        this.listeners = this.listeners.filter(l => l !== listener);
    }

    notify() {
        this.listeners.forEach(listener => listener());
    }

    async loadApiKey() {
        try {
            if (typeof chatDB !== 'undefined') {
                if (!chatDB.db && typeof chatDB.init === 'function') {
                    await chatDB.init();
                }
                const stored = await chatDB.getSetting(ACCESS_DB_KEY);
                if (stored) {
                    this.state = {
                        apiKey: stored.key,
                        apiKeyInfo: stored,
                        expiresAt: stored.expiresAt || stored.expires_at, // Support both formats
                        ticketUsed: stored.ticketUsed || stored.ticket_used
                    };
                    console.log('📥 Loaded API key from IndexedDB');
                    this.notify();
                    return;
                }
            }

            const legacyStored = localStorage.getItem(ACCESS_STORAGE_KEY);
            if (legacyStored) {
                const data = JSON.parse(legacyStored);
                this.state = {
                    apiKey: data.key,
                    apiKeyInfo: data,
                    expiresAt: data.expiresAt || data.expires_at,
                    ticketUsed: data.ticketUsed || data.ticket_used
                };
                let persisted = false;
                if (typeof chatDB !== 'undefined' && chatDB.db) {
                    try {
                        await chatDB.saveSetting(ACCESS_DB_KEY, data);
                        persisted = true;
                    } catch (error) {
                        console.warn('Failed to persist API key during migration:', error);
                    }
                }
                if (persisted) {
                    localStorage.removeItem(ACCESS_STORAGE_KEY);
                    console.log('📥 Migrated API key from localStorage');
                } else {
                    console.warn('📥 Loaded API key from localStorage (IndexedDB unavailable)');
                }
                this.notify();
            }
        } catch (error) {
            console.error('❌ Error loading API key:', error);
        }
    }

    async setApiKey(apiKeyData) {
        try {
            this.state = {
                apiKey: apiKeyData.key,
                apiKeyInfo: apiKeyData,
                expiresAt: apiKeyData.expiresAt || apiKeyData.expires_at,
                ticketUsed: apiKeyData.ticketUsed || apiKeyData.ticket_used
            };

            let persisted = false;
            if (typeof chatDB !== 'undefined') {
                if (!chatDB.db && typeof chatDB.init === 'function') {
                    await chatDB.init();
                }
                if (chatDB.db) {
                    await chatDB.saveSetting(ACCESS_DB_KEY, apiKeyData);
                    persisted = true;
                }
            }

            if (persisted) {
                localStorage.removeItem(ACCESS_STORAGE_KEY);
                console.log('💾 Saved API key to IndexedDB');
            } else {
                localStorage.setItem(ACCESS_STORAGE_KEY, JSON.stringify(apiKeyData));
                console.warn('💾 Saved API key to localStorage (IndexedDB unavailable)');
            }
            
            window.dispatchEvent(new CustomEvent('apikey-changed'));
            this.notify();
        } catch (error) {
            console.error('❌ Error saving API key:', error);
            throw error;
        }
    }

    clearApiKey() {
        this.state = {
            apiKey: null,
            apiKeyInfo: null,
            expiresAt: null,
            ticketUsed: null
        };

        if (typeof chatDB !== 'undefined' && chatDB.db) {
            chatDB.saveSetting(ACCESS_DB_KEY, null).catch(() => {});
        }
        localStorage.removeItem(ACCESS_STORAGE_KEY);
        console.log('🗑️  Cleared API key');
        
        window.dispatchEvent(new CustomEvent('apikey-cleared'));
        this.notify();
    }

    getApiKey() {
        return this.state.apiKey;
    }

    hasApiKey() {
        return !!this.state.apiKey;
    }

    getExpiresAt() {
        return this.state.expiresAt;
    }

    isExpired() {
        if (!this.state.expiresAt) return false;
        const expiryDate = new Date(this.state.expiresAt);
        return expiryDate <= new Date();
    }
}

// Export singleton instance
const apiKeyStore = new ApiKeyStore();

// Make available in console for debugging
if (typeof window !== 'undefined') {
    window.apiKeyStore = apiKeyStore;
}

export default apiKeyStore;
