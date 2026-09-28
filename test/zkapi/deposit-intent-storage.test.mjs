import test from 'node:test';
import assert from 'node:assert/strict';
import { chatDB } from '../../chat/db.js';

function fixture(value) {
    const puts = [];
    const request = { result: { value } };
    const transaction = {
        objectStore(name) {
            assert.equal(name, 'settings');
            return {
                get(key) { assert.equal(key, 'intent'); return request; },
                put(record) { puts.push(record); }
            };
        }
    };
    const receiver = { db: { transaction(stores, mode) {
        assert.deepEqual(stores, ['settings']);
        assert.equal(mode, 'readwrite');
        return transaction;
    } } };
    return { puts, request, transaction, update: (expected, next) =>
        chatDB.compareAndSetSetting.call(receiver, 'intent', expected, next) };
}

test('deposit display update reads and writes in one transaction and waits for commit', async () => {
    const original = { amount: '10', inputCurrency: 'usd' };
    const next = { ...original, inputCurrency: 'eth' };
    const f = fixture(structuredClone(original));
    let settled = false;
    const updated = f.update(original, next).then(result => { settled = true; return result; });
    f.request.onsuccess();
    await Promise.resolve();
    assert.equal(settled, false);
    assert.deepEqual(f.puts, [{ key: 'intent', value: next }]);
    f.transaction.oncomplete();
    assert.equal(await updated, true);
});

test('a newer stored principal prevents a stale display update', async () => {
    const f = fixture({ amount: '20', inputCurrency: 'usd' });
    const updated = f.update({ amount: '10', inputCurrency: 'usd' }, { amount: '10', inputCurrency: 'eth' });
    f.request.onsuccess();
    f.transaction.oncomplete();
    assert.equal(await updated, false);
    assert.equal(f.puts.length, 0);
});

test('a transaction abort never reports a saved currency change', async () => {
    const f = fixture({ amount: '10' });
    const updated = f.update({ amount: '10' }, { amount: '10', inputCurrency: 'eth' });
    f.request.onsuccess();
    f.transaction.onabort();
    await assert.rejects(updated, /transaction aborted/);
});

test('a missing intent can be initialized by saved-deposit restoration', async () => {
    const f = fixture(undefined);
    const next = { amount: '10', inputCurrency: 'eth' };
    const updated = f.update(null, next);
    f.request.onsuccess();
    f.transaction.oncomplete();
    assert.equal(await updated, true);
    assert.deepEqual(f.puts, [{ key: 'intent', value: next }]);
});
