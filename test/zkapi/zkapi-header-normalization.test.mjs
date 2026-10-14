// What the inference provider can see of a private request must not depend on
// which protocol version's SDK issued the key, and a closed deployment must be
// recognized from the key request's 410.
import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Replace only browser storage, network and wallet boundaries (as the model
// budget test does); the production API composition runs for real.
const values = new Map();
const storage = {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: key => values.delete(key)
};
globalThis.window = globalThis;
globalThis.location = { hostname: 'localhost', origin: 'https://chat.example', href: 'https://chat.example/', search: '' };
globalThis.localStorage = storage;
globalThis.sessionStorage = storage;
globalThis.addEventListener = () => {};
globalThis.dispatchEvent = () => {};
globalThis.document = {
    querySelector: () => null, getElementById: () => null, addEventListener() {},
    documentElement: { dataset: {}, classList: { contains: () => false } }
};
const request = result => {
    const value = {};
    queueMicrotask(() => { value.result = result; value.onsuccess?.({ target: value }); });
    return value;
};
const settings = { get: () => request(undefined), put: () => request(undefined), delete: () => request(undefined) };
globalThis.indexedDB = { open: () => request({ version: 4, close() {}, transaction: () => ({ objectStore: () => settings }) }) };
globalThis.zkapiWallet = new Proxy({ ABI: [] }, {
    get: (target, key) => key in target ? target[key] : (() => null)
});

const { ZkapiAPI, normalizeProviderHeaders } = await import('../../chat/zkapi/api.js');
const { default: zkapiClient } = await import('@openanonymity/zkapi-browser-sdk/client');

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtureClientFile = path.join(here, '../fixtures/zkapi-sdk-v2-fixture/sdk/services/zkapiClient.js');
const KEY = 'ephemeral-key-material';
const EXPECTED = {
    authorization: `Bearer ${KEY}`,
    'content-type': 'application/json',
    'http-referer': 'https://chat.example',
    'x-title': 'oa-chat'
};

// The two generations' real header sets (legacy: browserWalletRuntime.js
// acquireEphemeralKey; next: x-title is 'zkAPI').
const LEGACY_HEADERS = {
    authorization: `Bearer ${KEY}`, 'content-type': 'application/json',
    'http-referer': 'https://chat.example', 'x-title': 'oa-chat'
};
const NEXT_HEADERS = { ...LEGACY_HEADERS, 'x-title': 'zkAPI' };

function accessWith(headers, extra = {}) {
    return {
        mode: 'ephemeral-key', apiKey: KEY, baseUrl: 'https://provider.test/v1', spendingLimitUsd: 1,
        headers, release: () => {}, ...extra
    };
}

// Run one real title request and return what the provider transport saw.
async function providerSees(t, headers, extra) {
    t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ 'provider/cheap-mini': 1 }), {
        headers: { 'content-type': 'application/json' }
    }));
    t.mock.method(zkapiClient, 'acquireInferenceAccess', async () => accessWith(headers, extra));
    t.mock.method(zkapiClient, 'refresh', async () => {});
    const seen = [];
    const api = new ZkapiAPI({ modelCatalog: { getCachedModels: () => [{ id: 'provider/cheap-mini', name: 'Cheap' }] } });
    api.networkTransport = {
        async fetchWithRetryJson(url, init) {
            seen.push({ url, headers: init.headers });
            return { response: { ok: true, status: 200 }, data: { choices: [{ message: { content: 'Title' } }] } };
        }
    };
    await api.generateSessionTitle('hello', 'session-1', { modelId: 'provider/cheap-mini' });
    assert.equal(seen.length, 1);
    return seen[0];
}

test('the provider sees the same four headers whichever SDK generation issued the key', async t => {
    const legacy = await providerSees(t, LEGACY_HEADERS);
    const next = await providerSees(t, NEXT_HEADERS);
    assert.deepEqual(legacy.headers, EXPECTED);
    assert.deepEqual(next.headers, EXPECTED);
    assert.deepEqual(Object.keys(next.headers), ['authorization', 'content-type', 'http-referer', 'x-title']);
});

test('headers an SDK adds beyond the allowlist never reach the provider', async t => {
    const seen = await providerSees(t, {
        ...NEXT_HEADERS,
        'x-zkapi-version': '2',
        'x-forwarded-for': '203.0.113.9',
        cookie: 'session=1',
        'user-agent': 'custom',
        'x-request-id': 'abc'
    });
    assert.deepEqual(seen.headers, EXPECTED);
});

test('header names are matched case-insensitively and the output is the lowercase set', () => {
    const headers = normalizeProviderHeaders({ mode: 'ephemeral-key', headers: {
        Authorization: 'Bearer abc', 'Content-Type': 'application/json', 'HTTP-Referer': 'https://elsewhere.example',
        'X-Title': 'zkAPI', 'X-Extra': 'drop'
    } }, { origin: 'https://chat.example' });
    assert.deepEqual(headers, {
        authorization: 'Bearer abc', 'content-type': 'application/json',
        'http-referer': 'https://chat.example', 'x-title': 'oa-chat'
    });
});

test('the referer is this page, never a value an SDK chose; a missing page origin keeps the SDK value', () => {
    assert.equal(normalizeProviderHeaders(accessWith({ ...LEGACY_HEADERS, 'http-referer': 'https://other.example' }))['http-referer'],
        'https://chat.example');
    const saved = globalThis.location;
    try {
        delete globalThis.location;
        assert.equal(normalizeProviderHeaders(accessWith({ ...LEGACY_HEADERS, 'http-referer': 'https://sdk.example' }))['http-referer'],
            'https://sdk.example');
        assert.equal('http-referer' in normalizeProviderHeaders(accessWith({ authorization: 'Bearer x' })), false);
    } finally {
        globalThis.location = saved;
    }
});

test('the bearer credential comes from the access: its header, else its api key', () => {
    assert.equal(normalizeProviderHeaders(accessWith({ authorization: 'Bearer from-header' })).authorization, 'Bearer from-header');
    assert.equal(normalizeProviderHeaders(accessWith({})).authorization, `Bearer ${KEY}`);
    assert.equal('authorization' in normalizeProviderHeaders({ mode: 'ephemeral-key', headers: {} }), false);
    assert.deepEqual(normalizeProviderHeaders({ mode: 'ephemeral-key' }),
        { 'content-type': 'application/json', 'http-referer': 'https://chat.example', 'x-title': 'oa-chat' });
});

test('a daemon access goes to the local daemon, not the provider, and keeps its own headers', () => {
    const headers = { 'content-type': 'application/json', 'x-zkapi-session': 'session-1' };
    assert.deepEqual(normalizeProviderHeaders({ mode: 'daemon', headers }), headers);
});

test('everything else on the access survives the rebuild', async t => {
    t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ 'provider/cheap-mini': 1 })));
    let released = 0;
    t.mock.method(zkapiClient, 'acquireInferenceAccess', async () => accessWith(NEXT_HEADERS, {
        release: () => { released += 1; }, extraField: 'kept'
    }));
    const api = new ZkapiAPI({ modelCatalog: { getCachedModels: () => [] } });
    const access = await api.options.acquireRequestAccess('session-1', { modelId: 'provider/cheap-mini' });
    assert.equal(access.baseUrl, 'https://provider.test/v1');
    assert.equal(access.spendingLimitUsd, 1);
    assert.equal(access.extraField, 'kept');
    assert.deepEqual(access.headers, EXPECTED);
    access.release();
    assert.equal(released, 1);
});

test('the next SDK generation fixture, with an extra header, is normalized to the same four', async () => {
    const { default: fixtureClient } = await import(pathToFileURL(fixtureClientFile).href);
    fixtureClient.fixtureAccessHeaders = { 'x-zkapi-cohort': 'v2', 'x-title': 'zkAPI-override' };
    const access = await fixtureClient.acquireInferenceAccess('session-1', { spendingLimitUsd: 1 });
    // The fixture really emits the extra header and the generation's x-title.
    assert.equal(access.headers['x-zkapi-cohort'], 'v2');
    assert.equal(access.headers['x-title'], 'zkAPI-override');
    const headers = normalizeProviderHeaders(access);
    assert.deepEqual(headers, {
        authorization: `Bearer ${access.apiKey}`, 'content-type': 'application/json',
        'http-referer': 'https://chat.example', 'x-title': 'oa-chat'
    });
});

// -- Deployment retirement (410) ------------------------------------------------

async function keyRequestFailing(t, error, options) {
    t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ 'provider/cheap-mini': 1 })));
    t.mock.method(zkapiClient, 'acquireInferenceAccess', async () => { throw error; });
    const api = new ZkapiAPI({ modelCatalog: { getCachedModels: () => [] }, ...options });
    return api.options.acquireRequestAccess('session-1', { modelId: 'provider/cheap-mini' });
}

const gatewayError = (status, code, data = null) => Object.assign(new Error('gateway'), { status, code, data });

test('a 410 deployment_retiring from key issuance is reported once and still thrown', async t => {
    const signals = [];
    const error = gatewayError(410, 'deployment_retiring');
    await assert.rejects(keyRequestFailing(t, error, { onAdmissionClosed: code => signals.push(code) }), candidate => candidate === error);
    assert.deepEqual(signals, ['deployment_retiring']);
});

test('a non-retriable 410 is treated the same way, including a wrapped one', async t => {
    for (const error of [
        gatewayError(410, 'gone', { retriable: false }),
        gatewayError(410, undefined, { error: { code: 'whatever', retriable: false } }),
        Object.assign(new Error('wrapped'), { cause: gatewayError(410, 'deployment_retiring') })
    ]) {
        const signals = [];
        await assert.rejects(keyRequestFailing(t, error, { onAdmissionClosed: code => signals.push(code) }));
        assert.deepEqual(signals, ['deployment_retiring'], JSON.stringify(error.data));
        t.mock.restoreAll();
    }
});

test('other failures never signal retirement', async t => {
    for (const error of [
        gatewayError(503, 'deployment_retiring'),
        gatewayError(410, 'something_else', { retriable: true }),
        gatewayError(402, 'payment_required'),
        gatewayError(409, 'lease_pending'),
        new Error('plain'),
        Object.assign(new DOMException('aborted', 'AbortError'), { isCancelled: true })
    ]) {
        const signals = [];
        await assert.rejects(keyRequestFailing(t, error, { onAdmissionClosed: code => signals.push(code) }));
        assert.deepEqual(signals, []);
        t.mock.restoreAll();
    }
});

test('the default hook reaches the attached facade and is a no-op without one', async t => {
    const received = [];
    zkapiClient.oaVersioning = { noteSignal: code => received.push(code) };
    try {
        await assert.rejects(keyRequestFailing(t, gatewayError(410, 'deployment_retiring')));
        assert.deepEqual(received, ['deployment_retiring']);
        t.mock.restoreAll();
        delete zkapiClient.oaVersioning;
        await assert.rejects(keyRequestFailing(t, gatewayError(410, 'deployment_retiring')), /gateway/);
        zkapiClient.oaVersioning = { noteSignal() { throw new Error('facade bug'); } };
        t.mock.restoreAll();
        await assert.rejects(keyRequestFailing(t, gatewayError(410, 'deployment_retiring')), /gateway/);
    } finally {
        delete zkapiClient.oaVersioning;
    }
});
