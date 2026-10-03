import test from 'node:test';
import assert from 'node:assert/strict';
import { createComposerImageUrls } from '../../chat/services/composerImageUrls.js';

function fixture() {
    const created = [], revoked = [];
    const store = createComposerImageUrls({
        createObjectURL(file) { created.push(file); return `blob:photo-${created.length}`; },
        revokeObjectURL(url) { revoked.push(url); }
    });
    return { store, created, revoked };
}
test('removed and sent attachments release URLs; stale renders cannot recreate them', () => {
    const { store, created, revoked } = fixture();
    const first = {}, second = {};
    store.setFiles([first, second]);
    const a = store.getUrl(first), b = store.getUrl(second);
    assert.equal(store.getUrl(first), a);
    store.setFiles([second]);
    assert.deepEqual(revoked, [a]);
    assert.equal(store.getUrl(first), '');
    store.setFiles([]);
    assert.deepEqual(revoked, [a, b]);
    assert.equal(store.getUrl(second), '');
    assert.equal(created.length, 2);
});
test('expanded viewers retain a removed image until the last viewer closes', () => {
    const { store, revoked } = fixture();
    const file = {};
    store.setFiles([file]);
    const url = store.getUrl(file);
    const closeFirst = store.retainViewer(url), closeSecond = store.retainViewer(url);
    store.setFiles([]);
    assert.deepEqual(revoked, []);
    closeFirst(); closeFirst();
    assert.deepEqual(revoked, []);
    closeSecond();
    assert.deepEqual(revoked, [url]);
    store.retainViewer('data:image/png,unowned')();
    assert.deepEqual(revoked, [url]);
});
test('closing a viewer preserves a still-attached image for subsequent viewing', () => {
    const { store, revoked } = fixture();
    const file = {};
    store.setFiles([file]);
    const url = store.getUrl(file);
    store.retainViewer(url)();
    assert.equal(store.getUrl(file), url);
    assert.deepEqual(revoked, []);
    store.setFiles([]);
    assert.deepEqual(revoked, [url]);
});
