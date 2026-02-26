import test from 'node:test';
import assert from 'node:assert/strict';
import { createVectorStore, decodeVectorId, encodeVectorId } from './index.js';

function createOramaStub() {
    function matchesWhere(doc, where) {
        if (!where || typeof where !== 'object') return true;

        if (Array.isArray(where.and)) {
            return where.and.every((entry) => matchesWhere(doc, entry));
        }
        if (Array.isArray(where.or)) {
            return where.or.some((entry) => matchesWhere(doc, entry));
        }
        if (where.not && typeof where.not === 'object') {
            return !matchesWhere(doc, where.not);
        }

        for (const [key, condition] of Object.entries(where)) {
            const value = doc[key];
            if (condition && typeof condition === 'object' && !Array.isArray(condition)) {
                if ('eq' in condition) {
                    if (value !== condition.eq) return false;
                    continue;
                }
                return false;
            }
            if (Array.isArray(condition)) {
                if (!condition.includes(value)) return false;
                continue;
            }
            if (value !== condition) return false;
        }
        return true;
    }

    const module = {
        create: async ({ schema }) => ({
            schema,
            docs: new Map(),
            nextId: 1
        }),
        insert: async (db, doc) => {
            const id = doc.id || String(db.nextId++);
            db.docs.set(id, { ...doc, id });
            return id;
        },
        insertMultiple: async (db, docs) => {
            const ids = [];
            for (const doc of docs) {
                // eslint-disable-next-line no-await-in-loop
                const id = await module.insert(db, doc);
                ids.push(id);
            }
            return ids;
        },
        remove: async (db, id) => {
            db.docs.delete(id);
        },
        search: async (db, options) => {
            const { value, property } = options.vector;
            const limit = options.limit ?? 10;
            const similarity = options.similarity ?? 0;
            const where = options.where ?? null;

            const results = [];
            for (const [id, doc] of db.docs.entries()) {
                if (!matchesWhere(doc, where)) {
                    continue;
                }
                const vec = doc[property];
                let dot = 0;
                let qnorm = 0;
                let vnorm = 0;
                for (let i = 0; i < value.length; i += 1) {
                    const q = value[i];
                    const v = vec[i];
                    dot += q * v;
                    qnorm += q * q;
                    vnorm += v * v;
                }
                const denom = Math.sqrt(qnorm) * Math.sqrt(vnorm);
                const score = denom > 0 ? dot / denom : 0;
                if (score >= similarity) {
                    results.push({ id, score, document: doc });
                }
            }

            results.sort((a, b) => b.score - a.score);
            return { hits: results.slice(0, limit) };
        }
    };
    return module;
}

test('memory backend: upsert and search (cosine)', async () => {
    const store = await createVectorStore({
        name: 'test-cosine',
        dimension: 3,
        metric: 'cosine',
        backend: 'memory'
    });

    await store.upsert([
        { id: 'a', vector: [1, 0, 0], metadata: { tag: 'alpha' } },
        { id: 'b', vector: [0, 1, 0], metadata: { tag: 'beta' } }
    ]);

    const results = await store.search([1, 0, 0], 2);
    assert.equal(results.length, 2);
    assert.equal(results[0].id, 'a');
    assert.equal(results[0].metadata.tag, 'alpha');
});

test('memory backend: update + remove', async () => {
    const store = await createVectorStore({
        name: 'test-update',
        dimension: 2,
        metric: 'cosine',
        backend: 'memory'
    });

    await store.upsert([
        { id: 'x', vector: [1, 0] },
        { id: 'y', vector: [0, 1] }
    ]);

    await store.upsert({ id: 'y', vector: [0, 1], metadata: { updated: true } });

    const results = await store.search([0, 1], 1);
    assert.equal(results[0].id, 'y');
    assert.equal(results[0].metadata.updated, true);

    await store.remove('x');
    const count = await store.count();
    assert.equal(count, 1);
});

test('memory backend: l2 metric ordering', async () => {
    const store = await createVectorStore({
        name: 'test-l2',
        dimension: 2,
        metric: 'l2',
        backend: 'memory'
    });

    await store.upsert([
        { id: 'near', vector: [0.1, 0.1] },
        { id: 'far', vector: [2, 2] }
    ]);

    const results = await store.search([0, 0], 1);
    assert.equal(results[0].id, 'near');
});

test('memory backend: filter + includeVectors', async () => {
    const store = await createVectorStore({
        name: 'test-filter',
        dimension: 2,
        metric: 'cosine',
        backend: 'memory'
    });

    await store.upsert([
        { id: 'keep', vector: [1, 0], metadata: { keep: true } },
        { id: 'drop', vector: [1, 0], metadata: { keep: false } }
    ]);

    const results = await store.search([1, 0], 5, {
        filter: (metadata) => metadata?.keep === true,
        includeVectors: true
    });

    assert.equal(results.length, 1);
    assert.equal(results[0].id, 'keep');
    assert.ok(results[0].vector instanceof Float32Array);
});

test('id codec: encode + decode roundtrip', () => {
    const id = encodeVectorId({
        namespace: 'chat',
        type: 'session',
        entityId: 'session-1',
        chunkId: 2,
        field: 'body',
        variant: 'v1'
    });

    const decoded = decodeVectorId(id);
    assert.equal(decoded.namespace, 'chat');
    assert.equal(decoded.type, 'session');
    assert.equal(decoded.entityId, 'session-1');
    assert.equal(decoded.chunkId, '2');
    assert.equal(decoded.field, 'body');
    assert.equal(decoded.variant, 'v1');
});

test('orama backend: upsert + search + includeVectors', async () => {
    const module = createOramaStub();
    const store = await createVectorStore({
        name: 'orama-basic',
        dimension: 2,
        metric: 'cosine',
        backend: 'orama',
        persistence: 'none',
        moduleFactory: async () => module
    });

    await store.upsert([
        { id: 'a', vector: [1, 0], metadata: { tag: 'alpha' } },
        { id: 'b', vector: [0, 1], metadata: { tag: 'beta' } }
    ]);

    const results = await store.search([1, 0], 1, { includeVectors: true });
    assert.equal(results.length, 1);
    assert.equal(results[0].id, 'a');
    assert.equal(results[0].metadata.tag, 'alpha');
    assert.ok(results[0].vector instanceof Float32Array);
});

test('orama backend: update + remove', async () => {
    const module = createOramaStub();
    const store = await createVectorStore({
        name: 'orama-update',
        dimension: 2,
        metric: 'cosine',
        backend: 'orama',
        persistence: 'none',
        moduleFactory: async () => module
    });

    await store.upsert([
        { id: 'x', vector: [1, 0] },
        { id: 'y', vector: [0, 1] }
    ]);

    await store.upsert({ id: 'y', vector: [0, 1], metadata: { updated: true } });
    const results = await store.search([0, 1], 1);
    assert.equal(results[0].id, 'y');
    assert.equal(results[0].metadata.updated, true);

    await store.remove('x');
    const count = await store.count();
    assert.equal(count, 1);
});

test('orama backend: native where filter before top-k', async () => {
    const module = createOramaStub();
    const store = await createVectorStore({
        name: 'orama-native-where',
        dimension: 2,
        metric: 'cosine',
        backend: 'orama',
        persistence: 'none',
        moduleFactory: async () => module
    });

    await store.upsert([
        { id: 'drop', vector: [1, 0] },
        { id: 'keep', vector: [0.7, 0.3] }
    ]);

    const results = await store.search([1, 0], 1, {
        where: { id: 'keep' }
    });

    assert.equal(results.length, 1);
    assert.equal(results[0].id, 'keep');
});

test('orama backend: object filter alias maps to native where', async () => {
    const module = createOramaStub();
    const store = await createVectorStore({
        name: 'orama-object-filter-alias',
        dimension: 2,
        metric: 'cosine',
        backend: 'orama',
        persistence: 'none',
        moduleFactory: async () => module
    });

    await store.upsert([
        { id: 'drop-1', vector: [1, 0], metadata: { sessionId: 's-drop' } },
        { id: 'drop-2', vector: [0.98, 0.02], metadata: { sessionId: 's-drop' } },
        { id: 'keep-1', vector: [0.9, 0.1], metadata: { sessionId: 's-keep' } },
        { id: 'keep-2', vector: [0.8, 0.2], metadata: { sessionId: 's-keep' } }
    ]);

    const results = await store.search([1, 0], 1, {
        filter: { sessionId: 's-keep' }
    });

    assert.equal(results.length, 1);
    assert.equal(results[0].id, 'keep-1');
});

test('orama backend: function filter fallback still works', async () => {
    const module = createOramaStub();
    const store = await createVectorStore({
        name: 'orama-function-filter-fallback',
        dimension: 2,
        metric: 'cosine',
        backend: 'orama',
        persistence: 'none',
        moduleFactory: async () => module
    });

    await store.upsert([
        { id: 'a', vector: [1, 0], metadata: { sessionId: 's1' } }
    ]);

    const results = await store.search([1, 0], 1, {
        filter: (metadata) => metadata?.sessionId === 's1'
    });

    assert.equal(results.length, 1);
    assert.equal(results[0].id, 'a');
});
