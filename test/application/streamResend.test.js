// The send path resends a provider's in-stream 504 without touching the
// reply on screen, and Parallel lanes do the same (2026-10-15; production
// port 2026-10-20 carries no inference telemetry).
import test from 'node:test';
import assert from 'node:assert/strict';

function installBrowser() {
    const keys = ['window', 'location', 'localStorage', 'sessionStorage', 'document', 'fetch', 'requestAnimationFrame'];
    const descriptors = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    const storage = { getItem: () => null, setItem() {}, removeItem() {} };
    const events = { addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; } };
    const location = { href: 'http://localhost/', hostname: 'localhost', origin: 'http://localhost', search: '', pathname: '/' };
    const values = {
        window: { ...events, location, localStorage: storage, sessionStorage: storage },
        location, localStorage: storage, sessionStorage: storage,
        document: { ...events, querySelector: () => null, getElementById: () => null,
            documentElement: { classList: { contains: () => false }, dataset: {} } },
        fetch: async () => { throw new Error('No network in these tests.'); },
        requestAnimationFrame: callback => callback()
    };
    for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    return () => {
        for (const [key, descriptor] of descriptors) {
            if (descriptor) Object.defineProperty(globalThis, key, descriptor);
            else delete globalThis[key];
        }
    };
}

const restoreImport = installBrowser();
const { default: preferencesStore } = await import('../../chat/services/preferencesStore.js');
const getPreference = preferencesStore.getPreference;
preferencesStore.getPreference = async () => false;
const { ChatApp } = await import('../../chat/app.js');
const { default: CouncilController } = await import('../../chat/application/councilController.js');
preferencesStore.getPreference = getPreference;
restoreImport();

const providerError = code => Object.assign(new Error('Provider returned error'),
    { code, providerReported: true, isStreamError: true, retryable: false, hasReceivedTokens: false });

function withWindow(t, dispatchEvent) {
    const restore = installBrowser();
    globalThis.window.dispatchEvent = dispatchEvent;
    t.after(restore);
}

function appHarness(streamCompletion) {
    return Object.assign(Object.create(ChatApp.prototype), {
        runtime: { recordUsage: async () => {}, discardUsagePreview: async () => {} },
        state: { models: [], sessions: [], sessionsById: new Map() },
        inferenceService: { streamCompletion },
        generateId: () => 'request-1',
        getModelsForSession: () => [],
        setSessionPendingProgress() {},
        setInferenceHealth() {}
    });
}

test('an in-stream 504 before any text is resent and the reply streams normally', { timeout: 10000 }, async t => {
    const events = [];
    withWindow(t, event => { events.push(event); return true; });
    const chunks = [];
    let calls = 0;
    let opened = 0;
    const app = appHarness(async (_messages, _model, _session, onChunk, onTokenUpdate, _files, _search, _controller, onStreamOpen) => {
        calls += 1;
        await onStreamOpen();
        if (calls === 1) throw providerError(504);
        await onChunk('Yes, you can jump in.');
        const usage = { promptTokens: 4, completionTokens: 6, estimated: false, isStreaming: false };
        await onTokenUpdate(usage);
        return usage;
    });
    const result = await app.streamCompletionWithRuntime([], 'google/gemini-3.8-flash', { id: 'one' },
        chunk => chunks.push(chunk), null, [], false, new AbortController(), () => { opened += 1; }, null,
        false, 'medium', 'request-1');
    assert.equal(calls, 2);
    assert.equal(opened, 2, 'the pending row only hears the stream open again; it is not rebuilt');
    assert.deepEqual(chunks, ['Yes, you can jump in.']);
    assert.equal(result.completionTokens, 6);
    assert.equal(events.filter(event => String(event.detail?.name || '').startsWith('inference.')).length, 0,
        'production sends no inference telemetry');
});

test('a reporter that throws on every call does not touch the reply', { timeout: 10000 }, async t => {
    withWindow(t, () => { throw new Error('reporter down'); });
    let calls = 0;
    const app = appHarness(async (_m, _model, _s, onChunk) => {
        calls += 1;
        if (calls === 1) throw providerError(502);
        await onChunk('fine');
        return { completionTokens: 1 };
    });
    const chunks = [];
    const result = await app.streamCompletionWithRuntime([], 'openai/gpt-6.1', { id: 'one' },
        chunk => chunks.push(chunk), null, [], false, new AbortController(), null, null, false, 'medium', 'request-2');
    assert.deepEqual(chunks, ['fine']);
    assert.equal(result.completionTokens, 1);
});

test('the final error tells the send loop its resends are spent', { timeout: 15000 }, async t => {
    withWindow(t, () => true);
    let calls = 0;
    const app = appHarness(async () => { calls += 1; throw providerError(503); });
    await assert.rejects(app.streamCompletionWithRuntime([], 'google/gemini-3.8-flash', { id: 'one' },
        null, null, [], false, new AbortController(), null, null, false, 'medium', 'request-3'), error => {
        assert.equal(error.resendHandled, true);
        return true;
    });
    assert.equal(calls, 2);
});

test('a Parallel lane resends its own 502 and keeps its answer', { timeout: 10000 }, async t => {
    withWindow(t, () => true);
    let calls = 0;
    const controller = new CouncilController({
        app: { state: { models: [] }, reasoningEnabled: false, reasoningEffort: 'medium', normalizeModelName: name => name,
            processMessagesWithFiles: messages => messages, isAccessCreditExhaustedError: () => false },
        chatDB: {},
        inferenceService: {
            streamCompletion: async (_m, _model, _lane, onChunk) => {
                calls += 1;
                if (calls === 1) throw providerError(502);
                onChunk('lane answer');
                return { totalTokens: 3, promptTokens: 1, completionTokens: 2 };
            }
        },
        ticketClient: { getTicketCount: () => 0 }
    });
    const session = { id: 's', councilAccess: { secondary: { apiKey: 'k', apiKeyInfo: {}, expiresAt: new Date(Date.now() + 60000).toISOString() } } };
    const result = await controller.sendLaneCompletion({
        session, entry: { laneId: 'secondary', id: 'google/gemini-3.8-flash', name: 'Gemini' },
        sanitizedMessages: [{ role: 'user', content: 'hi' }], searchEnabled: false, abortController: new AbortController()
    });
    assert.equal(calls, 2);
    assert.equal(result.content, 'lane answer');
});

test('hidden thinking before a 504 is not resent', { timeout: 10000 }, async t => {
    withWindow(t, () => true);
    let calls = 0;
    const app = appHarness(async (_m, _model, _s, _onChunk, _onToken, _files, _search, _controller, _onOpen, onReasoningChunk) => {
        calls += 1;
        await onReasoningChunk('', { withheld: true });
        throw providerError(504);
    });
    await assert.rejects(app.streamCompletionWithRuntime([], 'google/gemini-3.8-flash', { id: 'one' },
        () => {}, null, [], false, new AbortController(), null, () => {}, false, 'medium', 'request-5'), error => {
        assert.equal(error.resendHandled, true);
        return true;
    });
    assert.equal(calls, 1);
});

test('quick asks are resent too', { timeout: 10000 }, async t => {
    withWindow(t, () => true);
    let calls = 0;
    const app = appHarness(async (_m, _model, _s, onChunk) => {
        calls += 1;
        if (calls === 1) throw providerError(429);
        await onChunk('ok');
        return {};
    });
    await app.streamCompletionWithRuntime([], 'anthropic/claude', { id: 'one' }, () => {}, null, [], false,
        new AbortController(), null, null, false, 'medium', 'request-4', 'quick-ask');
    assert.equal(calls, 2);
});
