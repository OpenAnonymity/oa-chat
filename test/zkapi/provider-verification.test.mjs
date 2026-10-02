import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.window = { location: { hostname: 'localhost' }, addEventListener() {}, dispatchEvent() {} };
globalThis.location = { origin: 'https://chat.example' };
const { configureBrowserSdk } = await import('@openanonymity/zkapi-browser-sdk');
const { BrowserWalletRuntime } = await import('@openanonymity/zkapi-browser-sdk/runtime');
const { createProviderKeyVerifier, assertPrivateLeaseVerification } = await import('../../chat/zkapi/services/providerVerification.mjs');
const { buildTrustedStationFallback } = await import('../../chat/services/trustedStations.js');
const { VERIFIER_URL } = await import('../../chat/config.js');

const expiry = () => Math.floor(Date.now() / 1000) + 300;
function fixture() {
    const expires = expiry();
    const runtime = new BrowserWalletRuntime();
    runtime.config = { funding: {}, credits_per_usd: 1_000_000,
        openrouter: { inference_base: 'https://openrouter.ai/api/v1', verifier_url: VERIFIER_URL, require_oa_key_source: true } };
    const lease = { status: 'active', client_request_id: 'request', api_key: 'private-provider-key',
        expires_at: expires, settle_after: expires, spending_limit_usd: 1,
        openrouter_api_base: runtime.config.openrouter.inference_base, key_source: 'oa_org',
        verification: { verifier_url: VERIFIER_URL, station_id: 'oa-station',
            station_signature: '12'.repeat(64), org_signature: '34'.repeat(64), key_valid_till: expires } };
    return { runtime, lease };
}
function keyData(lease) {
    return { key: lease.api_key, stationId: lease.verification.station_id,
        expiresAtUnix: lease.verification.key_valid_till, stationSignature: lease.verification.station_signature,
        orgSignature: lease.verification.org_signature };
}
function fallback(lease) {
    return { status: 'verifier-unavailable', detail: 'unverified_advisory',
        trustedStationFallback: buildTrustedStationFallback(keyData(lease), '0123456789abcdef') };
}
function host(t, options = {}) {
    configureBrowserSdk(options);
    t.after(() => configureBrowserSdk({ verifyProviderKey: null, assertProviderKey: null }));
}

test('real SDK invokes host policy only after lease/cap/origin validation, projecting unverified status without a key', async t => {
    const { runtime, lease } = fixture();
    const calls = [];
    const verifier = { async submitKey(data, options) { calls.push({ data, options }); return fallback(lease); } };
    host(t, { verifyProviderKey: createProviderKeyVerifier(verifier) });
    runtime.remoteJson = () => assert.fail('host verification must own the single verifier request');
    await runtime.verifyLease(lease, 1_000_000, 'request');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].options.queueOnFailure, false);
    assert.deepEqual(Object.keys(calls[0].data).sort(), ['stationId', 'key', 'expiresAtUnix', 'stationSignature', 'orgSignature', 'recentlyAttested'].sort());
    assert.equal(lease.verifierSubmitKeyProof.status, 'verifier-unavailable');
    runtime.activeLease = { ...lease, sessionId: 'chat' };
    const snapshot = runtime.snapshot().config.active_lease;
    assert.equal(snapshot.verifierSubmitKeyProof.status, 'verifier-unavailable');
    assert.equal(JSON.stringify(snapshot).includes(lease.api_key), false);
    assert.equal(JSON.stringify(snapshot).includes(lease.verification.org_signature), false);
    snapshot.verifierSubmitKeyProof.status = 'verified';
    assert.equal(runtime.activeLease.verifierSubmitKeyProof.status, 'verifier-unavailable');
});

for (const [label, changes] of [
    ['request identity', { client_request_id: 'other' }], ['expired key', { expires_at: 1 }],
    ['spending cap', { spending_limit_usd: 2 }], ['inference origin', { openrouter_api_base: 'https://bad.example' }],
    ['key source', { key_source: 'other' }]
]) test(`host fallback never relaxes ${label}`, async t => {
    const { runtime, lease } = fixture();
    host(t, { verifyProviderKey: () => assert.fail('bad lease must fail before policy') });
    await assert.rejects(runtime.verifyLease({ ...lease, ...changes }, 1_000_000, 'request'));
});

test('a changed verifier origin and missing signatures never reach host fallback', async t => {
    const { runtime, lease } = fixture();
    host(t, { verifyProviderKey: () => assert.fail('bad evidence must fail before policy') });
    for (const changes of [{ verifier_url: 'https://bad.example' }, { station_signature: '' }, { key_valid_till: 1 }]) {
        await assert.rejects(runtime.verifyLease({ ...lease, verification: { ...lease.verification, ...changes } }, 1_000_000, 'request'));
    }
});

test('SDK default does not accept a remote server granting unverified continuation', async t => {
    const { runtime, lease } = fixture();
    host(t, { verifyProviderKey: null });
    runtime.remoteJson = async () => fallback(lease);
    await assert.rejects(runtime.verifyLease(lease, 1_000_000, 'request'), /rejected/);
    assert.equal(lease.verifierSubmitKeyProof, undefined);
});

test('host rejects legacy/unknown fallback and verifier refusals without changing the journal', async t => {
    const { runtime, lease } = fixture();
    runtime.runtime = { journal: { saved: 'original-proof' } };
    for (const result of [{ status: 'verifier-unavailable' }, { status: 'rejected', error: new Error('Invalid station signature') }]) {
        host(t, { verifyProviderKey: createProviderKeyVerifier({ submitKey: async () => result }) });
        await assert.rejects(runtime.verifyLease(lease, 1_000_000, 'request'));
        assert.deepEqual(runtime.runtime.journal, { saved: 'original-proof' });
        assert.equal(lease.verifierSubmitKeyProof, undefined);
    }
});

test('canceling verification cannot publish an otherwise usable fallback', async t => {
    const { runtime, lease } = fixture();
    const controller = new AbortController();
    host(t, { verifyProviderKey: createProviderKeyVerifier({ async submitKey() { controller.abort(); return fallback(lease); } }) });
    await assert.rejects(runtime.verifyLease(lease, 1_000_000, 'request', undefined, controller.signal), { name: 'AbortError' });
    assert.equal(lease.verifierSubmitKeyProof, undefined);
});

test('host origin mismatch fails before forwarding any credential', async () => {
    await assert.rejects(createProviderKeyVerifier({ submitKey: () => assert.fail('unexpected request') })({ verifierUrl: 'https://other.example', keyData: {} }), /different trusted verifier/);
});

test('a later ban or old fallback cannot check out a cached lease or increment in-flight count', async t => {
    const { runtime, lease } = fixture();
    let banned = false;
    host(t, { verifyProviderKey: createProviderKeyVerifier({ submitKey: async () => fallback(lease) }),
        assertProviderKey: info => assertPrivateLeaseVerification(info, { isStationBanned: () => banned }) });
    await runtime.verifyLease(lease, 1_000_000, 'request');
    lease.inFlight = 0;
    runtime.activeLease = lease;
    runtime.ensureLease = async () => lease;
    const access = await runtime.acquireEphemeralKey('chat');
    assert.equal(lease.inFlight, 1);
    access.release();
    assert.equal(lease.inFlight, 0);
    banned = true;
    await assert.rejects(runtime.acquireEphemeralKey('chat'), /no longer/);
    assert.equal(lease.inFlight, 0);
    banned = false;
    delete lease.verifierSubmitKeyProof.trustedStationFallback;
    await assert.rejects(runtime.acquireEphemeralKey('chat'), /no longer/);
    assert.equal(lease.inFlight, 0);
});

test('verifier error detail is retained instead of falling back to HTTP 401', async () => {
    const { runtime } = fixture();
    runtime.remoteFetch = async () => new Response(JSON.stringify({ detail: 'Invalid org signature' }), { status: 401 });
    await assert.rejects(runtime.remoteJson(`${VERIFIER_URL}/submit_key`), error => error.message === 'Invalid org signature' && error.status === 401);
});


test('Mainnet lease on staging uses the separately pinned verifier and keeps SDK checks', async t => {
    const mainnet = 'https://verifier-production-20260917.openanonymity.ai';
    const { runtime, lease } = fixture();
    runtime.config.openrouter.verifier_url = mainnet;
    lease.verification.verifier_url = mainnet;
    let calls = 0;
    const verifier = { verifierUrl: mainnet, async submitKey(data) {
        calls++;
        assert.equal(data.key, lease.api_key);
        return { status: 'verified', keyHash: '0123456789abcdef' };
    } };
    host(t, { verifyProviderKey: createProviderKeyVerifier(verifier) });
    await runtime.verifyLease(lease, 1_000_000, 'request');
    assert.equal(calls, 1);
    assert.equal(lease.verifierSubmitKeyProof.status, 'verified');
    await assert.rejects(createProviderKeyVerifier(verifier)({ verifierUrl: VERIFIER_URL, keyData: keyData(lease) }), /different trusted verifier/);
    assert.equal(calls, 1, 'mismatched ticket verifier never receives the provider credential');
    await assert.rejects(runtime.verifyLease({ ...lease, verification: { ...lease.verification, verifier_url: VERIFIER_URL } }, 1_000_000, 'request'));
    assert.equal(calls, 1);
});
