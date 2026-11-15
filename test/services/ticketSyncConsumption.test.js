import test from 'node:test';
import assert from 'node:assert/strict';
import { chatDB } from '../../chat/db.js';
import sessionService from '../../chat/services/sessionService.js';
import { SyncService } from '../../chat/services/encryptedSyncService.js';
import { createTicketTombstones } from '../../chat/services/ticketTombstones.js';

// Synthetic tickets only. The server harness deliberately implements LWW:
// both clients read the old state before either uploads its distinct spend.
const first = { finalized_ticket: 'synthetic-web-ticket' };
const second = { finalized_ticket: 'synthetic-phone-ticket' };
const unspent = { finalized_ticket: 'synthetic-unspent-ticket' };
const masterKey = new Uint8Array(32).fill(42);

async function withDevices(run) {
    let settings = new Map();
    const originals = {
        getSetting: chatDB.getSetting,
        saveSetting: chatDB.saveSetting,
        saveSettings: chatDB.saveSettings
    };
    chatDB.getSetting = async key => structuredClone(settings.get(key));
    chatDB.saveSetting = async (key, value) => settings.set(key, structuredClone(value));
    chatDB.saveSettings = async entries => {
        for (const { key, value } of entries) await chatDB.saveSetting(key, value);
    };
    try {
        await run(value => { settings = value; });
    } finally {
        Object.assign(chatDB, originals);
    }
}

for (const transfer of [false, true]) {
    test(`concurrent ${transfer ? 'transfers' : 'spends'} survive LWW and stale active replay`, async () => {
        await withDevices(async select => {
            const server = new Map();
            const devices = [];
            for (const [used, other] of [[first, second], [second, first]]) {
                const settings = new Map([
                    ['tickets-active', [other, unspent]],
                    ['tickets-archive', transfer ? [] : [{ ...used, consumed_at: '2026-10-13T00:00:00Z' }]],
                    ['tickets-tombstones', transfer ? await createTicketTombstones([used]) : []]
                ]);
                select(settings);
                const service = new SyncService();
                const blobs = await service._collectLocalBlobs(masterKey);
                for (const blob of blobs) {
                    assert.deepEqual(Object.keys(blob).sort(), ['ciphertext', 'id', 'iv', 'version']);
                    assert.equal(JSON.stringify(blob).includes(used.finalized_ticket), false);
                    server.set(blob.id, blob);
                }
                // Reload must retain this device's record address.
                assert.deepEqual(
                    (await new SyncService()._collectLocalBlobs(masterKey)).map(blob => blob.id),
                    blobs.map(blob => blob.id)
                );
                devices.push(settings);
            }

            // A clean third device has no local evidence of either spend.
            // Exercise both orders: active before and after removal records.
            for (const reverse of [false, true]) {
                const fresh = new Map();
                select(fresh);
                const service = new SyncService();
                await service._buildIdMapping(masterKey);
                const blobs = [...server.values()];
                if (reverse) blobs.reverse();
                for (const blob of blobs) await service._applyServerBlob(masterKey, blob);
                await service._mergeTickets('tickets-active', [first, second, unspent]);
                assert.deepEqual(fresh.get('tickets-active'), [unspent]);
                if (!transfer) assert.equal(fresh.get('tickets-archive').length, 2);
                else assert.equal(fresh.get('tickets-tombstones').length, 2);
            }
            assert.notEqual(devices[0].get('sync-wallet-writer-id'), devices[1].get('sync-wallet-writer-id'));

            // Both original devices converge too, even after one goes offline.
            for (const settings of devices) {
                select(settings);
                const service = new SyncService();
                await service._buildIdMapping(masterKey);
                for (const blob of server.values()) await service._applyServerBlob(masterKey, blob);
                assert.deepEqual(settings.get('tickets-active'), [unspent]);
            }
        });
    });
}

test('removal records authenticate their opaque ID and notify hydrated wallet listeners', async () => {
    await withDevices(async select => {
        select(new Map([
            ['tickets-active', [unspent]],
            ['tickets-archive', [first]]
        ]));
        const service = new SyncService();
        await service._buildIdMapping(masterKey);
        const blobs = await service._collectLocalBlobs(masterKey);
        const record = blobs.find(blob => !service.idMapping.has(blob.id));
        assert.ok(record);
        const recipient = new Map([['tickets-active', [first, unspent]]]);
        select(recipient);
        let notified = false;
        service.subscribe(async ({ event, data }) => {
            if (event === 'blob_received' && data.type === 'ticket-removals') {
                await Promise.resolve();
                assert.deepEqual(recipient.get('tickets-active'), [unspent]);
                notified = true;
            }
        });
        assert.equal(await service._applyServerBlob(masterKey, { ...record, id: '0'.repeat(32) }), false);
        assert.deepEqual(recipient.get('tickets-active'), [first, unspent]);
        assert.equal(await service._applyServerBlob(masterKey, record), true);
        assert.equal(notified, true);
        assert.ok(service.getAccountScopedSettingKeys().includes('sync-wallet-writer-id'));
    });
});

test('fixed periodic sync uploads deferred spends without needing a server change', async () => {
    const originals = {
        setInterval: globalThis.setInterval,
        clearInterval: globalThis.clearInterval,
        document: globalThis.document
    };
    const timers = new Map();
    let visibilityHandler;
    globalThis.setInterval = (callback, delay) => {
        const id = timers.size + 1;
        timers.set(id, { callback, delay });
        return id;
    };
    globalThis.clearInterval = id => timers.delete(id);
    globalThis.document = {
        visibilityState: 'visible',
        addEventListener: (name, handler) => { visibilityHandler = handler; },
        removeEventListener: () => { visibilityHandler = null; }
    };
    const service = new SyncService();
    service.identityBacked = true;
    let enabled = true;
    let uploads = 0;
    service.isEnabled = () => enabled;
    service.hasRemoteChanges = async () => false;
    service.sync = async () => { uploads++; return { success: true }; };
    try {
        service.startPeriodicSync();
        assert.equal(service.shouldDeferRedemptionSync(), true);
        assert.equal(uploads, 1, 'start reconciles pending local changes');
        const periodic = [...timers.values()].find(timer => timer.delay === 30_000);
        assert.ok(periodic, 'full sync runs at a fixed 30-second cadence');
        await periodic.callback();
        assert.equal(uploads, 2, 'unchanged server must not suppress deferred upload');
        document.visibilityState = 'hidden';
        await periodic.callback();
        visibilityHandler();
        assert.equal(uploads, 2);
        document.visibilityState = 'visible';
        visibilityHandler();
        assert.equal(uploads, 3, 'resume uploads pending changes as well as pulling');
        enabled = false;
        await periodic.callback();
        assert.equal(uploads, 3);
        service.stopPeriodicSync();
        assert.equal(timers.size, 0);
        assert.equal(visibilityHandler, null);
    } finally {
        service.stopPeriodicSync();
        Object.assign(globalThis, originals);
    }
});


test('a stalled background response body releases the wallet lock without retrying', { timeout: 10_000 }, async () => {
    await withDevices(async select => {
        select(new Map([
            ['sync-account-scope', 'synthetic-account'],
            ['account-settings', { accountId: 'synthetic-account' }]
        ]));
        const service = new SyncService();
        service.setCredentials(masterKey, 'synthetic-account', { identityBacked: true });
        const originalFetch = sessionService.fetch;
        const originalError = console.error;
        let started;
        const fetched = new Promise(resolve => { started = resolve; });
        let attempts = 0;
        sessionService.fetch = async () => {
            attempts++;
            started();
            return new Response(new ReadableStream({
                start(controller) { controller.enqueue(new TextEncoder().encode('{')); },
            }), { headers: { 'Content-Type': 'application/json' } });
        };
        console.error = () => {};
        try {
            const sync = service.sync({ background: true });
            await fetched;
            let walletActionRan = false;
            const action = service.withSyncLock(() => { walletActionRan = true; });
            await Promise.resolve();
            assert.equal(walletActionRan, false);
            const result = await sync;
            await action;
            assert.equal(result.success, false);
            assert.match(result.error, /timed out/);
            assert.equal(attempts, 1);
            assert.equal(service.syncInProgress, false);
            assert.equal(walletActionRan, true);
        } finally {
            sessionService.fetch = originalFetch;
            console.error = originalError;
            service.clearCredentials();
        }
    });
});
