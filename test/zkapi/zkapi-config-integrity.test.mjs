// Served-configuration integrity (chat/zkapi/versioning/configIntegrity.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { assertServedIdentity, verifyServedConfig } from '../../chat/zkapi/versioning/configIntegrity.mjs';
import { serializeConfig } from '../../chat/zkapi/versioning/registryModel.mjs';

const BASE = 'https://app.example/chat/';
const CONFIG = { deployment_manifest_url: 'https://svc.example/config.json', trusted_deployment: { deployment_id: 'd', chain_id: 1 } };
const BYTES = serializeConfig(CONFIG);
const SHA = createHash('sha256').update(BYTES).digest('hex');
const VERSION = { id: 'v2', assetBase: 'zkapi/v2c/', configSha256: SHA };

const serve = (body, { ok = true, status = 200 } = {}) => async (url, options) => {
    serve.last = { url, options };
    return { ok, status, arrayBuffer: async () => new TextEncoder().encode(body).buffer };
};

test('the served file hashing to the embedded digest is ok, fetched without cache or credentials', async () => {
    const fetchImpl = serve(BYTES);
    assert.equal(await verifyServedConfig(VERSION, { fetch: fetchImpl, baseURI: BASE }), 'ok');
    assert.equal(serve.last.url, 'https://app.example/chat/zkapi/v2c/browser-config.json');
    assert.equal(serve.last.options.cache, 'no-store');
    assert.equal(serve.last.options.credentials, 'omit');
    assert.ok(serve.last.options.signal, 'the request can be abandoned');
});

test('a transparent re-encoding is the same configuration; different content is a mismatch', async () => {
    const minified = JSON.stringify(CONFIG);
    const crlf = BYTES.replace(/\n/g, '\r\n');
    assert.equal(await verifyServedConfig(VERSION, { fetch: serve(minified), baseURI: BASE }), 'ok');
    assert.equal(await verifyServedConfig(VERSION, { fetch: serve(crlf), baseURI: BASE }), 'ok');
    const changed = serializeConfig({ ...CONFIG, trusted_deployment: { ...CONFIG.trusted_deployment, chain_id: 2 } });
    assert.equal(await verifyServedConfig(VERSION, { fetch: serve(changed), baseURI: BASE }), 'mismatch');
    const extra = serializeConfig({ ...CONFIG, extra: true });
    assert.equal(await verifyServedConfig(VERSION, { fetch: serve(extra), baseURI: BASE }), 'mismatch');
});

test('anything that is not a clear answer is unverified, never a block', async () => {
    const cases = {
        'a missing file': serve('', { ok: false, status: 404 }),
        'an error page': serve('<html>Service unavailable</html>'),
        'a JSON value that is not a configuration': serve('[1,2]'),
        'a network failure': async () => { throw new TypeError('Failed to fetch'); },
        'a body that fails to read': async () => ({ ok: true, arrayBuffer: async () => { throw new Error('reset'); } }),
        'no response': async () => undefined
    };
    for (const [label, fetchImpl] of Object.entries(cases)) {
        assert.equal(await verifyServedConfig(VERSION, { fetch: fetchImpl, baseURI: BASE }), 'unverified', label);
    }
});

test('a request that never answers is abandoned at the deadline', async () => {
    let aborted = false;
    const hung = (url, { signal }) => new Promise(() => { signal.addEventListener('abort', () => { aborted = true; }); });
    const started = Date.now();
    assert.equal(await verifyServedConfig(VERSION, { fetch: hung, baseURI: BASE, timeoutMs: 30 }), 'unverified');
    assert.ok(Date.now() - started < 1000);
    assert.equal(aborted, true);
});

test('a version without an asset base or an embedded digest cannot be verified', async () => {
    const fetchImpl = serve(BYTES);
    for (const version of [
        null, {}, { assetBase: 'zkapi/' }, { configSha256: SHA }, { ...VERSION, configSha256: 'abc' },
        { ...VERSION, configSha256: SHA.toUpperCase() }, { ...VERSION, assetBase: '' }
    ]) {
        assert.equal(await verifyServedConfig(version, { fetch: fetchImpl, baseURI: BASE }), 'unverified');
    }
    assert.equal(await verifyServedConfig(VERSION, { fetch: fetchImpl }), 'unverified', 'no base URL');
    assert.equal(await verifyServedConfig(VERSION, { fetch: null, baseURI: BASE }), 'unverified');
});

test('a hash function that fails is unverified', async () => {
    assert.equal(await verifyServedConfig(VERSION, {
        fetch: serve(BYTES), baseURI: BASE, digest: async () => { throw new Error('no subtle'); }
    }), 'unverified');
});

// ------------------------------------------------------------------ identity

const LOADED = { id: 'v2', deploymentId: 'deployment-v2', vault: '0xAbC0000000000000000000000000000000000001'.toLowerCase(), chainId: 11155111 };
const reached = (overrides = {}) => ({
    client: { config: { funding: { contract_address: LOADED.vault.toUpperCase().replace('0X', '0x'), chain_id: 11155111 } } },
    runtime: { manifest: { deployment_id: 'deployment-v2' } },
    version: LOADED,
    ...overrides
});

test('the deployment the SDK reached must be the loaded version', () => {
    assert.equal(assertServedIdentity(reached()), 'ok');
    assert.equal(assertServedIdentity(reached({ runtime: { manifest: { deployment_id: 'deployment-v1' } } })), 'mismatch');
    assert.equal(assertServedIdentity(reached({ runtime: { manifest: {} } })), 'mismatch');
    assert.equal(assertServedIdentity(reached({ runtime: {} })), 'mismatch');
    assert.equal(assertServedIdentity(reached({ client: { config: { funding: { contract_address: '0x1' } } } })), 'mismatch');
    assert.equal(assertServedIdentity(reached({ client: { config: null } })), 'mismatch');
    assert.equal(assertServedIdentity(reached({
        client: { config: { funding: { contract_address: LOADED.vault, chain_id: 1 } } }
    })), 'mismatch');
});

test('a missing chain id does not by itself mismatch; a bad version row always does', () => {
    assert.equal(assertServedIdentity(reached({ client: { config: { funding: { contract_address: LOADED.vault } } } })), 'ok');
    assert.equal(assertServedIdentity(reached({ version: { ...LOADED, vault: null } })), 'mismatch');
    assert.equal(assertServedIdentity(reached({ version: null })), 'mismatch');
    assert.equal(assertServedIdentity({}), 'mismatch');
    assert.equal(assertServedIdentity(), 'mismatch');
});
