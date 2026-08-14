/**
 * Local-only recovery for in-progress entitlement ticket preparation.
 *
 * The database name intentionally stays at v1 so a pending claim created by
 * the earlier integrated client survives the public/commercial separation.
 */
const DB_NAME = 'oa-billing-local-v1';
const DB_VERSION = 1;
const STORE_NAME = 'claims';

export class EntitlementClaimRecoveryStore {
    constructor(options = {}) {
        this.indexedDB = options.indexedDBImpl || globalThis.indexedDB;
        this.dbPromise = null;
    }

    async open() {
        if (this.dbPromise) return this.dbPromise;
        if (!this.indexedDB) throw new Error('Local entitlement recovery storage is unavailable.');
        this.dbPromise = new Promise((resolve, reject) => {
            const request = this.indexedDB.open(DB_NAME, DB_VERSION);
            request.onupgradeneeded = () => {
                const db = request.result;
                if (!db.objectStoreNames.contains(STORE_NAME)) {
                    db.createObjectStore(STORE_NAME, { keyPath: 'accountScope' });
                }
            };
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error || new Error('Unable to open entitlement recovery storage.'));
            request.onblocked = () => reject(new Error('Entitlement recovery storage is blocked by another tab.'));
        });
        return this.dbPromise;
    }

    async get(accountScope) {
        const db = await this.open();
        return new Promise((resolve, reject) => {
            const request = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get(accountScope);
            request.onsuccess = () => resolve(request.result || null);
            request.onerror = () => reject(request.error);
        });
    }

    async put(record) {
        if (!record?.accountScope) throw new Error('Entitlement recovery record requires an account scope.');
        const db = await this.open();
        const saved = JSON.parse(JSON.stringify({ ...record, updatedAt: new Date().toISOString() }));
        await new Promise((resolve, reject) => {
            const transaction = db.transaction(STORE_NAME, 'readwrite');
            transaction.oncomplete = () => resolve();
            transaction.onerror = () => reject(transaction.error);
            transaction.objectStore(STORE_NAME).put(saved);
        });
        const roundTrip = await this.get(record.accountScope);
        if (!roundTrip || roundTrip.updatedAt !== saved.updatedAt) {
            throw new Error('Entitlement recovery state did not persist safely.');
        }
        return roundTrip;
    }

    async delete(accountScope) {
        const db = await this.open();
        await new Promise((resolve, reject) => {
            const transaction = db.transaction(STORE_NAME, 'readwrite');
            transaction.oncomplete = () => resolve();
            transaction.onerror = () => reject(transaction.error);
            transaction.objectStore(STORE_NAME).delete(accountScope);
        });
    }
}

export default new EntitlementClaimRecoveryStore();
