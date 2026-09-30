import assert from 'node:assert/strict';
import test from 'node:test';

import AccountModal from '../../chat/components/AccountModal.js';
import { isAmbiguousAccountFailure, toFriendlyAccountError } from '../../chat/domain/accountErrors.js';
import { positionAppToast } from '../../chat/ui/toastPosition.js';

// Sign-up robustness (2026-09-30 stress test): each test names the state a
// person could land in before the fix.

function signupModal(overrides = {}) {
    const modal = Object.create(AccountModal.prototype);
    const calls = [];
    Object.assign(modal, {
        isOpen: true,
        loginViewVersion: 0,
        usernameContinuePending: false,
        usernamePasskeyBusy: false,
        identifierMode: 'username',
        usernameInputValue: 'winter-owl',
        creationStep: 'idle',
        animationTimeouts: [],
        accountState: { passkeySupported: true },
        render() { calls.push(['render']); },
        focusModal() {},
        escapeHtml: value => String(value ?? ''),
        accountService: {
            clearErrors() {},
            setError(message) { calls.push(['error', message]); },
            async prepareUsernameContinuation(username) {
                calls.push(['lookup', username]);
                return { kind: 'register' };
            },
            async prepareAccount(username) { calls.push(['init', username]); },
            getPendingAccountId() { return '1234567890123456'; },
            getPendingReservedAt() { return 1000; },
            cancelPendingAccount() { calls.push(['cancel']); },
            forgetHeldRegistration() { calls.push(['forget-hold']); },
            clearLocalAccount: async () => { calls.push(['forget-account']); },
            hasPendingAccount: () => true
        },
        app: { showToast() {} },
        ...overrides
    });
    return { modal, calls };
}

test('a second Enter during the passkey wait lands on the dialog, not its invisible Close', () => {
    const focused = [];
    const close = { id: 'close-account-modal', focus: () => focused.push('close'), closest: () => waitingCard };
    const waitingCard = { focus: () => focused.push('dialog') };
    const modal = Object.create(AccountModal.prototype);
    Object.assign(modal, {
        isOpen: true,
        overlay: {
            contains: () => true,
            querySelector: selector => selector.includes('data-waiting') ? waitingCard : null,
            querySelectorAll: () => [close]
        }
    });
    modal.focusModal();
    assert.deepEqual(focused, ['dialog']);
    assert.deepEqual(modal.getModalFocusable(), [], 'the hidden card has no Tab stops');
});

test('a sheet the browser refuses right after a click says so instead of redrawing the same card', async () => {
    const { modal } = signupModal({
        generatedUsername: 'winter-owl',
        generatedAccountId: '1234567890123456',
        creationStep: 'passkey',
        sheetFromClick: true
    });
    modal.accountService.registerPasskeyForPreparedAccount = async () => {
        modal.accountState = { ...modal.accountState, error: 'Passkey creation was cancelled' };
        return false;
    };
    await modal.handlePasskeyRegistration();
    assert.equal(modal.creationStep, 'username_ready');
    assert.match(modal.creationError, /didn’t open the passkey prompt/);

    // Refused without a click (the activation from Enter lapsed): the plain
    // Create passkey card, nothing to explain.
    const second = signupModal({
        generatedUsername: 'winter-owl', generatedAccountId: '1234567890123456', creationStep: 'passkey', sheetFromClick: false
    }).modal;
    second.accountService.registerPasskeyForPreparedAccount = async () => {
        second.accountState = { ...second.accountState, error: 'Passkey creation was cancelled' };
        return false;
    };
    await second.handlePasskeyRegistration();
    assert.equal(second.creationError, null);
});

test('a finish whose reply was lost signs in to the new account on Try again, not "unavailable"', async () => {
    const { modal, calls } = signupModal({
        generatedUsername: 'winter-owl',
        generatedAccountId: '1234567890123456',
        creationStep: 'passkey'
    });
    modal.accountService.registerPasskeyForPreparedAccount = async () => true;
    modal.accountService.completeAccountRegistration = async () => {
        throw Object.assign(new TypeError('Failed to fetch'));
    };
    await modal.handlePasskeyRegistration();
    assert.equal(modal.creationStep, 'username_ready');
    assert.equal(modal.registrationUnconfirmed, true);
    assert.match(modal.creationError, /couldn’t confirm your new account/);

    // Try again: the name exists now, so it is a sign-in with the new passkey.
    modal.accountService.prepareUsernameContinuation = async username => {
        calls.push(['lookup', username]);
        return { kind: 'login' };
    };
    modal.handleAccountPasskeyUnlock = async () => { calls.push(['login', modal.usernameInputValue]); return true; };
    await modal.handleUsernamePasskeyContinue();
    assert.deepEqual(calls.filter(([kind]) => ['lookup', 'login', 'init'].includes(kind)), [
        ['lookup', 'winter-owl'],
        ['login', 'winter-owl']
    ]);
});

test('a server that refuses the finish still reserves afresh on Try again', async () => {
    const { modal } = signupModal({
        generatedUsername: 'winter-owl', generatedAccountId: '1234567890123456', creationStep: 'passkey'
    });
    modal.accountService.registerPasskeyForPreparedAccount = async () => true;
    modal.accountService.completeAccountRegistration = async () => {
        throw Object.assign(new Error('Challenge expired or invalid'), { status: 400, code: 'INVALID_CHALLENGE' });
    };
    await modal.handlePasskeyRegistration();
    assert.equal(modal.registrationUnconfirmed, false);
    assert.match(modal.creationError, /took a little too long/);
});

test('a new name on a browser that remembers another account offers Forget, which keeps the new name', async () => {
    const { modal, calls } = signupModal({ usernameInputValue: 'new-owl' });
    modal.accountService.prepareUsernameContinuation = async () => {
        throw Object.assign(new Error('This browser remembers “saved-owl”. Forget it to create a new account.'), {
            code: 'SAVED_ACCOUNT_MISMATCH'
        });
    };
    modal.takeHeldRegistration = () => null;
    await modal.handleAccountContinue();
    assert.equal(modal.savedAccountMismatch, true);
    assert.deepEqual(calls.find(([kind]) => kind === 'error'), [
        'error', 'This browser remembers “saved-owl”. Forget it to create a new account.'
    ]);
    modal.resetCreationFlow = () => {};
    await modal.handleForgetSavedAccount();
    assert.ok(calls.some(([kind]) => kind === 'forget-account'));
    assert.equal(modal.usernameInputValue, 'new-owl');
    assert.equal(modal.savedAccountMismatch, false);
});

test('after a reload the same name picks up this browser’s own reservation', () => {
    const { modal, calls } = signupModal();
    modal.heldRegistration = null;
    modal.accountService.resumeHeldRegistration = username => {
        calls.push(['resume', username]);
        return { username, accountId: '1234567890123456', at: 1000 };
    };
    assert.deepEqual(modal.takeHeldRegistration('winter-owl'), { username: 'winter-owl', accountId: '1234567890123456', at: 1000 });
    assert.deepEqual(calls, [['resume', 'winter-owl']]);
});

test('a hold counts from the reservation, not from when the sheet was dismissed', () => {
    const { modal } = signupModal({
        generatedUsername: 'winter-owl', generatedAccountId: '1234567890123456', creationStep: 'passkey'
    });
    modal.resetCreationFlow = () => {};
    modal.returnToUsernameForm('', { hold: true });
    assert.equal(modal.heldRegistration.at, 1000);
});

test('someone who typed a name that is not theirs is told what may have happened', () => {
    const { modal } = signupModal({ usernameInputValue: 'taken-owl', usernameUnlockReady: true });
    modal.accountState = { passkeySupported: true, error: 'Passkey prompt was cancelled', accountId: null };
    const card = modal.renderUsernameUnlockUI();
    assert.match(card, /If “taken-owl” isn’t your account, go back and choose another username\./);
    // A browser that has this account saved gets the plain line.
    modal.accountState = { passkeySupported: true, error: 'Passkey prompt was cancelled', accountId: '1234567890123456' };
    assert.doesNotMatch(modal.renderUsernameUnlockUI(), /isn’t your account/);
});

test('account errors never show a browser or proxy’s own words', () => {
    const cases = [
        [Object.assign(new TypeError('Failed to fetch')), /Can’t reach Open Anonymity/],
        [Object.assign(new TypeError('Load failed')), /Can’t reach Open Anonymity/],
        [Object.assign(new Error('signal is aborted without reason'), { name: 'AbortError' }), /Request timed out/],
        [Object.assign(new Error('Bad Gateway'), { status: 502 }), /Something went wrong on our side/],
        [Object.assign(new Error('Internal Server Error'), { status: 500 }), /Something went wrong on our side/],
        [Object.assign(new Error('Too many requests'), { status: 429 }), /Too many attempts/],
        [Object.assign(new Error('The user attempted to register an authenticator…'), { name: 'InvalidStateError' }), /already has a passkey/],
        [Object.assign(new Error('The relying party ID is not a registrable domain suffix'), { name: 'SecurityError' }), /blocked the passkey request/],
        [Object.assign(new Error('The operation failed for an unknown transient reason'), { name: 'UnknownError' }), /couldn’t finish the passkey/],
        [Object.assign(new Error('Username is unavailable'), { status: 409, code: 'USERNAME_UNAVAILABLE' }), /That username isn’t available/]
    ];
    for (const [error, expected] of cases) assert.match(toFriendlyAccountError(error), expected, error.message);
    // The org's own sentences pass through.
    assert.equal(toFriendlyAccountError(Object.assign(new Error('That username is reserved'), { status: 400 })), 'That username is reserved');
    assert.equal(
        toFriendlyAccountError(Object.assign(new Error('Username registration expired; start again'), { status: 409, code: 'USERNAME_UNAVAILABLE' })),
        'Username registration expired; start again'
    );
    assert.equal(isAmbiguousAccountFailure(new TypeError('Failed to fetch')), true);
    assert.equal(isAmbiguousAccountFailure(Object.assign(new Error('x'), { status: 503 })), true);
    assert.equal(isAmbiguousAccountFailure(Object.assign(new Error('x'), { status: 409 })), false);
});

test('a notice above the composer moves above a bottom sheet instead of covering its rows', () => {
    const sheet = { getBoundingClientRect: () => ({ top: 430, bottom: 740, width: 375, height: 310 }) };
    const card = { getBoundingClientRect: () => ({ top: 640, bottom: 720, width: 343, height: 80 }) };
    const doc = {
        getElementById: id => (id === 'input-card' ? card : null),
        querySelectorAll: () => [sheet]
    };
    const view = { innerWidth: 375, innerHeight: 740, visualViewport: null };
    const toast = { dataset: {}, style: {}, offsetHeight: 40 };
    positionAppToast(toast, { document: doc, window: view });
    assert.equal(toast.style.top, `${430 - 12 - 40}px`);

    // A centred dialog on a wide screen leaves the notice where it was.
    const dialog = { getBoundingClientRect: () => ({ top: 260, bottom: 600, width: 560, height: 340 }) };
    const wide = { innerWidth: 1280, innerHeight: 860, visualViewport: null };
    const wideDoc = { getElementById: doc.getElementById, querySelectorAll: () => [dialog] };
    const wideToast = { dataset: {}, style: {}, offsetHeight: 40 };
    positionAppToast(wideToast, { document: wideDoc, window: wide });
    assert.equal(wideToast.style.top, `${640 - 16 - 40}px`);
});
