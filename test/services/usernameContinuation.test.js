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
