import preferencesStore from './preferencesStore.js';
import ticketStore from './ticketStore.js';
import storageEvents from './storageEvents.js';

class StorageManager {
    constructor() {
        this.initPromise = null;
        // true: the browser keeps this site's data under storage pressure.
        // false: it may evict it. null: unknown or unsupported. Local only.
        this.persistence = null;
        this.installListenerAdded = false;
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
        this.listenForInstall();
        if (typeof navigator === 'undefined' || !navigator.storage) {
            return false;
        }

        try {
            const persisted = await navigator.storage.persisted();
            if (persisted) return this.setPersistence(true);
            return this.setPersistence(await navigator.storage.persist());
        } catch (error) {
            console.warn('Failed to request persistent storage:', error);
            return false;
        }
    }

    /** Read the current grant without asking for it. */
    async refreshPersistence() {
        if (typeof navigator === 'undefined' || typeof navigator.storage?.persisted !== 'function') {
            return this.persistence;
        }
        try {
            return this.setPersistence(await navigator.storage.persisted());
        } catch {
            return this.persistence;
        }
    }

    getPersistence() {
        return this.persistence;
    }

    setPersistence(value) {
        this.persistence = value === true ? true : value === false ? false : null;
        return this.persistence === true;
    }

    // Installing the app is the moment browsers are most likely to grant
    // persistence, so ask once more then. A grant is never guaranteed.
    listenForInstall() {
        if (this.installListenerAdded || typeof window === 'undefined' ||
            typeof window.addEventListener !== 'function') return;
        this.installListenerAdded = true;
        window.addEventListener('appinstalled', () => {
            if (this.persistence === true || typeof navigator === 'undefined' ||
                typeof navigator.storage?.persist !== 'function') return;
            navigator.storage.persist()
                .then(granted => this.setPersistence(granted))
                .catch(() => {});
        });
    }
}

const storageManager = new StorageManager();

export default storageManager;
