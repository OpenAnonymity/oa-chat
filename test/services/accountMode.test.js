import assert from 'node:assert/strict';
import test from 'node:test';

import { chatDB } from '../../chat/db.js';
import accountService, {
    bootstrapDesktopOAuthSession,
    inferPersistedEncryptionMode,
    oauthSessionNeedsEmailRefresh,
    toFriendlyAccountError
} from '../../chat/services/accountService.js';
import sessionService from '../../chat/services/sessionService.js';

test('account snapshot exposes only a boolean for a saved local binding', () => {
    const originalAccountId = accountService.state.accountId;
    const originalContinuity = accountService.localAccountContinuity;
    try {
        accountService.state.accountId = null;
        accountService.localAccountContinuity = true;
        const snapshot = accountService.getState();
        assert.equal(snapshot.accountId, null);
        assert.equal(snapshot.hasSavedAccountBinding, true);
    } finally {
        accountService.state.accountId = originalAccountId;
        accountService.localAccountContinuity = originalContinuity;
    }
});

test('a later storage NotFoundError is never reported as a missing passkey', async () => {
    const laterFailure = new Error('IndexedDB object store was not found');
    laterFailure.name = 'NotFoundError';
    assert.equal(
        toFriendlyAccountError(laterFailure),
        'IndexedDB object store was not found'
    );

    const originals = {
        persistMasterKey: accountService.persistMasterKey,
        state: { ...accountService.state }
    };
    accountService.persistMasterKey = async () => { throw laterFailure; };
    const masterKey = new Uint8Array(32).fill(9);
    try {
        await assert.rejects(
            accountService.finishOAuthKeyUnlock(masterKey, 'credential-id'),
            error => error.code === 'ACCOUNT_KEY_PERSIST_FAILED' &&
                /passkey worked/.test(error.message)
        );
        assert.equal(masterKey.every(value => value === 0), true);
    } finally {
        accountService.persistMasterKey = originals.persistMasterKey;
        Object.assign(accountService.state, originals.state);
    }
});

test('a post-passkey sync failure schedules a real restoration retry', async () => {
    const originals = {
        persistMasterKey: accountService.persistMasterKey,
        persistSettings: accountService.persistSettings,
        initializeSync: accountService.initializeSync,
        updateStatus: accountService.updateStatus,
        notify: accountService.notify,
        setTimeout: globalThis.setTimeout,
        state: { ...accountService.state },
        generation: accountService.syncInitializationGeneration
    };
    const calls = [];
    accountService.persistMasterKey = async () => {};
    accountService.persistSettings = async () => {};
    accountService.updateStatus = () => {};
    accountService.notify = () => {};
    accountService.state.accountId = '7777777777777777';
    accountService.state.sessionVerified = true;
    accountService.initializeSync = async (newAccount, options) => {
        accountService.syncInitializationGeneration += 1;
        calls.push({ newAccount, options });
        if (calls.length === 1) throw Object.assign(new Error('temporary'), {
            code: 'ACCOUNT_INITIAL_SYNC_FAILED'
        });
        return true;
    };
    globalThis.setTimeout = (callback, delay) => {
        assert.equal(delay, 1000);
        queueMicrotask(callback);
        return 1;
    };
    const masterKey = new Uint8Array(32).fill(5);

    try {
        await accountService.finishOAuthKeyUnlock(masterKey, 'credential-id');
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(masterKey.every(value => value === 0), true);
        assert.deepEqual(calls, [
            {
                newAccount: false,
                options: { awaitInitialSync: true, throwOnFailure: true }
            },
            {
                newAccount: false,
                options: { awaitInitialSync: true, throwOnFailure: true }
            }
        ]);
    } finally {
        accountService.persistMasterKey = originals.persistMasterKey;
        accountService.persistSettings = originals.persistSettings;
        accountService.initializeSync = originals.initializeSync;
        accountService.updateStatus = originals.updateStatus;
        accountService.notify = originals.notify;
        globalThis.setTimeout = originals.setTimeout;
        Object.assign(accountService.state, originals.state);
        accountService.syncInitializationGeneration = originals.generation;
    }
});

test('an account switch before the post-passkey retry cancels stale restoration', async () => {
    const originals = {
        persistMasterKey: accountService.persistMasterKey,
        persistSettings: accountService.persistSettings,
        initializeSync: accountService.initializeSync,
        updateStatus: accountService.updateStatus,
        notify: accountService.notify,
        setTimeout: globalThis.setTimeout,
        state: { ...accountService.state },
        generation: accountService.syncInitializationGeneration
    };
    const calls = [];
    let retryCallback = null;
    accountService.persistMasterKey = async () => {};
    accountService.persistSettings = async () => {};
    accountService.updateStatus = () => {};
    accountService.notify = () => {};
    accountService.state.accountId = '8888888888888888';
    accountService.state.sessionVerified = true;
    accountService.initializeSync = async (...args) => {
        accountService.syncInitializationGeneration += 1;
        calls.push(args);
        throw Object.assign(new Error('temporary'), {
            code: 'ACCOUNT_INITIAL_SYNC_FAILED'
        });
    };
    globalThis.setTimeout = callback => {
        retryCallback = callback;
        return 1;
    };

    try {
        const masterKey = new Uint8Array(32).fill(4);
        assert.equal(
            await accountService.finishOAuthKeyUnlock(masterKey, 'credential-id'),
            true
        );
        assert.equal(typeof retryCallback, 'function');
        accountService.state.accountId = '9999999999999999';
        retryCallback();
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(calls.length, 1);
    } finally {
        accountService.persistMasterKey = originals.persistMasterKey;
        accountService.persistSettings = originals.persistSettings;
        accountService.initializeSync = originals.initializeSync;
        accountService.updateStatus = originals.updateStatus;
        accountService.notify = originals.notify;
        globalThis.setTimeout = originals.setTimeout;
        Object.assign(accountService.state, originals.state);
        accountService.syncInitializationGeneration = originals.generation;
    }
});

test('desktop OAuth delegates browser handoff to the isolated bridge', async () => {
    const calls = [];
    const session = {
        accountId: '1234567890123456',
        email: 'member@example.test'
    };
    const result = await bootstrapDesktopOAuthSession(
        'google',
        session.accountId,
        {
            bridge: {
                isElectron: true,
                authStartBrowserSignIn: async (...args) => calls.push(args)
            },
            initializeSession: async () => calls.push(['init']),
            verifySession: async () => true,
            fetchSession: async () => session
        }
    );
    assert.deepEqual(calls, [
        ['init'],
        ['google', '1234567890123456']
    ]);
    assert.deepEqual(result, session);
});

test('desktop OAuth returns a validated relay passkey only after session verification', async () => {
    const passkey = {
        operation: 'get',
        credentialId: 'credential-id',
        prf: 'A'.repeat(43) + '='
    };
    const session = { accountId: '1234567890123456' };
    const result = await bootstrapDesktopOAuthSession('google', null, {
        bridge: {
            isElectron: true,
            authStartBrowserSignIn: async () => ({ success: true, passkey })
        },
        initializeSession: async () => {},
        verifySession: async () => true,
        fetchSession: async () => session
    });
    assert.deepEqual(result, { ...session, desktopPasskey: passkey });

    await assert.rejects(
        bootstrapDesktopOAuthSession('google', null, {
            bridge: {
                isElectron: true,
                authStartBrowserSignIn: async () => ({ success: true, passkey })
            },
            initializeSession: async () => {},
            verifySession: async () => false,
            fetchSession: async () => session
        }),
        /session could not be established/
    );
});

test('removed SSO providers are rejected by the account service', async () => {
    await assert.rejects(
        accountService.authenticateWithOAuth('github'),
        /Unsupported sign-in provider/
    );
});

test('old linked passkey settings retain legacy passkey provenance', () => {
    assert.equal(inferPersistedEncryptionMode({
        accountId: '1234567890123456',
        credentialId: 'legacy-authentication-credential',
        googleLinked: true
    }), 'LEGACY_PASSKEY');
});

test('old identity keyring settings infer PRF encryption provenance', () => {
    assert.equal(inferPersistedEncryptionMode({
        accountId: '1234567890123456',
        encryptionCredentialId: 'encryption-only-credential',
        googleLinked: true
    }), 'PRF');
});

test('old SSO setup sessions refresh OAuth before creating an email-labeled passkey', () => {
    assert.equal(oauthSessionNeedsEmailRefresh({
        encryptionMode: 'PRF_PENDING',
        email: null
    }), true);
    assert.equal(oauthSessionNeedsEmailRefresh({
        encryptionMode: 'LEGACY_SSO',
        email: ''
    }), true);
    assert.equal(oauthSessionNeedsEmailRefresh({
        encryptionMode: 'PRF_PENDING',
        email: 'person@example.com'
    }), false);
    assert.equal(oauthSessionNeedsEmailRefresh({
        encryptionMode: 'PRF',
        email: null
    }), false);
});

test('account settings retain the account-bound OAuth identity label', async () => {
    const originalSaveSetting = chatDB.saveSetting;
    const originalState = { ...accountService.state };
    let saved = null;
    chatDB.saveSetting = async (key, value) => { saved = { key, value }; };
    Object.assign(accountService.state, {
        accountId: '1234567890123456',
        googleLinked: true,
        oauthProvider: 'google',
        oauthEmail: 'member@example.test'
    });

    try {
        await accountService.persistSettings();
        assert.equal(saved.key, 'account-settings');
        assert.equal(saved.value.accountId, '1234567890123456');
        assert.equal(saved.value.oauthEmail, 'member@example.test');
    } finally {
        chatDB.saveSetting = originalSaveSetting;
        Object.assign(accountService.state, originalState);
    }
});

test('restored sessions expose the cached identity before profile refresh finishes', async () => {
    const originals = {
        state: { ...accountService.state },
        cryptoKey: accountService.cryptoKey,
        syncDerivationKey: accountService.syncDerivationKey,
        syncIdKey: accountService.syncIdKey,
        verifySession: sessionService.verifySession,
        refreshOAuthLinkStatuses: accountService.refreshOAuthLinkStatuses,
        persistSettings: accountService.persistSettings,
        initializeSync: accountService.initializeSync,
        setTimeout: globalThis.setTimeout
    };
    let releaseProfileRefresh;
    let refreshStarted = false;
    const profileRefresh = new Promise(resolve => { releaseProfileRefresh = resolve; });
    const snapshots = [];

    Object.assign(accountService.state, {
        accountId: '1234567890123456',
        authBootstrapComplete: false,
        sessionVerified: false,
        oauthEmail: 'member@example.test',
        busy: false
    });
    accountService.cryptoKey = {};
    accountService.syncDerivationKey = {};
    accountService.syncIdKey = {};
    sessionService.verifySession = async () => true;
    accountService.refreshOAuthLinkStatuses = async () => {
        refreshStarted = true;
        await profileRefresh;
        return true;
    };
    accountService.persistSettings = async () => {};
    accountService.initializeSync = async () => {};
    globalThis.setTimeout = callback => {
        queueMicrotask(callback);
        return 1;
    };
    const unsubscribe = accountService.subscribe(snapshot => snapshots.push(snapshot));

    try {
        const verification = accountService.verifySessionInBackground();
        await new Promise(resolve => setImmediate(resolve));

        assert.equal(refreshStarted, true);
        assert.equal(snapshots[0].sessionVerified, true);
        assert.equal(snapshots[0].status, 'unlocked');
        assert.equal(snapshots[0].oauthEmail, 'member@example.test');
        assert.equal(accountService.state.authBootstrapComplete, true);

        releaseProfileRefresh();
        await verification;
    } finally {
        unsubscribe();
        sessionService.verifySession = originals.verifySession;
        accountService.refreshOAuthLinkStatuses = originals.refreshOAuthLinkStatuses;
        accountService.persistSettings = originals.persistSettings;
        accountService.initializeSync = originals.initializeSync;
        globalThis.setTimeout = originals.setTimeout;
        Object.assign(accountService.state, originals.state);
        accountService.cryptoKey = originals.cryptoKey;
        accountService.syncDerivationKey = originals.syncDerivationKey;
        accountService.syncIdKey = originals.syncIdKey;
    }
});

test('account bootstrap waiters resolve only after initial authentication settles', async () => {
    const originalState = { ...accountService.state };
    const originalInit = accountService.init;
    accountService.state.authBootstrapComplete = false;
    accountService.init = async () => {};
    let resolved = false;

    try {
        const waiting = accountService.waitForAuthBootstrap().then(snapshot => {
            resolved = true;
            return snapshot;
        });
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(resolved, false);

        accountService.completeAuthBootstrap();
        const snapshot = await waiting;
        assert.equal(resolved, true);
        assert.equal(snapshot.authBootstrapComplete, true);
    } finally {
        accountService.init = originalInit;
        Object.assign(accountService.state, originalState);
    }
});
