import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequestFailureReporter, parseRequestFailureType, REQUEST_FAILURE_EVENT } from '../../chat/services/requestDiagnostics.js';

const secret = 'PRIVATE_PROMPT_KEY_EMAIL';
function harness() {
    const target = new EventTarget();
    const events = [];
    target.addEventListener(REQUEST_FAILURE_EVENT, event => events.push(event.detail));
    return { events, report: createRequestFailureReporter(target) };
}

test('handled failures emit only synthetic categories, once per category per page', () => {
    const { events, report } = harness();
    const error = Object.assign(new Error(secret), { status: 520, data: secret, token: secret });
    report('access', error);
    report('access', error);
    report('completion', error);
    assert.equal(events.length, 2);
    assert.deepEqual(events.map(error => error.name), ['OARequest_access_http_520', 'OARequest_completion_http_520']);
    for (const event of events) {
        assert.notEqual(event, error);
        assert.equal(JSON.stringify(event).includes(secret), false);
        assert.equal(event.stack.includes(secret), false);
        assert.equal(event.cause, undefined);
        assert.equal(event.message, 'Request failed (details withheld)');
    }
});

test('cancellation, expected credit recovery and invalid phases are not reported', () => {
    const { events, report } = harness();
    for (const error of [{ name: 'AbortError' }, { isCancelled: true }, { isUserAbort: true }, { status: 402 }]) report('completion', error);
    report('completion', { status: 520 }, { aborted: true });
    report(secret, { status: 520 });
    assert.deepEqual(events, []);
});

test('categories are finite; timeouts, rate limits, and unknown errors remain distinct', () => {
    const { events, report } = harness();
    for (const error of [{ name: 'TimeoutError' }, { status: 429 }, { response: { status: 503 } }, { status: 599 }, new TypeError(secret)]) report('completion', error);
    assert.deepEqual(events.map(error => parseRequestFailureType(error.name).reason), ['timeout', 'http_429', 'http_503', 'other_5xx', 'unexpected']);
    for (const value of [secret, 'OARequest_access_' + secret, 'OARequest_access_http_123456', null]) assert.equal(parseRequestFailureType(value), null);
    assert.doesNotThrow(() => createRequestFailureReporter({ dispatchEvent() { throw new Error(secret); } })('access', { status: 520 }));
    const hostile = { get status() { throw new Error(secret); } };
    assert.doesNotThrow(() => report('access', hostile));
});

test('reporting has a hard per-page event bound', () => {
    const { events, report } = harness();
    for (const phase of ['access', 'verification', 'completion']) {
        for (const status of [400,401,403,408,413,422,429,500,502,503,504,520,521,522,523,524,525,526]) report(phase, { status });
    }
    assert.equal(events.length, 20);
});
