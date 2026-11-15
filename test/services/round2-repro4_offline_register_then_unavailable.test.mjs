import test from 'node:test';
import assert from "node:assert/strict";

import { default as accountService } from '../../chat/services/accountService.js';
import { default as sessionService } from '../../chat/services/sessionService.js';
import { chatDB } from '../../chat/db.js';
import { default as AccountModal } from '../../chat/components/AccountModal.js';

const b64 = s => Buffer.from(s).toString('base64url');

function fakeServer() {
    const accounts = new Map(); // accountId -> { status, username, credentialId }
    const calls = [];
    let n = 0;
    let holdRegisterReply = false;
    const json = (status, data) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
    const fetch = async (url, init) => {
        const path = new URL(url, 'https://x').pathname.replace(/^.*\/auth/, '/auth');
        const body = init?.body ? JSON.parse(init.body) : {};
        calls.push(path);
        if (path === '/auth/init') {
            for (const a of accounts.values()) if (a.username === body.username) return json(409, { error: 'Username is unavailable', code: 'USERNAME_UNAVAILABLE' });
            const accountId = String(1000000000000000 + (++n));
            accounts.set(accountId, { status: 'pending', username: body.username, credentialId: null });
            return json(200, {
                accountId, username: body.username, challenge: b64('c' + n), rpId: 'chat.example',
                publicKey: { challenge: b64('c' + n), rp: { id: 'chat.example', name: 'OA' },
                    user: { id: b64(accountId), name: body.username, displayName: body.username } }
            });
        }
        if (path === '/auth/register') {
            const a = accounts.get(body.accountId);
            if (!a || a.status !== 'pending') return json(404, { error: 'Account not found', code: 'ACCOUNT_NOT_FOUND' });
            a.status = 'active';
            a.credentialId = body.credential.id;
            a.wrappedKeyPasskey = body.wrappedKeyPasskey;
            if (holdRegisterReply) return new Promise(() => {}); // committed; reply lost (page reloads)
            return json(200, { success: true });
        }
        if (path === '/auth/challenge') {
            const a = [...accounts.entries()].find(([, v]) => v.username === body.username && v.status === 'active');
            if (!a) return json(401, { error: 'Authentication failed', code: 'AUTHENTICATION_FAILED' });
            return json(200, { challengeId: 'x', accountId: a[0], publicKey: { challenge: b64('login'), allowCredentials: [{ id: a[1].credentialId, type: 'public-key' }] } });
        }
        if (path === '/auth/login') {
            const a = accounts.get(body.accountId);
            assert.equal(body.credentialId, a.credentialId);
            return json(200, { wrappedKeyPasskey: a.wrappedKeyPasskey });
        }
        return json(500, { error: 'unexpected ' + path });
    };
    return { accounts, calls, fetch, set holdRegisterReply(v) { holdRegisterReply = v; } };
}

function fakeAuthenticator() {
    const creds = new Map(); // `${rpId}|${userHandle}` -> credentialId  (CTAP2 rk overwrite semantics)
    let n = 0;
    return {
        creds,
        credentials: {
            async get({ publicKey }) {
                const id = Buffer.from(publicKey.allowCredentials[0].id).toString('base64url');
                assert.ok([...creds.values()].includes(id), 'original passkey still exists');
                return { id, rawId: Buffer.from(id, 'base64url').buffer, type: 'public-key',
                    response: { clientDataJSON: new Uint8Array([1]).buffer, authenticatorData: new Uint8Array([2]).buffer, signature: new Uint8Array([3]).buffer },
                    getClientExtensionResults: () => ({ prf: { results: { first: new Uint8Array(32).fill(9).buffer } } }) };
            },
            async create({ publicKey }) {
                const handle = Buffer.from(publicKey.user.id).toString('base64url');
                const id = b64('cred' + (++n));
                creds.set(`${publicKey.rp.id}|${handle}`, id);
                return {
                    id, rawId: new TextEncoder().encode(id).buffer, type: 'public-key',
                    response: { clientDataJSON: new Uint8Array([1]).buffer, attestationObject: new Uint8Array([2]).buffer },
                    getClientExtensionResults: () => ({ prf: { results: { first: new Uint8Array(32).fill(9).buffer } } })
                };
            }
        }
    };
}

function fakeSessionStorage() {
    const values = new Map();
    return { getItem: k => values.has(k) ? values.get(k) : null, setItem: (k, v) => values.set(k, String(v)), removeItem: k => values.delete(k) };
}

test('offline registration retries the exact credential and preserves the username', async t => {
    const restored = [];
    const replace = (obj, key, value) => { const before = obj[key]; restored.push(() => { obj[key] = before; }); obj[key] = value; };
    const storageBefore = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
    const navigatorBefore = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    const originalState = { ...accountService.state };
    t.after(() => { restored.reverse().forEach(fn => fn()); Object.assign(accountService.state, originalState);
        storageBefore ? Object.defineProperty(globalThis, 'sessionStorage', storageBefore) : delete globalThis.sessionStorage;
        navigatorBefore ? Object.defineProperty(globalThis, 'navigator', navigatorBefore) : delete globalThis.navigator; });
    const server = fakeServer();
    const auth = fakeAuthenticator();
    Object.defineProperty(globalThis, 'sessionStorage', { value: fakeSessionStorage(), configurable: true, writable: true });
    Object.defineProperty(globalThis, 'navigator', { value: { credentials: auth.credentials }, configurable: true });
    let offline = false;
    replace(sessionService, 'fetch', async (url, init) => {
        if (offline && String(url).includes('/auth/register')) throw new TypeError('Failed to fetch');
        return server.fetch(url, init);
    });
    replace(sessionService, 'doesSessionExist', async () => true);
    replace(accountService, 'initializeSync', async () => { accountService.state.accountScopeReady = true; return true; });
    replace(chatDB, 'saveSetting', async () => {});
    replace(chatDB, 'updateSettings', async () => {});
    accountService.state.passkeySupported = true;
    accountService.state.accountId = null;
    accountService.localAccountContinuity = false;
    chatDB.db = {};

    const modal = Object.create(AccountModal.prototype);
    Object.assign(modal, {
        isOpen: true, loginViewVersion: 0, usernameContinuePending: false, usernamePasskeyBusy: false,
        identifierMode: 'username', usernameInputValue: 'winter-owl', creationStep: 'idle',
        animationTimeouts: [], heldRegistration: null, accountState: accountService.getState(),
        accountService, app: { showToast() {}, notifyFirstAccountReady() {} },
        render() {}, focusModal() {}, close() { this.isOpen = false; },
        remainingPasskeyIntroMs: () => 0
    });
    const unsubscribe = accountService.subscribe(s => { modal.accountState = s; });
    t.after(() => unsubscribe?.());
    await modal.handleAccountContinue();              // lookup -> register; intro
    offline = true;
    modal.usernameIntroPending = false;
    await modal.handleUsernamePasskeyContinue();      // /auth/init ok, passkey ok, /auth/register offline
    assert.equal([...server.accounts.values()][0].status, 'pending', 'server never saw the register');

    offline = false;                                  // back online; press Try again
    await modal.handleUsernamePasskeyContinue();
    assert.equal(modal.creationStep, 'idle');
    assert.equal(modal.usernameInputValue, 'winter-owl');
    assert.equal([...server.accounts.values()][0].status, 'active', 'original credential completes');
    assert.equal(server.calls.filter(path => path === '/auth/init').length, 1, 'no second reservation');
    assert.equal(accountService.state.error, null);
    assert.equal(accountService.state.sessionVerified, true);
    assert.equal(accountService.state.username, 'winter-owl');
    assert.equal(accountService.state.accountScopeReady, true);
    assert.ok(accountService.masterKey?.length === 32, 'original encrypted master key was unwrapped');
    assert.equal(auth.creds.size, 1, 'only one credential was created');
});
