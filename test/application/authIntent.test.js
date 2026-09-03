import assert from 'node:assert/strict';
import test from 'node:test';

import {
    clearAuthenticationIntent,
    getAuthenticationIntent,
    getUsernameAuthenticationValue,
    routeAuthenticationIntent
} from '../../chat/application/authIntent.js';

function createHarness(state, search = '?auth=google&billingDemo=1', hash = '#latest') {
    let releaseBootstrap;
    const bootstrap = new Promise(resolve => { releaseBootstrap = resolve; });
    const replacements = [];
    let opens = 0;
    const usernameOpens = [];
    const accountService = {
        getState: () => ({ ...state }),
        waitForAuthBootstrap: () => bootstrap
    };
    const locationImpl = {
        pathname: '/chat/',
        search,
        hash
    };
    const historyImpl = {
        state: { preserved: true },
        replaceState(...args) { replacements.push(args); }
    };
    return {
        accountService,
        accountModal: {
            open() { opens += 1; },
            openForUsername(username) { usernameOpens.push(username); }
        },
        locationImpl,
        historyImpl,
        releaseBootstrap,
        replacements,
        usernameOpens,
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

test('username authentication intent normalizes its value and removes it from the route', () => {
    const locationImpl = {
        pathname: '/chat/',
        search: '?auth=username&billingDemo=1',
        hash: '#username=%20Winter-OWL%20&section=latest'
    };
    const calls = [];
    const historyImpl = {
        state: { route: 'chat' },
        replaceState(...args) { calls.push(args); }
    };

    assert.equal(getAuthenticationIntent(locationImpl), 'username');
    assert.equal(getUsernameAuthenticationValue(locationImpl), 'winter-owl');
    assert.equal(clearAuthenticationIntent(locationImpl, historyImpl), true);
    assert.deepEqual(calls, [[{ route: 'chat' }, '', '/chat/?billingDemo=1#section=latest']]);
    assert.equal(getUsernameAuthenticationValue({ search: '?auth=google', hash: '#username=keep' }), null);
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

test('signed-out username intent prefills the username sign-in surface', async () => {
    const harness = createHarness({
        accountId: null,
        sessionVerified: false,
        status: 'none'
    }, '?auth=username&billingDemo=1', '#username=Winter-OWL');
    const routing = routeAuthenticationIntent(harness);
    harness.releaseBootstrap();

    assert.deepEqual(await routing, { handled: true, action: 'sign-in' });
    assert.equal(harness.opens, 0);
    assert.deepEqual(harness.usernameOpens, ['winter-owl']);
    assert.deepEqual(harness.replacements, [[
        { preserved: true },
        '',
        '/chat/?billingDemo=1'
    ]]);
});

test('remembered unlocked username account consumes the handoff without opening Account', async () => {
    const harness = createHarness({
        accountId: '1234567890123456',
        username: 'winter-owl',
        sessionVerified: true,
        status: 'unlocked'
    }, '?auth=username', '#username=winter-owl');
    const routing = routeAuthenticationIntent(harness);
    harness.releaseBootstrap();

    assert.deepEqual(await routing, { handled: true, action: 'continue' });
    assert.equal(harness.opens, 0);
    assert.deepEqual(harness.usernameOpens, []);
    assert.deepEqual(harness.replacements, [[{ preserved: true }, '', '/chat/']]);
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
