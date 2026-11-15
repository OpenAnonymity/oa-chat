import assert from 'node:assert/strict';
import test from 'node:test';
import { chatDB } from '../../chat/db.js';

function transactionFixture(t) {
    const previous = chatDB.db;
    const requests = new Map();
    let transactions = 0;
    const transaction = {
        objectStore: name => {
            assert.equal(name, 'settings');
            return { get: key => { const request = {}; requests.set(key, request); return request; } };
        }
    };
    chatDB.db = { transaction: (stores, mode) => {
        transactions++;
        assert.deepEqual(stores, ['settings']);
        assert.equal(mode, 'readonly');
        return transaction;
    } };
    t.after(() => { chatDB.db = previous; });
    return { transaction, requests, transactionCount: () => transactions };
}

test('related settings are read in one transaction and published only on completion', async t => {
    const h = transactionFixture(t);
    let done = false;
    const snapshot = chatDB.getSettingsSnapshot(['owner', 'pending', 'scope']).then(result => { done = true; return result; });
    for (const [key, request] of h.requests) {
        request.result = key === 'pending' ? undefined : { value: 'account-a' };
        request.onsuccess();
    }
    await Promise.resolve();
    assert.equal(done, false);
    assert.equal(h.transactionCount(), 1);
    h.transaction.oncomplete();
    assert.deepEqual({ ...await snapshot }, { owner: 'account-a', pending: undefined, scope: 'account-a' });
});

for (const event of ['onabort', 'onerror']) {
    test(`a settings transaction ${event} cannot return a partial binding`, async t => {
        const h = transactionFixture(t);
        const snapshot = chatDB.getSettingsSnapshot(['owner', 'pending']);
        const request = h.requests.get('owner');
        request.result = { value: 'account-a' };
        request.onsuccess();
        h.transaction.error = new Error('storage failed');
        h.transaction[event]();
        await assert.rejects(snapshot, /storage failed/);
    });
}
