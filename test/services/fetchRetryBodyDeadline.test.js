import test from 'node:test';
import assert from 'node:assert/strict';

const { fetchRetry, fetchRetryJson, readBodyTextWithDeadline } = await import('../../chat/services/fetchRetry.js');

// A fetch whose headers arrive at once but whose body never finishes. The
// `honorsSignal` flavour behaves like native fetch (the body read rejects when
// the request signal aborts); the other flavour behaves like a transport that
// ignores the signal after headers, which is what the relay path looks like.
function stalledFetch({ honorsSignal }) {
    const calls = [];
    const fetchFn = async (url, init) => {
        calls.push({ url, init });
        const signal = init?.signal;
        let cancelled = false;
        const body = {
            cancel: async () => { cancelled = true; }
        };
        const response = {
            ok: true,
            status: 200,
            headers: new Headers({ 'content-type': 'application/json' }),
            body,
            text: () => new Promise((resolve, reject) => {
                if (!honorsSignal) return; // never settles
                const fail = () => {
                    const error = new Error('The operation was aborted');
                    error.name = 'AbortError';
                    reject(error);
                };
                if (signal?.aborted) fail();
                else signal?.addEventListener('abort', fail, { once: true });
            }),
            wasCancelled: () => cancelled
        };
        return response;
    };
    return { fetchFn, calls };
}

for (const honorsSignal of [true, false]) {
    test(`fetchRetryJson gives up on a stalled body (transport honours signal: ${honorsSignal})`, async () => {
        const { fetchFn, calls } = stalledFetch({ honorsSignal });
        const started = Date.now();
        await assert.rejects(
            fetchRetryJson('https://org.example/api/request_key', { method: 'POST' }, {
                fetchFn, timeoutMs: 40, maxAttempts: 3, context: 'Org API key'
            }),
            error => {
                assert.equal(error.name, 'TimeoutError');
                assert.equal(error.isBodyTimeout, true);
                assert.match(error.message, /response body timed out/);
                return true;
            }
        );
        assert.ok(Date.now() - started < 1000, 'returned promptly');
        assert.equal(calls.length, 1, 'a body stall is not retried (the server may already have acted)');
    });
}

test('a user abort mid-body is reported as a user abort, not a timeout', async () => {
    const { fetchFn } = stalledFetch({ honorsSignal: false });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);
    await assert.rejects(
        fetchRetryJson('https://org.example/x', {}, { fetchFn, timeoutMs: 5000, maxAttempts: 1, signal: controller.signal }),
        error => error.name === 'AbortError' && error.isUserAbort === true
    );
});

test('a body that completes in time still parses and clears the deadline', async () => {
    let released = false;
    const fetchFn = async () => ({
        ok: true, status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        text: async () => '{"hello":"world"}'
    });
    const { data } = await fetchRetryJson('https://org.example/x', {}, { fetchFn, timeoutMs: 50 });
    assert.deepEqual(data, { hello: 'world' });
    // Wait past the deadline: nothing should fire afterwards.
    await new Promise(resolve => setTimeout(resolve, 80));
    released = true;
    assert.ok(released);
});

test('fetchRetry (raw response) keeps its old contract: the deadline ends at headers', async () => {
    const { fetchFn } = stalledFetch({ honorsSignal: true });
    const response = await fetchRetry('https://org.example/stream', {}, { fetchFn, timeoutMs: 30 });
    assert.equal(response.status, 200);
    // The signal is not aborted after the deadline, so a streaming caller can
    // keep reading. (Streams manage their own watchdogs.)
    await new Promise(resolve => setTimeout(resolve, 60));
    assert.equal(fetchFn.aborted, undefined);
});

test('readBodyTextWithDeadline cancels the body when the signal aborts', async () => {
    const controller = new AbortController();
    let cancelled = false;
    const response = {
        body: { cancel: async () => { cancelled = true; } },
        text: () => new Promise(() => {})
    };
    setTimeout(() => controller.abort(), 10);
    await assert.rejects(readBodyTextWithDeadline(response, controller.signal, { context: 'Test', timeoutMs: 10 }), /timed out/);
    assert.equal(cancelled, true);
});
