import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { init, captureEvent, captureException, flush, makeFetchTransport, getCurrentScope } from '@sentry/browser';
import { sanitizeErrorEvent, privacyOptions } from '../scripts/sentry/privacy.mjs';

// The repository bundles unit tests into /tmp. Load the build helper from its
// real location so esbuild's native binary and relative entry resolve correctly.
const { resolveSentryConfig, injectSentry } = await import(
    pathToFileURL(path.join(process.cwd(), 'scripts/sentryBuild.mjs')).href
);

const config = {
    dsn: 'https://abc123@o0.ingest.sentry.io/123', environment: 'test', release: 'test-123',
    origin: 'https://chat.example', scriptPaths: ['/assets/app-ABC.js']
};
const privateText = 'PRIVATE_PROMPT_KEY_TICKET_EMAIL';
function event() {
    return {
        event_id: 'a'.repeat(32), message: privateText, user: { email: privateText },
        request: { url: privateText, headers: { Authorization: privateText } },
        breadcrumbs: [{ message: privateText }], tags: { account: privateText },
        contexts: { trace: { data: privateText } }, extra: { content: privateText },
        exception: { values: [{ type: 'TypeError', value: privateText, stacktrace: { frames: [{
            filename: `${config.origin}/assets/app-ABC.js?key=${privateText}#${privateText}`,
            lineno: 42, colno: 8, function: privateText, vars: { secret: privateText },
            context_line: privateText
        }] } }] }
    };
}

test('only build script locations and fixed error categories survive', () => {
    const sanitized = sanitizeErrorEvent(event(), config);
    assert.equal(JSON.stringify(sanitized).includes(privateText), false);
    assert.deepEqual(sanitized.exception.values[0].stacktrace.frames, [{
        filename: 'app:///assets/app-ABC.js', lineno: 42, colno: 8, in_app: true
    }]);
    assert.equal(sanitized.exception.values[0].type, 'TypeError');
    assert.equal(sanitized.environment, 'test');
    const custom = event();
    custom.exception.values[0].type = privateText;
    assert.equal(sanitizeErrorEvent(custom, config).exception.values[0].type, 'Error');
    custom.exception.values[0].mechanism = { handled: false, type: privateText, data: { secret: privateText } };
    const uncaught = sanitizeErrorEvent(custom, config);
    assert.deepEqual(uncaught.exception.values[0].mechanism, { type: 'generic', handled: false });
    assert.equal(JSON.stringify(uncaught).includes(privateText), false);
});

test('drop events without known application frames and non-error event types', () => {
    for (const filename of ['https://other.example/assets/app-ABC.js', `${config.origin}/tickets/${privateText}`, 'data:text/plain,secret', 'file:///private/secret.js']) {
        const input = event();
        input.exception.values[0].stacktrace.frames[0].filename = filename;
        assert.equal(sanitizeErrorEvent(input, config), null);
    }
    assert.equal(sanitizeErrorEvent({ message: privateText }, config), null);
    assert.equal(sanitizeErrorEvent({ ...event(), type: 'transaction' }, config), null);
});

test('Sentry is opt-in and invalid configuration fails without echoing secrets', () => {
    assert.equal(resolveSentryConfig({}), null);
    assert.equal(resolveSentryConfig({ SENTRY_DSN: config.dsn }).environment, 'development');
    for (const dsn of ['invalid', 'http://abc@sentry.io/1', 'https://abc:secret@o0.ingest.sentry.io/1', 'https://abc@evil.example/1']) {
        assert.throws(() => resolveSentryConfig({ SENTRY_DSN: dsn }), /SENTRY_DSN/);
    }
    assert.throws(() => resolveSentryConfig({ SENTRY_DSN: config.dsn, SENTRY_ENVIRONMENT: 'bad environment' }));
});

test('real SDK sends only sanitized error payload without cookies, referrer or attachments', async () => {
    const requests = [];
    init({
        ...privacyOptions(config),
        transport: options => makeFetchTransport(options, async (url, request) => {
            requests.push({ url, request });
            return { status: 200, headers: new Headers() };
        })
    });
    getCurrentScope().setUser({ email: privateText });
    getCurrentScope().addAttachment({ filename: privateText, data: privateText });
    captureEvent(event());
    await flush(2000);
    assert.equal(requests.length, 1);
    const { request } = requests[0];
    const body = String(request.body);
    assert.equal(body.includes(privateText), false);
    assert.equal(body.includes('attachment'), false);
    assert.equal(body.includes('"trace"'), false);
    assert.equal(body.includes('"request"'), false);
    assert.equal(request.credentials, 'omit');
    assert.equal(request.referrerPolicy, 'no-referrer');
    assert.equal(body.split('\n').filter(Boolean).length, 3);
    assert.equal(JSON.parse(body.split('\n')[1]).type, 'event');
    assert.equal(JSON.parse(body.split('\n')[2]).sdk.settings.infer_ip, 'never');
});

test('build emits a self-hosted SDK only when configured, before app modules', async () => {
    const outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oa-sentry-test-'));
    try {
        const html = '<html><head></head><body><script type="module" src="assets/app-ABC.js"></script></body></html>';
        assert.equal(await injectSentry(html, { config: null }), html);
        const result = await injectSentry(html, {
            outDir, config, outputs: { [path.join(outDir, 'assets/app-ABC.js')]: {} }
        });
        assert.match(result, /<script src="assets\/sentry-[A-Z0-9]+\.js"><\/script>\s*<\/head>/);
        const files = await fs.readdir(path.join(outDir, 'assets'));
        const bundle = await fs.readFile(path.join(outDir, 'assets', files[0]), 'utf8');
        assert.ok(bundle.includes(config.dsn));
        assert.ok(bundle.includes('/assets/app-ABC.js'));
        assert.ok(!bundle.includes('sentry-cdn.com'));
    } finally {
        await fs.rm(outDir, { recursive: true, force: true });
    }
});


test('handled request categories survive but original error data and arbitrary fingerprints do not', async () => {
    const input = event();
    input.exception.values[0].type = 'OARequest_access_http_520';
    input.exception.values[0].mechanism = { handled: true, type: 'generic', data: privateText };
    input.fingerprint = [privateText];
    const sanitized = sanitizeErrorEvent(input, config);
    assert.equal(sanitized.exception.values[0].value, 'OA Chat access failed: http_520 (details withheld)');
    assert.deepEqual(sanitized.fingerprint, ['OARequest_access_http_520']);
    assert.equal(sanitized.exception.values[0].mechanism.handled, true);
    assert.equal(JSON.stringify(sanitized).includes(privateText), false);
    const requests = [];
    init({ ...privacyOptions(config), transport: options => makeFetchTransport(options, async (_url, request) => {
        requests.push(request); return { status: 200, headers: new Headers() };
    }) });
    getCurrentScope().setUser({ email: privateText });
    getCurrentScope().addAttachment({ filename: privateText, data: privateText });
    captureEvent(input);
    await flush(2000);
    assert.equal(requests.length, 1);
    assert.equal(String(requests[0].body).includes(privateText), false);
    assert.ok(String(requests[0].body).includes('OARequest_access_http_520'));
    assert.equal(requests[0].credentials, 'omit');
    input.exception.values[0].type = 'OARequest_access_' + privateText;
    assert.equal(sanitizeErrorEvent(input, config).exception.values[0].type, 'Error');
    assert.equal(sanitizeErrorEvent(input, config).fingerprint, undefined);
});

test('actual SDK envelope keeps finite provider error categories and drops private scope', async () => {
    const input = event();
    input.exception.values[0].type = 'OARequest_completion_provider_code_429';
    const requests = [];
    init({ ...privacyOptions(config), transport: options => makeFetchTransport(options, async (_url, request) => {
        requests.push(request); return { status: 200, headers: new Headers() };
    }) });
    getCurrentScope().setUser({ email: privateText });
    captureEvent(input);
    await flush(2000);
    assert.equal(requests.length, 1);
    assert.ok(String(requests[0].body).includes('OARequest_completion_provider_code_429'));
    assert.equal(String(requests[0].body).includes(privateText), false);
    assert.equal(requests[0].credentials, 'omit');
});


test('actual SDK diagnostic envelope retains only scoped steps and relative times', async () => {
    const requests = [];
    init({ ...privacyOptions(config), transport: options => makeFetchTransport(options, async (_url, request) => {
        requests.push(request); return { status: 200, headers: new Headers() };
    }) });
    captureEvent({ message: 'OADiag_stream.timeout', contexts: { oa: { stage: 'idle', seconds: 45, prompt: privateText } },
        breadcrumbs: [{ category: 'oa.stream', message: 'opened', timestamp: 1700000000, data: { elapsed_ms: 125, sessionId: privateText } }] });
    await flush(2000);
    assert.equal(requests.length, 1);
    const body = String(requests[0].body);
    assert.equal(body.includes(privateText), false);
    assert.equal(body.includes('1700000000'), false);
    assert.ok(body.includes('elapsed_ms'));
    assert.ok(body.includes('opened'));
});


test('actual SDK captureException attaches the synthetic error request trail through beforeSend', async () => {
    const requests = [];
    init({ ...privacyOptions(config), transport: options => makeFetchTransport(options, async (_url, request) => {
        requests.push(request); return { status: 200, headers: new Headers() };
    }) });
    const failure = new Error('Request failed (details withheld)');
    failure.name = 'OARequest_completion_http_503';
    failure.stack = `OARequest_completion_http_503: Request failed\n    at send (${config.origin}/assets/app-ABC.js:42:8)`;
    failure.oaTrail = [{ category: 'stream', code: 'started', elapsedMs: 0 }, { category: 'stream', code: 'failed', elapsedMs: 1200, prompt: privateText }];
    captureException(failure);
    await flush(2000);
    assert.equal(requests.length, 1);
    const body = String(requests[0].body);
    assert.ok(body.includes('elapsed_ms'));
    assert.ok(body.includes('started'));
    assert.ok(body.includes('failed'));
    assert.equal(body.includes(privateText), false);
});
