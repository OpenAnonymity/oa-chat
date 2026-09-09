import assert from 'node:assert/strict';
import test from 'node:test';

import {
    accountMatchesAuthenticationIntent,
    clearAuthenticationIntent,
    getAuthenticationIntent,
    getOAuthCompletionToken,
    getUsernameAuthenticationValue,
    routeAuthenticationIntent
} from '../../chat/application/authIntent.js';

function createHarness(state, search = '?auth=google&billingDemo=1', hash = '#latest') {
    let currentState = { ...state };
    let releaseBootstrap;
    const bootstrap = new Promise(resolve => { releaseBootstrap = resolve; });
    const replacements = [];
    let opens = 0;
    let clears = 0;
    const usernameOpens = [];
    const usernameOptions = [];
    const completions = [];
    const accountService = {
        getState: () => ({ ...currentState }),
        waitForAuthBootstrap: () => bootstrap,
        async clearLocalAccount() {
            clears += 1;
            currentState = {
                accountId: null,
                username: null,
                googleLinked: false,
                oauthProvider: null,
                sessionVerified: false,
                status: 'none'
            };
        }
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
            openForUsername(username, returnFocusEl, options) {
                usernameOpens.push(username);
                usernameOptions.push(options);
                return new Promise(() => {}); // A native prompt must not block Chat startup.
            },
            openForOAuthCompletion(provider, token) {
                completions.push([provider, token]);
                return new Promise(() => {});
            }
        },
        locationImpl,
        historyImpl,
        releaseBootstrap,
        replacements,
        usernameOpens,
        usernameOptions,
        completions,
        get opens() { return opens; },
        get clears() { return clears; }
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

test('authentication intents match only the requested identity partition', () => {
    assert.equal(accountMatchesAuthenticationIntent({
        accountId: 'google-account',
        googleLinked: true
    }, 'google'), true);
    assert.equal(accountMatchesAuthenticationIntent({
        accountId: 'username-account',
        username: 'Winter-OWL'
    }, 'username', ' winter-owl '), true);
    assert.equal(accountMatchesAuthenticationIntent({
        accountId: 'username-account',
        username: 'winter-owl'
    }, 'google'), false);
    assert.equal(accountMatchesAuthenticationIntent({
        accountId: 'google-account',
        googleLinked: true
    }, 'username', 'winter-owl'), false);
    assert.equal(accountMatchesAuthenticationIntent({
        accountId: 'username-account',
        username: 'winter-owl'
    }, 'username', ''), false);
});

test('remembered unlocked Google account enters chat without opening Account', async () => {
    const harness = createHarness({
        accountId: '1234567890123456',
        googleLinked: true,
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
    assert.equal(harness.clears, 0);
    assert.equal(harness.replacements.length, 1);
});

test('Google intent signs out a remembered username account before opening sign-in', async () => {
    const harness = createHarness({
        accountId: 'username-account',
        username: 'winter-owl',
        googleLinked: false,
        sessionVerified: true,
        status: 'unlocked'
    });
    const routing = routeAuthenticationIntent(harness);
    harness.releaseBootstrap();

    assert.deepEqual(await routing, { handled: true, action: 'sign-in' });
    assert.equal(harness.clears, 1);
    assert.equal(harness.opens, 1);
    assert.deepEqual(harness.usernameOpens, []);
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
    assert.equal(harness.clears, 0);
    assert.equal(harness.opens, 1);
});

test('signed-out username intent starts the passkey handoff without blocking Chat startup', async () => {
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
    assert.deepEqual(harness.usernameOptions, [{ autoContinue: true }]);
    assert.equal(harness.clears, 0);
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
    assert.equal(harness.clears, 0);
    assert.equal(harness.opens, 0);
    assert.deepEqual(harness.usernameOpens, []);
    assert.deepEqual(harness.replacements, [[{ preserved: true }, '', '/chat/']]);
});

test('username intent signs out a different remembered username before its handoff', async () => {
    const harness = createHarness({
        accountId: 'summer-fox-account',
        username: 'summer-fox',
        sessionVerified: true,
        status: 'unlocked'
    }, '?auth=username', '#username=Winter-OWL');
    const routing = routeAuthenticationIntent(harness);
    harness.releaseBootstrap();

    assert.deepEqual(await routing, { handled: true, action: 'sign-in' });
    assert.equal(harness.clears, 1);
    assert.equal(harness.opens, 0);
    assert.deepEqual(harness.usernameOpens, ['winter-owl']);
});

test('username intent signs out a remembered Google account before its handoff', async () => {
    const harness = createHarness({
        accountId: 'google-account',
        googleLinked: true,
        sessionVerified: true,
        status: 'unlocked'
    }, '?auth=username', '#username=winter-owl');
    const routing = routeAuthenticationIntent(harness);
    harness.releaseBootstrap();

    assert.deepEqual(await routing, { handled: true, action: 'sign-in' });
    assert.equal(harness.clears, 1);
    assert.deepEqual(harness.usernameOpens, ['winter-owl']);
});

test('username intent without a username keeps the remembered account binding', async () => {
    const harness = createHarness({
        accountId: 'summer-fox-account',
        username: 'summer-fox',
        sessionVerified: true,
        status: 'unlocked'
    }, '?auth=username', '');
    const routing = routeAuthenticationIntent(harness);
    harness.releaseBootstrap();

    assert.deepEqual(await routing, { handled: true, action: 'unlock' });
    assert.equal(harness.clears, 0);
    assert.deepEqual(harness.usernameOpens, ['']);
});

test('verified locked account opens the encryption-passkey surface', async () => {
    const harness = createHarness({
        accountId: '1234567890123456',
        googleLinked: true,
        sessionVerified: true,
        status: 'locked',
        oauthKeyringRequired: true
    });
    const routing = routeAuthenticationIntent(harness);
    harness.releaseBootstrap();

    assert.deepEqual(await routing, { handled: true, action: 'unlock' });
    assert.equal(harness.clears, 0);
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

const COMPLETION_TOKEN = 'b'.repeat(43);

test('a landing-page Google completion token rides in the fragment and is stripped from the route', () => {
    const locationImpl = {
        pathname: '/',
        search: '?auth=google',
        hash: `#oauth=${COMPLETION_TOKEN}&section=latest`
    };
    assert.equal(getOAuthCompletionToken(locationImpl), COMPLETION_TOKEN);
    assert.equal(getOAuthCompletionToken({ search: '?auth=username', hash: locationImpl.hash }), null);
    assert.equal(getOAuthCompletionToken({ search: '?auth=google', hash: '#oauth=short' }), null);
    assert.equal(getOAuthCompletionToken({ search: '?auth=google', hash: '' }), null);
    const calls = [];
    const historyImpl = { state: null, replaceState(...args) { calls.push(args); } };
    assert.equal(clearAuthenticationIntent(locationImpl, historyImpl), true);
    assert.deepEqual(calls, [[null, '', '/#section=latest']]);
});

test('signed-out Google intent with a completion token finishes the session instead of asking again', async () => {
    const harness = createHarness({
        accountId: null,
        sessionVerified: false,
        status: 'none'
    }, '?auth=google', `#oauth=${COMPLETION_TOKEN}`);
    const routing = routeAuthenticationIntent(harness);
    harness.releaseBootstrap();

    assert.deepEqual(await routing, { handled: true, action: 'complete' });
    assert.equal(harness.opens, 0);
    assert.deepEqual(harness.completions, [['google', COMPLETION_TOKEN]]);
    assert.match(harness.replacements[0][2], /^\/chat\/$/);
});

test('a completion token still signs out a remembered username account first', async () => {
    const harness = createHarness({
        accountId: 'username-account',
        username: 'winter-owl',
        googleLinked: false,
        sessionVerified: true,
        status: 'unlocked'
    }, '?auth=google', `#oauth=${COMPLETION_TOKEN}`);
    const routing = routeAuthenticationIntent(harness);
    harness.releaseBootstrap();

    assert.deepEqual(await routing, { handled: true, action: 'complete' });
    assert.equal(harness.clears, 1);
    assert.equal(harness.opens, 0);
    assert.deepEqual(harness.completions, [['google', COMPLETION_TOKEN]]);
});
