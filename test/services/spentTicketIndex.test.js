import test from 'node:test';
import assert from 'node:assert/strict';

import ticketClient from '../../chat/services/ticketClient.js';
import { TicketStore } from '../../chat/services/ticketStore.js';
import { getActivityDescription, isSpentTicketRefusal } from '../../chat/services/networkLogRenderer.js';

// The org checks a multi-ticket request in order, stops at the first ticket
// it has already seen and rolls the earlier ones back (oa-org
// auth/ticket_auth.py: validate_and_spend_all, failed_ticket.index). Before
// 2026-10-14 the client set the whole selection aside, so on a three-ticket
// model every ticket spent from another device cost two good ones.

const spentBody = index => ({
    detail: {
        error_code: 'TICKET_ALREADY_SPENT',
        message: 'Ticket validation failed',
        tickets_submitted: 3,
        tickets_consumed: 0,
        failed_ticket: { index, preview: 'AAAB...', reason: 'Ticket already spent' }
    }
});

test('an already-spent refusal names the one ticket the org refused', () => {
    const error = ticketClient.createTicketRedemptionError(spentBody(1), 401, 'fallback');
    assert.equal(error.code, 'TICKET_USED');
    assert.equal(error.consumeTickets, true);
    assert.deepEqual(error.usedIndices, [1]);
    // The first ticket of a single-ticket request.
    assert.deepEqual(ticketClient.createTicketRedemptionError(spentBody(0), 401, 'fallback').usedIndices, [0]);
});

test('without an index (an older org) the refusal names no ticket, as before', () => {
    const older = ticketClient.createTicketRedemptionError({ detail: 'Ticket already spent (double-spending detected)' }, 401, 'fallback');
    assert.equal(older.code, 'TICKET_USED');
    assert.equal('usedIndices' in older, false);
    for (const index of [-1, 'two', null, 1.5]) {
        const body = spentBody(index);
        assert.equal('usedIndices' in ticketClient.createTicketRedemptionError(body, 401, 'fallback'), false, String(index));
    }
});

function tokenFor(nonceByte) {
    const bytes = new Uint8Array(2 + 32 + 32 + 32 + 256);
    bytes[1] = 2;
    bytes.fill(nonceByte, 2, 34);
    bytes.set(Buffer.from('22'.repeat(32), 'hex'), 66);
    return Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function storeWith(active) {
    const persisted = [];
    const store = new TicketStore();
    store.withLock = async handler => handler();
    store.ensureDbReady = async () => {};
    store.readFromDatabase = async () => ({ active, archived: [], tombstones: [], invalidatedKeyIds: [] });
    store.persistTickets = async (nextActive, nextArchive, options) => {
        persisted.push({ active: nextActive, archive: nextArchive, options });
    };
    return { store, persisted };
}

const wallet = [1, 2, 3, 4, 5].map(n => ({ finalized_ticket: tokenFor(n) }));
const tokens = tickets => tickets.map(ticket => ticket.finalized_ticket);

test('only the refused ticket leaves the wallet; the rolled-back ones stay spendable', async () => {
    const { store, persisted } = storeWith(wallet);
    await assert.rejects(store.consumeTickets(3, async () => {
        throw Object.assign(new Error('used'), { code: 'TICKET_USED', consumeTickets: true, usedIndices: [1] });
    }), { code: 'TICKET_USED' });
    assert.equal(persisted.length, 1);
    assert.deepEqual(tokens(persisted[0].active), tokens([wallet[0], wallet[2], wallet[3], wallet[4]]));
    assert.deepEqual(tokens(persisted[0].archive), tokens([wallet[1]]));
    assert.ok(persisted[0].archive[0].consumed_at);
});

test('a refusal that names no ticket still sets the whole selection aside', async () => {
    const { store, persisted } = storeWith(wallet);
    await assert.rejects(store.consumeTickets(3, async () => {
        throw Object.assign(new Error('used'), { code: 'TICKET_USED', consumeTickets: true });
    }), { code: 'TICKET_USED' });
    assert.deepEqual(tokens(persisted[0].active), tokens([wallet[3], wallet[4]]));
    assert.equal(persisted[0].archive.length, 3);
});

test('an index the selection does not have falls back to the whole selection', async () => {
    const { store, persisted } = storeWith(wallet);
    await assert.rejects(store.consumeTickets(2, async () => {
        throw Object.assign(new Error('used'), { code: 'TICKET_USED', consumeTickets: true, usedIndices: [7] });
    }), { code: 'TICKET_USED' });
    assert.equal(persisted[0].archive.length, 2);
});

test('the timeline says a refused ticket was skipped rather than "requesting"', () => {
    const log = { type: 'api-key', method: 'POST', url: 'https://org.example/api/request_key', status: 401, response: spentBody(0) };
    assert.equal(getActivityDescription(log), 'Ticket already used elsewhere, skipped');
    assert.match(getActivityDescription(log, true), /already seen this ticket/);
    assert.match(getActivityDescription(log, true), /Nothing was charged/);
    assert.equal(isSpentTicketRefusal(401, { detail: 'Ticket already spent' }), true);
    assert.equal(isSpentTicketRefusal(401, { detail: { error_code: 'TICKET_INVALID', message: 'Ticket validation failed' } }), false);
    assert.equal(isSpentTicketRefusal(200, spentBody(0)), false);
    // Other refusals keep their rows.
    assert.equal(getActivityDescription({ ...log, response: { detail: { error_code: 'TICKET_INVALID' } } }), 'Requesting ephemeral access key');
    assert.equal(getActivityDescription({ ...log, status: 200, response: { duration_minutes: 30 } }), 'Ephemeral access key granted');
});
