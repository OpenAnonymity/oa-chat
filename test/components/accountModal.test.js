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

test('signed-in Account opens after inserting its commercial slot beside the nested action row', () => {
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
        assert.equal(inserted.length, 1);
        assert.equal(inserted[0].reference, actionRow);
        assert.equal(inserted[0].node.dataset.oaExtensionSlot, SLOT_NAMES.ACCOUNT_COMMERCIAL);
        assert.deepEqual(refreshed, [SLOT_NAMES.ACCOUNT_COMMERCIAL]);
    } finally {
        modal.destroy();
        globalThis.document = originalDocument;
    }
});

test('account registration offers only Google SSO', () => {
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
        assert.match(html, /role="dialog" aria-modal="true" aria-labelledby="account-modal-title" tabindex="-1"/);
        assert.match(html, /id="account-modal-title"/);
        assert.doesNotMatch(html, /or use a passkey/i);
        assert.doesNotMatch(html, /passkey login/i);
        assert.doesNotMatch(html, /Recover your account/i);
        assert.doesNotMatch(html, /generate-account-btn/);
        assert.doesNotMatch(html, /account-passkey-btn/);
        assert.doesNotMatch(html, /account-recovery-toggle-btn/);
        assert.doesNotMatch(html, /Continue with GitHub/);
        assert.doesNotMatch(html, /account-github-btn/);
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
    let firstAccountReady = 0;
    modal.accountService = {
        authenticateWithOAuth: async () => ({ status: 'unlocked', newAccount: false })
    };
    modal.render = () => {};
    modal.app = {
        showToast() {},
        notifyFirstAccountReady() { firstAccountReady += 1; }
    };

    await modal.handleOAuthAuthentication('google');

    assert.equal(firstAccountReady, 0);
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

    try {
        const html = modal.renderOAuthUnlockUI();
        assert.match(html, /Use legacy passkey/);
        assert.match(html, /aria-labelledby="account-modal-title"/);
        assert.match(html, /id="account-modal-title"/);
        assert.match(html, /1234 5678 9012 3456/);
        await modal.handleOAuthKeyringUnlock();
        assert.equal(unlockAccountId, state.accountId);
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
        const html = modal.renderAccountUI();
        assert.match(html, /Tickets and preferences synchronize as encrypted data/);
        assert.match(html, /Account identity/);
        assert.match(html, /Passkey encryption/);
        assert.match(html, /Synchronization/);
        assert.doesNotMatch(html, /device-only/);
    } finally {
        modal.destroy();
        globalThis.document = originalDocument;
    }
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
