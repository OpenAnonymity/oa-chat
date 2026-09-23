import test from 'node:test';
import assert from 'node:assert/strict';
import { chatDB } from '../../chat/db.js';
import { acquireSessionAccess } from '../../chat/application/accessController.js';

function storageHarness() {
    const db = new chatDB.constructor();
    const notices = [];
    const request = {};
    const transaction = { error: null, objectStore: () => ({
        put(session) { transaction.pending = structuredClone(session); return request; }
    }) };
    db.db = { transaction: () => transaction };
    db.emitStorageEvent = (...args) => notices.push(args);
    return { db, request, transaction, notices };
}

test('session save waits for commit before reporting success or notifying other tabs', async () => {
    const h = storageHarness();
    let saved = false;
    const pending = h.db.saveSession({id:'chat',apiKey:'test-key'}).then(() => { saved = true; });
    h.request.onsuccess?.();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(saved, false);
    assert.deepEqual(h.notices, []);
    h.transaction.oncomplete();
    await pending;
    assert.equal(saved, true);
    assert.deepEqual(h.notices, [['sessions-updated', {sessionId:'chat'}]]);
});

test('a transaction aborted after a successful put does not report a saved key', async () => {
    const h = storageHarness();
    const pending = h.db.saveSession({id:'chat',apiKey:'test-key'});
    const rejected = assert.rejects(pending, /not committed/);
    h.request.onsuccess?.();
    h.transaction.onabort?.();
    await rejected;
    assert.deepEqual(h.notices, []);
});

test('access acquisition waits for session commit and writes the key with its verification proof', async () => {
    const h = storageHarness();
    const session = {id:'chat'};
    const proof = {status:'verified'};
    let granted = false;
    const pending = acquireSessionAccess({
        session, chatDB:h.db,
        acquireAccess:async () => ({key:'test-key',expiresAt:'2099-01-01T00:00:00Z',verifierSubmitKeyProof:proof}),
        inferenceService: {
            setAccessInfo(target, info) { target.apiKey = info.key; target.apiKeyInfo = info; target.expiresAt = info.expiresAt; },
            getAccessToken: target => target.apiKey,
            getVerificationAdapter: () => ({supports:false})
        }
    }).then(token => { granted = true; return token; });
    await new Promise(resolve => setImmediate(resolve));
    h.request.onsuccess?.();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(granted, false, 'waiting must not start after put success alone');
    h.transaction.oncomplete();
    assert.equal(await pending, 'test-key');
    const serialized = h.transaction.pending;
    assert.equal(serialized.apiKey, 'test-key');
    assert.deepEqual(serialized.apiKeyInfo.verifierSubmitKeyProof, proof);
    assert.equal(serialized.expiresAt, '2099-01-01T00:00:00Z');
});
