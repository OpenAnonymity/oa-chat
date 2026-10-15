import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchRetryJson } from '../../chat/services/fetchRetry.js';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const bounded = promise => Promise.race([promise, delay(500).then(() => { throw new Error('Still stuck after deadline'); })]);

test('a header stall releases the caller without replaying an ambiguous request, and discards a late response', async () => {
    let calls = 0, finish, cancelled = false;
    const pending = fetchRetryJson('https://org.example/key', { method: 'POST' }, {
        timeoutMs: 20, maxAttempts: 3, context: 'Key fetch',
        fetchFn: () => { calls++; return new Promise(resolve => { finish = resolve; }); }
    });
    await assert.rejects(bounded(pending), error => error.name === 'TimeoutError' && error.isRequestTimeout);
    assert.equal(calls, 1);
    finish(new Response(new ReadableStream({ cancel() { cancelled = true; } })));
    await delay(0);
    assert.equal(cancelled, true);
});

test('Stop via RequestInit aborts a transport that ignores its signal before headers', async () => {
    const controller = new AbortController();
    const pending = fetchRetryJson('https://org.example/key', { signal: controller.signal }, {
        timeoutMs: 5000, fetchFn: () => new Promise(() => {})
    });
    controller.abort();
    await assert.rejects(bounded(pending), error => error.name === 'AbortError' && error.isUserAbort);
});

test('a mid-body timeout cancels the owned stream reader and releases its lock', async () => {
    let cancelled = false;
    const response = new Response(new ReadableStream({
        start(controller) { controller.enqueue(new TextEncoder().encode('{"pending":')); },
        cancel() { cancelled = true; return new Promise(() => {}); }
    }));
    await assert.rejects(bounded(fetchRetryJson('https://org.example/key', {}, {
        timeoutMs: 20, fetchFn: async () => response
    })), error => error.isBodyTimeout);
    assert.equal(cancelled, true);
    assert.equal(response.body.locked, false);
});

test('Stop interrupts Retry-After without starting another attempt', async () => {
    const controller = new AbortController();
    let calls = 0;
    const pending = fetchRetryJson('https://org.example/key', {}, {
        signal: controller.signal, timeoutMs: 5000,
        fetchFn: async () => { calls++; return new Response('', { status: 429, headers: { 'Retry-After': '5' } }); }
    });
    await delay(5);
    controller.abort();
    await assert.rejects(bounded(pending), error => error.name === 'AbortError' && error.isUserAbort);
    assert.equal(calls, 1);
});

test('owned stream decoding preserves a split UTF-8 character', async () => {
    const bytes = new TextEncoder().encode('{"text":"✓"}');
    const response = new Response(new ReadableStream({ start(controller) {
        controller.enqueue(bytes.slice(0, 10)); controller.enqueue(bytes.slice(10)); controller.close();
    } }));
    const { data } = await fetchRetryJson('https://org.example/key', {}, { fetchFn: async () => response });
    assert.deepEqual(data, { text: '✓' });
    assert.equal(response.body.locked, false);
});

 test('a raw response retains caller cancellation after its header deadline ends', async () => {
    const { fetchRetry } = await import('../../chat/services/fetchRetry.js');
    const controller = new AbortController();
    let deliveredSignal;
    await fetchRetry('https://org.example/stream', {}, {
        signal: controller.signal, timeoutMs: 10,
        fetchFn: async (_, init) => { deliveredSignal = init.signal; return new Response('ok'); }
    });
    await delay(20);
    assert.equal(deliveredSignal.aborted, false);
    controller.abort();
    assert.equal(deliveredSignal.aborted, true);
});

test('an abandoned operation does not retain its abort listener', async () => {
    const { waitForSignal } = await import('../../chat/services/inference/reliability.js');
    const controller = new AbortController();
    let removes = 0;
    const remove = controller.signal.removeEventListener.bind(controller.signal);
    controller.signal.removeEventListener = (...args) => { removes++; remove(...args); };
    const pending = waitForSignal(new Promise(() => {}), controller.signal);
    controller.abort();
    await assert.rejects(pending, { name: 'AbortError' });
    assert.equal(removes, 1);
});
