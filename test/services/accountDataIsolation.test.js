import assert from 'node:assert/strict';
import test from 'node:test';

import { chatDB } from '../../chat/db.js';
import syncService from '../../chat/services/encryptedSyncService.js';
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

test('identity-backed sync omits tickets and ticket changes schedule no sync', async () => {
    const fixture = installSettingsMap([
        ['tickets-active', [{ finalized_ticket: 'identity-ticket' }]],
        ['tickets-archive', [{ finalized_ticket: 'spent-ticket' }]]
    ]);
    const key = new Uint8Array(32).fill(7);
    syncService.setCredentials(
        key,
        'anonymous-token',
        async () => null,
        'anonymous-account'
    );
    syncService.triggerTicketSync(60000);
    assert.ok(syncService.localChangeDebounceTimer);
    syncService.clearCredentials();
    syncService.setCredentials(
        key,
        'identity-token',
        async () => null,
        'identity-account',
        { syncTickets: false }
    );

    try {
        assert.equal(syncService.localChangeDebounceTimer, null);
        const blobs = await syncService._collectLocalBlobs(key);
        assert.deepEqual(blobs, []);
        syncService.triggerTicketSync(1);
        assert.equal(syncService.localChangeDebounceTimer, null);
    } finally {
        fixture.restore();
    }
});
