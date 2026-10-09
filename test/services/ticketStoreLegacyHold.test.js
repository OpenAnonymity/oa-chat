import test from 'node:test';
import assert from 'node:assert/strict';

import { TicketStore } from '../../chat/services/ticketStore.js';

const LEGACY_KEY = '61'.repeat(32);
const CURRENT_KEY = '22'.repeat(32);

function tokenForKeyId(keyId, nonceByte) {
    const bytes = new Uint8Array(2 + 32 + 32 + 32 + 256);
    bytes[1] = 2;
    bytes.fill(nonceByte, 2, 34);
    bytes.set(Buffer.from(keyId, 'hex'), 66);
    return Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function storeWith(active, archived = []) {
    const persisted = [];
    const store = new TicketStore();
    store.withLock = async handler => handler();
    store.ensureDbReady = async () => {};
    store.readFromDatabase = async () => ({ active, archived, tombstones: [], invalidatedKeyIds: [] });
    store.persistTickets = async (nextActive, nextArchive, options) => {
        persisted.push({ active: nextActive, archive: nextArchive, options });
    };
    return { store, persisted };
}

const legacy = [1, 2].map(n => ({ finalized_ticket: tokenForKeyId(LEGACY_KEY, n) }));
const current = [3, 4].map(n => ({ finalized_ticket: tokenForKeyId(CURRENT_KEY, n) }));

test('held previous-org tickets are never selected and stay in the wallet', async () => {
    const { store, persisted } = storeWith([...legacy, ...current]);
    store.setHeldKeyIds([LEGACY_KEY.toUpperCase()]);
    let seen = null;
    await store.consumeTickets(1, async ({ tickets }) => { seen = tickets; return 'ok'; });
    assert.deepEqual(seen, [current[0]]);
    const kept = persisted[0].active.map(ticket => ticket.finalized_ticket);
    assert.deepEqual(kept, [...legacy, current[1]].map(ticket => ticket.finalized_ticket));
    assert.equal(persisted[0].archive.length, 1);
});

test('a wallet of only held tickets reports no spendable tickets', async () => {
    const { store } = storeWith([...legacy]);
    store.setHeldKeyIds([LEGACY_KEY]);
    await assert.rejects(store.consumeTickets(1, async () => 'unused'), { code: 'NO_TICKETS' });
    const mixed = storeWith([...legacy, current[0]]);
    mixed.store.setHeldKeyIds([LEGACY_KEY]);
    await assert.rejects(mixed.store.consumeTickets(2, async () => 'unused'), { code: 'INSUFFICIENT_TICKETS' });
});

test('without a hold every ticket is spendable, as before', async () => {
    const { store } = storeWith([...legacy, ...current]);
    let seen = null;
    await store.consumeTickets(2, async ({ tickets }) => { seen = tickets; });
    assert.deepEqual(seen, legacy);
});

test('peek and held count follow the hold', () => {
    const store = new TicketStore();
    store.ensureInit = () => {};
    store.tickets = [...legacy, ...current];
    assert.equal(store.getHeldCount(), 0);
    store.setHeldKeyIds([LEGACY_KEY, 'not-a-key']);
    assert.deepEqual(store.peekTickets(1), [current[0]]);
    assert.equal(store.getHeldCount(), 2);
    store.setHeldKeyIds([]);
    assert.deepEqual(store.peekTickets(1), [legacy[0]]);
});

test('removeTickets drops exactly the moved tickets and tombstones them', async () => {
    const archivedLegacy = { finalized_ticket: tokenForKeyId(LEGACY_KEY, 9), consumed_at: '2026-01-01T00:00:00Z' };
    const { store, persisted } = storeWith([...legacy, ...current], [archivedLegacy]);
    const removed = await store.removeTickets([legacy[0], { finalized_ticket: 'not-in-wallet' }]);
    assert.equal(removed, 1);
    assert.deepEqual(
        persisted[0].active.map(ticket => ticket.finalized_ticket),
        [legacy[1], ...current].map(ticket => ticket.finalized_ticket)
    );
    assert.equal(persisted[0].archive.length, 1);
    assert.equal(persisted[0].options.tombstones.length, 1);
    assert.equal(await store.removeTickets([]), 0);
});

test('stranded tickets stay held and in the wallet, but leave the held count', () => {
    const store = new TicketStore();
    store.initPromise = Promise.resolve();
    store.tickets = [...legacy, ...current];
    store.setHeldKeyIds([LEGACY_KEY]);
    let updates = 0;
    store.emitUpdate = () => { updates += 1; };
    store.setStrandedTickets([legacy[1].finalized_ticket, 'not-in-this-wallet']);
    assert.equal(updates, 1);
    assert.equal(store.getCount(), 4, 'nothing leaves the wallet');
    assert.equal(store.getHeldCount(), 1, 'one old ticket is still moving');
    assert.equal(store.getStrandedCount(), 1);
    assert.deepEqual(store.peekTickets(4), current, 'stranded tickets are never spent');
    store.setStrandedTickets([legacy[1].finalized_ticket]);
    assert.equal(updates, 2);
    store.setStrandedTickets([legacy[1].finalized_ticket]);
    assert.equal(updates, 2, 'no change, no update');
    // Released from the hold (window closed): no longer set apart.
    store.setHeldKeyIds([]);
    assert.equal(store.getStrandedCount(), 0);
});


test('a rejected obsolete price preserves selected tickets for the corrected request', async () => {
    const { store, persisted } = storeWith(current);
    await assert.rejects(store.consumeTickets(1, async () => {
        throw Object.assign(new Error('Model pricing changed'), { code: 'TICKET_PRICE_CHANGED' });
    }), { code: 'TICKET_PRICE_CHANGED' });
    assert.equal(persisted.length, 0);
    await store.consumeTickets(2, async ({ tickets }) => assert.deepEqual(tickets, current));
    assert.equal(persisted[0].archive.length, 2);
    assert.equal(persisted[0].active.length, 0);
});
