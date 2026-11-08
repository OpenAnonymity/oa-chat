import test from 'node:test';
import assert from 'node:assert/strict';
import { ensureDirectCompletionLimit } from '@openanonymity/zkapi-browser-sdk/request-compat';

// Native isolated test: exercise the shared API with browser boundaries stubbed.
globalThis.window = globalThis;
globalThis.location = { hostname: 'localhost', origin: 'http://localhost', search: '' };
globalThis.localStorage = globalThis.sessionStorage = {
    getItem() { return null; }, setItem() {}, removeItem() {}
};
globalThis.addEventListener = () => {};
globalThis.document = {
    querySelector() { return null; }, getElementById() { return null; }, addEventListener() {},
    documentElement: { classList: { contains() { return false; } } }
};
const { OpenRouterAPI } = await import('../../chat/api.js');
const message = 'This request requires more credits, or fewer max_tokens. You requested up to 30000 tokens, but can only afford 20000.';
const fail = () => new Response(JSON.stringify({ error: { message } }), { status: 402 });

test('production stream recovers before opening, preserving request access and body policy', async () => {
    const bodies = [];
    let acquired = 0;
    let released = 0;
    let prepared = 0;
    let opened = 0;
    const chunks = [];
    const api = new OpenRouterAPI({
        acquireRequestAccess: async () => {
            acquired++;
            return { baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'test-key', headers: {}, release: () => { released++; } };
        },
        prepareRequestBody: body => { prepared++; return { ...body, max_tokens: 60000 }; },
        networkTransport: {
            async fetchWithRetry(url, init) {
                bodies.push(JSON.parse(init.body));
                if (bodies.length === 1) return fail();
                return new Response('data: {"choices":[{"delta":{"content":"Recovered answer"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
            }
        }
    });
    await api.streamCompletion([{ role: 'user', content: 'Hello' }], 'test/model', 'binding',
        text => { if (text) chunks.push(text); }, null, [], false, null, () => { opened++; }, null, false);
    assert.deepEqual(chunks, ['Recovered answer']);
    assert.equal(opened, 1);
    assert.equal(acquired, 1);
    assert.equal(released, 1);
    assert.equal(prepared, 1, 'product policy cannot restore the rejected cap on retry');
    assert.deepEqual(bodies.map(body => body.max_tokens), [30000, 18000]);
    assert.deepEqual(bodies[1].messages, bodies[0].messages);
});

test('all shared completion paths cap generation while keeping helper requests small', async () => {
    const bodies = [];
    const api = new OpenRouterAPI({ networkTransport: {
        async fetchWithRetry(url, init) {
            bodies.push(JSON.parse(init.body));
            return new Response('data: {"choices":[{"delta":{"content":"Answer"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
        },
        async fetchWithRetryJson(url, init) {
            bodies.push(JSON.parse(init.body));
            return { response: { ok: true, status: 200 }, data: { choices: [{ message: { content: 'Answer' } }] } };
        }
    } });
    await api.streamCompletion([], 'test/model', 'key', () => {});
    await api.sendCompletionStrict([], 'test/model', 'key');
    await api.generateSessionTitle('Question', 'key');
    assert.deepEqual(bodies.map(body => body.max_tokens), [30000, 30000, 24]);
    // Android native streaming also calls this shared preparation boundary.
    assert.equal(api.prepareRequestBody({ model: 'test/model' }, {}).max_tokens, 30000);
});

test('composed policy cannot increase a small caller limit and may reduce it further', () => {
    const raises = new OpenRouterAPI({ prepareRequestBody: body => ({ ...body, max_tokens: 60000 }) });
    assert.equal(raises.prepareRequestBody({ max_tokens: 24 }, {}).max_tokens, 24);
    const lowers = new OpenRouterAPI({ prepareRequestBody: body => ({ ...body, max_tokens: 512 }) });
    assert.equal(lowers.prepareRequestBody({}, {}).max_tokens, 512);
    const mutates = new OpenRouterAPI({ prepareRequestBody: body => { body.max_tokens = 60000; return body; } });
    const body = { max_tokens: 24 };
    assert.equal(mutates.prepareRequestBody(body, {}).max_tokens, 24);
    assert.equal(body.max_tokens, 24);
});

test('real private-payment adapter retains its affordability calculation before the ceiling', async () => {
    const bodies = [];
    const api = new OpenRouterAPI({
        prepareRequestBody: (body, { access, model }) => ensureDirectCompletionLimit(body, {
            spendingLimitUsd: access.spendingLimitUsd, model
        }),
        acquireRequestAccess: async () => ({ baseUrl: 'https://openrouter.ai/api/v1', headers: {}, spendingLimitUsd: 1 }),
        networkTransport: { async fetchWithRetryJson(url, init) {
            bodies.push(JSON.parse(init.body));
            return { response: { ok: true, status: 200 }, data: { choices: [{ message: { content: 'Answer' } }] } };
        } }
    });
    api.getModelBudgetMetadata = () => ({ pricing: { completion: '0.00005' } });
    await api.sendCompletionStrict([], 'test/model', 'binding');
    assert.equal(bodies[0].max_tokens, 18000, 'a $1 budget must not be raised to 30K');
    assert.equal(api.prepareRequestBody({}, { spendingLimitUsd: 5 }).max_tokens, 30000);
});

test('terminal failure preserves diagnostics while activity logs exclude provider text', async t => {
    const logs = [];
    const previousLogger = window.networkLogger;
    t.after(() => { window.networkLogger = previousLogger; });
    window.networkLogger = {
        sanitizeHeaders: () => ({}),
        keyRefForHeaders: () => '',
        logRequest: entry => logs.push(entry)
    };
    const api = new OpenRouterAPI({ networkTransport: { fetchWithRetry: async () => fail() } });
    await assert.rejects(api.streamCompletion([], 'test/model', 'key', () => {}), error => {
        assert.equal(error.status, 402);
        assert.equal(error.code, 'INFERENCE_OUTPUT_BUDGET');
        assert.equal(error.data.error.message, message);
        return true;
    });
    assert.deepEqual(logs.at(-1).error, { status: 402, code: 'INFERENCE_OUTPUT_BUDGET' });
    assert.doesNotMatch(JSON.stringify(logs), /can only afford|Bearer key/);
});

const { fetchWithOpenRouterCreditRecovery, INFERENCE_AUTH_RETRY_DELAYS_MS, getInferenceAuthRetryCount } =
    await import('../../chat/services/inference/openRouterCreditRecovery.js');
const OPENROUTER_COMPLETIONS = 'https://openrouter.ai/api/v1/chat/completions';
const unauthorized = () => new Response('{"error":{"code":401,"message":"User not found."}}', { status: 401 });

test('inference 401 resends use 1s, 2s and 4s pauses by default', () => {
    assert.deepEqual([...INFERENCE_AUTH_RETRY_DELAYS_MS], [1000, 2000, 4000]);
    assert.ok(Object.isFrozen(INFERENCE_AUTH_RETRY_DELAYS_MS));
});

test('a private-key 401 resends inside the same checked-out lease and never re-acquires or settles', async () => {
    let acquired = 0, released = 0;
    const headers = [];
    const api = new OpenRouterAPI({
        acquireRequestAccess: async () => {
            acquired++;
            return { baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'lease-key',
                headers: { authorization: 'Bearer lease-key' }, release: () => { released++; } };
        },
        inferenceTiming: { authRetryDelaysMs: [1, 1, 1] },
        networkTransport: { async fetchWithRetry(url, init) {
            assert.equal(released, 0, 'the lease stays checked out across resends');
            headers.push(init.headers.authorization);
            return headers.length < 4 ? unauthorized()
                : new Response('data: {"choices":[{"delta":{"content":"OK"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
        } }
    });
    const chunks = [];
    await api.streamCompletion([{ role: 'user', content: 'Hi' }], 'test/model', 'binding', text => { if (text) chunks.push(text); });
    assert.deepEqual(chunks, ['OK']);
    assert.deepEqual(headers, Array(4).fill('Bearer lease-key'));
    assert.equal(acquired, 1);
    assert.equal(released, 1);
});

test('a final inference 401 is tagged at the response boundary; access-issuance 401s are not', async () => {
    const api = new OpenRouterAPI({ inferenceTiming: { authRetryDelaysMs: [1, 1, 1] },
        networkTransport: { fetchWithRetry: async () => unauthorized() } });
    await assert.rejects(api.streamCompletion([], 'test/model', 'key', () => {}), error => {
        assert.equal(error.status, 401);
        assert.equal(error.inferenceAuthRejected, true);
        assert.equal(error.authRetryCount, 3);
        return true;
    });
    let fetched = 0;
    const issuing = new OpenRouterAPI({
        acquireRequestAccess: async () => { throw Object.assign(new Error('HTTP 401'), { name: 'BrowserWalletHttpError', status: 401 }); },
        networkTransport: { fetchWithRetry: async () => { fetched++; return unauthorized(); } }
    });
    await assert.rejects(issuing.streamCompletion([], 'test/model', 'key', () => {}), error => {
        assert.equal(error.status, 401);
        assert.equal(error.inferenceAuthRejected, undefined);
        return true;
    });
    assert.equal(fetched, 0);
});

test('only the OpenRouter completion endpoint resends a 401, and mixed 401/402 retries stay bounded', async () => {
    let calls = 0;
    const other = await fetchWithOpenRouterCreditRecovery(async () => { calls++; return unauthorized(); },
        'https://verifier.example/submit_key', {}, { authRetryDelaysMs: [1, 1, 1] });
    assert.equal(other.status, 401);
    assert.equal(calls, 1);
    assert.equal(getInferenceAuthRetryCount(other), 0);

    calls = 0;
    const busy = () => new Response(JSON.stringify({ error: { metadata: { limit_source: 'openrouter_in_flight_budget' } } }),
        { status: 402, headers: { 'Retry-After': '0' } });
    const final = await fetchWithOpenRouterCreditRecovery(async () => (++calls % 2 ? unauthorized() : busy()),
        OPENROUTER_COMPLETIONS, { body: '{}' }, { authRetryDelaysMs: [1, 1, 1] });
    // 401, 402, 401, 402, 401, 402: three auth resends, two settlement resends.
    assert.equal(calls, 6);
    assert.equal(final.status, 402);
});

test('discarded 401 bodies are cancelled; a stop during an in-flight resend sends nothing more', async () => {
    let cancelled = 0, calls = 0;
    const controller = new AbortController();
    const cancellable = () => new Response(new ReadableStream({ start() {}, cancel() { cancelled++; } }), { status: 401 });
    await assert.rejects(fetchWithOpenRouterCreditRecovery(async () => {
        calls++;
        if (calls === 2) controller.abort();
        return cancellable();
    }, OPENROUTER_COMPLETIONS, { body: '{}' }, { signal: controller.signal, authRetryDelaysMs: [1, 1, 1] }),
    { name: 'AbortError' });
    assert.equal(calls, 2);
    assert.equal(cancelled, 2);
});

test('a 401 from a non-OpenRouter inference base (e.g. a local daemon) is neither resent nor tagged', async () => {
    let calls = 0;
    const api = new OpenRouterAPI({
        acquireRequestAccess: async () => ({ mode: 'daemon', baseUrl: 'http://localhost/v1', headers: {} }),
        inferenceTiming: { authRetryDelaysMs: [1, 1, 1] },
        networkTransport: { fetchWithRetry: async () => { calls++; return unauthorized(); } }
    });
    await assert.rejects(api.streamCompletion([], 'test/model', 'key', () => {}), error => {
        assert.equal(error.status, 401);
        assert.equal(error.inferenceAuthRejected, undefined);
        return true;
    });
    assert.equal(calls, 1);
});

test('the transport never receives the auth retry schedule', async () => {
    let seen;
    await fetchWithOpenRouterCreditRecovery(async (url, init, config) => { seen = config; return new Response('ok'); },
        OPENROUTER_COMPLETIONS, {}, { signal: null, maxAttempts: 1, authRetryDelaysMs: [1] });
    assert.equal('authRetryDelaysMs' in seen, false);
    assert.equal(seen.maxAttempts, 1);
});
