import assert from 'node:assert/strict';
import test from 'node:test';

import accountService from '../../chat/services/accountService.js';
import sessionService from '../../chat/services/sessionService.js';

test('username continuation reserves new names and selects login only on a typed conflict', async () => {
    const originalFetch = sessionService.fetch;
    const originalState = { ...accountService.state };
    const originalContinuity = accountService.localAccountContinuity;
    let requests = [];
    let response;
    let challengeResponse;
    accountService.state.accountId = null;
    accountService.localAccountContinuity = false;
    sessionService.fetch = async (url, options) => {
        requests.push({ url, body: JSON.parse(options.body) });
        return url.endsWith('/auth/challenge') ? challengeResponse : response;
    };
    const jsonResponse = (status, body) => new Response(JSON.stringify(body), { status });
    try {
        // A returning user must not hit /auth/init or its registration quota.
        const challenge = { accountId: '1234567890123456', challengeId: 'challenge-123' };
        challengeResponse = jsonResponse(200, challenge);
        assert.deepEqual(await accountService.prepareUsernameContinuation(' Winter-Owl '), {
            kind: 'login', challenge: { username: 'winter-owl', data: challenge }
        });
        assert.equal(requests.length, 1);
        assert.ok(requests[0].url.endsWith('/auth/challenge'));
        requests = [];
        // Reusable lightweight response shim for repeated unknown-name lookups.
        challengeResponse = { ok: false, status: 401, json: async () => ({ code: 'AUTHENTICATION_FAILED' }) };
        response = jsonResponse(200, { accountId: '1234567890123456', username: 'winter-owl' });
        assert.deepEqual(await accountService.prepareUsernameContinuation(' Winter-Owl '), { kind: 'register' });
        assert.equal(accountService.getPendingUsername(), 'winter-owl');
        assert.equal(requests.length, 2);
        assert.ok(requests[1].url.endsWith('/auth/init'));
        assert.deepEqual(requests[1].body, { username: 'winter-owl' });

        for (const body of [
            { error: 'Username is unavailable', code: 'USERNAME_UNAVAILABLE' },
            { detail: { error: 'Username is unavailable', code: 'USERNAME_UNAVAILABLE' } }
        ]) {
            response = jsonResponse(409, body);
            assert.deepEqual(await accountService.prepareUsernameContinuation('winter-owl'), { kind: 'login' });
            assert.equal(accountService.getPendingAccountId(), null);
        }

        for (const status of [400, 401, 409, 429, 500]) {
            response = jsonResponse(status, { error: 'Request failed' });
            await assert.rejects(accountService.prepareUsernameContinuation('winter-owl'));
            assert.equal(accountService.getPendingAccountId(), null);
        }
        response = jsonResponse(500, { code: 'USERNAME_UNAVAILABLE' });
        await assert.rejects(accountService.prepareUsernameContinuation('winter-owl'));
        for (const status of [401, 404, 429, 500]) {
            requests = [];
            challengeResponse = jsonResponse(status, { error: 'Lookup failed' });
            await assert.rejects(accountService.prepareUsernameContinuation('winter-owl'));
            assert.equal(requests.length, 1);
            assert.ok(requests[0].url.endsWith('/auth/challenge'));
        }
        sessionService.fetch = async () => { throw new Error('Network unavailable'); };
        await assert.rejects(accountService.prepareUsernameContinuation('winter-owl'), /Network unavailable/);

        // Blank input cannot accidentally invoke the legacy no-body initializer.
        requests = [];
        sessionService.fetch = async () => { requests.push('unexpected'); };
        await assert.rejects(accountService.prepareUsernameContinuation(''));
        await assert.rejects(accountService.prepareUsernameContinuation('not-an-email@example.com'));
        assert.deepEqual(requests, []);

        accountService.state.accountId = '1234567890123456';
        assert.deepEqual(await accountService.prepareUsernameContinuation('another-name'), { kind: 'login' });
        accountService.state.accountId = null;
        accountService.localAccountContinuity = true;
        assert.deepEqual(await accountService.prepareUsernameContinuation('another-name'), { kind: 'login' });
        assert.deepEqual(requests, []);
    } finally {
        accountService.cancelPendingAccount();
        sessionService.fetch = originalFetch;
        Object.assign(accountService.state, originalState);
        accountService.localAccountContinuity = originalContinuity;
    }
});

test('continuation reuses one account-bound challenge and cancellation never initializes an account', async () => {
    const originalFetch = sessionService.fetch;
    const originalState = { ...accountService.state };
    const originalContinuity = accountService.localAccountContinuity;
    const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    const requests = [];
    let prompts = 0;
    Object.assign(accountService.state, {
        accountId: null, username: null, busy: false, passkeySupported: true
    });
    accountService.localAccountContinuity = false;
    sessionService.fetch = async url => {
        requests.push(url);
        assert.ok(url.endsWith('/auth/challenge'));
        return new Response(JSON.stringify({
            accountId: '1234567890123456',
            challengeId: 'opaque-challenge',
            publicKey: { challenge: 'Y2hhbGxlbmdl', rpId: 'localhost' }
        }), { status: 200 });
    };
    Object.defineProperty(globalThis, 'navigator', {
        configurable: true,
        value: { credentials: { async get() {
            prompts += 1;
            throw Object.assign(new Error('Canceled'), { name: 'NotAllowedError' });
        } } }
    });
    try {
        const next = await accountService.prepareUsernameContinuation('winter-owl');
        assert.equal(await accountService.unlockWithUsername('winter-owl', {
            preparedChallenge: next.challenge
        }), false);
        assert.equal(requests.length, 1);
        assert.equal(prompts, 1);

        assert.equal(await accountService.unlockWithUsername('different-name', {
            preparedChallenge: next.challenge
        }), false);
        assert.equal(requests.length, 1);
        assert.equal(prompts, 1);
        assert.equal(accountService.getPendingAccountId(), null);
    } finally {
        sessionService.fetch = originalFetch;
        Object.assign(accountService.state, originalState);
        accountService.localAccountContinuity = originalContinuity;
        if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator);
        else delete globalThis.navigator;
    }
});

test('lookup-only explanation never reserves a name; setup challenge is created at the later click', async () => {
    const originalFetch = sessionService.fetch;
    const originalState = { ...accountService.state };
    const originalContinuity = accountService.localAccountContinuity;
    const requests = [];
    let now = 0;
    let challengeCreatedAt;
    Object.assign(accountService.state, { accountId: null });
    accountService.localAccountContinuity = false;
    sessionService.fetch = async url => {
        requests.push(url);
        if (url.endsWith('/auth/challenge')) return new Response(JSON.stringify({ code: 'AUTHENTICATION_FAILED' }), { status: 401 });
        assert.ok(url.endsWith('/auth/init'));
        challengeCreatedAt = now;
        return new Response(JSON.stringify({ accountId: '1234567890123456', username: 'winter-owl' }));
    };
    try {
        for (let attempt = 0; attempt < 2; attempt += 1) {
            assert.deepEqual(await accountService.prepareUsernameContinuation('winter-owl', { lookupOnly: true }), { kind: 'register' });
            assert.equal(accountService.hasPendingAccount(), false);
            // Reading the card, or Back → Continue, outlives a 60-second challenge.
            now += 90_000;
            accountService.cancelPendingAccount();
        }
        assert.equal(challengeCreatedAt, undefined);
        assert.equal(requests.filter(url => url.endsWith('/auth/init')).length, 0);
        await accountService.prepareAccount('winter-owl');
        assert.equal(challengeCreatedAt, now);
        assert.equal(accountService.getPendingUsername(), 'winter-owl');
    } finally {
        accountService.cancelPendingAccount();
        sessionService.fetch = originalFetch;
        Object.assign(accountService.state, originalState);
        accountService.localAccountContinuity = originalContinuity;
    }
});

test('a cancelled initializer cannot replace a newer pending account', async () => {
    const originalFetch = sessionService.fetch;
    const originalState = { ...accountService.state };
    const originalContinuity = accountService.localAccountContinuity;
    let finishOld;
    Object.assign(accountService.state, { accountId: null });
    accountService.localAccountContinuity = false;
    sessionService.fetch = async (url, options) => {
        const { username } = JSON.parse(options.body);
        if (username === 'old-name') return new Promise(resolve => { finishOld = resolve; });
        return new Response(JSON.stringify({ accountId: '2222222222222222', username }));
    };
    try {
        const old = accountService.prepareAccount('old-name');
        const rejected = assert.rejects(old, /cancelled/);
        await accountService.prepareAccount('new-name');
        const replacement = accountService.pendingAccount;
        finishOld(new Response(JSON.stringify({ accountId: '1111111111111111', username: 'old-name' })));
        await rejected;
        assert.equal(accountService.pendingAccount, replacement);
        assert.equal(accountService.getPendingUsername(), 'new-name');
    } finally {
        accountService.cancelPendingAccount();
        sessionService.fetch = originalFetch;
        Object.assign(accountService.state, originalState);
        accountService.localAccountContinuity = originalContinuity;
    }
});

test('cancelled credential operations cannot write into a replacement pending account', async () => {
    const originalState = { ...accountService.state };
    const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    accountService.state.passkeySupported = true;
    try {
        for (const succeeds of [false, true]) {
            let finish;
            let started;
            const nativeStarted = new Promise(resolve => { started = resolve; });
            Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { credentials: {
                create: () => new Promise((resolve, reject) => {
                    finish = () => succeeds
                        ? resolve({ getClientExtensionResults() { throw new Error('stale credential was inspected'); } })
                        : reject(Object.assign(new Error('cancelled'), { name: 'NotAllowedError' }));
                    started();
                })
            } } });
            accountService.pendingAccount = { accountId: '1111111111111111', username: 'old-name', masterKey: new Uint8Array(32), initData: {} };
            const registration = accountService.registerPasskeyForPreparedAccount();
            await nativeStarted;
            accountService.cancelPendingAccount();
            const replacement = { accountId: '2222222222222222', username: 'new-name' };
            accountService.pendingAccount = replacement;
            accountService.state.error = 'New view error';
            finish();
            assert.equal(await registration, false);
            assert.equal(accountService.pendingAccount, replacement);
            assert.equal(replacement.credential, undefined);
            assert.equal(accountService.state.error, 'New view error');
        }
    } finally {
        accountService.cancelPendingAccount();
        Object.assign(accountService.state, originalState);
        if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator);
        else delete globalThis.navigator;
    }
});

test('cancelled registration finalization cannot install a zeroed key or replace account state', async () => {
    const originalFetch = sessionService.fetch;
    const originalState = { ...accountService.state };
    const originalMasterKey = accountService.masterKey;
    const pending = () => ({
        accountId: '1111111111111111', username: 'old-name', masterKey: new Uint8Array(32).fill(7), prfBytes: new Uint8Array(32).fill(9),
        credential: { id: 'fixture', type: 'public-key', rawId: new ArrayBuffer(0), response: { clientDataJSON: new ArrayBuffer(0), attestationObject: new ArrayBuffer(0) } }
    });
    try {
        let requests = 0;
        sessionService.fetch = async () => { requests += 1; return new Response('{}'); };
        accountService.pendingAccount = pending();
        const beforeSend = accountService.completeAccountRegistration();
        accountService.cancelPendingAccount();
        await assert.rejects(beforeSend, /cancelled/);
        assert.equal(requests, 0);

        let finish;
        let sent;
        const requestSent = new Promise(resolve => { sent = resolve; });
        sessionService.fetch = async () => new Promise(resolve => { finish = resolve; sent(); });
        accountService.pendingAccount = pending();
        const inFlight = accountService.completeAccountRegistration();
        await requestSent;
        accountService.cancelPendingAccount();
        accountService.state.accountId = '2222222222222222';
        finish(new Response('{}'));
        await assert.rejects(inFlight, /cancelled/);
        assert.equal(accountService.state.accountId, '2222222222222222');
        assert.equal(accountService.masterKey, originalMasterKey);
    } finally {
        accountService.cancelPendingAccount();
        sessionService.fetch = originalFetch;
        Object.assign(accountService.state, originalState);
        accountService.masterKey = originalMasterKey;
    }
});
