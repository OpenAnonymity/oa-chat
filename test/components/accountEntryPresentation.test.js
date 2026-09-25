import test from 'node:test';
import assert from 'node:assert/strict';
import AccountModal from '../../chat/components/AccountModal.js';

function harness(overrides = {}) {
    const modal = Object.create(AccountModal.prototype);
    Object.assign(modal, {
        accountState: { authBootstrapComplete: true, passkeySupported: true },
        recoveryStep: 'idle', creationStep: 'idle', isOpen: true, loginViewVersion: 0,
        usernameInputValue: 'river-owl',
        app: { getSignInPolicy: () => ({}), hasPaymentModes: () => true },
        escapeHtml: v => String(v ?? ''), render() {}, ...overrides
    });
    return modal;
}

test('trusted host receives only entry display data; restoration and recovery bypass it', () => {
    const calls = [];
    const modal = harness();
    modal.app.getSignInPolicy = () => ({ required: true, renderEntry: state => { calls.push(state); return 'host entry'; } });
    modal.accountState.secret = 'never exposed';
    assert.equal(modal.renderAccountUI(), 'host entry');
    assert.deepEqual(Object.keys(calls[0]).sort(), ['busy','canClose','canUseWallet','error','hasSavedAccount','passkeySupported','username'].sort());
    assert.equal(calls[0].username, 'river-owl');
    assert.ok(Object.isFrozen(calls[0]));
    modal.accountState.authBootstrapComplete = false;
    assert.match(modal.renderAccountUI(), /Restoring your account/);
    modal.accountState.authBootstrapComplete = true;
    modal.recoveryStep = 'verifying';
    modal.renderRecoveryFlowUI = () => 'recovery';
    assert.equal(modal.renderAccountUI(), 'recovery');
    modal.recoveryStep = 'idle';
    modal.accountState.oauthSetupRequired = true;
    modal.renderOAuthUnlockUI = () => 'passkey setup';
    assert.equal(modal.renderAccountUI(), 'passkey setup');
    assert.equal(calls.length, 1);
});

test('legacy account entry remains available and account-only builds keep their close guard', () => {
    const modal = harness();
    let display;
    modal.app.hasPaymentModes = () => false;
    modal.app.getSignInPolicy = () => ({ required: true, renderEntry: state => { display = state; return 'entry'; } });
    modal.renderAccountUI();
    assert.equal(display.canClose, false);
    assert.equal(display.canUseWallet, false);
    modal.identifierMode = 'accountId';
    modal.formatAccountId = () => '';
    assert.match(modal.renderAccountUI(), /id="account-id-input"/);
});

test('logout renders the host entry after clearing the account, with no intermediate sign-in', async () => {
    const modal = harness();
    const frames = [];
    modal.closeAccountMenu = () => {};
    modal.resetCreationFlow = () => {};
    modal.app.getSignInPolicy = () => ({ renderEntry: () => 'shared landing card' });
    modal.app.getPaymentMode = () => 'tickets';
    modal.render = () => frames.push(modal.loggingOut ? 'logging out' : modal.renderAccountUI());
    modal.accountService = { async clearLocalAccount() { modal.render(); modal.accountState = { passkeySupported: true }; } };
    await modal.handleAccountClear();
    assert.deepEqual(frames, ['logging out', 'logging out', 'shared landing card']);
});



test('wallet entry closes sign-in before switching in place, without an account operation', async () => {
    const events = [];
    const modal = harness();
    modal.close = options => {
        assert.deepEqual(options, { afterAuthentication: true });
        events.push('close'); modal.isOpen = false;
    };
    modal.app.changePaymentMode = async mode => { events.push(mode); };
    await modal.handleWalletEntry();
    assert.deepEqual(events, ['close', 'zkapi']);
    assert.equal(modal.walletEntryPending, false);
});

test('wallet entry preserves the mode-switch guard and restores sign-in on failure', async () => {
    const events = [];
    const trigger = {};
    const modal = harness({ returnFocusEl: trigger, restoreOverlaySidebar: true });
    modal.close = () => { modal.isOpen = false; modal.restoreOverlaySidebar = false; events.push('close'); };
    modal.open = element => {
        assert.equal(element, trigger);
        assert.equal(modal.restoreOverlaySidebar, true);
        modal.accountState.error = null; // Opening clears stale account errors.
        events.push('open');
    };
    modal.accountService = { setError: message => { modal.accountState.error = message; events.push(message); } };
    modal.app.changePaymentMode = async () => { throw new Error('Finish or stop the current response before switching payment methods.'); };
    await modal.handleWalletEntry();
    assert.deepEqual(events, ['close', 'open', 'Finish or stop the current response before switching payment methods.']);
    assert.equal(modal.accountState.error, 'Finish or stop the current response before switching payment methods.');
    assert.equal(modal.walletEntryPending, false);
});

test('wallet entry cannot overlap authentication, recovery or another wallet entry', async () => {
    for (const override of [
        { isOpen: false }, { walletEntryPending: true }, { loggingOut: true },
        { accountState: { busy: true } }, { usernameContinuePending: true },
        { creationStep: 'oauth_authorizing' }, { recoveryStep: 'verifying' }
    ]) {
        const modal = harness(override);
        modal.close = () => assert.fail('must not close');
        modal.app.changePaymentMode = () => assert.fail('must not switch');
        await modal.handleWalletEntry();
    }
    const modal = harness();
    modal.app.hasPaymentModes = () => false;
    await modal.handleWalletEntry();
});

test('wallet entry ignores repeat clicks while the payment runtime is pending', async () => {
    let release;
    let calls = 0;
    const modal = harness();
    modal.close = () => {};
    modal.app.changePaymentMode = () => { calls++; return new Promise(resolve => { release = resolve; }); };
    const pending = modal.handleWalletEntry();
    await modal.handleWalletEntry();
    assert.equal(calls, 1);
    release();
    await pending;
    assert.equal(modal.walletEntryPending, false);
});

test('the wallet control consumes the click and invokes the in-app handler', async t => {
    const previousDocument = globalThis.document;
    t.after(() => { globalThis.document = previousDocument; });
    const button = {};
    globalThis.document = { getElementById: id => id === 'account-wallet-entry-btn' ? button : null };
    const modal = harness();
    let prevented = false;
    modal.handleWalletEntry = async () => { assert.equal(prevented, true); return 'switched'; };
    modal.attachEventListeners();
    assert.equal(await button.onclick({ preventDefault() { prevented = true; } }), 'switched');
});
