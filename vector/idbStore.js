import { toId } from './utils.js';

const DB_VERSION = 1;
const ITEMS_STORE = 'vector_items';
const META_STORE = 'vector_meta';

function requestToPromise(request) {
    return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

function transactionToPromise(transaction) {
    return new Promise((resolve, reject) => {
        transaction.oncomplete = () => resolve();
        transaction.onabort = () => reject(transaction.error || new Error('IndexedDB transaction aborted.'));
        transaction.onerror = () => reject(transaction.error || new Error('IndexedDB transaction failed.'));
    });
}

export async function openVectorDatabase(dbName) {
    if (typeof indexedDB === 'undefined') {
        throw new Error('IndexedDB is not available in this environment.');
    }

    const request = indexedDB.open(dbName, DB_VERSION);
    request.onupgradeneeded = (event) => {
        const db = event.target.result;

        if (!db.objectStoreNames.contains(ITEMS_STORE)) {
            const store = db.createObjectStore(ITEMS_STORE, { keyPath: 'key' });
            store.createIndex('collection', 'collection', { unique: false });
        }

        if (!db.objectStoreNames.contains(META_STORE)) {
            db.createObjectStore(META_STORE, { keyPath: 'collection' });
        }
    };

    return requestToPromise(request);
}

export async function ensureVectorMeta(db, collection, { dimension, metric, normalize }) {
    const tx = db.transaction([META_STORE], 'readwrite');
    const store = tx.objectStore(META_STORE);
    const existing = await requestToPromise(store.get(collection));
    const nextMeta = {
        collection,
        dimension,
        metric,
        normalize,
        createdAt: existing?.createdAt || Date.now(),
        updatedAt: Date.now()
    };

    if (existing) {
        const mismatch = existing.dimension !== dimension
            || existing.metric !== metric
            || existing.normalize !== normalize;
        if (mismatch) {
            throw new Error(`IndexedDB backend config mismatch for collection "${collection}".`);
        }
    }

    store.put(nextMeta);
    await transactionToPromise(tx);
    return nextMeta;
}

export async function loadVectorItems(db, collection) {
    const items = [];
    const tx = db.transaction([ITEMS_STORE], 'readonly');
    const store = tx.objectStore(ITEMS_STORE).index('collection');
    const request = store.openCursor(IDBKeyRange.only(collection));

    await new Promise((resolve, reject) => {
        request.onsuccess = (event) => {
            const cursor = event.target.result;
            if (!cursor) {
                resolve();
                return;
            }
            const value = cursor.value;
            const vector = value.vector instanceof Float32Array
                ? value.vector
                : new Float32Array(value.vector);
            items.push({
                id: value.id,
                vector,
                metadata: value.metadata ?? null
            });
            cursor.continue();
        };
        request.onerror = () => reject(request.error);
    });

    await transactionToPromise(tx);
    return items;
}

export async function persistVectorItems(db, collection, items) {
    const tx = db.transaction([ITEMS_STORE], 'readwrite');
    const store = tx.objectStore(ITEMS_STORE);
    for (const item of items) {
        store.put({
            key: vectorKey(collection, item.id),
            collection,
            id: item.id,
            vector: item.vector,
            metadata: item.metadata ?? null,
            updatedAt: Date.now()
        });
    }
    await transactionToPromise(tx);
}

export async function removeVectorItems(db, collection, ids) {
    const tx = db.transaction([ITEMS_STORE], 'readwrite');
    const store = tx.objectStore(ITEMS_STORE);
    for (const idValue of ids) {
        const id = toId(idValue);
        store.delete(vectorKey(collection, id));
    }
    await transactionToPromise(tx);
}

export async function clearVectorItems(db, collection) {
    const tx = db.transaction([ITEMS_STORE], 'readwrite');
    const store = tx.objectStore(ITEMS_STORE).index('collection');
    const request = store.openCursor(IDBKeyRange.only(collection));

    await new Promise((resolve, reject) => {
        request.onsuccess = (event) => {
            const cursor = event.target.result;
            if (!cursor) {
                resolve();
                return;
            }
            cursor.delete();
            cursor.continue();
        };
        request.onerror = () => reject(request.error);
    });

    await transactionToPromise(tx);
}

export function vectorKey(collection, id) {
    return `${collection}::${id}`;
}

export const VECTOR_DB_VERSION = DB_VERSION;
export const VECTOR_ITEMS_STORE = ITEMS_STORE;
export const VECTOR_META_STORE = META_STORE;
