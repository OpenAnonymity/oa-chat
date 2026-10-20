const test = require('node:test');
const assert = require('node:assert/strict');

// 2026-10-15: Gemini 3.8 Flash, "The provider stopped the reply with an
// error", PROVIDER_CODE_504 in the System Panel. OpenRouter had answered 200,
// waited on Google, then sent its 504 as an event in the stream. These
// replay that event (and its siblings) through the real stream parser and
// the real resend rule, and count the requests that went out.
let API;
let resend;
test.before(async () => {
    globalThis.window = globalThis;
    window.location = { hostname: 'localhost', origin: 'http://localhost', search: '' };
    globalThis.localStorage = globalThis.sessionStorage = { getItem() { return null; }, setItem() {}, removeItem() {} };
    globalThis.document = { querySelector() { return null; }, getElementById() { return null; }, addEventListener() {},
        documentElement: { classList: { contains() { return false; } } } };
    API = (await import('../../chat/api.js')).OpenRouterAPI;
    resend = await import('../../chat/services/inference/resend.js');
});

const sse = events => new ReadableStream({
    start(controller) {
        for (const event of events) controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));
        controller.close();
    }
});
// What OpenRouter sends when the provider times out before answering.
const routerError = code => ({ id: 'gen-x', model: 'unknown', object: 'chat.completion.chunk',
    choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: 'error' }],
    error: { message: 'Provider returned error', code, metadata: { provider_name: 'Google' } } });
const answer = text => [
    { id: 'gen-ok', model: 'google/gemini-3.8-flash', choices: [{ index: 0, delta: { role: 'assistant', content: text } }] },
    { id: 'gen-ok', model: 'google/gemini-3.8-flash', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
    { usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 } }
];

// Each request gets the next scripted response: an SSE body, or an HTTP status.
function scripted(responses) {
    const requests = [];
    const api = new API({
        networkTransport: { async fetchWithRetry(...args) {
            requests.push(args);
            const next = responses[Math.min(requests.length - 1, responses.length - 1)];
            if (typeof next === 'number') {
                return { ok: false, status: next, body: sse([]), json: async () => ({ error: { message: 'busy' } }) };
            }
            return { ok: true, status: 200, body: sse(next) };
        } },
        inferenceTiming: { tailMs: 20, pollMs: 2, idleMs: 1000, outputMs: 1500, connectionMs: 1000, warningMs: 800 }
    });
    return { api, requests };
}

// The same wiring as streamCompletionWithRuntime / a Parallel lane.
async function send(api, { signal = null, clockStep = 1000 } = {}) {
    let shown = false;
    let text = '';
    let t = 0;
    const settled = [];
    const abort = new AbortController();
    signal?.addEventListener('abort', () => abort.abort(), { once: true });
    try {
        const result = await resend.runWithResend(() => {
            shown = false;
            t += clockStep;
            return api.streamCompletion([{ role: 'user', content: 'What if I jump in without that?' }],
                'google/gemini-3.8-flash', 'synthetic-key',
                chunk => { if (chunk) { shown = true; text += chunk; } }, () => {}, [], false, abort);
        }, { signal: abort.signal, outputSeen: () => shown, now: () => t, wait: async () => {}, onSettled: s => settled.push(s) });
        return { result, text, settled };
    } catch (error) {
        return { error, text, settled };
    }
}

test('the 504 from the screenshot is resent and the answer arrives', { timeout: 5000 }, async () => {
    const { api, requests } = scripted([[routerError(504)], answer('Yes, you can jump in.')]);
    const { result, text, error, settled } = await send(api);
    assert.equal(error, undefined, error?.message);
    assert.equal(requests.length, 2, 'one resend');
    assert.equal(text, 'Yes, you can jump in.');
    assert.equal(result.content ?? text, 'Yes, you can jump in.');
    assert.equal(settled[0].reason, 'recovered');
    assert.equal(settled[0].firstFailure.error.code, 504);
});

test('429, 502 and 503 in the stream are resent too', { timeout: 5000 }, async () => {
    for (const code of [429, 502, 503]) {
        const { api, requests } = scripted([[routerError(code)], answer('ok')]);
        const { error } = await send(api);
        assert.equal(error, undefined, `${code}: ${error?.message}`);
        assert.equal(requests.length, 2, `${code}`);
    }
});

test('a provider that keeps failing gets two requests, then the error', { timeout: 5000 }, async () => {
    const { api, requests } = scripted([[routerError(503)]]);
    const { error, settled } = await send(api);
    assert.equal(requests.length, 2);
    assert.equal(error.code, 503);
    assert.equal(error.resendHandled, true, 'the send loop will not retry it again');
    assert.equal(settled[0].reason, 'limit_reached');
});

test('a 400 inside the stream is not resent', { timeout: 5000 }, async () => {
    const { api, requests } = scripted([[routerError(400)], answer('never')]);
    const { error, settled } = await send(api);
    assert.equal(requests.length, 1);
    assert.equal(error.code, 400);
    assert.equal(settled[0].reason, 'not_transient');
});

test('an error after text keeps the partial answer and sends nothing more', { timeout: 5000 }, async () => {
    const { api, requests } = scripted([[
        { id: 'g', model: 'google/gemini-3.8-flash', choices: [{ index: 0, delta: { role: 'assistant', content: 'Here is my' } }] },
        routerError(429)
    ], answer('never')]);
    const { error, text, settled } = await send(api);
    assert.equal(requests.length, 1);
    assert.equal(text, 'Here is my');
    assert.equal(error.hasReceivedTokens, true);
    assert.equal(settled[0].reason, 'had_text');
});

test('an HTTP 503 before the stream opens is resent the same way', { timeout: 5000 }, async () => {
    const { api, requests } = scripted([503, answer('ok')]);
    const { error } = await send(api);
    assert.equal(error, undefined, error?.message);
    assert.equal(requests.length, 2);
});

test('a 504 that took longer than 15 s is shown at once', { timeout: 5000 }, async () => {
    const { api, requests } = scripted([[routerError(504)], answer('never')]);
    const { error, settled } = await send(api, { clockStep: 20000 });
    assert.equal(requests.length, 1);
    assert.equal(error.code, 504);
    assert.equal(settled[0].reason, 'too_slow');
});

// 2026-10-20: the real parser keeps a 429's Retry-After and upstream provider,
// and tells a transport's abort from the reply's own Stop.
function scriptedResponses(responses) {
    const requests = [];
    const api = new API({
        networkTransport: { async fetchWithRetry(...args) {
            requests.push(args);
            const next = responses[Math.min(requests.length - 1, responses.length - 1)];
            if (typeof next === 'function') return next(args);
            return next;
        } },
        inferenceTiming: { tailMs: 20, pollMs: 2, idleMs: 1000, outputMs: 1500, connectionMs: 1000, warningMs: 800 }
    });
    return { api, requests };
}

test('an HTTP 429 carries the wait it asked for and the upstream provider', { timeout: 5000 }, async () => {
    const errorBody = JSON.stringify({ error: { code: 429, message: 'Provider returned error', metadata: { provider_name: 'Google AI Studio' } } });
    const limited = { ok: false, status: 429,
        body: new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(errorBody)); c.close(); } }),
        headers: { get: name => ({ 'retry-after': '2', 'x-ratelimit-remaining': '0' })[name.toLowerCase()] ?? null },
        json: async () => ({ error: { code: 429, message: 'Provider returned error', metadata: { provider_name: 'Google AI Studio' } } }) };
    const { api, requests } = scriptedResponses([limited, { ok: true, status: 200, body: sse(answer('After the wait.')) }]);
    const waits = [];
    const abort = new AbortController();
    let shown = false;
    let first = null;
    const result = await resend.runWithResend(() => {
        shown = false;
        return api.streamCompletion([{ role: 'user', content: 'hi' }], 'google/gemini-3.8-flash', 'synthetic-key',
            chunk => { if (chunk) shown = true; }, () => {}, [], false, abort).catch(error => { first ??= error; throw error; });
    }, { signal: abort.signal, outputSeen: () => shown, now: () => 0, random: () => 0, wait: async ms => { waits.push(ms); } });
    assert.ok(result);
    assert.equal(requests.length, 2);
    assert.equal(first.retryAfterMs, 2000);
    assert.equal(first.upstreamProvider, 'Google AI Studio');
    assert.deepEqual(waits, [2000], 'waited the default 2 s, which covers the 2 s asked');
});

test('a transport abort before text is resent; the reply\'s own Stop is not', { timeout: 5000 }, async () => {
    const transportAbort = () => { throw new DOMException('The operation was aborted.', 'AbortError'); };
    const { api, requests } = scriptedResponses([transportAbort, { ok: true, status: 200, body: sse(answer('Reconnected.')) }]);
    const { result, text, error } = await send(api);
    assert.equal(error, undefined, error?.message);
    assert.equal(requests.length, 2);
    assert.match(text, /Reconnected/);
    assert.ok(result);

    const stopping = scriptedResponses([() => new Promise(() => {})]);
    const person = new AbortController();
    const pending = send(stopping.api, { signal: person.signal });
    setTimeout(() => person.abort(), 20);
    const stopped = await pending;
    assert.equal(stopped.error?.isCancelled, true);
    assert.notEqual(stopped.error?.isTransportAbort, true);
    assert.equal(stopping.requests.length, 1, 'a Stop is never resent');
});
