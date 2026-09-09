const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const test = require('node:test');

const moduleUrl = pathToFileURL(path.join(__dirname, '../../chat/services/inference/sseStream.js'));
const streamingStateUrl = pathToFileURL(path.join(__dirname, '../../chat/zkapi/domain/streamingState.js'));

async function loadOpenRouterApiForStreamingTest() {
    globalThis.window = globalThis;
    window.location = { hostname: 'localhost', origin: 'http://localhost', search: '' };
    globalThis.location = window.location;
    globalThis.localStorage = {
        getItem() { return null; },
        setItem() {},
        removeItem() {}
    };
    globalThis.sessionStorage = {
        getItem() { return null; },
        setItem() {},
        removeItem() {}
    };
    globalThis.document = {
        querySelector() { return null; },
        getElementById() { return null; },
        addEventListener() {},
        documentElement: { classList: { contains() { return false; } } }
    };
    globalThis.zkapiWallet = new Proxy({ ABI: [] }, {
        get(target, key) {
            return key in target ? target[key] : (() => null);
        }
    });

    const { default: openRouterApi } = await import(pathToFileURL(path.join(__dirname, '../../chat/zkapi/api.js')));
    return { openRouterApi, zkapiClient: globalThis.zkapiClient };
}

test('queued settlement remains distinct from access and response waits', async () => {
    const { normalizePendingPhase } = await import(streamingStateUrl);
    assert.equal(normalizePendingPhase('settling-previous'), 'settling-previous');
    assert.equal(normalizePendingPhase('requesting-key'), 'requesting-key');
    assert.equal(normalizePendingPhase('waiting'), 'requesting-key');
    assert.equal(normalizePendingPhase('stream-open'), 'waiting-response');
});

test('private-access progress maps truthful phases to compact copy and ordered steps', async () => {
    const { derivePendingIndicatorPresentation } = await import(streamingStateUrl);
    const phases = [
        ['checking', 'Checking for unfinished private activity…', 0, 'active'],
        ['syncing', 'Reading the latest private vault state…', 1, 'active'],
        ['proving', 'Generating a zero-knowledge funding proof…', 2, 'active'],
        ['requesting', 'Creating a temporary key for this chat…', 3, 'active'],
        ['verifying', 'Verifying private access with Open Anonymity…', 4, 'active']
    ];

    for (const [phase, current, activeIndex, activeState] of phases) {
        const presentation = derivePendingIndicatorPresentation('requesting-key', {
            kind: 'access',
            phase
        });
        assert.equal(presentation.mode, 'security');
        assert.equal(presentation.kind, 'access');
        assert.equal(presentation.current, current);
        assert.equal(presentation.progressPhase, phase);
        assert.equal(presentation.steps.length, 5);
        assert.equal(presentation.steps[activeIndex].state, activeState);
        assert.ok(presentation.steps.slice(0, activeIndex).every(step => step.state === 'complete'));
        assert.ok(presentation.steps.slice(activeIndex + 1).every(step => step.state === 'upcoming'));
        assert.match(presentation.description, new RegExp(current.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    }

    const ready = derivePendingIndicatorPresentation('requesting-key', {
        kind: 'access',
        phase: 'ready'
    });
    assert.match(ready.current, /secured/i);
    assert.ok(ready.steps.every(step => step.state === 'complete'));

    const thinking = derivePendingIndicatorPresentation('stream-open', {
        kind: 'access',
        phase: 'proving'
    });
    assert.equal(thinking.mode, 'thinking');
    assert.equal(thinking.current, 'Thinking');
    assert.deepEqual(thinking.steps, []);
});

test('retry progress exposes only known client-authored status copy', async () => {
    const { derivePendingIndicatorPresentation } = await import(streamingStateUrl);
    const expected = 'OA is briefly limiting new temporary keys. Retrying in 2 seconds…';
    const known = derivePendingIndicatorPresentation('requesting-key', {
        kind: 'access',
        phase: 'waiting',
        message: expected
    });
    assert.equal(known.current, expected);
    assert.equal(known.steps[3].state, 'waiting');

    const untrusted = derivePendingIndicatorPresentation('requesting-key', {
        kind: 'access',
        phase: 'waiting',
        message: '<img src=x onerror=steal()> arbitrary server detail'
    });
    assert.equal(untrusted.current, 'Waiting briefly before retrying temporary key creation…');
    assert.doesNotMatch(JSON.stringify(untrusted), /<img|onerror|arbitrary server detail/);
});

test('private-access failures stay attached to the step that actually failed', async () => {
    const { derivePendingIndicatorPresentation } = await import(streamingStateUrl);
    const verificationFailure = derivePendingIndicatorPresentation('requesting-key', {
        kind: 'access',
        phase: 'error',
        failedPhase: 'verifying'
    });
    assert.deepEqual(
        verificationFailure.steps.map(step => step.state),
        ['complete', 'complete', 'complete', 'complete', 'error']
    );

    const proofCancellation = derivePendingIndicatorPresentation('requesting-key', {
        kind: 'access',
        phase: 'canceled',
        failedPhase: 'proving'
    });
    assert.deepEqual(
        proofCancellation.steps.map(step => step.state),
        ['complete', 'complete', 'canceled', 'upcoming', 'upcoming']
    );
});

test('ordinary key refresh is distinct from unfinished-key recovery', async () => {
    const { derivePendingIndicatorPresentation } = await import(streamingStateUrl);
    const renewal = derivePendingIndicatorPresentation('requesting-key', {
        kind: 'renewal',
        phase: 'proving'
    });
    assert.equal(renewal.kind, 'renewal');
    assert.equal(renewal.category, 'Refreshing private access');
    assert.equal(renewal.current, 'Generating a fresh zero-knowledge funding proof…');
    assert.equal(renewal.steps.length, 8);
    assert.equal(renewal.steps[5].state, 'active');
    assert.doesNotMatch(JSON.stringify(renewal), /unfinished key/i);

    const recovery = derivePendingIndicatorPresentation('requesting-key', {
        kind: 'recovery',
        phase: 'settling'
    });
    assert.equal(recovery.kind, 'recovery');
    assert.match(recovery.current, /unfinished private key/i);
});

test('queued messages describe the real settlement phase before fresh access starts', async () => {
    const { derivePendingIndicatorPresentation } = await import(streamingStateUrl);
    const usage = derivePendingIndicatorPresentation('settling-previous', {
        kind: 'settlement',
        phase: 'usage'
    });
    assert.equal(usage.kind, 'settlement');
    assert.equal(usage.current, 'Confirming the previous chat’s usage…');
    assert.deepEqual(usage.steps.map(step => step.state), ['complete', 'active', 'upcoming']);

    const applying = derivePendingIndicatorPresentation('settling-previous', {
        kind: 'settlement',
        phase: 'applying'
    });
    assert.equal(applying.current, 'Updating your private balance…');
    assert.deepEqual(applying.steps.map(step => step.state), ['complete', 'complete', 'active']);
});

test('OA SSE transport delivers complete lines before the response finishes', async () => {
    const { consumeSseBody } = await import(moduleUrl);
    const encoder = new TextEncoder();
    let sendSecondChunk;
    const waitForSecondChunk = new Promise(resolve => { sendSecondChunk = resolve; });
    let firstChunkObserved;
    const observedFirstChunk = new Promise(resolve => { firstChunkObserved = resolve; });
    const lines = [];

    const body = new ReadableStream({
        async start(controller) {
            controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"hel'));
            controller.enqueue(encoder.encode('lo"}}]}\n'));
            await waitForSecondChunk;
            controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":" world"}}]}\r\n'));
            controller.enqueue(encoder.encode('data: [DONE]\n'));
            controller.close();
        }
    });

    const consuming = consumeSseBody(body, line => {
        lines.push(line);
        if (lines.length === 1) firstChunkObserved();
    });

    await observedFirstChunk;
    assert.deepEqual(lines, ['data: {"choices":[{"delta":{"content":"hello"}}]}']);
    sendSecondChunk();
    await consuming;
    assert.deepEqual(lines, [
        'data: {"choices":[{"delta":{"content":"hello"}}]}',
        'data: {"choices":[{"delta":{"content":" world"}}]}',
        'data: [DONE]'
    ]);
});

test('OA SSE transport preserves delta order while the first async handler initializes the message', async () => {
    const { consumeSseBody } = await import(moduleUrl);
    const encoder = new TextEncoder();
    let releaseFirstHandler;
    const firstHandlerGate = new Promise(resolve => { releaseFirstHandler = resolve; });
    let firstHandlerStarted;
    const observedFirstHandler = new Promise(resolve => { firstHandlerStarted = resolve; });
    let assembled = '';
    let secondHandlerStarted = false;

    const body = new ReadableStream({
        start(controller) {
            controller.enqueue(encoder.encode('Here\n\u2019s a concise list\n'));
            controller.close();
        }
    });

    const consuming = consumeSseBody(body, async line => {
        if (line === 'Here') {
            firstHandlerStarted();
            // Mirrors the first streaming callback awaiting message persistence
            // and insertion before it appends its content.
            await firstHandlerGate;
        } else {
            secondHandlerStarted = true;
        }
        assembled += line;
    });

    await observedFirstHandler;
    await Promise.resolve();
    assert.equal(secondHandlerStarted, false, 'a later delta must not overtake first-message setup');

    releaseFirstHandler();
    await consuming;
    assert.equal(assembled, 'Here\u2019s a concise list');
});

test('OpenRouter stream does not dispatch a later delta while delayed first onChunk clears sending state', async () => {
    const { openRouterApi, zkapiClient } = await loadOpenRouterApiForStreamingTest();
    const encoder = new TextEncoder();
    let releaseFirstChunk;
    const firstChunkGate = new Promise(resolve => { releaseFirstChunk = resolve; });
    let firstChunkStarted;
    const observedFirstChunk = new Promise(resolve => { firstChunkStarted = resolve; });
    let content = '';
    let secondChunkStarted = false;
    let firstChunkEntered = false;
    let callbackCount = 0;
    let sendingStateCleared = false;
    let accessReleased = false;

    const body = new ReadableStream({
        start(controller) {
            controller.enqueue(encoder.encode(
                'data: {"choices":[{"delta":{"content":"Here"}}]}\n' +
                'data: {"choices":[{"delta":{"content":"\u2019s a concise list"}}]}\n' +
                'data: [DONE]\n'
            ));
            controller.close();
        }
    });

    zkapiClient.acquireInferenceAccess = async () => ({
        baseUrl: 'https://example.test/v1',
        headers: {},
        spendingLimitUsd: 5,
        release() { accessReleased = true; }
    });
    zkapiClient.refresh = async () => {};
    openRouterApi.fetchWithRetry = async () => ({
        ok: true,
        status: 200,
        body
    });

    const streaming = openRouterApi.streamCompletion(
        [{ role: 'user', content: 'List privacy tips' }],
        'openai/test-model',
        'session-ordering',
        async chunk => {
            callbackCount += 1;
            if (!firstChunkEntered) {
                firstChunkEntered = true;
                firstChunkStarted();
                // The production handler awaits clearing the durable user-message
                // delivery state before it appends the first assistant delta.
                await firstChunkGate;
                sendingStateCleared = true;
            } else {
                secondChunkStarted = true;
            }
            content += chunk;
        },
        () => {},
        [],
        false,
        new AbortController()
    );

    let streamingSettled = false;
    void streaming.finally(() => { streamingSettled = true; });

    await observedFirstChunk;
    await Promise.resolve();
    assert.equal(callbackCount, 1, 'only the first callback may enter while its setup is pending');
    assert.equal(secondChunkStarted, false, 'the next delta must wait for first-chunk state setup');
    assert.equal(streamingSettled, false, 'the stream must remain pending with its first callback');
    assert.equal(accessReleased, false, 'the proof-backed key must remain checked out until callbacks finish');

    releaseFirstChunk();
    await streaming;
    assert.equal(content, 'Here\u2019s a concise list');
    assert.equal(sendingStateCleared, true);
    assert.equal(accessReleased, true);
});

test('OpenRouter [DONE] ends a stream even when the HTTP response remains open', async () => {
    const { openRouterApi, zkapiClient } = await loadOpenRouterApiForStreamingTest();
    const encoder = new TextEncoder();
    let readerCancelled = false;
    let timeoutId;
    const body = new ReadableStream({
        start(controller) {
            controller.enqueue(encoder.encode(
                'data: {"choices":[{"delta":{"content":"complete"}}]}\n' +
                'data: [DONE]\n'
            ));
            // Deliberately leave the response open. [DONE] is the SSE terminator.
        },
        cancel() {
            readerCancelled = true;
        }
    });

    zkapiClient.acquireInferenceAccess = async () => ({
        baseUrl: 'https://example.test/v1',
        headers: {},
        spendingLimitUsd: 5,
        release() {}
    });
    zkapiClient.refresh = async () => {};
    openRouterApi.fetchWithRetry = async () => ({ ok: true, status: 200, body });

    try {
        const result = await Promise.race([
            openRouterApi.streamCompletion(
                [{ role: 'user', content: 'finish' }],
                'openai/test-model',
                'session-done',
                () => {},
                () => {}
            ),
            new Promise((_, reject) => {
                timeoutId = setTimeout(() => reject(new Error('[DONE] did not terminate the stream')), 250);
            })
        ]);
        assert.equal(result.model, 'openai/test-model');
        assert.equal(readerCancelled, true);
    } finally {
        clearTimeout(timeoutId);
    }
});

test('OpenRouter null usage cost remains unknown while an exact zero remains authoritative', async () => {
    const { openRouterApi, zkapiClient } = await loadOpenRouterApiForStreamingTest();
    const encoder = new TextEncoder();
    zkapiClient.acquireInferenceAccess = async () => ({
        baseUrl: 'https://example.test/v1',
        headers: {},
        spendingLimitUsd: 1,
        release() {}
    });
    zkapiClient.refresh = async () => {};

    for (const [providerCost, expected] of [[null, null], [0, 0]]) {
        const body = new ReadableStream({
            start(controller) {
                controller.enqueue(encoder.encode(
                    `data: ${JSON.stringify({
                        model: 'openai/gpt-5.6-sol',
                        usage: {
                            prompt_tokens: 12,
                            completion_tokens: 3,
                            total_tokens: 15,
                            cost: providerCost
                        },
                        choices: [{ delta: {} }]
                    })}\n` +
                    'data: [DONE]\n'
                ));
                controller.close();
            }
        });
        openRouterApi.fetchWithRetry = async () => ({ ok: true, status: 200, body });
        const updates = [];
        const result = await openRouterApi.streamCompletion(
            [{ role: 'user', content: 'cost accounting' }],
            'openai/gpt-5.6-sol',
            `session-cost-${String(providerCost)}`,
            () => {},
            usage => updates.push(usage)
        );
        assert.equal(result.cost, expected);
        assert.equal(updates.at(-1).cost, expected);
        assert.equal(result.totalTokens, 15);
    }
});

test('OpenRouter provider error events reject instead of finalizing a truncated response', async () => {
    const { openRouterApi, zkapiClient } = await loadOpenRouterApiForStreamingTest();
    const encoder = new TextEncoder();
    let content = '';
    const body = new ReadableStream({
        start(controller) {
            controller.enqueue(encoder.encode(
                'data: {"choices":[{"delta":{"content":"partial"}}]}\n' +
                'data: {"error":{"message":"provider failed","code":"upstream_error"}}\n'
            ));
            controller.close();
        }
    });

    zkapiClient.acquireInferenceAccess = async () => ({
        baseUrl: 'https://example.test/v1',
        headers: {},
        spendingLimitUsd: 5,
        release() {}
    });
    zkapiClient.refresh = async () => {};
    openRouterApi.fetchWithRetry = async () => ({ ok: true, status: 200, body });

    const originalConsoleError = console.error;
    console.error = () => {};
    try {
        await assert.rejects(
            openRouterApi.streamCompletion(
                [{ role: 'user', content: 'fail after a token' }],
                'openai/test-model',
                'session-provider-error',
                chunk => { content += chunk || ''; },
                () => {}
            ),
            error => {
                assert.equal(error.message, 'provider failed');
                assert.equal(error.code, 'upstream_error');
                assert.equal(error.isStreamError, true);
                assert.equal(error.hasReceivedTokens, true);
                return true;
            }
        );
    } finally {
        console.error = originalConsoleError;
    }
    assert.equal(content, 'partial');
});

test('reasoning flush finishes before content and surfaces timer callback failures safely', async () => {
    const { openRouterApi, zkapiClient } = await loadOpenRouterApiForStreamingTest();
    const encoder = new TextEncoder();
    const events = [];
    let releaseReasoning;
    const reasoningGate = new Promise(resolve => { releaseReasoning = resolve; });
    let reasoningStarted;
    const observedReasoning = new Promise(resolve => { reasoningStarted = resolve; });
    const orderedBody = new ReadableStream({
        start(controller) {
            controller.enqueue(encoder.encode(
                'data: {"choices":[{"delta":{"reasoning":"think"}}]}\n' +
                'data: {"choices":[{"delta":{"content":"answer"}}]}\n' +
                'data: [DONE]\n'
            ));
            controller.close();
        }
    });

    zkapiClient.acquireInferenceAccess = async () => ({
        baseUrl: 'https://example.test/v1',
        headers: {},
        spendingLimitUsd: 5,
        release() {}
    });
    zkapiClient.refresh = async () => {};
    openRouterApi.fetchWithRetry = async () => ({ ok: true, status: 200, body: orderedBody });

    const orderedStream = openRouterApi.streamCompletion(
        [{ role: 'user', content: 'reason first' }],
        'openai/test-model',
        'session-reasoning-order',
        chunk => { events.push(`content:${chunk}`); },
        () => {},
        [],
        false,
        null,
        null,
        async chunk => {
            reasoningStarted();
            await reasoningGate;
            events.push(`reasoning:${chunk}`);
        }
    );

    await observedReasoning;
    await Promise.resolve();
    assert.deepEqual(events, []);
    releaseReasoning();
    await orderedStream;
    assert.deepEqual(events, ['reasoning:think', 'content:answer']);

    const failingBody = new ReadableStream({
        start(controller) {
            controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"reasoning":"fail"}}]}\n'));
            setTimeout(() => controller.enqueue(encoder.encode('data: [DONE]\n')), 80);
        }
    });
    openRouterApi.fetchWithRetry = async () => ({ ok: true, status: 200, body: failingBody });
    let unhandledReason = null;
    const onUnhandled = reason => { unhandledReason = reason; };
    process.once('unhandledRejection', onUnhandled);
    const originalConsoleError = console.error;
    console.error = () => {};
    try {
        await assert.rejects(
            openRouterApi.streamCompletion(
                [{ role: 'user', content: 'reason failure' }],
                'openai/test-model',
                'session-reasoning-failure',
                () => {},
                () => {},
                [],
                false,
                null,
                null,
                async () => { throw new Error('reasoning render failed'); }
            ),
            /reasoning render failed/
        );
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(unhandledReason, null);
    } finally {
        process.removeListener('unhandledRejection', onUnhandled);
        console.error = originalConsoleError;
    }
});

test('aborting while the first onChunk is pending cancels before later deltas or finalization', async () => {
    const { openRouterApi, zkapiClient } = await loadOpenRouterApiForStreamingTest();
    const encoder = new TextEncoder();
    const abortController = new AbortController();
    let releaseChunk;
    const chunkGate = new Promise(resolve => { releaseChunk = resolve; });
    let chunkStarted;
    const observedChunk = new Promise(resolve => { chunkStarted = resolve; });
    let callbackCount = 0;
    const body = new ReadableStream({
        start(controller) {
            controller.enqueue(encoder.encode(
                'data: {"choices":[{"delta":{"content":"first"}}]}\n' +
                'data: {"choices":[{"delta":{"content":"second"}}]}\n' +
                'data: [DONE]\n'
            ));
        }
    });

    zkapiClient.acquireInferenceAccess = async () => ({
        baseUrl: 'https://example.test/v1',
        headers: {},
        spendingLimitUsd: 5,
        release() {}
    });
    zkapiClient.refresh = async () => {};
    openRouterApi.fetchWithRetry = async () => ({ ok: true, status: 200, body });

    const originalConsoleError = console.error;
    console.error = () => {};
    try {
        const streaming = openRouterApi.streamCompletion(
            [{ role: 'user', content: 'abort' }],
            'openai/test-model',
            'session-abort-order',
            async () => {
                callbackCount += 1;
                chunkStarted();
                await chunkGate;
            },
            () => {},
            [],
            false,
            abortController
        );
        await observedChunk;
        abortController.abort();
        releaseChunk();
        await assert.rejects(streaming, error => error?.isCancelled === true);
    } finally {
        console.error = originalConsoleError;
    }
    assert.equal(callbackCount, 1);
});
