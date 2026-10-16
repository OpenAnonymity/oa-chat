import test from 'node:test';
import assert from 'node:assert/strict';
import { chatDB } from '../../chat/db.js';
import accountService from '../../chat/services/accountService.js';
import syncService from '../../chat/services/encryptedSyncService.js';
import sessionService from '../../chat/services/sessionService.js';

function setup(t, { response = () => Response.json({ last_sync: 10 }), visible = true, schema = 3 } = {}) {
    const originals = { document: globalThis.document, setInterval: globalThis.setInterval,
        clearInterval: globalThis.clearInterval, fetch: sessionService.fetch,
        getSetting: chatDB.getSetting, state: { ...accountService.state },
        enabled: syncService.isEnabled, active: syncService.isAccountScopeActive,
        sync: syncService.sync, accountId: syncService.accountId, generation: syncService.credentialGeneration };
    const timers = new Map();
    let visibility, statusRequests = 0, fullSyncs = 0;
    globalThis.document = { visibilityState: visible ? 'visible' : 'hidden',
        addEventListener: (_name, listener) => { visibility = listener; },
        removeEventListener: () => { visibility = null; } };
    globalThis.setInterval = (callback, delay) => { const id = timers.size + 1; timers.set(id, { callback, delay }); return id; };
    globalThis.clearInterval = id => timers.delete(id);
    chatDB.getSetting = async key => key === 'sync-schema-version' ? schema : 10;
    sessionService.fetch = async url => { assert.match(String(url), /\/auth\/sync\/status$/); statusRequests++; return response(); };
    syncService.isEnabled = () => true;
    syncService.isAccountScopeActive = async () => true;
    // Model a full sync that has not established readiness. The real status
    // request/parser and the real AccountService event subscriber run below.
    syncService.sync = async () => { fullSyncs++; return { success: false, error: 'synthetic full-sync failure' }; };
    syncService.accountId = 'synthetic-current-account';
    Object.assign(accountService.state, { accountId: syncService.accountId, isReady: true,
        sessionVerified: true, status: 'unlocked', accountScopeReady: true, ticketSyncReady: false });
    t.after(() => {
        syncService.stopPeriodicSync();
        Object.assign(globalThis, { document: originals.document, setInterval: originals.setInterval, clearInterval: originals.clearInterval });
        sessionService.fetch = originals.fetch; chatDB.getSetting = originals.getSetting;
        syncService.isEnabled = originals.enabled; syncService.isAccountScopeActive = originals.active;
        syncService.sync = originals.sync; syncService.accountId = originals.accountId;
        syncService.credentialGeneration = originals.generation;
        Object.assign(accountService.state, originals.state);
    });
    return { timers, counts: () => ({ statusRequests, fullSyncs }), show: () => { document.visibilityState = 'visible'; visibility(); } };
}
const settle = () => new Promise(resolve => setImmediate(resolve));

test('restored up-to-date wallet becomes billing-ready without waiting five minutes or suppressing full sync', async t => {
    const h = setup(t);
    syncService.startPeriodicSync();
    await settle();
    assert.equal(accountService.state.ticketSyncReady, true);
    assert.deepEqual(h.counts(), { statusRequests: 1, fullSyncs: 1 });
    const periodic = [...h.timers.values()].find(timer => timer.delay === 30_000);
    await periodic.callback();
    assert.equal(h.counts().fullSyncs, 2, 'deferred local spends still upload on fixed cadence');
});

for (const [name, response] of [
    ['newer remote data', () => Response.json({ last_sync: 11 })],
    ['invalid response', () => Response.json({ last_sync: 'invalid' })],
    ['HTTP failure', () => new Response('{}', { status: 503 })]
]) test(`startup status ${name} cannot unlock billing`, async t => {
    const h = setup(t, { response });
    syncService.startPeriodicSync(); await settle();
    assert.equal(h.counts().statusRequests, 1);
    assert.equal(accountService.state.ticketSyncReady, false);
});

test('hidden startup checks status once on first visibility without changing subsequent foreground cadence', async t => {
    const h = setup(t, { visible: false });
    syncService.startPeriodicSync(); await settle();
    assert.deepEqual(h.counts(), { statusRequests: 0, fullSyncs: 0 });
    h.show(); await settle();
    assert.equal(accountService.state.ticketSyncReady, true);
    assert.deepEqual(h.counts(), { statusRequests: 1, fullSyncs: 1 });
    h.show(); await settle();
    assert.deepEqual(h.counts(), { statusRequests: 1, fullSyncs: 2 });
});

test('a startup status response from the old credentials cannot unlock a new account', async t => {
    let release;
    const h = setup(t, { response: () => new Promise(resolve => { release = resolve; }) });
    syncService.startPeriodicSync(); await settle();
    assert.equal(h.counts().statusRequests, 1);
    syncService.credentialGeneration++;
    syncService.accountId = 'synthetic-next-account';
    accountService.state.accountId = syncService.accountId;
    release(Response.json({ last_sync: 10 })); await settle();
    assert.equal(accountService.state.ticketSyncReady, false);
});


test('an equal server timestamp cannot unlock a wallet that still needs schema replay', async t => {
    const h = setup(t, { schema: 2 });
    syncService.startPeriodicSync(); await settle();
    assert.equal(h.counts().statusRequests, 1);
    assert.equal(accountService.state.ticketSyncReady, false);
    assert.ok(h.counts().fullSyncs >= 1, 'schema replay stays on the normal full-sync path');
});
