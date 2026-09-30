import assert from 'node:assert/strict';
import test from 'node:test';

import accountService, { HELD_REGISTRATION_MS } from '../../chat/services/accountService.js';
import sessionService from '../../chat/services/sessionService.js';

function fakeSessionStorage() {
    const values = new Map();
    return {
        getItem: key => (values.has(key) ? values.get(key) : null),
        setItem: (key, value) => { values.set(key, String(value)); },
        removeItem: key => { values.delete(key); },
        values
    };
}

async function withService(fn) {
    const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
    const originalFetch = sessionService.fetch;
    const originalState = { ...accountService.state };
    const originalContinuity = accountService.localAccountContinuity;
    const storage = fakeSessionStorage();
    Object.defineProperty(globalThis, 'sessionStorage', { value: storage, configurable: true, writable: true });
    Object.assign(accountService.state, { accountId: null, username: null });
    accountService.localAccountContinuity = false;
    try {
        await fn(storage);
    } finally {
        accountService.cancelPendingAccount();
        sessionService.fetch = originalFetch;
        Object.assign(accountService.state, originalState);
        accountService.localAccountContinuity = originalContinuity;
        if (originalStorage) Object.defineProperty(globalThis, 'sessionStorage', originalStorage);
        else delete globalThis.sessionStorage;
    }
}

const initData = {
    accountId: '1234567890123456',
    username: 'winter-owl',
    challenge: 'Y2hhbGxlbmdl',
    publicKey: { challenge: 'Y2hhbGxlbmdl', rp: { id: 'chat.example', name: 'OA' }, user: { id: 'dXNlcg', name: 'winter-owl', displayName: 'winter-owl' } }
};

test('a reservation survives a reload for the same name, and only for that name', () => withService(async storage => {
    sessionService.fetch = async () => new Response(JSON.stringify(initData), { status: 200 });
    await accountService.prepareAccount('winter-owl');
    assert.ok(storage.getItem('oa-held-username-registration-v1'), 'kept for this tab');
    const reservedAt = accountService.getPendingReservedAt();
    assert.ok(reservedAt > 0);

    // The page reloads: memory is gone, the tab's storage is not.
    accountService.cancelPendingAccount();
    assert.equal(accountService.resumeHeldRegistration('another-owl'), null);
    const resumed = accountService.resumeHeldRegistration(' Winter-Owl ');
    assert.deepEqual(resumed, { username: 'winter-owl', accountId: '1234567890123456', at: reservedAt });
    assert.equal(accountService.getPendingAccountId(), '1234567890123456');
    assert.equal(accountService.getPendingUsername(), 'winter-owl');

    // A browser that has an account saved never resumes someone's sign-up.
    accountService.cancelPendingAccount();
    accountService.state.accountId = '6543210987654321';
    assert.equal(accountService.resumeHeldRegistration('winter-owl'), null);
    accountService.state.accountId = null;

    // Past its life (the challenge behind it is gone): dropped.
    const saved = JSON.parse(storage.getItem('oa-held-username-registration-v1'));
    storage.setItem('oa-held-username-registration-v1', JSON.stringify({ ...saved, at: Date.now() - HELD_REGISTRATION_MS - 1 }));
    assert.equal(accountService.resumeHeldRegistration('winter-owl'), null);
    assert.equal(storage.getItem('oa-held-username-registration-v1'), null);

    // The server refused it: nothing to resume.
    storage.setItem('oa-held-username-registration-v1', JSON.stringify(saved));
    accountService.forgetHeldRegistration();
    assert.equal(accountService.resumeHeldRegistration('winter-owl'), null);
}));

test('an account the server made without a session is an error, not "created"', () => withService(async storage => {
    sessionService.fetch = async () => new Response(JSON.stringify(initData), { status: 200 });
    await accountService.prepareAccount('winter-owl');
    const pending = accountService.pendingAccount;
    pending.credential = {
        id: 'Y3JlZA', rawId: new Uint8Array([1, 2, 3]).buffer, type: 'public-key',
        response: { clientDataJSON: new Uint8Array([1]).buffer, attestationObject: new Uint8Array([2]).buffer },
        getClientExtensionResults: () => ({})
    };
    pending.prfBytes = new Uint8Array(32).fill(7);
    sessionService.fetch = async () => new Response(JSON.stringify({ success: true }), { status: 200 });
    const originalExists = sessionService.doesSessionExist;
    sessionService.doesSessionExist = async () => false;
    try {
        await assert.rejects(accountService.completeAccountRegistration(), error => {
            assert.equal(error.code, 'SESSION_NOT_ESTABLISHED');
            assert.equal(error.accountCreated, true);
            assert.match(error.message, /didn’t keep you signed in/);
            return true;
        });
        assert.equal(storage.getItem('oa-held-username-registration-v1'), null, 'the challenge is spent');
        assert.equal(accountService.state.accountId, null);
    } finally {
        sessionService.doesSessionExist = originalExists;
    }
}));
