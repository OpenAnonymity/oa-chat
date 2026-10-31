import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createCipheriv, createHmac, hkdfSync, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import syncService, { activeLeaseFingerprints, SyncService } from '../../chat/services/encryptedSyncService.js';
import { TicketStore } from '../../chat/services/ticketStore.js';
import { chatDB } from '../../chat/db.js';

const fingerprint = token => createHash('sha256').update(token).digest('hex');
const ticket = token => ({ finalized_ticket: token });

function storeWith(active, leases, archived = []) {
    const persisted = [];
    const store = new TicketStore();
    store.withLock = async handler => handler();
    store.ensureDbReady = async () => {};
    store.readFromDatabase = async () => ({ active, archived, invalidatedKeyIds: [], leases });
    store.persistTickets = async (nextActive, nextArchive, options) => {
        persisted.push({ active: nextActive, archive: nextArchive, options });
    };
    return { store, persisted };
}

function withSettings(values, run) {
    const original = chatDB.getSetting;
    const originalSave = chatDB.saveSettings;
    const saved = [];
    chatDB.getSetting = async key => values[key];
    chatDB.saveSettings = async entries => {
        entries.forEach(entry => { values[entry.key] = entry.value; });
        saved.push(entries);
    };
    return Promise.resolve(run(saved)).finally(() => {
        chatDB.getSetting = original;
        chatDB.saveSettings = originalSave;
    });
}

test('an expired lease holds nothing and malformed values are ignored', () => {
    const now = 1000;
    const held = activeLeaseFingerprints({
        live: { fingerprints: ['a'], expires_at_ms: 2000 },
        expired: { fingerprints: ['b'], expires_at_ms: 500 },
        broken: { fingerprints: 'nope', expires_at_ms: 2000 }
    }, now);
    assert.deepEqual([...held], ['a']);
    assert.equal(activeLeaseFingerprints(null, now).size, 0);
    assert.equal(activeLeaseFingerprints(['x'], now).size, 0);
});

test('spending skips tickets a daemon holds and keeps wallet order', async () => {
    const leases = { daemon: { fingerprints: [fingerprint('a')], expires_at_ms: Date.now() + 60000 } };
    const { store, persisted } = storeWith([ticket('a'), ticket('b'), ticket('c')], leases);
    const { tickets } = await store.consumeTickets(1, async () => ({}));
    assert.equal(tickets[0].finalized_ticket, 'b');
    assert.deepEqual(persisted[0].active.map(t => t.finalized_ticket), ['a', 'c']);
    assert.deepEqual(persisted[0].archive.map(t => t.finalized_ticket), ['b']);
});

test('a lease never starves this browser: leased tickets fill a selection last', async () => {
    const leases = { daemon: { fingerprints: ['a', 'b'].map(fingerprint), expires_at_ms: Date.now() + 60000 } };
    const { store, persisted } = storeWith([ticket('a'), ticket('b'), ticket('c')], leases);
    const { tickets } = await store.consumeTickets(2, async () => ({}));
    assert.deepEqual(tickets.map(t => t.finalized_ticket), ['c', 'a']);
    assert.deepEqual(persisted[0].active.map(t => t.finalized_ticket), ['b']);

    const all = storeWith([ticket('a'), ticket('b')], leases);
    const tail = await all.store.consumeTickets(1, async () => ({}), { order: 'tail' });
    assert.equal(tail.tickets[0].finalized_ticket, 'b');
});

test('only a real shortage is a shortage, whatever is leased', async () => {
    const leases = { daemon: { fingerprints: ['a', 'b'].map(fingerprint), expires_at_ms: Date.now() + 60000 } };
    const { store, persisted } = storeWith([ticket('a'), ticket('b')], leases);
    await assert.rejects(
        store.consumeTickets(3, async () => assert.fail('must not redeem')),
        error => error.code === 'INSUFFICIENT_TICKETS' && error.availableTickets === 2 && error.heldTickets === 0
    );
    assert.equal(persisted.length, 0);
});

test('a ticket the org says another request holds is kept and tried last', async () => {
    const { store, persisted } = storeWith([ticket('a'), ticket('b')], null);
    await assert.rejects(store.consumeTickets(1, async () => {
        throw Object.assign(new Error('held'), { code: 'TICKET_REQUEST_IN_PROGRESS', failedIndex: 0 });
    }), { code: 'TICKET_REQUEST_IN_PROGRESS' });
    assert.equal(persisted.length, 0, 'nothing is archived or removed');
    const { tickets } = await store.consumeTickets(1, async () => ({}));
    assert.equal(tickets[0].finalized_ticket, 'b');
    assert.deepEqual(persisted[0].active.map(t => t.finalized_ticket), ['a']);

    store.contendedUntil.set('a', Date.now() - 1);
    const again = storeWith([ticket('a'), ticket('c')], null);
    again.store.contendedUntil = store.contendedUntil;
    assert.equal((await again.store.consumeTickets(1, async () => ({}))).tickets[0].finalized_ticket, 'a', 'set aside only for a while');
});

test('an expired lease returns its tickets to the browser', async () => {
    const leases = { daemon: { fingerprints: [fingerprint('a')], expires_at_ms: Date.now() - 1 } };
    const { store } = storeWith([ticket('a')], leases);
    const { tickets } = await store.consumeTickets(1, async () => ({}));
    assert.equal(tickets[0].finalized_ticket, 'a');
});

test('no lease leaves head and tail selection exactly as before', async () => {
    const head = storeWith([ticket('a'), ticket('b'), ticket('c')]);
    assert.equal((await head.store.consumeTickets(1, async () => ({}))).tickets[0].finalized_ticket, 'a');
    const tail = storeWith([ticket('a'), ticket('b'), ticket('c')]);
    const result = await tail.store.consumeTickets(1, async () => ({}), { order: 'tail' });
    assert.equal(result.tickets[0].finalized_ticket, 'c');
    assert.deepEqual(tail.persisted[0].active.map(t => t.finalized_ticket), ['a', 'b']);
});

// A daemon's record, sealed the way oa-clientd seals it (see the Go vector test).
function sealLease(master, deviceId, body, idOverride = null) {
    const key = Buffer.from(hkdfSync('sha256', master, 'oa-sync-v1', 'ticket-lease-item', 32));
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(body)), cipher.final(), cipher.getAuthTag()]);
    const id = createHmac('sha256', master).update(`oa-sync-id-v1:ticket-lease-item:${deviceId}`).digest().subarray(0, 16).toString('hex');
    return { id: idOverride || id, ciphertext: ciphertext.toString('base64'), iv: iv.toString('base64'), version: 1 };
}

test('a synced lease is stored for spending and never treated as wallet data', () => {
    const master = randomBytes(32);
    const deviceId = 'a'.repeat(32);
    const values = {};
    return withSettings(values, async () => {
        const service = new SyncService();
        const blob = sealLease(master, deviceId, { type: 'ticket-lease', device_id: deviceId, fingerprints: ['b'.repeat(64), 'not-hex'], expires_at_ms: 123 });
        assert.equal(await service._applyServerBlob(new Uint8Array(master), blob, 0, new Map()), false);
        assert.deepEqual(values['tickets-leases'][deviceId], { fingerprints: ['b'.repeat(64)], expires_at_ms: 123 });
        assert.equal(values['tickets-active'], undefined);
    });
});

test('a lease whose opaque ID does not match its device is refused', () => {
    const master = randomBytes(32);
    const values = {};
    return withSettings(values, async () => {
        const service = new SyncService();
        const blob = sealLease(master, 'a'.repeat(32), { type: 'ticket-lease', device_id: 'a'.repeat(32), fingerprints: [], expires_at_ms: 1 }, 'f'.repeat(32));
        assert.equal(await service._applyServerBlob(new Uint8Array(master), blob, 0, new Map()), false);
        assert.equal(values['tickets-leases'], undefined);
    });
});

test('an unknown record still falls through to the invalidation probe', () => {
    const master = randomBytes(32);
    return withSettings({}, async () => {
        const service = new SyncService();
        const iv = randomBytes(12);
        const blob = { id: 'e'.repeat(32), ciphertext: randomBytes(48).toString('base64'), iv: iv.toString('base64'), version: 1 };
        assert.equal(await service._applyServerBlob(new Uint8Array(master), blob, 0, new Map()), false);
    });
});

test('leases are account-scoped local data', () => {
    assert.ok(syncService.getAccountScopedSettingKeys().includes('tickets-leases'));
});

test('applying a lease drops other devices whose leases expired', () => {
    const master = randomBytes(32);
    const device = 'a'.repeat(32);
    const live = 'c'.repeat(32);
    const values = { 'tickets-leases': {
        ['b'.repeat(32)]: { fingerprints: [], expires_at_ms: Date.now() - 1 },
        [live]: { fingerprints: [], expires_at_ms: Date.now() + 60000 }
    } };
    return withSettings(values, async () => {
        const service = new SyncService();
        const blob = sealLease(master, device, { type: 'ticket-lease', device_id: device, fingerprints: [], expires_at_ms: Date.now() + 60000 });
        assert.equal(await service._applyServerBlob(new Uint8Array(master), blob, 0, new Map()), false);
        assert.deepEqual(Object.keys(values['tickets-leases']).sort(), [device, live]);
    });
});

// Sealed by the Go daemon's own account.Seal (zkapi-clientd/internal/oa/account).
const goBlobs = JSON.parse(readFileSync(path.join(process.cwd(), 'test/fixtures/daemon-wallet-blobs-v1.json'), 'utf8'));
const goMaster = () => new Uint8Array(32).fill(0x42);

test('a lease sealed by the Go daemon is read here and holds its ticket', () => {
    const values = {};
    return withSettings(values, async () => {
        const service = new SyncService();
        assert.equal(await service._applyServerBlob(goMaster(), goBlobs.lease, 0, new Map()), false);
        assert.deepEqual(values['tickets-leases'][goBlobs.device_id].fingerprints, [goBlobs.fingerprint]);
        assert.equal(goBlobs.fingerprint, fingerprint('test'));
        const { store } = storeWith([ticket('test'), ticket('other')], values['tickets-leases']);
        assert.equal((await store.consumeTickets(1, async () => ({}))).tickets[0].finalized_ticket, 'other');
    });
});

test('a removal record sealed by the Go daemon merges like a browser writer\'s', () => {
    return withSettings({}, async () => {
        const service = new SyncService();
        const merged = [];
        service._mergeTickets = async (logicalId, data) => { merged.push([logicalId, data]); };
        service.notifyAndWait = async () => {};
        assert.equal(await service._applyServerBlob(goMaster(), goBlobs.removals, 0, new Map()), true);
        assert.deepEqual(merged.map(([logicalId]) => logicalId), ['tickets-tombstones', 'tickets-archive']);
        assert.equal(merged[1][1][0].finalized_ticket, 'test');
    });
});
