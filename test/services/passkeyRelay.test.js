import test from 'node:test';
import assert from 'node:assert/strict';

import {
    deserializeCredentialOptions,
    normalizeRelayError,
    parseRelayRequest,
    serializeCredential
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
