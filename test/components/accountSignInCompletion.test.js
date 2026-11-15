import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import AccountModal from '../../chat/components/AccountModal.js';
import accountService from '../../chat/services/accountService.js';

const ready = { accountId: 'account-y', sessionVerified: true, status: 'unlocked', accountScopeReady: true, busy: false };

function harness(t, initial) {
    const previousDocument = globalThis.document;
    globalThis.document = { getElementById: () => null, removeEventListener() {} };
    let publish;
    const modal = new AccountModal({ services: {
        account: { getState: () => initial, subscribe(fn) { publish = fn; return () => {}; } },
        sync: { getStatus: () => ({}), subscribe: () => () => {} }
    } });
    modal.isOpen = true;
    let closed = 0, rendered = 0;
    modal.close = options => { assert.equal(options.afterAuthentication, true); closed++; modal.isOpen = false; };
    modal.render = () => { rendered++; };
    modal.maybeAutoPromptPasskey = () => {};
    t.after(() => { modal.destroy(); globalThis.document = previousDocument; });
    return { modal, publish, closed: () => closed, rendered: () => rendered };
}

test('startup never schedules a passkey for the remembered account', () => {
    assert.equal(typeof accountService.maybeAutoUnlock, 'undefined');
    const source = fs.readFileSync(`${process.cwd()}/chat/app.js`, 'utf8');
    assert.doesNotMatch(source, /maybeAutoUnlock/);
});

test('an external sign-in closes the login dialog only after its wallet scope is ready', t => {
    const h = harness(t, { accountId: 'account-x', sessionVerified: false, status: 'locked', accountScopeReady: false });
    h.publish({ ...ready, accountScopeReady: false });
    assert.equal(h.closed(), 0);
    h.publish(ready);
    assert.equal(h.closed(), 1);
    const rendered = h.rendered();
    h.publish({ ...ready, ticketSyncReady: true });
    assert.equal(h.closed(), 1);
    assert.equal(h.rendered(), rendered, 'must not redraw the old Account / Sync now surface');
});

test('an already authenticated Account settings dialog stays open on updates', t => {
    const h = harness(t, ready);
    h.publish({ ...ready, ticketSyncReady: true });
    assert.equal(h.closed(), 0);
});

test('restoration becoming idle closes a dialog whose scope became ready while busy', t => {
    const h = harness(t, { ...ready, busy: true });
    h.publish(ready);
    assert.equal(h.closed(), 1);
});

for (const flow of ['oauth_authorizing', 'confirming', 'recovery']) {
    test(`external state does not interrupt the ${flow} completion handler`, t => {
        const h = harness(t, { sessionVerified: false, status: 'locked' });
        h.modal.creationStep = flow;
        h.publish(ready);
        assert.equal(h.closed(), 0);
    });
}

test('an explicit passkey handler retains ownership of its completion', t => {
    const h = harness(t, { sessionVerified: false, status: 'locked' });
    h.modal.authenticationExitPending = true;
    h.publish(ready);
    assert.equal(h.closed(), 0);
});

test('busy Google completion reports a failure without starting a second authentication', async t => {
    const previousWindow = globalThis.window;
    globalThis.window = { open() { assert.fail('must not open another provider popup'); } };
    t.after(() => { globalThis.window = previousWindow; });
    const service = new accountService.constructor();
    service.state.busy = true;
    const result = await service.authenticateWithOAuth('google', { completionToken: 'x'.repeat(43) });
    assert.equal(result, null);
    assert.match(service.state.error, /Could not finish signing in/);
    assert.equal(service.state.busy, true, 'must not clear the other authentication operation');
});

test('a null OAuth completion cannot quietly return to login', async () => {
    const state = {};
    const modal = Object.assign(Object.create(AccountModal.prototype), {
        render() {},
        accountService: {
            authenticateWithOAuth: async () => null,
            getState: () => state,
            setError: error => { state.error = error; }
        }
    });
    await modal.handleOAuthAuthentication('google', { completionToken: 'x'.repeat(43) });
    assert.equal(modal.creationStep, 'idle');
    assert.equal(modal.oauthHandoffPending, false);
    assert.equal(state.error, 'Could not finish signing in. Please try again.');
});
