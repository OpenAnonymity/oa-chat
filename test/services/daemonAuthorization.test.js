import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
    bytesToBase64Url,
    base64UrlToBytes,
    clearDaemonIntent,
    consumeDaemonIntent,
    consumeDevicesIntent,
    createDaemonAuthorization,
    daemonPublicKeyHash,
    parseDaemonFragment,
    sealForDaemon,
    DAEMON_INTENT_STORAGE_KEY
} from '../../chat/services/daemonAuthorization.js';

// The runner bundles this file elsewhere, so the fixture is found from the repository root.
const fixturesDir = path.join(process.cwd(), 'test/fixtures');
const vector = JSON.parse(readFileSync(path.join(fixturesDir, 'daemon-auth-v1.json'), 'utf8'));

const transaction = 'T'.repeat(43);
const makeFragment = payload => `#oa-daemon=${bytesToBase64Url(new TextEncoder().encode(JSON.stringify(payload)))}`;

async function daemonKey() {
    const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
    const raw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
    return { pair, publicKey: bytesToBase64Url(raw), raw };
}

function memoryStorage() {
    const values = new Map();
    return {
        getItem: key => values.has(key) ? values.get(key) : null,
        setItem: (key, value) => values.set(key, value),
        removeItem: key => values.delete(key),
        values
    };
}

async function openAsDaemon(sealed, pair, rawPublic, txn) {
    const ephemeral = base64UrlToBytes(sealed.ephemeralPublicKey);
    const peer = await crypto.subtle.importKey('raw', ephemeral, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
    const shared = await crypto.subtle.deriveBits({ name: 'ECDH', public: peer }, pair.privateKey, 256);
    const hkdf = await crypto.subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey']);
    const hex = bytes => Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
    const key = await crypto.subtle.deriveKey({
        name: 'HKDF', hash: 'SHA-256',
        salt: await crypto.subtle.digest('SHA-256', new TextEncoder().encode(txn)),
        info: new TextEncoder().encode(`oa-daemon-auth/v1/browser->daemon|${hex(rawPublic)}|${hex(ephemeral)}`)
    }, hkdf, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
    const plaintext = await crypto.subtle.decrypt({
        name: 'AES-GCM', iv: base64UrlToBytes(sealed.nonce),
        additionalData: new TextEncoder().encode(`oa-daemon-auth/v1/envelope|${txn}`)
    }, key, base64UrlToBytes(sealed.ciphertext));
    return JSON.parse(new TextDecoder().decode(plaintext));
}

test('the fixed vector seals to the bytes the Go daemon opens', async () => {
    const ephemeral = {
        privateKey: await crypto.subtle.importKey('jwk', vector.ephemeralPrivateJwk, { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']),
        publicKey: await crypto.subtle.importKey('jwk', { ...vector.ephemeralPrivateJwk, d: undefined, key_ops: [] }, { name: 'ECDH', namedCurve: 'P-256' }, true, [])
    };
    const sealed = await sealForDaemon({
        daemonPublicKey: vector.daemonPublicKey,
        transaction: vector.transaction,
        accountId: vector.accountId,
        origin: vector.origin,
        masterKey: base64UrlToBytes(vector.masterKey),
        ephemeral,
        nonce: base64UrlToBytes(vector.sealed.nonce)
    });
    assert.deepEqual(sealed, vector.sealed);
});

test('a daemon opens the sealed key and the envelope binds its context', async () => {
    const { pair, publicKey, raw } = await daemonKey();
    const masterKey = crypto.getRandomValues(new Uint8Array(32));
    const sealed = await sealForDaemon({ daemonPublicKey: publicKey, transaction, accountId: '1234567890123456', origin: 'https://staging.openanonymity.ai', masterKey });
    const opened = await openAsDaemon(sealed, pair, raw, transaction);
    assert.equal(opened.masterKey, bytesToBase64Url(masterKey));
    assert.equal(opened.accountId, '1234567890123456');
    assert.equal(opened.origin, 'https://staging.openanonymity.ai');
    await assert.rejects(openAsDaemon(sealed, pair, raw, 'X'.repeat(43)));
    const other = await daemonKey();
    await assert.rejects(openAsDaemon(sealed, other.pair, other.raw, transaction));
    assert.equal(JSON.stringify(sealed).includes(bytesToBase64Url(masterKey)), false);
});

test('sealing refuses a malformed key or master key', async () => {
    const { publicKey } = await daemonKey();
    await assert.rejects(sealForDaemon({ daemonPublicKey: publicKey, transaction, accountId: '1', origin: 'o', masterKey: new Uint8Array(16) }));
    await assert.rejects(sealForDaemon({ daemonPublicKey: bytesToBase64Url(new Uint8Array(65)), transaction, accountId: '1', origin: 'o', masterKey: new Uint8Array(32) }));
});

test('only a well-formed fragment is an intent', () => {
    const k = `BA${'A'.repeat(85)}`;
    assert.deepEqual(parseDaemonFragment(makeFragment({ v: 1, t: transaction, k })), { transaction, daemonPublicKey: k });
    for (const bad of [
        '', '#', '#other=1', '#oa-daemon=%%%', makeFragment({ v: 2, t: transaction, k }),
        makeFragment({ v: 1, t: 'short', k }), makeFragment({ v: 1, t: transaction, k: 'short' }),
        makeFragment({ v: 1, t: `${transaction}<script>`, k })
    ]) {
        assert.equal(parseDaemonFragment(bad), null, bad);
    }
});

test('the intent leaves the address at once and survives a same-tab sign-in', () => {
    const k = `BA${'A'.repeat(85)}`;
    const storage = memoryStorage();
    const replaced = [];
    const locationImpl = { hash: makeFragment({ v: 1, t: transaction, k }), pathname: '/', search: '?x=1' };
    const historyImpl = { state: null, replaceState: (_s, _t, url) => replaced.push(url) };
    const intent = consumeDaemonIntent({ locationImpl, historyImpl, storage, now: 1000 });
    assert.equal(intent.transaction, transaction);
    assert.deepEqual(replaced, ['/?x=1']);
    const resumed = consumeDaemonIntent({ locationImpl: { hash: '', pathname: '/', search: '' }, historyImpl, storage, now: 2000 });
    assert.equal(resumed.daemonPublicKey, k);
    clearDaemonIntent(storage);
    assert.equal(storage.values.has(DAEMON_INTENT_STORAGE_KEY), false);
});

test('a stale or malformed saved intent is dropped; a bad fragment is still removed', () => {
    const k = `BA${'A'.repeat(85)}`;
    const storage = memoryStorage();
    storage.setItem(DAEMON_INTENT_STORAGE_KEY, JSON.stringify({ transaction, daemonPublicKey: k, savedAt: 0 }));
    assert.equal(consumeDaemonIntent({ locationImpl: { hash: '' }, historyImpl: {}, storage, now: 16 * 60 * 1000 }), null);
    assert.equal(storage.values.has(DAEMON_INTENT_STORAGE_KEY), false);
    const replaced = [];
    const result = consumeDaemonIntent({
        locationImpl: { hash: '#oa-daemon=garbage', pathname: '/', search: '' },
        historyImpl: { state: null, replaceState: (_s, _t, url) => replaced.push(url) },
        storage
    });
    assert.equal(result, null);
    assert.deepEqual(replaced, ['/']);
});

test('the devices view opens only from its exact fragment', () => {
    const replaced = [];
    const historyImpl = { state: null, replaceState: (_s, _t, url) => replaced.push(url) };
    assert.equal(consumeDevicesIntent({ locationImpl: { hash: '#oa-daemon-devices', pathname: '/', search: '' }, historyImpl }), true);
    assert.equal(consumeDevicesIntent({ locationImpl: { hash: '#oa-daemon-devices2', pathname: '/', search: '' }, historyImpl }), false);
    assert.deepEqual(replaced, ['/']);
});

function harness({ lookup, responses = {}, account = '1234567890123456', reveal } = {}) {
    const calls = [];
    const state = { account };
    const revealed = [];
    return {
        calls, state, revealed,
        async build(publicKey) {
            const hash = await daemonPublicKeyHash(publicKey);
            return createDaemonAuthorization({
                intent: { transaction, daemonPublicKey: publicKey },
                origin: 'https://staging.openanonymity.ai',
                accountId: () => state.account,
                request: async (path, body) => {
                    calls.push({ path, body });
                    if (responses[path]) return responses[path](body);
                    if (path === '/auth/daemon/lookup') return { clientName: 'oa-clientd', clientVersion: '1.0.0', platform: 'darwin/arm64', expiresIn: 600, sameNetwork: true, daemonPublicKeyHash: lookup || hash };
                    return { success: true };
                },
                revealMasterKey: reveal || (async () => {
                    const key = new Uint8Array(32).fill(7);
                    revealed.push(key);
                    return key;
                })
            });
        }
    };
}

test('approval sends only a sealed envelope, never the key, and zeroes it', async () => {
    const { pair, publicKey, raw } = await daemonKey();
    const h = harness();
    const session = await h.build(publicKey);
    await session.load();
    assert.equal(session.getState().status, 'review');
    assert.equal(h.calls.some(call => call.path === '/auth/daemon/approve'), false);
    await session.approve('ABCD-EFGH');
    assert.equal(session.getState().status, 'done');
    const approve = h.calls.find(call => call.path === '/auth/daemon/approve');
    assert.equal(JSON.stringify(h.calls).includes(bytesToBase64Url(new Uint8Array(32).fill(7))), false);
    const opened = await openAsDaemon(approve.body.sealed, pair, raw, transaction);
    assert.equal(opened.masterKey, bytesToBase64Url(new Uint8Array(32).fill(7)));
    assert.deepEqual(h.revealed[0], new Uint8Array(32));
});

test('a link whose key differs from the org record stops before any prompt', async () => {
    const { publicKey } = await daemonKey();
    const h = harness({ lookup: '0'.repeat(64) });
    const session = await h.build(publicKey);
    await session.load();
    assert.equal(session.getState().status, 'failed');
    await session.approve('ABCD-EFGH');
    assert.equal(h.revealed.length, 0);
});

test('a wrong code does not reach the passkey prompt and can be retried', async () => {
    const { publicKey } = await daemonKey();
    let first = true;
    const h = harness({ responses: {
        '/auth/daemon/check-code': () => {
            if (first) {
                first = false;
                throw Object.assign(new Error('bad'), { code: 'DAEMON_AUTH_BAD_CODE' });
            }
            return { success: true };
        }
    } });
    const session = await h.build(publicKey);
    await session.load();
    await session.approve('AAAA-AAAA');
    assert.equal(session.getState().status, 'review');
    assert.match(session.getState().error, /code does not match/);
    assert.equal(h.revealed.length, 0);
    await session.approve('ABCD-EFGH');
    assert.equal(session.getState().status, 'done');
});

test('a cancelled passkey prompt sends nothing', async () => {
    const { publicKey } = await daemonKey();
    const h = harness({ reveal: async () => { throw new DOMException('no', 'NotAllowedError'); } });
    const session = await h.build(publicKey);
    await session.load();
    await session.approve('ABCD-EFGH');
    assert.equal(session.getState().status, 'review');
    assert.equal(h.calls.some(call => call.path === '/auth/daemon/approve'), false);
});

test('an account change during approval zeroes the key and sends nothing', async () => {
    const { publicKey } = await daemonKey();
    const keys = [];
    const h = harness({ reveal: async () => {
        const key = new Uint8Array(32).fill(9);
        keys.push(key);
        h.state.account = '6543210987654321';
        return key;
    } });
    const session = await h.build(publicKey);
    await session.load();
    await session.approve('ABCD-EFGH');
    assert.equal(session.getState().status, 'failed');
    assert.equal(h.calls.some(call => call.path === '/auth/daemon/approve'), false);
    assert.deepEqual(keys[0], new Uint8Array(32));
});

test('an expired transaction ends the dialog', async () => {
    const { publicKey } = await daemonKey();
    const h = harness({ responses: { '/auth/daemon/lookup': () => { throw Object.assign(new Error('gone'), { code: 'DAEMON_AUTH_EXPIRED' }); } } });
    const session = await h.build(publicKey);
    await session.load();
    assert.equal(session.getState().status, 'expired');
});

test('declining reports to the org and is final', async () => {
    const { publicKey } = await daemonKey();
    const h = harness();
    const session = await h.build(publicKey);
    await session.load();
    await session.decline();
    assert.equal(session.getState().status, 'declined');
    assert.equal(h.calls.at(-1).path, '/auth/daemon/deny');
    await session.approve('ABCD-EFGH');
    assert.equal(h.revealed.length, 0);
});

test('the device list is a POST so a same-origin browser sends its Origin', () => {
    const source = readFileSync(path.join(process.cwd(), 'chat/components/DaemonAuthorizeModal.js'), 'utf8');
    assert.match(source, /daemonAuthRequest\('\/auth\/daemon\/devices\/list', \{\}\)/);
    assert.doesNotMatch(source, /method: 'GET'/);
});

test('a lost approval response never claims nothing was sent', async () => {
    const { publicKey } = await daemonKey();
    const h = harness({ responses: { '/auth/daemon/approve': () => { throw new Error('network'); } } });
    const session = await h.build(publicKey);
    await session.load();
    await session.approve('ABCD-EFGH');
    assert.equal(session.getState().status, 'failed');
    assert.doesNotMatch(session.getState().error, /Nothing was sent/);
});

test('the landing hand-off leaves the address too', () => {
    const replaced = [];
    const fragment = makeFragment({ v: 1, t: transaction, k: 'BA' + 'x'.repeat(85) });
    const intent = consumeDaemonIntent({
        locationImpl: { hash: fragment, pathname: '/', search: '?auth=daemon&c=abc' },
        historyImpl: { state: null, replaceState: (_s, _t, url) => replaced.push(url) },
        storage: memoryStorage(),
        now: 1000
    });
    assert.equal(intent.transaction, transaction);
    assert.equal(intent.savedAt, 1000);
    assert.deepEqual(replaced, ['/?c=abc']);
});

test('an idle review ends when the account changes or the request expires', async () => {
    const { publicKey } = await daemonKey();
    const hash = await daemonPublicKeyHash(publicKey);
    const details = { clientName: 'oa-clientd', clientVersion: '1', platform: 'x', expiresIn: 10, daemonPublicKeyHash: hash };
    const open = async overrides => {
        const session = createDaemonAuthorization({
            intent: { transaction, daemonPublicKey: publicKey }, origin: 'https://app.test',
            request: async () => details, revealMasterKey: async () => assert.fail('no prompt'),
            accountId: () => 'acct', ...overrides
        });
        await session.load();
        return session;
    };
    let account = 'acct';
    const changed = await open({ accountId: () => account });
    assert.equal(changed.getState().status, 'review');
    account = 'other';
    changed.revalidate();
    assert.equal(changed.getState().status, 'failed');

    let clock = 1000;
    const expiring = await open({ now: () => clock });
    clock += 11000;
    expiring.revalidate();
    assert.equal(expiring.getState().status, 'expired');

    const unsupported = await open({ accountSupported: () => false });
    assert.equal(unsupported.getState().status, 'failed');
    assert.match(unsupported.getState().error, /cannot authorize/);
});

test('every class the dialog uses is in the committed stylesheet', () => {
    const css = readFileSync(path.join(process.cwd(), 'chat/tailwind.generated.css'), 'utf8');
    const source = readFileSync(path.join(process.cwd(), 'chat/components/DaemonAuthorizeModal.js'), 'utf8');
    const classes = new Set();
    for (const [, value] of source.matchAll(/(?:class="|className = '|buttonBase = '|card = ')([^"']+)["']/g)) {
        value.replace(/\$\{[^}]*\}/g, ' ').split(/\s+/).filter(Boolean).forEach(name => classes.add(name));
    }
    classes.delete('daemon-authorize-modal');
    for (const name of [...classes]) {
        if (name.startsWith('daemon-')) classes.delete(name);
    }
    assert.ok(classes.size > 20);
    const escape = name => name.replace(/[^a-zA-Z0-9_-]/g, char => `\\${char}`);
    const missing = [...classes].filter(name => !css.includes(`.${escape(name)}`));
    assert.deepEqual(missing, []);
});
