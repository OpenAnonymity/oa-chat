import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSyncUploadBatches, MAX_SYNC_UPLOAD_BYTES } from '../../chat/services/syncUploadBatches.js';

const size = value => Buffer.byteLength(value, 'utf8');
const blob = (id, length) => ({ id, ciphertext: 'a'.repeat(length), iv: 'synthetic', version: 1 });

test('wallet-sized upload splits by exact serialized bytes without omitting or changing items', () => {
    const blobs = [blob('active', 3285800), blob('history', 3000000), blob('removals', 1329000),
        ...Array.from({length: 6}, (_,i) => blob(`pref-${i}`, 20))];
    assert(size(JSON.stringify({blobs})) > 7_600_000);
    const batches = buildSyncUploadBatches(blobs);
    assert.equal(batches.length, 3);
    for (const batch of batches) {
        assert(size(batch.body) <= MAX_SYNC_UPLOAD_BYTES);
        assert.equal(batch.body, JSON.stringify({blobs: batch.blobs}));
    }
    assert.deepEqual(batches.flatMap(b => JSON.parse(b.body).blobs), blobs);
});

test('UTF-8, escapes, commas and JSON envelope count at the exact boundary', () => {
    const prefix = { id: 'é😀"\\', ciphertext: '' };
    const overhead = size(JSON.stringify({blobs:[prefix]}));
    const exact = {...prefix, ciphertext:'a'.repeat(MAX_SYNC_UPLOAD_BYTES-overhead)};
    assert.equal(size(buildSyncUploadBatches([exact])[0].body), MAX_SYNC_UPLOAD_BYTES);
    assert.throws(() => buildSyncUploadBatches([{...exact,ciphertext:exact.ciphertext+'é'}]), /too large/);
    const half = blob('half', Math.floor(MAX_SYNC_UPLOAD_BYTES/2)-60);
    const unicode = {...half, id:'é'.repeat(100)};
    assert.equal(buildSyncUploadBatches([half, unicode]).length,2);
});

test('item-count limit remains 100 and empty input makes no request', () => {
    assert.deepEqual(buildSyncUploadBatches([]),[]);
    const batches = buildSyncUploadBatches(Array.from({length:205}, (_,i)=>blob(String(i),0)));
    assert.deepEqual(batches.map(b=>b.blobs.length),[100,100,5]);
});

test('a later oversized item rejects the whole plan before any batch is returned', () => {
    assert.throws(() => buildSyncUploadBatches([
        ...Array.from({length:101}, (_,i)=>blob(String(i),0)), blob('oversized',MAX_SYNC_UPLOAD_BYTES)
    ]), /local data is kept/);
});
