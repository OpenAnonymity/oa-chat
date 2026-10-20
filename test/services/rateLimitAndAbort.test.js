// 429s wait as long as the provider asks (never less), stretched by jitter
// and capped; an abort from the transport is a failure that is resent before
// text, while the reply's own Stop never is (2026-10-20).
import test from 'node:test';
import assert from 'node:assert/strict';
import { resendDecision, runWithResend, baseResendWait, jitteredWait, isStopError, RESEND_POLICY }
    from '../../chat/services/inference/resend.js';
import { parseRetryAfterMs, rateLimitDetails, describeInferenceFailure, transientFailureReply }
    from '../../chat/domain/inferenceFailure.js';
import { abortOrigin, isTransportAbort, accessFailureText } from '../../chat/domain/abortOrigin.js';
import { isFailureReply, failureReplyText } from '../../chat/domain/replyFailure.js';

const http429 = (retryAfterMs) => Object.assign(new Error('Provider returned error'), { status: 429,
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }) });
const headers = values => ({ get: name => values[name.toLowerCase()] ?? null });

test('Retry-After is read as seconds or an HTTP date', () => {
    assert.equal(parseRetryAfterMs('2'), 2000);
    assert.equal(parseRetryAfterMs('1.5'), 1500);
    assert.equal(parseRetryAfterMs(new Date(10_000).toUTCString(), 4_000), 6000);
    assert.equal(parseRetryAfterMs(new Date(1_000).toUTCString(), 4_000), 0, 'a date in the past means now');
    assert.equal(parseRetryAfterMs(null), null);
    assert.equal(parseRetryAfterMs('soon'), null);
});

test('a 429 keeps the wait it asked for, its rate-limit figures and the upstream provider', () => {
    const details = rateLimitDetails(headers({ 'retry-after': '7', 'x-ratelimit-limit': '20', 'x-ratelimit-remaining': '0',
        'x-ratelimit-reset': String(Date.now() + 60_000) }), { code: 429, metadata: { provider_name: 'Google AI Studio', raw: 'quota' } });
    assert.equal(details.retryAfterMs, 7000);
    assert.equal(details.rateLimit.limit, '20');
    assert.equal(details.upstreamProvider, 'Google AI Studio');
    const fromReset = rateLimitDetails(headers({ 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Date.now() + 4_000) }), null);
    assert.ok(fromReset.retryAfterMs > 3000 && fromReset.retryAfterMs <= 4000, 'reset time stands in for Retry-After');
    assert.deepEqual(rateLimitDetails(headers({}), {}), {}, 'nothing invented when nothing was sent');
    assert.deepEqual(rateLimitDetails(null, null), {});
    const noRemaining = rateLimitDetails(headers({ 'x-ratelimit-limit': '20', 'x-ratelimit-reset': String(Date.now() + 4_000) }), null);
    assert.equal(noRemaining.retryAfterMs, undefined, 'a missing remaining count is not read as zero');
});

test('a 429 waits at least the default schedule and never less than Retry-After', () => {
    assert.equal(baseResendWait(http429(), 0), 2000);
    assert.equal(baseResendWait(http429(), 1), 2000);
    assert.equal(baseResendWait(http429(500), 0), 2000, 'a short Retry-After does not shorten our wait');
    assert.equal(baseResendWait(http429(8000), 0), 8000);
    assert.equal(baseResendWait(Object.assign(new Error('x'), { status: 503 }), 0), 1000, '5xx keeps its own schedule');
});

test('jitter only stretches a wait, by at most a quarter', () => {
    assert.equal(jitteredWait(4000, RESEND_POLICY, () => 0), 4000);
    assert.equal(jitteredWait(4000, RESEND_POLICY, () => 1), 5000);
    assert.equal(jitteredWait(4000, RESEND_POLICY, () => 0.5), 4500);
    assert.equal(jitteredWait(4000, RESEND_POLICY, () => { throw new Error('no random'); }), 4000);
});

test('six seconds fits; longer hints end with a plain error without waiting', () => {
    assert.equal(resendDecision(http429(6000), { elapsedMs: 1000 }), 'resend');
    assert.equal(resendDecision(http429(6001), { elapsedMs: 1000 }), 'wait_too_long');
    assert.equal(resendDecision(http429(30_000), { elapsedMs: 1000 }), 'wait_too_long');
    assert.equal(resendDecision(http429(6000), { elapsedMs: 9000 }), 'too_slow', 'the dispatch deadline includes the wait');
    assert.equal(describeInferenceFailure(http429(30_000)), 'The model is temporarily busy. Please try again.');
    assert.equal(describeInferenceFailure(http429(5_000)), 'The model is temporarily busy. Please try again.');
});

test('all retryable statuses honour hints without truncating them to the six-second cap', async () => {
    for (const status of [429, 502, 503, 504]) {
        let calls = 0;
        const error = { status, retryAfterMs: 6001 };
        await assert.rejects(runWithResend(async () => { calls++; throw error; }, {
            wait: async () => assert.fail('a long hint must never schedule a retry')
        }), error);
        assert.equal(calls, 1);
        assert.equal(baseResendWait({ status, retryAfterMs: 4000 }, 0), 4000);
    }
});

test('the resend loop sleeps the jittered Retry-After, then answers', async () => {
    let t = 0, calls = 0;
    const waits = [];
    const result = await runWithResend(async () => { calls += 1; if (calls === 1) throw http429(3000); return 'ok'; },
        { now: () => t, random: () => 1, wait: async ms => { waits.push(ms); t += ms; } });
    assert.equal(result, 'ok');
    assert.deepEqual(waits, [3750], '3 s asked, stretched by 25 %');
});

test('jitter stays within the wait cap and the remaining total budget', async () => {
    let time = 0, calls = 0;
    const waits = [];
    await runWithResend(async () => {
        if (++calls === 1) { time = 1000; throw http429(6000); }
        assert.ok(time < RESEND_POLICY.budgetMs);
    }, { now: () => time, random: () => 1, wait: async ms => { waits.push(ms); time += ms; } });
    assert.deepEqual(waits, [6000]);
    assert.equal(calls, 2);
});

test('jitter cannot waste the remaining budget when the provider minimum fits', async () => {
    let time = 0, calls = 0;
    const waits = [];
    const result = await runWithResend(async () => {
        if (++calls === 1) { time = 12000; throw http429(2500); }
        return 'answer';
    }, { now: () => time, random: () => 1, wait: async ms => { waits.push(ms); time += ms; } });
    assert.deepEqual(waits, [2500]);
    assert.equal(calls, 2);
    assert.equal(result, 'answer');
});

test('a minimum wait reaching the dispatch deadline is rejected before waiting', async () => {
    let time = 0, calls = 0;
    await assert.rejects(runWithResend(async () => {
        calls++; time = 9000; throw http429(6000);
    }, { now: () => time, wait: async () => assert.fail('no pointless wait') }));
    assert.equal(calls, 1);
});

test('a suspended tab cannot dispatch a resend after its total budget', async () => {
    let time = 0, calls = 0, outcome;
    const error = http429(2000);
    await assert.rejects(runWithResend(async () => { calls++; throw error; }, {
        now: () => time, wait: async () => { time = 30000; },
        onSettled: value => { outcome = value; }
    }), error);
    assert.equal(calls, 1);
    assert.equal(error.resendHandled, true);
    assert.equal(outcome.reason, 'too_slow');
    assert.equal(outcome.attempts, 1);
});

test('only the reply\'s own signal is a Stop; a transport abort is resent before text', async () => {
    const transport = Object.assign(new DOMException('The operation was aborted.', 'AbortError'));
    const own = new AbortController();
    assert.equal(isStopError(transport, own.signal), false);
    assert.equal(abortOrigin(transport, own.signal), 'transport');
    own.abort();
    assert.equal(isStopError(transport, own.signal), true);
    assert.equal(abortOrigin(transport, own.signal), 'stop');

    const marked = Object.assign(new Error('The operation was aborted'), { isTransportAbort: true, code: 'TRANSPORT_ABORTED' });
    assert.equal(resendDecision(marked, { signal: new AbortController().signal }), 'resend');
    assert.equal(resendDecision(marked, { signal: new AbortController().signal, outputSeen: true }), 'had_text');
    let calls = 0;
    const answer = await runWithResend(async () => { calls += 1; if (calls === 1) throw marked; return 'answer'; },
        { signal: new AbortController().signal, wait: async () => {}, random: () => 0 });
    assert.equal(answer, 'answer');
    assert.equal(calls, 2);

    // A Stop that lands while that failure is judged ends as a Stop.
    const late = new AbortController();
    const judged = Object.assign(new Error('The operation was aborted'), { isTransportAbort: true });
    await assert.rejects(runWithResend(async () => { late.abort(); throw judged; }, { signal: late.signal }), error => {
        assert.equal(error.isCancelled, true);
        return true;
    });
});

test('transport aborts and key failures read in plain words', () => {
    assert.equal(isTransportAbort(new Error('Request aborted')), true);
    assert.equal(isTransportAbort(Object.assign(new Error('x'), { name: 'AbortError', isCancelled: true })), false);
    assert.equal(transientFailureReply({ isTransportAbort: true }), '**Error:** The connection closed before the model replied.');
    assert.equal(transientFailureReply({ isTransportAbort: true }, { hadPartial: true }), 'The connection closed before the reply finished.');
    assert.equal(accessFailureText(new DOMException('The operation was aborted.', 'AbortError')),
        "Couldn't get an access key: the connection closed before the key arrived. Try again.");
    assert.equal(accessFailureText(new Error('Tickets are being moved.')), 'Tickets are being moved.');
});

test('an error row is not an answer; a partial answer with an error note is', () => {
    assert.equal(isFailureReply({ role: 'assistant', isLocalOnly: true, content: '**Error:** The operation was aborted' }), true);
    assert.equal(isFailureReply({ role: 'assistant', isLocalOnly: true, content: '⚠️ **Error** (after 2 retries): Provider returned error' }), true);
    assert.equal(isFailureReply({ role: 'assistant', content: 'Half an answer', inferenceError: 'Gateway timeout' }), false);
    assert.equal(isFailureReply({ role: 'assistant', content: 'A real answer.' }), false);
    assert.equal(isFailureReply({ role: 'user', isLocalOnly: true, content: '**Error:** x' }), false);
    assert.equal(failureReplyText({ content: '**Error:** Too many requests (HTTP 429).' }), 'Too many requests (HTTP 429).');
});
