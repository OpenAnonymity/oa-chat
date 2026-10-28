// The computer's side of phone pairing ("Sync from your computer"), as a
// small state machine the Account dialog renders. docs/PHONE_PAIRING.md is
// the specification; chat/services/phonePairing.js does the cryptography.
//
// States: idle → showing (QR up, polling) → scanned (phone message opened,
// waiting for the person) → approving (passkey prompt, key sent) → done,
// or expired / declined / failed from any of them. Every transition is
// announced to `onChange`; nothing here touches the DOM.
//
// The master key exists in this module only between `revealMasterKey()`
// resolving and the message being sealed, and is zeroed in a `finally`.

import {
    randomBytes, generateEphemeralKeyPair, ecdh, deriveK1, deriveK2,
    openMsg1, sealMsg2, decodePhoneMessage, encodeComputerMessage, encodeQr,
    base64UrlToBytes, bytesToBase64Url, TUNNEL_ID_BYTES, QR_SECRET_BYTES
} from './phonePairing.js';

export const PAIRING_STATES = Object.freeze(['idle', 'showing', 'scanned', 'approving', 'done', 'expired', 'declined', 'failed']);
const POLL_MS = 2000;
const DEFAULT_TIMERS = Object.freeze({
    now: () => Date.now(),
    setTimeout: (callback, delay) => globalThis.setTimeout(callback, delay),
    clearTimeout: timer => globalThis.clearTimeout(timer)
});

/** Build-time flag (scripts/build.mjs `__OA_PHONE_PAIRING__`); off unless set. */
export function phonePairingBuildEnabled() {
    return typeof __OA_PHONE_PAIRING__ !== 'undefined' && __OA_PHONE_PAIRING__ === true;
}

/** Every asynchronous step belongs to one immutable account/attempt binding. */
export function createPhonePairingSession({ request, accountKind, accountId,
    accountGeneration = () => 0, revealMasterKey, approveUsername, env,
    onChange = () => {}, timers = DEFAULT_TIMERS } = {}) {
    if (typeof request !== 'function') throw new Error('request is required');
    if (!['prod', 'staging'].includes(env)) throw new Error('env must be prod or staging');
    let state = { status: 'idle', qr: null, expiresAt: null, device: null, error: null };
    let current = null;
    const set = patch => {
        state = Object.freeze({ ...state, ...patch });
        try { onChange(state); } catch { /* presentation cannot change protocol state */ }
    };
    const valid = a => current === a && !a.abort.signal.aborted
        && a.accountId === accountId() && a.kind === accountKind()
        && a.accountGeneration === accountGeneration();
    const check = a => {
        if (!valid(a)) throw new DOMException('Pairing cancelled or account changed', 'AbortError');
    };
    const stop = a => {
        if (!a) return;
        a.abort.abort();
        timers.clearTimeout(a.pollTimer);
        timers.clearTimeout(a.expiryTimer);
        a.secret.fill(0);
        a.computer = a.phone = null;
    };
    const remove = a => a?.id
        ? request(`/auth/pairing/${a.id}`, { method: 'DELETE' }).catch(() => {})
        : Promise.resolve();
    const finish = (a, status, error = null) => {
        if (current !== a) return;
        current = null;
        stop(a);
        set({ status, qr: null, device: null, error });
    };
    const failed = (a, error) => {
        if (current !== a) return;
        const cancelled = !valid(a) || error?.name === 'AbortError' || error?.name === 'NotAllowedError';
        void remove(a);
        finish(a, cancelled ? 'declined' : [404, 410].includes(error?.status) ? 'expired' : 'failed',
            cancelled ? null : error?.message || 'Pairing failed');
    };
    async function poll(a) {
        try {
            check(a);
            const response = await request(`/auth/pairing/${a.id}`, { method: 'GET', signal: a.abort.signal });
            check(a);
            if (!response?.ready) {
                a.pollTimer = timers.setTimeout(() => poll(a), POLL_MS);
                return;
            }
            const k1 = await deriveK1({ qrSecret: a.secret, tunnelId: a.idBytes });
            check(a);
            const plaintext = await openMsg1({ k1, tunnelId: a.idBytes,
                nonce: base64UrlToBytes(response.phone.nonce), ciphertext: base64UrlToBytes(response.phone.ciphertext) });
            check(a);
            const phone = decodePhoneMessage(plaintext);
            if (phone.accountId !== a.accountId || phone.kind !== a.kind) throw new Error('That phone is signed in to a different account');
            a.phone = phone;
            set({ status: 'scanned', device: phone.device });
        } catch (error) {
            if (current !== a) return;
            if (valid(a) && !error?.status && error?.name === 'TypeError') {
                a.pollTimer = timers.setTimeout(() => poll(a), POLL_MS);
            } else { failed(a, error); }
        }
    }
    return Object.freeze({
        get state() { return state; },
        async start() {
            const old = current;
            current = null;
            stop(old);
            void remove(old);
            const a = { accountId: accountId(), kind: accountKind(), accountGeneration: accountGeneration(),
                abort: new AbortController(), secret: randomBytes(QR_SECRET_BYTES) };
            current = a;
            try {
                if (!a.kind || !a.accountId) throw new Error('Sign in and unlock before adding a phone');
                a.computer = await generateEphemeralKeyPair();
                check(a);
                const created = await request('/auth/pairing', { method: 'POST', signal: a.abort.signal });
                // A create already accepted by the server may complete after close.
                a.id = created.tunnelId;
                if (!valid(a)) { void remove(a); check(a); }
                a.idBytes = base64UrlToBytes(a.id);
                if (a.idBytes.length !== TUNNEL_ID_BYTES) throw new Error('Bad tunnel id');
                const qr = encodeQr({ env, tunnelId: a.idBytes, qrSecret: a.secret, cPub: a.computer.pub });
                set({ status: 'showing', qr, expiresAt: created.expiresAt, device: null, error: null });
                a.expiryTimer = timers.setTimeout(() => {
                    if (current === a) { void remove(a); finish(a, 'expired'); }
                }, Math.max(0, created.expiresAt * 1000 - timers.now()));
                a.pollTimer = timers.setTimeout(() => poll(a), POLL_MS);
            } catch (error) { failed(a, error); }
            return state;
        },
        async decline() {
            const a = current;
            if (a) finish(a, 'declined');
            else set({ status: 'declined', qr: null, device: null, error: null });
            await remove(a);
            return state;
        },
        async approve() {
            const a = current;
            if (!a || state.status !== 'scanned' || !a.phone) return state;
            let masterKey = null;
            let plaintext = null;
            try {
                check(a);
                set({ status: 'approving', error: null });
                let grant = null;
                if (a.kind === 'username') {
                    const approved = await approveUsername({ tunnelId: a.id, signal: a.abort.signal });
                    masterKey = approved.masterKey;
                    grant = approved.grant;
                } else {
                    masterKey = await revealMasterKey({ signal: a.abort.signal });
                }
                check(a);
                const shared = await ecdh(a.computer.privateKey, a.phone.pPub);
                check(a);
                const k2 = await deriveK2({ shared, qrSecret: a.secret, tunnelId: a.idBytes, cPub: a.computer.pub, pPub: a.phone.pPub });
                check(a);
                const nonce = randomBytes(12);
                plaintext = encodeComputerMessage({ masterKey, grant });
                const ciphertext = await sealMsg2({ k2, tunnelId: a.idBytes, nonce, plaintext });
                check(a);
                await request(`/auth/pairing/${a.id}/computer`, { method: 'POST', signal: a.abort.signal,
                    body: { nonce: bytesToBase64Url(nonce), ciphertext: bytesToBase64Url(ciphertext) } });
                check(a);
                finish(a, 'done');
            } catch (error) { failed(a, error); }
            finally { masterKey?.fill(0); plaintext?.fill(0); }
            return state;
        },
        dispose() {
            const a = current;
            current = null;
            stop(a);
            void remove(a);
            set({ status: 'idle', qr: null, device: null, error: null });
        }
    });
}
