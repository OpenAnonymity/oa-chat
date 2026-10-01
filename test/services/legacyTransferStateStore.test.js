import assert from 'node:assert/strict';
import test from 'node:test';
import { legacyTransferStateStore } from '../../chat/services/legacyTransferStateStore.js';

test('old single journal migrates without losing another account across reloads', async () => {
    let saved = { accountId: 'A', tickets: ['a'], reservedTickets: ['a', 'a2'] };
    const db = { getSetting: async () => structuredClone(saved), updateSettings: async entries => { saved = structuredClone(entries[0].value); } };
    await legacyTransferStateStore(db).put({ accountId: 'B', tickets: ['b'] });
    const reloaded = legacyTransferStateStore(db);
    assert.equal((await reloaded.list()).length, 2);
    await reloaded.clear('B');
    assert.deepEqual(await reloaded.get('A'), { accountId: 'A', tickets: ['a'], reservedTickets: ['a', 'a2'] });
});

test('failed or malformed journal reads never overwrite recovery data', async () => {
    let writes = 0;
    const db = { getSetting: async () => { throw new Error('storage unavailable'); }, updateSettings: async () => { writes++; } };
    await assert.rejects(legacyTransferStateStore(db).put({ accountId: 'B', tickets: ['b'] }), /storage unavailable/);
    db.getSetting = async () => ({ accountId: 'A', tickets: null });
    await assert.rejects(legacyTransferStateStore(db).clear('A'), /kept/);
    assert.equal(writes, 0);
});
