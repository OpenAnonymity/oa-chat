import assert from 'node:assert/strict';
import test from 'node:test';

import AccountModal from '../../chat/components/AccountModal.js';
import { SLOT_NAMES } from '../../chat/extensions/extensionHost.js';
import { toFriendlyOAuthError } from '../../chat/services/accountService.js';

test('account restoration renders an operable neutral progress dialog', () => {
    const originalDocument = globalThis.document;
    globalThis.document = {
        getElementById() {
            return null;
        }
    };
    const state = {
        authBootstrapComplete: false,
        accountId: 'account-123',
        sessionVerified: false,
        status: 'unlocked',
        oauthEmail: 'member@example.com'
    };
    const modal = new AccountModal({
        services: {
            account: {
                getState: () => state,
                subscribe: () => () => {}
            },
            sync: {
                getStatus: () => ({}),
                subscribe: () => () => {}
            }
        }
    });
    modal.accountState = state;
    modal.escapeHtml = value => String(value ?? '');

    try {
        const html = modal.renderAccountUI();
        assert.match(html, /Restoring your account…/);
        assert.match(html, /member@example\.com/);
        assert.match(html, /aria-busy="true"/);
        assert.doesNotMatch(html, /Continue with Google/);
        assert.doesNotMatch(html, /Log out/);
        assert.doesNotMatch(html, /Synchronization/);
    } finally {
        modal.destroy();
        globalThis.document = originalDocument;
    }
});

test('account rerenders refresh the commercial slot through the UI facade', () => {
    const source = String(AccountModal.prototype.render);
    assert.match(source, /refreshExtensionSlot\?\.\(SLOT_NAMES\.ACCOUNT_COMMERCIAL\)/);
    assert.match(source, /actionRow\?\.parentNode/);
    assert.match(source, /actionParent\.insertBefore\(commercialSlot, actionRow\)/);
    assert.doesNotMatch(source, /dialog\.insertBefore\(commercialSlot, actionRow\)/);
    assert.doesNotMatch(source, /extensionSlots/);
});

test('signed-in Account opens beside the nested action row without backdrop dismissal', () => {
    const originalDocument = globalThis.document;
    const inserted = [];
    const refreshed = [];
    const actionParent = {
        insertBefore(node, reference) {
            inserted.push({ node, reference });
        }
    };
    const actionRow = { parentNode: actionParent };
    const dialog = {
        focus() {},
        appendChild() {
            throw new Error('The nested action row must use its own parent');
        },
        querySelector(selector) {
            return selector === '[data-account-actions]' ? actionRow : null;
        }
    };
    const removedClasses = [];
    const overlay = {
        onclick: null,
        classList: {
            add() {},
            remove(name) { removedClasses.push(name); }
        },
        contains() { return false; },
        querySelector(selector) {
            return selector === '[role="dialog"]' ? dialog : null;
        },
        querySelectorAll() { return []; },
        set innerHTML(value) { this.html = value; }
    };
    const state = {
        authBootstrapComplete: true,
        accountId: 'account-123',
        sessionVerified: true,
        status: 'unlocked',
        googleLinked: true,
        encryptionMode: 'PRF',
        passkeySupported: true,
        busy: false,
        action: null
    };
    globalThis.document = {
        activeElement: null,
        createElement() {
            return { dataset: {}, hidden: false };
        },
        getElementById(id) {
            return id === 'account-modal' ? overlay : null;
        },
        addEventListener() {},
        removeEventListener() {}
    };
    const modal = new AccountModal({
        services: {
            account: {
                getState: () => state,
                subscribe: () => () => {},
                clearErrors() {}
            },
            sync: {
                getStatus: () => ({
                    syncing: false,
                    lastSyncTime: null,
                    lastSyncResult: null
                }),
                subscribe: () => () => {}
            }
        },
        refreshExtensionSlot(name) {
            refreshed.push(name);
        }
    });
    modal.escapeHtml = value => String(value ?? '');

    try {
        modal.open();
        assert.equal(modal.isOpen, true);
        assert.deepEqual(removedClasses, ['hidden']);
        assert.equal(overlay.onclick, null);
        assert.equal(inserted.length, 1);
        assert.equal(inserted[0].reference, actionRow);
        assert.equal(inserted[0].node.dataset.oaExtensionSlot, SLOT_NAMES.ACCOUNT_COMMERCIAL);
        assert.deepEqual(refreshed, [SLOT_NAMES.ACCOUNT_COMMERCIAL]);
    } finally {
        modal.destroy();
        globalThis.document = originalDocument;
    }
});

test('account entry offers Google and pseudonymous username passkeys', () => {
    const originalDocument = globalThis.document;
    globalThis.document = {
        getElementById() {
            return null;
        }
    };
    const state = {
        accountId: null,
        passkeySupported: true,
        busy: false,
        action: null,
        error: null
    };
    const modal = new AccountModal({
        services: {
            account: {
                getState: () => state,
                subscribe: () => () => {}
            },
            sync: {
                getStatus: () => ({}),
                subscribe: () => () => {}
            }
        }
    });
    modal.accountState = state;
    modal.escapeHtml = value => String(value ?? '');

    try {
        const html = modal.renderAccountUI();
        assert.match(html, /Continue with Google/);
        assert.match(html, /Username/);
        assert.match(html, />Log in<\/h3>/);
        assert.match(html, /placeholder="Username"/);
        assert.match(html, /aria-label="Username"/);
        assert.match(html, />\s*Continue\s*<\/button>/);
        assert.doesNotMatch(html, /Sign in to OA|Choose Google|Use a pseudonym|winter-owl/);
        assert.doesNotMatch(html, /<label|Create a passkey account|account-identifier-mode-btn/);
        assert.match(html, /role="dialog" aria-modal="true" aria-labelledby="account-modal-title" tabindex="-1"/);
        assert.match(html, /id="account-modal-title"/);
        assert.doesNotMatch(html, /generate-account-btn/);
        assert.match(html, /account-passkey-btn/);
        assert.doesNotMatch(html, /account-recovery-toggle-btn/);
        assert.doesNotMatch(html, /Five-word recovery code/);
        assert.doesNotMatch(html, /Continue with GitHub/);
        assert.doesNotMatch(html, /account-github-btn/);
    } finally {
        modal.destroy();
        globalThis.document = originalDocument;
    }
});

test('landing username handoff prefills and focuses the username field', () => {
    const originalDocument = globalThis.document;
    const focused = [];
    const usernameInput = { focus() { focused.push('account-username-input'); } };
    globalThis.document = {
        activeElement: null,
        addEventListener() {},
        getElementById(id) {
            return id === 'account-username-input' ? usernameInput : null;
        }
    };
    const state = {
        accountId: null,
        passkeySupported: true,
        busy: false,
        action: null,
        error: null
    };
    const overlay = {
        classList: { remove() {} },
        contains(node) { return node === usernameInput; },
        querySelectorAll() { return []; },
        querySelector() { return null; }
    };
    const modal = new AccountModal({
        services: {
            account: {
                getState: () => state,
                subscribe: () => () => {},
                clearErrors() {}
            },
            sync: {
                getStatus: () => ({}),
                subscribe: () => () => {}
            }
        }
    });
    modal.overlay = overlay;
    modal.render = () => {};

    try {
        modal.openForUsername('  Winter-OWL  ');
        assert.equal(modal.isOpen, true);
        assert.equal(modal.identifierMode, 'username');
        assert.equal(modal.usernameInputValue, 'winter-owl');
        assert.deepEqual(focused, ['account-username-input']);
    } finally {
        modal.destroy();
        globalThis.document = originalDocument;
    }
});

test('blank username creation cannot fall through to legacy account creation', async () => {
    const originalDocument = globalThis.document;
    globalThis.document = { getElementById() { return null; } };
    let requestedUsername;
    const state = {
        accountId: null,
        username: null,
        passkeySupported: true,
        busy: false,
        action: null,
        error: null
    };
    const modal = new AccountModal({
        services: {
            account: {
                getState: () => state,
                subscribe: () => () => {},
                clearErrors() {},
                setError(message) { state.error = message; },
                async prepareUsernameContinuation(username) {
                    requestedUsername = username;
                    throw new Error('Username is required');
                }
            },
            sync: {
                getStatus: () => ({}),
                subscribe: () => () => {}
            }
        }
    });
    modal.accountState = state;
    modal.isOpen = true;
    modal.render = () => {};

    try {
        await modal.handleAccountContinue();
        assert.equal(requestedUsername, '');
        assert.equal(state.error, 'Username is required');
        assert.equal(modal.creationStep, 'idle');
    } finally {
        modal.destroy();
        globalThis.document = originalDocument;
    }
});

test('first username account completes after one passkey and routes to Membership', async () => {
    const modal = Object.create(AccountModal.prototype);
    let completeCount = 0;
    let recoveryGenerationCount = 0;
    let closed = 0;
    let firstAccountReady = 0;
    modal.generatedUsername = 'winter-owl';
    modal.creationStep = 'passkey';
    modal.creationError = null;
    modal.render = () => {};
    modal.close = () => { closed += 1; };
    modal.accountService = {
        async registerPasskeyForPreparedAccount() { return true; },
        generateRecoveryForPreparedAccount() {
            recoveryGenerationCount += 1;
            return 'should-not-be-generated';
        },
        async completeAccountRegistration() { completeCount += 1; }
    };
    modal.app = {
        showToast() {},
        notifyFirstAccountReady() { firstAccountReady += 1; }
    };

    await modal.handlePasskeyRegistration();

    assert.equal(completeCount, 1);
    assert.equal(recoveryGenerationCount, 0);
    assert.equal(modal.creationStep, 'complete');
    assert.equal(closed, 1);
    assert.equal(firstAccountReady, 1);
});

test('first username setup never displays the username while awaiting or finishing the passkey', () => {
    const modal = Object.create(AccountModal.prototype);
    modal.generatedUsername = 'winter-owl';
    modal.escapeHtml = value => String(value ?? '').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
    for (const step of ['passkey', 'confirming', 'complete']) {
        modal.creationStep = step;
        const html = modal.renderCreationFlow();
        assert.match(html, />Log in<\/h3>/);
        assert.match(html, /role="status"/);
        assert.match(html, /Setting up your account…/);
        assert.doesNotMatch(html, /winter-owl|Your username|Your account number|Create a passkey account|You're all set/);
    }
    modal.creationStep = 'passkey_retry';
    modal.creationError = '<cancelled>';
    const retry = modal.renderCreationFlow();
    assert.match(retry, /role="alert"/);
    assert.match(retry, /&lt;cancelled&gt;/);
    assert.match(retry, /id="retry-passkey-btn"/);
    assert.match(retry, /id="cancel-creation-btn"/);
    assert.doesNotMatch(retry, /winter-owl|Your username|Setting up your account/);
    modal.creationStep = 'error';
    assert.match(modal.renderCreationFlow(), /id="start-over-btn"/);
});

test('new username registration keeps progress through account/sync notifications until Membership', async () => {
    const originalDocument = globalThis.document;
    let accountListener;
    let syncListener;
    let finishRegistration;
    let firstAccountReady = 0;
    const frames = [];
    const state = { accountId: null, passkeySupported: true };
    globalThis.document = {
        activeElement: null,
        getElementById() { return null; },
        removeEventListener() {}
    };
    const modal = new AccountModal({
        services: {
            account: {
                getState: () => state,
                subscribe(listener) { accountListener = listener; return () => {}; },
                async registerPasskeyForPreparedAccount() { return true; },
                completeAccountRegistration() {
                    accountListener({ accountId: '1234567890123456', username: 'winter-owl', sessionVerified: true, status: 'unlocked' });
                    syncListener();
                    return new Promise(resolve => { finishRegistration = resolve; });
                }
            },
            sync: {
                getStatus: () => ({}),
                subscribe(listener) { syncListener = listener; return () => {}; }
            }
        },
        showToast() {},
        notifyFirstAccountReady() { firstAccountReady += 1; }
    });
    modal.overlay = {
        contains() { return false; },
        querySelector() { return null; },
        classList: { add() {} },
        set innerHTML(html) { frames.push(html); }
    };
    modal.attachEventListeners = () => {};
    modal.isOpen = true;
    modal.generatedUsername = 'winter-owl';
    modal.creationStep = 'passkey';
    modal.escapeHtml = value => String(value ?? '');
    modal.renderAccountUI = () => { throw new Error('Account summary must not flash during setup'); };
    try {
        modal.render();
        const registration = modal.handlePasskeyRegistration();
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(modal.creationStep, 'confirming');
        assert.equal(modal.isOpen, true);
        assert.equal(frames.length, 3); // waiting, confirming, and sync notification
        for (const html of frames) {
            assert.match(html, /Setting up your account…/);
            assert.doesNotMatch(html, /Your username|winter-owl|Your account number/);
        }
        assert.equal(firstAccountReady, 0);
        finishRegistration();
        await registration;
        assert.equal(modal.isOpen, false);
        assert.equal(firstAccountReady, 1);
        assert.equal(frames.at(-1), '');
    } finally {
        modal.destroy();
        globalThis.document = originalDocument;
    }
});

function continuationModal(next = 'register') {
    const modal = Object.create(AccountModal.prototype);
    const calls = [];
    Object.assign(modal, {
        isOpen: true,
        loginViewVersion: 0,
        usernameContinuePending: false,
        identifierMode: 'username',
        usernameInputValue: 'winter-owl',
        creationStep: 'idle',
        accountState: { passkeySupported: true },
        render() {},
        accountService: {
            clearErrors() {},
            setError(message) { calls.push(['error', message]); },
            async prepareUsernameContinuation(username) {
                calls.push(['prepare', username]);
                return { kind: next };
            },
            getPendingAccountId() { return '1234567890123456'; },
            getPendingUsername() { return 'winter-owl'; },
            cancelPendingAccount() { calls.push(['cancel']); }
        },
        async handlePasskeyRegistration() { calls.push(['register']); },
        async handleAccountPasskeyUnlock() { calls.push(['login']); return false; }
    });
    return { modal, calls };
}

test('one Continue routes to registration or login without falling back after a failed passkey', async () => {
    for (const next of ['register', 'login']) {
        const { modal, calls } = continuationModal(next);
        await modal.handleAccountContinue();
        assert.deepEqual(calls, [['prepare', 'winter-owl'], [next]]);
        assert.equal(modal.usernameContinuePending, false);
        assert.equal(modal.creationStep, next === 'register' ? 'passkey' : 'idle');
        if (next === 'register') assert.equal(modal.generatedUsername, 'winter-owl');
    }
});

test('Continue is single-flight and closing during lookup never launches a passkey', async () => {
    const { modal, calls } = continuationModal();
    let resolve;
    modal.accountService.prepareUsernameContinuation = () => new Promise(done => { resolve = done; });
    const first = modal.handleAccountContinue();
    await modal.handleAccountContinue();
    assert.equal(modal.usernameContinuePending, true);
    // A close/reopen must also invalidate the earlier request.
    modal.loginViewVersion += 1;
    resolve({ kind: 'register' });
    await first;
    assert.deepEqual(calls, [['cancel']]);
    assert.equal(modal.usernameContinuePending, false);
});

test('lookup failures stay on the login form and do not launch a passkey', async () => {
    const { modal, calls } = continuationModal();
    modal.accountService.prepareUsernameContinuation = async () => { throw new Error('Try again later'); };
    await modal.handleAccountContinue();
    assert.deepEqual(calls, [['error', 'Try again later']]);
    assert.equal(modal.creationStep, 'idle');
    assert.equal(modal.usernameContinuePending, false);
});

test('Continue preserves saved legacy login and honors unsupported/busy guards', async () => {
    const { modal, calls } = continuationModal();
    modal.identifierMode = 'accountId';
    await modal.handleAccountContinue();
    assert.deepEqual(calls, [['login']]);
    modal.accountState.busy = true;
    await modal.handleAccountContinue();
    modal.accountState.busy = false;
    modal.accountState.passkeySupported = false;
    await modal.handleAccountContinue();
    assert.deepEqual(calls, [['login']]);
});

test('returning username account closes sign-in without first-account routing', async () => {
    const modal = Object.create(AccountModal.prototype);
    let closed = 0;
    let firstAccountReady = 0;
    modal.identifierMode = 'username';
    modal.usernameInputValue = 'winter-owl';
    modal.accountState = { username: 'winter-owl' };
    modal.close = () => { closed += 1; };
    modal.accountService = {
        async unlockWithUsername(username, options) {
            assert.equal(username, 'winter-owl');
            assert.deepEqual(options, { action: 'username_login' });
            return true;
        }
    };
    modal.app = {
        showToast() {},
        notifyFirstAccountReady() { firstAccountReady += 1; }
    };

    await modal.handleAccountPasskeyUnlock();

    assert.equal(closed, 1);
    assert.equal(firstAccountReady, 0);
});

test('saved legacy passkey accounts keep the account-number login path', async () => {
    const originalDocument = globalThis.document;
    globalThis.document = { getElementById() { return null; } };
    const state = {
        accountId: '1234567890123456',
        username: null,
        googleLinked: false,
        encryptionMode: 'LEGACY_PASSKEY',
        sessionVerified: false,
        status: 'locked',
        passkeySupported: true,
        busy: false,
        action: null,
        error: null
    };
    let unlockedAccountId = null;
    const account = {
        getState: () => state,
        subscribe: () => () => {},
        clearErrors() {},
        async unlockWithPasskey(accountId) {
            unlockedAccountId = accountId;
            return true;
        },
        async unlockWithUsername() {
            throw new Error('legacy account unexpectedly used username login');
        }
    };
    const modal = new AccountModal({
        services: {
            account,
            sync: {
                getStatus: () => ({}),
                subscribe: () => () => {}
            }
        },
        showToast() {}
    });
    modal.accountState = state;
    modal.escapeHtml = value => String(value ?? '');

    try {
        modal.openForUsername('another-name');
        assert.equal(modal.getIdentifierMode(), 'accountId');
        const html = modal.renderAccountUI();
        assert.match(html, /id="account-id-input"/);
        assert.match(html, /1234 5678 9012 3456/);
        assert.match(html, /id="account-recovery-toggle-btn"/);
        assert.doesNotMatch(html, /account-identifier-mode-btn/);
        await modal.handleAccountPasskeyUnlock();
        assert.equal(unlockedAccountId, state.accountId);
        // Pre-migration Google-linked accounts still use the legacy passkey
        // when their session has expired and OAuth unlock flags are unset.
        state.googleLinked = true;
        state.oauthLegacyPasskeyRequired = false;
        assert.equal(modal.getIdentifierMode(), 'accountId');
        const linkedLegacyHtml = modal.renderAccountUI();
        assert.match(linkedLegacyHtml, /id="account-id-input"/);
        assert.match(linkedLegacyHtml, /id="account-recovery-toggle-btn"/);
        await modal.handleAccountContinue();
        assert.equal(unlockedAccountId, state.accountId);
    } finally {
        modal.destroy();
        globalThis.document = originalDocument;
    }
});

test('signed-out saved account exposes an explicit account-switch recovery', () => {
    const originalDocument = globalThis.document;
    globalThis.document = {
        getElementById() {
            return null;
        }
    };
    const state = {
        accountId: null,
        hasSavedAccountBinding: true,
        sessionVerified: false,
        passkeySupported: true,
        busy: false,
        action: null,
        error: 'This Google account does not match the OA account saved on this device.'
    };
    const modal = new AccountModal({
        services: {
            account: {
                getState: () => state,
                subscribe: () => () => {}
            },
            sync: {
                getStatus: () => ({}),
                subscribe: () => () => {}
            }
        }
    });
    modal.accountState = state;
    modal.escapeHtml = value => String(value ?? '');

    try {
        const html = modal.renderAccountUI();
        assert.match(html, /Continue with Google/);
        assert.match(html, /This device remembers a signed-out OA account/);
        assert.match(html, /id="account-forget-saved-btn"/);
        assert.match(html, /Forget saved account/);
        assert.doesNotMatch(html, /id="generate-account-btn"/);
    } finally {
        modal.destroy();
        globalThis.document = originalDocument;
    }
});

test('desktop account-mismatch recovery does not depend on a visible account ID', () => {
    const originalDocument = globalThis.document;
    globalThis.document = {
        getElementById() {
            return null;
        }
    };
    const state = {
        accountId: null,
        hasSavedAccountBinding: false,
        sessionVerified: false,
        passkeySupported: true,
        busy: false,
        action: null,
        error: 'This Google account does not match the OA account saved on this device.'
    };
    const modal = new AccountModal({
        services: {
            account: {
                getState: () => state,
                subscribe: () => () => {}
            },
            sync: {
                getStatus: () => ({}),
                subscribe: () => () => {}
            }
        }
    });
    modal.accountState = state;
    modal.escapeHtml = value => String(value ?? '');

    try {
        const html = modal.renderAccountUI();
        assert.match(html, /id="account-forget-saved-btn"/);
        assert.match(html, /Forget saved account/);
    } finally {
        modal.destroy();
        globalThis.document = originalDocument;
    }
});

test('forgetting a signed-out saved account clears only after explicit action', async () => {
    let clearCount = 0;
    let toast = '';
    const modal = Object.create(AccountModal.prototype);
    modal.accountService = {
        async clearLocalAccount() {
            clearCount += 1;
        }
    };
    modal.accountInputValue = 'saved';
    modal.recoveryInputValue = 'saved';
    modal.showRecoveryInput = true;
    modal.resetCreationFlow = () => {};
    modal.render = () => {};
    modal.app = { showToast(message) { toast = message; } };

    await modal.handleForgetSavedAccount();

    assert.equal(clearCount, 1);
    assert.equal(modal.accountInputValue, '');
    assert.equal(modal.recoveryInputValue, '');
    assert.equal(modal.showRecoveryInput, false);
    assert.equal(toast, 'Saved account removed from this device');
});

test('account service turns upstream failures into actionable Google copy', () => {
    assert.equal(
        toFriendlyOAuthError(Object.assign(new Error('Bad Gateway'), { status: 502 })),
        'Google sign-in is temporarily unavailable. Please retry.'
    );
});

test('an already-unlocked Google account completes without commercial coupling', async () => {
    const modal = Object.create(AccountModal.prototype);
    let toast = '';
    modal.accountService = {
        authenticateWithOAuth: async () => ({ status: 'unlocked' })
    };
    modal.render = () => {};
    modal.app = { showToast(message) { toast = message; } };

    await modal.handleOAuthAuthentication('google');

    assert.equal(toast, 'Signed in with Google');
    assert.equal('resumePremiumCheckoutIfPending' in modal, false);
});

test('a first Google account closes authentication and routes directly to Membership', async () => {
    const modal = Object.create(AccountModal.prototype);
    let closed = 0;
    let firstAccountReady = 0;
    modal.accountService = {
        authenticateWithOAuth: async () => ({ status: 'unlocked', newAccount: true })
    };
    modal.render = () => {};
    modal.close = () => { closed += 1; };
    modal.app = {
        showToast() {},
        notifyFirstAccountReady() { firstAccountReady += 1; }
    };

    await modal.handleOAuthAuthentication('google');

    assert.equal(closed, 1);
    assert.equal(firstAccountReady, 1);
});

test('a returning Google account stays in Chat without first-account routing', async () => {
    const modal = Object.create(AccountModal.prototype);
    let closed = 0;
    let firstAccountReady = 0;
    let renders = 0;
    modal.accountService = {
        authenticateWithOAuth: async () => ({ status: 'unlocked', newAccount: false })
    };
    modal.render = () => { renders += 1; };
    modal.close = () => { closed += 1; };
    modal.app = {
        showToast() {},
        notifyFirstAccountReady() { firstAccountReady += 1; }
    };

    await modal.handleOAuthAuthentication('google');

    assert.equal(closed, 1);
    assert.equal(firstAccountReady, 0);
    assert.equal(renders, 1);
});

test('returning passkey and recovery unlocks close Account without Membership routing', async () => {
    const cases = [
        ['handleAccountPasskeyUnlock', 'unlockWithPasskey'],
        ['handleOAuthRecoveryUnlock', 'unlockOAuthWithRecoveryCode'],
        ['handleOAuthKeyringUnlock', 'unlockOAuthKeyring']
    ];

    for (const [handler, serviceMethod] of cases) {
        const modal = Object.create(AccountModal.prototype);
        let closed = 0;
        let firstAccountReady = 0;
        modal.accountState = {
            accountId: 'account-1',
            oauthProvider: 'google'
        };
        modal.accountInputValue = '';
        modal.recoveryInputValue = 'recovery-code';
        modal.accountService = {
            getState: () => ({
                accountId: 'account-1',
                oauthSetupRequired: false,
                oauthLegacyPasskeyRequired: false
            }),
            [serviceMethod]: async () => true
        };
        modal.close = () => { closed += 1; };
        modal.app = {
            showToast() {},
            notifyFirstAccountReady() { firstAccountReady += 1; }
        };

        await modal[handler]();

        assert.equal(closed, 1, handler);
        assert.equal(firstAccountReady, 0, handler);
        assert.equal(modal.authenticationExitPending, false, handler);
    }
});

test('legacy recovery closes Account after the replacement passkey succeeds', async () => {
    const modal = Object.create(AccountModal.prototype);
    let closed = 0;
    let toast = '';
    modal.accountState = { accountId: 'account-1' };
    modal.accountInputValue = '';
    modal.recoveryInputValue = 'recovery-code';
    modal.showRecoveryInput = true;
    modal.recoveryStep = 'idle';
    modal.accountService = {
        clearErrors() {},
        unlockWithRecoveryCode: async () => true
    };
    modal.render = () => {};
    modal.close = () => { closed += 1; };
    modal.app = { showToast(message) { toast = message; } };

    await modal.handleAccountRecoveryUnlock();

    assert.equal(closed, 1);
    assert.equal(toast, 'Account recovered successfully');
    assert.equal(modal.recoveryStep, 'idle');
    assert.equal(modal.showRecoveryInput, false);
    assert.equal(modal.recoveryInputValue, '');
    assert.equal(modal.authenticationExitPending, false);
});

test('first Google keyring setup closes Account and routes once to Membership', async () => {
    const modal = Object.create(AccountModal.prototype);
    let closed = 0;
    let firstAccountReady = 0;
    modal.accountService = {
        getState: () => ({
            accountId: 'account-1',
            oauthSetupRequired: true,
            oauthLegacyPasskeyRequired: false
        }),
        setupOAuthKeyring: async () => true
    };
    modal.close = () => { closed += 1; };
    modal.app = {
        showToast() {},
        notifyFirstAccountReady() { firstAccountReady += 1; }
    };

    await modal.handleOAuthKeyringUnlock();

    assert.equal(closed, 1);
    assert.equal(firstAccountReady, 1);
    assert.equal(modal.authenticationExitPending, false);
});

test('successful unlock does not flash the signed-in Account summary before closing', () => {
    const originalDocument = globalThis.document;
    let accountListener = null;
    let syncListener = null;
    globalThis.document = {
        getElementById() { return null; },
        addEventListener() {},
        removeEventListener() {}
    };
    const modal = new AccountModal({
        services: {
            account: {
                getState: () => ({ status: 'locked' }),
                subscribe(listener) {
                    accountListener = listener;
                    return () => {};
                }
            },
            sync: {
                getStatus: () => ({}),
                subscribe(listener) {
                    syncListener = listener;
                    return () => {};
                }
            }
        }
    });
    let renders = 0;
    modal.isOpen = true;
    modal.authenticationExitPending = true;
    modal.render = () => { renders += 1; };

    try {
        accountListener({
            accountId: 'account-1',
            sessionVerified: true,
            status: 'unlocked'
        });
        syncListener();
        assert.equal(renders, 0);

        accountListener({
            accountId: 'account-1',
            sessionVerified: true,
            status: 'locked',
            busy: false,
            error: 'Try again'
        });
        assert.equal(renders, 1);
    } finally {
        modal.destroy();
        globalThis.document = originalDocument;
    }
});

test('a Google-authenticated locked account explains that passkey unlock is still required', () => {
    const originalDocument = globalThis.document;
    globalThis.document = { getElementById() { return null; } };
    const state = {
        accountId: 'identity-account',
        sessionVerified: true,
        status: 'locked',
        oauthProvider: 'google',
        oauthKeyringRequired: true,
        busy: false,
        error: 'No passkey found for this account on this device'
    };
    const modal = new AccountModal({
        services: {
            account: {
                getState: () => state,
                subscribe: () => () => {}
            },
            sync: {
                getStatus: () => ({}),
                subscribe: () => () => {}
            }
        }
    });
    modal.accountState = state;
    modal.escapeHtml = value => String(value ?? '');

    try {
        const html = modal.renderOAuthUnlockUI();
        assert.match(html, /Signed in with Google/);
        assert.match(html, /Encrypted data is still locked/);
        assert.match(html, /Google sign-in alone cannot decrypt it/);
        assert.match(html, /Closing this dialog keeps Google signed in/);
        assert.match(html, />\s*Log out\s*</);
        assert.doesNotMatch(html, /Cancel and log out/);
    } finally {
        modal.destroy();
        globalThis.document = originalDocument;
    }
});

test('legacy linked account uses its existing passkey unlock path', async () => {
    const originalDocument = globalThis.document;
    globalThis.document = {
        getElementById() {
            return null;
        }
    };
    const state = {
        accountId: '1234567890123456',
        oauthProvider: 'google',
        oauthLegacyPasskeyRequired: true
    };
    let unlockAccountId = null;
    let closed = 0;
    const account = {
        getState: () => state,
        subscribe: () => () => {},
        async unlockWithPasskey(accountId) {
            unlockAccountId = accountId;
            return true;
        }
    };
    const modal = new AccountModal({
        services: {
            account,
            sync: {
                getStatus: () => ({}),
                subscribe: () => () => {}
            }
        },
        showToast() {}
    });
    modal.accountState = state;
    modal.escapeHtml = value => String(value ?? '');
    modal.close = () => { closed += 1; };

    try {
        const html = modal.renderOAuthUnlockUI();
        assert.match(html, /Use legacy passkey/);
        assert.match(html, /aria-labelledby="account-modal-title"/);
        assert.match(html, /id="account-modal-title"/);
        assert.match(html, /1234 5678 9012 3456/);
        await modal.handleOAuthKeyringUnlock();
        assert.equal(unlockAccountId, state.accountId);
        assert.equal(closed, 1);
        assert.equal('resumePremiumCheckoutIfPending' in modal, false);
    } finally {
        modal.destroy();
        globalThis.document = originalDocument;
    }
});

test('identity account describes ticket and preference sync', () => {
    const originalDocument = globalThis.document;
    globalThis.document = {
        getElementById() {
            return null;
        }
    };
    const state = {
        accountId: '1234567890123456',
        googleLinked: true,
        oauthEmail: 'dominic@example.com',
        encryptionMode: 'PRF',
        sessionVerified: true,
        status: 'unlocked',
        busy: false,
        action: null,
        passkeySupported: true
    };
    const modal = new AccountModal({
        services: {
            account: {
                getState: () => state,
                subscribe: () => () => {}
            },
            sync: {
                getStatus: () => ({
                    syncing: false,
                    lastSyncTime: null,
                    lastSyncResult: null
                }),
                subscribe: () => () => {}
            }
        }
    });
    modal.accountState = state;
    modal.escapeHtml = value => String(value ?? '');

    try {
        let html = modal.renderAccountUI();
        assert.match(html, /account-compact-dialog/);
        assert.match(html, /account-compact-avatar[^>]*>D</);
        assert.match(html, /dominic@example\.com/);
        assert.match(html, /Sync now|Retry sync/);
        assert.match(html, /Passkey &amp; encryption/);
        assert.match(html, /id="account-passkey-details"[^>]*hidden/);
        assert.match(html, /Tickets and preferences sync encrypted with your passkey/);
        assert.doesNotMatch(html, /Account identity|Synchronization|Connected provider/);
        assert.doesNotMatch(html, /device-only/);

        modal.togglePasskeyDetails();
        html = modal.renderAccountUI();
        assert.match(html, /aria-expanded="true"/);
        assert.match(html, /id="account-passkey-details" class="account-compact-detail" >/);
        assert.match(html, /End-to-end encrypted/);
        assert.match(html, /Google connected/);
    } finally {
        modal.destroy();
        globalThis.document = originalDocument;
    }
});

test('username account displays the pseudonym and hides its internal account ID', () => {
    const originalDocument = globalThis.document;
    globalThis.document = { getElementById() { return null; } };
    const state = {
        accountId: '1234567890123456',
        username: 'winter-owl',
        googleLinked: false,
        encryptionMode: 'LEGACY_PASSKEY',
        sessionVerified: true,
        status: 'unlocked',
        busy: false,
        action: null,
        passkeySupported: true
    };
    const modal = new AccountModal({
        services: {
            account: {
                getState: () => state,
                subscribe: () => () => {}
            },
            sync: {
                getStatus: () => ({
                    syncing: false,
                    lastSyncTime: null,
                    lastSyncResult: null
                }),
                subscribe: () => () => {}
            }
        }
    });
    modal.accountState = state;
    modal.escapeHtml = value => String(value ?? '');

    try {
        const html = modal.renderAccountUI();
        assert.match(html, /winter-owl/);
        assert.doesNotMatch(html, /1234 5678 9012 3456/);
        assert.doesNotMatch(html, /Copy account ID/);
    } finally {
        modal.destroy();
        globalThis.document = originalDocument;
    }
});

test('legacy recovery completion displays only the account number', () => {
    const modal = Object.create(AccountModal.prototype);
    modal.accountState = {
        accountId: '1234567890123456',
        username: null
    };
    modal.formatAccountId = accountId => accountId.replace(/(.{4})/g, '$1 ').trim();
    modal.escapeHtml = value => String(value ?? '');
    modal.renderHeader = title => `<h2>${title}</h2>`;

    const html = modal.renderRecoveryCompleteUI();

    assert.match(html, /Account Recovered/);
    assert.match(html, /1234 5678 9012 3456/);
});

test('legacy registration recovery screen pairs the code with its account number', () => {
    const modal = Object.create(AccountModal.prototype);
    modal.generatedAccountId = '1234567890123456';
    modal.generatedUsername = null;
    modal.generatedRecoveryCode = 'alpha-bravo-charlie-delta-echo';
    modal.accountIdCopied = false;
    modal.recoveryCodeCopied = false;
    modal.escapeHtml = value => String(value ?? '');
    modal.formatAccountId = accountId => accountId.replace(/(.{4})/g, '$1 ').trim();

    const html = modal.renderCreationBody('recovery');

    assert.match(html, /Your account number/);
    assert.match(html, /1234 5678 9012 3456/);
    assert.match(html, /alpha-bravo-charlie-delta-echo/);
    assert.doesNotMatch(html, /Your username/);
});

test('missing legacy SSO email returns to provider sign in before passkey setup', () => {
    const originalDocument = globalThis.document;
    globalThis.document = {
        getElementById() {
            return null;
        }
    };
    const state = {
        accountId: '1234567890123456',
        googleLinked: true,
        oauthProvider: 'google',
        oauthEmail: null,
        encryptionMode: 'PRF_PENDING',
        sessionVerified: false,
        oauthSetupRequired: false,
        oauthRecoveryRequired: false,
        oauthKeyringRequired: false,
        oauthLegacyPasskeyRequired: false,
        passkeySupported: true,
        busy: false,
        action: null,
        error: 'Continue with Google again so OA can label your encryption passkey'
    };
    const modal = new AccountModal({
        services: {
            account: {
                getState: () => state,
                subscribe: () => () => {}
            },
            sync: {
                getStatus: () => ({}),
                subscribe: () => () => {}
            }
        }
    });
    modal.accountState = state;
    modal.escapeHtml = value => String(value ?? '');

    try {
        const html = modal.renderAccountUI();
        assert.match(html, /Continue with Google/);
        assert.match(html, /label your encryption passkey/);
        assert.doesNotMatch(html, /Google sign in complete/);
        assert.doesNotMatch(html, /Create encryption passkey/);
    } finally {
        modal.destroy();
        globalThis.document = originalDocument;
    }
});
