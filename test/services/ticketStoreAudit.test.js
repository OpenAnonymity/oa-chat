import test from 'node:test';
import assert from 'node:assert/strict';
import ticketStore from '../../chat/services/ticketStore.js';

test('local wallet audit reports structure without exposing ticket values', () => {
    const originalTickets = ticketStore.tickets;
    const originalArchive = ticketStore.archive;
    const secretValues = [
        'secret-blinded-request',
        'secret-signed-response',
        'secret-finalized-ticket'
    ];

    ticketStore.tickets = [{
        blinded_request: secretValues[0],
        signed_response: secretValues[1],
        finalized_ticket: secretValues[2],
        created_at: '2026-07-30T00:00:00.000Z'
    }];
    ticketStore.archive = [{
        blinded_request: 'archived-blinded',
        signed_response: 'archived-signed',
        finalized_ticket: 'archived-finalized',
        created_at: '2026-07-30T00:00:00.000Z',
        consumed_at: '2026-07-30T00:01:00.000Z'
    }];

    try {
        const audit = ticketStore.getRedactedAuditSummary();
        const serialized = JSON.stringify(audit);

        assert.equal(audit.active.count, 1);
        assert.equal(audit.archived.count, 1);
        assert.equal(audit.active.allHaveCoreFields, true);
        assert.equal(audit.archived.allHaveCoreFields, true);
        assert.equal(audit.archivedAllHaveConsumedAt, true);
        secretValues.forEach(value => assert.equal(serialized.includes(value), false));
    } finally {
        ticketStore.tickets = originalTickets;
        ticketStore.archive = originalArchive;
    }
});

test('durable ticket import requires an IndexedDB round-trip for every ticket', async () => {
    const originals = {
        ensureDbReady: ticketStore.ensureDbReady,
        readFromDatabase: ticketStore.readFromDatabase,
        persistTickets: ticketStore.persistTickets,
        withLock: ticketStore.withLock,
        tickets: ticketStore.tickets,
        archive: ticketStore.archive
    };
    const ticket = {
        blinded_request: 'blind',
        signed_response: 'signed',
        finalized_ticket: 'finalized',
        created_at: '2026-07-30T00:00:00.000Z'
    };
    let reads = 0;
    ticketStore.withLock = async callback => callback();
    ticketStore.ensureDbReady = async () => {};
    ticketStore.readFromDatabase = async options => {
        assert.equal(options.requireDurable, true);
        reads += 1;
        return { active: [], archived: [] };
    };
    ticketStore.persistTickets = async (_active, _archived, options) => {
        assert.equal(options.requireDurable, true);
        return true;
    };

    try {
        await assert.rejects(
            () => ticketStore.addTickets([ticket], { requireDurable: true }),
            /did not round-trip every prepared ticket/
        );
        assert.equal(reads, 2);
    } finally {
        Object.assign(ticketStore, originals);
    }
});

test('ticket import preserves archive precedence and never resurrects a spent ticket', async () => {
    const originals = {
        ensureDbReady: ticketStore.ensureDbReady,
        readFromDatabase: ticketStore.readFromDatabase,
        persistTickets: ticketStore.persistTickets,
        withLock: ticketStore.withLock,
        tickets: ticketStore.tickets,
        archive: ticketStore.archive
    };
    const spent = {
        blinded_request: 'blind',
        signed_response: 'signed',
        finalized_ticket: 'spent-finalized',
        created_at: '2026-07-30T00:00:00.000Z',
        consumed_at: '2026-07-30T00:01:00.000Z'
    };
    let persistedActive = null;
    ticketStore.withLock = async callback => callback();
    ticketStore.ensureDbReady = async () => {};
    ticketStore.readFromDatabase = async () => ({ active: [], archived: [spent] });
    ticketStore.persistTickets = async (active, archive) => {
        persistedActive = active;
        assert.equal(archive.length, 1);
        return true;
    };

    try {
        const activeCount = await ticketStore.addTickets([{ ...spent, consumed_at: undefined }]);
        assert.equal(activeCount, 0);
        assert.deepEqual(persistedActive, []);
    } finally {
        Object.assign(ticketStore, originals);
    }
});
