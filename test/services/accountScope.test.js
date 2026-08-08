import assert from 'node:assert/strict';
import test from 'node:test';

import { chatDB } from '../../chat/db.js';
import syncService from '../../chat/services/encryptedSyncService.js';

test('account scopes do not carry tickets between SSO accounts', async () => {
    const originalGetSetting = chatDB.getSetting;
    const originalSaveSetting = chatDB.saveSetting;
    const originalSaveSettings = chatDB.saveSettings;
    const originalUpdateSettings = chatDB.updateSettings;
    const originalDeleteSetting = chatDB.deleteSetting;
    const settings = new Map([
        ['tickets-active', [{ finalized_ticket: 'account-a-ticket' }]]
    ]);

    chatDB.getSetting = async key => settings.get(key);
    chatDB.saveSetting = async (key, value) => {
        settings.set(key, value);
    };
    chatDB.saveSettings = async entries => {
        for (const { key, value } of entries) settings.set(key, value);
    };
    chatDB.updateSettings = async (entries, deleteKeys) => {
        for (const { key, value } of entries) settings.set(key, value);
        for (const key of deleteKeys) settings.delete(key);
    };
    chatDB.deleteSetting = async key => {
        settings.delete(key);
    };

    try {
        await syncService.activateAccountScope('account-a', {
            adoptUnscoped: true
        });
        await syncService.deactivateAccountScope('account-a');
        assert.equal(settings.has('tickets-active'), false);

        await syncService.activateAccountScope('account-b');
        assert.equal(settings.has('tickets-active'), false);
        settings.set('tickets-active', [{ finalized_ticket: 'account-b-ticket' }]);
        await syncService.deactivateAccountScope('account-b');

        await syncService.activateAccountScope('account-a');
        assert.deepEqual(settings.get('tickets-active'), [
            { finalized_ticket: 'account-a-ticket' }
        ]);
        await syncService.deactivateAccountScope('account-a');

        await syncService.activateAccountScope('account-b');
        assert.deepEqual(settings.get('tickets-active'), [
            { finalized_ticket: 'account-b-ticket' }
        ]);
    } finally {
        chatDB.getSetting = originalGetSetting;
        chatDB.saveSetting = originalSaveSetting;
        chatDB.saveSettings = originalSaveSettings;
        chatDB.updateSettings = originalUpdateSettings;
        chatDB.deleteSetting = originalDeleteSetting;
        settings.clear();
    }
});

test('a fresh account does not adopt unscoped legacy tickets', async () => {
    const originalGetSetting = chatDB.getSetting;
    const originalSaveSetting = chatDB.saveSetting;
    const originalSaveSettings = chatDB.saveSettings;
    const originalUpdateSettings = chatDB.updateSettings;
    const originalDeleteSetting = chatDB.deleteSetting;
    const settings = new Map([
        ['tickets-active', [{ finalized_ticket: 'unowned-ticket' }]]
    ]);

    chatDB.getSetting = async key => settings.get(key);
    chatDB.saveSetting = async (key, value) => {
        settings.set(key, value);
    };
    chatDB.saveSettings = async entries => {
        for (const { key, value } of entries) settings.set(key, value);
    };
    chatDB.updateSettings = async (entries, deleteKeys) => {
        for (const { key, value } of entries) settings.set(key, value);
        for (const key of deleteKeys) settings.delete(key);
    };
    chatDB.deleteSetting = async key => {
        settings.delete(key);
    };

    try {
        await syncService.activateAccountScope('fresh-account');
        assert.equal(settings.has('tickets-active'), false);
        assert.deepEqual(
            settings.get('sync-unclaimed-data')?.['tickets-active'],
            [{ finalized_ticket: 'unowned-ticket' }]
        );
    } finally {
        chatDB.getSetting = originalGetSetting;
        chatDB.saveSetting = originalSaveSetting;
        chatDB.saveSettings = originalSaveSettings;
        chatDB.updateSettings = originalUpdateSettings;
        chatDB.deleteSetting = originalDeleteSetting;
        settings.clear();
    }
});

test('cancel before scope activation preserves unscoped data', async () => {
    const originalGetSetting = chatDB.getSetting;
    const originalSaveSetting = chatDB.saveSetting;
    const originalSaveSettings = chatDB.saveSettings;
    const originalUpdateSettings = chatDB.updateSettings;
    const originalDeleteSetting = chatDB.deleteSetting;
    const settings = new Map([
        ['tickets-active', [{ finalized_ticket: 'unowned-ticket' }]]
    ]);

    chatDB.getSetting = async key => settings.get(key);
    chatDB.saveSetting = async (key, value) => {
        settings.set(key, value);
    };
    chatDB.saveSettings = async entries => {
        for (const { key, value } of entries) settings.set(key, value);
    };
    chatDB.updateSettings = async (entries, deleteKeys) => {
        for (const { key, value } of entries) settings.set(key, value);
        for (const key of deleteKeys) settings.delete(key);
    };
    chatDB.deleteSetting = async key => {
        settings.delete(key);
    };

    try {
        await syncService.deactivateAccountScope('fresh-account');
        assert.deepEqual(settings.get('tickets-active'), [
            { finalized_ticket: 'unowned-ticket' }
        ]);
        assert.equal(
            settings.has('sync-account-data:fresh-account'),
            false
        );
    } finally {
        chatDB.getSetting = originalGetSetting;
        chatDB.saveSetting = originalSaveSetting;
        chatDB.saveSettings = originalSaveSettings;
        chatDB.updateSettings = originalUpdateSettings;
        chatDB.deleteSetting = originalDeleteSetting;
        settings.clear();
    }
});

test('a stale tab cannot deactivate another account scope', async () => {
    const originalGetSetting = chatDB.getSetting;
    const originalSaveSetting = chatDB.saveSetting;
    const originalSaveSettings = chatDB.saveSettings;
    const originalUpdateSettings = chatDB.updateSettings;
    const originalDeleteSetting = chatDB.deleteSetting;
    const accountBTickets = [{ finalized_ticket: 'account-b-ticket' }];
    const settings = new Map([
        ['sync-account-scope', 'account-b'],
        ['tickets-active', accountBTickets]
    ]);

    chatDB.getSetting = async key => settings.get(key);
    chatDB.saveSetting = async (key, value) => {
        settings.set(key, value);
    };
    chatDB.saveSettings = async entries => {
        for (const { key, value } of entries) settings.set(key, value);
    };
    chatDB.updateSettings = async (entries, deleteKeys) => {
        for (const { key, value } of entries) settings.set(key, value);
        for (const key of deleteKeys) settings.delete(key);
    };
    chatDB.deleteSetting = async key => {
        settings.delete(key);
    };

    try {
        await syncService.deactivateAccountScope('account-a');
        assert.equal(settings.get('sync-account-scope'), 'account-b');
        assert.deepEqual(settings.get('tickets-active'), accountBTickets);
        assert.equal(settings.has('sync-account-data:account-b'), false);
    } finally {
        chatDB.getSetting = originalGetSetting;
        chatDB.saveSetting = originalSaveSetting;
        chatDB.saveSettings = originalSaveSettings;
        chatDB.updateSettings = originalUpdateSettings;
        chatDB.deleteSetting = originalDeleteSetting;
        settings.clear();
    }
});

test('sync refuses to read live values from another account scope', async () => {
    const originalGetSetting = chatDB.getSetting;
    chatDB.getSetting = async key => (
        key === 'sync-account-scope' ? 'account-b' : undefined
    );

    try {
        syncService.setCredentials(
            new Uint8Array(32).fill(1),
            'account-a'
        );
        const result = await syncService.sync();
        assert.equal(result.success, false);
        assert.match(result.error, /account scope changed/);
    } finally {
        chatDB.getSetting = originalGetSetting;
        syncService.clearCredentials();
        syncService.syncInProgress = false;
    }
});
