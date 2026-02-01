import test from 'node:test';
import assert from 'node:assert/strict';
import { createEmbeddingSource } from '../index.js';

const stubBackend = {
    id: 'stub',
    label: 'Stub',
    async createEmbedding(request) {
        const inputs = Array.isArray(request.input) ? request.input : [request.input];
        const data = inputs.map((text, index) => ({
            index,
            embedding: [String(text).length, index, 1]
        }));
        return { model: request.model, data };
    }
};

test('embedding source: embedText returns Float32Array', async () => {
    const source = createEmbeddingSource({
        backend: stubBackend,
        model: 'stub-model'
    });

    const embedding = await source.embedText('hello');
    assert.ok(embedding instanceof Float32Array);
    assert.equal(embedding.length, 3);
    assert.equal(embedding[0], 5);
});

test('embedding source: embedTexts returns batch embeddings', async () => {
    const source = createEmbeddingSource({
        backend: stubBackend,
        model: 'stub-model'
    });

    const embeddings = await source.embedTexts(['a', 'abcd']);
    assert.equal(embeddings.length, 2);
    assert.equal(embeddings[0][0], 1);
    assert.equal(embeddings[1][0], 4);
});

test('embedding source: createEmbedding normalizes response', async () => {
    const source = createEmbeddingSource({
        backend: stubBackend,
        model: 'stub-model'
    });

    const response = await source.createEmbedding({ input: 'abc' });
    assert.equal(response.model, 'stub-model');
    assert.ok(Array.isArray(response.embeddings));
    assert.ok(response.embeddings[0] instanceof Float32Array);
});
