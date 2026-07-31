import assert from 'node:assert/strict';
import test from 'node:test';

import {
    inferPersistedEncryptionMode,
    oauthSessionNeedsEmailRefresh
} from '../../chat/services/accountService.js';

test('old linked passkey settings retain legacy passkey provenance', () => {
    assert.equal(inferPersistedEncryptionMode({
        accountId: '1234567890123456',
        credentialId: 'legacy-authentication-credential',
        githubLinked: true
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
