import assert from 'node:assert/strict';
import test from 'node:test';

globalThis.window = { location: { hostname: 'localhost' } };

const { BrowserWalletRuntime, BrowserWalletHttpError } = await import('@openanonymity/zkapi-browser-sdk/runtime');
const { withBrowserWalletLock } = await import('@openanonymity/zkapi-browser-sdk/store');
const { createPrivateLeaseRecovery } = await import('../../chat/zkapi/services/privateLeaseRecovery.mjs');

function harness(options = {}) {
    const runtime = new BrowserWalletRuntime();
    const request = {
        client_request_id: 'interrupted-request',
        proof: { a: ['original-proof'] },
        public_inputs: { solvency_bound: 1_000_000 }
    };
    let durable = {
        deploymentId: 'interrupted-recovery-test',
        state: { note_id: 42, current_balance: 2_000_000 },
        journal: { prepared_request: request, nullifier: 'original-nullifier' },
        lease: null
    };
    const before = structuredClone(durable);
    const calls = [];
    const commits = [];
    let locked = false;
    let status = 'provisioning';
    const receipt = { signature: 'signed-receipt', request_id: request.client_request_id };
    const expiresAt = Math.floor(Date.now() / 1000) + 600;
    const lease = {
        status: 'active',
        client_request_id: request.client_request_id,
        api_key: 'must-stay-in-memory',
        expires_at: expiresAt,
        settle_after: expiresAt,
        spending_limit_usd: 1,
        openrouter_api_base: 'https://openrouter.ai/api/v1',
        key_source: 'oa_org',
        verification: {
            station_id: 'station', station_signature: 'station-signature',
            org_signature: 'org-signature', key_valid_till: expiresAt,
            verifier_url: 'https://verifier.example'
        }
    };
    runtime.manifest = { deployment_id: durable.deploymentId };
    runtime.config = {
        funding: { protocol_server_url: 'https://protocol.example' },
        credits_per_usd: 1_000_000,
        wallet_core: { trusted: true },
        openrouter: {
            inference_base: lease.openrouter_api_base,
            require_oa_key_source: true,
            verifier_url: lease.verification.verifier_url
        }
    };
    runtime.init = async () => {};
    runtime.runtime = structuredClone(durable);
    runtime.reload = async () => {
        assert.equal(locked, true, 'reads happen under the SDK wallet lock');
        runtime.runtime = structuredClone(durable);
        return runtime.runtime;
    };
    runtime.commit = async next => {
        assert.equal(locked, true, 'receipt commits remain under the SDK wallet lock');
        assert.equal(JSON.stringify(next).includes(lease.api_key), false);
        commits.push(structuredClone(next));
        durable = structuredClone(next);
        runtime.runtime = structuredClone(next);
        return runtime.runtime;
    };
    runtime.worker = {
        async call(method, payload) {
            calls.push({ method });
            assert.equal(method, 'completeResponse');
            assert.deepEqual(payload.args.journal, before.journal);
            assert.deepEqual(payload.args.response, receipt);
            if (options.badReceipt) throw new Error('Invalid receipt signature');
            return { note_id: 42, current_balance: 1_990_000 };
        }
    };
    runtime.remoteJson = async (url, init = {}) => {
        calls.push({ url, ...init });
        assert.equal(locked, true, 'all recovery network steps hold the wallet lock');
        if (url.endsWith('/submit_key')) {
            assert.equal(JSON.parse(init.body).api_key, lease.api_key);
            options.onVerify?.();
            return { status: options.verificationRejected ? 'rejected' : 'verified' };
        }
        if (url.endsWith('/v2/openrouter/leases')) {
            assert.equal(init.method, 'POST');
            assert.equal(init.body, JSON.stringify(request), 'replays byte-identical saved request');
            if (options.issuanceError) throw options.issuanceError;
            status = 'active';
            options.onIssue?.();
            return { ...structuredClone(lease), ...options.leaseOverrides };
        }
        if (url.endsWith(`/v2/openrouter/leases/${request.client_request_id}`)) {
            if (init.method !== 'POST') {
                if (options.statusError) throw options.statusError;
                return { status };
            }
            assert.equal(init.body, JSON.stringify(request), 'retires only the same proved request');
            if (options.retirementError) throw options.retirementError;
            status = options.retirementStatus || 'finalized';
            options.onRetire?.();
            return { status };
        }
        if (url.endsWith(`/v2/requests/${request.client_request_id}`)) {
            if (options.receiptError) throw options.receiptError;
            return { request_response: options.missingReceipt ? null : receipt };
        }
        if (url.endsWith('/v2/nullifiers/original-nullifier')) {
            return options.nullifierRecovery || { nullifier_status: 'unknown' };
        }
        assert.fail(`Unexpected recovery endpoint: ${url}`);
    };
    const withWalletLock = (_deploymentId, operation) => withBrowserWalletLock(_deploymentId, async () => {
        assert.equal(locked, false);
        locked = true;
        try { return await operation(); } finally { locked = false; }
    });
    const recover = createPrivateLeaseRecovery({
        runtime,
        withWalletLock,
        retryOptions: { maxWaitMs: 0, maxAttempts: 1 },
        ...options.factory
    });
    return {
        runtime, request, before, calls, commits, recover, withWalletLock,
        durable: () => structuredClone(durable),
        setDurable: next => { durable = structuredClone(next); },
        setStatus: next => { status = next; }
    };
}

test('the pinned SDK leaves provisioning untouched; recovery replays, verifies, retires and installs its receipt', async () => {
    const h = harness();
    await h.withWalletLock('test', async () => {
        assert.equal(await h.runtime.recoverPendingLocked({ retireLostKey: true }), false);
    });
    assert.deepEqual(h.durable(), h.before, 'reproduces the stranded original journal');
    const progress = [];
    assert.equal(await h.recover({ sessionId: 'failed-chat', onProgress: (...args) => progress.push(args) }), true);
    assert.equal(h.runtime.activeLease, null);
    assert.equal(h.durable().journal, null);
    assert.equal(h.durable().lease, null);
    assert.equal(h.durable().state.current_balance, 1_990_000);
    assert.equal(h.commits.length, 1, 'only the verified receipt installs state');
    assert.equal(JSON.stringify(progress).includes('must-stay-in-memory'), false);
    assert.deepEqual(h.calls.filter(call => call.method === 'POST').map(call => call.url), [
        'https://protocol.example/v2/openrouter/leases',
        'https://verifier.example/submit_key',
        'https://protocol.example/v2/openrouter/leases/interrupted-request'
    ]);
});

test('continued temporary-key outage fails boundedly without modifying the journal or enabling inference', async () => {
    const failure = new BrowserWalletHttpError('Temporary-key service unavailable', 503, 'oa_unavailable', { retriable: true });
    const h = harness({ issuanceError: failure });
    await assert.rejects(h.recover(), error => error === failure);
    assert.deepEqual(h.durable(), h.before);
    assert.equal(h.runtime.activeLease, null);
    assert.equal(h.commits.length, 0);
    assert.equal(h.calls.filter(call => call.method === 'POST').length, 1);
});

test('a later retry after service recovery finishes the saved request without replacement proofs', async () => {
    const options = {
        issuanceError: new BrowserWalletHttpError('Temporary-key service unavailable', 503, 'oa_unavailable', { retriable: true })
    };
    const h = harness(options);
    await assert.rejects(h.recover());
    options.issuanceError = null;
    assert.equal(await h.recover(), true);
    const requests = h.calls.filter(call => call.url?.endsWith('/v2/openrouter/leases'));
    assert.equal(requests.length, 2);
    assert.equal(requests[0].body, requests[1].body);
    assert.equal(h.commits.length, 1);
    assert.equal(h.durable().journal, null);
});

test('cancellation interrupts the SDK retry delay with the recovery journal intact', async () => {
    const controller = new AbortController();
    const h = harness({
        issuanceError: new BrowserWalletHttpError('Temporary-key service unavailable', 503, 'oa_unavailable', { retriable: true }),
        factory: { retryOptions: { maxWaitMs: 5_000, maxAttempts: 2, initialRetryMs: 1_000 } }
    });
    await assert.rejects(h.recover({
        signal: controller.signal,
        onProgress(phase) {
            if (phase === 'waiting') controller.abort();
        }
    }), error => error.name === 'AbortError');
    assert.deepEqual(h.durable(), h.before);
    assert.equal(h.calls.filter(call => call.method === 'POST').length, 1);
});

test('production recovery retry policy bounds attempts instead of using the full issuance loop', async () => {
    const h = harness();
    let retryOptions;
    h.runtime.requestLeaseWithRetry = async (_request, _progress, _signal, options) => {
        retryOptions = options;
        throw new Error('service unavailable');
    };
    const recover = createPrivateLeaseRecovery({ runtime: h.runtime, withWalletLock: h.withWalletLock });
    await assert.rejects(recover(), /service unavailable/);
    assert.deepEqual(retryOptions, { maxWaitMs: 15_000, maxAttempts: 2 });
    assert.deepEqual(h.durable(), h.before);
});

for (const [name, options] of [
    ['wrong request identity', { leaseOverrides: { client_request_id: 'another-request' } }],
    ['wrong spending limit', { leaseOverrides: { spending_limit_usd: 10 } }],
    ['untrusted inference origin', { leaseOverrides: { openrouter_api_base: 'https://untrusted.example' } }],
    ['rejected OA evidence', { verificationRejected: true }]
]) {
    test(`${name} preserves recovery state without retiring an unverified key`, async () => {
        const h = harness(options);
        await assert.rejects(h.recover());
        assert.deepEqual(h.durable(), h.before);
        assert.equal(h.runtime.activeLease, null);
        assert.equal(h.calls.some(call => call.method === 'POST' && call.url.endsWith('/interrupted-request')), false);
    });
}

for (const [name, options] of [
    ['retirement failure', { retirementError: new Error('retirement unavailable') }],
    ['unfinished retirement', { retirementStatus: 'active' }],
    ['receipt fetch failure', { receiptError: new Error('receipt unavailable') }],
    ['missing receipt', { missingReceipt: true }],
    ['invalid signed receipt', { badReceipt: true }]
]) {
    test(`${name} keeps the exact journal for a later retry`, async () => {
        const h = harness(options);
        await assert.rejects(h.recover());
        assert.deepEqual(h.durable(), h.before);
        assert.equal(h.runtime.activeLease, null);
        assert.equal(h.commits.length, 0);
    });
}

test('scoped retry after missing receipt installs an ownerless finalized request without reissuing', async () => {
    const options = { missingReceipt: true };
    const h = harness(options);
    await assert.rejects(h.recover({ sessionId: 'failed-chat' }), error => error.code === 'lease_pending');
    options.missingReceipt = false;
    assert.equal(await h.recover({ sessionId: 'failed-chat' }), true);
    assert.equal(h.calls.filter(call => call.url?.endsWith('/v2/openrouter/leases')).length, 1);
    assert.equal(h.durable().journal, null);
});

for (const status of ['active', 'finalized', 'settling']) {
    test(`${status} requests with a known chat remain owned by normal SDK scoped recovery`, async () => {
        const h = harness();
        h.setStatus(status);
        h.setDurable({ ...h.before, lease: { sessionId: 'failed-chat', ownerId: h.runtime.ownerId } });
        const before = h.durable();
        assert.equal(await h.recover({ sessionId: 'failed-chat' }), false);
        assert.deepEqual(h.durable(), before);
        assert.equal(h.calls.length, 1);
    });
}

test('unknown missing requests never clear a journal or create a replacement proof', async () => {
    const h = harness({ statusError: new BrowserWalletHttpError('Not found', 404, 'not_found') });
    await assert.rejects(h.recover({ sessionId: 'failed-chat' }), error => error.code === 'private_access_recovery_pending');
    assert.deepEqual(h.durable(), h.before);
    assert.equal(h.calls.length, 3, 'SDK checks the saved nullifier before leaving recovery pending');
});

test('missing ownerless requests retain SDK withdrawal-clearance recovery', async () => {
    const h = harness({
        statusError: new BrowserWalletHttpError('Not found', 404, 'not_found'),
        nullifierRecovery: { nullifier_status: 'clearance_reserved' }
    });
    assert.equal(await h.recover({ sessionId: 'failed-chat' }), true);
    assert.equal(h.durable().journal, null);
    assert.equal(h.durable().preparedWithdrawal.clearanceReserved, true);
    assert.equal(h.durable().preparedWithdrawal.withdrawalNullifier, 'original-nullifier');
    assert.equal(h.calls.some(call => call.method === 'POST'), false);
});

test('unknown ownerless lease status remains pending instead of reporting scoped settlement complete', async () => {
    const h = harness();
    h.setStatus('settling');
    await assert.rejects(h.recover({ sessionId: 'failed-chat' }), error => error.code === 'private_access_recovery_pending');
    assert.deepEqual(h.durable(), h.before);
    assert.equal(h.calls.length, 1);
});

test('retry after aborting issued ownerless access retires the existing key and applies the receipt', async () => {
    const controller = new AbortController();
    const h = harness({ onIssue: () => controller.abort() });
    await assert.rejects(h.recover({ sessionId: 'failed-chat', signal: controller.signal }), error => error.name === 'AbortError');
    assert.deepEqual(h.durable(), h.before);
    assert.equal(await h.recover({ sessionId: 'failed-chat' }), true);
    assert.equal(h.durable().journal, null);
    assert.equal(h.durable().lease, null);
    assert.equal(h.runtime.activeLease, null);
    assert.equal(h.calls.filter(call => call.url?.endsWith('/v2/openrouter/leases')).length, 1);
    assert.equal(h.commits.length, 1);
});

test('scoped active/finalized recovery never touches another chat or live tab owner', async () => {
    for (const status of ['active', 'finalized']) {
        for (const kind of ['another-chat', 'another-tab']) {
            const h = harness();
            h.setStatus(status);
            h.setDurable({ ...h.before, lease: {
                sessionId: kind === 'another-chat' ? 'other-chat' : 'failed-chat',
                ownerId: kind === 'another-tab' ? 'other-tab' : h.runtime.ownerId,
                settle_after: Math.floor(Date.now() / 1000) + 600
            } });
            const before = h.durable();
            assert.equal(await h.recover({ sessionId: 'failed-chat' }), false);
            assert.deepEqual(h.durable(), before);
            assert.equal(h.calls.length, 0);
        }
    }
});

test('ownerless active/finalized requests with a missing receipt cannot report settlement complete', async () => {
    for (const status of ['active', 'finalized']) {
        const h = harness({ missingReceipt: true });
        h.setStatus(status);
        await assert.rejects(h.recover({ sessionId: 'failed-chat' }), error => error.code === 'lease_pending');
        assert.deepEqual(h.durable(), h.before);
        assert.equal(h.runtime.activeLease, null);
        assert.equal(h.calls.some(call => call.url?.endsWith('/v2/openrouter/leases')), false);
    }
});

test('an active in-memory key, another chat owner, or a live other-tab owner prevents replay', async () => {
    for (const kind of ['active-key', 'another-chat', 'another-tab']) {
        const h = harness();
        if (kind === 'active-key') h.runtime.activeLease = { sessionId: 'failed-chat' };
        if (kind !== 'active-key') h.setDurable({
            ...h.before,
            lease: {
                sessionId: kind === 'another-chat' ? 'other-chat' : 'failed-chat',
                ownerId: kind === 'another-tab' ? 'other-tab' : h.runtime.ownerId,
                settle_after: Math.floor(Date.now() / 1000) + 600
            }
        });
        const before = h.durable();
        assert.equal(await h.recover({ sessionId: 'failed-chat' }), false, kind);
        assert.deepEqual(h.durable(), before);
        assert.equal(h.calls.length, 0);
    }
});

test('an expired other-tab ownership window permits interrupted recovery', async () => {
    const h = harness();
    h.setDurable({ ...h.before, lease: {
        sessionId: 'failed-chat', ownerId: 'expired-tab', settle_after: 1
    } });
    assert.equal(await h.recover({ sessionId: 'failed-chat' }), true);
});

test('state replaced while waiting for the lock is reloaded before choosing any request', async () => {
    const h = harness();
    let release;
    const blocking = h.withWalletLock('test', () => new Promise(resolve => { release = resolve; }));
    while (!release) await Promise.resolve();
    const recovery = h.recover({ sessionId: 'failed-chat' });
    h.setDurable({ ...h.before, journal: null, lease: null });
    release();
    await blocking;
    assert.equal(await recovery, false);
    assert.equal(h.calls.length, 0);
    assert.equal(h.durable().journal, null);
});

test('cancellation while queued never starts a late recovery after the wallet lock opens', async () => {
    const h = harness();
    let release;
    const blocking = h.withWalletLock('test', () => new Promise(resolve => { release = resolve; }));
    while (!release) await Promise.resolve();
    const controller = new AbortController();
    const recovery = h.recover({ signal: controller.signal });
    await Promise.resolve();
    controller.abort();
    release();
    await blocking;
    await assert.rejects(recovery, error => error.name === 'AbortError');
    assert.equal(h.calls.length, 0);
    assert.deepEqual(h.durable(), h.before);
});

for (const phase of ['onIssue', 'onVerify', 'onRetire']) {
    test(`cancellation at ${phase} preserves the journal without publishing credentials`, async () => {
        const controller = new AbortController();
        const h = harness({ [phase]: () => controller.abort() });
        await assert.rejects(h.recover({ signal: controller.signal }), error => error.name === 'AbortError');
        assert.deepEqual(h.durable(), h.before);
        assert.equal(h.runtime.activeLease, null);
        assert.equal(h.commits.length, 0);
        assert.equal(h.calls.some(call => call.url?.includes('/v2/requests/')), false);
    });
}
