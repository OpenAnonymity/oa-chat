/**
 * API Key Store
 * Legacy access key lifecycle in localStorage.
 */

const ACCESS_STORAGE_KEY = 'oa_access_key_data';

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

    loadApiKey() {
        try {
            const stored = localStorage.getItem(ACCESS_STORAGE_KEY);
            if (stored) {
                const data = JSON.parse(stored);
                this.state = {
                    apiKey: data.key,
                    apiKeyInfo: data,
                    expiresAt: data.expiresAt || data.expires_at, // Support both formats
                    ticketUsed: data.ticketUsed || data.ticket_used
                };
                console.log('📥 Loaded API key from localStorage');
                this.notify();
            }
        } catch (error) {
            console.error('❌ Error loading API key:', error);
        }
    }

    setApiKey(apiKeyData) {
        try {
            this.state = {
                apiKey: apiKeyData.key,
                apiKeyInfo: apiKeyData,
                expiresAt: apiKeyData.expiresAt || apiKeyData.expires_at,
                ticketUsed: apiKeyData.ticketUsed || apiKeyData.ticket_used
            };

            localStorage.setItem(ACCESS_STORAGE_KEY, JSON.stringify(apiKeyData));
            console.log('💾 Saved API key to localStorage');
            
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


