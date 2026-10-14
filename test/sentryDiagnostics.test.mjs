import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeErrorEvent, sanitizeBreadcrumbs, sanitizeTags, collectLiveTags, privacyOptions, TAGS } from '../scripts/sentry/privacy.mjs';

// The trail, the tags and the diagnostics: everything a report may carry
// beyond the stack is rebuilt here from the client's finite vocabulary.
// This file needs no SDK; test/sentry.test.mjs covers the real envelope.

const config = {
    dsn: 'https://abc123@o0.ingest.sentry.io/123', environment: 'test', release: 'test-123',
    origin: 'https://chat.example', scriptPaths: ['/assets/app-ABC.js']
};
const privateText = 'PRIVATE_PROMPT_KEY_TICKET_EMAIL';
const frame = { filename: `${config.origin}/assets/app-ABC.js`, lineno: 42, colno: 8 };

function crumbs() {
    return [
        { category: 'oa.access', message: 'request_key', level: 'info', timestamp: 1700000000.5, data: { status: 401, error_code: 'TICKET_ALREADY_SPENT', url: privateText } },
        { category: 'oa.access', message: 'request_key', level: 'info', timestamp: 1700000001, data: { status: 200 } },
        { category: 'oa.stream', message: 'completion', data: { status: 0, aborted: true, body: privateText } },
        { category: 'console', message: privateText, data: { arguments: [privateText] } },
        { category: 'fetch', message: privateText, data: { url: privateText } },
        { category: 'oa.access', message: privateText },
        { category: `oa.${privateText}`, message: 'request_key' },
        { category: 'oa.tickets', message: 'split', data: { status: 999999, error_code: privateText, count: 4 } }
    ];
}

test('breadcrumbs survive only as category, step, status, org code and bucketed count', () => {
    const kept = sanitizeBreadcrumbs(crumbs());
    assert.deepEqual(kept, [
        { category: 'oa.access', message: 'request_key', level: 'info', type: 'default', timestamp: 1700000000.5, data: { status: 401, error_code: 'TICKET_ALREADY_SPENT' } },
        { category: 'oa.access', message: 'request_key', level: 'info', type: 'default', timestamp: 1700000001, data: { status: 200 } },
        { category: 'oa.stream', message: 'completion', level: 'info', type: 'default', data: { status: 0, aborted: true } },
        { category: 'oa.tickets', message: 'split', level: 'info', type: 'default', data: { count: 5 } }
    ]);
    assert.equal(JSON.stringify(kept).includes(privateText), false);
    assert.equal(sanitizeBreadcrumbs(Array.from({ length: 100 }, () => crumbs()[1])).length, 40);
    assert.deepEqual(sanitizeBreadcrumbs(privateText), []);
});

test('tags are a fixed set with fixed values', () => {
    assert.deepEqual(sanitizeTags({ 'oa.mode': 'zkapi', 'oa.surface': 'desktop', 'oa.visibility': 'hidden', 'oa.online': 'offline', account: privateText, 'oa.model': privateText }),
        { 'oa.mode': 'zkapi', 'oa.surface': 'desktop', 'oa.visibility': 'hidden', 'oa.online': 'offline' });
    assert.deepEqual(sanitizeTags({ 'oa.mode': privateText }), {});
    assert.deepEqual(sanitizeTags(null), {});
    for (const values of Object.values(TAGS)) assert.ok(values.every(value => /^[a-z]+$/.test(value)));
});

test('live tags come from the page and only ever take catalogued values', () => {
    const page = {
        document: { documentElement: { classList: { contains: name => name === 'zkapi-mode' } }, visibilityState: 'hidden' },
        navigator: { onLine: false },
        window: { oaDesktopReady: true }
    };
    assert.deepEqual(collectLiveTags(page), { 'oa.mode': 'zkapi', 'oa.surface': 'desktop', 'oa.visibility': 'hidden', 'oa.online': 'offline' });
    assert.deepEqual(collectLiveTags({ document: {}, navigator: {}, window: {} }), { 'oa.mode': 'ticket', 'oa.surface': 'web', 'oa.visibility': 'visible', 'oa.online': 'online' });
    assert.deepEqual(collectLiveTags({ document: { get documentElement() { throw new Error(privateText); } } }), {});
    for (const [key, value] of Object.entries(collectLiveTags(page))) assert.ok(TAGS[key].includes(value));
});

test('a diagnostic event is rebuilt from its catalogued name and fields, with the trail and tags', () => {
    const sanitized = sanitizeErrorEvent({
        event_id: 'b'.repeat(32), message: 'OADiag_access.sweep', level: 'warning', timestamp: 1700000002,
        contexts: { oa: { skipped: 213, recovered: true, tier: 3, repeats: 2, prompt: privateText }, device: { name: privateText } },
        breadcrumbs: crumbs(), tags: { 'oa.mode': 'ticket', account: privateText }, user: { email: privateText },
        extra: { content: privateText }, request: { url: privateText }, fingerprint: [privateText]
    }, { ...config, liveTags: () => ({ 'oa.surface': 'web', 'oa.visibility': privateText }) });
    assert.deepEqual(sanitized, {
        event_id: 'b'.repeat(32), platform: 'javascript', environment: 'test', release: 'test-123', timestamp: 1700000002,
        level: 'warning', message: 'OADiag_access.sweep', logger: 'oa.diagnostics',
        contexts: { oa: { skipped: 500, recovered: true, tier: 3, repeats: 2 } },
        fingerprint: ['OADiag_access.sweep'],
        tags: { 'oa.mode': 'ticket', 'oa.surface': 'web' },
        breadcrumbs: sanitizeBreadcrumbs(crumbs())
    });
    assert.equal(JSON.stringify(sanitized).includes(privateText), false);
    // Event tags win over live tags (they were read when the incident happened).
    const live = sanitizeErrorEvent({ message: 'OADiag_access.sweep', tags: { 'oa.mode': 'zkapi' } }, { ...config, liveTags: () => ({ 'oa.mode': 'ticket' }) });
    assert.deepEqual(live.tags, { 'oa.mode': 'zkapi' });
    assert.equal(live.level, 'warning');
    assert.equal(sanitizeErrorEvent({ message: 'OADiag_access.sweep', level: 'error' }, config).level, 'error');
    assert.equal(sanitizeErrorEvent({ message: 'OADiag_access.sweep', level: privateText }, config).level, 'warning');
});

test('messages outside the catalogue are dropped as before', () => {
    for (const message of [privateText, 'OADiag_' + privateText, 'OADiag_access.' + privateText, 'OADiag_access.sweep.extra', 'OADiag_toString.x', 'OADiag___proto__.x', '']) {
        assert.equal(sanitizeErrorEvent({ message, breadcrumbs: crumbs() }, config), null, message);
    }
    assert.equal(sanitizeErrorEvent({ message: 'OADiag_access.sweep', type: 'transaction' }, config), null);
});

test('an exception event carries the trail and tags, nothing else new', () => {
    const sanitized = sanitizeErrorEvent({
        exception: { values: [{ type: 'TypeError', value: privateText, stacktrace: { frames: [frame] } }] },
        breadcrumbs: crumbs(), tags: { 'oa.online': 'offline', 'oa.extra': privateText }, timestamp: 1700000003
    }, config);
    assert.deepEqual(Object.keys(sanitized).sort(), ['breadcrumbs', 'environment', 'exception', 'level', 'platform', 'release', 'tags', 'timestamp']);
    assert.deepEqual(sanitized.tags, { 'oa.online': 'offline' });
    assert.equal(sanitized.breadcrumbs.length, 4);
    assert.equal(JSON.stringify(sanitized).includes(privateText), false);
    // No trail, no tags: the event is exactly what it was before.
    const bare = sanitizeErrorEvent({ exception: { values: [{ type: 'TypeError', value: privateText, stacktrace: { frames: [frame] } }] } }, config);
    assert.deepEqual(Object.keys(bare).sort(), ['environment', 'exception', 'level', 'platform', 'release']);
});

test('the SDK keeps only the client\'s own breadcrumbs', () => {
    const options = privacyOptions(config);
    assert.equal(options.maxBreadcrumbs, 40);
    assert.deepEqual(options.beforeBreadcrumb({ category: 'oa.access', message: 'request_key' }), { category: 'oa.access', message: 'request_key' });
    for (const crumb of [{ category: 'console', message: privateText }, { category: 'fetch' }, { category: 'xhr' }, { category: 'ui.click' }, { message: privateText }, null]) {
        assert.equal(options.beforeBreadcrumb(crumb), null);
    }
    assert.equal(options.defaultIntegrations, false);
    assert.equal(options.tracesSampleRate, 0);
});
