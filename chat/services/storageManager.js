import preferencesStore from './preferencesStore.js';
import ticketStore from './ticketStore.js';
import storageEvents from './storageEvents.js';

class StorageManager {
    constructor() {
        this.initPromise = null;
    }

    async init() {
        if (this.initPromise) {
            return this.initPromise;
        }

        this.initPromise = (async () => {
            storageEvents.init();
            await this.ensurePersistentStorage();
            await preferencesStore.init();
            await ticketStore.init();
        })();

        return this.initPromise;
    }

    async ensurePersistentStorage() {
        if (typeof navigator === 'undefined' || !navigator.storage) {
            return false;
        }

        try {
            const persisted = await navigator.storage.persisted();
            if (persisted) return true;
            return await navigator.storage.persist();
        } catch (error) {
            console.warn('Failed to request persistent storage:', error);
            return false;
        }
    }
}

const storageManager = new StorageManager();

export default storageManager;
