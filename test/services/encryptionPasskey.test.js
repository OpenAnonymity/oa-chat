import assert from 'node:assert/strict';
import test from 'node:test';
import { webcrypto } from 'node:crypto';

import {
    createEncryptionKeyWrapper,
    createEncryptionKeyWrapperFromPrf,
    unlockEncryptionKeyring,
    unlockEncryptionKeyringFromPrf
} from '../../chat/services/encryptionPasskey.js';

const CREDENTIAL_ID = 'Y3JlZGVudGlhbC0x';

function credential(id, prfResult, enabled = true) {
    return {
        id,
        getClientExtensionResults() {
            return {
                prf: {
                    enabled,
                    results: prfResult
                        ? { first: prfResult.buffer.slice(0) }
                        : undefined
                }
            };
        }
    };
}

function installBrowserCredentials({ create, get }) {
    const previousCrypto = globalThis.crypto;
    const previousWindow = globalThis.window;
    const previousNavigator = globalThis.navigator;

    Object.defineProperty(globalThis, 'crypto', {
        configurable: true,
        value: webcrypto
    });
    Object.defineProperty(globalThis, 'window', {
        configurable: true,
        value: { PublicKeyCredential: class PublicKeyCredential {} }
    });
    Object.defineProperty(globalThis, 'navigator', {
        configurable: true,
        value: { credentials: { create, get } }
    });

    return () => {
        Object.defineProperty(globalThis, 'crypto', {
            configurable: true,
            value: previousCrypto
        });
        Object.defineProperty(globalThis, 'window', {
            configurable: true,
            value: previousWindow
        });
        Object.defineProperty(globalThis, 'navigator', {
            configurable: true,
            value: previousNavigator
        });
    };
}

test('PRF passkey wrapper round-trips a random account master key', async () => {
    const prf = new Uint8Array(32).fill(7);
    let getCalls = 0;
    const restore = installBrowserCredentials({
        // Simulate authenticators that confirm PRF support on create but return
        // the result only from the follow-up assertion.
        create: async () => credential(CREDENTIAL_ID, null, true),
        get: async () => {
            getCalls += 1;
            return credential(CREDENTIAL_ID, prf, true);
        }
    });

    try {
        const masterKey = webcrypto.getRandomValues(new Uint8Array(32));
        const expected = new Uint8Array(masterKey);
        const wrapper = await createEncryptionKeyWrapper(
            masterKey,
            'person@example.com'
        );
        const unlocked = await unlockEncryptionKeyring([wrapper]);

        assert.equal(wrapper.credentialId, CREDENTIAL_ID);
        assert.equal(wrapper.type, 'PASSKEY');
        assert.equal(wrapper.version, 1);
        assert.deepEqual(unlocked.masterKey, expected);
        assert.equal(getCalls, 2);
    } finally {
        restore();
    }
});

test('passkey creation fails when the authenticator does not enable PRF', async () => {
    const restore = installBrowserCredentials({
        create: async () => credential(CREDENTIAL_ID, null, false),
        get: async () => {
            throw new Error('get should not run');
        }
    });

    try {
        await assert.rejects(
            createEncryptionKeyWrapper(
                new Uint8Array(32),
                'person@example.com'
            ),
            /does not support encrypted data/
        );
    } finally {
        restore();
    }
});

test('missing browser-profile credential is classified only at the WebAuthn request', async () => {
    const missing = new DOMException('credential unavailable', 'NotFoundError');
    const restore = installBrowserCredentials({
        create: async () => null,
        get: async () => { throw missing; }
    });

    try {
        await assert.rejects(
            unlockEncryptionKeyring([{
                credentialId: CREDENTIAL_ID,
                type: 'PASSKEY',
                version: 1,
                wrappedKey: 'unused'
            }]),
            error => error.name === 'PasskeyUnavailableError' &&
                error.code === 'ENCRYPTION_PASSKEY_NOT_AVAILABLE' &&
                /private window/.test(error.message)
        );
    } finally {
        restore();
    }
});

test('passkey creation labels the WebAuthn user with the SSO email', async () => {
    const prf = new Uint8Array(32).fill(11);
    let creationOptions = null;
    const restore = installBrowserCredentials({
        create: async ({ publicKey }) => {
            creationOptions = publicKey;
            return credential(CREDENTIAL_ID, prf, true);
        },
        get: async () => {
            throw new Error('get should not run');
        }
    });

    try {
        await createEncryptionKeyWrapper(
            new Uint8Array(32),
            '  person@example.com  '
        );
        assert.equal(creationOptions.user.name, 'person@example.com');
        assert.equal(creationOptions.user.displayName, 'person@example.com');
    } finally {
        restore();
    }
});

test('passkey creation requires an SSO email label', async () => {
    let createCalls = 0;
    const restore = installBrowserCredentials({
        create: async () => {
            createCalls += 1;
            return null;
        },
        get: async () => null
    });

    try {
        await assert.rejects(
            createEncryptionKeyWrapper(new Uint8Array(32), ''),
            /label the passkey with your email/
        );
        assert.equal(createCalls, 0);
    } finally {
        restore();
    }
});

test('relay-evaluated PRF wraps and unlocks only its matching account credential', async () => {
    const masterKey = webcrypto.getRandomValues(new Uint8Array(32));
    const expected = new Uint8Array(masterKey);
    const prf = new Uint8Array(32).fill(23);
    const wrapper = await createEncryptionKeyWrapperFromPrf(
        masterKey,
        CREDENTIAL_ID,
        new Uint8Array(prf)
    );
    const unlocked = await unlockEncryptionKeyringFromPrf(
        [wrapper],
        CREDENTIAL_ID,
        new Uint8Array(prf)
    );
    assert.deepEqual(unlocked.masterKey, expected);
    assert.equal(unlocked.credentialId, CREDENTIAL_ID);
    await assert.rejects(
        unlockEncryptionKeyringFromPrf(
            [wrapper],
            'another-credential',
            new Uint8Array(prf)
        ),
        /not registered for this account/
    );
});
