import { MemoryBackend } from './memoryBackend.js';
import {
    clearVectorItems,
    ensureVectorMeta,
    loadVectorItems,
    openVectorDatabase,
    persistVectorItems,
    removeVectorItems
} from './idbStore.js';

export class IndexedDBBackend extends MemoryBackend {
    constructor(options = {}) {
        super(options);
        this.dbName = options.dbName || 'oa-vector-store';
        this.collection = options.collection || options.name || 'default';
        this.db = null;
        this._meta = null;
    }

    async init(options = {}) {
        await super.init(options);
        this.dbName = options.dbName || this.dbName;
        this.collection = options.collection || options.name || this.collection;
        this.db = await openVectorDatabase(this.dbName);
        this._meta = await ensureVectorMeta(this.db, this.collection, {
            dimension: this.dimension,
            metric: this.metric,
            normalize: this.normalizeVectors
        });
        const items = await loadVectorItems(this.db, this.collection);
        if (items.length > 0) {
            this.upsertPrepared(items);
        }
    }

    async upsert(items) {
        const prepared = this.prepareItems(items);
        if (prepared.length === 0) return 0;
        await persistVectorItems(this.db, this.collection, prepared);
        this.upsertPrepared(prepared);
        return prepared.length;
    }

    async remove(ids) {
        const targetIds = Array.isArray(ids) ? ids : [ids];
        if (targetIds.length === 0) return 0;
        await removeVectorItems(this.db, this.collection, targetIds);
        return super.remove(targetIds);
    }

    async clear() {
        await clearVectorItems(this.db, this.collection);
        await super.clear();
    }

    async close() {
        if (this.db) {
            this.db.close();
            this.db = null;
        }
    }

}
