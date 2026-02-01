import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeEmbeddingResponse, firstEmbedding } from '../utils.js';

test('normalizeEmbeddingResponse decodes base64 embeddings', () => {
    const raw = new Float32Array([1.5, -2, 0.25]);
    const base64 = Buffer.from(raw.buffer).toString('base64');

    const response = normalizeEmbeddingResponse({
        model: 'stub',
        data: [{ embedding: base64 }]
    });

    assert.ok(response.embeddings[0] instanceof Float32Array);
    assert.equal(response.embeddings[0].length, 3);
    assert.ok(Math.abs(response.embeddings[0][0] - 1.5) < 1e-6);
    assert.ok(Math.abs(response.embeddings[0][1] + 2) < 1e-6);
    assert.ok(Math.abs(response.embeddings[0][2] - 0.25) < 1e-6);
});

test('firstEmbedding returns decoded base64 embedding', () => {
    const raw = new Float32Array([0.5, 0.75]);
    const base64 = Buffer.from(raw.buffer).toString('base64');

    const embedding = firstEmbedding({
        data: [{ embedding: base64 }]
    });

    assert.ok(embedding instanceof Float32Array);
    assert.equal(embedding.length, 2);
    assert.ok(Math.abs(embedding[0] - 0.5) < 1e-6);
    assert.ok(Math.abs(embedding[1] - 0.75) < 1e-6);
});
