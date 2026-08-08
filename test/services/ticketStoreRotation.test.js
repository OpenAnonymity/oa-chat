import test from 'node:test';
import assert from 'node:assert/strict';

import syncService from '../../chat/services/encryptedSyncService.js';
import { TicketStore } from '../../chat/services/ticketStore.js';

function tokenForKeyId(keyId, nonceByte) {
    const bytes = new Uint8Array(2 + 32 + 32 + 32 + 256);
    bytes[0] = 0;
    bytes[1] = 2;
    bytes.fill(nonceByte, 2, 34);
    bytes.set(Buffer.from(keyId, 'hex'), 66);
    return Buffer.from(bytes)
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/g, '');
}

test('consumeTickets deletes every ticket from an invalidated key generation', async () => {
    const oldKeyId = '11'.repeat(32);
    const currentKeyId = '22'.repeat(32);
    const active = [
        { finalized_ticket: tokenForKeyId(oldKeyId, 1) },
        { finalized_ticket: tokenForKeyId(currentKeyId, 2) },
        { finalized_ticket: tokenForKeyId(oldKeyId, 3), ticket_key_id: oldKeyId }
    ];
    const archived = [
        { finalized_ticket: tokenForKeyId(oldKeyId, 4), consumed_at: '2026-01-01T00:00:00Z' },
        { finalized_ticket: tokenForKeyId(currentKeyId, 5), consumed_at: '2026-01-02T00:00:00Z' }
    ];
    const persisted = [];
    const store = new TicketStore();
    store.ensureDbReady = async () => {};
    store.readFromDatabase = async () => ({
        active,
        archived,
        invalidatedKeyIds: []
    });
    store.persistTickets = async (nextActive, nextArchive, options) => {
        persisted.push({ active: nextActive, archive: nextArchive, options });
    };

    await assert.rejects(
        store.consumeTickets(1, async () => {
            const error = new Error('rotated');
            error.code = 'TICKET_KEY_INVALIDATED';
            error.invalidatedKeyId = oldKeyId;
            throw error;
        }),
        error => {
            assert.equal(error.invalidatedTicketsRemoved, 3);
            assert.equal(error.remainingTickets, 1);
            return true;
        }
    );

    assert.equal(persisted.length, 1);
    assert.equal(persisted[0].active.length, 1);
    assert.equal(persisted[0].active[0].ticket_key_id, undefined);
    assert.equal(persisted[0].archive.length, 1);
    assert.equal(persisted[0].archive[0].finalized_ticket, archived[1].finalized_ticket);
    assert.deepEqual(persisted[0].options.invalidatedKeyIds, [oldKeyId]);
});

test('consumeTickets never selects a stale synced ticket blocked by a tombstone', async () => {
    const invalidatedKeyId = '33'.repeat(32);
    const currentKeyId = '44'.repeat(32);
    const staleTicket = {
        finalized_ticket: tokenForKeyId(invalidatedKeyId, 1)
    };
    const currentTicket = {
        finalized_ticket: tokenForKeyId(currentKeyId, 2)
    };
    const store = new TicketStore();
    store.ensureDbReady = async () => {};
    store.readFromDatabase = async () => ({
        active: [staleTicket, currentTicket],
        archived: [],
        invalidatedKeyIds: [invalidatedKeyId]
    });
    store.persistTickets = async () => true;

    const consumed = await store.consumeTickets(1, async ({ tickets }) => {
        assert.deepEqual(tickets, [currentTicket]);
        return { ok: true };
    });

    assert.deepEqual(consumed.tickets, [currentTicket]);
});

test('per-generation sync tombstone reloads the in-memory ticket cache', async () => {
    const store = new TicketStore();
    const loadCalls = [];
    store.ensureDbReady = async () => {};
    store.migrateFromLocalStorage = async () => {};
    store.cleanLegacyTickets = async () => {};
    store.loadFromDatabase = async options => {
        loadCalls.push(options);
    };
    store.emitUpdate = () => {};

    try {
        await store.init();
        assert.equal(loadCalls.length, 1);

        syncService.notify('blob_received', {
            type: 'ticket-invalidation',
            logicalId: 'ticket-invalidation-item'
        });
        await Promise.resolve();

        assert.equal(loadCalls.length, 2);
        assert.deepEqual(loadCalls[1], {
            emitUpdate: true,
            skipBroadcast: true
        });
    } finally {
        store.storageUnsubscribe?.();
        store.syncUnsubscribe?.();
    }
});
