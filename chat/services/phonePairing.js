// Phone pairing ("Sync from your computer"): the cryptography, and nothing
// else. docs/PHONE_PAIRING.md is the specification; this file is its wire
// format. Every byte here is pinned by test/fixtures/phone-pairing-v1.json,
// which the iOS implementation (OAPhonePairingCrypto.swift) must reproduce.
//
// Primitives: P-256 ECDH, HKDF-SHA256, AES-256-GCM (12-byte nonce, 16-byte
// tag), all through WebCrypto so the same code runs in the browser, OA
// Desktop's renderer and Node's test runner. No module state, no network.

const subtle = () => globalThis.crypto.subtle;

export const PAIRING_VERSION = 1;
export const QR_PREFIX = 'OAPAIR';
export const QR_ENVIRONMENTS = Object.freeze(['prod', 'staging']);
const INFO_MSG1 = 'oa-pairing/v1/phone->computer';
const INFO_MSG2 = 'oa-pairing/v1/computer->phone';
const AAD_MSG1 = 'msg1';
const AAD_MSG2 = 'msg2';
export const TUNNEL_ID_BYTES = 16;
export const QR_SECRET_BYTES = 32;
const POINT_BYTES = 65;

const text = new TextEncoder();

export function bytesToBase64Url(bytes) {
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function base64UrlToBytes(input) {
    if (typeof input !== 'string' || !/^[A-Za-z0-9_-]*$/.test(input)) throw new Error('Not base64url');
    const padded = input.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (input.length % 4)) % 4);
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
}

function concat(...parts) {
    const total = parts.reduce((sum, part) => sum + part.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) { out.set(part, offset); offset += part.length; }
    return out;
}

function expectLength(bytes, length, name) {
    if (!(bytes instanceof Uint8Array) || bytes.length !== length) throw new Error(`${name} must be ${length} bytes`);
    return bytes;
}

async function hkdf(ikm, salt, info) {
    const key = await subtle().importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
    const bits = await subtle().deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, 256);
    return new Uint8Array(bits);
}

async function aesKey(raw, usage) {
    return subtle().importKey('raw', raw, { name: 'AES-GCM' }, false, [usage]);
}

// --- Keys ------------------------------------------------------------------

/** An ephemeral P-256 pair; `pub` is the 65-byte uncompressed point. */
export async function generateEphemeralKeyPair() {
    const pair = await subtle().generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
    const pub = new Uint8Array(await subtle().exportKey('raw', pair.publicKey));
    return { privateKey: pair.privateKey, pub };
}

/** Imports a private key from its JWK (fixtures and tests only). */
export async function importPrivateKeyJwk(jwk) {
    return subtle().importKey('jwk', jwk, { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
}

async function importPublicPoint(pub) {
    expectLength(pub, POINT_BYTES, 'public point');
    if (pub[0] !== 0x04) throw new Error('public point must be uncompressed');
    return subtle().importKey('raw', pub, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
}

/** The ECDH shared secret: the 32-byte x-coordinate, as CryptoKit returns it. */
export async function ecdh(privateKey, peerPub) {
    const peer = await importPublicPoint(peerPub);
    return new Uint8Array(await subtle().deriveBits({ name: 'ECDH', public: peer }, privateKey, 256));
}

export async function deriveK1({ qrSecret, tunnelId }) {
    return hkdf(expectLength(qrSecret, QR_SECRET_BYTES, 'qrSecret'), expectLength(tunnelId, TUNNEL_ID_BYTES, 'tunnelId'), text.encode(INFO_MSG1));
}

export async function deriveK2({ shared, qrSecret, tunnelId, cPub, pPub }) {
    expectLength(shared, 32, 'shared');
    expectLength(cPub, POINT_BYTES, 'cPub');
    expectLength(pPub, POINT_BYTES, 'pPub');
    return hkdf(
        concat(shared, expectLength(qrSecret, QR_SECRET_BYTES, 'qrSecret')),
        expectLength(tunnelId, TUNNEL_ID_BYTES, 'tunnelId'),
        concat(text.encode(INFO_MSG2), cPub, pPub)
    );
}

// --- Messages --------------------------------------------------------------

async function seal(keyBytes, nonce, aad, plaintext) {
    expectLength(nonce, 12, 'nonce');
    const key = await aesKey(keyBytes, 'encrypt');
    return new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv: nonce, additionalData: aad, tagLength: 128 }, key, plaintext));
}

async function open(keyBytes, nonce, aad, ciphertext) {
    expectLength(nonce, 12, 'nonce');
    const key = await aesKey(keyBytes, 'decrypt');
    try {
        return new Uint8Array(await subtle().decrypt({ name: 'AES-GCM', iv: nonce, additionalData: aad, tagLength: 128 }, key, ciphertext));
    } catch {
        throw new Error('The pairing message could not be opened');
    }
}

const aadMsg1 = tunnelId => concat(text.encode(AAD_MSG1), tunnelId);
const aadMsg2 = tunnelId => concat(text.encode(AAD_MSG2), tunnelId);

/** Phone → computer, under K1. `plaintext` is the encoded JSON bytes. */
export function sealMsg1({ k1, tunnelId, nonce, plaintext }) {
    return seal(k1, nonce, aadMsg1(tunnelId), plaintext);
}
export function openMsg1({ k1, tunnelId, nonce, ciphertext }) {
    return open(k1, nonce, aadMsg1(tunnelId), ciphertext);
}

/** Computer → phone, under K2. */
export function sealMsg2({ k2, tunnelId, nonce, plaintext }) {
    return seal(k2, nonce, aadMsg2(tunnelId), plaintext);
}
export function openMsg2({ k2, tunnelId, nonce, ciphertext }) {
    return open(k2, nonce, aadMsg2(tunnelId), ciphertext);
}

// --- Plaintexts ------------------------------------------------------------

/** The phone's message, as bytes. Field order is fixed so both sides agree. */
export function encodePhoneMessage({ pPub, kind, accountId, device }) {
    if (!['google', 'username'].includes(kind)) throw new Error('kind');
    if (!['iPhone', 'iPad'].includes(device)) throw new Error('device');
    if (typeof accountId !== 'string' || !accountId) throw new Error('accountId');
    return text.encode(JSON.stringify({
        v: PAIRING_VERSION,
        pPub: bytesToBase64Url(expectLength(pPub, POINT_BYTES, 'pPub')),
        account: { kind, accountId },
        device
    }));
}

export function decodePhoneMessage(bytes) {
    const message = JSON.parse(new TextDecoder().decode(bytes));
    if (message?.v !== PAIRING_VERSION) throw new Error('Unsupported pairing message version');
    const pPub = base64UrlToBytes(message.pPub);
    expectLength(pPub, POINT_BYTES, 'pPub');
    if (!['google', 'username'].includes(message.account?.kind)) throw new Error('kind');
    if (typeof message.account?.accountId !== 'string' || !message.account.accountId) throw new Error('accountId');
    if (!['iPhone', 'iPad'].includes(message.device)) throw new Error('device');
    return { pPub, kind: message.account.kind, accountId: message.account.accountId, device: message.device };
}

/** The computer's message: the master key and, for username accounts, the grant. */
export function encodeComputerMessage({ masterKey, grant = null }) {
    expectLength(masterKey, 32, 'masterKey');
    const message = { v: PAIRING_VERSION, masterKey: bytesToBase64Url(masterKey) };
    if (grant !== null) {
        if (typeof grant !== 'string' || !grant) throw new Error('grant');
        message.grant = grant;
    }
    return text.encode(JSON.stringify(message));
}

export function decodeComputerMessage(bytes) {
    const message = JSON.parse(new TextDecoder().decode(bytes));
    if (message?.v !== PAIRING_VERSION) throw new Error('Unsupported pairing message version');
    const masterKey = base64UrlToBytes(message.masterKey);
    expectLength(masterKey, 32, 'masterKey');
    const grant = message.grant === undefined ? null : message.grant;
    if (grant !== null && (typeof grant !== 'string' || !grant)) throw new Error('grant');
    return { masterKey, grant };
}

// --- QR --------------------------------------------------------------------

export function encodeQr({ env, tunnelId, qrSecret, cPub }) {
    if (!QR_ENVIRONMENTS.includes(env)) throw new Error('env');
    return [
        QR_PREFIX, String(PAIRING_VERSION), env,
        bytesToBase64Url(expectLength(tunnelId, TUNNEL_ID_BYTES, 'tunnelId')),
        bytesToBase64Url(expectLength(qrSecret, QR_SECRET_BYTES, 'qrSecret')),
        bytesToBase64Url(expectLength(cPub, POINT_BYTES, 'cPub'))
    ].join('/');
}

/** Parses a QR line; throws on anything that is not exactly this format. */
export function parseQr(line, { env } = {}) {
    if (typeof line !== 'string') throw new Error('Not an OA pairing code');
    const parts = line.split('/');
    if (parts.length !== 6 || parts[0] !== QR_PREFIX) throw new Error('Not an OA pairing code');
    if (parts[1] !== String(PAIRING_VERSION)) throw new Error('This pairing code needs a newer app');
    if (!QR_ENVIRONMENTS.includes(parts[2])) throw new Error('Not an OA pairing code');
    if (env && parts[2] !== env) throw new Error(`This code is for ${parts[2]}, not ${env}`);
    const tunnelId = base64UrlToBytes(parts[3]);
    const qrSecret = base64UrlToBytes(parts[4]);
    const cPub = base64UrlToBytes(parts[5]);
    expectLength(tunnelId, TUNNEL_ID_BYTES, 'tunnelId');
    expectLength(qrSecret, QR_SECRET_BYTES, 'qrSecret');
    expectLength(cPub, POINT_BYTES, 'cPub');
    if (cPub[0] !== 0x04) throw new Error('Not an OA pairing code');
    return { env: parts[2], tunnelId, qrSecret, cPub };
}

/** Random bytes for nonces, secrets and ephemeral material. */
export function randomBytes(length) {
    return globalThis.crypto.getRandomValues(new Uint8Array(length));
}
