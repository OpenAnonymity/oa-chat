// Repro 1: a reload while /auth/register is in flight leaves the held
// reservation in sessionStorage. Typing the same name again resumes it
// without any lookup, runs a second navigator.credentials.create for the SAME
// user handle (CTAP2/platform authenticators overwrite a discoverable
// credential with the same rpId+userHandle), and the server refuses the
// second /auth/register. Result: the server-side account is active with
// credential #1, the device only holds credential #2 -> the account (and
// its name) can never be signed in to. Username accounts have no recovery code.
import assert from 'node:assert/strict';
import test from 'node:test';

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
            if (holdRegisterReply) return new Promise(() => {}); // committed; reply lost (page reloads)
            return json(200, { success: true });
        }
        if (path === '/auth/challenge') {
            const a = [...accounts.entries()].find(([, v]) => v.username === body.username && v.status === 'active');
            if (!a) return json(401, { error: 'Authentication failed', code: 'AUTHENTICATION_FAILED' });
            return json(200, { challengeId: 'x', accountId: a[0], publicKey: { challenge: b64('login'), allowCredentials: [{ id: a[1].credentialId, type: 'public-key' }] } });
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
            async create({ publicKey }) {
                const handle = Buffer.from(publicKey.user.id).toString('base64url');
                const id = 'cred' + (++n);
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

test('reload during registration selects login without replacing the registered passkey', async () => {
    const server = fakeServer();
    const auth = fakeAuthenticator();
    Object.defineProperty(globalThis, 'sessionStorage', { value: fakeSessionStorage(), configurable: true, writable: true });
    Object.defineProperty(globalThis, 'navigator', { value: { credentials: auth.credentials }, configurable: true });
    sessionService.fetch = server.fetch;
    sessionService.doesSessionExist = async () => true;
    accountService.state.passkeySupported = true;
    accountService.state.accountId = null;
    accountService.localAccountContinuity = false;
    chatDB.db = {};

    // ---- Page 1: sign-up for "winter-owl"; the register reply is lost.
    await accountService.prepareAccount('winter-owl');
    assert.equal(await accountService.registerPasskeyForPreparedAccount(), true);
    server.holdRegisterReply = true;
    void accountService.completeAccountRegistration();          // never settles: the page reloads
    for (let i = 0; i < 200 && !server.calls.includes('/auth/register'); i++) await new Promise(r => setTimeout(r, 5));
    const [accountId, serverAccount] = [...server.accounts.entries()][0];
    assert.equal(serverAccount.status, 'active', 'server created the account with cred1');
    assert.equal(serverAccount.credentialId, 'cred1');

    // ---- Reload: in-memory state gone, the tab's sessionStorage is not.
    accountService.cancelPendingAccount();
    server.holdRegisterReply = false;
    server.calls.length = 0;

    // ---- Page 2: the person types the same name and presses Enter.
    const modal = Object.create(AccountModal.prototype);
    Object.assign(modal, {
        isOpen: true, loginViewVersion: 0, usernameContinuePending: false, usernamePasskeyBusy: false,
        identifierMode: 'username', usernameInputValue: 'winter-owl', creationStep: 'idle',
        animationTimeouts: [], heldRegistration: null, accountState: accountService.getState(),
        accountService, app: { showToast() {}, notifyFirstAccountReady() {} },
        render() {}, focusModal() {}, close() { this.isOpen = false; },
        startPasskeyIntro() { /* the timer would call handleUsernamePasskeyContinue */ }
    });
    accountService.subscribe(s => { modal.accountState = s; });
    await modal.handleAccountContinue();
    assert.equal(modal.usernameUnlockReady, true, 'existing account selects sign-in');
    assert.ok(server.calls.includes('/auth/challenge'));
    assert.deepEqual([...auth.creds.values()], ['cred1'], 'registered passkey is never replaced');
    assert.equal(serverAccount.credentialId, 'cred1');
});
