/** Browser-local bearer-code and blinding recovery. Never synced or sent to billing. */
export class TicketCodeRecoveryStore {
    constructor({ indexedDBImpl = globalThis.indexedDB } = {}) {
        this.indexedDB = indexedDBImpl;
        this.dbPromise = null;
    }

    async open() {
        if (!this.indexedDB) throw new Error('Local ticket-code recovery storage is unavailable.');
        if (!this.dbPromise) {
            this.dbPromise = new Promise((resolve, reject) => {
                const request = this.indexedDB.open('oa-ticket-code-recovery-v1', 1);
                request.onupgradeneeded = () => {
                    const store = request.result.createObjectStore('redemptions', { keyPath: ['scope', 'code'] });
                    store.createIndex('scope', 'scope');
                };
                request.onsuccess = () => resolve(request.result);
                request.onerror = () => reject(request.error);
                request.onblocked = () => reject(new Error('Ticket-code recovery storage is blocked by another tab.'));
            }).catch(error => { this.dbPromise = null; throw error; });
        }
        return this.dbPromise;
    }

    async list(scope) {
        const db = await this.open();
        return new Promise((resolve, reject) => {
            const request = db.transaction('redemptions').objectStore('redemptions').index('scope').getAll(scope);
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    }

    async write(record, remove = false) {
        const db = await this.open();
        // Await the transaction commit, not just the individual request.
        await new Promise((resolve, reject) => {
            const tx = db.transaction('redemptions', 'readwrite');
            tx.oncomplete = resolve;
            tx.onerror = () => reject(tx.error || new Error('Unable to save ticket-code recovery.'));
            tx.onabort = () => reject(tx.error || new Error('Ticket-code recovery write was aborted.'));
            const store = tx.objectStore('redemptions');
            if (remove) store.delete([record.scope, record.code]);
            else store.put(record);
        });
    }

    put(record) { return this.write(record); }
    delete(record) { return this.write(record, true); }
}

export default new TicketCodeRecoveryStore();
