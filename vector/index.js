import { IndexedDBBackend } from './indexedDbBackend.js';
import { MemoryBackend } from './memoryBackend.js';
import { OramaBackend } from './oramaBackend.js';
import { normalizeMetric } from './utils.js';
import { decodeVectorId, encodeVectorId } from './idCodec.js';

const backendRegistry = new Map();

export function registerBackend(name, factory) {
    if (!name || typeof name !== 'string') {
        throw new Error('Backend name must be a non-empty string.');
    }
    if (typeof factory !== 'function') {
        throw new Error('Backend factory must be a function.');
    }
    backendRegistry.set(name.toLowerCase(), factory);
}

export function availableBackends() {
    return Array.from(backendRegistry.keys());
}

function resolveBackend(backend, options) {
    if (!backend || backend === 'auto') {
        let preferred = 'memory';
        if (typeof window !== 'undefined') {
            preferred = 'orama';
        } else if (typeof indexedDB !== 'undefined') {
            preferred = 'indexeddb';
        }
        return backendRegistry.get(preferred)(options);
    }

    if (typeof backend === 'string') {
        const name = backend.toLowerCase();
        const factory = backendRegistry.get(name);
        if (!factory) {
            throw new Error(`Unknown vector backend: ${backend}`);
        }
        return factory(options);
    }

    if (typeof backend === 'function') {
        const instance = backend(options);
        if (!instance) {
            throw new Error('Backend factory returned no instance.');
        }
        return instance;
    }

    if (typeof backend === 'object') {
        if (backend.name && backend.options) {
            const name = String(backend.name).toLowerCase();
            const mergedOptions = { ...options, ...backend.options };
            const factory = backendRegistry.get(name);
            if (!factory) {
                throw new Error(`Unknown vector backend: ${backend.name}`);
            }
            return factory(mergedOptions);
        }

        if (typeof backend.search === 'function' && typeof backend.upsert === 'function') {
            return backend;
        }
    }

    throw new Error('Unsupported backend configuration.');
}

export class VectorStore {
    constructor(options = {}) {
        if (!options.dimension) {
            throw new Error('VectorStore requires a dimension.');
        }

        this.name = options.name || 'default';
        this.dimension = options.dimension;
        this.metric = normalizeMetric(options.metric);
        this.normalize = options.normalize ?? (this.metric === 'cosine');
        this.backendName = typeof options.backend === 'string' ? options.backend : 'custom';
        this.backend = resolveBackend(options.backend, {
            ...options,
            name: this.name,
            dimension: this.dimension,
            metric: this.metric,
            normalize: this.normalize
        });
        this.ready = Promise.resolve().then(() => this.backend.init?.({
            ...options,
            name: this.name,
            dimension: this.dimension,
            metric: this.metric,
            normalize: this.normalize
        }));
    }

    async upsert(items) {
        await this.ready;
        const batch = Array.isArray(items) ? items : [items];
        return this.backend.upsert(batch);
    }

    async remove(ids) {
        await this.ready;
        return this.backend.remove(ids);
    }

    async get(ids, options) {
        await this.ready;
        return this.backend.get(ids, options);
    }

    async search(query, k, options) {
        await this.ready;
        return this.backend.search(query, k, options);
    }

    async count() {
        await this.ready;
        return this.backend.count();
    }

    async clear() {
        await this.ready;
        return this.backend.clear();
    }

    async stats() {
        await this.ready;
        return this.backend.stats();
    }

    async close() {
        await this.ready;
        return this.backend.close();
    }
}

export async function createVectorStore(options = {}) {
    const store = new VectorStore(options);
    await store.ready;
    return store;
}

registerBackend('memory', (options) => new MemoryBackend(options));
registerBackend('indexeddb', (options) => new IndexedDBBackend(options));
registerBackend('orama', (options) => new OramaBackend(options));

export { MemoryBackend, IndexedDBBackend, OramaBackend, encodeVectorId, decodeVectorId };
