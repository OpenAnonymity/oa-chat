const test = require('node:test');
const assert = require('node:assert/strict');

// Prod, 2026-10-14: the router's error event carried `"model": "unknown"`, and
// the stream published it as the answering model, so a failed Parallel lane
// was labelled "unknown". An error event names no model; "unknown" never does.
let API;
test.before(async () => {
    globalThis.window = globalThis;
    window.location = { hostname: 'localhost', origin: 'http://localhost', search: '' };
    globalThis.localStorage = globalThis.sessionStorage = { getItem() { return null; }, setItem() {}, removeItem() {} };
    globalThis.document = { querySelector() { return null; }, getElementById() { return null; }, addEventListener() {},
        documentElement: { classList: { contains() { return false; } } } };
    API = (await import('../../chat/api.js')).OpenRouterAPI;
});

function fixture(t) {
    let controller;
    const abort = new AbortController();
    const body = new ReadableStream({ start(c) { controller = c; } });
    const api = new API({ networkTransport: { async fetchWithRetry() { return { ok: true, status: 200, body }; } },
        inferenceTiming: { tailMs: 40, pollMs: 2, idleMs: 1000, outputMs: 1500, connectionMs: 1000, warningMs: 800 } });
    const usages = [];
    const result = api.streamCompletion([{ role: 'user', content: 'best restaurants in palo alto' }], 'google/gemini-3.8-flash', 'synthetic-key',
        () => {}, usage => { usages.push(usage); }, [], true, abort);
    const outcome = result.then(value => ({ value }), error => ({ error }));
    t.after(() => { abort.abort(); try { controller.close(); } catch {} });
    return {
        usages, outcome,
        push(event) { controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`)); },
        close() { controller.close(); }
    };
}

const reportedModels = usages => usages.filter(usage => usage.modelOnly).map(usage => usage.model);

test('a router error event publishes no model and fails the stream with its numeric code', { timeout: 3000 }, async t => {
    const f = fixture(t);
    // What the router sends when no provider took the request: HTTP 200, one
    // event, model "unknown", a numeric HTTP-style code.
    f.push({
        id: 'gen-1', model: 'unknown', object: 'chat.completion.chunk',
        choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: 'error' }],
        error: { message: 'Provider returned error', code: 502, metadata: { provider_name: 'Google' } }
    });
    const { error } = await f.outcome;
    assert.deepEqual(reportedModels(f.usages), [], 'the error event names no answering model');
    assert.equal(error?.code, 502, 'the numeric code travels with the error');
    assert.equal(error?.providerReported, true);
    assert.match(error?.message || '', /Provider returned error/);
});

test('"unknown" on a role-only event is ignored; a concrete routed id is still published', { timeout: 3000 }, async t => {
    const f = fixture(t);
    f.push({ id: 'gen-2', model: 'unknown', choices: [{ index: 0, delta: { role: 'assistant' } }] });
    f.push({ id: 'gen-2', model: 'google/gemini-3.8-flash-routed', choices: [{ index: 0, delta: { role: 'assistant' } }] });
    f.push({ id: 'gen-2', model: 'google/gemini-3.8-flash-routed', choices: [{ index: 0, delta: { content: 'Evvia.' }, finish_reason: 'stop' }] });
    f.push({ usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } });
    f.close();
    const { value, error } = await f.outcome;
    assert.equal(error, undefined, error?.message);
    assert.deepEqual(reportedModels(f.usages), ['google/gemini-3.8-flash-routed']);
    assert.equal(value?.model, 'google/gemini-3.8-flash-routed');
});

test('a model named on an error event after output does not relabel the partial answer', { timeout: 3000 }, async t => {
    const f = fixture(t);
    f.push({ id: 'gen-3', model: 'google/gemini-3.8-flash', choices: [{ index: 0, delta: { role: 'assistant', content: 'Here is my' } }] });
    f.push({ id: 'gen-3', model: 'unknown', choices: [{ index: 0, delta: { content: '' }, finish_reason: 'error' }],
        error: { message: 'Provider returned error', code: 429 } });
    const { error } = await f.outcome;
    assert.deepEqual(reportedModels(f.usages), ['google/gemini-3.8-flash']);
    assert.equal(error?.code, 429);
    assert.equal(error?.hasReceivedTokens, true);
});
