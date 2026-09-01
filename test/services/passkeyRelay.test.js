import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';

import {
    deserializeCredentialOptions,
    normalizeRelayError,
    parseRelayRequest,
    parseSingleBrowserCompletion,
    parseSingleBrowserStart,
    performSingleBrowserPasskey,
    serializeCredential,
    validateSingleBrowserContext
} from '../../chat/passkey-relay.js';

const encodedOptions = encodeURIComponent(JSON.stringify({
    publicKey: { challenge: 'YWJj' }
}));

test('passkey relay accepts only a nonce, random loopback port, operation, and options', () => {
    assert.deepEqual(
        parseRelayRequest(`#nonce=${'a'.repeat(32)}&port=49152&type=get&options=${encodedOptions}`),
        {
            nonce: 'a'.repeat(32),
            port: 49152,
            type: 'get',
            options: { publicKey: { challenge: 'YWJj' } }
        }
    );
});

test('passkey relay rejects malformed callback requests', () => {
    for (const fragment of [
        '',
        `#nonce=short&port=49152&type=get&options=${encodedOptions}`,
        `#nonce=${'a'.repeat(32)}&port=80&type=get&options=${encodedOptions}`,
        `#nonce=${'a'.repeat(32)}&port=49152&type=delete&options=${encodedOptions}`,
        `#nonce=${'a'.repeat(32)}&port=49152&type=get&options=not-json`
    ]) {
        assert.throws(() => parseRelayRequest(fragment));
    }
});

test('passkey relay exposes only non-sensitive error categories', () => {
    assert.equal(normalizeRelayError({ name: 'NotAllowedError' }), 'Passkey request canceled');
    assert.equal(normalizeRelayError({ name: 'InvalidStateError' }), 'Passkey already registered');
    assert.equal(normalizeRelayError(new Error('secret raw authenticator failure')), 'Passkey request failed');
});

test('passkey relay preserves PRF bytes only in the local credential result', () => {
    const options = deserializeCredentialOptions({
        publicKey: {
            challenge: 'AQID',
            extensions: { prf: { eval: { first: 'BAUG' } } }
        }
    });
    assert.deepEqual([...new Uint8Array(options.publicKey.challenge)], [1, 2, 3]);
    assert.deepEqual(
        [...new Uint8Array(options.publicKey.extensions.prf.eval.first)],
        [4, 5, 6]
    );

    const credential = {
        id: 'credential-id',
        rawId: Uint8Array.from([7, 8]).buffer,
        type: 'public-key',
        authenticatorAttachment: 'platform',
        response: {
            clientDataJSON: Uint8Array.from([9]).buffer,
            authenticatorData: Uint8Array.from([10]).buffer,
            signature: Uint8Array.from([11]).buffer,
            userHandle: null
        },
        getClientExtensionResults: () => ({
            prf: { results: { first: Uint8Array.from([12, 13]).buffer } }
        })
    };
    assert.equal(
        serializeCredential(credential, 'get').clientExtensionResults.prf.results.first,
        'DA0='
    );
});

test('single-browser relay accepts only the same-origin desktop authorize route', () => {
    const origin = 'https://oa-staging-main.vercel.app';
    const authorizationUrl = `${origin}/auth/desktop/authorize?transaction=${'t'.repeat(43)}`;
    const fragment = new URLSearchParams({
        mode: 'start',
        nonce: 'a'.repeat(32),
        port: '49152',
        authorizationUrl
    });
    assert.deepEqual(parseSingleBrowserStart(`#${fragment}`, origin), {
        mode: 'start',
        nonce: 'a'.repeat(32),
        port: 49152,
        authorizationUrl
    });

    fragment.set('authorizationUrl', 'https://attacker.example/auth/desktop/authorize');
    assert.throws(() => parseSingleBrowserStart(`#${fragment}`, origin));
    fragment.set('authorizationUrl', `${origin}/auth/google/start`);
    assert.throws(() => parseSingleBrowserStart(`#${fragment}`, origin));
});

test('single-browser completion requires bound opaque tokens or an explicit fallback', () => {
    const state = 's'.repeat(43);
    const code = 'c'.repeat(43);
    const context = 'x'.repeat(43);
    assert.deepEqual(
        parseSingleBrowserCompletion(
            `#mode=complete&state=${state}&code=${code}&context=${context}`
        ),
        { mode: 'complete', state, code, context, fallback: false }
    );
    assert.deepEqual(
        parseSingleBrowserCompletion(
            `#mode=complete&state=${state}&code=${code}&fallback=1`
        ),
        { mode: 'complete', state, code, context: '', fallback: true }
    );
    assert.throws(() => parseSingleBrowserCompletion(
        `#mode=complete&state=${state}&code=${code}`
    ));
});

test('single-browser passkey context is limited to create or account-bound get', () => {
    assert.deepEqual(validateSingleBrowserContext({
        operation: 'create',
        email: ' member@example.com ',
        credentialIds: []
    }), {
        operation: 'create',
        email: 'member@example.com',
        credentialIds: []
    });
    assert.deepEqual(validateSingleBrowserContext({
        operation: 'get',
        credentialIds: ['credential-id']
    }), {
        operation: 'get',
        email: null,
        credentialIds: ['credential-id']
    });
    assert.throws(() => validateSingleBrowserContext({
        operation: 'get',
        credentialIds: []
    }));
});

test('single-browser unlock rejects a credential outside the account context', async () => {
    const previousCrypto = globalThis.crypto;
    const previousNavigator = globalThis.navigator;
    Object.defineProperty(globalThis, 'crypto', {
        configurable: true,
        value: webcrypto
    });
    Object.defineProperty(globalThis, 'navigator', {
        configurable: true,
        value: {
            credentials: {
                get: async () => ({
                    id: 'Y3JlZGVudGlhbC0y',
                    getClientExtensionResults: () => ({
                        prf: { results: { first: new Uint8Array(32).buffer } }
                    })
                })
            }
        }
    });
    try {
        await assert.rejects(
            performSingleBrowserPasskey({
                operation: 'get',
                credentialIds: ['Y3JlZGVudGlhbC0x']
            }),
            /Passkey request failed/
        );
    } finally {
        Object.defineProperty(globalThis, 'crypto', {
            configurable: true,
            value: previousCrypto
        });
        Object.defineProperty(globalThis, 'navigator', {
            configurable: true,
            value: previousNavigator
        });
    }
});
