import test from 'node:test';
import assert from 'node:assert/strict';
import accountService from '../../chat/services/accountService.js';

test('closing signup aborts the PRF fallback assertion and permits a fresh attempt', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    const old = { pending: accountService.pendingAccount, supported: accountService.state.passkeySupported,
        ceremony: accountService.passkeyCeremony, notify: accountService.notify, error: accountService.state.error,
        prfSupported: accountService.state.prfSupported };
    let entered;
    const waiting = new Promise(resolve => { entered = resolve; });
    let signal;
    let fallbackOptions;
    let retry = false;
    let expectedHints = ['client-device'];
    const credential = results => ({ rawId: new Uint8Array([1]).buffer,
        getClientExtensionResults: () => ({ prf: results ? { results: { first: new Uint8Array(32).fill(7).buffer } } : { enabled: true } }) });
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { credentials: {
        create: async ({ publicKey }) => {
            assert.deepEqual(publicKey.hints, expectedHints);
            assert.equal(publicKey.authenticatorSelection.userVerification, 'required');
            assert.equal(publicKey.authenticatorSelection.authenticatorAttachment, undefined);
            return credential(retry);
        },
        get: options => { signal = options.signal; fallbackOptions = options.publicKey; entered(); return new Promise((resolve, reject) => {
            options.signal.addEventListener('abort', () => reject(new DOMException('Cancelled', 'AbortError')), { once: true });
        }); }
    } } });
    accountService.pendingAccount = { accountId: '1234567890123456', username: 'retry-user', initData: { challenge: 'YQ==', rpId: 'localhost' } };
    accountService.state.passkeySupported = true;
    accountService.notify = () => {};
    try {
        const run = accountService.registerPasskeyForPreparedAccount();
        await waiting;
        assert.ok(signal);
        assert.deepEqual(fallbackOptions.hints, ['client-device']);
        assert.equal(fallbackOptions.userVerification, 'required');
        accountService.abortPasskeyCeremony();
        assert.equal(signal.aborted, true);
        assert.equal(await run, false);
        assert.equal(accountService.passkeyCeremony, null);
        retry = true;
        expectedHints = ['hybrid'];
        accountService.pendingAccount.initData.publicKey = { hints: expectedHints };
        assert.equal(await accountService.registerPasskeyForPreparedAccount(), true);
        assert.equal(accountService.passkeyCeremony, null);
    } finally {
        if (descriptor) Object.defineProperty(globalThis, 'navigator', descriptor); else delete globalThis.navigator;
        accountService.pendingAccount = old.pending; accountService.state.passkeySupported = old.supported;
        accountService.passkeyCeremony = old.ceremony; accountService.notify = old.notify;
        accountService.state.error = old.error; accountService.state.prfSupported = old.prfSupported;
    }
});
