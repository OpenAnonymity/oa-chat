import test from 'node:test';
import assert from 'node:assert/strict';

import { createPhonePairingSession } from '../../chat/services/phonePairingSession.js';
import {
    randomBytes, generateEphemeralKeyPair, ecdh, deriveK1, deriveK2, sealMsg1, openMsg2,
    encodePhoneMessage, decodeComputerMessage, parseQr, base64UrlToBytes, bytesToBase64Url
} from '../../chat/services/phonePairing.js';

const ACCOUNT = '1234567890123456';

/** A fake org: the tunnel endpoints as the spec describes them, in memory. */
function fakeOrg() {
    const tunnels = new Map();
    const calls = [];
    const request = async (path, init = {}) => {
        const method = init.method || 'POST';
        calls.push(`${method} ${path}`);
        const reject = (status, code) => { const e = new Error(code); e.status = status; e.code = code; throw e; };
        let match;
        if (path === '/auth/pairing' && method === 'POST') {
            const tunnelId = bytesToBase64Url(randomBytes(16));
            tunnels.set(tunnelId, { createdAt: 1_800_000_000 });
            return { tunnelId, expiresAt: 1_800_000_000 + 120 };
        }
        if (path === '/auth/credentials/grant') return { grant: 'Z3JhbnQtZm9yLXRoZS1maXh0dXJlLW9ubHktMDAwMDAwMDA', expiresAt: 0 };
        if ((match = path.match(/^\/auth\/pairing\/([^/]+)$/))) {
            const tunnel = tunnels.get(match[1]);
            if (!tunnel) reject(404, 'PAIRING_TUNNEL_NOT_FOUND');
            if (method === 'DELETE') { tunnels.delete(match[1]); return {}; }
            return tunnel.msg1 ? { ready: true, expiresAt: 0, phone: tunnel.msg1 } : { ready: false, expiresAt: 0 };
        }
        if ((match = path.match(/^\/auth\/pairing\/([^/]+)\/computer$/))) {
            const tunnel = tunnels.get(match[1]);
            if (!tunnel) reject(404, 'PAIRING_TUNNEL_NOT_FOUND');
            if (!tunnel.msg1) reject(409, 'PAIRING_NOT_READY');
            tunnel.msg2 = init.body;
            return {};
        }
        throw new Error(`unexpected ${method} ${path}`);
    };
    return { tunnels, calls, request };
}

/** What the phone does after scanning, using the real crypto module. */
async function phoneScans(org, qr, { accountId = ACCOUNT, kind = 'google' } = {}) {
    const scanned = parseQr(qr, { env: 'staging' });
    const phone = await generateEphemeralKeyPair();
    const k1 = await deriveK1({ qrSecret: scanned.qrSecret, tunnelId: scanned.tunnelId });
    const nonce = randomBytes(12);
    const ciphertext = await sealMsg1({ k1, tunnelId: scanned.tunnelId, nonce, plaintext: encodePhoneMessage({ pPub: phone.pub, kind, accountId, device: 'iPhone' }) });
    org.tunnels.get(bytesToBase64Url(scanned.tunnelId)).msg1 = { nonce: bytesToBase64Url(nonce), ciphertext: bytesToBase64Url(ciphertext) };
    return { phone, scanned };
}

function fakeTimers() {
    const pending = [];
    return {
        pending,
        now: () => 1_800_000_000 * 1000,
        setTimeout: (fn, ms) => { const id = { fn, ms }; pending.push(id); return id; },
        clearTimeout: id => { const i = pending.indexOf(id); if (i >= 0) pending.splice(i, 1); },
        async runNext() { const next = pending.shift(); if (next) await next.fn(); }
    };
}

function session(org, overrides = {}) {
    const states = [];
    const keys = [];
    const masterKey = randomBytes(32);
    const s = createPhonePairingSession({
        request: org.request,
        accountKind: () => 'google',
        accountId: () => ACCOUNT,
        revealMasterKey: async () => { const copy = Uint8Array.from(masterKey); keys.push(copy); return copy; },
        approveUsername: async () => ({ masterKey: Uint8Array.from(masterKey), grant: 'Z3JhbnQtZm9yLXRoZS1maXh0dXJlLW9ubHktMDAwMDAwMDA' }),
        env: 'staging',
        onChange: state => states.push(state.status),
        timers: overrides.timers || fakeTimers(),
        ...overrides
    });
    return { s, states, keys, masterKey };
}

test('the default runtime clock opens a pairing code without injected timers', async () => {
    const org = fakeOrg();
    const { s } = session(org, {
        timers: undefined,
        request: async (path, init) => {
            const response = await org.request(path, init);
            return path === '/auth/pairing'
                ? { ...response, expiresAt: Math.floor(Date.now() / 1000) + 120 }
                : response;
        }
    });
    try {
        await s.start();
        assert.equal(s.state.status, 'showing');
        assert.equal(s.state.error, null);
        assert.match(s.state.qr, /^OAPAIR\/1\/staging\//);
    } finally {
        await s.decline();
    }
    assert.equal(org.tunnels.size, 0);
});

test('the whole computer side: QR, scan, approve, and the phone opens the key', async () => {
    const org = fakeOrg();
    const timers = fakeTimers();
    const { s, states, keys, masterKey } = session(org, { timers });

    await s.start();
    assert.equal(s.state.status, 'showing');
    assert.match(s.state.qr, /^OAPAIR\/1\/staging\//);
    assert.equal(timers.pending.length, 2, 'an expiry timer and a poll timer');

    await timers.runNext(); // expiry timer is first; nothing happens while showing... it fires 'expired' only if still showing
    // The expiry timer fired while showing: that is an expiry. Restart to test the happy path with the poll first.
    assert.equal(s.state.status, 'expired');

    await s.start();
    // Run the poll before anyone scanned: still showing, re-armed.
    const pollFirst = timers.pending.find(t => t.ms === 2000);
    timers.pending.splice(timers.pending.indexOf(pollFirst), 1);
    await pollFirst.fn();
    assert.equal(s.state.status, 'showing');

    const { phone, scanned } = await phoneScans(org, s.state.qr);
    const poll = timers.pending.find(t => t.ms === 2000);
    timers.pending.splice(timers.pending.indexOf(poll), 1);
    await poll.fn();
    assert.equal(s.state.status, 'scanned');
    assert.equal(s.state.device, 'iPhone');

    await s.approve();
    assert.equal(s.state.status, 'done');
    assert.ok(keys.every(key => key.every(byte => byte === 0)), 'the revealed key is zeroed after use');

    // The phone opens what the org holds.
    const tunnel = org.tunnels.get(bytesToBase64Url(scanned.tunnelId));
    const k2 = await deriveK2({ shared: await ecdh(phone.privateKey, scanned.cPub), qrSecret: scanned.qrSecret, tunnelId: scanned.tunnelId, cPub: scanned.cPub, pPub: phone.pub });
    const received = decodeComputerMessage(await openMsg2({ k2, tunnelId: scanned.tunnelId, nonce: base64UrlToBytes(tunnel.msg2.nonce), ciphertext: base64UrlToBytes(tunnel.msg2.ciphertext) }));
    assert.deepEqual(received.masterKey, masterKey);
    assert.equal(received.grant, null, 'Google accounts carry no grant');
    assert.ok(!org.calls.includes('POST /auth/credentials/grant'));
    assert.deepEqual(states.slice(-3), ['scanned', 'approving', 'done']);
});

test('username accounts carry a grant in the message', async () => {
    const org = fakeOrg();
    const timers = fakeTimers();
    const { s } = session(org, { timers, accountKind: () => 'username' });
    await s.start();
    const { phone, scanned } = await phoneScans(org, s.state.qr, { kind: 'username' });
    const poll = timers.pending.find(t => t.ms === 2000);
    timers.pending.splice(timers.pending.indexOf(poll), 1);
    await poll.fn();
    await s.approve();
    assert.equal(s.state.status, 'done');
    const tunnel = org.tunnels.get(bytesToBase64Url(scanned.tunnelId));
    const k2 = await deriveK2({ shared: await ecdh(phone.privateKey, scanned.cPub), qrSecret: scanned.qrSecret, tunnelId: scanned.tunnelId, cPub: scanned.cPub, pPub: phone.pub });
    const received = decodeComputerMessage(await openMsg2({ k2, tunnelId: scanned.tunnelId, nonce: base64UrlToBytes(tunnel.msg2.nonce), ciphertext: base64UrlToBytes(tunnel.msg2.ciphertext) }));
    assert.equal(received.grant, 'Z3JhbnQtZm9yLXRoZS1maXh0dXJlLW9ubHktMDAwMDAwMDA');
});

test('a phone on another account, or a message not from a phone that saw the QR, closes the tunnel', async () => {
    for (const bad of [{ accountId: '0000000000000000' }, { kind: 'username' }]) {
        const org = fakeOrg();
        const timers = fakeTimers();
        const { s } = session(org, { timers });
        await s.start();
        await phoneScans(org, s.state.qr, bad);
        const poll = timers.pending.find(t => t.ms === 2000);
        timers.pending.splice(timers.pending.indexOf(poll), 1);
        await poll.fn();
        assert.equal(s.state.status, 'failed');
        assert.match(s.state.error, /different account/);
        assert.ok(org.calls.some(c => c.startsWith('DELETE /auth/pairing/')));
    }
    const org = fakeOrg();
    const timers = fakeTimers();
    const { s } = session(org, { timers });
    await s.start();
    const tunnelId = org.calls.length && [...org.tunnels.keys()][0];
    org.tunnels.get(tunnelId).msg1 = { nonce: bytesToBase64Url(randomBytes(12)), ciphertext: bytesToBase64Url(randomBytes(80)) };
    const poll = timers.pending.find(t => t.ms === 2000);
    timers.pending.splice(timers.pending.indexOf(poll), 1);
    await poll.fn();
    assert.equal(s.state.status, 'failed');
    assert.match(s.state.error, /pairing message could not be opened/i);
});

test('cancelling the passkey prompt declines; a vanished tunnel reads as expired; decline deletes', async () => {
    let org = fakeOrg();
    let timers = fakeTimers();
    let { s } = session(org, { timers, revealMasterKey: async () => { const e = new Error('The operation was cancelled'); e.name = 'NotAllowedError'; throw e; } });
    await s.start();
    await phoneScans(org, s.state.qr);
    let poll = timers.pending.find(t => t.ms === 2000);
    timers.pending.splice(timers.pending.indexOf(poll), 1);
    await poll.fn();
    await s.approve();
    assert.equal(s.state.status, 'declined');
    assert.equal(org.tunnels.size, 0, 'declined tunnels are deleted');

    org = fakeOrg();
    timers = fakeTimers();
    ({ s } = session(org, { timers }));
    await s.start();
    org.tunnels.clear(); // expired on the org
    poll = timers.pending.find(t => t.ms === 2000);
    timers.pending.splice(timers.pending.indexOf(poll), 1);
    await poll.fn();
    assert.equal(s.state.status, 'expired');

    org = fakeOrg();
    timers = fakeTimers();
    ({ s } = session(org, { timers }));
    await s.start();
    await s.decline();
    assert.equal(s.state.status, 'declined');
    assert.equal(org.tunnels.size, 0);
    assert.equal(timers.pending.length, 0, 'no timers survive a decline');
});

test('the session never starts without an unlocked account and never exposes secrets on its state', async () => {
    const org = fakeOrg();
    const { s } = session(org, { accountKind: () => null });
    await s.start();
    assert.equal(s.state.status, 'failed');
    assert.equal(org.calls.length, 0);

    const live = session(fakeOrg());
    await live.s.start();
    const exposed = JSON.stringify(live.s.state);
    assert.ok(!exposed.includes('privateKey'));
    assert.ok(!exposed.includes('qrSecret'));
    // The QR string itself carries the secret by design; it is the only place it appears.
    assert.deepEqual(Object.keys(live.s.state).sort(), ['device', 'error', 'expiresAt', 'qr', 'status']);
});

function deferred() {
    let resolve;
    const promise = new Promise(r => { resolve = r; });
    return { promise, resolve };
}
async function scan(s, org, timers, kind = 'google') {
    await s.start();
    await phoneScans(org, s.state.qr, { kind });
    const poll = timers.pending.find(t => t.ms === 2000);
    timers.pending.splice(timers.pending.indexOf(poll), 1);
    await poll.fn();
}

for (const kind of ['google', 'username']) {
    for (const interrupt of ['decline', 'dispose', 'expire', 'account-generation']) {
        test(`${kind}: ${interrupt} during passkey approval cannot publish a key`, async () => {
            const org = fakeOrg(), timers = fakeTimers(), gate = deferred();
            const key = randomBytes(32);
            let generation = 0;
            const { s } = session(org, { timers, accountKind: () => kind,
                accountGeneration: () => generation,
                revealMasterKey: () => gate.promise,
                approveUsername: async () => ({ masterKey: await gate.promise, grant: 'g'.repeat(43) }) });
            await scan(s, org, timers, kind);
            const approving = s.approve();
            if (interrupt === 'expire') await timers.pending.find(t => t.ms !== 2000).fn();
            else if (interrupt === 'account-generation') generation++;
            else await s[interrupt]();
            gate.resolve(key);
            await approving;
            assert.ok(!org.calls.some(c => /^POST .*\/computer$/.test(c)));
            assert.ok(key.every(b => b === 0));
            assert.notEqual(s.state.status, 'done');
        });
    }
}

test('a delayed old delete cannot overwrite the next QR', async () => {
    const org = fakeOrg(), deletion = deferred();
    const { s } = session(org, { request: async (path, init) => {
        const result = await org.request(path, init);
        if (init.method === 'DELETE') await deletion.promise;
        return result;
    } });
    await s.start();
    const closing = s.decline();
    await s.start();
    const qr = s.state.qr;
    deletion.resolve();
    await closing;
    assert.equal(s.state.status, 'showing');
    assert.equal(s.state.qr, qr);
    s.dispose();
});

test('cancelled create cleans up its late response without touching a newer attempt', async () => {
    const org = fakeOrg(), gate = deferred(), entered = deferred();
    let first = true;
    const { s } = session(org, { request: async (path, init) => {
        const result = await org.request(path, init);
        if (path === '/auth/pairing' && first) {
            first = false; entered.resolve(); await gate.promise;
        }
        return result;
    } });
    const creating = s.start();
    await entered.promise;
    await s.decline();
    await s.start();
    const qr = s.state.qr;
    gate.resolve(); await creating;
    assert.equal(s.state.qr, qr);
    assert.equal(org.tunnels.size, 1);
    s.dispose();
});
