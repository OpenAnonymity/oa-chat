import test from 'node:test';
import assert from 'node:assert/strict';

import {
    DIAGNOSTIC_EVENT, BREADCRUMB_EVENT, DIAGNOSTIC_CATALOG,
    bucketCount, normalizeDiagnostic, normalizeBreadcrumb, breadcrumbFromLogEntry,
    createDiagnosticsReporter, requestFailureReason, isDiagnosticName, createDiagnosticTrail, unlockFailureOutcome
} from '../../chat/services/diagnostics.js';

const privateText = 'PRIVATE_PROMPT_KEY_TICKET_EMAIL';

function target() {
    const events = [];
    return { events, dispatchEvent: event => { events.push({ type: event.type, detail: event.detail }); return true; } };
}

test('counts are buckets, never exact sizes', () => {
    assert.deepEqual([0, 1, 2, 3, 4, 5, 7, 10, 13, 47, 99, 477, 5000].map(bucketCount),
        [0, 1, 2, 3, 5, 5, 10, 10, 20, 50, 100, 500, Infinity]);
    assert.equal(bucketCount('many'), 0);
    assert.equal(bucketCount(-3), 0);
});

test('a diagnostic keeps only catalogued fields with catalogued values', () => {
    assert.deepEqual(normalizeDiagnostic('access.sweep', {
        skipped: 213, recovered: true, tier: 3, model: privateText, note: privateText, extra: { prompt: privateText }
    }), { skipped: 500, recovered: true, tier: 3 });
    assert.deepEqual(normalizeDiagnostic('stream.timeout', { stage: privateText, seconds: 120 }), { seconds: 200 });
    assert.deepEqual(normalizeDiagnostic('storage.failed', { store: 'tickets', op: 'write' }), { store: 'tickets', op: 'write' });
    assert.deepEqual(normalizeDiagnostic('access.sweep', { recovered: 'yes' }), {});
    assert.equal(normalizeDiagnostic(privateText, { a: 1 }), null);
    assert.equal(normalizeDiagnostic('access.sweep.' + privateText), null);
    assert.equal(isDiagnosticName('access.sweep'), true);
    assert.equal(isDiagnosticName('toString'), false);
    assert.equal(isDiagnosticName('__proto__'), false);
    for (const [name, schema] of Object.entries(DIAGNOSTIC_CATALOG)) {
        assert.match(name, /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/);
        for (const kind of Object.values(schema)) assert.ok(['enum', 'count', 'bool'].includes(kind.kind));
    }
});

test('a breadcrumb is a category, a step name and a status; nothing free-form', () => {
    assert.deepEqual(normalizeBreadcrumb({ category: 'access', code: 'request_key', status: 401, errorCode: 'TICKET_ALREADY_SPENT', count: 13, url: privateText, body: privateText }),
        { category: 'access', code: 'request_key', status: 401, errorCode: 'TICKET_ALREADY_SPENT', count: 20 });
    assert.equal(normalizeBreadcrumb({ category: privateText, code: 'request_key' }), null);
    assert.equal(normalizeBreadcrumb({ category: 'access', code: privateText }), null);
    assert.equal(normalizeBreadcrumb({ category: 'access', code: 'request key' }), null);
    assert.deepEqual(normalizeBreadcrumb({ category: 'access', code: 'request_key', status: 'nope', errorCode: 'has a space', aborted: true }),
        { category: 'access', code: 'request_key', aborted: true });
    assert.deepEqual(normalizeBreadcrumb({ category: 'stream', code: 'completion', errorCode: privateText.toLowerCase() }), { category: 'stream', code: 'completion' });
    // Only the org's own codes travel; an uppercase identifier is not enough.
    assert.deepEqual(normalizeBreadcrumb({ category: 'stream', code: 'completion', errorCode: privateText }), { category: 'stream', code: 'completion' });
});

test('timeline entries reduce to steps without host, path parameters, headers or bodies', () => {
    const entry = {
        type: 'api-key', method: 'POST', status: 401,
        url: `https://org.example/api/request_key?token=${privateText}`,
        request: { headers: { Authorization: privateText } },
        response: { detail: { error_code: 'TICKET_ALREADY_SPENT', message: privateText, failed_ticket: { preview: privateText } } }
    };
    assert.deepEqual(breadcrumbFromLogEntry(entry), { category: 'access', code: 'request_key', status: 401, errorCode: 'TICKET_ALREADY_SPENT' });
    assert.deepEqual(breadcrumbFromLogEntry({ type: 'verification', url: 'https://verifier.example/submit_key', status: 200 }), { category: 'verify', code: 'submit_key', status: 200 });
    assert.deepEqual(breadcrumbFromLogEntry({ type: 'openrouter', url: `https://station.example/v1/chat/completions`, status: 0, isAborted: true }), { category: 'stream', code: 'completion', status: 0, aborted: true });
    assert.deepEqual(breadcrumbFromLogEntry({ type: 'openrouter', url: `https://station.example/${privateText}`, status: 502 }), { category: 'stream', code: 'request', status: 502 });
    assert.deepEqual(breadcrumbFromLogEntry({ type: 'ticket', url: 'https://org.example/api/split_tickets', status: 200 }), { category: 'tickets', code: 'split', status: 200 });
    assert.deepEqual(breadcrumbFromLogEntry({ type: 'local', method: 'LOCAL', status: 200, action: 'ticket-select', response: { ticket_index: 42 } }), { category: 'local', code: 'ticket_select' });
    assert.deepEqual(breadcrumbFromLogEntry({ type: 'ticket', url: 'not a url', status: 500 }), { category: 'other', code: 'request', status: 500 });
    assert.equal(breadcrumbFromLogEntry({ type: 'local', action: privateText }), null);
    assert.equal(JSON.stringify(breadcrumbFromLogEntry(entry)).includes(privateText), false);
    assert.equal(breadcrumbFromLogEntry(null), null);
});

test('the reporter sends catalogued events, coalesces repeats and never throws', () => {
    let clock = 1_000_000;
    const sink = target();
    const reporter = createDiagnosticsReporter({ target: sink, now: () => clock });
    assert.equal(reporter.report('access.sweep', { skipped: 7, recovered: true, tier: 1 }), true);
    assert.equal(reporter.report('access.sweep', { skipped: 2, recovered: true }), false); // within the minute
    assert.equal(reporter.report('access.sweep', { skipped: 2, recovered: true }), false);
    clock += 61_000;
    assert.equal(reporter.report('access.sweep', { skipped: 9, recovered: false }), true);
    assert.deepEqual(sink.events.map(event => event.type), [DIAGNOSTIC_EVENT, DIAGNOSTIC_EVENT]);
    assert.deepEqual(sink.events[0].detail, { name: 'access.sweep', fields: { skipped: 10, recovered: true, tier: 1 }, repeats: 0, trail: [] });
    assert.deepEqual(sink.events[1].detail, { name: 'access.sweep', fields: { skipped: 10, recovered: false }, repeats: 2, trail: [] });
    assert.equal(reporter.report(privateText, { skipped: 1 }), false);
    assert.equal(reporter.report('access.sweep', null), false);
    assert.equal(reporter.breadcrumb({ category: 'access', code: 'request_key', status: 401 }), true);
    assert.equal(reporter.breadcrumb({ category: 'nope', code: 'request_key' }), false);
    assert.equal(reporter.breadcrumb(null), false);
    assert.equal(sink.events.at(-1).type, BREADCRUMB_EVENT);
    // A target that throws is swallowed.
    const broken = createDiagnosticsReporter({ target: { dispatchEvent() { throw new Error(privateText); } } });
    assert.equal(broken.report('access.sweep', { skipped: 1 }), false);
    assert.equal(broken.breadcrumb({ category: 'access', code: 'x' }), false);
    // No window at all: nothing happens, nothing throws.
    const headless = createDiagnosticsReporter({ target: null, now: () => clock });
    const previousWindow = globalThis.window;
    delete globalThis.window;
    try { assert.equal(headless.report('access.sweep', { skipped: 1 }), false); } finally { if (previousWindow) globalThis.window = previousWindow; }
});

test('the reporter has hard per-name and per-page bounds', () => {
    let clock = 0;
    const sink = target();
    const reporter = createDiagnosticsReporter({ target: sink, now: () => clock });
    for (let i = 0; i < 15; i += 1) { reporter.report('storage.failed', { store: 'tickets', op: 'write' }); clock += 61_000; }
    assert.equal(sink.events.length, 10);
    for (let i = 0; i < 100; i += 1) {
        reporter.report('sync.failed', { reason: 'timeout', stage: 'pull' });
        reporter.report('stream.timeout', { stage: 'idle', seconds: 180 });
        reporter.report('access.sweep', { skipped: 1 });
        reporter.report('access.sweep_stalled', {});
        reporter.report('access.sweep', { skipped: 1 }); clock += 61_000;
    }
    assert.ok(sink.events.length <= 60, String(sink.events.length));
    assert.ok(sink.events.every(event => event.type === DIAGNOSTIC_EVENT));
});

test('request failures map to finite reasons; the message is never carried', () => {
    assert.equal(requestFailureReason({ status: 504 }), 'http_504');
    assert.equal(requestFailureReason({ response: { status: 418 } }), 'other_4xx');
    assert.equal(requestFailureReason({ status: 599 }), 'other_5xx');
    assert.equal(requestFailureReason({ name: 'TimeoutError', message: privateText }), 'timeout');
    assert.equal(requestFailureReason({ isBodyTimeout: true }), 'timeout');
    assert.equal(requestFailureReason(new TypeError(`Failed to fetch ${privateText}`)), 'network');
    assert.equal(requestFailureReason(new TypeError(`${privateText} is not a function`)), 'unexpected');
    assert.equal(requestFailureReason({ code: 'VERIFICATION_REJECTED' }), 'rejected');
    assert.equal(requestFailureReason(null), 'unexpected');
});


test('concurrent request trails remain isolated, bounded, and contain only relative timing', () => {
    let clock = 1000000000;
    const a = createDiagnosticTrail('access', { now: () => clock });
    a.add('started');
    clock += 225;
    const b = createDiagnosticTrail('stream', { now: () => clock });
    b.add('opened');
    clock += 100;
    a.add('failed');
    a.add('private_user_prompt');
    assert.deepEqual(a.snapshot(), [
        { category: 'access', code: 'started', elapsedMs: 0 },
        { category: 'access', code: 'failed', elapsedMs: 300 }
    ]);
    assert.deepEqual(b.snapshot(), [{ category: 'stream', code: 'opened', elapsedMs: 0 }]);
    a.snapshot()[0].code = privateText;
    assert.equal(a.snapshot()[0].code, 'started');
    for (let i = 0; i < 60; i++) a.add('request_key');
    assert.equal(a.snapshot().length, 40);
    assert.equal(normalizeBreadcrumb({ category: 'access', code: 'private_user_prompt' }), null);
});

test('unlock failures map to finite outcomes with the account kind; the message is never carried', () => {
    const unavailable = new Error(`This passkey is not available ${privateText}`);
    unavailable.name = 'PasskeyUnavailableError';
    unavailable.code = 'ENCRYPTION_PASSKEY_NOT_AVAILABLE';
    assert.equal(unlockFailureOutcome(unavailable), 'unavailable');
    assert.equal(unlockFailureOutcome({ name: 'NotAllowedError', message: privateText }), 'cancelled');
    assert.equal(unlockFailureOutcome({ name: 'AbortError' }), 'cancelled');
    assert.equal(unlockFailureOutcome(new Error(`This passkey did not provide an encryption key. Use a PRF-capable passkey. ${privateText}`)), 'no_prf');
    assert.equal(unlockFailureOutcome(new Error(privateText)), 'failed');
    assert.equal(unlockFailureOutcome(null), 'failed');

    const sent = normalizeDiagnostic('unlock.failed', { outcome: 'unavailable', account: 'google', prelaunch: false, message: privateText });
    assert.deepEqual(sent, { outcome: 'unavailable', account: 'google', prelaunch: false });
    assert.deepEqual(normalizeDiagnostic('unlock.failed', { outcome: privateText, account: 'apple' }), {});
    assert.ok(!JSON.stringify(sent).includes(privateText));
});
