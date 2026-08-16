import assert from 'node:assert/strict';
import test from 'node:test';

import { chatDB } from '../../chat/db.js';
import accountService from '../../chat/services/accountService.js';
import syncService from '../../chat/services/encryptedSyncService.js';

test('anonymous startup restores the anonymous wallet before billing becomes ready', async () => {
    const originals = {
        db: chatDB.db,
        init: chatDB.init,
        getSetting: chatDB.getSetting,
        deactivateAccountScope: syncService.deactivateAccountScope,
        setLocalAccountScope: syncService.setLocalAccountScope
    };
    const events = [];
    chatDB.db = {};
    chatDB.init = async () => {};
    chatDB.getSetting = async key => (
        key === 'account-settings' ? null : undefined
    );
    syncService.deactivateAccountScope = async accountId => {
        events.push(['deactivate', accountId]);
        assert.equal(accountService.state.isReady, false);
    };
    syncService.setLocalAccountScope = accountId => {
        events.push(['local', accountId]);
        assert.equal(accountService.state.isReady, false);
    };
    accountService.state.isReady = false;
    accountService.state.accountId = null;

    try {
        await accountService.init();
        assert.deepEqual(events, [
            ['deactivate', null],
            ['local', null]
        ]);
        assert.equal(accountService.state.isReady, true);
    } finally {
        chatDB.db = originals.db;
        chatDB.init = originals.init;
        chatDB.getSetting = originals.getSetting;
        syncService.deactivateAccountScope = originals.deactivateAccountScope;
        syncService.setLocalAccountScope = originals.setLocalAccountScope;
        accountService.state.isReady = false;
        accountService.state.accountId = null;
        accountService.updateStatus();
    }
});

test('anonymous startup stays billing-unready when scope restoration fails', async () => {
    const originals = {
        db: chatDB.db,
        init: chatDB.init,
        getSetting: chatDB.getSetting,
        deactivateAccountScope: syncService.deactivateAccountScope
    };
    chatDB.db = {};
    chatDB.init = async () => {};
    chatDB.getSetting = async () => null;
    syncService.deactivateAccountScope = async () => {
        throw new Error('scope restore failed');
    };
    accountService.state.isReady = false;
    accountService.state.accountId = null;

    try {
        await assert.rejects(
            accountService.init(),
            /scope restore failed/
        );
        assert.equal(accountService.state.isReady, false);
    } finally {
        chatDB.db = originals.db;
        chatDB.init = originals.init;
        chatDB.getSetting = originals.getSetting;
        syncService.deactivateAccountScope = originals.deactivateAccountScope;
        accountService.state.isReady = false;
        accountService.state.accountId = null;
        accountService.updateStatus();
    }
});

test('new SSO keyring setup adopts the existing device wallet', async () => {
    const originals = {
        getSyncKeyMaterial: accountService.getSyncKeyMaterial,
        activateAccountScope: syncService.activateAccountScope,
        setCredentials: syncService.setCredentials,
        init: syncService.init,
        sync: syncService.sync,
        startPeriodicSync: syncService.startPeriodicSync
    };
    let activation = null;
    let credentialOptions = null;
    accountService.getSyncKeyMaterial = () => new Uint8Array(32).fill(9);
    accountService.state.accountId = '4444444444444444';
    accountService.state.sessionVerified = true;
    accountService.state.googleLinked = true;
    accountService.state.accountScopeReady = false;
    accountService.localAccountContinuity = false;
    syncService.activateAccountScope = async (accountId, options) => {
        assert.equal(accountService.state.accountScopeReady, false);
        activation = { accountId, options };
    };
    syncService.setCredentials = (
        _keyMaterial,
        _accountId,
        options
    ) => {
        credentialOptions = options;
    };
    syncService.init = async () => {};
    syncService.sync = async () => ({ success: true });
    syncService.startPeriodicSync = () => {};

    try {
        await accountService.initializeSync(true);
        assert.deepEqual(activation, {
            accountId: '4444444444444444',
            options: { adoptUnscoped: true }
        });
        assert.deepEqual(credentialOptions, {
            identityBacked: true
        });
        assert.equal(accountService.state.accountScopeReady, true);
    } finally {
        accountService.getSyncKeyMaterial = originals.getSyncKeyMaterial;
        syncService.activateAccountScope = originals.activateAccountScope;
        syncService.setCredentials = originals.setCredentials;
        syncService.init = originals.init;
        syncService.sync = originals.sync;
        syncService.startPeriodicSync = originals.startPeriodicSync;
        accountService.state.accountId = null;
        accountService.state.sessionVerified = false;
        accountService.state.googleLinked = false;
        accountService.state.accountScopeReady = false;
        accountService.localAccountContinuity = false;
    }
});

test('persisted non-extractable keys are bound to their account', async () => {
    const originals = {
        getSetting: chatDB.getSetting,
        updateSettings: chatDB.updateSettings
    };
    const settings = new Map();
    chatDB.getSetting = async key => settings.get(key);
    chatDB.updateSettings = async (entries, deleteKeys) => {
        entries.forEach(({ key, value }) => settings.set(key, value));
        deleteKeys.forEach(key => settings.delete(key));
    };
    const masterKey = crypto.getRandomValues(new Uint8Array(32));

    try {
        accountService.state.accountId = '1111111111111111';
        settings.set('account-settings', {
            accountId: '1111111111111111'
        });
        await accountService.persistMasterKey(masterKey);
        const bundle = settings.get('account-key-bundle-v1');
        assert.equal(bundle.accountId, '1111111111111111');
        assert.equal(bundle.cryptoKey.extractable, false);
        assert.equal(bundle.derivationKey.extractable, false);
        assert.equal(bundle.idKey.extractable, false);

        settings.set('account-settings', {
            accountId: '2222222222222222'
        });
        await assert.rejects(
            accountService.persistMasterKey(masterKey),
            /Account changed/
        );
        assert.equal(settings.get('account-key-bundle-v1'), bundle);

        accountService.cryptoKey = null;
        accountService.syncDerivationKey = null;
        accountService.syncIdKey = null;
        const foreignLegacyKey = await crypto.subtle.importKey(
            'raw',
            crypto.getRandomValues(new Uint8Array(32)),
            { name: 'AES-GCM' },
            false,
            ['encrypt', 'decrypt']
        );
        settings.set('account-master-crypto-key', foreignLegacyKey);
        settings.set('account-sync-derivation-key', await crypto.subtle.importKey(
            'raw',
            crypto.getRandomValues(new Uint8Array(32)),
            { name: 'HKDF' },
            false,
            ['deriveKey']
        ));
        settings.set('account-sync-id-key', await crypto.subtle.importKey(
            'raw',
            crypto.getRandomValues(new Uint8Array(32)),
            { name: 'HMAC', hash: 'SHA-256' },
            false,
            ['sign']
        ));
        accountService.state.accountId = '2222222222222222';
        assert.equal(await accountService.loadMasterKey(), false);
        assert.equal(accountService.getSyncKeyMaterial(), null);
        await accountService.clearPersistedMasterKey();
        assert.equal(
            settings.get('account-key-bundle-v1').accountId,
            '1111111111111111'
        );

        accountService.state.accountId = '1111111111111111';
        settings.set('account-settings', {
            accountId: '1111111111111111'
        });
        assert.equal(await accountService.loadMasterKey(), true);
        assert.ok(accountService.getSyncKeyMaterial());
    } finally {
        masterKey.fill(0);
        chatDB.getSetting = originals.getSetting;
        chatDB.updateSettings = originals.updateSettings;
        accountService.cryptoKey = null;
        accountService.syncDerivationKey = null;
        accountService.syncIdKey = null;
        accountService.state.accountId = null;
        accountService.localAccountContinuity = false;
    }
});

test('legacy CryptoKeys are migrated once into an account-bound bundle', async () => {
    const originals = {
        getSetting: chatDB.getSetting,
        updateSettings: chatDB.updateSettings
    };
    const settings = new Map();
    chatDB.getSetting = async key => settings.get(key);
    chatDB.updateSettings = async (entries, deleteKeys) => {
        entries.forEach(({ key, value }) => settings.set(key, value));
        deleteKeys.forEach(key => settings.delete(key));
    };
    const raw = crypto.getRandomValues(new Uint8Array(32));

    try {
        settings.set('account-master-crypto-key', await crypto.subtle.importKey(
            'raw',
            raw,
            { name: 'AES-GCM' },
            false,
            ['encrypt', 'decrypt']
        ));
        settings.set('account-sync-derivation-key', await crypto.subtle.importKey(
            'raw',
            raw,
            { name: 'HKDF' },
            false,
            ['deriveKey']
        ));
        settings.set('account-sync-id-key', await crypto.subtle.importKey(
            'raw',
            raw,
            { name: 'HMAC', hash: 'SHA-256' },
            false,
            ['sign']
        ));
        accountService.state.accountId = '3333333333333333';
        accountService.localAccountContinuity = true;
        settings.set('account-settings', {
            accountId: '3333333333333333'
        });

        assert.equal(await accountService.loadMasterKey(), true);
        assert.equal(
            settings.get('account-key-bundle-v1').accountId,
            '3333333333333333'
        );
        assert.equal(settings.has('account-master-crypto-key'), false);
        assert.equal(settings.has('account-sync-derivation-key'), false);
        assert.equal(settings.has('account-sync-id-key'), false);
    } finally {
        raw.fill(0);
        chatDB.getSetting = originals.getSetting;
        chatDB.updateSettings = originals.updateSettings;
        accountService.cryptoKey = null;
        accountService.syncDerivationKey = null;
        accountService.syncIdKey = null;
        accountService.state.accountId = null;
        accountService.localAccountContinuity = false;
    }
});
