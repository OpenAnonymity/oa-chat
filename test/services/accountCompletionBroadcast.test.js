import assert from 'node:assert/strict';
import test from 'node:test';
import accountService, { ACCOUNT_LOGIN_COMPLETE_EVENT } from '../../chat/services/accountService.js';
import storageEvents from '../../chat/services/storageEvents.js';
import sessionService from '../../chat/services/sessionService.js';

function harness(t) {
    const originalInit = storageEvents.init, originalBroadcast = storageEvents.broadcast;
    const sent = [];
    storageEvents.init = () => {};
    storageEvents.broadcast = (type, payload) => sent.push({ type, payload });
    const service = new accountService.constructor();
    t.after(() => { storageEvents.init = originalInit; storageEvents.broadcast = originalBroadcast; });
    return { service, sent };
}

test('completion broadcasts contain only the current ready account, never key material', t => {
    const { service, sent } = harness(t);
    Object.assign(service.state, { accountId: 'new-account', sessionVerified: true, accountScopeReady: true });
    service.broadcastAccountReady('old-account');
    assert.equal(sent.length, 0);
    service.state.accountScopeReady = false;
    service.broadcastAccountReady('new-account');
    assert.equal(sent.length, 0);
    service.state.accountScopeReady = true;
    service.state.sessionVerified = false;
    service.broadcastAccountReady('new-account');
    assert.equal(sent.length, 0);
    service.state.sessionVerified = true;
    service.broadcastAccountReady('new-account');
    assert.deepEqual(sent, [{ type: ACCOUNT_LOGIN_COMPLETE_EVENT, payload: { accountId: 'new-account' } }]);
});

test('Google key unlock announces completion after persistence and scope initialization', async t => {
    const { service, sent } = harness(t);
    Object.assign(service.state, { accountId: 'google-account', sessionVerified: true, accountScopeReady: false });
    service.persistMasterKey = async () => true;
    service.persistSettings = async () => { assert.equal(sent.length, 0); };
    service.initializeSync = async () => {
        assert.equal(sent.length, 0);
        service.syncInitializationGeneration++;
        service.state.accountScopeReady = true;
        return true;
    };
    assert.equal(await service.finishOAuthKeyUnlock(new Uint8Array(32), 'credential'), true);
    assert.deepEqual(sent, [{ type: ACCOUNT_LOGIN_COMPLETE_EVENT, payload: { accountId: 'google-account' } }]);
});

test('a new username account announces completion after its wallet scope is ready', async t => {
    const storageBefore = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
    const storage = new Map();
    Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) } });
    t.after(() => storageBefore ? Object.defineProperty(globalThis, 'sessionStorage', storageBefore) : delete globalThis.sessionStorage);
    const { service, sent } = harness(t);
    const originalFetch = sessionService.fetch, originalSession = sessionService.doesSessionExist;
    t.after(() => { sessionService.fetch = originalFetch; sessionService.doesSessionExist = originalSession; });
    service.pendingAccount = {
        accountId: '1234567890123456', username: 'test-user',
        masterKey: new Uint8Array(32).fill(1), prfBytes: new Uint8Array(32).fill(2),
        credential: { id: 'credential', rawId: new Uint8Array([1]).buffer, type: 'public-key', response: {
            clientDataJSON: new Uint8Array([2]).buffer, attestationObject: new Uint8Array([3]).buffer
        } }
    };
    sessionService.fetch = async () => new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    sessionService.doesSessionExist = async () => true;
    service.persistSettings = async () => { assert.equal(sent.length, 0); };
    service.persistMasterKey = async () => true;
    service.initializeSync = async () => {
        assert.equal(sent.length, 0);
        service.state.accountScopeReady = true;
        return true;
    };
    assert.equal(await service.completeAccountRegistration(), true);
    assert.deepEqual(sent, [{ type: ACCOUNT_LOGIN_COMPLETE_EVENT, payload: { accountId: '1234567890123456' } }]);
});
