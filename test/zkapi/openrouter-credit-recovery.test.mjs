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

test('terminal failure preserves diagnostics while activity logs exclude provider text', async () => {
    const logs = [];
    window.networkLogger = { sanitizeHeaders: () => ({}), logRequest: entry => logs.push(entry) };
    const api = new OpenRouterAPI({ networkTransport: { fetchWithRetry: async () => fail() } });
    await assert.rejects(api.streamCompletion([], 'test/model', 'key', () => {}), error => {
        assert.equal(error.status, 402);
        assert.equal(error.code, 'INFERENCE_OUTPUT_BUDGET');
        assert.equal(error.data.error.message, message);
        return true;
    });
    assert.deepEqual(logs.at(-1).error, { status: 402, code: 'INFERENCE_OUTPUT_BUDGET' });
    assert.doesNotMatch(JSON.stringify(logs), /can only afford|Bearer key/);
    delete window.networkLogger;
});
