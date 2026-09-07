import test, { describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

const browserKeys = ['window', 'location', 'localStorage', 'sessionStorage', 'document'];
function installBrowser() {
    const original = new Map(browserKeys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    const location = { hostname: 'localhost', origin: 'http://localhost', search: '', href: 'http://localhost/' };
    const window = { location, addEventListener() {}, removeEventListener() {} };
    const values = {
        window, location,
        localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
        sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
        document: {
            querySelector: () => null, getElementById: () => null, addEventListener() {},
            documentElement: { classList: { contains: () => false } }
        }
    };
    for (const [key, value] of Object.entries(values)) {
        Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    }
    return () => {
        for (const [key, descriptor] of original) {
            if (descriptor) Object.defineProperty(globalThis, key, descriptor);
            else delete globalThis[key];
        }
    };
}

const restoreImportGlobals = installBrowser();
const { OpenRouterAPI, createInferenceService } = await import('../../chat/publicInferenceApi.js');
restoreImportGlobals();
describe('inference composition', () => {
let restoreTestGlobals;
beforeEach(() => { restoreTestGlobals = installBrowser(); });
afterEach(() => { restoreTestGlobals(); });

function transportWithResponse(result = { content: 'answer' }) {
    const calls = [];
    return {
        calls,
        async fetchWithRetryJson(url, init, config) {
            calls.push({ url, init, config });
            return { response: { ok: true, status: 200 }, data: { choices: [{ message: result }] } };
        }
    };
}

test('inference registries are isolated and preserve backend defaults', async () => {
    const calls = [];
    const backend = {
        id: 'composed', defaultModelId: 'composed/model', defaultModelName: 'Composed model',
        requestAccess: async options => { calls.push(options); return { token: 'opaque' }; }
    };
    const custom = createInferenceService({ backends: [backend], defaultBackendId: backend.id });
    const standard = createInferenceService();
    assert.equal(standard.getDefaultBackendId(), 'openrouter');
    assert.equal(custom.getDefaultBackendId(), 'composed');
    assert.equal(custom.getDefaultModelId(), 'composed/model');
    const session = { id: 'test' };
    assert.equal(custom.ensureSessionBackend(session), 'composed');
    await custom.requestAccess(session, { signal: 'test-signal' });
    assert.equal(calls[0].session, session);
    assert.equal(calls[0].signal, 'test-signal');
    assert.throws(() => createInferenceService({ backends: [], defaultBackendId: 'missing' }), /registered default/);
    assert.throws(() => createInferenceService({ backends: [backend, backend] }), /unique/);
});

test('ordinary OpenRouter requests retain direct provider URL and bearer key', async () => {
    const transport = transportWithResponse();
    const api = new OpenRouterAPI({ networkTransport: transport });
    const result = await api.sendCompletionStrict([{ role: 'user', content: 'hello' }], 'model', 'ephemeral');
    assert.equal(result.content, 'answer');
    assert.equal(transport.calls[0].url, 'https://openrouter.ai/api/v1/chat/completions');
    assert.equal(transport.calls[0].init.headers.Authorization, 'Bearer ephemeral');
    assert.equal(JSON.parse(transport.calls[0].init.body).max_tokens, undefined);
});

test('changing the default never retargets existing sessions or unknown paid backends', async () => {
    const calls = [];
    const backends = ['ticket', 'paid'].map(id => ({ id, requestAccess: async () => { calls.push(id); } }));
    const service = createInferenceService({ backends });
    const historical = {};
    service.ensureSessionBackend(historical);
    service.setDefaultBackendId('paid');
    const next = { inferenceBackend: service.getDefaultBackendId() };
    service.ensureSessionBackend(next);
    assert.equal(historical.inferenceBackend, 'ticket');
    assert.equal(next.inferenceBackend, 'paid');
    await service.requestAccess(historical);
    await service.requestAccess(next);
    assert.deepEqual(calls, ['ticket', 'paid']);
    assert.throws(() => service.setDefaultBackendId('unavailable'), /Unknown inference backend/);
    await assert.rejects(service.requestAccess({ inferenceBackend: 'unavailable' }), /Unknown inference backend/);
    assert.equal(service.getDefaultBackendId(), 'paid');
    assert.deepEqual(calls, ['ticket', 'paid']);
});

test('legacy access ownership is independent of the preferred new-chat backend', () => {
    const backends = ['ticket', 'paid'].map(id => ({ id, getAccessToken: session => session.apiKey }));
    const service = createInferenceService({ backends, defaultBackendId: 'paid', legacyBackendId: 'ticket',
        resolveLegacyBackendId: session => session.paidLease ? 'paid' : null });
    const legacy = { apiKey: 'old-provider-key' };
    assert.equal(service.getBackendForSession(legacy).id, 'ticket');
    assert.equal(legacy.inferenceBackend, 'ticket');
    service.setDefaultBackendId('ticket');
    assert.equal(service.getBackendForSession({ paidLease: 'bound' }).id, 'paid');
    assert.equal(service.getBackendForSession({ inferenceBackend: 'paid' }).id, 'paid');
    assert.equal(service.getBackendForSession(null).id, 'ticket');
});

test('title usage computes totals when the provider only reports input and output tokens', async () => {
    const updates = [];
    const api = new OpenRouterAPI({ networkTransport: {
        fetchWithRetryJson: async () => ({ response: { ok: true, status: 200 }, data: {
            choices: [{ message: { content: 'HTTPS explained' } }],
            usage: { prompt_tokens: 30, completion_tokens: 3, cost: 0.0001 }
        } })
    } });
    assert.equal(await api.generateSessionTitle('Explain HTTPS', 'key', { onUsage: usage => updates.push(usage) }), 'HTTPS explained');
    assert.equal(updates[0].totalTokens, 33);
    assert.equal(updates[0].cost, 0.0001);
});

test('concurrent request leases keep endpoints, headers, policies and releases isolated', async () => {
    const transport = transportWithResponse();
    const released = [];
    let policies = 0;
    const api = new OpenRouterAPI({
        networkTransport: transport,
        acquireRequestAccess: async binding => ({
            baseUrl: `https://${binding}.test/v1`,
            headers: { 'x-session': binding },
            proxyConfig: { bypassProxy: true },
            release: () => released.push(binding)
        }),
        prepareRequestBody: body => { policies += 1; return { ...body, max_tokens: 1234 }; }
    });
    await Promise.all([
        api.sendCompletionStrict([{ role: 'user', content: 'first' }], 'model', 'one'),
        api.generateSessionTitle('second', 'two', { modelId: 'title-model' })
    ]);
    assert.deepEqual(released.sort(), ['one', 'two']);
    assert.equal(policies, 2);
    for (const call of transport.calls) {
        assert.equal(call.url, `https://${call.init.headers['x-session']}.test/v1/chat/completions`);
        assert.equal(call.init.headers.Authorization, undefined);
        assert.equal(JSON.parse(call.init.body).max_tokens, 1234);
        assert.deepEqual(call.config.proxyConfig, { bypassProxy: true });
    }
    assert.equal(api.baseUrl, 'https://openrouter.ai/api/v1');
});

test('a late abort and request-policy failure both release acquired access', async () => {
    const originalError = console.error;
    console.error = () => {};
    try {
        for (const lateAbort of [true, false]) {
            const controller = new AbortController();
            const transport = transportWithResponse();
            let released = 0;
            const api = new OpenRouterAPI({
                networkTransport: transport,
                acquireRequestAccess: async () => {
                    if (lateAbort) controller.abort();
                    return { baseUrl: 'https://provider.test', headers: {}, release: () => { released += 1; } };
                },
                prepareRequestBody: () => { throw new Error('budget unavailable'); }
            });
            await assert.rejects(api.sendCompletionStrict([], 'model', 'binding', { signal: controller.signal }),
                lateAbort ? /aborted/ : /budget unavailable/);
            assert.equal(released, 1);
            assert.equal(transport.calls.length, 0);
        }
    } finally { console.error = originalError; }
});

test('empty strict completions reject and release instead of returning a simulated answer', async () => {
    let released = 0;
    const api = new OpenRouterAPI({
        networkTransport: transportWithResponse({}),
        acquireRequestAccess: async () => ({
            baseUrl: 'https://provider.test', headers: {}, release: () => { released += 1; }
        })
    });
    const originalError = console.error;
    console.error = () => {};
    try { await assert.rejects(api.sendCompletionStrict([], 'model', 'binding'), /Invalid completion/); }
    finally { console.error = originalError; }
    assert.equal(released, 1);
});

test('shared SSE awaits asynchronous deltas, stops at DONE and releases access last', async () => {
    let releaseFirst;
    const firstGate = new Promise(resolve => { releaseFirst = resolve; });
    let firstStarted;
    const started = new Promise(resolve => { firstStarted = resolve; });
    const events = [];
    let canceled = false;
    const body = new ReadableStream({
        start(controller) {
            controller.enqueue(new TextEncoder().encode(
                'data: {"choices":[{"delta":{"content":"first"}}]}\n' +
                'data: {"choices":[{"delta":{"content":" second"}}]}\n' +
                'data: [DONE]\n' +
                'data: {"choices":[{"delta":{"content":"must not appear"}}]}\n'
            ));
        },
        cancel() { canceled = true; }
    });
    const api = new OpenRouterAPI({
        networkTransport: { fetchWithRetry: async () => ({ ok: true, status: 200, body }) },
        acquireRequestAccess: async () => ({
            baseUrl: 'https://provider.test', headers: {}, release: () => events.push('release')
        })
    });
    const result = api.streamCompletion([], 'model', 'binding', async chunk => {
        if (chunk === 'first') { firstStarted(); await firstGate; }
        events.push(chunk);
    });
    await started;
    assert.deepEqual(events, []);
    releaseFirst();
    await result;
    assert.deepEqual(events, ['first', ' second', 'release']);
    assert.equal(canceled, true);
});

test('shared stream provider failures propagate and release without retrying partial output', async () => {
    let requests = 0;
    let released = 0;
    const events = [];
    const api = new OpenRouterAPI({
        networkTransport: {
            fetchWithRetry: async () => {
                requests += 1;
                return {
                    ok: true, status: 200,
                    body: new ReadableStream({ start(controller) {
                        controller.enqueue(new TextEncoder().encode(
                            'data: {"choices":[{"delta":{"content":"partial"}}]}\n' +
                            'data: {"error":{"message":"provider unavailable","code":"upstream"}}\n'
                        ));
                        controller.close();
                    } })
                };
            }
        },
        acquireRequestAccess: async () => ({
            baseUrl: 'https://provider.test', headers: {}, release: () => { released += 1; }
        })
    });
    const originalError = console.error;
    console.error = () => {};
    try {
        await assert.rejects(api.streamCompletion([], 'model', 'binding', chunk => events.push(chunk)),
            error => error.isStreamError === true && error.hasReceivedTokens === true);
    } finally { console.error = originalError; }
    assert.deepEqual(events, ['partial']);
    assert.equal(requests, 1);
    assert.equal(released, 1);
});
});
