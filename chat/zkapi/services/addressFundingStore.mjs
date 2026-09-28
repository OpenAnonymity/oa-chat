const DATABASE = 'oa-zkapi-address-funding-v1';
const RECORDS = 'addresses';

export function isBrowserCustodyKey(key) {
    return Object.prototype.toString.call(key) === '[object CryptoKey]'
        && key.type === 'secret' && key.extractable === false
        && key.algorithm?.name === 'AES-GCM' && key.algorithm.length === 256
        && key.usages?.length === 2 && key.usages.includes('encrypt') && key.usages.includes('decrypt');
}

/** Local custody data is deliberately outside chat/account synchronization.
 * The non-extractable browser key and encrypted custody state share one row so
 * they commit atomically. Resolve only on durable transaction completion. */
export function createAddressFundingStore({ indexedDB = globalThis.indexedDB } = {}) {
    let connection;
    const unavailable = () => Object.assign(new Error('The payment address could not be saved or read. Keep this browser data intact and try again.'), { code: 'address_storage' });

    async function open() {
        if (!indexedDB) throw unavailable();
        if (!connection) {
            connection = new Promise((resolve, reject) => {
                const request = indexedDB.open(DATABASE, 1);
                let abandoned = false;
                request.onupgradeneeded = () => request.result.createObjectStore(RECORDS);
                request.onerror = request.onblocked = () => { abandoned = true; reject(unavailable()); };
                request.onsuccess = () => {
                    const database = request.result;
                    if (abandoned) { database.close(); return; }
                    database.onversionchange = () => { database.close(); connection = null; };
                    resolve(database);
                };
            }).catch(error => { connection = null; throw error; });
        }
        return connection;
    }

    async function operation(scope, mode, record, createOnly = false) {
        const database = await open();
        return new Promise((resolve, reject) => {
            let transaction;
            try {
                transaction = database.transaction(RECORDS, mode, { durability: 'strict' });
                const request = mode === 'readonly'
                    ? transaction.objectStore(RECORDS).get(scope)
                    : transaction.objectStore(RECORDS)[createOnly ? 'add' : 'put'](record, scope);
                let result;
                request.onsuccess = () => { result = request.result; };
                transaction.oncomplete = () => resolve(result ?? null);
                transaction.onerror = transaction.onabort = () => reject(unavailable());
            } catch {
                try { transaction?.abort(); } catch { /* Already completed. */ }
                reject(unavailable());
            }
        });
    }

    return {
        load: scope => operation(scope, 'readonly'),
        save(scope, record, { createOnly = false } = {}) {
            if (record?.format !== 'oa-address-wallet' || typeof record.ciphertext !== 'string'
                || ![1, 2].includes(record.version) || Object.hasOwn(record, 'privateKey')
                || (record.version === 2 && !isBrowserCustodyKey(record.browserKey))) throw unavailable();
            return operation(scope, 'readwrite', record, createOnly);
        }
    };
}
