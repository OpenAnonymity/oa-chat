import test from 'node:test';
import assert from 'node:assert/strict';
import AccountModal from '../../chat/components/AccountModal.js';
import { routeAuthenticationIntent } from '../../chat/application/authIntent.js';

function fixture(t, { fail = false } = {}) {
    const previousDocument = globalThis.document;
    globalThis.document = { getElementById: () => null };
    t.after(() => { globalThis.document = previousDocument; });
    let state = { accountId: 'old-google', googleLinked: true, sessionVerified: true,
        oauthKeyringRequired: true, status: 'unlocked', authBootstrapComplete: true };
    let notify;
    let release;
    const cleanup = new Promise(resolve => { release = resolve; });
    const frames = [];
    const calls = [];
    const notices = [];
    const replacements = [];
    const service = {
        getState: () => state,
        subscribe(fn) { notify = fn; return () => {}; },
        async waitForAuthBootstrap() {},
        async clearLocalAccount() {
            calls.push('clear');
            state = { ...state, sessionVerified: false };
            notify(state);
            await cleanup;
            if (fail) throw new Error('cleanup failed');
            state = { accountId: null, status: 'none', authBootstrapComplete: true };
            notify(state);
        },
        setError(error) { state = { ...state, error }; notify(state); }
    };
    const modal = new AccountModal({
        services: { account: service, sync: { getStatus: () => ({}), subscribe: () => () => {} } },
        signInRequiredNow: () => true,
        showToast: message => notices.push(message)
    });
    modal.overlay = {};
    modal.open = () => { modal.isOpen = true; modal.render(); modal.maybeAutoPromptPasskey(); };
    modal.render = () => frames.push(modal.usernameHandoffPending ? 'waiting' : 'form');
    modal.focusModal = () => {};
    modal.handleOAuthKeyringUnlock = () => calls.push('old-passkey');
    modal.handleAccountContinue = async () => { calls.push(`continue:${modal.usernameInputValue}`); };
    const routing = () => routeAuthenticationIntent({
        accountService: service, accountModal: modal,
        locationImpl: { pathname: '/', search: '?auth=username', hash: '#username=Winter-OWL' },
        historyImpl: { replaceState(...args) { replacements.push(args); } }
    });
    return { modal, calls, frames, notices, replacements, release, cleanup, routing, state: () => state };
}

test('Google to username arrival authenticates once without clearing the old account', async t => {
    const f = fixture(t);
    await f.routing();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(f.calls, ['continue:winter-owl']);
    assert.equal(f.state().accountId, 'old-google');
    assert.equal(f.state().sessionVerified, true);
    assert.equal(f.frames[0], 'waiting');
});

test('an idle restoration form is reused for the submitted username', async t => {
    const f = fixture(t);
    f.modal.isOpen = true;
    await f.routing();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(f.calls, ['continue:winter-owl']);
    assert.equal(f.modal.getIdentifierMode(), 'username');
    assert.equal(f.frames[0], 'waiting');
});

for (const active of ['authenticationExitPending', 'busy']) {
    test(`account switching never clears an account during an active ceremony: ${active}`, async t => {
        const f = fixture(t);
        f.modal.isOpen = true;
        if (active === 'busy') f.state().busy = true;
        else f.modal.authenticationExitPending = true;
        assert.deepEqual(await f.routing(), { handled: true, action: 'blocked' });
        assert.deepEqual(f.calls, []);
        assert.deepEqual(f.frames, []);
        assert.deepEqual(f.replacements, [], 'retain the requested username for retry after the active ceremony');
        assert.match(f.notices[0], /reload to switch accounts/);
    });
}

test('reusing an idle restoration dialog retires its scheduled old-account explanation', async t => {
    const f = fixture(t);
    f.modal.isOpen = true;
    f.modal.oauthIntroPending = true;
    const previousVersion = f.modal.loginViewVersion;
    let cleared = false;
    f.modal.clearAnimationTimeouts = () => { cleared = true; };
    const routed = f.routing();
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(cleared, true);
    assert.equal(f.modal.oauthIntroPending, false);
    assert.equal(f.modal.loginViewVersion, previousVersion + 1);
    f.release();
    await routed;
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(f.calls, ['continue:winter-owl']);
});
