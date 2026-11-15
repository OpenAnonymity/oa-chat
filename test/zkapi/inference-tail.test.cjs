const test = require('node:test');
const assert = require('node:assert/strict');
let API, waitForSignal, createInferenceWatchdog;
test.before(async () => {
    globalThis.window = globalThis;
    window.location = { hostname: 'localhost', origin: 'http://localhost', search: '' };
    globalThis.localStorage = globalThis.sessionStorage = { getItem() { return null; }, setItem() {}, removeItem() {} };
    globalThis.document = { querySelector() { return null; }, getElementById() { return null; }, addEventListener() {},
        documentElement: { classList: { contains() { return false; } } } };
    API = (await import('../../chat/api.js')).OpenRouterAPI;
    ({ waitForSignal, createInferenceWatchdog } = await import('../../chat/services/inference/reliability.js'));
});
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
const finish = { choices: [{ delta: { content: 'Answer' }, finish_reason: 'stop' }] };
function fixture(t, onUsage = () => {}, native = false) {
    let controller, cancelled = false;
    const abort = new AbortController(), gate = deferred(), entered = deferred();
    const body = new ReadableStream({ start(c) { controller = c; }, cancel() { cancelled = true; } });
    const events = []; let sequence = 0;
    if (native) window.oaAndroidInferenceNative = {
        startJob() { return JSON.stringify({ jobId: 'synthetic-job' }); },
        pollEvents() { return JSON.stringify({ events: events.splice(0) }); },
        cancelJob() { cancelled = true; return '{}'; }
    };
    const api = new API({ networkTransport: { async fetchWithRetry() { return { ok: true, status: 200, body }; } },
        inferenceTiming: { tailMs: 40, pollMs: 2, idleMs: 1000, outputMs: 1500, connectionMs: 1000, warningMs: 800 } });
    const chunks = [];
    const result = api.streamCompletion([{ role: 'user', content: 'Synthetic tail test' }], 'test/model', 'synthetic-key',
        chunk => chunks.push(chunk), usage => onUsage(usage, entered, gate), [], true, abort);
    // Observe rejection immediately, including Stop while a callback is held.
    const outcome = result.then(value => ({ value }), error => ({ error }));
    t.after(() => { gate.resolve(); abort.abort(); if (native) delete window.oaAndroidInferenceNative; try { controller.close(); } catch {} });
    return { chunks, result, outcome, gate, abort,
        entered: () => waitForSignal(entered.promise, t.signal),
        push(event) { assert.equal(cancelled, false, 'transport cancelled before queued event'); if (native) events.push({ sequence: ++sequence, type: 'sse-line', line: `data: ${JSON.stringify(event)}` });
            else controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`)); },
        close() { controller.close(); }, get cancelled() { return cancelled; } };
}
const holdFinalUsage = async (usage, entered, gate) => {
    if (usage.isStreaming === false) { entered.resolve(); await gate.promise; }
};
const holdMetadata = async (usage, entered, gate) => {
    if (usage.modelOnly) { entered.resolve(); await gate.promise; }
};

test('tail retains a queued provider error while a usage callback is slow', { timeout: 3000 }, async t => {
    const f = fixture(t, holdFinalUsage);
    f.push(finish);
    f.push({ usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } });
    await f.entered();
    f.push({ error: { message: 'provider failed within tail' } });
    await delay(80);
    assert.equal(f.cancelled, false, 'must not cancel during the callback');
    f.gate.resolve();
    const { error } = await f.outcome;
    assert.match(error?.message || '', /provider failed within tail/);
});

test('tail drains final usage, cost and citations behind a metadata callback', { timeout: 3000 }, async t => {
    const f = fixture(t, holdMetadata);
    f.push(finish); f.push({ model: 'test/routed', choices: [] }); await f.entered();
    f.push({ usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5, cost: 0.07 },
        annotations: [{ type: 'url_citation', url: 'https://example.com/source', title: 'Source', start_index: 0, end_index: 6 }] });
    await delay(80); f.gate.resolve();
    const { value, error } = await f.outcome;
    assert.ifError(error);
    assert.equal(value.totalTokens, 5); assert.equal(value.cost, 0.07);
    assert.equal(value.citations?.[0]?.url, 'https://example.com/source');
    assert.equal(f.cancelled, true, 'idle tail is closed after draining queued events');
});

test('queued new output resets an expired tail and waits for a new finish', { timeout: 3000 }, async t => {
    const f = fixture(t, holdMetadata);
    f.push(finish); f.push({ model: 'test/routed', choices: [] }); await f.entered();
    f.push({ choices: [{ delta: { content: ' resumed' } }] });
    await delay(80); f.gate.resolve(); await delay(80);
    assert.equal(f.cancelled, false);
    assert.deepEqual(f.chunks, ['Answer', ' resumed']);
    f.push({ choices: [{ delta: { content: ' end' }, finish_reason: 'stop' }] });
    const { value, error } = await f.outcome;
    assert.ifError(error); assert.equal(value.finishReason, 'stop');
    assert.deepEqual(f.chunks, ['Answer', ' resumed', ' end']);
});

test('EOF after resumed output cannot reuse an obsolete finish reason', { timeout: 3000 }, async t => {
    const f = fixture(t);
    f.push(finish); f.push({ choices: [{ delta: { content: ' incomplete continuation' } }] }); f.close();
    const { error } = await f.outcome;
    assert.equal(error?.code, 'INFERENCE_TRUNCATED');
});

test('Stop during slow tail bookkeeping still rejects promptly', { timeout: 3000 }, async t => {
    const f = fixture(t, holdMetadata);
    f.push(finish); f.push({ model: 'test/routed', choices: [] }); await f.entered();
    f.push({ usage: { total_tokens: 5 } }); f.abort.abort();
    const { error } = await waitForSignal(f.outcome, t.signal);
    assert.equal(error?.isCancelled, true);
    assert.equal(f.cancelled, true);
    f.gate.resolve();
});

test('tail can start at clock zero, reset, and arm again', { timeout: 3000 }, async t => {
    let now = 0;
    const guard = createInferenceWatchdog({ now: () => now, timing: { tailMs: 10, pollMs: 1 } });
    t.after(() => guard.dispose());
    guard.opened(); guard.finished();
    const firstTail = guard.settled;
    assert(firstTail); now = 11; await waitForSignal(firstTail, t.signal);
    guard.output(); assert.equal(guard.settled, null); assert.equal(guard.tailExpired(), false);
    guard.finished(); assert.notEqual(guard.settled, firstTail);
    now = 22; await waitForSignal(guard.settled, t.signal);
});

for (const queuedError of [false, true]) test(`native polling drains queued ${queuedError ? 'errors' : 'usage'} after a slow callback`, { timeout: 3000 }, async t => {
    const f = fixture(t, holdMetadata, true);
    f.push(finish); f.push({ model: 'test/routed', choices: [] }); await f.entered();
    f.push(queuedError ? { error: { message: 'native provider failed in tail' } }
        : { usage: { total_tokens: 5, prompt_tokens: 3, completion_tokens: 2, cost: 0.07 } });
    await delay(80); f.gate.resolve();
    const { value, error } = await f.outcome;
    if (queuedError) assert.match(error?.message || '', /native provider failed in tail/);
    else { assert.ifError(error); assert.equal(value.totalTokens, 5); assert.equal(value.cost, 0.07); }
    assert.equal(f.cancelled, true);
});
