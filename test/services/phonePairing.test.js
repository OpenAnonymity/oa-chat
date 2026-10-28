import test from 'node:test';
import assert from 'node:assert/strict';
import fixture from '../fixtures/phone-pairing-v1.json' with { type: 'json' };
import { createECDH } from 'node:crypto';

import {
    base64UrlToBytes, bytesToBase64Url, importPrivateKeyJwk, generateEphemeralKeyPair, ecdh,
    deriveK1, deriveK2, sealMsg1, openMsg1, sealMsg2, openMsg2,
    encodePhoneMessage, decodePhoneMessage, encodeComputerMessage, decodeComputerMessage,
    encodeQr, parseQr, randomBytes
} from '../../chat/services/phonePairing.js';

// The vectors the iOS implementation must also reproduce (docs/PHONE_PAIRING.md).
const b = base64UrlToBytes;
const same = (actual, expected, what) => assert.equal(bytesToBase64Url(actual), expected, what);

function keyFromScalar(scalarB64) {
    const priv = Buffer.from(b(scalarB64));
    const ec = createECDH('prime256v1');
    ec.setPrivateKey(priv);
    const pub = ec.getPublicKey();
    return importPrivateKeyJwk({ kty: 'EC', crv: 'P-256', d: scalarB64, x: bytesToBase64Url(pub.subarray(1, 33)), y: bytesToBase64Url(pub.subarray(33, 65)), ext: true });
}

test('the fixture is self-consistent: points, shared secret and both keys', async () => {
    const cKey = await keyFromScalar(fixture.computer.privateScalar);
    const pKey = await keyFromScalar(fixture.phone.privateScalar);
    const tunnelId = b(fixture.tunnelId);
    const qrSecret = b(fixture.qrSecret);
    const cPub = b(fixture.computer.pub);
    const pPub = b(fixture.phone.pub);
    assert.equal(cPub.length, 65);
    assert.equal(pPub.length, 65);

    same(await ecdh(cKey, pPub), fixture.shared, 'ECDH from the computer side');
    same(await ecdh(pKey, cPub), fixture.shared, 'ECDH from the phone side');
    same(await deriveK1({ qrSecret, tunnelId }), fixture.k1, 'K1');
    same(await deriveK2({ shared: b(fixture.shared), qrSecret, tunnelId, cPub, pPub }), fixture.k2, 'K2');
});

test('both messages seal to the fixture bytes and open back to the fixture plaintexts', async () => {
    const tunnelId = b(fixture.tunnelId);
    const k1 = b(fixture.k1);
    const k2 = b(fixture.k2);

    same(await sealMsg1({ k1, tunnelId, nonce: b(fixture.msg1.nonce), plaintext: b(fixture.msg1.plaintext) }), fixture.msg1.ciphertext, 'msg1');
    same(await openMsg1({ k1, tunnelId, nonce: b(fixture.msg1.nonce), ciphertext: b(fixture.msg1.ciphertext) }), fixture.msg1.plaintext, 'msg1 opened');
    same(await sealMsg2({ k2, tunnelId, nonce: b(fixture.msg2.nonce), plaintext: b(fixture.msg2.plaintext) }), fixture.msg2.ciphertext, 'msg2');
    same(await openMsg2({ k2, tunnelId, nonce: b(fixture.msg2.nonce), ciphertext: b(fixture.msg2.ciphertext) }), fixture.msg2.plaintext, 'msg2 opened');

    const phone = decodePhoneMessage(b(fixture.msg1.plaintext));
    assert.equal(phone.kind, fixture.expected.kind);
    assert.equal(phone.accountId, fixture.expected.accountId);
    assert.equal(phone.device, fixture.expected.device);
    same(phone.pPub, fixture.phone.pub, 'pPub inside msg1');
    const computer = decodeComputerMessage(b(fixture.msg2.plaintext));
    same(computer.masterKey, fixture.expected.masterKey, 'master key inside msg2');
    assert.equal(computer.grant, fixture.expected.grant);
    // The encoders produce exactly the fixture bytes, so field order is pinned.
    same(encodePhoneMessage({ pPub: b(fixture.phone.pub), kind: phone.kind, accountId: phone.accountId, device: phone.device }), fixture.msg1.plaintext, 'phone message encoding');
    same(encodeComputerMessage({ masterKey: computer.masterKey, grant: computer.grant }), fixture.msg2.plaintext, 'computer message encoding');
});

test('a message is bound to its tunnel, its direction and its key', async () => {
    const tunnelId = b(fixture.tunnelId);
    const other = randomBytes(16);
    const k1 = b(fixture.k1);
    const k2 = b(fixture.k2);
    const nonce = b(fixture.msg1.nonce);
    const ciphertext = b(fixture.msg1.ciphertext);
    await assert.rejects(openMsg1({ k1, tunnelId: other, nonce, ciphertext }), /could not be opened/);
    await assert.rejects(openMsg2({ k2: k1, tunnelId, nonce, ciphertext }), /could not be opened/);
    await assert.rejects(openMsg1({ k1: k2, tunnelId, nonce, ciphertext }), /could not be opened/);
    const flipped = Uint8Array.from(ciphertext);
    flipped[3] ^= 1;
    await assert.rejects(openMsg1({ k1, tunnelId, nonce, ciphertext: flipped }), /could not be opened/);
});

test('the QR line round-trips, carries nothing but the three values, and refuses other environments', () => {
    assert.equal(fixture.qr, encodeQr({ env: 'staging', tunnelId: b(fixture.tunnelId), qrSecret: b(fixture.qrSecret), cPub: b(fixture.computer.pub) }));
    const parsed = parseQr(fixture.qr, { env: 'staging' });
    same(parsed.tunnelId, fixture.tunnelId);
    same(parsed.qrSecret, fixture.qrSecret);
    same(parsed.cPub, fixture.computer.pub);
    assert.ok(!fixture.qr.includes(fixture.expected.accountId));
    assert.ok(!/https?:/.test(fixture.qr));
    assert.throws(() => parseQr(fixture.qr, { env: 'prod' }), /staging, not prod/);
    assert.throws(() => parseQr(fixture.qr.replace('OAPAIR/1/', 'OAPAIR/2/')), /newer app/);
    assert.throws(() => parseQr('https://example.com/' + fixture.qr), /Not an OA pairing code/);
    assert.throws(() => parseQr(fixture.qr + '/extra'), /Not an OA pairing code/);
});

test('a fresh pairing with random material works end to end, and the org only ever holds ciphertext', async () => {
    const tunnelId = randomBytes(16);
    const qrSecret = randomBytes(32);
    const computer = await generateEphemeralKeyPair();
    const qr = encodeQr({ env: 'prod', tunnelId, qrSecret, cPub: computer.pub });

    // Phone.
    const scanned = parseQr(qr, { env: 'prod' });
    const phone = await generateEphemeralKeyPair();
    const k1Phone = await deriveK1({ qrSecret: scanned.qrSecret, tunnelId: scanned.tunnelId });
    const nonce1 = randomBytes(12);
    const msg1 = await sealMsg1({ k1: k1Phone, tunnelId: scanned.tunnelId, nonce: nonce1, plaintext: encodePhoneMessage({ pPub: phone.pub, kind: 'google', accountId: '9999888877776666', device: 'iPad' }) });

    // Computer: what the org handed over is only nonce1 + msg1.
    const k1 = await deriveK1({ qrSecret, tunnelId });
    const phoneMessage = decodePhoneMessage(await openMsg1({ k1, tunnelId, nonce: nonce1, ciphertext: msg1 }));
    assert.equal(phoneMessage.kind, 'google');
    const masterKey = randomBytes(32);
    const k2 = await deriveK2({ shared: await ecdh(computer.privateKey, phoneMessage.pPub), qrSecret, tunnelId, cPub: computer.pub, pPub: phoneMessage.pPub });
    const nonce2 = randomBytes(12);
    const msg2 = await sealMsg2({ k2, tunnelId, nonce: nonce2, plaintext: encodeComputerMessage({ masterKey }) });

    // Phone again.
    const k2Phone = await deriveK2({ shared: await ecdh(phone.privateKey, scanned.cPub), qrSecret: scanned.qrSecret, tunnelId: scanned.tunnelId, cPub: scanned.cPub, pPub: phone.pub });
    const received = decodeComputerMessage(await openMsg2({ k2: k2Phone, tunnelId: scanned.tunnelId, nonce: nonce2, ciphertext: msg2 }));
    assert.deepEqual(received.masterKey, masterKey);
    assert.equal(received.grant, null);

    // The org's view: neither ciphertext contains the key, the secret or the plaintext.
    for (const held of [msg1, msg2]) {
        const hex = Buffer.from(held).toString('hex');
        assert.ok(!hex.includes(Buffer.from(masterKey).toString('hex')));
        assert.ok(!hex.includes(Buffer.from(qrSecret).toString('hex')));
        assert.ok(!Buffer.from(held).toString('latin1').includes('accountId'));
    }
    // And without the QR secret, even the ECDH secret does not open msg2.
    const wrongK2 = await deriveK2({ shared: await ecdh(phone.privateKey, scanned.cPub), qrSecret: randomBytes(32), tunnelId, cPub: computer.pub, pPub: phone.pub });
    await assert.rejects(openMsg2({ k2: wrongK2, tunnelId, nonce: nonce2, ciphertext: msg2 }), /could not be opened/);
});
