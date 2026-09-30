import assert from 'node:assert/strict';
import test from 'node:test';

import { chatDB } from '../../chat/db.js';
import accountService, { isPreviousVersionAccountRecord } from '../../chat/services/accountService.js';
import syncService from '../../chat/services/encryptedSyncService.js';
import sessionService from '../../chat/services/sessionService.js';

// Exactly what the previous production client (oa-chat origin/prod 420e4cb)
// persisted for an account.
const OLD_RECORD = Object.freeze({
    accountId: 'K7M39QX2HT4PW8LD',
    credentialId: 'cXVpZXQtb2xkLWNyZWRlbnRpYWw',
    recoveryConfirmed: true,
    updatedAt: 1788000000000
});

// What this client persists: every field present, some null.
const CURRENT_RECORD = Object.freeze({
    accountId: 'N3W4ACCT7Q2L9XPD',
    username: null,
    credentialId: 'bmV3LWNyZWRlbnRpYWw',
    encryptionCredentialId: null,
    encryptionMode: 'LEGACY_PASSKEY',
    recoveryConfirmed: true,
    googleLinked: false,
    lastOAuthProvider: null,
    oauthEmail: null,
    updatedAt: 1790000000000
});

const WALLET = Object.freeze([{ finalized_ticket: 'AAIA-old-1' }, { finalized_ticket: 'AAIA-old-2' }]);

function installBrowser(initial) {
    const settings = new Map(Object.entries(initial));
    const writes = [];
    const originals = {
        db: chatDB.db,
        init: chatDB.init,
        getSetting: chatDB.getSetting,
        saveSetting: chatDB.saveSetting,
        deleteSetting: chatDB.deleteSetting,
        updateSettings: chatDB.updateSettings,
        sessionInit: sessionService.init,
        verifySession: sessionService.verifySession,
        deactivateAccountScope: syncService.deactivateAccountScope,
        setLocalAccountScope: syncService.setLocalAccountScope
    };
    chatDB.db = {};
    chatDB.init = async () => {};
    chatDB.getSetting = async key => settings.get(key);
    chatDB.saveSetting = async (key, value) => { writes.push(['save', key]); settings.set(key, value); };
    chatDB.deleteSetting = async key => { writes.push(['delete', key]); settings.delete(key); };
    chatDB.updateSettings = async (entries = [], deleteKeys = []) => {
        for (const { key, value } of entries) { writes.push(['save', key]); settings.set(key, value); }
        for (const key of deleteKeys) { writes.push(['delete', key]); settings.delete(key); }
    };
    sessionService.init = async () => {};
    sessionService.verifySession = async () => false;
    const scopes = [];
    syncService.deactivateAccountScope = async accountId => { scopes.push(['deactivate', accountId]); };
    syncService.setLocalAccountScope = accountId => { scopes.push(['local', accountId]); };
    const restore = () => {
        Object.assign(chatDB, {
            db: originals.db,
            init: originals.init,
            getSetting: originals.getSetting,
            saveSetting: originals.saveSetting,
            deleteSetting: originals.deleteSetting,
            updateSettings: originals.updateSettings
        });
        sessionService.init = originals.sessionInit;
        sessionService.verifySession = originals.verifySession;
        syncService.deactivateAccountScope = originals.deactivateAccountScope;
        syncService.setLocalAccountScope = originals.setLocalAccountScope;
        accountService.resetSavedAccountState();
        accountService.cryptoKey = null;
        accountService.configure({ releasePreviousVersionAccounts: false });
        accountService.releasedPreviousVersionAccount = false;
        accountService.previousVersionRelease = null;
        syncService.localScopeAccountId = null;
        accountService.state.isReady = false;
        accountService.state.authBootstrapComplete = false;
        accountService.updateStatus();
    };
    accountService.state.isReady = false;
    accountService.state.authBootstrapComplete = false;
    accountService.state.accountId = null;
    accountService.releasedPreviousVersionAccount = false;
    accountService.previousVersionRelease = null;
    return { settings, writes, scopes, restore };
}

async function oldBrowser(extra = {}) {
    const key = await crypto.subtle.importKey('raw', new Uint8Array(32), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
    return installBrowser({
        'account-settings': OLD_RECORD,
        'account-master-crypto-key': key,
        'account-master-key-bytes': new Uint8Array(32),
        'tickets-active': WALLET,
        ...extra
    });
}

test('only a record in the previous client’s shape counts as previous-version', () => {
    assert.equal(isPreviousVersionAccountRecord(OLD_RECORD), true);
    assert.equal(isPreviousVersionAccountRecord({ accountId: 'X', updatedAt: 1 }), true);
    assert.equal(isPreviousVersionAccountRecord(CURRENT_RECORD), false);
    assert.equal(isPreviousVersionAccountRecord({ ...OLD_RECORD, username: null }), false);
    assert.equal(isPreviousVersionAccountRecord({ ...OLD_RECORD, googleLinked: false }), false);
    assert.equal(isPreviousVersionAccountRecord({ credentialId: 'c' }), false);
    assert.equal(isPreviousVersionAccountRecord(null), false);
});

test('with the host policy on, a previous-version account is forgotten on first load and the wallet stays', async () => {
    const browser = await oldBrowser();
    try {
        accountService.configure({ releasePreviousVersionAccounts: true });
        await accountService.init();
        assert.equal(accountService.releasedPreviousVersionAccount, true);
        assert.equal(accountService.state.accountId, null);
        assert.equal(accountService.localAccountContinuity, false);
        assert.equal(accountService.getState().hasSavedAccountBinding, false);
        assert.equal(accountService.state.status, 'none');
        assert.equal(browser.settings.has('account-settings'), false);
        assert.equal(browser.settings.has('account-master-crypto-key'), false);
        assert.equal(browser.settings.has('account-master-key-bytes'), false);
        assert.deepEqual(browser.settings.get('tickets-active'), WALLET, 'tickets are never touched');
        assert.ok(!browser.writes.some(([, key]) => key === 'tickets-active' || key === 'tickets-archive'));
        // The browser continues as a signed-out visitor: anonymous scope, so
        // a new account adopts this wallet.
        assert.deepEqual(browser.scopes, [['deactivate', null], ['local', null]]);
        // Asked again (the scope gate and init share one check): no second release.
        assert.equal(await accountService.releasePreviousVersionAccountIfNeeded(), true);
        assert.equal(browser.writes.filter(([op, key]) => op === 'delete' && key === 'account-settings').length, 1);
    } finally {
        browser.restore();
    }
});

test('without the host policy the saved account is kept, as before', async () => {
    const browser = await oldBrowser();
    try {
        await accountService.init();
        assert.equal(accountService.releasedPreviousVersionAccount, false);
        assert.equal(accountService.state.accountId, OLD_RECORD.accountId);
        assert.equal(browser.settings.has('account-settings'), true);
    } finally {
        browser.restore();
    }
});

test('a record this client has already used is never released', async () => {
    for (const extra of [
        { 'account-key-bundle-v1': { accountId: OLD_RECORD.accountId } },
        { 'sync-account-scope': OLD_RECORD.accountId },
        { 'account-login-pending': { accountId: OLD_RECORD.accountId } }
    ]) {
        const browser = await oldBrowser(extra);
        try {
            accountService.configure({ releasePreviousVersionAccounts: true });
            await accountService.init();
            assert.equal(accountService.releasedPreviousVersionAccount, false, JSON.stringify(Object.keys(extra)));
            assert.equal(browser.settings.has('account-settings'), true);
        } finally {
            browser.restore();
        }
    }
    const current = installBrowser({ 'account-settings': CURRENT_RECORD });
    try {
        accountService.configure({ releasePreviousVersionAccounts: true });
        await accountService.init();
        assert.equal(accountService.releasedPreviousVersionAccount, false);
        assert.equal(accountService.state.accountId, CURRENT_RECORD.accountId);
    } finally {
        current.restore();
    }
});

test('configure ignores anything but an explicit boolean', () => {
    accountService.configure({ releasePreviousVersionAccounts: 'yes' });
    assert.equal(accountService.releasePreviousVersionAccounts, false);
    accountService.configure({});
    assert.equal(accountService.releasePreviousVersionAccounts, false);
    accountService.configure({ releasePreviousVersionAccounts: true });
    assert.equal(accountService.releasePreviousVersionAccounts, true);
    accountService.configure({ releasePreviousVersionAccounts: false });
    assert.equal(accountService.releasePreviousVersionAccounts, false);
});

test('the wallet’s data scope waits for the release, so it never opens under the old account', async () => {
    const browser = await oldBrowser();
    const recorder = syncService.setLocalAccountScope;
    // The real scope, as the ticket store sees it.
    syncService.setLocalAccountScope = Object.getPrototypeOf(syncService).setLocalAccountScope;
    try {
        accountService.configure({ releasePreviousVersionAccounts: true });
        syncService.localScopeAccountId = null;
        // The ticket store asks for its scope before account init has run.
        const scope = await syncService.bootstrapLocalAccountScope();
        assert.equal(scope, null, 'not the previous-version account');
        assert.equal(browser.settings.has('account-settings'), false);
        assert.deepEqual(browser.settings.get('tickets-active'), WALLET);
        await accountService.init();
        assert.equal(accountService.state.accountId, null);
        assert.equal(browser.writes.filter(([op, key]) => op === 'delete' && key === 'account-settings').length, 1);
    } finally {
        syncService.setLocalAccountScope = recorder;
        browser.restore();
    }
});

test('without the host policy the scope reads the saved account at once', async () => {
    const browser = await oldBrowser();
    try {
        syncService.localScopeAccountId = null;
        assert.equal(syncService.localScopeGate, null);
        const realSetLocal = Object.getPrototypeOf(syncService).setLocalAccountScope;
        syncService.setLocalAccountScope = realSetLocal;
        assert.equal(await syncService.bootstrapLocalAccountScope(), OLD_RECORD.accountId);
    } finally {
        browser.restore();
    }
});

test('a scope picked before the host configured the release is dropped, and stores are told', async () => {
    const browser = await oldBrowser();
    const recorder = syncService.setLocalAccountScope;
    syncService.setLocalAccountScope = Object.getPrototypeOf(syncService).setLocalAccountScope;
    const events = [];
    const unsubscribe = syncService.subscribe(payload => { events.push([payload.event, payload.data]); });
    try {
        // A preference read at startup, before configure(): the old account.
        syncService.localScopeAccountId = null;
        assert.equal(await syncService.bootstrapLocalAccountScope(), OLD_RECORD.accountId);
        accountService.configure({ releasePreviousVersionAccounts: true });
        // The ticket store opens next: it waits for the release and gets
        // the anonymous scope, not the one read earlier.
        assert.equal(await syncService.bootstrapLocalAccountScope(), null);
        await new Promise(resolve => setImmediate(resolve));
        assert.deepEqual(events, [['account_scope_changed', { accountId: null }]]);
        assert.deepEqual(browser.settings.get('tickets-active'), WALLET);
    } finally {
        unsubscribe?.();
        syncService.setLocalAccountScope = recorder;
        browser.restore();
    }
});

test('an unreadable marker keeps the saved account', async () => {
    const browser = await oldBrowser();
    const getSetting = chatDB.getSetting;
    chatDB.getSetting = async key => {
        if (key === 'sync-account-scope') throw new Error('IndexedDB read failed');
        return getSetting(key);
    };
    try {
        accountService.configure({ releasePreviousVersionAccounts: true });
        await accountService.init();
        assert.equal(accountService.releasedPreviousVersionAccount, false);
        assert.equal(browser.settings.has('account-settings'), true);
    } finally {
        browser.restore();
    }
});
