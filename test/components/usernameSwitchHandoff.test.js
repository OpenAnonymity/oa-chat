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

test('Google to username arrival waits through cleanup and continues once without a second form', async t => {
    const f = fixture(t);
    const routed = f.routing();
    await Promise.resolve();
    await Promise.resolve();
    assert.deepEqual(f.calls, ['clear']);
    assert.ok(f.frames.length > 0 && f.frames.every(frame => frame === 'waiting'));
    await f.modal.openForUsername('duplicate', null, { autoContinue: true, beforeContinue: () => { throw new Error('duplicate cleanup'); } });
    assert.equal(f.modal.usernameInputValue, 'winter-owl');
    f.release();
    await routed;
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(f.calls, ['clear', 'continue:winter-owl']);
    assert.equal(f.modal.usernameAccountCleanupPending, false);
});

test('failed previous-account cleanup never starts the new username authentication', async t => {
    const f = fixture(t, { fail: true });
    const routed = assert.rejects(f.routing(), /cleanup failed/);
    await Promise.resolve();
    f.release();
    await routed;
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(f.calls, ['clear']);
    assert.match(f.state().error, /Could not finish switching accounts/);
    assert.equal(f.modal.usernameHandoffPending, false);
    assert.equal(f.modal.usernameAccountCleanupPending, false);
});

test('an idle form opened by restoration is reused and cannot be dismissed during account cleanup', async t => {
    const f = fixture(t);
    f.modal.isOpen = true;
    const routed = f.routing();
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(f.modal.usernameAccountCleanupPending, true);
    f.modal.handleCloseAttempt();
    assert.equal(f.modal.isOpen, true);
    assert.ok(f.frames.length > 0 && f.frames.every(frame => frame === 'waiting'));
    f.release();
    await routed;
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(f.calls, ['clear', 'continue:winter-owl']);
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
    assert.deepEqual(f.calls, ['clear', 'continue:winter-owl']);
});
