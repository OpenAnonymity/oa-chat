import test from 'node:test';
import assert from 'node:assert/strict';
import accountService from '../../chat/services/accountService.js';
import sessionService from '../../chat/services/sessionService.js';

// The first send on the web build waits for the wallet scope and, when the
// wallet is short, for the first encrypted sync. Both start in initializeSync,
// which must begin as soon as the saved session is confirmed, not after the
// cosmetic identity refresh and its burst-protection delay.
test('a restored session starts its wallet scope and sync before the identity refresh delay', async () => {
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
    const order = [];
    let releaseDelay = () => {};
    Object.assign(accountService.state, {
        accountId: '1234567890123456', authBootstrapComplete: false, sessionVerified: false,
        oauthEmail: 'member@example.test', busy: false
    });
    accountService.cryptoKey = {};
    accountService.syncDerivationKey = {};
    accountService.syncIdKey = {};
    sessionService.verifySession = async () => true;
    accountService.refreshOAuthLinkStatuses = async () => { order.push('identity refresh'); return true; };
    accountService.persistSettings = async () => {};
    accountService.initializeSync = async () => { order.push('sync initialization'); };
    globalThis.setTimeout = (callback, delay) => {
        if (delay === 1000) { order.push('burst delay'); releaseDelay = callback; return 1; }
        return originals.setTimeout(callback, delay);
    };
    try {
        const verification = accountService.verifySessionInBackground();
        await new Promise(resolve => setImmediate(resolve));
        assert.deepEqual(order, ['sync initialization', 'burst delay']);
        releaseDelay();
        await verification;
        assert.deepEqual(order, ['sync initialization', 'burst delay', 'identity refresh']);
    } finally {
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

test('initializeSync publishes the activation in flight and clears it when it settles', async () => {
    const originals = { run: accountService.runSyncInitialization, inFlight: accountService.syncInitializationInFlight };
    let release;
    accountService.runSyncInitialization = () => new Promise(resolve => { release = resolve; });
    try {
        const starting = accountService.initializeSync(false);
        assert.equal(accountService.syncInitializationInFlight, starting);
        release(true);
        assert.equal(await starting, true);
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(accountService.syncInitializationInFlight, null);
    } finally {
        accountService.runSyncInitialization = originals.run;
        accountService.syncInitializationInFlight = originals.inFlight;
    }
});
