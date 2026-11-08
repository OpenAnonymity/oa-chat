import test from 'node:test';
import assert from 'node:assert/strict';

// Native isolated test: the shared OpenRouter client and its 401 boundary with
// only the network transport stubbed, driven by a virtual clock.
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
const readiness = await import('../../chat/services/inference/keyReadiness.js');
const recovery = await import('../../chat/services/inference/openRouterCreditRecovery.js');
const { isRetryableInferenceError } = await import('../../chat/services/inference/reliability.js');

let keySequence = 0;
const nextKey = () => `sk-or-v1-fresh-test-key-${String(++keySequence).padStart(4, '0')}`;
const WALL_START = Date.UTC(2026, 10, 8, 2, 40, 44);
const answer = 'data: {"choices":[{"delta":{"content":"Accepted"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';

// Monotonic and wall time advance only when every actor is waiting on a
// virtual sleep; the earliest sleep then fires. Aborted sleeps are removed.
function virtualClock() {
    let t = 0;
    const timers = [];
    const abortError = () => new DOMException('Request aborted', 'AbortError');
    const clock = {
        now: () => t,
        wallNow: () => WALL_START + t,
        sleep(ms, signal) {
            return new Promise((resolve, reject) => {
                if (signal?.aborted) { reject(abortError()); return; }
                const timer = { at: t + ms, resolve };
                timers.push(timer);
                signal?.addEventListener('abort', () => {
                    const index = timers.indexOf(timer);
                    if (index >= 0) timers.splice(index, 1);
                    reject(abortError());
                }, { once: true });
            });
        },
        pendingTimers: () => timers.length,
        advance(ms) { t += ms; },
        async drive(promise) {
            let done = false;
            promise.then(() => { done = true; }, () => { done = true; });
            for (let idle = 0; !done && idle < 2000; ) {
                await new Promise(resolve => setImmediate(resolve));
                if (done) break;
                if (!timers.length) { idle++; continue; }
                idle = 0;
                timers.sort((a, b) => a.at - b.at);
                const next = timers.shift();
                t = Math.max(t, next.at);
                next.resolve();
            }
            return promise;
        }
    };
    return clock;
}

function rejectedBody(onCancel) {
    return new Response(new ReadableStream({
        start(controller) {
            controller.enqueue(new TextEncoder().encode('{"error":{"message":"User not found.","code":401}}'));
            controller.close();
        },
        cancel() { onCancel?.(); }
    }), { status: 401 });
}

function harness({ acceptAtMs = Infinity, clock = virtualClock(), stream = () => new Response(answer), key = nextKey() } = {}) {
    const requests = [];
    let cancelled = 0;
    const api = new OpenRouterAPI({
        inferenceTiming: { authClock: clock },
        networkTransport: {
            async fetchWithRetry(url, init) {
                requests.push({ at: clock.now(), url, authorization: init.headers.Authorization, body: init.body });
                return clock.now() >= acceptAtMs ? stream() : rejectedBody(() => { cancelled++; });
            }
        }
    });
    const send = (controller = null, chunk = () => {}) => api.streamCompletion(
        [{ role: 'user', content: 'Authentication diagnostic' }], 'anthropic/claude-sonnet-5.5:online', key,
        chunk, null, [], false, controller);
    const markFresh = ({ expiresInMs = 20 * 60_000, receivedAt = clock.now() } = {}) =>
        readiness.markFreshInferenceKey(key, { clock, receivedAt, expiresAt: WALL_START + clock.now() + expiresInMs });
    return { api, clock, key, requests, send, markFresh, cancelled: () => cancelled };
}
const times = h => h.requests.map(request => request.at);

test('a fresh verified key rejected for 30 s is then accepted with the identical request', async () => {
    const h = harness({ acceptAtMs: 30_000 });
    h.markFresh();
    const chunks = [];
    await h.clock.drive(h.send(null, text => { if (text) chunks.push(text); }));
    assert.deepEqual(chunks, ['Accepted']);
    assert.deepEqual(times(h), [0, 1000, 3000, 7000, 12000, 17000, 22000, 27000, 32000]);
    assert.deepEqual(new Set(h.requests.map(request => request.authorization)), new Set([`Bearer ${h.key}`]));
    assert.equal(new Set(h.requests.map(request => request.body)).size, 1, 'same model, messages and options');
    assert.equal(h.cancelled(), 8, 'every rejected body is cancelled');
    assert.equal(readiness.getFreshKeyReadiness(h.key, h.clock), null, 'acceptance closes the window');
});

test('a key rejected for the whole window never sends at or past its deadline', async () => {
    const h = harness();
    h.markFresh();
    const error = await h.clock.drive(h.send()).catch(value => value);
    assert.deepEqual(times(h), [0, 1000, 3000, 7000, 12000, 17000, 22000, 27000, 32000, 37000, 42000, 47000, 52000, 57000]);
    assert.equal(error.status, 401);
    assert.equal(error.inferenceAuthRejected, true);
    assert.equal(error.authRetryCount, times(h).length - 1);
    assert.equal(isRetryableInferenceError(error), false, 'the send loop adds no further resends');
});

test('the window is anchored at key receipt, before a slow verifier', async () => {
    const h = harness();
    // Received at 0, verified (and recorded) 50 s later.
    h.clock.advance(50_000);
    h.markFresh({ receivedAt: 0 });
    await h.clock.drive(h.send()).catch(() => {});
    assert.deepEqual(times(h), [50000, 51000, 53000, 57000]);
});

test('a window that already lapsed at receipt is never opened', async () => {
    const h = harness();
    h.clock.advance(70_000);
    h.markFresh({ receivedAt: 0 });
    assert.equal(readiness.getFreshKeyReadiness(h.key, h.clock), null);
    await h.clock.drive(h.send()).catch(() => {});
    assert.deepEqual(times(h), [70000, 71000, 73000, 77000], 'short policy');
});

test('a later manual retry only uses what is left of the window, then gets the short policy', async () => {
    const h = harness();
    h.markFresh();
    h.clock.advance(50_000);
    await h.clock.drive(h.send()).catch(() => {});
    assert.deepEqual(times(h), [50000, 51000, 53000, 57000]);
    h.requests.length = 0;
    h.clock.advance(70_000 - h.clock.now());
    assert.equal(readiness.getFreshKeyReadiness(h.key, h.clock), null, 'the window lapsed and was pruned');
    // A duplicate registration after the window never reopens it.
    h.markFresh();
    assert.equal(readiness.getFreshKeyReadiness(h.key, h.clock), null);
    await h.clock.drive(h.send()).catch(() => {});
    assert.equal(h.requests.length, 4, 'after the window: one request plus three short resends');
});

test('a duplicate registration inside the window does not extend it', async () => {
    const h = harness();
    h.markFresh();
    h.clock.advance(55_000);
    h.markFresh();
    await h.clock.drive(h.send()).catch(() => {});
    assert.deepEqual(times(h), [55000, 56000, 58000]);
});

test('unknown, old or reloaded keys keep the short 1/2/4 s policy', async () => {
    const h = harness();
    await h.clock.drive(h.send()).catch(() => {});
    assert.deepEqual(times(h), [0, 1000, 3000, 7000]);
});

test('resends never run past the key expiry', async () => {
    const h = harness();
    h.markFresh({ expiresInMs: 10_000 });
    await h.clock.drive(h.send()).catch(() => {});
    // The next pause (5 s from 7 s) would reach the 10 s expiry.
    assert.deepEqual(times(h), [0, 1000, 3000, 7000]);
    h.clock.advance(10_000);
    assert.equal(readiness.getFreshKeyReadiness(h.key, h.clock), null, 'an expired key leaves the registry');
});

test('a pause that overruns (suspended device) is rechecked before the resend and never switches to the short policy', async () => {
    const clock = virtualClock();
    // Every pause overshoots to five minutes, past both the window and the expiry.
    const overrun = { ...clock, sleep: async (ms, signal) => {
        if (signal?.aborted) throw new DOMException('Request aborted', 'AbortError');
        clock.advance(300_000);
    } };
    const h = harness({ clock: overrun });
    h.markFresh({ expiresInMs: 10_000 });
    const error = await h.send().catch(value => value);
    assert.deepEqual(times(h), [0], 'no resend after the overrun');
    assert.equal(error.status, 401);
    assert.equal(error.inferenceAuthRejected, true);
    assert.equal(error.authRetryCount, 0);
});

test('a rejection arriving after the window closed ends the call without a short-policy fallback', async () => {
    const clock = virtualClock();
    const h = harness({ clock });
    h.markFresh();
    clock.advance(59_000);
    // The request is slow: its 401 arrives two seconds later, past the deadline.
    const slow = new OpenRouterAPI({ inferenceTiming: { authClock: clock }, networkTransport: {
        async fetchWithRetry(url, init) {
            h.requests.push({ at: clock.now(), authorization: init.headers.Authorization });
            clock.advance(2_000);
            return rejectedBody();
        } } });
    await clock.drive(slow.streamCompletion([{ role: 'user', content: 'Hi' }], 'test/model', h.key, () => {})).catch(() => {});
    assert.deepEqual(times(h), [59000]);
    assert.equal(clock.now(), 61000, 'ends at once: no short-policy pause after the window');
});

test('a stalled monotonic clock (suspended tab) is still capped by the attempt ceiling', async () => {
    const clock = virtualClock();
    const stalled = { ...clock, sleep: () => Promise.resolve() };
    const h = harness({ clock: stalled });
    h.markFresh();
    await h.send().catch(() => {});
    assert.equal(h.requests.length, recovery.FRESH_KEY_MAX_AUTH_ATTEMPTS);
});

test('Stop during a readiness pause cancels the wait and sends nothing more', async () => {
    const h = harness();
    h.markFresh();
    const controller = new AbortController();
    const pending = h.send(controller);
    for (let i = 0; i < 20 && h.clock.pendingTimers() === 0; i++) await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.requests.length, 1);
    controller.abort();
    await assert.rejects(pending, error => error.isCancelled === true || error.name === 'AbortError');
    assert.equal(h.clock.pendingTimers(), 0, 'the aborted pause is removed');
    assert.equal(h.requests.length, 1);
});

test('real timers: Stop during the first fresh-key pause returns promptly', async () => {
    const key = nextKey();
    const requests = [];
    const api = new OpenRouterAPI({ networkTransport: { async fetchWithRetry(url, init) {
        requests.push(init.headers.Authorization);
        return rejectedBody();
    } } });
    readiness.markFreshInferenceKey(key, { expiresAt: Date.now() + 60_000 * 20 });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);
    const started = Date.now();
    await assert.rejects(api.streamCompletion([{ role: 'user', content: 'Hi' }], 'test/model', key, () => {},
        null, [], false, controller), error => error.isCancelled === true);
    assert.ok(Date.now() - started < 900);
    assert.equal(requests.length, 1);
});

test('output followed by an in-stream 401 is never replayed; the 200 closes readiness', async () => {
    const h = harness({ acceptAtMs: 0, stream: () => new Response(
        'data: {"choices":[{"delta":{"content":"Partial"}}]}\n\ndata: {"error":{"code":401,"message":"User not found."}}\n\n') });
    h.markFresh();
    const chunks = [];
    await assert.rejects(h.clock.drive(h.send(null, text => { if (text) chunks.push(text); })));
    assert.deepEqual(chunks, ['Partial']);
    assert.equal(h.requests.length, 1);
    assert.equal(readiness.getFreshKeyReadiness(h.key, h.clock), null);
});

test('concurrent callers on one fresh key share the same absolute deadline', async () => {
    const h = harness();
    h.markFresh();
    h.clock.advance(40_000);
    await h.clock.drive(Promise.allSettled([h.send(), h.send()]));
    // Each caller pauses 1, 2, 4, 5 s and neither sends at or past 60 s.
    assert.deepEqual(times(h).sort((a, b) => a - b), [40000, 40000, 41000, 41000, 43000, 43000, 47000, 47000, 52000, 52000, 57000, 57000]);
});

test('the registry is bounded and only explicit registrations open windows', () => {
    const clock = virtualClock();
    const keys = Array.from({ length: 40 }, () => nextKey());
    for (const key of keys) readiness.markFreshInferenceKey(key, { clock });
    assert.equal(readiness.getFreshKeyReadiness(keys[0], clock), null, 'oldest entries are evicted');
    assert.ok(readiness.getFreshKeyReadiness(keys[39], clock));
    assert.equal(readiness.getFreshKeyReadiness('short', clock), null);
    assert.equal(readiness.bearerToken({ authorization: `Bearer ${keys[1]}` }), keys[1]);
});

test('non-OpenRouter endpoints never get a readiness window', async () => {
    const clock = virtualClock();
    const key = nextKey();
    readiness.markFreshInferenceKey(key, { clock });
    let calls = 0;
    const final = await clock.drive(recovery.fetchWithOpenRouterCreditRecovery(async () => { calls++; return rejectedBody(); },
        'http://localhost/v1/chat/completions', { headers: { Authorization: `Bearer ${key}` } }, { authClock: clock }));
    assert.equal(final.status, 401);
    assert.equal(calls, 1);
});

// Two callers on one key (e.g. the chat and an inline QuickAsk), sharing a
// transport whose answers are scripted per request order.
function sharedKeyCallers(answers) {
    const clock = virtualClock();
    const key = nextKey();
    const requests = [];
    const api = new OpenRouterAPI({
        inferenceTiming: { authClock: clock },
        networkTransport: { async fetchWithRetry(url, init) {
            const caller = JSON.parse(init.body).messages.at(-1).content;
            requests.push({ caller, at: clock.now(), authorization: init.headers.Authorization });
            return answers(caller, requests.length, clock.now()) ? new Response(answer) : rejectedBody();
        } }
    });
    const call = (caller, controller = null) => api.streamCompletion([{ role: 'user', content: caller }],
        'test/model', key, () => {}, null, [], false, controller);
    readiness.markFreshInferenceKey(key, { clock, receivedAt: 0, expiresAt: WALL_START + 20 * 60_000 });
    const settle = async () => { for (let i = 0; i < 50; i++) await new Promise(resolve => setImmediate(resolve)); };
    return { clock, key, requests, call, settle };
}

test('a peer accepting the key while a caller pauses does not end that caller without resending', async () => {
    const s = sharedKeyCallers(caller => caller === 'B' || s.requests.filter(r => r.caller === 'A').length > 1);
    const a = s.call('A');
    await s.settle();
    assert.equal(s.clock.pendingTimers(), 1, 'A got 401 and is pausing');
    await s.call('B');
    assert.equal(readiness.getFreshKeyReadiness(s.key, s.clock), null, 'B closed the window for later calls');
    await s.clock.drive(a);
    assert.deepEqual(s.requests.map(r => `${r.caller}@${r.at}`), ['A@0', 'B@0', 'A@1000']);
    assert.equal(new Set(s.requests.map(r => r.authorization)).size, 1);
});

test('after a peer accepts, a still-rejected caller keeps its own fixed deadline and never switches to the short policy', async () => {
    const s = sharedKeyCallers(caller => caller === 'B');
    s.clock.advance(40_000);
    const a = s.call('A');
    await s.settle();
    await s.call('B');
    const error = await s.clock.drive(a).catch(value => value);
    assert.deepEqual(s.requests.filter(r => r.caller === 'A').map(r => r.at), [40000, 41000, 43000, 47000, 52000, 57000]);
    assert.equal(error.status, 401);
    assert.equal(error.inferenceAuthRejected, true);
});

test('cancelling one caller during its pause does not affect another caller on the same key', async () => {
    const s = sharedKeyCallers((caller, count, now) => now >= 30_000);
    const controllerB = new AbortController();
    const a = s.call('A');
    const b = s.call('B', controllerB);
    await s.settle();
    assert.equal(s.clock.pendingTimers(), 2);
    controllerB.abort();
    await assert.rejects(b, error => error.isCancelled === true || error.name === 'AbortError');
    await s.clock.drive(a);
    assert.deepEqual(s.requests.filter(r => r.caller === 'B').map(r => r.at), [0]);
    assert.deepEqual(s.requests.filter(r => r.caller === 'A').map(r => r.at), [0, 1000, 3000, 7000, 12000, 17000, 22000, 27000, 32000]);
    assert.equal(s.clock.pendingTimers(), 0, 'no dangling pauses');
});
