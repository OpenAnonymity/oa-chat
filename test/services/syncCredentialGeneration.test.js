import assert from 'node:assert/strict';
import test from 'node:test';

import { chatDB } from '../../chat/db.js';
import syncService from '../../chat/services/encryptedSyncService.js';

test('an in-flight sync cannot refresh with a replacement account session', async () => {
    const originalCollect = syncService._collectLocalBlobs;
    const originalFetch = syncService.fetchWithRetry;
    let finishRequest;
    let refreshCalled = false;

    try {
        syncService.setCredentials(
            new Uint8Array(32).fill(1),
            'account-a-token',
            async () => {
                refreshCalled = true;
                return { accessToken: 'account-b-token' };
            },
            'account-a'
        );
        const generation = syncService.credentialGeneration;
        syncService._collectLocalBlobs = async () => [{
            id: 'opaque',
            ciphertext: 'ciphertext',
            iv: 'iv',
            version: 1
        }];
        syncService.fetchWithRetry = async () => new Promise(resolve => {
            finishRequest = resolve;
        });

        const pendingPush = syncService._push(
            new Uint8Array(32).fill(1),
            'account-a-token',
            generation
        );
        await new Promise(resolve => setTimeout(resolve, 0));

        syncService.clearCredentials();
        finishRequest({ ok: false, status: 401 });

        await assert.rejects(pendingPush, /Sync credentials changed/);
        assert.equal(refreshCalled, false);
        assert.equal(syncService.accessToken, null);
    } finally {
        syncService._collectLocalBlobs = originalCollect;
        syncService.fetchWithRetry = originalFetch;
        syncService.clearCredentials();
    }
});

test('an invalidated ID mapping build cannot populate the replacement account cache', async () => {
    try {
        const accountAKey = new Uint8Array(32).fill(1);
        const accountBKey = new Uint8Array(32).fill(2);

        syncService.setCredentials(
            accountAKey,
            'account-a-token',
            async () => null,
            'account-a'
        );
        const accountAGeneration = syncService.credentialGeneration;
        const pendingAccountAMapping = syncService._buildIdMapping(
            accountAKey,
            accountAGeneration
        );

        syncService.setCredentials(
            accountBKey,
            'account-b-token',
            async () => null,
            'account-b'
        );
        const accountBGeneration = syncService.credentialGeneration;

        await assert.rejects(
            pendingAccountAMapping,
            /Sync credentials changed/
        );
        assert.equal(syncService.idMapping, null);
        assert.equal(syncService.idMappingGeneration, null);

        const accountBMapping = await syncService._buildIdMapping(
            accountBKey,
            accountBGeneration
        );
        assert.equal(syncService.idMapping, accountBMapping);
        assert.equal(syncService.idMappingGeneration, accountBGeneration);
    } finally {
        syncService.clearCredentials();
    }
});

test('an invalidated pull cannot apply parsed blobs or publish sync metadata', async () => {
    const originalFetch = syncService.fetchWithRetry;
    const originalApply = syncService._applyServerBlob;
    const originalGetSetting = chatDB.getSetting;
    const originalSaveSetting = chatDB.saveSetting;
    let finishJson;
    let applied = false;
    let savedSyncTime = false;

    try {
        const accountAKey = new Uint8Array(32).fill(1);
        syncService.setCredentials(
            accountAKey,
            'account-a-token',
            async () => null,
            'account-a'
        );
        const generation = syncService.credentialGeneration;

        syncService.fetchWithRetry = async () => ({
            ok: true,
            status: 200,
            json: async () => new Promise(resolve => {
                finishJson = resolve;
            })
        });
        syncService._applyServerBlob = async () => {
            applied = true;
            return true;
        };
        chatDB.getSetting = async () => 0;
        chatDB.saveSetting = async () => {
            savedSyncTime = true;
        };

        const pendingPull = syncService._pull(
            accountAKey,
            'account-a-token',
            generation,
            new Map()
        );
        while (!finishJson) {
            await new Promise(resolve => setTimeout(resolve, 0));
        }

        syncService.clearCredentials();
        finishJson({ blobs: [{ id: 'old-account' }], server_time: 123 });

        await assert.rejects(pendingPull, /Sync credentials changed/);
        assert.equal(applied, false);
        assert.equal(savedSyncTime, false);
    } finally {
        syncService.fetchWithRetry = originalFetch;
        syncService._applyServerBlob = originalApply;
        chatDB.getSetting = originalGetSetting;
        chatDB.saveSetting = originalSaveSetting;
        syncService.clearCredentials();
    }
});

test('an invalidated sync does not overwrite replacement-account UI state', async () => {
    const originalBuild = syncService._buildIdMapping;
    const originalScopeCheck = syncService.isAccountScopeActive;
    const originalNotify = syncService.notify;
    let finishBuild;
    const events = [];

    try {
        const accountAKey = new Uint8Array(32).fill(1);
        syncService.setCredentials(
            accountAKey,
            'account-a-token',
            async () => null,
            'account-a'
        );
        const generation = syncService.credentialGeneration;
        syncService.lastSyncResult = { success: true, account: 'replacement' };
        syncService.syncInProgress = true;
        syncService.notify = event => events.push(event);
        syncService._buildIdMapping = async () => new Promise(resolve => {
            finishBuild = resolve;
        });
        syncService.isAccountScopeActive = async () => true;

        const pendingSync = syncService._doSync(
            accountAKey,
            'account-a-token',
            'account-a',
            generation
        );
        while (!finishBuild) {
            await new Promise(resolve => setTimeout(resolve, 0));
        }

        syncService.setCredentials(
            new Uint8Array(32).fill(2),
            'account-b-token',
            async () => null,
            'account-b'
        );
        finishBuild(new Map());

        const result = await pendingSync;
        assert.equal(result.stale, true);
        assert.deepEqual(
            syncService.lastSyncResult,
            { success: true, account: 'replacement' }
        );
        assert.deepEqual(events, []);
        assert.equal(syncService.syncInProgress, false);
    } finally {
        syncService._buildIdMapping = originalBuild;
        syncService.isAccountScopeActive = originalScopeCheck;
        syncService.notify = originalNotify;
        syncService.lastSyncResult = null;
        syncService.syncInProgress = false;
        syncService.clearCredentials();
    }
});
