import assert from 'node:assert/strict';
import test from 'node:test';

import { chatDB } from '../../chat/db.js';
import accountService from '../../chat/services/accountService.js';
import syncService from '../../chat/services/encryptedSyncService.js';
import sessionService from '../../chat/services/sessionService.js';

test('anonymous startup restores the anonymous wallet before billing becomes ready', async () => {
    const originals = {
        db: chatDB.db,
        init: chatDB.init,
        getSetting: chatDB.getSetting,
        sessionInit: sessionService.init,
        deactivateAccountScope: syncService.deactivateAccountScope,
        setLocalAccountScope: syncService.setLocalAccountScope
    };
    const events = [];
    chatDB.db = {};
    chatDB.init = async () => {};
    chatDB.getSetting = async key => (
        key === 'account-settings' ? null : undefined
    );
    sessionService.init = async () => {};
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
        sessionService.init = originals.sessionInit;
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
        sessionInit: sessionService.init,
        deactivateAccountScope: syncService.deactivateAccountScope
    };
    chatDB.db = {};
    chatDB.init = async () => {};
    chatDB.getSetting = async () => null;
    sessionService.init = async () => {};
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
        sessionService.init = originals.sessionInit;
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

test('recovery initialization exposes an initial sync failure for retry', async () => {
    const originals = {
        getSyncKeyMaterial: accountService.getSyncKeyMaterial,
        activateAccountScope: syncService.activateAccountScope,
        setCredentials: syncService.setCredentials,
        init: syncService.init,
        sync: syncService.sync,
        startPeriodicSync: syncService.startPeriodicSync,
        state: { ...accountService.state },
        localAccountContinuity: accountService.localAccountContinuity
    };
    accountService.getSyncKeyMaterial = () => new Uint8Array(32).fill(7);
    accountService.state.accountId = '5555555555555555';
    accountService.state.sessionVerified = true;
    accountService.state.accountScopeReady = false;
    accountService.state.ticketSyncReady = false;
    accountService.localAccountContinuity = false;
    syncService.activateAccountScope = async () => {};
    syncService.setCredentials = () => {};
    syncService.init = async () => {};
    syncService.sync = async () => ({ success: false, error: 'temporary pull failure' });
    syncService.startPeriodicSync = () => {};

    try {
        await assert.rejects(
            accountService.initializeSync(false, {
                awaitInitialSync: true,
                throwOnFailure: true
            }),
            error => error.code === 'ACCOUNT_INITIAL_SYNC_FAILED' &&
                error.cause === 'temporary pull failure'
        );
        assert.equal(accountService.state.accountScopeReady, true);
        assert.equal(accountService.state.ticketSyncReady, false);
    } finally {
        accountService.getSyncKeyMaterial = originals.getSyncKeyMaterial;
        syncService.activateAccountScope = originals.activateAccountScope;
        syncService.setCredentials = originals.setCredentials;
        syncService.init = originals.init;
        syncService.sync = originals.sync;
        syncService.startPeriodicSync = originals.startPeriodicSync;
        Object.assign(accountService.state, originals.state);
        accountService.localAccountContinuity = originals.localAccountContinuity;
    }
});

test('locking during the first encrypted sync cannot restore stale readiness', async () => {
    const originals = {
        getSyncKeyMaterial: accountService.getSyncKeyMaterial,
        updateStatus: accountService.updateStatus,
        notify: accountService.notify,
        activateAccountScope: syncService.activateAccountScope,
        setCredentials: syncService.setCredentials,
        init: syncService.init,
        sync: syncService.sync,
        startPeriodicSync: syncService.startPeriodicSync,
        clearCredentials: syncService.clearCredentials,
        stopPeriodicSync: syncService.stopPeriodicSync,
        state: { ...accountService.state },
        generation: accountService.syncInitializationGeneration,
        localAccountContinuity: accountService.localAccountContinuity,
        cryptoKey: accountService.cryptoKey,
        syncDerivationKey: accountService.syncDerivationKey,
        syncIdKey: accountService.syncIdKey
    };
    let resolveSync;
    let syncStarted;
    const didStartSync = new Promise(resolve => { syncStarted = resolve; });
    accountService.getSyncKeyMaterial = () => new Uint8Array(32).fill(3);
    accountService.updateStatus = () => {};
    accountService.notify = () => {};
    accountService.state.accountId = '6666666666666666';
    accountService.state.sessionVerified = true;
    accountService.state.accountScopeReady = false;
    accountService.state.ticketSyncReady = false;
    syncService.activateAccountScope = async () => {};
    syncService.setCredentials = () => {};
    syncService.init = async () => {};
    syncService.sync = () => {
        syncStarted();
        return new Promise(resolve => { resolveSync = resolve; });
    };
    syncService.startPeriodicSync = () => {};
    syncService.clearCredentials = () => {};
    syncService.stopPeriodicSync = () => {};

    try {
        const initialization = accountService.initializeSync(false, {
            awaitInitialSync: true,
            throwOnFailure: true
        });
        await didStartSync;
        accountService.lock();
        resolveSync({ success: true });
        await assert.rejects(
            initialization,
            error => error.code === 'ACCOUNT_SYNC_CONTEXT_CHANGED'
        );
        assert.equal(accountService.state.accountScopeReady, false);
        assert.equal(accountService.state.ticketSyncReady, false);
    } finally {
        accountService.getSyncKeyMaterial = originals.getSyncKeyMaterial;
        accountService.updateStatus = originals.updateStatus;
        accountService.notify = originals.notify;
        syncService.activateAccountScope = originals.activateAccountScope;
        syncService.setCredentials = originals.setCredentials;
        syncService.init = originals.init;
        syncService.sync = originals.sync;
        syncService.startPeriodicSync = originals.startPeriodicSync;
        syncService.clearCredentials = originals.clearCredentials;
        syncService.stopPeriodicSync = originals.stopPeriodicSync;
        Object.assign(accountService.state, originals.state);
        accountService.syncInitializationGeneration = originals.generation;
        accountService.localAccountContinuity = originals.localAccountContinuity;
        accountService.cryptoKey = originals.cryptoKey;
        accountService.syncDerivationKey = originals.syncDerivationKey;
        accountService.syncIdKey = originals.syncIdKey;
    }
});

test('locking during key persistence cannot repopulate stale account keys', async () => {
    const originals = {
        persistCryptoKeyBundle: accountService.persistCryptoKeyBundle,
        updateStatus: accountService.updateStatus,
        notify: accountService.notify,
        clearCredentials: syncService.clearCredentials,
        stopPeriodicSync: syncService.stopPeriodicSync,
        state: { ...accountService.state },
        generation: accountService.syncInitializationGeneration,
        cryptoKey: accountService.cryptoKey,
        syncDerivationKey: accountService.syncDerivationKey,
        syncIdKey: accountService.syncIdKey
    };
    let releasePersistence;
    let persistenceStarted;
    let committed = false;
    const didStartPersistence = new Promise(resolve => {
        persistenceStarted = resolve;
    });
    const persistenceGate = new Promise(resolve => {
        releasePersistence = resolve;
    });
    accountService.state.accountId = '1212121212121212';
    accountService.state.sessionVerified = true;
    accountService.cryptoKey = null;
    accountService.syncDerivationKey = null;
    accountService.syncIdKey = null;
    accountService.updateStatus = () => {};
    accountService.notify = () => {};
    syncService.clearCredentials = () => {};
    syncService.stopPeriodicSync = () => {};
    accountService.persistCryptoKeyBundle = async (
        _accountId,
        _cryptoKey,
        _derivationKey,
        _idKey,
        isCurrent
    ) => {
        persistenceStarted();
        await persistenceGate;
        if (isCurrent && !isCurrent()) return false;
        committed = true;
        return true;
    };
    const expectedGeneration = accountService.syncInitializationGeneration;
    const isCurrent = () => (
        accountService.syncInitializationGeneration === expectedGeneration &&
        accountService.state.accountId === '1212121212121212' &&
        accountService.state.sessionVerified === true
    );
    const masterKey = new Uint8Array(32).fill(6);

    try {
        const persistence = accountService.persistMasterKey(
            masterKey,
            '1212121212121212',
            { isCurrent }
        );
        await didStartPersistence;
        accountService.lock();
        releasePersistence();
        assert.equal(await persistence, false);
        assert.equal(committed, false);
        assert.equal(accountService.getCryptoKey(), null);
        assert.equal(accountService.getSyncKeyMaterial(), null);
    } finally {
        masterKey.fill(0);
        accountService.persistCryptoKeyBundle = originals.persistCryptoKeyBundle;
        accountService.updateStatus = originals.updateStatus;
        accountService.notify = originals.notify;
        syncService.clearCredentials = originals.clearCredentials;
        syncService.stopPeriodicSync = originals.stopPeriodicSync;
        Object.assign(accountService.state, originals.state);
        accountService.syncInitializationGeneration = originals.generation;
        accountService.cryptoKey = originals.cryptoKey;
        accountService.syncDerivationKey = originals.syncDerivationKey;
        accountService.syncIdKey = originals.syncIdKey;
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
