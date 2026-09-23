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


