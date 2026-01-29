import { ensurePositiveInteger, normalizeMetric, prepareVector, toId } from './utils.js';

class TopKHeap {
    constructor(k) {
        this.k = k;
        this.size = 0;
        this.indices = new Int32Array(k);
        this.scores = new Float64Array(k);
    }

    push(index, score) {
        if (this.size < this.k) {
            this.indices[this.size] = index;
            this.scores[this.size] = score;
            this.size += 1;
            this._siftUp(this.size - 1);
            return;
        }

        if (score <= this.scores[0]) {
            return;
        }

        this.indices[0] = index;
        this.scores[0] = score;
        this._siftDown(0);
    }

    toSortedArray(mapper) {
        const results = [];
        for (let i = 0; i < this.size; i += 1) {
            results.push(mapper(this.indices[i], this.scores[i]));
        }
        results.sort((a, b) => b.score - a.score);
        return results;
    }

    _siftUp(index) {
        let current = index;
        while (current > 0) {
            const parent = Math.floor((current - 1) / 2);
            if (this.scores[current] >= this.scores[parent]) {
                break;
            }
            this._swap(current, parent);
            current = parent;
        }
    }

    _siftDown(index) {
        let current = index;
        while (true) {
            const left = current * 2 + 1;
            const right = left + 1;
            let smallest = current;

            if (left < this.size && this.scores[left] < this.scores[smallest]) {
                smallest = left;
            }
            if (right < this.size && this.scores[right] < this.scores[smallest]) {
                smallest = right;
            }
            if (smallest === current) {
                break;
            }
            this._swap(current, smallest);
            current = smallest;
        }
    }

    _swap(a, b) {
        const idx = this.indices[a];
        const score = this.scores[a];
        this.indices[a] = this.indices[b];
        this.scores[a] = this.scores[b];
        this.indices[b] = idx;
        this.scores[b] = score;
    }
}

export class MemoryBackend {
    constructor(options = {}) {
        this.name = options.name || 'default';
        this.dimension = options.dimension || null;
        this.metric = normalizeMetric(options.metric);
        this.normalizeVectors = options.normalize ?? (this.metric === 'cosine');
        this.size = 0;
        this.capacity = ensurePositiveInteger(options.capacity, 128);
        this.ids = new Array(this.capacity);
        this.metadata = new Array(this.capacity);
        this.vectors = null;
        this.idToIndex = new Map();
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
        if (!this.vectors || this.vectors.length !== this.capacity * this.dimension) {
            this.vectors = new Float32Array(this.capacity * this.dimension);
        }
    }

    prepareItems(items) {
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

    upsertPrepared(preparedItems) {
        for (const item of preparedItems) {
            const existingIndex = this.idToIndex.get(item.id);
            if (existingIndex !== undefined) {
                this._writeVector(existingIndex, item.vector);
                this.metadata[existingIndex] = item.metadata;
                continue;
            }

            const index = this.size;
            this._ensureCapacity(index + 1);
            this.ids[index] = item.id;
            this.metadata[index] = item.metadata;
            this.idToIndex.set(item.id, index);
            this._writeVector(index, item.vector);
            this.size += 1;
        }
    }

    async upsert(items) {
        const prepared = this.prepareItems(items);
        this.upsertPrepared(prepared);
        return prepared.length;
    }

    async remove(ids) {
        const targetIds = Array.isArray(ids) ? ids : [ids];
        let removed = 0;
        for (const idValue of targetIds) {
            const id = toId(idValue);
            const index = this.idToIndex.get(id);
            if (index === undefined) continue;

            const lastIndex = this.size - 1;
            if (index !== lastIndex) {
                this._moveVector(lastIndex, index);
                this.ids[index] = this.ids[lastIndex];
                this.metadata[index] = this.metadata[lastIndex];
                this.idToIndex.set(this.ids[index], index);
            }

            this.ids[lastIndex] = undefined;
            this.metadata[lastIndex] = undefined;
            this.idToIndex.delete(id);
            this.size -= 1;
            removed += 1;
        }
        return removed;
    }

    async get(ids, options = {}) {
        const targetIds = Array.isArray(ids) ? ids : [ids];
        const includeVectors = options.includeVectors === true;
        const results = [];
        for (const idValue of targetIds) {
            const id = toId(idValue);
            const index = this.idToIndex.get(id);
            if (index === undefined) continue;
            const result = {
                id,
                metadata: this.metadata[index]
            };
            if (includeVectors) {
                result.vector = this._readVector(index);
            }
            results.push(result);
        }
        return results;
    }

    async count() {
        return this.size;
    }

    async clear() {
        this.size = 0;
        this.ids = new Array(this.capacity);
        this.metadata = new Array(this.capacity);
        this.idToIndex.clear();
        this.vectors = new Float32Array(this.capacity * this.dimension);
    }

    async search(query, k = 10, options = {}) {
        const limit = ensurePositiveInteger(k, 10);
        if (this.size === 0 || limit === 0) {
            return [];
        }

        const queryVector = prepareVector(query, this.dimension, this.normalizeVectors);
        const heap = new TopKHeap(Math.min(limit, this.size));
        const filter = typeof options.filter === 'function' ? options.filter : null;
        const minScore = Number.isFinite(options.minScore) ? options.minScore : -Infinity;

        for (let index = 0; index < this.size; index += 1) {
            if (filter && !filter(this.metadata[index], this.ids[index])) {
                continue;
            }

            const score = this._scoreVector(queryVector, index);
            if (score < minScore) {
                continue;
            }
            heap.push(index, score);
        }

        const includeVectors = options.includeVectors === true;
        return heap.toSortedArray((index, score) => {
            const entry = {
                id: this.ids[index],
                score,
                metadata: this.metadata[index]
            };
            if (includeVectors) {
                entry.vector = this._readVector(index);
            }
            return entry;
        });
    }

    async stats() {
        return {
            name: this.name,
            size: this.size,
            dimension: this.dimension,
            metric: this.metric,
            normalize: this.normalizeVectors,
            capacity: this.capacity
        };
    }

    async close() {
        return;
    }

    _ensureCapacity(nextSize) {
        if (nextSize <= this.capacity) return;
        let target = this.capacity;
        while (target < nextSize) {
            target = Math.max(target * 2, target + 1);
        }
        const nextVectors = new Float32Array(target * this.dimension);
        nextVectors.set(this.vectors.subarray(0, this.size * this.dimension));
        this.vectors = nextVectors;
        this.ids.length = target;
        this.metadata.length = target;
        this.capacity = target;
    }

    _writeVector(index, vector) {
        const offset = index * this.dimension;
        this.vectors.set(vector, offset);
    }

    _moveVector(fromIndex, toIndex) {
        if (fromIndex === toIndex) return;
        const fromOffset = fromIndex * this.dimension;
        const toOffset = toIndex * this.dimension;
        this.vectors.copyWithin(toOffset, fromOffset, fromOffset + this.dimension);
    }

    _readVector(index) {
        const offset = index * this.dimension;
        return this.vectors.slice(offset, offset + this.dimension);
    }

    _scoreVector(queryVector, index) {
        const offset = index * this.dimension;
        const vectors = this.vectors;
        if (this.metric === 'l2') {
            let sum = 0;
            for (let i = 0; i < this.dimension; i += 1) {
                const diff = queryVector[i] - vectors[offset + i];
                sum += diff * diff;
            }
            return -sum;
        }

        let dot = 0;
        for (let i = 0; i < this.dimension; i += 1) {
            dot += queryVector[i] * vectors[offset + i];
        }
        return dot;
    }
}
