import assert from 'node:assert/strict';
import test from 'node:test';

// Exercise production API composition; replace only browser storage, network,
// and wallet access boundaries. No protocol request or provider call is live.
const values = new Map();
const storage = {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: key => values.delete(key)
};
globalThis.window = globalThis;
globalThis.location = { hostname: 'localhost', origin: 'http://localhost', href: 'http://localhost/funding/', search: '' };
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

const { ZkapiAPI } = await import('../../chat/zkapi/api.js');
const { default: zkapiClient } = await import('@openanonymity/zkapi-browser-sdk/client');
const { createInferenceService } = await import('../../chat/publicInferenceApi.js');

test('title and response wait for live tiers and acquire the same captured chat budget', async t => {
    let releasePricing;
    const pricingGate = new Promise(resolve => { releasePricing = resolve; });
    const publicCalls = [];
    t.mock.method(globalThis, 'fetch', async (url, options) => {
        publicCalls.push({ url, options });
        await pricingGate;
        return new Response(JSON.stringify({ 'provider/premium': 25, 'provider/cheap-mini': 1 }), {
            headers: { 'content-type': 'application/json' }
        });
    });
    const acquired = [];
    const releases = [];
    t.mock.method(zkapiClient, 'acquireInferenceAccess', async (sessionId, options) => {
        acquired.push({ sessionId, options });
        return {
            baseUrl: 'https://provider.test/v1', headers: {}, spendingLimitUsd: options.spendingLimitUsd,
            release: () => releases.push(sessionId)
        };
    });
    t.mock.method(zkapiClient, 'refresh', async () => {});
    const providerCalls = [];
    const api = new ZkapiAPI({ modelCatalog: { getCachedModels: () => [
        { id: 'provider/premium', name: 'Premium Model' },
        { id: 'provider/cheap-mini', name: 'Cheap Model' }
    ] } });
    api.networkTransport = {
        async fetchWithRetryJson(url, init) {
            providerCalls.push({ url, body: JSON.parse(init.body) });
            return { response: { ok: true, status: 200 }, data: { choices: [{ message: { content: 'Example title' } }] } };
        },
        async fetchWithRetry(url, init) {
            providerCalls.push({ url, body: JSON.parse(init.body) });
            return new Response('data: {"choices":[{"delta":{"content":"Answer"},"finish_reason":"stop"}]}\ndata: [DONE]\n');
        }
    };
    const service = createInferenceService({ backends: [{
        id: 'zkapi', getAccessToken: session => session.id,
        getCachedModels: () => api.getCachedModels(),
        generateSessionTitle: (...args) => api.generateSessionTitle(...args),
        streamCompletion: (...args) => api.streamCompletion(...args)
    }] });
    const session = { id: 'captured-chat', model: 'Premium Model', reasoningEnabled: false };
    const titleOptions = { modelId: 'provider/cheap-mini' };
    const title = service.generateSessionTitle(session, 'Example prompt', titleOptions);
    const stream = service.streamCompletion([], 'provider/premium', session, () => {}, null,
        [], false, null, null, null, false);
    assert.equal(acquired.length, 0, 'cached/fallback display pricing cannot authorize a key');
    session.id = 'different-visible-chat';
    session.model = 'Cheap Model';
    session.reasoningEnabled = true;
    titleOptions.modelId = 'provider/different-helper';
    releasePricing();
    await Promise.all([title, stream]);

    assert.equal(publicCalls.length, 1, 'concurrent requests share public tier loading');
    assert.match(publicCalls[0].url, /\/chat\/model-tickets$/);
    assert.equal(publicCalls[0].options.credentials, 'omit');
    assert.equal(publicCalls[0].options.body, undefined);
    assert.deepEqual(acquired.map(access => [access.sessionId, access.options.spendingLimitUsd]), [
        ['captured-chat', 4.5], ['captured-chat', 4.5]
    ]);
    for (const { options } of acquired) {
        assert.equal(options.modelId, undefined, 'the wallet receives only the coarse budget');
        assert.equal(options.accessModelId, undefined);
        assert.equal(options.reasoningEnabled, undefined);
    }
    assert.deepEqual(providerCalls.map(call => call.body.model).sort(), ['provider/cheap-mini', 'provider/premium']);
    for (const call of providerCalls) {
        assert.equal(call.url, 'https://provider.test/v1/chat/completions');
        assert.equal(call.body.accessModelId, undefined);
        assert.equal(call.body.spendingLimitUsd, undefined);
    }
    assert.deepEqual(releases, ['captured-chat', 'captured-chat']);

    const canceled = new AbortController();
    canceled.abort();
    await assert.rejects(api.sendCompletionStrict([], 'provider/premium', 'canceled-chat', { signal: canceled.signal }),
        error => error.name === 'AbortError');
    assert.equal(acquired.length, 2, 'canceled tier readiness never reaches wallet acquisition');
});
