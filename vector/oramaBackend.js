import { ensurePositiveInteger, normalizeMetric, prepareVector, toId } from './utils.js';
import {
    clearVectorItems,
    ensureVectorMeta,
    loadVectorItems,
    openVectorDatabase,
    persistVectorItems,
    removeVectorItems
} from './idbStore.js';

const DEFAULT_VECTOR_PROPERTY = 'embedding';
const DEFAULT_ID_FIELD = 'id';
const DEFAULT_SESSION_FIELD = 'sessionId';

function clampSimilarity(value) {
    if (!Number.isFinite(value)) return 0;
    if (value < 0) return 0;
    if (value > 1) return 1;
    return value;
}

export class OramaBackend {
    constructor(options = {}) {
        if (!options.dimension) {
            throw new Error('OramaBackend requires a dimension.');
        }

        this.name = options.name || 'default';
        this.dimension = options.dimension;
        this.metric = normalizeMetric(options.metric);
        this.normalizeVectors = options.normalize ?? (this.metric === 'cosine');
        this.vectorProperty = options.vectorProperty || DEFAULT_VECTOR_PROPERTY;
        this.idField = options.idField || DEFAULT_ID_FIELD;
        this.sessionField = options.sessionField || DEFAULT_SESSION_FIELD;
        this.dbName = options.dbName || 'oa-vector-store';
        this.collection = options.collection || options.name || 'default';
        this.persistence = options.persistence || 'indexeddb';

        this.moduleFactory = options.moduleFactory || null;
        this.moduleUrl = options.moduleUrl || null;
        this.module = null;
        this.db = null;
        this.meta = null;
        this.orama = null;

        this.idToOramaId = new Map();
        this.oramaIdToId = new Map();
        this.metadataById = new Map();
        this.vectorById = new Map();
    }

    async init(options = {}) {
        if (options.dimension) {
            this.dimension = options.dimension;
        }
        if (!this.dimension || this.dimension <= 0) {
            throw new Error('Vector dimension must be provided.');
        }

        this.metric = normalizeMetric(options.metric || this.metric);
        this.normalizeVectors = options.normalize ?? this.normalizeVectors ?? (this.metric === 'cosine');
        this.vectorProperty = options.vectorProperty || this.vectorProperty;
        this.idField = options.idField || this.idField;
        this.sessionField = options.sessionField || this.sessionField;
        this.dbName = options.dbName || this.dbName;
        this.collection = options.collection || options.name || this.collection;
        this.persistence = options.persistence || this.persistence;
        this.moduleFactory = options.moduleFactory || this.moduleFactory;
        this.moduleUrl = options.moduleUrl || this.moduleUrl;

        if (this.metric !== 'cosine') {
            throw new Error('Orama backend currently supports cosine similarity only.');
        }

        await this._loadModule();
        await this._createOrama();

        if (this.persistence === 'indexeddb') {
            this.db = await openVectorDatabase(this.dbName);
            this.meta = await ensureVectorMeta(this.db, this.collection, {
                dimension: this.dimension,
                metric: this.metric,
                normalize: this.normalizeVectors
            });
            const items = await loadVectorItems(this.db, this.collection);
            if (items.length > 0) {
                await this._insertDocuments(items);
            }
        }
    }

    async upsert(items) {
        const batch = Array.isArray(items) ? items : [items];
        const prepared = this._prepareItems(batch);
        if (prepared.length === 0) return 0;

        for (const item of prepared) {
            if (this.idToOramaId.has(item.id)) {
                await this._removeFromOrama(item.id);
            }
        }

        if (this.persistence === 'indexeddb') {
            await persistVectorItems(this.db, this.collection, prepared);
        }

        await this._insertDocuments(prepared);
        return prepared.length;
    }

    async remove(ids) {
        const targetIds = Array.isArray(ids) ? ids : [ids];
        if (targetIds.length === 0) return 0;

        if (this.persistence === 'indexeddb') {
            await removeVectorItems(this.db, this.collection, targetIds);
        }

        let removed = 0;
        for (const idValue of targetIds) {
            const id = toId(idValue);
            let didRemove = false;
            if (this.idToOramaId.has(id)) {
                await this._removeFromOrama(id);
                didRemove = true;
            }
            if (this.metadataById.delete(id)) {
                didRemove = true;
            }
            if (this.vectorById.delete(id)) {
                didRemove = true;
            }
            if (didRemove) {
                removed += 1;
            }
        }
        return removed;
    }

    async get(ids, options = {}) {
        const targetIds = Array.isArray(ids) ? ids : [ids];
        const includeVectors = options.includeVectors === true;
        const results = [];

        for (const idValue of targetIds) {
            const id = toId(idValue);
            if (!this.metadataById.has(id) && !this.vectorById.has(id)) {
                continue;
            }
            const result = {
                id,
                metadata: this.metadataById.get(id) ?? null
            };
            if (includeVectors) {
                const vector = this.vectorById.get(id);
                if (vector) {
                    result.vector = vector;
                }
            }
            results.push(result);
        }

        return results;
    }

    async search(query, k = 10, options = {}) {
        const limit = ensurePositiveInteger(k, 10);
        if (limit === 0 || this.metadataById.size === 0) {
            return [];
        }

        const queryVector = prepareVector(query, this.dimension, this.normalizeVectors);
        const includeVectors = options.includeVectors === true;
        const filter = typeof options.filter === 'function' ? options.filter : null;
        const where = options.where && typeof options.where === 'object'
            ? options.where
            : (options.filter && typeof options.filter === 'object' && !Array.isArray(options.filter)
                ? options.filter
                : null);
        const minScore = Number.isFinite(options.minScore) ? options.minScore : null;
        const debug = options.debug === true;
        const debugLabel = typeof options.debugLabel === 'string' && options.debugLabel
            ? options.debugLabel
            : 'vector-search';

        const similarity = clampSimilarity(minScore ?? 0);

        // Compatibility path for arbitrary predicates. Prefer `where` for indexed fast filtering.
        if (filter) {
            let candidateCount = 0;
            let minScoreRejectedCount = 0;
            const scored = [];

            for (const [id, metadata] of this.metadataById.entries()) {
                if (!filter(metadata, id)) continue;
                candidateCount += 1;
                const vector = this.vectorById.get(id);
                if (!vector) continue;

                const score = this._cosineSimilarity(queryVector, vector);
                if (score < similarity) {
                    minScoreRejectedCount += 1;
                    continue;
                }

                const entry = { id, score, metadata: metadata ?? null };
                if (includeVectors) {
                    entry.vector = vector;
                }
                scored.push(entry);
            }

            scored.sort((a, b) => b.score - a.score);
            const finalResults = scored.slice(0, limit);

            if (debug) {
                console.log(
                    `[OramaBackend] ${debugLabel} — total vectors: ${this.metadataById.size}, ` +
                    `requested k: ${limit}, filtered candidates: ${candidateCount}, ` +
                    `minScore rejected: ${minScoreRejectedCount}, returned: ${finalResults.length}, passes: 1`
                );
            }

            return finalResults;
        }

        const response = await this.module.search(this.orama, {
            mode: 'vector',
            vector: {
                value: Array.from(queryVector),
                property: this.vectorProperty
            },
            limit,
            similarity,
            includeVectors,
            ...(where ? { where } : {})
        });

        const hits = response?.hits || [];
        const finalResults = [];
        let minScoreRejectedCount = 0;

        for (const hit of hits) {
            const oramaId = hit.id;
            const idFromMap = this.oramaIdToId.get(oramaId);
            const docId = idFromMap || hit.document?.[this.idField] || oramaId;
            const metadata = this.metadataById.get(docId) ?? null;

            const score = hit.score ?? 0;
            if (minScore !== null && score < minScore) {
                minScoreRejectedCount += 1;
                continue;
            }

            const entry = { id: docId, score, metadata };
            if (includeVectors) {
                const vector = this.vectorById.get(docId);
                if (vector) {
                    entry.vector = vector;
                } else if (hit.document?.[this.vectorProperty]) {
                    entry.vector = Float32Array.from(hit.document[this.vectorProperty]);
                }
            }
            finalResults.push(entry);
        }

        if (debug) {
            console.log(
                `[OramaBackend] ${debugLabel} — total vectors: ${this.metadataById.size}, ` +
                `requested k: ${limit}, raw hits: ${hits.length}, ` +
                `native where: ${where ? 'yes' : 'no'}, ` +
                `minScore rejected: ${minScoreRejectedCount}, returned: ${finalResults.length}, passes: 1`
            );
        }

        return finalResults;
    }

    async count() {
        return this.metadataById.size;
    }

    async clear() {
        if (this.persistence === 'indexeddb') {
            await clearVectorItems(this.db, this.collection);
        }
        await this._createOrama();
        this.idToOramaId.clear();
        this.oramaIdToId.clear();
        this.metadataById.clear();
        this.vectorById.clear();
    }

    async stats() {
        return {
            name: this.name,
            size: this.metadataById.size,
            dimension: this.dimension,
            metric: this.metric,
            normalize: this.normalizeVectors,
            backend: 'orama',
            persistence: this.persistence
        };
    }

    async close() {
        this.orama = null;
        if (this.db) {
            this.db.close();
            this.db = null;
        }
    }

    _prepareItems(items) {
        const prepared = [];
        for (const item of items) {
            if (!item) continue;
            const id = toId(item.id);
            const vector = prepareVector(item.vector, this.dimension, this.normalizeVectors);
            prepared.push({
                id,
                vector,
                metadata: item.metadata ?? null
            });
        }
        return prepared;
    }

    async _insertDocuments(items) {
        if (!items || items.length === 0) return;
        const docs = items.map((item) => ({
            [this.idField]: item.id,
            [this.sessionField]: typeof item.metadata?.sessionId === 'string' ? item.metadata.sessionId : '',
            [this.vectorProperty]: Array.from(item.vector)
        }));

        let ids = [];
        if (typeof this.module.insertMultiple === 'function') {
            ids = await this.module.insertMultiple(this.orama, docs);
        } else {
            for (const doc of docs) {
                // eslint-disable-next-line no-await-in-loop
                const id = await this.module.insert(this.orama, doc);
                ids.push(id);
            }
        }

        for (let i = 0; i < items.length; i += 1) {
            const item = items[i];
            const oramaId = ids[i] ?? item.id;
            this.idToOramaId.set(item.id, oramaId);
            this.oramaIdToId.set(oramaId, item.id);
            this.metadataById.set(item.id, item.metadata ?? null);
            this.vectorById.set(item.id, item.vector);
        }
    }

    async _removeFromOrama(id) {
        const oramaId = this.idToOramaId.get(id);
        if (!oramaId) return;
        if (typeof this.module.remove === 'function') {
            await this.module.remove(this.orama, oramaId);
        }
        this.idToOramaId.delete(id);
        this.oramaIdToId.delete(oramaId);
    }

    async _loadModule() {
        if (this.module) return;
        if (this.moduleFactory) {
            this.module = await this.moduleFactory();
            return;
        }
        if (!this.moduleUrl && typeof window !== 'undefined') {
            this.moduleUrl = '/vector/vendor/orama/index.js';
        }
        if (this.moduleUrl) {
            const mod = await import(/* @vite-ignore */ this.moduleUrl);
            this.module = mod?.default || mod;
            return;
        }
        throw new Error('Orama module not provided. Set moduleFactory or moduleUrl.');
    }

    async _createOrama() {
        const schema = {
            [this.idField]: 'string',
            [this.sessionField]: 'enum',
            [this.vectorProperty]: `vector[${this.dimension}]`
        };
        const create = this.module.create;
        if (typeof create !== 'function') {
            throw new Error('Orama module missing create() export.');
        }
        this.orama = await create({ schema });
    }

    _cosineSimilarity(a, b) {
        let dot = 0;
        let normA = 0;
        let normB = 0;
        for (let i = 0; i < this.dimension; i += 1) {
            const av = a[i];
            const bv = b[i];
            dot += av * bv;
            normA += av * av;
            normB += bv * bv;
        }
        const denom = Math.sqrt(normA) * Math.sqrt(normB);
        return denom > 0 ? dot / denom : 0;
    }
}
