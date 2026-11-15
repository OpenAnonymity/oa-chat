import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createServerTimeWorld, serverTimeRuntime } from './support/server-time-world.mjs';

globalThis.window = { location: { hostname: 'localhost' }, addEventListener() {}, dispatchEvent() {} };
globalThis.location = { origin: 'https://chat.example' };
// The actual pinned SDK, after the full reviewed patch chain (pretest applies it).
const { configureBrowserSdk } = await import('@openanonymity/zkapi-browser-sdk');
const { BrowserWalletRuntime } = await import('@openanonymity/zkapi-browser-sdk/runtime');
const sdkRoot = path.dirname(fileURLToPath(import.meta.resolve('@openanonymity/zkapi-browser-sdk/package.json')));
// Not a package export: load the installed, patched module from its resolved root.
const { nativeUsdMicros } = await import(pathToFileURL(path.join(sdkRoot, 'sdk/services/zkapiNativeEth.mjs')).href);
const { StationVerifier } = await import('../../chat/services/verifier.js');
const { default: networkProxy } = await import('../../chat/services/networkProxy.js');
const { VERIFIER_URL } = await import('../../chat/config.js');
const { createProviderKeyVerifier, assertPrivateLeaseVerification } = await import('../../chat/zkapi/services/providerVerification.mjs');
const { createZkapiChatRuntimeCore } = await import('../../chat/zkapi/services/zkapiChatRuntimeCore.mjs');
const { createPrivateLeaseRecovery } = await import('../../chat/zkapi/services/privateLeaseRecovery.mjs');
const { signStationKey, trustedStationPins, recordedTrustedAccess, recordedTrustedResult } = await import('../helpers/trustedStation.js');
const { isCurrentTrustedStationFallback } = await import('../../chat/services/trustedStations.js');
const { zkapiSdkPatches, zkapiSdkPatchesProvenance } = await import('../../scripts/patch-zkapi-sdk.mjs');

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const funding = {
    billing_asset: 'native_eth', billing_unit: 'gwei', chain_id: 1,
    contract_address: `0x${'22'.repeat(20)}`, native_asset_wei_per_unit: '1000000000',
    native_price_feed_address: `0x${'33'.repeat(20)}`, native_price_feed_decimals: 8,
    native_price_max_age_seconds: 4500, demo_rpc_url: 'https://rpc.example',
    protocol_server_url: 'https://protocol.example'
};
const openrouter = { inference_base: 'https://openrouter.ai/api/v1', verifier_url: VERIFIER_URL, require_oa_key_source: true };
const digest = value => createHash('sha256').update(value).digest('hex');

function world(t, options = {}) {
    const fake = createServerTimeWorld({ funding, ...options });
    fake.spendingLimitUsd = request => Number(nativeUsdMicros(request.public_inputs.solvency_bound,
        JSON.parse(request.payload).billing_quote)) / 1_000_000;
    // OA verifier-backed key: real station signature over the issued key and its validity.
    fake.keySource = 'oa_org';
    fake.leaseExtras = (now, apiKey) => ({ verification: {
        verifier_url: VERIFIER_URL, station_id: 'oa-station', org_signature: '34'.repeat(64),
        station_recently_attested: true, key_valid_till: now + 630,
        station_signature: signStationKey({ stationId: 'oa-station', key: apiKey, expiresAtUnix: now + 630 }).stationSignature
    }, expires_at: now + 600 });
    t.mock.method(globalThis, 'fetch', fake.fetch);
    t.mock.method(Date, 'now', () => fake.deviceNow());
    return fake;
}

// The real host verifier and policy callbacks, with only its network reply faked.
function hostVerifier(t, reply, { ensureReady, onSubmit } = {}) {
    const original = networkProxy.fetchWithRetryJson;
    const submissions = [];
    const verifier = new StationVerifier({ verifierUrl: VERIFIER_URL, trustedStations: trustedStationPins('oa-station') });
    networkProxy.fetchWithRetryJson = async (url, init) => {
        const body = JSON.parse(init.body);
        submissions.push(body);
        await onSubmit?.(body);
        if (reply === 'outage') throw Object.assign(new TypeError('Failed to fetch'), { name: 'TypeError' });
        return { response: { ok: true, status: 200 }, data: { status: 'verified', station_id: body.station_id,
            key_hash: await verifier._hashKey(body.api_key) } };
    };
    configureBrowserSdk({
        verifyProviderKey: createProviderKeyVerifier(verifier, ensureReady ? { ensureReady } : {}),
        assertProviderKey: (lease, options) => assertPrivateLeaseVerification(lease, verifier, options)
    });
    t.after(() => {
        networkProxy.fetchWithRetryJson = original;
        configureBrowserSdk({ verifyProviderKey: null, assertProviderKey: null });
    });
    return { verifier, submissions };
}

for (const reply of ['verified']) for (const skewMs of [-3 * DAY, -3 * HOUR, 0, 3 * HOUR, 3 * DAY]) {
    test(`patched SDK and real host verifier (${reply}) mint and use one key with the device clock off by ${skewMs} ms`, async t => {
        const fake = world(t, { skewMs });
        const { submissions } = hostVerifier(t, reply);
        const runtime = serverTimeRuntime(BrowserWalletRuntime, fake, { funding, openrouter });
        const lease = await runtime.issueLease('chat', undefined, null, 1);
        assert.equal(fake.leasePosts.length, 1, 'exactly one authorization');
        const requestTime = fake.proofs[0].args.request_time;
        assert.ok(requestTime <= fake.serverSeconds() && requestTime + 300 >= fake.serverSeconds());
        assert.equal(submissions.length, 1);
        assert.equal(lease.verifierSubmitKeyProof.status, reply === 'verified' ? 'verified' : 'verifier-unavailable');
        assert.ok(runtime.snapshot().config.active_lease, 'the active key is shown as usable');
        fake.advance(60_000);
        const access = await runtime.acquireEphemeralKey('chat', undefined, { spendingLimitUsd: 1 });
        assert.equal(access.apiKey, lease.api_key, 'the host policy check accepts the cached key');
        access.release();
        assert.equal(fake.leasePosts.length, 1, 'no second authorization');
    });
}

test('review finding: without the SDK clock the real host verifier rejects an hours-fast device key', async t => {
    const fake = world(t, { skewMs: 3 * HOUR });
    const { verifier } = hostVerifier(t, 'verified');
    const keyData = signStationKey({ stationId: 'oa-station', key: 'sk-test', expiresAtUnix: fake.serverSeconds() + 630,
        orgSignature: '34'.repeat(64) });
    const legacy = await verifier.submitKey(keyData, { queueOnFailure: false });
    assert.equal(legacy.status, 'rejected');
    assert.match(legacy.error.message, /expired before it could be verified/);
    const scoped = await verifier.submitKey(keyData, { queueOnFailure: false, now: () => fake.serverMs });
    assert.equal(scoped.status, 'verified');
    // A non-function clock is ignored rather than trusted.
    assert.equal((await verifier.submitKey(keyData, { queueOnFailure: false, now: 'later' })).status, 'rejected');
});

test('host outage fallback and cached-key policy use the supplied server clock, never a global override', async t => {
    const fake = world(t, { skewMs: 3 * HOUR });
    const access = { ...recordedTrustedAccess('sk-cached'), expiresAtUnix: fake.serverSeconds() + 600 };
    const result = recordedTrustedResult(access);
    const serverNow = () => fake.serverMs;
    assert.equal(isCurrentTrustedStationFallback(result), false, 'the device clock alone rejects it');
    assert.equal(isCurrentTrustedStationFallback(result, access, { now: serverNow }), true);
    const verifier = { isStationBanned: () => false };
    const lease = { station_id: access.stationId, verifierSubmitKeyProof: { ...result, stationId: access.stationId } };
    assert.throws(() => assertPrivateLeaseVerification(lease, verifier), /no longer has usable/);
    assert.doesNotThrow(() => assertPrivateLeaseVerification(lease, verifier, { now: serverNow }));
    // The server clock never extends a key past its signed validity.
    fake.advance(601_000);
    assert.throws(() => assertPrivateLeaseVerification(lease, verifier, { now: serverNow }), /no longer has usable/);
    assert.equal(Date.now(), fake.deviceNow(), 'Date.now is only the test device clock');
});

test('patched SDK on an old server (404) keeps the legacy device clock for request and host checks', async t => {
    const fake = world(t, { timeEndpoint: 404 });
    let hostNow = null;
    const { verifier } = hostVerifier(t, 'verified');
    const verify = createProviderKeyVerifier(verifier);
    configureBrowserSdk({ verifyProviderKey: options => { hostNow = options.now(); return verify(options); } });
    const runtime = serverTimeRuntime(BrowserWalletRuntime, fake, { funding, openrouter });
    await runtime.issueLease('chat', undefined, null, 1);
    assert.equal(runtime.serverClock.mode, 'legacy');
    assert.equal(hostNow, fake.deviceNow());
    assert.equal(fake.leasePosts.length, 1);
});

for (const timeEndpoint of [401, 403, 500, 'malformed', 'network']) test(`patched SDK refuses a new key without downgrading when /v2/time returns ${timeEndpoint}`, async t => {
    const fake = world(t, { timeEndpoint, skewMs: 3 * HOUR });
    hostVerifier(t, 'verified');
    const runtime = serverTimeRuntime(BrowserWalletRuntime, fake, { funding, openrouter });
    await assert.rejects(runtime.issueLease('chat', undefined, null, 1), { code: 'server_time_unavailable' });
    assert.equal(fake.proofs.length, 0);
    assert.equal(fake.leasePosts.length, 0);
    assert.equal(runtime.commits.length, 0);
});

test('patched SDK resamples after a suspend between quote and timestamp', async t => {
    const fake = world(t, { skewMs: -3 * HOUR });
    hostVerifier(t, 'verified');
    let slept = false;
    fake.onRpc = w => { if (!slept) { slept = true; w.suspend(8 * 60_000); } };
    const runtime = serverTimeRuntime(BrowserWalletRuntime, fake, { funding, openrouter });
    await runtime.issueLease('chat', undefined, null, 1);
    assert.ok(fake.proofs[0].args.request_time >= fake.serverSeconds() - 5);
    assert.equal(fake.leasePosts.length, 1);
});

function savedJournal(fake, requestTime) {
    const request = { client_request_id: 'saved-request', payload_hash: '0x99',
        payload: JSON.stringify({ mode: 'openrouter_ephemeral_lease', version: 1, billing_quote: fake.quote() }),
        public_inputs: { request_time: requestTime, request_nullifier: '0x77', solvency_bound: 1_000_000 },
        proof: { backend: 'groth16_bn254', proof: 'saved-proof' } };
    return { request, bytes: JSON.stringify(request), journal: { nullifier: '0x77', prepared_request: request } };
}

test('patched SDK replaces an aged journal only after the server declares the exact bytes expired', async t => {
    const fake = world(t, { skewMs: 3 * HOUR });
    hostVerifier(t, 'verified');
    const runtime = serverTimeRuntime(BrowserWalletRuntime, fake, { funding, openrouter });
    const saved = savedJournal(fake, fake.serverSeconds() - 400);
    runtime.runtime = { ...runtime.runtime, journal: saved.journal };
    await runtime.issueLease('chat', undefined, null, 1);
    assert.equal(JSON.stringify(fake.expireCalls[0].request), saved.bytes);
    assert.equal(JSON.stringify(saved.request), saved.bytes);
    assert.equal(runtime.commits[0].journal, null);
    assert.equal(fake.leasePosts.length, 1);
});

test('patched SDK keeps future-dated and old-server journals and replays their exact bytes', async t => {
    for (const [offset, expireKnowsAge] of [[600, true], [-400, false]]) {
        const fake = world(t, { skewMs: -3 * HOUR });
        fake.expireKnowsAge = expireKnowsAge;
        hostVerifier(t, 'verified');
        const runtime = serverTimeRuntime(BrowserWalletRuntime, fake, { funding, openrouter });
        const saved = savedJournal(fake, fake.serverSeconds() + offset);
        runtime.runtime = { ...runtime.runtime, journal: saved.journal };
        await assert.rejects(runtime.issueLease('chat', undefined, null, 1), /freshness window/);
        assert.equal(JSON.stringify(fake.leasePosts[0].request), saved.bytes);
        assert.equal(fake.proofs.length, 0);
        assert.equal(runtime.runtime.journal, saved.journal);
        assert.equal(runtime.commits.length, 0);
    }
});

function chatCore(client, options = {}) {
    const core = createZkapiChatRuntimeCore({
        client, backend: { id: 'private', requestAccess: async () => ({}) },
        modelConfiguration: { getDefaultModelConfig: () => ({ defaultModelId: 'model' }) },
        createInferenceService: () => ({}), ...options
    });
    const opened = [];
    core.attach({ refreshPresentation() {}, openFunding: () => opened.push(true), showToast() {} });
    return { core, opened };
}

test('host send gate judges note expiry by the trusted server clock, with a legacy fallback only on failure', async t => {
    const fake = world(t, { skewMs: 3 * HOUR });
    const client = { hasNote: true, withdrawalBlocksChat: false, note: { expiry_ts: fake.serverSeconds() + HOUR / 1000 },
        init: async () => {}, subscribe: () => () => {} };
    const runtime = serverTimeRuntime(BrowserWalletRuntime, fake, { funding, openrouter });
    const trusted = chatCore(client, { protocolNow: signal => runtime.protocolTimeMs(signal, { maxAgeMs: 5 * 60_000 }) });
    assert.equal(await trusted.core.checkCanSend(), true, 'an hours-fast device can still send');
    assert.equal(trusted.opened.length, 0);
    const failing = chatCore(client, { protocolNow: async () => { throw new Error('time unavailable'); } });
    assert.equal(await failing.core.checkCanSend(), false, 'endpoint failure keeps the legacy device-clock gate');
    assert.equal(failing.opened.length, 1);
});

test('interrupted-access recovery respects another tab’s server-time ownership under a fast device clock', async t => {
    const fake = world(t, { skewMs: 3 * HOUR });
    const runtime = serverTimeRuntime(BrowserWalletRuntime, fake, { funding, openrouter });
    const saved = savedJournal(fake, fake.serverSeconds() - 10);
    runtime.ownerId = 'this-tab';
    runtime.runtime = { ...runtime.runtime, journal: saved.journal,
        lease: { ownerId: 'other-tab', sessionId: 'chat', client_request_id: 'saved-request',
            expires_at: fake.serverSeconds() + 270, settle_after: fake.serverSeconds() + 300 } };
    const recover = createPrivateLeaseRecovery({ runtime, withWalletLock: async (_id, operation) => operation() });
    assert.equal(await recover({}), false);
    assert.deepEqual(fake.log.filter(url => !url.endsWith('/v2/time')), [], 'no status, replay or retirement request');
    assert.equal(runtime.runtime.journal, saved.journal);
});

test('server-time patch is the last reviewed link, recorded in provenance and matching installed bytes', async () => {
    const definition = zkapiSdkPatches.at(-1);
    assert.equal(definition.name, 'server-time-v1');
    assert.equal(definition.revision, '3342c95871e8422bb878ad40072687c241a68a5b');
    const record = zkapiSdkPatchesProvenance().find(entry => entry.name === 'server-time-v1');
    assert.equal(record.sha256, digest(JSON.stringify(definition)));
    for (const [file, hash] of Object.entries(record.files)) {
        assert.equal(digest(await fs.readFile(path.join(sdkRoot, file))), hash, file);
    }
    const runtimeSource = await fs.readFile(path.join(sdkRoot, 'sdk/services/browserWalletRuntime.js'), 'utf8');
    assert.doesNotMatch(runtimeSource, /Date\.now\s*=|globalThis\.Date\s*=|Date\s*=\s*class/, 'no global clock override');
    // Earlier repairs stay intact underneath this patch.
    assert.match(runtimeSource, /browserSdkOptions\(\)\.verifyProviderKey/);
    assert.match(runtimeSource, /class ZkapiServerClock/);
});

// Review repro: a 10-minute key, then a 20-minute sleep (performance.now()
// paused) inside the host's readiness wait or the verifier transport.
for (const [where, minutes, expired] of [['ensureReady', 20, true], ['verifier transport', 20, true],
    ['ensureReady', 2, false], ['verifier transport', 2, false]]) {
    test(`a ${minutes}-minute suspend inside ${where} ${expired ? 'never installs the expired key' : 'still installs the valid key'}`, async t => {
        const fake = world(t, { skewMs: 3 * HOUR });
        const sleep = async () => fake.suspend(minutes * 60_000);
        const { submissions } = hostVerifier(t, 'verified', where === 'ensureReady' ? { ensureReady: sleep } : { onSubmit: sleep });
        const runtime = serverTimeRuntime(BrowserWalletRuntime, fake, { funding, openrouter });
        const issuing = runtime.issueLease('chat', undefined, null, 1);
        if (!expired) {
            const lease = await issuing;
            assert.ok(lease.expires_at > fake.serverSeconds());
            assert.equal(lease.verifierSubmitKeyProof.status, 'verified');
            return;
        }
        await assert.rejects(issuing);
        assert.equal(runtime.activeLease, null, 'no expired key installed or returned');
        assert.equal(runtime.snapshot().config.active_lease, null);
        assert.equal(fake.leasePosts.length, 1, 'no automatic second authorization');
        assert.ok(submissions.length <= 1);
        assert.equal(JSON.stringify(runtime.runtime.journal.prepared_request), JSON.stringify(fake.leasePosts[0].request),
            'the exact saved request remains for recovery');
        assert.ok(fake.serverSeconds() >= fake.leasePosts[0].serverSeconds + 600, 'the key really had expired');
    });
}

test('after a suspend, a cached key is neither reused nor checked out when the server clock cannot be resampled', async t => {
    const fake = world(t, { skewMs: -3 * HOUR });
    hostVerifier(t, 'verified');
    const runtime = serverTimeRuntime(BrowserWalletRuntime, fake, { funding, openrouter });
    const lease = await runtime.issueLease('chat', undefined, null, 1);
    fake.suspend(20 * 60_000);
    fake.timeEndpoint = 500;
    await assert.rejects(runtime.acquireEphemeralKey('chat', undefined, { spendingLimitUsd: 1 }), { code: 'server_time_unavailable' });
    runtime.ensureLease = async () => lease; // even if reuse were skipped, checkout fails closed
    await assert.rejects(runtime.acquireEphemeralKey('chat'), { code: 'lease_expired' });
    assert.equal(lease.inFlight, 0);
    assert.equal(fake.leasePosts.length, 1);
});

// Finding 3 on the pinned SDK: saved-request recovery and receipt installation
// depend only on the server's exact answers, not device time or /v2/time.
test('patched SDK recovers an aged saved request via exact /expire on a slow device while /v2/time fails', async t => {
    const fake = world(t, { skewMs: -3 * HOUR, timeEndpoint: 'network' });
    const runtime = serverTimeRuntime(BrowserWalletRuntime, fake, { funding, openrouter });
    const saved = savedJournal(fake, fake.serverSeconds() - 400);
    runtime.runtime = { ...runtime.runtime, journal: saved.journal };
    assert.equal(await runtime.recoverPendingLocked({ retireLostKey: true }), true);
    assert.equal(fake.expireCalls.length, 1);
    assert.equal(JSON.stringify(fake.expireCalls[0].request), saved.bytes);
    assert.equal(fake.timeRequests.length, 0);
    assert.equal(runtime.runtime.journal, null);
    await assert.rejects(runtime.prepareLeaseRequest(undefined, null, 1), { code: 'server_time_unavailable' },
        'new authorization stays strict');
});

test('patched SDK keeps a future-dated or unanswered saved journal intact when /v2/time fails', async t => {
    for (const [offset, fails] of [[600, false], [-400, true]]) {
        const fake = world(t, { skewMs: -3 * HOUR, timeEndpoint: 'network' });
        fake.expireFails = fails;
        const runtime = serverTimeRuntime(BrowserWalletRuntime, fake, { funding, openrouter });
        const saved = savedJournal(fake, fake.serverSeconds() + offset);
        runtime.runtime = { ...runtime.runtime, journal: saved.journal };
        if (fails) await assert.rejects(runtime.recoverUnacceptedNativeQuote(saved.request));
        else assert.equal(await runtime.recoverUnacceptedNativeQuote(saved.request), false);
        assert.equal(runtime.runtime.journal, saved.journal);
        assert.equal(JSON.stringify(saved.request), saved.bytes);
        assert.equal(runtime.commits.length, 0);
    }
});

test('patched SDK installs a signed receipt on a slow device while /v2/time fails, refusing a changed quote', async t => {
    const fake = world(t, { skewMs: -3 * HOUR, timeEndpoint: 'network' });
    const runtime = serverTimeRuntime(BrowserWalletRuntime, fake, { funding, openrouter });
    const saved = savedJournal(fake, fake.serverSeconds() - 30);
    runtime.runtime = { ...runtime.runtime, journal: saved.journal };
    fake.receipts = new Map([['saved-request', { response_payload: JSON.stringify({ billing_quote: { ...fake.quote(), answer: '1' } }) }]]);
    await assert.rejects(runtime.installRecoveredResponse('saved-request'), /changed the authorized/);
    assert.equal(runtime.runtime.journal, saved.journal);
    fake.receipts.set('saved-request', { response_payload: JSON.stringify({ billing_quote: fake.quote() }) });
    assert.equal(await runtime.installRecoveredResponse('saved-request'), true);
    assert.equal(fake.completed[0].journal, saved.journal);
    assert.equal(runtime.runtime.journal, null);
    assert.equal(fake.timeRequests.length, 0);
});

test('patched SDK never returns a cached ordinary key after a 20-minute suspend when /v2/time fails, without host callbacks', async t => {
    const fake = world(t, { skewMs: 3 * HOUR });
    fake.keySource = 'openrouter';
    fake.leaseExtras = null;
    configureBrowserSdk({ verifyProviderKey: null, assertProviderKey: null });
    const runtime = serverTimeRuntime(BrowserWalletRuntime, fake, { funding,
        openrouter: { inference_base: 'https://openrouter.ai/api/v1', require_oa_key_source: false } });
    const lease = await runtime.issueLease('chat', undefined, null, 1);
    const journal = runtime.runtime.journal;
    fake.suspend(20 * 60_000);
    fake.timeEndpoint = 'network';
    await assert.rejects(runtime.acquireEphemeralKey('chat', undefined, { spendingLimitUsd: 1 }), { code: 'server_time_unavailable' });
    assert.equal(lease.inFlight, 0);
    assert.equal(fake.leasePosts.length, 1, 'no replacement authorization');
    assert.equal(runtime.runtime.journal, journal);
    runtime.ensureLease = async () => lease; // checkout alone also fails closed
    await assert.rejects(runtime.acquireEphemeralKey('chat'), { code: 'lease_expired' });
    assert.equal(lease.inFlight, 0);
});
