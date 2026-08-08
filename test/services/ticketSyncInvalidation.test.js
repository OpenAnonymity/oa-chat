import test from 'node:test';
import assert from 'node:assert/strict';

import { chatDB } from '../../chat/db.js';
import { SyncService } from '../../chat/services/encryptedSyncService.js';
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

test('sync tombstones remove and prevent resurrection of invalidated generations', async () => {
    const invalidatedKeyId = '77'.repeat(32);
    const currentKeyId = '88'.repeat(32);
    const oldActive = { finalized_ticket: tokenForKeyId(invalidatedKeyId, 1) };
    const oldArchived = {
        finalized_ticket: tokenForKeyId(invalidatedKeyId, 2),
        consumed_at: '2026-01-01T00:00:00Z'
    };
    const currentActive = { finalized_ticket: tokenForKeyId(currentKeyId, 3) };
    const currentArchived = {
        finalized_ticket: tokenForKeyId(currentKeyId, 4),
        consumed_at: '2026-01-02T00:00:00Z'
    };
    const settings = new Map([
        ['tickets-active', [oldActive, currentActive]],
        ['tickets-archive', [oldArchived, currentArchived]],
        ['tickets-invalidated-key-ids', []]
    ]);
    const originalGetSetting = chatDB.getSetting;
    const originalSaveSetting = chatDB.saveSetting;
    const originalSaveSettings = chatDB.saveSettings;
    chatDB.getSetting = async key => settings.get(key);
    chatDB.saveSetting = async (key, value) => settings.set(key, value);
    chatDB.saveSettings = async entries => {
        entries.forEach(({ key, value }) => settings.set(key, value));
    };

    try {
        const service = new SyncService();
        await service._mergeTicketInvalidations([invalidatedKeyId]);

        assert.deepEqual(
            settings.get('tickets-invalidated-key-ids'),
            [invalidatedKeyId]
        );
        assert.deepEqual(settings.get('tickets-active'), [currentActive]);
        assert.deepEqual(settings.get('tickets-archive'), [currentArchived]);

        await service._mergeTickets('tickets-active', [oldActive]);
        await service._mergeTickets('tickets-archive', [oldArchived]);

        assert.deepEqual(settings.get('tickets-active'), [currentActive]);
        assert.deepEqual(settings.get('tickets-archive'), [currentArchived]);
    } finally {
        chatDB.getSetting = originalGetSetting;
        chatDB.saveSetting = originalSaveSetting;
        chatDB.saveSettings = originalSaveSettings;
    }
});

test('concurrent devices retain distinct per-generation invalidations', async () => {
    const firstInvalidatedKeyId = '91'.repeat(32);
    const secondInvalidatedKeyId = '92'.repeat(32);
    const currentKeyId = '93'.repeat(32);
    const firstOldTicket = {
        finalized_ticket: tokenForKeyId(firstInvalidatedKeyId, 1)
    };
    const secondOldTicket = {
        finalized_ticket: tokenForKeyId(secondInvalidatedKeyId, 2)
    };
    const currentTicket = {
        finalized_ticket: tokenForKeyId(currentKeyId, 3)
    };
    const masterKey = Uint8Array.from(
        { length: 32 },
        (_, index) => index + 1
    );
    const originalGetSetting = chatDB.getSetting;
    const originalSaveSetting = chatDB.saveSetting;
    const originalSaveSettings = chatDB.saveSettings;
    let activeSettings = null;
    chatDB.getSetting = async key => activeSettings.get(key);
    chatDB.saveSetting = async (key, value) => activeSettings.set(key, value);
    chatDB.saveSettings = async entries => {
        entries.forEach(({ key, value }) => activeSettings.set(key, value));
    };

    try {
        const firstDeviceSettings = new Map([
            ['tickets-active', [secondOldTicket, currentTicket]],
            ['tickets-archive', []],
            ['tickets-invalidated-key-ids', [firstInvalidatedKeyId]]
        ]);
        activeSettings = firstDeviceSettings;
        const firstDeviceBlobs = await new SyncService()
            ._collectLocalBlobs(masterKey);

        const secondDeviceSettings = new Map([
            ['tickets-active', [firstOldTicket, currentTicket]],
            ['tickets-archive', []],
            ['tickets-invalidated-key-ids', [secondInvalidatedKeyId]]
        ]);
        activeSettings = secondDeviceSettings;
        const secondDeviceBlobs = await new SyncService()
            ._collectLocalBlobs(masterKey);

        // Model the org's LWW upsert. Fixed aggregate/active records from the
        // second device overwrite the first, but generation-item IDs differ.
        const serverBlobs = new Map();
        [...firstDeviceBlobs, ...secondDeviceBlobs].forEach(blob => {
            serverBlobs.set(blob.id, blob);
        });

        const freshSettings = new Map([
            ['tickets-active', []],
            ['tickets-archive', []],
            ['tickets-invalidated-key-ids', []]
        ]);
        activeSettings = freshSettings;
        const freshDevice = new SyncService();
        await freshDevice._buildIdMapping(masterKey);
        const activeBlobId = Array.from(freshDevice.idMapping.entries())
            .find(([, logicalId]) => logicalId === 'tickets-active')[0];
        const orderedBlobs = Array.from(serverBlobs.values()).sort(
            left => left.id === activeBlobId ? 1 : -1
        );

        for (const blob of orderedBlobs) {
            await freshDevice._applyServerBlob(masterKey, blob);
        }

        assert.deepEqual(
            new Set(freshSettings.get('tickets-invalidated-key-ids')),
            new Set([firstInvalidatedKeyId, secondInvalidatedKeyId])
        );
        assert.deepEqual(
            freshSettings.get('tickets-active'),
            [currentTicket]
        );
    } finally {
        chatDB.getSetting = originalGetSetting;
        chatDB.saveSetting = originalSaveSetting;
        chatDB.saveSettings = originalSaveSettings;
    }
});

test('sync push chunks append-only invalidation records to server limits', async () => {
    const service = new SyncService();
    const blobs = Array.from({ length: 205 }, (_, index) => ({
        id: `blob-${index}`,
        ciphertext: 'ciphertext',
        iv: 'iv',
        version: 1
    }));
    const batchSizes = [];
    service._collectLocalBlobs = async () => blobs;
    service.fetchWithRetry = async (url, options) => {
        assert.match(url, /\/auth\/sync$/);
        const batch = JSON.parse(options.body).blobs;
        batchSizes.push(batch.length);
        return {
            ok: true,
            status: 200,
            json: async () => ({
                accepted: batch.map(blob => blob.id)
            })
        };
    };

    const result = await service._push(new Uint8Array(32), 'access-token');

    assert.deepEqual(batchSizes, [100, 100, 5]);
    assert.equal(result.count, 205);
});

test('local and remote invalidations share one ticket storage lock', async () => {
    const localKeyId = 'a1'.repeat(32);
    const remoteKeyId = 'a2'.repeat(32);
    const localTicket = {
        finalized_ticket: tokenForKeyId(localKeyId, 1)
    };
    const remoteTicket = {
        finalized_ticket: tokenForKeyId(remoteKeyId, 2)
    };
    const settings = new Map([
        ['tickets-active', [localTicket, remoteTicket]],
        ['tickets-archive', []],
        ['tickets-invalidated-key-ids', []]
    ]);
    const originalGetSetting = chatDB.getSetting;
    const originalSaveSetting = chatDB.saveSetting;
    const originalSaveSettings = chatDB.saveSettings;
    chatDB.getSetting = async key => settings.get(key);
    chatDB.saveSetting = async (key, value) => settings.set(key, value);
    chatDB.saveSettings = async entries => {
        entries.forEach(({ key, value }) => settings.set(key, value));
    };
    let releaseLocal;
    const localGate = new Promise(resolve => {
        releaseLocal = resolve;
    });
    let localEntered;
    const entered = new Promise(resolve => {
        localEntered = resolve;
    });

    try {
        const store = new TicketStore();
        const localMerge = store.withLock(async () => {
            const existingKeyIds = settings.get(
                'tickets-invalidated-key-ids'
            );
            localEntered();
            await localGate;
            settings.set(
                'tickets-invalidated-key-ids',
                [...existingKeyIds, localKeyId]
            );
            settings.set('tickets-active', [remoteTicket]);
        });
        await entered;

        let remoteSettled = false;
        const remoteService = new SyncService();
        const remoteMerge = remoteService
            .withSyncLock(() => remoteService._mergeTicketInvalidations([remoteKeyId]))
            .then(() => {
                remoteSettled = true;
            });
        await Promise.resolve();
        assert.equal(remoteSettled, false);

        releaseLocal();
        await Promise.all([localMerge, remoteMerge]);

        assert.deepEqual(
            new Set(settings.get('tickets-invalidated-key-ids')),
            new Set([localKeyId, remoteKeyId])
        );
        assert.deepEqual(settings.get('tickets-active'), []);
    } finally {
        chatDB.getSetting = originalGetSetting;
        chatDB.saveSetting = originalSaveSetting;
        chatDB.saveSettings = originalSaveSettings;
    }
});

test('sync schema upgrade performs one full pull for dynamic tombstones', async () => {
    const settings = new Map([
        ['sync-lastSyncTime', 900]
    ]);
    const requestedUrls = [];
    const originalGetSetting = chatDB.getSetting;
    const originalSaveSetting = chatDB.saveSetting;
    const originalSaveSettings = chatDB.saveSettings;
    chatDB.getSetting = async key => settings.get(key);
    chatDB.saveSetting = async (key, value) => settings.set(key, value);
    chatDB.saveSettings = async entries => {
        entries.forEach(({ key, value }) => settings.set(key, value));
    };

    try {
        const service = new SyncService();
        service.fetchWithRetry = async url => {
            requestedUrls.push(url);
            return {
                ok: true,
                status: 200,
                json: async () => ({
                    blobs: [],
                    server_time: 1000
                })
            };
        };

        await service._pull(new Uint8Array(32), 'access-token');
        await service._pull(new Uint8Array(32), 'access-token');

        assert.match(requestedUrls[0], /\?since=0$/);
        assert.match(requestedUrls[1], /\?since=1000$/);
        assert.equal(settings.get('sync-schema-version'), 2);
        assert.equal(settings.get('sync-lastSyncTime'), 1000);
    } finally {
        chatDB.getSetting = originalGetSetting;
        chatDB.saveSetting = originalSaveSetting;
        chatDB.saveSettings = originalSaveSettings;
    }
});
