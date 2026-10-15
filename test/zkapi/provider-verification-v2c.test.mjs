import test from 'node:test';
import assert from 'node:assert/strict';
import { configureBrowserSdk } from 'zkapi-sdk-v2c';
import { BrowserWalletRuntime } from 'zkapi-sdk-v2c/runtime';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import patch from '../../patches/zkapi-browser-sdk-v2c-provider-verification.mjs';
import { patchSdkVersion } from '../../scripts/patch-zkapi-sdk.mjs';

test('successor verification patch installs from pinned bytes, is repeatable, and rejects altered SDKs', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'oa-v2c-verification-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const installed = path.dirname(fileURLToPath(import.meta.resolve('zkapi-sdk-v2c/package.json')));
    const sdk = path.join(root, 'node_modules/zkapi-sdk-v2c');
    const source = `github:OpenAnonymity/zkapi#${patch.revision}`;
    const digest = value => createHash('sha256').update(value).digest('hex');
    await fs.mkdir(sdk, { recursive: true });
    await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ dependencies: { 'zkapi-sdk-v2c': source } }));
    await fs.copyFile(path.join(installed, 'package.json'), path.join(sdk, 'package.json'));
    for (const entry of patch.files) {
        let text = await fs.readFile(path.join(installed, entry.file), 'utf8');
        assert.equal(digest(text), entry.afterSha256);
        for (const replacement of [...entry.replacements].reverse()) text = text.replace(replacement.after, replacement.before);
        assert.equal(digest(text), entry.beforeSha256);
        await fs.mkdir(path.dirname(path.join(sdk, entry.file)), { recursive: true });
        await fs.writeFile(path.join(sdk, entry.file), text);
    }
    const args = { root, alias: 'zkapi-sdk-v2c', source, patches: [patch.name] };
    assert.equal(await patchSdkVersion(args), 2);
    assert.equal(await patchSdkVersion(args), 0);
    await fs.appendFile(path.join(sdk, patch.files[1].file), '\n// unreviewed bytes\n');
    await assert.rejects(patchSdkVersion(args), /Unexpected zkAPI SDK contents/);
});

globalThis.window = { location: { hostname: 'localhost' }, addEventListener() {}, dispatchEvent() {} };
globalThis.location = { origin: 'https://chat.example' };
const { createProviderKeyVerifier, assertPrivateLeaseVerification } = await import('../../chat/zkapi/services/providerVerification.mjs');
const { VERIFIER_URL } = await import('../../chat/config.js');

function fixture(t, options = {}) {
    configureBrowserSdk({ verifyProviderKey: null, assertProviderKey: null, ...options });
    t.after(() => configureBrowserSdk({ verifyProviderKey: null, assertProviderKey: null }));
    const now = Math.floor(Date.now() / 1000);
    const runtime = new BrowserWalletRuntime();
    const funding = { billing_asset: 'native_eth', billing_unit: 'gwei', native_asset_wei_per_unit: 1e9,
        contract_address: '0x' + '11'.repeat(20), native_price_feed_address: '0x' + '22'.repeat(20),
        chain_id: 11155111, native_price_feed_decimals: 8, native_price_max_age_seconds: 3600,
        rpc_url: 'https://rpc.example' };
    const quote = { asset: 'native_eth', units_per_eth: 1e9, chain_id: funding.chain_id,
        feed_address: funding.native_price_feed_address, decimals: 8, round_id: '1', answer: '100000000000',
        updated_at: now, expires_at: now + 3600 };
    runtime.config = { funding, openrouter: { inference_base: 'https://openrouter.ai/api/v1',
        verifier_url: VERIFIER_URL, require_oa_key_source: true } };
    const lease = { status: 'active', client_request_id: 'request', api_key: 'synthetic-private-key',
        expires_at: now + 300, settle_after: now + 300, spending_limit_usd: 1, billing_quote: quote,
        openrouter_api_base: runtime.config.openrouter.inference_base, key_source: 'oa_org',
        verification: { verifier_url: VERIFIER_URL, station_id: 'oa-station',
            station_signature: '12'.repeat(64), org_signature: '34'.repeat(64), key_valid_till: now + 300 } };
    const verify = (value = lease, signal) => runtime.verifyLease(value, 1_000_000, 'request', undefined, signal, quote);
    return { runtime, lease, verify };
}

test('successor SDK accepts the actual host startup options and retains its exit configuration', t => {
    const verifyProviderKey = () => {};
    const assertProviderKey = () => {};
    const configured = configureBrowserSdk({ verifyProviderKey, assertProviderKey, mode: 'browser',
        configUrl: 'https://chat.example/zkapi/v2c/browser-config.json',
        workerUrl: 'https://chat.example/zkapi/v2c/assets/zkapiWasmWorker.js',
        transport: async () => {}, requestTestnetPassword: async () => {},
        provingKeysBaseUrlOverride: 'https://keys.example/' });
    assert.equal(configured.verifyProviderKey, verifyProviderKey);
    assert.equal(configured.assertProviderKey, assertProviderKey);
    assert.equal(configured.provingKeysBaseUrlOverride, 'https://keys.example/');
    assert.throws(() => configureBrowserSdk({ verifyProviderKey: true }), /verification function/);
    assert.throws(() => configureBrowserSdk({ assertProviderKey: true }), /verification function/);
    t.after(() => configureBrowserSdk({ verifyProviderKey: null, assertProviderKey: null, provingKeysBaseUrlOverride: null }));
});

test('successor verifies once through host policy and exposes only safe proof in snapshots', async t => {
    let calls = 0;
    const { runtime, lease, verify } = fixture(t, { verifyProviderKey: createProviderKeyVerifier({
        async submitKey(data) { calls++; assert.equal(data.key, 'synthetic-private-key'); return { status: 'verified' }; }
    }) });
    runtime.remoteJson = () => assert.fail('must not duplicate host verification');
    await verify();
    assert.equal(calls, 1);
    runtime.activeLease = { ...lease, sessionId: 'chat' };
    const snapshot = runtime.snapshot().config.active_lease;
    assert.equal(snapshot.verifierSubmitKeyProof.status, 'verified');
    assert.ok(!JSON.stringify(snapshot).includes(lease.api_key));
    assert.ok(!JSON.stringify(snapshot).includes(lease.verification.org_signature));
    snapshot.verifierSubmitKeyProof.status = 'changed';
    assert.equal(lease.verifierSubmitKeyProof.status, 'verified');
});

for (const field of ['cap', 'quote', 'request', 'origin', 'source', 'signature', 'verifier', 'expiry']) {
    test(`successor refuses invalid ${field} before calling host policy`, async t => {
        const { lease, verify } = fixture(t, { verifyProviderKey: () => assert.fail('invalid lease reached policy') });
        if (field === 'cap') lease.spending_limit_usd = 2;
        if (field === 'quote') lease.billing_quote = { ...lease.billing_quote, answer: '2' };
        if (field === 'request') lease.client_request_id = 'wrong';
        if (field === 'origin') lease.openrouter_api_base = 'https://wrong.example';
        if (field === 'source') lease.key_source = 'other';
        if (field === 'signature') lease.verification.org_signature = '';
        if (field === 'verifier') lease.verification.verifier_url = 'https://wrong.example';
        if (field === 'expiry') lease.expires_at = 1;
        await assert.rejects(verify());
    });
}

test('successor default still rejects unverified responses without host authorization', async t => {
    const { runtime, verify } = fixture(t);
    runtime.remoteJson = async () => ({ status: 'verifier-unavailable', trustedStationFallback: {} });
    await assert.rejects(verify(), /rejected/);
});

test('successor honors cancellation after verification before publishing a proof', async t => {
    const controller = new AbortController();
    const { lease, verify } = fixture(t, { verifyProviderKey: async () => {
        controller.abort(); return { status: 'verified' };
    } });
    await assert.rejects(verify(lease, controller.signal), { name: 'AbortError' });
    assert.equal(lease.verifierSubmitKeyProof, undefined);
});

test('successor rechecks a cached key before checkout and does not reserve a banned key', async t => {
    let banned = false;
    const { runtime, lease, verify } = fixture(t, {
        verifyProviderKey: createProviderKeyVerifier({ submitKey: async () => ({ status: 'verified' }) }),
        assertProviderKey: info => assertPrivateLeaseVerification(info, { isStationBanned: () => banned })
    });
    await verify();
    lease.inFlight = 0;
    runtime.activeLease = lease;
    runtime.ensureLease = async () => lease;
    const access = await runtime.acquireEphemeralKey('chat');
    access.release();
    banned = true;
    await assert.rejects(runtime.acquireEphemeralKey('chat'), /no longer/);
    assert.equal(lease.inFlight, 0);
});
