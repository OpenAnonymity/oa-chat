import test from 'node:test';
import assert from 'node:assert/strict';
import syncService, { SyncService } from '../../chat/services/encryptedSyncService.js';
import { TicketStore } from '../../chat/services/ticketStore.js';
import { chatDB } from '../../chat/db.js';

const key = new Uint8Array(32).fill(7);
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
function setup(t) {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const service = new SyncService();
    service.setCredentials(key, 'synthetic-a', { identityBacked: true });
    service.withSyncLock = async callback => callback();
    const calls = [];
    service._doSync = async (masterKey, accountId, generation, options) => {
        calls.push({ accountId, options });
        return { success: true };
    };
    t.after(() => service.clearCredentials());
    return { service, calls };
}

test('ticket changes debounce for two seconds, with bounded background transport', async t => {
    const { service, calls } = setup(t);
    service.triggerTicketSync();
    t.mock.timers.tick(1500);
    service.triggerTicketSync();
    t.mock.timers.tick(1999);
    await flush();
    assert.equal(calls.length, 0);
    t.mock.timers.tick(1);
    await flush();
    assert.deepEqual(calls, [{ accountId: 'synthetic-a', options: { background: true } }]);
    assert.equal(service.localChangeSyncPending, false);
    assert.equal(service.syncInProgress, false);
});

test('a change whose timer expires during a sync gets one follow-up after lock release', async t => {
    const { service, calls } = setup(t);
    let release;
    service._doSync = async (...args) => {
        calls.push(args);
        if (calls.length === 1) await new Promise(resolve => { release = resolve; });
        return { success: true };
    };
    const running = service.sync();
    service.triggerTicketSync();
    t.mock.timers.tick(2000);
    await flush();
    assert.equal(calls.length, 1);
    assert.equal(service.localChangeSyncPending, true);
    release();
    await running;
    t.mock.timers.tick(1999);
    await flush();
    assert.equal(calls.length, 1);
    t.mock.timers.tick(1);
    await flush();
    assert.equal(calls.length, 2);
    assert.equal(service.localChangeSyncPending, false);
    t.mock.timers.tick(10000);
    await flush();
    assert.equal(calls.length, 2, 'no repeating upload loop');
});

test('sync stays busy until the account lock releases', async t => {
    const { service, calls } = setup(t);
    let release;
    service.withSyncLock = async callback => {
        const result = await callback();
        await new Promise(resolve => { release = resolve; });
        return result;
    };
    const running = service.sync();
    await flush();
    assert.equal(service.syncInProgress, true);
    assert.match((await service.sync()).error, /already in progress/);
    assert.equal(calls.length, 1);
    release();
    await running;
    assert.equal(service.syncInProgress, false);
});

for (const replacement of [false, true]) {
    test(`${replacement ? 'account replacement' : 'sign-out'} cancels the previous account debounce`, async t => {
        const { service, calls } = setup(t);
        service.triggerTicketSync();
        if (replacement) service.setCredentials(key, 'synthetic-b', { identityBacked: true });
        else service.clearCredentials();
        t.mock.timers.tick(2000);
        await flush();
        assert.equal(calls.length, 0);
        assert.equal(service.localChangeSyncPending, false);
    });
}

test('sign-out during a pass discards its pending follow-up', async t => {
    const { service, calls } = setup(t);
    let release;
    service._doSync = async () => {
        calls.push('first');
        await new Promise(resolve => { release = resolve; });
    };
    const running = service.sync();
    service.triggerTicketSync();
    t.mock.timers.tick(2000);
    service.clearCredentials();
    release();
    await running;
    t.mock.timers.tick(10000);
    await flush();
    assert.equal(calls.length, 1);
    assert.equal(service.localChangeSyncPending, false);
});

test('replacement-account changes survive an old pass finishing', async t => {
    const { service, calls } = setup(t);
    let release;
    service._doSync = async (masterKey, account) => {
        calls.push(account);
        if (account === 'synthetic-a') await new Promise(resolve => { release = resolve; });
        return { success: true };
    };
    const running = service.sync();
    service.setCredentials(key, 'synthetic-b', { identityBacked: true });
    service.triggerTicketSync();
    t.mock.timers.tick(2000);
    release();
    await running;
    t.mock.timers.tick(2000);
    await flush();
    assert.deepEqual(calls, ['synthetic-a', 'synthetic-b']);
});

test('failed scheduled upload does not create a rapid retry loop', async t => {
    const { service, calls } = setup(t);
    service._doSync = async () => { calls.push('failed'); return { success: false }; };
    service.triggerTicketSync();
    t.mock.timers.tick(2000);
    await flush();
    t.mock.timers.tick(60000);
    await flush();
    assert.equal(calls.length, 1, 'periodic/resume reconciliation supplies the next retry');
    assert.equal(service.syncInProgress, false);
});

test('lock failure releases the busy flag', async t => {
    const { service } = setup(t);
    service.withSyncLock = async () => { throw new Error('synthetic lock failure'); };
    await assert.rejects(service.sync(), /synthetic lock failure/);
    assert.equal(service.syncInProgress, false);
});

test('locked wallets schedule no local-change work', async t => {
    const { service, calls } = setup(t);
    service.clearCredentials();
    service.triggerTicketSync();
    t.mock.timers.tick(2000);
    await flush();
    assert.equal(calls.length, 0);
    assert.equal(service.localChangeSyncPending, false);
});

for (const refusal of [false, true]) {
    test(`${refusal ? 'used-ticket removal' : 'successful spend'} schedules identity-backed sync after persistence`, async t => {
        syncService.setCredentials(key, 'synthetic-a', { identityBacked: true });
        t.after(() => syncService.clearCredentials());
        const events = [];
        t.mock.method(syncService, 'triggerTicketSync', () => events.push('schedule'));
        const originalDb = chatDB.db;
        chatDB.db = {};
        t.after(() => { chatDB.db = originalDb; });
        t.mock.method(chatDB, 'saveSettings', async () => events.push('persist'));
        const store = new TicketStore();
        store.withLock = async callback => callback();
        store.ensureDbReady = async () => {};
        store.markHadTicketsBeforeIfNeeded = async () => {};
        store.readFromDatabase = async () => ({ active: [{ finalized_ticket: 'synthetic-ticket' }], archived: [] });
        const request = store.consumeTickets(1, async () => {
            if (refusal) throw Object.assign(new Error('used'), { code: 'TICKET_USED', consumeTickets: true });
            return { key: 'synthetic-provider-key' };
        });
        if (refusal) await assert.rejects(request, { code: 'TICKET_USED' });
        else await request;
        assert.deepEqual(events, ['persist', 'schedule']);
        assert.equal(store.archive.length, 1);
    });
}

test('remote wallet hydration does not echo a local-change upload', async t => {
    const originalDb = chatDB.db;
    chatDB.db = {};
    t.after(() => { chatDB.db = originalDb; });
    let uploads = 0;
    let writes = 0;
    t.mock.method(syncService, 'triggerTicketSync', () => { uploads++; });
    t.mock.method(chatDB, 'saveSettings', async () => { writes++; });
    const store = new TicketStore();
    store.markHadTicketsBeforeIfNeeded = async () => {};
    // A historical used flag requires normalization and persistence during pull.
    store.readFromDatabase = async () => ({
        active: [{ finalized_ticket: 'synthetic-ticket', used: true }],
        archived: [], tombstones: [], invalidatedKeyIds: []
    });
    await store.loadFromDatabase({ emitUpdate: true, skipBroadcast: true });
    assert.equal(writes, 1);
    assert.equal(uploads, 0);
    assert.equal(store.tickets.length, 0);
    assert.equal(store.archive.length, 1);
});
