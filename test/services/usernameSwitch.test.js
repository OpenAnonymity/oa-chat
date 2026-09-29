import assert from 'node:assert/strict';
import test from 'node:test';
import { chatDB } from '../../chat/db.js';
import accountService, { ACCOUNT_LOGIN_EVENT, ACCOUNT_LOGIN_COMPLETE_EVENT } from '../../chat/services/accountService.js';
import syncService from '../../chat/services/encryptedSyncService.js';
import sessionService from '../../chat/services/sessionService.js';
import storageEvents from '../../chat/services/storageEvents.js';
import AccountModal from '../../chat/components/AccountModal.js';
import { ACCOUNT_LOGIN_PENDING_KEY } from '../../chat/services/accountDataLock.js';

const X = '1111111111111111';
const Y = '2222222222222222';
const b64 = bytes => Buffer.from(bytes).toString('base64');

async function setup(t, { stale = false, cancel = false, failLogin = false } = {}) {
    const saved = [];
    const replace = (object, key, value) => {
        saved.push(() => { object[key] = original; });
        const original = object[key];
        object[key] = value;
    };
    const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    const prf = new Uint8Array(32).fill(5);
    const targetKey = new Uint8Array(32).fill(8);
    const aes = await crypto.subtle.importKey('raw', prf, 'AES-GCM', false, ['encrypt']);
    const iv = new Uint8Array(12).fill(7);
    const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aes, targetKey);
    const oldMaster = new Uint8Array(32).fill(3);
    const settings = new Map([
        ['account-settings', { accountId: X, username: 'first-user', googleLinked: true }],
        ['account-key-bundle-v1', { accountId: X, cryptoKey: 'old-crypto' }],
        ['sync-account-scope', X],
        ['tickets-active', [{ finalized_ticket: 'x-ticket' }]],
        [`sync-account-data:${Y}`, { 'tickets-active': [{ finalized_ticket: 'y-ticket' }] }]
    ]);
    const requests = [];
    const broadcasts = [];
    replace(accountService, 'state', {
        ...accountService.state, isReady: true, authBootstrapComplete: true,
        accountId: stale ? null : X, username: stale ? null : 'first-user',
        credentialId: 'x-passkey', encryptionCredentialId: 'x-encryption-passkey',
        googleLinked: true, oauthEmail: 'old@example.test', oauthProvider: 'google',
        sessionVerified: !stale, accountScopeReady: !stale, ticketSyncReady: !stale,
        busy: false, passkeySupported: true, error: null, accountHandoffPending: false
    });
    replace(accountService, 'masterKey', oldMaster);
    replace(accountService, 'cryptoKey', 'old-crypto');
    replace(accountService, 'syncDerivationKey', {});
    replace(accountService, 'syncIdKey', {});
    replace(accountService, 'localAccountContinuity', true);
    replace(accountService, 'failedAttempts', []);
    replace(accountService, 'lockedUntil', 0);
    replace(accountService, 'loginGeneration', 0);
    replace(accountService, 'recoveryPayload', 'x-recovery');
    replace(accountService, 'keyringWrappers', ['x-wrapper']);
    replace(chatDB, 'db', {});
    replace(chatDB, 'getSetting', async key => settings.get(key));
    replace(chatDB, 'saveSetting', async (key, value) => { settings.set(key, value); });
    replace(chatDB, 'updateSettings', async (entries, deletes = []) => {
        for (const { key, value } of entries) settings.set(key, value);
        for (const key of deletes) settings.delete(key);
    });
    replace(storageEvents, 'init', () => {});
    replace(storageEvents, 'broadcast', (type, payload) => { broadcasts.push({ type, payload }); });
    replace(sessionService, 'doesSessionExist', async () => true);
    replace(sessionService, 'init', async () => {});
    replace(sessionService, 'fetch', async (url, options) => {
        const body = JSON.parse(options.body);
        requests.push({ url, body });
        if (url.endsWith('/auth/challenge')) {
            assert.equal(body.credentialId, undefined, 'never offer X’s passkey for Y');
            return Response.json({ accountId: Y, challengeId: 'y-challenge', publicKey: {
                challenge: b64(new Uint8Array([1, 2])), userVerification: 'required',
                allowCredentials: [{ type: 'public-key', id: b64(new Uint8Array([3])) }]
            } });
        }
        assert.ok(url.endsWith('/auth/login'));
        assert.equal(body.accountId, Y);
        assert.equal(body.challengeId, 'y-challenge');
        assert.equal(settings.get(ACCOUNT_LOGIN_PENDING_KEY).accountId, Y);
        await assert.rejects(syncService.assertAccountDataAccess(), /Account changed/);
        if (failLogin) throw new Error('Connection interrupted');
        return Response.json({ wrappedKeyPasskey: { iv: b64(iv), ciphertext: b64(encrypted) } });
    });
    replace(syncService, 'localScopeAccountId', X);
    replace(syncService, 'sync', async () => ({ success: true }));
    replace(syncService, 'init', async () => {});
    replace(syncService, 'startPeriodicSync', () => {});
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { credentials: {
        get: async () => {
            assert.equal(settings.get('account-settings').accountId, X, 'X survives until passkey succeeds');
            assert.equal(settings.has(ACCOUNT_LOGIN_PENDING_KEY), false);
            if (cancel) throw new DOMException('Canceled', 'NotAllowedError');
            return {
                id: 'y-passkey', rawId: new Uint8Array([3]).buffer, type: 'public-key',
                response: { clientDataJSON: new Uint8Array([1]).buffer,
                    authenticatorData: new Uint8Array([2]).buffer, signature: new Uint8Array([3]).buffer },
                getClientExtensionResults: () => ({ prf: { results: { first: prf.slice().buffer } } })
            };
        }
    } } });
    t.after(() => {
        for (const restore of saved.reverse()) restore();
        if (navigatorDescriptor) Object.defineProperty(globalThis, 'navigator', navigatorDescriptor);
        else delete globalThis.navigator;
        syncService.clearCredentials();
    });
    return { settings, oldMaster, requests, broadcasts, targetKey };
}

for (const stale of [false, true]) {
    test(`username switch isolates accounts from a ${stale ? 'stale logged-out' : 'signed-in'} window`, async t => {
        const h = await setup(t, { stale });
        assert.equal(await accountService.unlockWithUsername('second-user'), true);
        assert.equal(accountService.state.accountId, Y);
        assert.equal(accountService.state.sessionVerified, true);
        assert.equal(accountService.state.accountScopeReady, true);
        assert.equal(accountService.state.googleLinked, false);
        assert.equal(accountService.state.oauthEmail, null);
        assert.equal(accountService.recoveryPayload, null);
        assert.deepEqual(accountService.keyringWrappers, []);
        assert.equal(accountService.state.encryptionCredentialId, null);
        assert.deepEqual(accountService.masterKey, h.targetKey);
        assert.ok(h.oldMaster.every(byte => byte === 0));
        assert.deepEqual(h.settings.get('tickets-active'), [{ finalized_ticket: 'y-ticket' }]);
        assert.deepEqual(h.settings.get(`sync-account-data:${X}`)['tickets-active'], [{ finalized_ticket: 'x-ticket' }]);
        const bundle = h.settings.get('account-key-bundle-v1');
        assert.equal(bundle.accountId, Y);
        assert.equal(bundle.cryptoKey.extractable, false);
        assert.equal(bundle.derivationKey.extractable, false);
        assert.equal(bundle.idKey.extractable, false);
        assert.equal(h.settings.has(ACCOUNT_LOGIN_PENDING_KEY), false);
        assert.ok(h.broadcasts.some(event => event.type === ACCOUNT_LOGIN_EVENT));
        assert.ok(h.broadcasts.some(event => event.type === ACCOUNT_LOGIN_COMPLETE_EVENT));
        // A delayed old tab cannot reactivate X after Y owns the shared session.
        await assert.rejects(syncService.activateAccountScope(X, { checkBinding: true }), /Account changed/);
        assert.equal(h.settings.get('sync-account-scope'), Y);
    });
}

test('canceling Y’s passkey leaves X’s session, keys, tickets and settings untouched', async t => {
    const h = await setup(t, { cancel: true });
    assert.equal(await accountService.unlockWithUsername('second-user'), false);
    assert.equal(accountService.state.accountId, X);
    assert.equal(accountService.state.sessionVerified, true);
    assert.equal(accountService.cryptoKey, 'old-crypto');
    assert.ok(h.oldMaster.every(byte => byte === 3));
    assert.equal(h.settings.get('account-settings').accountId, X);
    assert.deepEqual(h.settings.get('tickets-active'), [{ finalized_ticket: 'x-ticket' }]);
    assert.equal(h.requests.length, 1);
    assert.equal(h.broadcasts.length, 0);
});

test('uncertain login fails closed without deleting X’s wallet or restoring its keys on reload', async t => {
    const h = await setup(t, { failLogin: true });
    assert.equal(await accountService.unlockWithUsername('second-user'), false);
    assert.equal(accountService.state.sessionVerified, false);
    assert.equal(accountService.cryptoKey, null);
    assert.equal(h.settings.get('account-settings').accountId, X);
    assert.deepEqual(h.settings.get('tickets-active'), [{ finalized_ticket: 'x-ticket' }]);
    await assert.rejects(syncService.assertAccountDataAccess(), /Account changed/);
    const load = accountService.loadMasterKey;
    accountService.loadMasterKey = async () => { assert.fail('pending login must not restore old keys'); };
    t.after(() => { accountService.loadMasterKey = load; });
    accountService.state.isReady = false;
    accountService.state.authBootstrapComplete = false;
    await accountService.init();
    assert.equal(accountService.state.authBootstrapComplete, true);
    assert.equal(accountService.state.sessionVerified, false);
});

test('a sign-in in another window invalidates a pending old ceremony without deleting shared keys', async t => {
    const h = await setup(t);
    const originalUnsubscribe = accountService.signOutElsewhereUnsubscribe;
    accountService.signOutElsewhereUnsubscribe = null;
    accountService.listenForSignOutElsewhere();
    t.after(() => {
        accountService.signOutElsewhereUnsubscribe?.();
        accountService.signOutElsewhereUnsubscribe = originalUnsubscribe;
    });
    accountService.state.encryptionMode = 'PRF';
    const generation = accountService.loginGeneration;
    storageEvents.handleMessage({ sender: 'another-window', type: ACCOUNT_LOGIN_EVENT, payload: { accountId: Y } });
    assert.equal(accountService.state.sessionVerified, false);
    assert.equal(accountService.cryptoKey, null);
    assert.equal(accountService.state.oauthKeyringRequired, false, 'another window must not auto-prompt the old Google passkey');
    assert.equal(accountService.state.oauthLegacyPasskeyRequired, false);
    const modal = Object.assign(Object.create(AccountModal.prototype), {
        isOpen: true, accountState: accountService.getState(), recoveryStep: 'idle',
        app: { getSignInPolicy: () => ({ renderEntry: () => '<form>Sign in</form>' }) },
        handleOAuthKeyringUnlock: () => assert.fail('must not unlock the previous Google account'),
        mustStaySignedIn: () => false,
        renderOAuthUnlockUI: () => assert.fail('must not trap the other window on the old unlock card')
    });
    modal.maybeAutoPromptPasskey();
    assert.match(modal.renderAccountUI(), /Restoring your account/);
    assert.doesNotMatch(modal.renderAccountUI(), /old@example/);
    await accountService.reconcileSharedAccount();
    assert.equal(h.settings.get('account-key-bundle-v1').accountId, X, 'notification never deletes shared keys');
    assert.deepEqual(h.settings.get('tickets-active'), [{ finalized_ticket: 'x-ticket' }]);
    await assert.rejects(accountService.completeUsernameLogin({
        accountId: Y, username: 'second-user', loginGeneration: generation,
        prfBytes: new Uint8Array(32)
    }), /Account changed in another window/);
    assert.equal(h.requests.length, 0, 'a superseded prompt cannot change the shared cookie');
});

test('switching back restores the first account’s saved tickets without adopting the second wallet', async t => {
    const h = await setup(t);
    assert.equal(await accountService.unlockWithUsername('second-user'), true);
    // Successful authentication for X would publish its binding before activation.
    h.settings.set('account-settings', { accountId: X });
    await syncService.activateAccountScope(X, { checkBinding: true });
    assert.deepEqual(h.settings.get('tickets-active'), [{ finalized_ticket: 'x-ticket' }]);
    assert.deepEqual(h.settings.get(`sync-account-data:${Y}`)['tickets-active'], [{ finalized_ticket: 'y-ticket' }]);
});

test('a pending login cannot be cleared by cached-key restoration or legacy key migration', async t => {
    const h = await setup(t);
    const marker = { accountId: Y };
    h.settings.set(ACCOUNT_LOGIN_PENDING_KEY, marker);
    assert.equal(await accountService.loadMasterKey(), false,
        'Google cached-key fast path must fall through to fresh passkey unlock');
    assert.equal(await accountService.persistCryptoKeyBundle(X, {}, {}, {}), false);
    assert.equal(await accountService.persistMasterKey(new Uint8Array(32), X), false);
    assert.deepEqual(h.settings.get(ACCOUNT_LOGIN_PENDING_KEY), marker);
    assert.equal(h.settings.get('account-key-bundle-v1').accountId, X);
    // A verified, fresh passkey/keyring unlock can recover the same saved owner.
    assert.equal(await accountService.persistMasterKey(new Uint8Array(32), X, { authenticated: true }), true);
    assert.equal(h.settings.has(ACCOUNT_LOGIN_PENDING_KEY), false);
});

test('delayed expired-session cleanup cannot delete a newer login to the same account', async t => {
    const h = await setup(t);
    let release;
    const scope = syncService.deactivateAccountScope;
    syncService.deactivateAccountScope = async () => new Promise(resolve => { release = resolve; });
    t.after(() => { syncService.deactivateAccountScope = scope; });
    const pending = accountService.handleTokenInvalidation();
    assert.equal(accountService.state.oauthKeyringRequired, false);
    ++accountService.syncInitializationGeneration; // new login acquired the data lock
    const replacement = { accountId: X, cryptoKey: 'fresh-key' };
    h.settings.set('account-key-bundle-v1', replacement);
    accountService.cryptoKey = 'fresh-key';
    release();
    await pending;
    assert.equal(h.settings.get('account-key-bundle-v1'), replacement);
    assert.equal(accountService.cryptoKey, 'fresh-key');
});

test('expiry in a stale signed-out window leaves the other window’s account data alone', async t => {
    const h = await setup(t, { stale: true });
    await accountService.handleTokenInvalidation();
    assert.equal(h.settings.get('sync-account-scope'), X);
    assert.equal(h.settings.get('account-key-bundle-v1').accountId, X);
    assert.deepEqual(h.settings.get('tickets-active'), [{ finalized_ticket: 'x-ticket' }]);
});

async function publishOtherAccount(h) {
    const cryptoKey = await crypto.subtle.importKey('raw', h.targetKey, 'AES-GCM', false, ['encrypt', 'decrypt']);
    const derivationKey = await crypto.subtle.importKey('raw', h.targetKey, 'HKDF', false, ['deriveKey', 'deriveBits']);
    const idKey = await crypto.subtle.importKey('raw', h.targetKey, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    h.settings.set('account-settings', { accountId: Y, username: 'second-user', credentialId: 'y-passkey', encryptionMode: 'PRF' });
    h.settings.set('account-key-bundle-v1', { accountId: Y, cryptoKey, derivationKey, idKey });
}

for (const notified of [true, false]) {
    test(`other window restores Y without another passkey (${notified ? 'notified' : 'missed notification'})`, async t => {
        const h = await setup(t);
        await publishOtherAccount(h);
        if (notified) accountService.beginSharedAccountHandoff();
        await accountService.reconcileSharedAccount();
        assert.equal(accountService.state.accountId, Y);
        assert.equal(accountService.getState().status, 'unlocked');
        assert.equal(accountService.state.sessionVerified, true);
        assert.equal(accountService.state.accountScopeReady, true);
        assert.equal(accountService.state.ticketSyncReady, true);
        assert.equal(accountService.state.accountHandoffPending, false);
        assert.equal(accountService.state.oauthEmail, null);
        assert.equal(accountService.recoveryPayload, null);
        assert.deepEqual(accountService.keyringWrappers, []);
        assert.equal(h.requests.length, 0, 'restoration must not create a new authentication request');
        assert.ok(h.oldMaster.every(byte => byte === 0));
        assert.deepEqual(h.settings.get('tickets-active'), [{ finalized_ticket: 'y-ticket' }]);
        assert.deepEqual(h.settings.get(`sync-account-data:${X}`)['tickets-active'], [{ finalized_ticket: 'x-ticket' }]);
        await syncService.assertAccountDataAccess();
        const iv = new Uint8Array(12);
        const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, accountService.cryptoKey, new Uint8Array([42]));
        assert.deepEqual(new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, accountService.cryptoKey, ciphertext)), new Uint8Array([42]));
    });
}

test('interrupted exchange leaves old keys blocked but ends the handoff loading surface', async t => {
    const h = await setup(t);
    h.settings.set(ACCOUNT_LOGIN_PENDING_KEY, { accountId: Y });
    accountService.beginSharedAccountHandoff();
    await accountService.reconcileSharedAccount();
    assert.equal(accountService.state.accountHandoffPending, false);
    assert.equal(accountService.state.sessionVerified, false);
    assert.equal(accountService.cryptoKey, null);
    assert.equal(h.settings.get(ACCOUNT_LOGIN_PENDING_KEY).accountId, Y);
    assert.deepEqual(h.settings.get('tickets-active'), [{ finalized_ticket: 'x-ticket' }]);
    await assert.rejects(syncService.assertAccountDataAccess(), /Account changed/);
});

test('restoration refuses keys belonging to a different account', async t => {
    const h = await setup(t);
    await publishOtherAccount(h);
    h.settings.get('account-key-bundle-v1').accountId = X;
    await accountService.reconcileSharedAccount();
    assert.equal(accountService.state.sessionVerified, false);
    assert.equal(accountService.cryptoKey, null);
    assert.equal(accountService.state.accountHandoffPending, false);
    assert.deepEqual(h.settings.get('tickets-active'), [{ finalized_ticket: 'x-ticket' }]);
});

test('an absent server session cannot restore Y or delete its shared credentials', async t => {
    const h = await setup(t);
    await publishOtherAccount(h);
    const original = sessionService.verifySession;
    sessionService.verifySession = async () => false;
    t.after(() => { sessionService.verifySession = original; });
    await accountService.reconcileSharedAccount();
    assert.equal(accountService.state.sessionVerified, false);
    assert.equal(accountService.cryptoKey, null);
    assert.equal(accountService.state.accountHandoffPending, false);
    assert.equal(h.settings.get('account-key-bundle-v1').accountId, Y);
});

test('a newer handoff invalidates an in-flight restoration before binding its keys', async t => {
    const h = await setup(t);
    await publishOtherAccount(h);
    let release;
    const original = sessionService.verifySession;
    sessionService.verifySession = () => new Promise(resolve => { release = resolve; });
    t.after(() => { sessionService.verifySession = original; });
    const restoring = accountService.reconcileSharedAccount();
    while (!release) await new Promise(resolve => setImmediate(resolve));
    accountService.beginSharedAccountHandoff();
    release(true);
    await restoring;
    assert.equal(accountService.state.sessionVerified, false);
    assert.equal(accountService.cryptoKey, null);
    assert.deepEqual(h.settings.get('tickets-active'), [{ finalized_ticket: 'x-ticket' }]);
});

test('a transient scope initialization failure can restore the same account on retry', async t => {
    const h = await setup(t);
    await publishOtherAccount(h);
    const activate = syncService.activateAccountScope;
    let failed = false;
    syncService.activateAccountScope = async function (...args) {
        if (!failed) { failed = true; throw new Error('Temporary scope initialization failure'); }
        return activate.apply(this, args);
    };
    t.after(() => { syncService.activateAccountScope = activate; });
    await accountService.reconcileSharedAccount();
    assert.equal(accountService.state.accountId, Y);
    assert.equal(accountService.state.sessionVerified, false);
    assert.equal(accountService.state.accountHandoffPending, false);
    assert.equal(accountService.cryptoKey, null);
    await accountService.reconcileSharedAccount();
    assert.equal(accountService.state.sessionVerified, true);
    assert.equal(accountService.state.accountScopeReady, true);
    assert.equal(accountService.state.ticketSyncReady, true);
    assert.equal(accountService.getState().status, 'unlocked');
    assert.deepEqual(h.settings.get('tickets-active'), [{ finalized_ticket: 'y-ticket' }]);
    assert.equal(h.requests.length, 0);
});
