import test from 'node:test';
import assert from 'node:assert/strict';

import { chatDB } from '../../chat/db.js';
import syncService from '../../chat/services/encryptedSyncService.js';
import { TicketStore } from '../../chat/services/ticketStore.js';
import {
    TICKET_USAGE_KEY,
    TICKET_USAGE_MAX_DAYS,
    addTicketUsage,
    backfillTicketUsage,
    localDayKey,
    normalizeTicketUsageLog,
    toTicketUsageHistory
} from '../../chat/services/ticketUsageLog.js';

const ticket = (n, consumedAt) => ({
    finalized_ticket: `ticket-${n}`,
    ...(consumedAt ? { consumed_at: consumedAt } : {})
});

function storeWith({ active = [], archived = [], log = null } = {}) {
    const store = new TicketStore();
    const state = { log, writes: [], persisted: [] };
    store.withLock = async handler => handler();
    store.ensureDbReady = async () => {};
    store.readFromDatabase = async () => ({ active, archived, invalidatedKeyIds: [] });
    store.persistTickets = async (nextActive, nextArchive, options) => {
        state.persisted.push({ active: nextActive, archive: nextArchive, options });
        if (options?.usageLog) {
            state.log = options.usageLog;
            state.writes.push(options.usageLog);
        }
    };
    store.readUsageLog = async () => normalizeTicketUsageLog(state.log);
    store.writeUsageLog = async next => {
        state.log = next;
        state.writes.push(next);
    };
    return { store, state };
}

test('localDayKey uses the local calendar day', () => {
    assert.equal(localDayKey(new Date(2026, 10, 5, 23, 59)), '2026-11-05');
    assert.equal(localDayKey(new Date(2026, 0, 1, 0, 0)), '2026-01-01');
    assert.equal(localDayKey('not a date'), null);
});

test('normalizeTicketUsageLog keeps only well-formed positive day counts', () => {
    const log = normalizeTicketUsageLog({
        backfilled: true,
        days: { '2026-11-05': 3, '2026-11-06': 0, '2026-11-07': -2, bad: 4, '2026-11-08': '2', '2026-11-09': 1.9 }
    });
    assert.deepEqual(log, {
        version: 1,
        backfilled: true,
        days: { '2026-11-05': 3, '2026-11-08': 2, '2026-11-09': 1 }
    });
    assert.deepEqual(normalizeTicketUsageLog(undefined), { version: 1, backfilled: false, days: {} });
});

test('addTicketUsage adds to the day and caps the history length', () => {
    let log = addTicketUsage(null, 2, new Date(2026, 10, 5, 9));
    log = addTicketUsage(log, 3, new Date(2026, 10, 5, 18));
    log = addTicketUsage(log, 0, new Date(2026, 10, 6));
    assert.deepEqual(log.days, { '2026-11-05': 5 });

    const days = {};
    for (let i = 0; i < TICKET_USAGE_MAX_DAYS + 5; i += 1) {
        days[localDayKey(new Date(2010, 0, 1 + i))] = 1;
    }
    const capped = normalizeTicketUsageLog({ days });
    assert.equal(Object.keys(capped.days).length, TICKET_USAGE_MAX_DAYS);
    assert.equal(capped.days['2010-01-01'], undefined);
});

test('backfillTicketUsage seeds once from the archive without double counting', () => {
    const archive = [
        ticket(1, new Date(2026, 10, 3, 10).toISOString()),
        ticket(2, new Date(2026, 10, 3, 11).toISOString()),
        ticket(3, new Date(2026, 10, 4, 9).toISOString()),
        ticket(4)
    ];
    const seeded = backfillTicketUsage({ days: { '2026-11-04': 5 } }, archive);
    assert.equal(seeded.backfilled, true);
    assert.deepEqual(seeded.days, { '2026-11-03': 2, '2026-11-04': 5 });
    assert.deepEqual(backfillTicketUsage(seeded, [...archive, ...archive]).days, seeded.days);
});

test('toTicketUsageHistory is frozen and oldest first', () => {
    const history = toTicketUsageHistory({ days: { '2026-11-05': 1, '2026-10-01': 4 } });
    assert.deepEqual(history.map(entry => entry.day), ['2026-10-01', '2026-11-05']);
    assert.ok(Object.isFrozen(history));
    assert.ok(Object.isFrozen(history[0]));
});

test('a successful spend records usage after seeding from the prior archive', async () => {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const { store, state } = storeWith({
        active: [ticket(1), ticket(2), ticket(3)],
        archived: [ticket(9, yesterday.toISOString())]
    });
    await store.consumeTickets(2, async () => ({ ok: true }));
    assert.equal(state.writes.length, 1);
    assert.equal(state.log.backfilled, true);
    assert.equal(state.log.days[localDayKey(yesterday)], 1);
    assert.equal(state.log.days[localDayKey(new Date())], 2);
    assert.equal(state.persisted.length, 1);
});

test('a first share seeds history without counting the shared tickets', async () => {
    const { store, state } = storeWith({ active: [ticket(1), ticket(2)] });
    await store.consumeTickets(2, async () => ({ ok: true }), { order: 'tail', recordUsage: false });
    assert.equal(state.writes.length, 1);
    assert.equal(state.log.backfilled, true);
    assert.deepEqual(state.log.days, {});
    assert.equal(state.persisted.length, 1);
    assert.deepEqual(await store.getUsageHistory(), []);
});

test('tickets the server consumed during a failed request are recorded', async () => {
    const { store, state } = storeWith({ active: [ticket(1), ticket(2), ticket(3)] });
    await assert.rejects(store.consumeTickets(3, async ({ tickets }) => {
        const error = new Error('partly spent');
        error.consumeTickets = true;
        error.usedTokens = [tickets[0].finalized_ticket];
        throw error;
    }));
    assert.equal(state.log.days[localDayKey(new Date())], 1);
});

test('expired-key cleanup removes spent tickets but keeps the usage log', async () => {
    const { store, state } = storeWith({
        active: [ticket(1)],
        log: { backfilled: true, days: { '2026-10-15': 7 } }
    });
    await assert.rejects(store.consumeTickets(1, async () => {
        const error = new Error('rotated');
        error.code = 'TICKET_KEY_INVALIDATED';
        error.invalidatedKeyId = '11'.repeat(32);
        throw error;
    }));
    assert.equal(state.writes.length, 0);
    assert.deepEqual(state.log.days, { '2026-10-15': 7 });
});

test('a failed usage read never fails the spend', async () => {
    const { store, state } = storeWith({ active: [ticket(1)] });
    store.readUsageLog = async () => { throw new Error('quota'); };
    const originalWarn = console.warn;
    console.warn = () => {};
    try {
        const result = await store.consumeTickets(1, async () => 'done');
        assert.equal(result.result, 'done');
    } finally {
        console.warn = originalWarn;
    }
    assert.equal(state.persisted.length, 1);
});

test('getUsageHistory seeds from the archive once', async () => {
    const day = new Date(2026, 9, 20, 12).toISOString();
    const { store, state } = storeWith({ archived: [ticket(1, day), ticket(2, day)] });
    const first = await store.getUsageHistory();
    assert.deepEqual(first.map(entry => ({ ...entry })), [{ day: '2026-10-20', count: 2 }]);
    const second = await store.getUsageHistory();
    assert.deepEqual(second.map(entry => ({ ...entry })), [{ day: '2026-10-20', count: 2 }]);
    assert.equal(state.writes.length, 1);
});

test('the usage log switches with the account and is never uploaded', async () => {
    assert.ok(syncService.getAccountScopedSettingKeys().includes(TICKET_USAGE_KEY));
    const read = [];
    const { chatDB } = await import('../../chat/db.js');
    const originalGet = chatDB.getSetting;
    chatDB.getSetting = async key => { read.push(key); return undefined; };
    try {
        await syncService.readUploadSnapshot();
    } finally {
        chatDB.getSetting = originalGet;
    }
    assert.ok(!read.includes(TICKET_USAGE_KEY));
});


test('already seeded history still requires the account scope lock', async () => {
    const { store } = storeWith({ log: { backfilled: true, days: { '2026-11-05': 2 } } });
    let locked = false;
    const read = store.readUsageLog;
    store.withLock = async handler => { locked = true; try { return await handler(); } finally { locked = false; } };
    store.readUsageLog = async () => { assert.equal(locked, true); return read(); };
    assert.deepEqual(await store.getUsageHistory(), [{ day: '2026-11-05', count: 2 }]);
    store.withLock = async () => { throw new Error('account scope unavailable'); };
    await assert.rejects(store.getUsageHistory(), /account scope unavailable/);
});


test('usage and consumed tickets commit together and a failed batch cannot double count', async t => {
    const { store, state } = storeWith({ active: [ticket(1)] });
    const originalDb = chatDB.db;
    chatDB.db = {};
    t.after(() => { chatDB.db = originalDb; });
    store.persistTickets = TicketStore.prototype.persistTickets;
    store.markHadTicketsBeforeIfNeeded = async () => {};
    store.publishUpdate = () => {};
    let fail = true;
    const batches = [];
    t.mock.method(chatDB, 'saveSettings', async entries => {
        batches.push(entries);
        if (fail) throw new Error('disk full');
        state.log = entries.find(entry => entry.key === TICKET_USAGE_KEY)?.value;
    });
    t.mock.method(console, 'warn', () => {});
    await store.consumeTickets(1, async () => 'key');
    assert.equal(state.log, null, 'failed batch must leave the usage log unchanged');
    fail = false;
    await store.consumeTickets(1, async () => 'replayed key');
    assert.equal(state.log.days[localDayKey(new Date())], 1);
    assert.equal(batches.length, 2);
    assert.equal(batches[1].length, 3, 'active tickets, archive and usage share a transaction');
});
