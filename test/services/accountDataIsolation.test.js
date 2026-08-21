import assert from 'node:assert/strict';
import test from 'node:test';

import { chatDB } from '../../chat/db.js';
import syncService from '../../chat/services/encryptedSyncService.js';
import storageEvents from '../../chat/services/storageEvents.js';
import ticketStore from '../../chat/services/ticketStore.js';
import preferencesStore, {
    PREF_KEYS
} from '../../chat/services/preferencesStore.js';

function installSettingsMap(initialEntries = []) {
    const originals = {
        db: chatDB.db,
        getSetting: chatDB.getSetting,
        saveSetting: chatDB.saveSetting,
        saveSettings: chatDB.saveSettings,
        updateSettings: chatDB.updateSettings,
        deleteSetting: chatDB.deleteSetting
    };
    const settings = new Map(initialEntries);
    chatDB.db = {};
    chatDB.getSetting = async key => settings.get(key);
    chatDB.saveSetting = async (key, value) => settings.set(key, value);
    chatDB.saveSettings = async entries => {
        entries.forEach(({ key, value }) => settings.set(key, value));
    };
    chatDB.updateSettings = async (entries, deleteKeys) => {
        const next = new Map(settings);
        entries.forEach(({ key, value }) => next.set(key, value));
        deleteKeys.forEach(key => next.delete(key));
        settings.clear();
        next.forEach((value, key) => settings.set(key, value));
    };
    chatDB.deleteSetting = async key => settings.delete(key);
    return {
        settings,
        restore() {
            Object.assign(chatDB, originals);
            syncService.clearCredentials();
            syncService.setLocalAccountScope(null);
            syncService.syncInProgress = false;
            ticketStore.tickets = [];
            ticketStore.archive = [];
        }
    };
}

test('failed scope transaction leaves the previous marker and wallet intact', async () => {
    const accountATickets = [{ finalized_ticket: 'account-a-ticket' }];
    const fixture = installSettingsMap([
        ['sync-account-scope', 'account-a'],
        ['tickets-active', accountATickets]
    ]);
    syncService.setLocalAccountScope('account-a');
    const atomicUpdate = chatDB.updateSettings;
    chatDB.updateSettings = async () => {
        throw new Error('simulated quota failure');
    };

    try {
        await assert.rejects(
            syncService.activateAccountScope('account-b', {
                adoptUnscoped: true
            }),
            /quota failure/
        );
        assert.equal(
            fixture.settings.get('sync-account-scope'),
            'account-a'
        );
        assert.deepEqual(
            fixture.settings.get('tickets-active'),
            accountATickets
        );
        assert.equal(
            fixture.settings.has('sync-account-data:account-a'),
            false
        );

        chatDB.updateSettings = atomicUpdate;
        await syncService.activateAccountScope('account-b', {
            adoptUnscoped: true
        });
        assert.equal(
            fixture.settings.get('sync-account-scope'),
            'account-b'
        );
        assert.equal(fixture.settings.has('tickets-active'), false);
        assert.deepEqual(
            fixture.settings.get('sync-account-data:account-a')[
                'tickets-active'
            ],
            accountATickets
        );
    } finally {
        fixture.restore();
    }
});

test('scope switch waits for ticket consumption and never writes into the next wallet', async () => {
    const fixture = installSettingsMap([
        ['sync-account-scope', 'account-a'],
        ['tickets-active', [
            { finalized_ticket: 'account-a-1' },
            { finalized_ticket: 'account-a-2' }
        ]]
    ]);
    syncService.setLocalAccountScope('account-a');
    ticketStore.hasMarkedTicketHistory = true;

    let releaseHandler;
    const handlerStarted = new Promise(resolve => {
        releaseHandler = resolve;
    });
    let handlerEntered;
    const entered = new Promise(resolve => {
        handlerEntered = resolve;
    });

    try {
        const consume = ticketStore.consumeTickets(1, async () => {
            handlerEntered();
            await handlerStarted;
            return 'redeemed';
        });
        await entered;

        const switchScope = syncService.activateAccountScope('account-b');
        await Promise.resolve();
        assert.equal(
            fixture.settings.get('sync-account-scope'),
            'account-a'
        );

        releaseHandler();
        await consume;
        await switchScope;

        assert.equal(
            fixture.settings.get('sync-account-scope'),
            'account-b'
        );
        assert.equal(fixture.settings.has('tickets-active'), false);
        const accountA = fixture.settings.get(
            'sync-account-data:account-a'
        );
        assert.deepEqual(
            accountA['tickets-active'].map(ticket =>
                ticket.finalized_ticket
            ),
            ['account-a-2']
        );
        assert.deepEqual(
            accountA['tickets-archive'].map(ticket =>
                ticket.finalized_ticket
            ),
            ['account-a-1']
        );
    } finally {
        fixture.restore();
    }
});

test('stale tab cannot consume or reload the active account wallet', async () => {
    const accountBTickets = [{ finalized_ticket: 'account-b-ticket' }];
    const fixture = installSettingsMap([
        ['sync-account-scope', 'account-b'],
        ['tickets-active', accountBTickets]
    ]);
    syncService.setLocalAccountScope('account-a');
    ticketStore.tickets = [{ finalized_ticket: 'stale-account-a-ticket' }];
    let handlerCalled = false;

    try {
        await assert.rejects(
            ticketStore.consumeTickets(1, async () => {
                handlerCalled = true;
            }),
            /scope changed/
        );
        assert.equal(handlerCalled, false);
        assert.deepEqual(
            fixture.settings.get('tickets-active'),
            accountBTickets
        );

        await ticketStore.handleAccountScopeChange(
            { accountId: 'account-a' },
            { external: true }
        );
        assert.deepEqual(ticketStore.tickets, []);
    } finally {
        fixture.restore();
    }
});

test('delayed preference broadcast cannot repopulate a stale tab cache', async () => {
    const fixture = installSettingsMap([
        ['sync-account-scope', 'account-b'],
        [PREF_KEYS.theme, 'light']
    ]);
    syncService.setLocalAccountScope('account-a');
    preferencesStore.cache.set(PREF_KEYS.theme, 'dark');

    try {
        await preferencesStore.handleExternalPreferenceUpdate({
            accountId: 'account-a',
            key: PREF_KEYS.theme,
            value: 'dark'
        });
        assert.equal(
            preferencesStore.cache.get(PREF_KEYS.theme),
            'system'
        );
    } finally {
        fixture.restore();
    }
});

test('stale remote ticket notification cannot clear the next account cache', async () => {
    const fixture = installSettingsMap([
        ['sync-account-scope', 'account-b'],
        ['tickets-active', [{ finalized_ticket: 'account-b-ticket' }]]
    ]);
    syncService.setLocalAccountScope('account-b');
    ticketStore.tickets = [{ finalized_ticket: 'account-b-ticket' }];

    try {
        await ticketStore.handleAccountScopeChange(
            { accountId: 'account-a' },
            { external: true, ignoreMismatched: true }
        );
        assert.deepEqual(ticketStore.tickets, [
            { finalized_ticket: 'account-b-ticket' }
        ]);
    } finally {
        fixture.restore();
    }
});

test('queued stale ticket notification preserves cache after scope changes', async () => {
    const fixture = installSettingsMap([
        ['sync-account-scope', 'account-a'],
        ['tickets-active', [{ finalized_ticket: 'account-a-ticket' }]]
    ]);
    const originalWithLock = ticketStore.withLock;
    syncService.setLocalAccountScope('account-a');
    ticketStore.tickets = [{ finalized_ticket: 'account-a-ticket' }];
    ticketStore.withLock = async handler => {
        syncService.setLocalAccountScope('account-b');
        fixture.settings.set('sync-account-scope', 'account-b');
        fixture.settings.set('tickets-active', [
            { finalized_ticket: 'account-b-ticket' }
        ]);
        ticketStore.tickets = [{ finalized_ticket: 'account-b-ticket' }];
        return handler();
    };

    try {
        await ticketStore.handleAccountScopeChange(
            { accountId: 'account-a' },
            { external: true, ignoreMismatched: true }
        );
        assert.deepEqual(ticketStore.tickets, [
            { finalized_ticket: 'account-b-ticket' }
        ]);
    } finally {
        ticketStore.withLock = originalWithLock;
        fixture.restore();
    }
});

test('identity-backed sync pushes encrypted tickets and restores them on a fresh device', async () => {
    const fixture = installSettingsMap([
        ['sync-account-scope', 'identity-account'],
        ['tickets-active', [
            { finalized_ticket: 'identity-active-ticket' },
            { finalized_ticket: 'identity-spent-ticket' }
        ]],
        ['tickets-archive', [{
            finalized_ticket: 'identity-spent-ticket',
            consumed_at: '2026-07-30T12:00:00.000Z'
        }]]
    ]);
    const key = new Uint8Array(32).fill(7);
    const originalFetchWithRetry = syncService.fetchWithRetry;
    const originalBroadcast = storageEvents.broadcast;
    let remoteBlobs = [];
    let serveRemoteBlobs = false;
    const broadcasts = [];

    syncService.fetchWithRetry = async (_url, options) => {
        if (options.method === 'GET') {
            return {
                ok: true,
                status: 200,
                json: async () => ({
                    blobs: serveRemoteBlobs ? remoteBlobs : [],
                    server_time: serveRemoteBlobs ? 200 : 100
                })
            };
        }

        assert.equal(options.method, 'POST');
        assert.equal(options.headers.Authorization, undefined);
        remoteBlobs = JSON.parse(options.body).blobs;
        return {
            ok: true,
            status: 200,
            json: async () => ({
                accepted: remoteBlobs.map(blob => blob.id)
            })
        };
    };
    storageEvents.broadcast = (...args) => {
        broadcasts.push(args);
    };
    syncService.setCredentials(
        key,
        'identity-account',
        { identityBacked: true }
    );

    try {
        const pushResult = await syncService.sync();
        assert.equal(pushResult.success, true);
        assert.equal(remoteBlobs.length, 2);
        assert.ok(remoteBlobs.every(blob =>
            typeof blob.id === 'string' &&
            typeof blob.ciphertext === 'string' &&
            typeof blob.iv === 'string'
        ));
        assert.doesNotMatch(
            JSON.stringify(remoteBlobs),
            /identity-(?:active|spent)-ticket/
        );

        fixture.settings.delete('tickets-active');
        fixture.settings.delete('tickets-archive');
        fixture.settings.delete('sync-lastSyncTime');
        serveRemoteBlobs = true;

        const pullResult = await syncService.sync();
        assert.equal(pullResult.success, true);
        assert.deepEqual(
            fixture.settings.get('tickets-active'),
            [{ finalized_ticket: 'identity-active-ticket' }]
        );
        assert.deepEqual(
            fixture.settings.get('tickets-archive'),
            [{
                finalized_ticket: 'identity-spent-ticket',
                consumed_at: '2026-07-30T12:00:00.000Z'
            }]
        );
        assert.ok(broadcasts.some(([type, payload]) =>
            type === 'tickets-updated' &&
            payload.accountId === 'identity-account'
        ));
    } finally {
        syncService.fetchWithRetry = originalFetchWithRetry;
        storageEvents.broadcast = originalBroadcast;
        syncService.clearCredentials();
        fixture.restore();
    }
});

test('cash-style ticket removal syncs hash tombstones without retaining secrets', async () => {
    const keep = { finalized_ticket: 'keep-ticket-secret' };
    const exported = { finalized_ticket: 'exported-ticket-secret' };
    const archived = {
        finalized_ticket: 'archived-ticket-secret',
        consumed_at: '2026-07-30T12:00:00.000Z'
    };
    const fixture = installSettingsMap([
        ['sync-account-scope', 'identity-account'],
        ['tickets-active', [keep, exported]],
        ['tickets-archive', [archived]]
    ]);
    const originalTriggerTicketSync = syncService.triggerTicketSync;
    syncService.triggerTicketSync = () => {};
    syncService.setCredentials(
        new Uint8Array(32).fill(12),
        'identity-account',
        { identityBacked: true }
    );

    try {
        await ticketStore.setActiveTickets([keep]);
        assert.deepEqual(fixture.settings.get('tickets-active'), [keep]);
        assert.equal(fixture.settings.get('tickets-tombstones').length, 1);
        assert.doesNotMatch(
            JSON.stringify(fixture.settings.get('tickets-tombstones')),
            /exported-ticket-secret/
        );

        await syncService._mergeTickets(
            'tickets-active',
            [exported],
            syncService.credentialGeneration
        );
        assert.deepEqual(fixture.settings.get('tickets-active'), [keep]);

        await ticketStore.clearAllTickets();
        assert.deepEqual(fixture.settings.get('tickets-active'), []);
        assert.deepEqual(fixture.settings.get('tickets-archive'), []);
        assert.deepEqual(ticketStore.tickets, []);
        assert.deepEqual(ticketStore.archive, []);
        assert.equal(fixture.settings.get('tickets-tombstones').length, 3);
        assert.doesNotMatch(
            JSON.stringify(fixture.settings.get('tickets-tombstones')),
            /(?:keep|exported|archived)-ticket-secret/
        );

        await syncService._mergeTickets(
            'tickets-active',
            [keep, exported],
            syncService.credentialGeneration
        );
        await syncService._mergeTickets(
            'tickets-archive',
            [archived],
            syncService.credentialGeneration
        );
        assert.deepEqual(fixture.settings.get('tickets-active'), []);
        assert.deepEqual(fixture.settings.get('tickets-archive'), []);
    } finally {
        syncService.triggerTicketSync = originalTriggerTicketSync;
        syncService.clearCredentials();
        fixture.restore();
    }
});

test('empty ticket wallets are encrypted so the remote snapshot can be cleared', async () => {
    const fixture = installSettingsMap([
        ['tickets-active', []],
        ['tickets-archive', []]
    ]);
    const key = new Uint8Array(32).fill(8);

    try {
        const blobs = await syncService._collectLocalBlobs(key);
        assert.equal(blobs.length, 2);
        assert.ok(blobs.every(blob =>
            typeof blob.id === 'string' &&
            typeof blob.ciphertext === 'string' &&
            typeof blob.iv === 'string'
        ));
    } finally {
        fixture.restore();
    }
});

test('SSO redemption defers sync while other mutations and legacy redemption sync', async () => {
    const fixture = installSettingsMap([
        ['sync-account-scope', 'identity-account'],
        ['tickets-active', [{ finalized_ticket: 'identity-ticket' }]],
        ['tickets-archive', []]
    ]);
    const originalTriggerTicketSync = syncService.triggerTicketSync;
    let syncTriggerCount = 0;
    syncService.triggerTicketSync = () => {
        syncTriggerCount += 1;
    };
    syncService.setCredentials(
        new Uint8Array(32).fill(10),
        'identity-account',
        { identityBacked: true }
    );
    ticketStore.hasMarkedTicketHistory = true;

    try {
        await ticketStore.consumeTickets(1, async () => 'redeemed');
        assert.equal(syncTriggerCount, 0);
        assert.deepEqual(fixture.settings.get('tickets-active'), []);
        assert.equal(
            fixture.settings.get('tickets-archive')[0].finalized_ticket,
            'identity-ticket'
        );

        await ticketStore.addTickets([
            { finalized_ticket: 'new-identity-ticket' }
        ]);
        assert.equal(syncTriggerCount, 1);

        syncTriggerCount = 0;
        syncService.clearCredentials();
        syncService.setCredentials(
            new Uint8Array(32).fill(11),
            'identity-account'
        );
        await ticketStore.consumeTickets(1, async () => 'redeemed');
        assert.equal(syncTriggerCount, 1);
    } finally {
        syncService.triggerTicketSync = originalTriggerTicketSync;
        syncService.clearCredentials();
        fixture.restore();
    }
});
