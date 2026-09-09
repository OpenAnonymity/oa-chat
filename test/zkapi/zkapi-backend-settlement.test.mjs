import assert from 'node:assert/strict';
import test from 'node:test';

const values = new Map();
globalThis.localStorage = {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: key => values.delete(key)
};
globalThis.sessionStorage = globalThis.localStorage;
globalThis.window = new EventTarget();
globalThis.window.location = {
    hostname: 'localhost', origin: 'http://localhost',
    href: 'http://localhost/funding/', search: ''
};
globalThis.location = window.location;

const { createZkapiBackend } = await import('../../chat/zkapi/services/inference/backends/zkapiBackend.js');
const { default: client } = await import('@openanonymity/zkapi-browser-sdk/client');
const { default: walletRuntime } = await import('@openanonymity/zkapi-browser-sdk/runtime');

const backend = createZkapiBackend({});
const lease = sessionId => ({ session_id: sessionId, expires_at: Math.floor(Date.now() / 1000) + 3600 });
const session = (extra = {}) => ({
    id: 'chat-a', inferenceBackend: 'zkapi', zkapiSessionId: 'chat-a',
    apiKey: 'chat-a', apiKeyInfo: { backendId: 'zkapi', sessionBound: true },
    currentEphemeralKeyId: 'chat-a', expiresAt: 9999999, ...extra
});

test.beforeEach(() => {
    client.config = { active_lease: lease('chat-a') };
    client.wallet = { pending_request: true };
    client.activities = [];
});

test('clearing private access retains an owned retirement marker and changes no other chat credentials', () => {
    const owner = session();
    const other = session({ id: 'chat-b', apiKey: 'ticket-key', inferenceBackend: 'openrouter' });
    const otherBefore = structuredClone(other);
    backend.clearAccessInfo(owner);
    assert.equal(owner.zkapiSettleBeforeAccess, true);
    assert.equal(owner.zkapiSessionId, 'chat-a');
    for (const field of ['apiKey', 'apiKeyInfo', 'expiresAt', 'currentEphemeralKeyId']) {
        assert.equal(owner[field], null);
    }
    assert.deepEqual(other, otherBefore);
    client.config.active_lease = lease('chat-b');
    backend.clearAccessInfo(owner);
    assert.equal(owner.zkapiSettleBeforeAccess, true, 'an existing obligation survives a newer active owner');
    const unrelated = session({ id: 'chat-c' });
    backend.clearAccessInfo(unrelated);
    assert.equal(unrelated.zkapiSettleBeforeAccess, undefined);
});

test('access waits for owner-scoped retirement and clears its marker only after success', async t => {
    const owner = session({ zkapiSettleBeforeAccess: true, apiKey: null, apiKeyInfo: null });
    let release;
    const hold = new Promise(resolve => { release = resolve; });
    const settlement = t.mock.method(client, 'settleActiveLease', async () => hold);
    let resolved = false;
    const access = backend.requestAccess({ session: owner }).then(value => { resolved = true; return value; });
    await Promise.resolve();
    assert.equal(resolved, false);
    assert.equal(owner.zkapiSettleBeforeAccess, true);
    assert.deepEqual(settlement.mock.calls[0].arguments, [undefined, { sessionId: 'chat-a' }]);
    release();
    assert.deepEqual(await access, { key: 'chat-a', token: 'chat-a', backendId: 'zkapi', sessionBound: true });
    assert.equal(owner.zkapiSettleBeforeAccess, undefined);
    assert.equal(owner.apiKey, null, 'requestAccess does not install credentials before its caller accepts them');
    await backend.requestAccess({ session: owner });
    assert.equal(settlement.mock.calls.length, 1, 'completed retirement is not repeated');
});

test('a rejected retirement preserves the marker and retry stays scoped to the same captured chat', async t => {
    const owner = session({ zkapiSettleBeforeAccess: true });
    const failure = Object.assign(new Error('Usage still finalizing'), { code: 'lease_pending' });
    let attempts = 0;
    const settlement = t.mock.method(client, 'settleActiveLease', async () => {
        if (++attempts === 1) throw failure;
    });
    await assert.rejects(backend.requestAccess({ session: owner }), error => error === failure);
    assert.equal(owner.zkapiSettleBeforeAccess, true);
    await backend.requestAccess({ session: owner });
    assert.equal(owner.zkapiSettleBeforeAccess, undefined);
    assert.deepEqual(settlement.mock.calls.map(call => call.arguments), [
        [undefined, { sessionId: 'chat-a' }], [undefined, { sessionId: 'chat-a' }]
    ]);
});

test('an already canceled access request retains its marker without starting settlement', async t => {
    const settlement = t.mock.method(client, 'settleActiveLease', async () => {});
    const owner = session({ zkapiSettleBeforeAccess: true });
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(backend.requestAccess({ session: owner, signal: controller.signal }), error =>
        error.name === 'AbortError' && error.isCancelled === true);
    assert.equal(settlement.mock.calls.length, 0);
    assert.equal(owner.zkapiSettleBeforeAccess, true);
});

test('the actual client and browser owner check leave a newer chat lease intact during marked access recovery', async t => {
    const owner = session({ zkapiSettleBeforeAccess: true });
    const durable = {
        deploymentId: 'backend-owner-scope',
        state: { note_id: 1, current_balance: 1950000 },
        lease: { sessionId: 'chat-b', client_request_id: 'request-b' },
        journal: { prepared_request: { client_request_id: 'request-b' } }
    };
    t.mock.method(client, 'init', async () => {});
    t.mock.method(client, 'refresh', async () => client.snapshot());
    t.mock.method(walletRuntime, 'init', async () => {});
    t.mock.method(walletRuntime, 'reload', async () => {
        walletRuntime.runtime = structuredClone(durable);
        return walletRuntime.runtime;
    });
    const recovery = t.mock.method(walletRuntime, 'recoverPendingLocked', async () => {
        assert.fail('Recovery must not run against chat B for chat A');
    });
    const retire = t.mock.method(walletRuntime, 'retireActiveLease', async () => {
        assert.fail('Chat B must not be retired for chat A');
    });
    const priorBrowserMode = client.browserMode;
    const priorManifest = walletRuntime.manifest;
    const priorLease = walletRuntime.activeLease;
    t.after(() => {
        client.browserMode = priorBrowserMode;
        walletRuntime.manifest = priorManifest;
        walletRuntime.activeLease = priorLease;
    });
    client.browserMode = true;
    client.config.active_lease = lease('chat-b');
    walletRuntime.manifest = { deployment_id: durable.deploymentId };
    walletRuntime.activeLease = { sessionId: 'chat-b', client_request_id: 'request-b' };
    assert.equal((await backend.requestAccess({ session: owner })).key, 'chat-a');
    assert.equal(owner.zkapiSettleBeforeAccess, undefined);
    assert.equal(recovery.mock.calls.length, 0);
    assert.equal(retire.mock.calls.length, 0);
    assert.deepEqual(walletRuntime.runtime, durable);
    assert.equal(walletRuntime.activeLease.sessionId, 'chat-b');
});
