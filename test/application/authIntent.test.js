import assert from 'node:assert/strict';
import test from 'node:test';

import {
    clearAuthenticationIntent,
    getAuthenticationIntent,
    routeAuthenticationIntent
} from '../../chat/application/authIntent.js';

function createHarness(state, search = '?auth=google&billingDemo=1') {
    let releaseBootstrap;
    const bootstrap = new Promise(resolve => { releaseBootstrap = resolve; });
    const replacements = [];
    let opens = 0;
    const accountService = {
        getState: () => ({ ...state }),
        waitForAuthBootstrap: () => bootstrap
    };
    const locationImpl = {
        pathname: '/chat/',
        search,
        hash: '#latest'
    };
    const historyImpl = {
        state: { preserved: true },
        replaceState(...args) { replacements.push(args); }
    };
    return {
        accountService,
        accountModal: { open() { opens += 1; } },
        locationImpl,
        historyImpl,
        releaseBootstrap,
        replacements,
        get opens() { return opens; }
    };
}

test('authentication intent parsing and cleanup preserve unrelated route state', () => {
    const locationImpl = {
        pathname: '/chat/',
        search: '?auth=google&billingDemo=1',
        hash: '#latest'
    };
    const calls = [];
    const historyImpl = {
        state: { route: 'chat' },
        replaceState(...args) { calls.push(args); }
    };

    assert.equal(getAuthenticationIntent(locationImpl), 'google');
    assert.equal(clearAuthenticationIntent(locationImpl, historyImpl), true);
    assert.deepEqual(calls, [[{ route: 'chat' }, '', '/chat/?billingDemo=1#latest']]);
    assert.equal(getAuthenticationIntent({ search: '?auth=unknown' }), null);
});

test('remembered unlocked account enters chat without opening Account', async () => {
    const harness = createHarness({
        accountId: '1234567890123456',
        sessionVerified: true,
        status: 'unlocked'
    });
    const routing = routeAuthenticationIntent(harness);

    await Promise.resolve();
    assert.equal(harness.opens, 0);
    assert.equal(harness.replacements.length, 0);

    harness.releaseBootstrap();
    assert.deepEqual(await routing, { handled: true, action: 'continue' });
    assert.equal(harness.opens, 0);
    assert.equal(harness.replacements.length, 1);
});

test('signed-out authentication intent opens only the Google sign-in surface', async () => {
    const harness = createHarness({
        accountId: null,
        sessionVerified: false,
        status: 'none'
    });
    const routing = routeAuthenticationIntent(harness);
    harness.releaseBootstrap();

    assert.deepEqual(await routing, { handled: true, action: 'sign-in' });
    assert.equal(harness.opens, 1);
});

test('verified locked account opens the encryption-passkey surface', async () => {
    const harness = createHarness({
        accountId: '1234567890123456',
        sessionVerified: true,
        status: 'locked',
        oauthKeyringRequired: true
    });
    const routing = routeAuthenticationIntent(harness);
    harness.releaseBootstrap();

    assert.deepEqual(await routing, { handled: true, action: 'unlock' });
    assert.equal(harness.opens, 1);
});

test('ordinary chat loads do not wait for auth or open a dialog', async () => {
    const harness = createHarness({}, '?billingDemo=1');
    assert.deepEqual(await routeAuthenticationIntent(harness), {
        handled: false,
        action: 'none'
    });
    assert.equal(harness.opens, 0);
    assert.equal(harness.replacements.length, 0);
});
