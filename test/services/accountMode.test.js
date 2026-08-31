import assert from 'node:assert/strict';
import test from 'node:test';

import accountService, {
    bootstrapDesktopOAuthSession,
    inferPersistedEncryptionMode,
    oauthSessionNeedsEmailRefresh
} from '../../chat/services/accountService.js';

test('desktop OAuth delegates browser handoff to the isolated bridge', async () => {
    const calls = [];
    const session = {
        accountId: '1234567890123456',
        email: 'member@example.test'
    };
    const result = await bootstrapDesktopOAuthSession(
        'google',
        session.accountId,
        {
            bridge: {
                isElectron: true,
                authStartBrowserSignIn: async (...args) => calls.push(args)
            },
            initializeSession: async () => calls.push(['init']),
            verifySession: async () => true,
            fetchSession: async () => session
        }
    );
    assert.deepEqual(calls, [
        ['init'],
        ['google', '1234567890123456']
    ]);
    assert.deepEqual(result, session);
});

test('removed SSO providers are rejected by the account service', async () => {
    await assert.rejects(
        accountService.authenticateWithOAuth('github'),
        /Unsupported sign-in provider/
    );
});

test('old linked passkey settings retain legacy passkey provenance', () => {
    assert.equal(inferPersistedEncryptionMode({
        accountId: '1234567890123456',
        credentialId: 'legacy-authentication-credential',
        googleLinked: true
    }), 'LEGACY_PASSKEY');
});

test('old identity keyring settings infer PRF encryption provenance', () => {
    assert.equal(inferPersistedEncryptionMode({
        accountId: '1234567890123456',
        encryptionCredentialId: 'encryption-only-credential',
        googleLinked: true
    }), 'PRF');
});

test('old SSO setup sessions refresh OAuth before creating an email-labeled passkey', () => {
    assert.equal(oauthSessionNeedsEmailRefresh({
        encryptionMode: 'PRF_PENDING',
        email: null
    }), true);
    assert.equal(oauthSessionNeedsEmailRefresh({
        encryptionMode: 'LEGACY_SSO',
        email: ''
    }), true);
    assert.equal(oauthSessionNeedsEmailRefresh({
        encryptionMode: 'PRF_PENDING',
        email: 'person@example.com'
    }), false);
    assert.equal(oauthSessionNeedsEmailRefresh({
        encryptionMode: 'PRF',
        email: null
    }), false);
});
