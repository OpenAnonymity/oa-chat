// Authorizing a local oa-clientd daemon from the signed-in browser.
// docs/DAEMON_AUTHORIZATION.md is the specification. This file is its wire format
// and the small state machine the dialog renders; it never touches the DOM.
//
// The master key exists here only between `revealMasterKey()` resolving and the
// envelope being sealed, and is zeroed in a `finally`. The daemon's public key
// comes from the URL fragment and never from the org: the org could otherwise
// substitute its own key and receive the sync key.

const subtle = () => globalThis.crypto.subtle;
const text = new TextEncoder();

export const DAEMON_ENVELOPE_VERSION = 1;
export const DAEMON_FRAGMENT_KEY = 'oa-daemon';
export const DAEMON_INTENT_STORAGE_KEY = 'oa-daemon-authorization';
const INTENT_MAX_AGE_MS = 15 * 60 * 1000;
const ENVELOPE_INFO = 'oa-daemon-auth/v1/browser->daemon';
const ENVELOPE_AAD = 'oa-daemon-auth/v1/envelope';
const TRANSACTION_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const POINT_PATTERN = /^B[A-P][A-Za-z0-9_-]{85}$/;
// A first-time browser is sent to the landing page, which forwards the fragment
// back with this value; `auth` already reaches the chat root past that redirect.
export const DAEMON_AUTH_HANDOFF = 'daemon';

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

function bytesToHex(bytes) {
    return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

/** Reads and validates a `#oa-daemon=` fragment; null when absent or malformed. */
export function parseDaemonFragment(hash) {
    const prefix = `#${DAEMON_FRAGMENT_KEY}=`;
    if (typeof hash !== 'string' || !hash.startsWith(prefix)) return null;
    try {
        const payload = JSON.parse(new TextDecoder().decode(base64UrlToBytes(hash.slice(prefix.length))));
        if (payload?.v !== DAEMON_ENVELOPE_VERSION) return null;
        if (!TRANSACTION_PATTERN.test(payload.t) || !POINT_PATTERN.test(payload.k)) return null;
        return { transaction: payload.t, daemonPublicKey: payload.k };
    } catch {
        return null;
    }
}

export function isDaemonIntentFresh(intent, now = Date.now()) {
    return Number.isFinite(intent?.savedAt) && now - intent.savedAt < INTENT_MAX_AGE_MS;
}

function clearAddress(locationImpl, historyImpl) {
    const params = new URLSearchParams(locationImpl?.search || '');
    if (params.get('auth') === DAEMON_AUTH_HANDOFF) params.delete('auth');
    const search = params.toString();
    historyImpl?.replaceState?.(historyImpl.state, '', `${locationImpl.pathname}${search ? `?${search}` : ''}`);
}

/**
 * Moves the intent out of the address at once, so it never reaches history,
 * a referrer or a screenshot. sessionStorage holds it across a same-tab sign-in
 * redirect. It carries no secret: approving also needs the terminal's code.
 */
export function consumeDaemonIntent({ locationImpl = globalThis.location, historyImpl = globalThis.history, storage = globalThis.sessionStorage, now = Date.now() } = {}) {
    const parsed = parseDaemonFragment(locationImpl?.hash);
    if (locationImpl?.hash?.startsWith(`#${DAEMON_FRAGMENT_KEY}=`)) {
        clearAddress(locationImpl, historyImpl);
    }
    if (parsed) {
        const intent = { ...parsed, savedAt: now };
        try {
            storage?.setItem(DAEMON_INTENT_STORAGE_KEY, JSON.stringify(intent));
        } catch { /* The dialog can still run from memory in this tab. */ }
        return intent;
    }
    try {
        const saved = JSON.parse(storage?.getItem(DAEMON_INTENT_STORAGE_KEY) || 'null');
        if (saved && isDaemonIntentFresh(saved, now)
            && TRANSACTION_PATTERN.test(saved.transaction) && POINT_PATTERN.test(saved.daemonPublicKey)) {
            return { transaction: saved.transaction, daemonPublicKey: saved.daemonPublicKey, savedAt: saved.savedAt };
        }
        storage?.removeItem(DAEMON_INTENT_STORAGE_KEY);
    } catch { /* Unavailable storage just means no saved intent. */ }
    return null;
}

/** `#oa-daemon-devices` opens the list of authorized daemons for revocation. */
export function consumeDevicesIntent({ locationImpl = globalThis.location, historyImpl = globalThis.history } = {}) {
    if (locationImpl?.hash !== '#oa-daemon-devices') return false;
    clearAddress(locationImpl, historyImpl);
    return true;
}

export function clearDaemonIntent(storage = globalThis.sessionStorage) {
    try { storage?.removeItem(DAEMON_INTENT_STORAGE_KEY); } catch { /* best effort */ }
}

/** The digest the org stored at start; a tampered link fails approval. */
export async function daemonPublicKeyHash(daemonPublicKey) {
    return bytesToHex(new Uint8Array(await subtle().digest('SHA-256', text.encode(daemonPublicKey))));
}

async function envelopeKey({ privateKey, daemonPoint, ephemeralPoint, transaction }) {
    const peer = await subtle().importKey('raw', daemonPoint, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
    const shared = new Uint8Array(await subtle().deriveBits({ name: 'ECDH', public: peer }, privateKey, 256));
    try {
        const hkdf = await subtle().importKey('raw', shared, 'HKDF', false, ['deriveKey']);
        return await subtle().deriveKey(
            {
                name: 'HKDF',
                hash: 'SHA-256',
                salt: await subtle().digest('SHA-256', text.encode(transaction)),
                info: text.encode(`${ENVELOPE_INFO}|${bytesToHex(daemonPoint)}|${bytesToHex(ephemeralPoint)}`)
            },
            hkdf,
            { name: 'AES-GCM', length: 256 },
            false,
            ['encrypt']
        );
    } finally {
        shared.fill(0);
    }
}

/**
 * Seals the raw master key to the daemon. P-256 ECDH, HKDF-SHA256, AES-256-GCM,
 * as phone pairing. Tests pass `ephemeral` and `nonce` for fixed vectors.
 */
export async function sealForDaemon({ daemonPublicKey, transaction, accountId, origin, masterKey, ephemeral = null, nonce = null }) {
    if (!(masterKey instanceof Uint8Array) || masterKey.length !== 32) throw new Error('A 32-byte master key is required');
    const daemonPoint = base64UrlToBytes(daemonPublicKey);
    if (daemonPoint.length !== 65 || daemonPoint[0] !== 0x04) throw new Error('Invalid daemon key');
    const pair = ephemeral || await subtle().generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
    const ephemeralPoint = new Uint8Array(await subtle().exportKey('raw', pair.publicKey));
    const key = await envelopeKey({ privateKey: pair.privateKey, daemonPoint, ephemeralPoint, transaction });
    const iv = nonce || globalThis.crypto.getRandomValues(new Uint8Array(12));
    const plaintext = text.encode(JSON.stringify({
        v: DAEMON_ENVELOPE_VERSION,
        accountId,
        transaction,
        origin,
        masterKey: bytesToBase64Url(masterKey)
    }));
    try {
        const ciphertext = new Uint8Array(await subtle().encrypt(
            { name: 'AES-GCM', iv, additionalData: text.encode(`${ENVELOPE_AAD}|${transaction}`), tagLength: 128 },
            key,
            plaintext
        ));
        return {
            ephemeralPublicKey: bytesToBase64Url(ephemeralPoint),
            nonce: bytesToBase64Url(iv),
            ciphertext: bytesToBase64Url(ciphertext)
        };
    } finally {
        plaintext.fill(0);
    }
}

export const DAEMON_STATES = Object.freeze(['loading', 'review', 'approving', 'done', 'declined', 'expired', 'failed']);

function isCancelled(error) {
    return error?.name === 'AbortError' || error?.name === 'NotAllowedError';
}

/**
 * One authorization attempt, bound to the account that opened it. An account
 * change or expiry makes every later step refuse. Nothing is sent without
 * `approve`, which only a click reaches.
 */
export function createDaemonAuthorization({ intent, request, revealMasterKey, accountId, accountSupported = () => true, origin, onChange = () => {}, now = () => Date.now() }) {
    if (typeof request !== 'function' || typeof revealMasterKey !== 'function' || typeof accountId !== 'function') {
        throw new Error('request, revealMasterKey and accountId are required');
    }
    const boundAccount = accountId();
    let state = { status: 'loading', details: null, error: null, expiresAt: null };
    // Once the sealed key may have reached the org, "nothing was sent" is not true.
    let approveAttempted = false;
    const set = patch => {
        state = Object.freeze({ ...state, ...patch });
        try { onChange(state); } catch { /* presentation cannot change protocol state */ }
    };
    const assertCurrent = () => {
        if (accountId() !== boundAccount) throw Object.assign(new Error('The account changed. Reopen the link from your terminal.'), { terminal: true });
        if (state.expiresAt && now() >= state.expiresAt) throw Object.assign(new Error('expired'), { expired: true });
    };
    const fail = error => {
        const code = error?.code || error?.data?.code || error?.detail?.code;
        if ((error?.expired || code === 'DAEMON_AUTH_EXPIRED') && !approveAttempted) {
            set({ status: 'expired', error: null });
        } else if (code === 'DAEMON_AUTH_BAD_CODE') {
            set({ status: 'review', error: 'That code does not match your terminal. Check it and try again.' });
        } else if (isCancelled(error)) {
            set({ status: 'review', error: 'The passkey prompt was cancelled. Nothing was sent.' });
        } else if (code === 'DAEMON_AUTH_UNSUPPORTED') {
            set({ status: 'failed', error: 'This account cannot authorize a computer yet. Finish setting up its encryption passkey, then try again.' });
        } else if (error?.terminal) {
            set({ status: 'failed', error: error.message });
        } else if (approveAttempted) {
            set({ status: 'failed', error: 'We could not confirm this approval. Check your terminal: if oa-clientd did not finish, run oa-clientd login and try again.' });
        } else {
            set({ status: 'review', error: 'That did not work. Nothing was sent. Try again.' });
        }
    };
    return {
        getState: () => state,
        async load() {
            try {
                const details = await request('/auth/daemon/lookup', { transaction: intent.transaction });
                assertCurrent();
                const expectedHash = await daemonPublicKeyHash(intent.daemonPublicKey);
                if (details.daemonPublicKeyHash !== expectedHash) {
                    throw Object.assign(new Error('This link does not match the request from your terminal. Run oa-clientd login again.'), { terminal: true });
                }
                if (!accountSupported()) throw Object.assign(new Error('Unsupported account'), { code: 'DAEMON_AUTH_UNSUPPORTED' });
                set({ status: 'review', details, expiresAt: now() + (details.expiresIn * 1000), error: null });
            } catch (error) {
                fail(error);
            }
        },
        /** Ends an idle review when the account changed or the request expired. */
        revalidate() {
            if (state.status !== 'review') return;
            try {
                assertCurrent();
            } catch (error) {
                fail(error);
            }
        },
        async approve(userCode) {
            if (state.status !== 'review') return;
            set({ status: 'approving', error: null });
            let masterKey = null;
            try {
                assertCurrent();
                await request('/auth/daemon/check-code', { transaction: intent.transaction, userCode });
                assertCurrent();
                masterKey = await revealMasterKey({ transaction: intent.transaction, userCode });
                assertCurrent();
                const sealed = await sealForDaemon({
                    daemonPublicKey: intent.daemonPublicKey,
                    transaction: intent.transaction,
                    accountId: boundAccount,
                    origin,
                    masterKey
                });
                approveAttempted = true;
                await request('/auth/daemon/approve', {
                    transaction: intent.transaction,
                    userCode,
                    daemonPublicKeyHash: await daemonPublicKeyHash(intent.daemonPublicKey),
                    sealed
                });
                set({ status: 'done', error: null });
            } catch (error) {
                fail(error);
            } finally {
                masterKey?.fill?.(0);
            }
        },
        async decline() {
            if (!['review', 'loading'].includes(state.status)) return;
            set({ status: 'declined', error: null });
            try {
                await request('/auth/daemon/deny', { transaction: intent.transaction });
            } catch { /* The transaction expires by itself and holds no key. */ }
        }
    };
}
