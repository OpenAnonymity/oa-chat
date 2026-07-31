import test from 'node:test';
import assert from 'node:assert/strict';

import privacyPassProvider from '../../chat/services/privacyPass.js';
import { publicVerif } from '../../chat/vendor/privacypass-ts/privacypass-ts.min.js';

function encode(bytes) {
    return Buffer.from(bytes).toString('base64url');
}

function decode(value) {
    return new Uint8Array(Buffer.from(value, 'base64url'));
}

test('serialized Privacy Pass state finalizes after the live client object is discarded', async () => {
    const mode = publicVerif.BlindRSAMode.PSS;
    const keyPair = await publicVerif.Issuer.generateKey(mode, {
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1])
    });
    const issuer = new publicVerif.Issuer(
        mode,
        'local-persistence-test',
        keyPair.privateKey,
        keyPair.publicKey
    );
    const publicKey = encode(await publicVerif.getPublicKeyBytes(keyPair.publicKey));
    const created = await privacyPassProvider.createSingleTokenRequest(publicKey);
    const blinded = publicVerif.TokenRequest.deserialize(
        publicVerif.BLIND_RSA,
        decode(created.blindedRequest)
    );
    const signed = await issuer.issue(blinded);

    const finalized = await privacyPassProvider.finalizeToken(
        encode(signed.serialize()),
        structuredClone(created.serializedState)
    );

    assert.equal(typeof finalized, 'string');
    assert.ok(finalized.length > 100);
    assert.equal(created.serializedState.protocol, 'public-token-blind-rsa');
});
