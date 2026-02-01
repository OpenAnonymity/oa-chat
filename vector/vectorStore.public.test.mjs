import test from 'node:test';
import assert from 'node:assert/strict';
import { createVectorStore } from './index.js';

function makeVectors(count, dimension) {
    const items = [];
    for (let i = 0; i < count; i += 1) {
        const vec = new Float32Array(dimension);
        vec[i % dimension] = 1;
        items.push({ id: `id-${i}`, vector: vec, metadata: { idx: i } });
    }
    return items;
}

test('public api: create, upsert, get, count, search, remove, clear', async () => {
    const store = await createVectorStore({
        name: 'public-basic',
        dimension: 4,
        metric: 'cosine',
        backend: 'memory'
    });

    await store.upsert({ id: 'a', vector: [1, 0, 0, 0], metadata: { tag: 'alpha' } });
    await store.upsert({ id: 'b', vector: [0, 1, 0, 0], metadata: { tag: 'beta' } });

    assert.equal(await store.count(), 2);

    const got = await store.get(['a', 'b'], { includeVectors: true });
    assert.equal(got.length, 2);
    assert.ok(got[0].vector instanceof Float32Array);

    const results = await store.search([1, 0, 0, 0], 1);
    assert.equal(results[0].id, 'a');

    await store.remove('a');
    assert.equal(await store.count(), 1);

    await store.clear();
    assert.equal(await store.count(), 0);
});

test('public api: supports batch upsert + filter + minScore', async () => {
    const store = await createVectorStore({
        name: 'public-filter',
        dimension: 3,
        metric: 'cosine',
        backend: 'memory'
    });

    await store.upsert(makeVectors(6, 3));

    const results = await store.search([1, 0, 0], 5, {
        filter: (metadata) => metadata.idx % 2 === 0,
        minScore: 0.5
    });

    assert.ok(results.length > 0);
    assert.ok(results.every((r) => r.metadata.idx % 2 === 0));
});

test('public api: dimension mismatch throws', async () => {
    const store = await createVectorStore({
        name: 'public-dim',
        dimension: 2,
        metric: 'cosine',
        backend: 'memory'
    });

    await assert.rejects(async () => {
        await store.upsert({ id: 'bad', vector: [1, 0, 0] });
    }, /dimension/i);
});

test('public api: auto backend falls back to memory in node', async () => {
    const store = await createVectorStore({
        name: 'public-auto',
        dimension: 2,
        metric: 'cosine'
    });

    await store.upsert({ id: 'a', vector: [1, 0] });
    const results = await store.search([1, 0], 1);
    assert.equal(results[0].id, 'a');
});
