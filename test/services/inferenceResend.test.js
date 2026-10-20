// The resend rule (2026-10-15; production port 2026-10-20, without the
// staging-only inference telemetry). A provider's 504 inside an HTTP 200
// stream used to end the reply at once; it is now resent like an HTTP 503,
// at most once, only before anything was shown and only when it failed
// quickly.
import test from 'node:test';
import assert from 'node:assert/strict';
import { resendDecision, runWithResend, isTransientInferenceError, RESEND_POLICY } from '../../chat/services/inference/resend.js';
import { describeInferenceFailure, isTransientStatusFailure, transientFailureReply } from '../../chat/domain/inferenceFailure.js';

const providerError = (code, extra = {}) => Object.assign(new Error('Provider returned error'),
    { code, providerReported: true, isStreamError: true, retryable: false, hasReceivedTokens: false, ...extra });
const httpError = status => Object.assign(new Error(`HTTP ${status}`), { status });
const stop = () => Object.assign(new DOMException('Request stopped', 'AbortError'), { isCancelled: true });

test('what is resent: busy or unavailable providers, in the stream or over HTTP', () => {
    for (const code of [429, 502, 503, 504, '504', 'PROVIDER_CODE_504']) {
        assert.equal(isTransientInferenceError(providerError(code)), true, `provider ${code}`);
    }
    for (const status of [408, 429, 500, 502, 503, 504]) assert.equal(isTransientInferenceError(httpError(status)), true);
    assert.equal(isTransientInferenceError(Object.assign(new TypeError('Failed to fetch'))), true);
    // A resend would only repeat these.
    for (const code of [400, 401, 403, 500, 'PROVIDER_STREAM_ERROR', undefined]) {
        assert.equal(isTransientInferenceError(providerError(code)), false, `provider ${code}`);
    }
    for (const status of [400, 401, 402, 403, 404, 413]) assert.equal(isTransientInferenceError(httpError(status)), false);
    // OA's own watchdog and a malformed stream are not resent.
    assert.equal(isTransientInferenceError(Object.assign(new Error('silent'), { code: 'INFERENCE_IDLE_TIMEOUT', isStreamError: true, retryable: false })), false);
    assert.equal(isTransientInferenceError(new TypeError('x is not a function')), false, 'a code bug is not a network failure');
});

test('when it is resent: nothing shown, under the limit, within 15 s, not stopped', () => {
    const e = providerError(504);
    assert.equal(resendDecision(e, { resends: 0, elapsedMs: 4000 }), 'resend');
    assert.equal(resendDecision(e, { resends: 1, elapsedMs: 9000 }), 'limit_reached');
    assert.equal(resendDecision(e, { resends: 2, elapsedMs: 9000 }), 'limit_reached');
    assert.equal(resendDecision(e, { resends: 0, elapsedMs: 15000 }), 'too_slow');
    assert.equal(resendDecision(e, { resends: 0, elapsedMs: 1000, outputSeen: true }), 'had_text');
    assert.equal(resendDecision(providerError(504, { hasReceivedTokens: true }), {}), 'had_text');
    assert.equal(resendDecision(providerError(400), {}), 'not_transient');
    const stopped = new AbortController(); stopped.abort();
    assert.equal(resendDecision(e, { signal: stopped.signal }), 'stopped');
    assert.equal(RESEND_POLICY.maxResends, 1);
    assert.deepEqual([...RESEND_POLICY.waitsMs], [1000]);
});

function clock() {
    let t = 0;
    return { now: () => t, advance: ms => { t += ms; } };
}

test('a 504 before any text is resent once and the reply arrives', async () => {
    const c = clock();
    const waits = [];
    const settled = [];
    let calls = 0;
    const result = await runWithResend(async () => {
        calls += 1;
        c.advance(3000);
        if (calls === 1) throw providerError(504);
        return 'answer';
    }, { now: c.now, random: () => 0, wait: async ms => { waits.push(ms); c.advance(ms); }, onSettled: s => settled.push(s) });
    assert.equal(result, 'answer');
    assert.equal(calls, 2);
    assert.deepEqual(waits, [1000]);
    assert.equal(settled.length, 1);
    assert.equal(settled[0].outcome, 'answered');
    assert.equal(settled[0].reason, 'recovered');
    assert.equal(settled[0].attempts, 2);
    assert.equal(settled[0].firstFailure.afterMs, 3000);
    assert.equal(settled[0].totalMs, 7000);
});

test('never more than two requests, then the error, marked as already resent', async () => {
    const c = clock();
    let calls = 0;
    const settled = [];
    await assert.rejects(runWithResend(async () => { calls += 1; c.advance(500); throw providerError(503); },
        { now: c.now, wait: async ms => c.advance(ms), onSettled: s => settled.push(s) }), error => {
        assert.equal(error.resendHandled, true);
        return true;
    });
    assert.equal(calls, 2);
    assert.equal(settled[0].reason, 'limit_reached');
    assert.equal(settled[0].outcome, 'failed');
});

test('a slow failure is shown, not waited out again', async () => {
    const c = clock();
    let calls = 0;
    const settled = [];
    await assert.rejects(runWithResend(async () => { calls += 1; c.advance(22000); throw providerError(504); },
        { now: c.now, wait: async () => assert.fail('no wait'), onSettled: s => settled.push(s) }));
    assert.equal(calls, 1);
    assert.equal(settled[0].reason, 'too_slow');
    assert.equal(settled[0].firstFailure.afterMs, 22000);
});

test('a failure after text keeps the partial answer and is not resent', async () => {
    let calls = 0;
    let shown = false;
    const settled = [];
    await assert.rejects(runWithResend(async () => { calls += 1; shown = true; throw providerError(429); },
        { outputSeen: () => shown, wait: async () => assert.fail('no wait'), onSettled: s => settled.push(s) }));
    assert.equal(calls, 1);
    assert.equal(settled[0].reason, 'had_text');
    assert.equal(settled[0].firstFailure.hadText, true);
});

test('Stop during the wait ends it without another request', async () => {
    const controller = new AbortController();
    let calls = 0;
    const settled = [];
    await assert.rejects(runWithResend(async () => { calls += 1; throw providerError(502); }, {
        signal: controller.signal,
        onSettled: s => settled.push(s),
        policy: { maxResends: 2, waitsMs: [50, 50], windowMs: 15000 },
        onResend: () => setTimeout(() => controller.abort(), 5)
    }), error => {
        assert.equal(error.name, 'AbortError');
        assert.equal(error.isCancelled, true, 'the send loop reads it as the person\'s Stop');
        return true;
    });
    assert.equal(calls, 1);
    assert.equal(settled[0].outcome, 'stopped');
});

test('a reply stopped on its first request, or that just works, reports nothing', async () => {
    const settled = [];
    assert.equal(await runWithResend(async () => 'ok', { onSettled: s => settled.push(s) }), 'ok');
    await assert.rejects(runWithResend(async () => { throw stop(); }, { onSettled: s => settled.push(s) }));
    assert.deepEqual(settled, []);
});

test('reporting that throws changes nothing about the reply', async () => {
    const c = clock();
    let calls = 0;
    const result = await runWithResend(async () => { calls += 1; if (calls === 1) throw providerError(504); return 'answer'; }, {
        now: c.now, wait: async () => {},
        outputSeen: () => { throw new Error('broken probe'); },
        onSettled: () => { throw new Error('broken reporter'); },
        onResend: () => { throw new Error('broken hook'); }
    });
    assert.equal(result, 'answer');
});

test('the error line names the status, as a Parallel lane does', () => {
    assert.equal(describeInferenceFailure(providerError(504)), 'Gateway timeout (provider 504).');
    assert.equal(describeInferenceFailure(providerError('PROVIDER_CODE_429')), 'The model is temporarily busy. Please try again.');
    assert.equal(describeInferenceFailure(httpError(503)), 'Service unavailable (HTTP 503).');
    assert.equal(describeInferenceFailure(providerError(undefined)), 'The provider stopped the reply with an error.');
    assert.equal(describeInferenceFailure(providerError(599)), 'The provider reported an error (provider 599).');
    assert.equal(isTransientStatusFailure(httpError(400)), false);
    assert.equal(isTransientStatusFailure(providerError(504)), true);
});

test('the reply after spent resends: one labelled line, or the provider\'s own words when they matter', () => {
    assert.equal(transientFailureReply(providerError(504)), '**Error:** Gateway timeout (provider 504).');
    // Below a partial answer the template adds "Error:" itself.
    assert.equal(transientFailureReply(providerError(504), { hadPartial: true }), 'Gateway timeout (provider 504).');
    assert.equal(transientFailureReply(httpError(429)), '**Error:** The model is temporarily busy. Please try again.');
    assert.equal(transientFailureReply(providerError('PROVIDER_STREAM_ERROR')), '**Error:** The provider stopped the reply with an error.');
    // A context-length 400 keeps its message; key and credit errors keep their paths.
    for (const status of [400, 401, 402, 403]) assert.equal(transientFailureReply(httpError(status)), null);
    // A request that never reached a server reads as a closed connection (2026-10-20).
    assert.equal(transientFailureReply(new TypeError('Failed to fetch')), '**Error:** The connection closed before the model replied.');
    assert.doesNotMatch(transientFailureReply(providerError(504), { hadPartial: true }), /Error/);
});
