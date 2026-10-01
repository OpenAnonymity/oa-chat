import test from 'node:test';
import assert from 'node:assert/strict';
import accountService from '../../chat/services/accountService.js';
import sessionService from '../../chat/services/sessionService.js';
import { createEncryptionKeyWrapperFromPrf, unlockEncryptionKeyring } from '../../chat/services/encryptionPasskey.js';

const A = '1111111111111111';
const B = '2222222222222222';
const id = 'Y3JlZGVudGlhbC0x';
const prf = new Uint8Array(32).fill(8);
const master = new Uint8Array(32).fill(9);

function browser(t, get, origin = 'https://chat.openanonymity.ai') {
    const oldWindow = globalThis.window;
    const oldNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    globalThis.window = { location: { origin } };
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { credentials: { get } } });
    t.after(() => {
        globalThis.window = oldWindow;
        if (oldNavigator) Object.defineProperty(globalThis, 'navigator', oldNavigator);
        else delete globalThis.navigator;
    });
}

function assertion(credentialId = id) {
    return { id: credentialId, getClientExtensionResults: () => ({ prf: { results: { first: prf.slice().buffer } } }) };
}

async function fixture() {
    const wrapper = await createEncryptionKeyWrapperFromPrf(master.slice(), id, prf.slice());
    const service = Object.create(Object.getPrototypeOf(accountService));
    service.state = { accountId: A, sessionVerified: true, oauthProvider: 'google',
        oauthKeyringRequired: true, encryptionMode: 'PRF', busy: false };
    service.loginGeneration = 1;
    service.syncInitializationGeneration = 1;
    service.keyringWrappers = [wrapper];
    service.setState = patch => Object.assign(service.state, patch);
    service.fetchOAuthKeyring = async () => ({ accountId: A, wrappers: [wrapper] });
    return { service, wrapper };
}

test('explicit preview recovery decrypts the same wrapper with a fixed RP and credential allowlist', async t => {
    let request;
    browser(t, async options => { request = options; return assertion(); });
    const { wrapper } = await fixture();
    const before = JSON.stringify(wrapper);
    const result = await unlockEncryptionKeyring([wrapper], { usePrelaunchPasskey: true, rpId: 'attacker.example' });
    assert.deepEqual(result.masterKey, master);
    assert.equal(JSON.stringify(wrapper), before);
    assert.equal(request.publicKey.rpId, 'oa-production-20260917.vercel.app');
    assert.equal(request.publicKey.userVerification, 'required');
    assert.deepEqual(request.publicKey.hints, ['client-device']);
    assert.equal(request.publicKey.allowCredentials.length, 1);
    assert.equal(Buffer.from(request.publicKey.allowCredentials[0].id).toString(), 'credential-1');
});

test('ordinary unlock keeps the current RP and rejects an unlisted credential', async t => {
    let request;
    browser(t, async options => { request = options; return assertion('dW5saXN0ZWQ'); });
    const { wrapper } = await fixture();
    await assert.rejects(unlockEncryptionKeyring([wrapper]), /not registered/);
    assert.equal(request.publicKey.rpId, undefined);
});

for (const origin of ['https://staging.openanonymity.ai', 'https://chat.openanonymity.ai.evil.test',
    'http://chat.openanonymity.ai', 'https://oa-production-20260917.vercel.app']) {
    test(`preview recovery refuses ${origin} before opening WebAuthn`, async t => {
        let calls = 0;
        browser(t, async () => { calls++; return assertion(); }, origin);
        const { wrapper, service } = await fixture();
        await assert.rejects(unlockEncryptionKeyring([wrapper], { usePrelaunchPasskey: true }), /only available/);
        assert.equal(await service.unlockOAuthKeyring(null, { usePrelaunchPasskey: true }), false);
        assert.equal(calls, 0);
    });
}

test('ROR configuration or browser refusal produces an actionable error without a second prompt', async t => {
    let calls = 0;
    browser(t, async () => { calls++; throw Object.assign(new Error('blocked'), { name: 'SecurityError' }); });
    const { wrapper } = await fixture();
    await assert.rejects(unlockEncryptionKeyring([wrapper], { usePrelaunchPasskey: true }), /could not use the pre-launch passkey/);
    assert.equal(calls, 1);
});

test('recovery completes with the original account ownership and unchanged master key', async t => {
    browser(t, async () => assertion());
    const { service } = await fixture();
    let completed = false;
    service.finishOAuthKeyUnlock = async (key, credentialId, ownership) => {
        assert.deepEqual(key, master);
        assert.equal(credentialId, id);
        assert.deepEqual(ownership, { expectedAccountId: A, unlockGeneration: 1 });
        completed = true;
        return true;
    };
    assert.equal(await service.unlockOAuthKeyring(null, { usePrelaunchPasskey: true }), true);
    assert.equal(completed, true);
});

for (const outcome of ['success', 'cancel']) {
    for (const replacement of [B, null]) {
        test(`late ${outcome} after switch to ${replacement} cannot install keys or change the new UI`, async t => {
            let resume;
            let entered;
            const started = new Promise(resolve => { entered = resolve; });
            browser(t, () => { entered(); return new Promise((resolve, reject) => {
                resume = () => outcome === 'success' ? resolve(assertion()) : reject(Object.assign(new Error('cancelled'), { name: 'NotAllowedError' }));
            }); });
            const { service } = await fixture();
            let finishes = 0;
            service.finishOAuthKeyUnlock = async () => { finishes++; return true; };
            const pending = service.unlockOAuthKeyring(null, { usePrelaunchPasskey: true });
            await started;
            service.state = { accountId: replacement, sessionVerified: Boolean(replacement), busy: false, error: 'new account state' };
            service.loginGeneration++;
            service.syncInitializationGeneration++;
            const expected = { ...service.state };
            resume();
            assert.equal(await pending, false);
            assert.equal(finishes, 0);
            assert.deepEqual(service.state, expected);
        });
    }
}

test('logout during keyring fetch cannot restore old wrappers or encryption mode', async t => {
    const { service } = await fixture();
    delete service.fetchOAuthKeyring;
    const oldFetch = sessionService.fetch;
    t.after(() => { sessionService.fetch = oldFetch; });
    let resume;
    sessionService.fetch = () => new Promise(resolve => { resume = resolve; });
    const pending = service.fetchOAuthKeyring();
    service.state = { accountId: null, sessionVerified: false, encryptionMode: null };
    service.keyringWrappers = [];
    service.loginGeneration++;
    resume({ ok: true, json: async () => ({ accountId: A, encryptionMode: 'PRF', wrappers: [{ credentialId: id }] }) });
    await assert.rejects(pending, /account changed/);
    assert.deepEqual(service.keyringWrappers, []);
    assert.equal(service.state.encryptionMode, null);
});

test('the final persistence boundary rejects stale ownership and erases the plaintext key', async () => {
    const { service } = await fixture();
    let writes = 0;
    service.persistMasterKey = async () => { writes++; };
    service.state.accountId = B;
    const key = master.slice();
    assert.equal(await service.finishOAuthKeyUnlock(key, id, { expectedAccountId: A, unlockGeneration: 1 }), false);
    assert.equal(writes, 0);
    assert.ok(key.every(value => value === 0));
});

for (const replacement of [B, null]) {
    test(`switch to ${replacement} during initial sync cannot announce successful unlock`, async () => {
        const { service } = await fixture();
        let resume;
        let entered;
        const started = new Promise(resolve => { entered = resolve; });
        service.persistMasterKey = async () => true;
        service.persistSettings = async () => {};
        service.updateStatus = service.notify = () => {};
        let announcements = 0;
        service.broadcastAccountReady = () => { announcements++; };
        service.initializeSync = async () => {
            service.syncInitializationGeneration++;
            entered();
            await new Promise(resolve => { resume = resolve; });
        };
        const pending = service.finishOAuthKeyUnlock(master.slice(), id, {
            expectedAccountId: A, unlockGeneration: 1
        });
        await started;
        service.state = { accountId: replacement, sessionVerified: Boolean(replacement) };
        service.syncInitializationGeneration++;
        resume();
        assert.equal(await pending, false);
        assert.equal(announcements, 0);
    });
}

test('recovery is only available for an existing Google PRF keyring awaiting unlock', async t => {
    browser(t, async () => assertion());
    const { service } = await fixture();
    assert.equal(service.canUsePrelaunchPasskey(), true);
    for (const patch of [
        { encryptionMode: 'LEGACY' }, { oauthSetupRequired: true },
        { oauthRecoveryRequired: true }, { oauthLegacyPasskeyRequired: true },
        { sessionVerified: false }, { oauthProvider: 'passkey' }, { oauthKeyringRequired: false }
    ]) {
        const state = service.state;
        service.state = { ...state, ...patch };
        assert.equal(service.canUsePrelaunchPasskey(), false, JSON.stringify(patch));
        service.state = state;
    }
});
