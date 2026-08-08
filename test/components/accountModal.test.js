import assert from 'node:assert/strict';
import test from 'node:test';

import AccountModal from '../../chat/components/AccountModal.js';

test('account sign in offers Google as the only SSO provider', () => {
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
        assert.doesNotMatch(html, /Continue with GitHub/);
        assert.doesNotMatch(html, /account-github-btn/);
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
        assert.match(html, /1234 5678 9012 3456/);
        await modal.handleOAuthKeyringUnlock();
        assert.equal(unlockAccountId, state.accountId);
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
        assert.match(html, /Encrypted sync for tickets & preferences/);
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
