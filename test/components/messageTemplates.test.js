import test from 'node:test';
import assert from 'node:assert/strict';
import { restoredResponseForDisplay, wasReplyStreaming } from '../../chat/ui/restoredResponse.js';
import { OWNERSHIP_ELSEWHERE, OWNERSHIP_NONE, OWNERSHIP_UNKNOWN } from '../../chat/services/turnOwnership.js';

function installTemplateGlobals() {
    const originalDocument = globalThis.document;
    const originalWindow = globalThis.window;
    globalThis.document = {
        createElement() {
            return {
                _text: '',
                set textContent(value) {
                    this._text = String(value || '');
                    this.innerHTML = this._text
                        .replace(/&/g, '&amp;')
                        .replace(/</g, '&lt;')
                        .replace(/>/g, '&gt;')
                        .replace(/"/g, '&quot;')
                        .replace(/'/g, '&#39;');
                },
                get textContent() {
                    return this._text;
                },
                innerHTML: ''
            };
        }
    };
    globalThis.window = {
        location: {
            hostname: 'localhost'
        },
        app: {
            getDefaultModelName() {
                return 'OpenAI: GPT-5.3 Instant';
            }
        }
    };
    return () => {
        if (originalDocument === undefined) delete globalThis.document;
        else globalThis.document = originalDocument;
        if (originalWindow === undefined) delete globalThis.window;
        else globalThis.window = originalWindow;
    };
}

function escapeHtml(value) {
    return String(value || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

test('a saved pending response is displayed as disconnected without changing stored state or starting work', async () => {
    const restoreGlobals = installTemplateGlobals();
    try {
        const { buildMessageHTML } = await import('../../chat/components/MessageTemplates.js');
        for (const phase of ['requesting-key', 'waiting-response']) {
            const saved = Object.freeze({ id: 'saved', sessionId: 'chat', role: 'assistant',
                content: '', model: 'Test', timestamp: 1, streamingPending: true,
                streamingPhase: phase, streamingTokens: 0,
                accessTrace: Object.freeze({ category: 'Private access', steps: Object.freeze([
                    Object.freeze({id:'verify',label:'Verify private key',state:'active'})
                ]) }) });
            const display = restoredResponseForDisplay(saved, false);
            const html = buildMessageHTML(display, {processContentWithLatex:escapeHtml,formatTime:()=>''}, [], 'Test');
            assert.doesNotMatch(html, /data-streaming-pending="true"/);
            assert.match(html, /no longer connected/);
            assert.doesNotMatch(html, /Retrying sends a new request/);
            assert.match(html, /class="[^"]*response-error/);
            assert.doesNotMatch(html, /Model provider returned no response/);
            assert.doesNotMatch(html, /Private access secured|Verify private key/);
            assert.equal(saved.accessTrace.steps[0].state, 'active');
            assert.equal(saved.streamingPending, true, 'another tab may still own the stored response');
            assert.equal(saved.streamingPhase, phase);
            assert.equal(saved.inferenceError, undefined, 'notice must never enter saved history or model context');
            assert.equal(display.content, saved.content);
        }
    } finally { restoreGlobals(); }
});

test('a pending turn saved before the first chunk is displayed as an interrupted reply with retry', async () => {
    const restoreGlobals = installTemplateGlobals();
    try {
        const { buildMessageHTML } = await import('../../chat/components/MessageTemplates.js');
        const saved = Object.freeze({ id: 'pending', sessionId: 'chat', role: 'assistant',
            content: '', model: 'Test', timestamp: 1, streamingPending: true,
            streamingPhase: 'requesting-key', streamingTokens: 0,
            isLocalOnly: true, pendingTurn: true });
        const display = restoredResponseForDisplay(saved, false);
        assert.match(display.inferenceError, /no reply was received/);
        assert.match(display.inferenceError, /Check any other open tab before retrying\.$/);
        const html = buildMessageHTML(display, {processContentWithLatex:escapeHtml,formatTime:()=>''}, [], 'Test');
        assert.match(html, /response-error/);
        assert.match(html, /regenerate-message-btn/);
        assert.doesNotMatch(html, /data-streaming-pending="true"/);
        assert.doesNotMatch(html, /Model provider returned no response/);
        assert.equal(restoredResponseForDisplay(saved, true), saved, 'a live pending turn in this tab is untouched');
        // A local-only row that is not a pending turn keeps the old behaviour.
        assert.equal(restoredResponseForDisplay({ ...saved, pendingTurn: false }, false).inferenceError, undefined);
    } finally { restoreGlobals(); }
});

test('a reply another tab is still writing is shown as answering elsewhere, with no error and no actions', async () => {
    const restoreGlobals = installTemplateGlobals();
    try {
        const { buildMessageHTML } = await import('../../chat/components/MessageTemplates.js');
        const helpers = { processContentWithLatex: escapeHtml, formatTime: () => '' };
        const placeholder = Object.freeze({ id: 'row', sessionId: 'chat', role: 'assistant', content: '', model: 'Test',
            timestamp: 1, streamingPending: true, streamingPhase: 'requesting-key', streamingTokens: 0 });
        const partial = Object.freeze({ ...placeholder, streamingPending: false, content: 'Half an answer', streamingTokens: 4 });
        const pendingTurn = Object.freeze({ ...placeholder, isLocalOnly: true, pendingTurn: true });
        for (const saved of [placeholder, partial, pendingTurn]) {
            assert.equal(wasReplyStreaming(saved), true);
            const display = restoredResponseForDisplay(saved, false, OWNERSHIP_ELSEWHERE);
            assert.equal(display.answeringElsewhere, true);
            assert.equal(display.inferenceError, undefined);
            assert.equal(display.streamingPending, false);
            assert.equal(display.streamingTokens, null);
            assert.equal(display.content, saved.content, 'what has arrived so far stays visible');
            const html = buildMessageHTML(display, helpers, [], 'Test');
            assert.match(html, /Answering in another tab/);
            assert.match(html, /pending-response-streaming/);
            assert.doesNotMatch(html, /response-error|no longer connected|connection to this/);
            assert.doesNotMatch(html, /copy-message-btn|regenerate-message-btn/, 'no actions on a reply still being written');
            assert.doesNotMatch(html, /Model provider returned no response/);
            assert.doesNotMatch(html, /data-streaming-pending="true"/);
            assert.equal(saved.streamingPending, placeholder === saved || pendingTurn === saved, 'stored state untouched');
        }
        // A reply that already carries its own error keeps it, whoever holds the turn.
        const failed = { ...partial, inferenceError: 'Provider error' };
        assert.equal(restoredResponseForDisplay(failed, false, OWNERSHIP_ELSEWHERE).inferenceError, 'Provider error');
        assert.equal(restoredResponseForDisplay(failed, false, OWNERSHIP_ELSEWHERE).answeringElsewhere, undefined);
        // This tab's own live reply is never normalized, whatever the lock says.
        assert.equal(restoredResponseForDisplay(partial, true, OWNERSHIP_ELSEWHERE), partial);
        assert.equal(wasReplyStreaming({ role: 'assistant', content: 'done', streamingTokens: null }), false);
        assert.equal(wasReplyStreaming({ role: 'user', streamingPending: true }), false);
    } finally { restoreGlobals(); }
});

test('the interrupted copy says what the turn lock knows: connection lost, or check other tabs when it cannot tell', async () => {
    const restoreGlobals = installTemplateGlobals();
    try {
        const { buildMessageHTML } = await import('../../chat/components/MessageTemplates.js');
        const helpers = { processContentWithLatex: escapeHtml, formatTime: () => '' };
        const reply = Object.freeze({ id: 'row', sessionId: 'chat', role: 'assistant', content: 'Half an answer',
            model: 'Test', timestamp: 1, streamingTokens: 4 });
        const pendingTurn = Object.freeze({ ...reply, content: '', streamingPending: true, streamingTokens: 0,
            isLocalOnly: true, pendingTurn: true });
        // Nobody holds the turn: the tab that was writing it is gone.
        const lost = restoredResponseForDisplay(reply, false, OWNERSHIP_NONE);
        assert.match(lost.inferenceError, /^The connection to this reply was lost before it finished\.$/);
        assert.doesNotMatch(lost.inferenceError, /other open tab/);
        assert.match(restoredResponseForDisplay(pendingTurn, false, OWNERSHIP_NONE).inferenceError,
            /^The connection to this request was lost before a reply arrived\.$/);
        const html = buildMessageHTML(lost, helpers, [], 'Test');
        assert.match(html, /response-error/);
        assert.doesNotMatch(html, /Answering in another tab/);
        // No Web Locks (or no answer): the cautious copy stays.
        for (const ownership of [OWNERSHIP_UNKNOWN, null, undefined]) {
            assert.match(restoredResponseForDisplay(reply, false, ownership).inferenceError,
                /no longer connected to the response\. Check any other open tab/);
            assert.match(restoredResponseForDisplay(pendingTurn, false, ownership).inferenceError,
                /no reply was received\. Check any other open tab/);
        }
    } finally { restoreGlobals(); }
});

test('restored partial output is retained while live and completed messages stay unchanged', () => {
    const images = [{ url: 'data:image/png;base64,example' }];
    const saved = Object.freeze({ role: 'assistant', content: 'Partial answer', reasoning: 'Partial reasoning',
        images, streamingReasoning: true, streamingTokens: 4 });
    const display = restoredResponseForDisplay(saved, false);
    assert.equal(display.content, saved.content);
    assert.equal(display.reasoning, saved.reasoning);
    assert.equal(display.images, images);
    assert.equal(display.streamingReasoning, false);
    assert.equal(display.streamingTokens, null);
    assert.equal(restoredResponseForDisplay(saved, true), saved, 'switching between live chats must not interrupt them');
    for (const message of [
        { role: 'assistant', content: 'Older complete answer' },
        { role: 'assistant', content: 'Complete answer', streamingPending: false, streamingReasoning: false, streamingTokens: null },
        { role: 'user', content: 'Prompt left before a key returned' }
    ]) assert.equal(restoredResponseForDisplay(message, false), message);
    const withError = { ...saved, inferenceError: 'Original provider error' };
    assert.equal(restoredResponseForDisplay(withError, false).inferenceError, withError.inferenceError);
    const completedTrace = { category: 'Private access', steps: [{state:'complete'}] };
    assert.deepEqual(restoredResponseForDisplay({...saved,accessTrace:completedTrace}, false).accessTrace, [completedTrace]);
    for (const accessTrace of [null, {steps:'bad'}, {steps:[null]}, {steps:[]}, [null]]) {
        assert.deepEqual(restoredResponseForDisplay({...saved,accessTrace}, false).accessTrace, []);
    }
    for (const workflow of [{council:{enabled:true}}, {model:'Memory Agent'}, {isLocalOnly:true}]) {
        const specialized = { ...saved, ...workflow };
        assert.equal(restoredResponseForDisplay(specialized, false).inferenceError, undefined,
            'specialized workflows must not acquire a generic inference retry control');
    }
});

test('interrupted answers keep their content and show an escaped error with retry', async () => {
    const restoreGlobals = installTemplateGlobals();
    try {
        const { buildMessageHTML } = await import('../../chat/components/MessageTemplates.js');
        const message = {id:'partial-answer',role:'assistant',content:'Partial answer',model:'Test',timestamp:new Date().toISOString()};
        const render = value => buildMessageHTML(value,{processContentWithLatex:escapeHtml,formatTime:()=>''},[],'Test');
        assert.doesNotMatch(render(message), /response-error/);
        const html = render({...message,inferenceError:'Response interrupted <script>alert(1)</script>'});
        assert.match(html, /Partial answer/);
        // The same line as a reply that failed before any text, after the answer.
        assert.match(html, /class="[^"]*response-error"[\s\S]*<strong>Error:<\/strong> Response interrupted &lt;script&gt;/);
        assert.ok(html.indexOf('Partial answer') < html.indexOf('response-error'));
        assert.doesNotMatch(html, /<script>|inference-failure-warning|Retry response/);
        assert.match(html, /regenerate-message-btn/, 'retry is the action row');
    } finally { restoreGlobals(); }
});

test('memory agent failures use the same compact status presentation as an empty retrieval', async () => {
    const restoreGlobals = installTemplateGlobals();
    const originalWarn = console.warn;
    const originalError = console.error;
    console.warn = () => {};
    console.error = () => {};

    try {
        const { buildMessageHTML } = await import('../../chat/components/MessageTemplates.js');

        const html = buildMessageHTML({
            id: 'memory-failure',
            role: 'assistant',
            model: 'memory agent',
            timestamp: new Date('2026-07-02T08:15:12Z').toISOString(),
            content: 'No added memory. Sending original prompt.',
            isLocalOnly: true,
            memoryRetrievalFailure: {
                kind: 'network',
                title: 'Connection issue <script>',
                detail: 'The app could not reach the confidential memory service. Check your connection and try again. api_key=secret <img>'
            }
        }, {
            processContentWithLatex: escapeHtml,
            formatTime: () => '18:15:12'
        }, [], 'memory agent');

        assert.match(html, /No added memory\. Sending original prompt\./);
        assert.doesNotMatch(html, /memory-failure-detail|Note:|Connection issue/);
        assert.doesNotMatch(html, /confidential memory service|Check your connection|script|img|api_key=secret|<script>|<img>/);
    } finally {
        await new Promise((resolve) => setTimeout(resolve, 0));
        console.warn = originalWarn;
        console.error = originalError;
        restoreGlobals();
    }
});

test('assistant model IDs use author providers without family-logo guessing', async () => {
    const restoreGlobals = installTemplateGlobals();
    try {
        const { buildMessageHTML } = await import('../../chat/components/MessageTemplates.js');
        const helpers = { processContentWithLatex: escapeHtml, formatTime: () => '18:15:12' };

        const downstream = buildMessageHTML({
            id: 'downstream', role: 'assistant', model: 'future-lab/llama-model', content: 'hello'
        }, helpers, [], 'future-lab/llama-model');
        assert.match(downstream, /data-provider-icon-fallback[^>]*>F<\/span>/);
        assert.doesNotMatch(downstream, /img\/meta\.svg/);

        const unresolved = buildMessageHTML({
            id: 'unresolved', role: 'assistant', model: 'arbitrary model', content: 'hello'
        }, helpers, [], 'arbitrary model');
        assert.match(unresolved, /data-provider-icon-fallback[^>]*>A<\/span>/);
        assert.doesNotMatch(unresolved, /img\/openai\.svg/);
    } finally {
        restoreGlobals();
    }
});

test('only output-limited assistant responses offer an explicit continuation action', async () => {
    const restoreGlobals = installTemplateGlobals();
    try {
        const { buildMessageHTML } = await import('../../chat/components/MessageTemplates.js');
        const helpers = { processContentWithLatex: escapeHtml, formatTime: () => '18:15:12' };
        const response = { id: 'limited-response', role: 'assistant', model: 'openai/example', content: 'Partial response' };
        const limited = buildMessageHTML({ ...response, finishReason: 'length' }, helpers, [], response.model);
        assert.match(limited, /Output limit reached/);
        assert.match(limited, /continue-message-btn/);
        assert.match(limited, /aria-label="Continue this response"/);
        assert.equal((limited.match(/continue-message-btn/g) || []).length, 1);
        assert.doesNotMatch(buildMessageHTML({ ...response, finishReason: 'stop' }, helpers, [], response.model), /continue-message-btn|Output limit reached/);
        assert.doesNotMatch(buildMessageHTML({ ...response, role: 'user', finishReason: 'length' }, helpers, [], response.model), /continue-message-btn|Output limit reached/);
    } finally {
        restoreGlobals();
    }
});

test('resolved response models render with their provider and escape unknown labels', async () => {
    const restoreGlobals = installTemplateGlobals();
    try {
        const { buildMessageHTML } = await import('../../chat/components/MessageTemplates.js');
        const helpers = { processContentWithLatex: escapeHtml, formatTime: () => '18:15:12' };
        const message = { id: 'routed', role: 'assistant', model: 'Anthropic: Claude Example', content: 'Hello' };
        const html = buildMessageHTML(message, helpers, [
            { id: 'anthropic/example', name: message.model, provider: 'Anthropic' }
        ], 'Auto Router');
        assert.match(html, /data-assistant-model-name[^>]*>Claude Example<\/span>/);
        assert.match(html, /img\/claude\.svg/);
        assert.doesNotMatch(html, /Auto Router/);
        for (const streamingPending of [true, false]) {
            const unsafe = buildMessageHTML({ ...message, model: '<img src=x onerror=alert(1)>', streamingPending }, helpers, [], 'Auto Router');
            assert.match(unsafe, /&lt;img src=x onerror=alert\(1\)&gt;/);
            assert.doesNotMatch(unsafe, /<img src=x/);
        }
    } finally { restoreGlobals(); }
});

test('Parallel and Council render response attribution without changing requested lane models', async () => {
    const restoreGlobals = installTemplateGlobals();
    try {
        const { buildMessageHTML } = await import('../../chat/components/MessageTemplates.js');
        const helpers = { processContentWithLatex: escapeHtml, formatTime: () => '18:15:12' };
        const message = {
            id: 'routed-council', role: 'assistant', model: 'Council', content: '',
            council: {
                enabled: true, currentStage: 'complete', outputMode: 'synthesis',
                stage1: [
                    { label: 'Response A', laneId: 'primary', model: 'Auto Router', modelId: 'openrouter/auto', responseModel: 'Anthropic: Claude Example', status: 'complete', response: '' },
                    { label: 'Response B', laneId: 'secondary', model: 'Auto Router', modelId: 'openrouter/auto', status: 'pending' }
                ],
                synthesis: { model: 'Auto Router', modelId: 'openrouter/auto', responseModel: 'OpenAI: GPT Example', status: 'complete', response: '' }
            }
        };
        const html = buildMessageHTML(message, helpers, [], 'Auto Router');
        assert.match(html, /Claude Example/);
        assert.match(html, /img\/claude\.svg/);
        assert.match(html, /GPT Example/);
        assert.match(html, /img\/openai\.svg/);
        assert.match(html, /Auto Router/);
        assert.equal(message.council.stage1[0].modelId, 'openrouter/auto');
        assert.equal(message.council.synthesis.model, 'Auto Router');
    } finally { restoreGlobals(); }
});

test('standalone typing indicators expose session and model hooks for pre-output attribution', async () => {
    const restoreGlobals = installTemplateGlobals();
    try {
        const { buildTypingIndicator } = await import('../../chat/components/MessageTemplates.js');
        const html = buildTypingIndicator('pending-response', 'OpenRouter', 'Auto Router',
            Date.parse('2026-07-02T08:15:12Z'), 'waiting-response', null, 'session-one');
        assert.match(html, /class="typing-indicator[^>]*data-pending-session-id="session-one"/);
        assert.match(html, /data-phase="waiting-response"/);
        assert.match(html, /data-assistant-model-name[^>]*>Auto Router<\/span>/);
        assert.match(html, /<div data-assistant-model-icon\b/);
        assert.match(html, /Waiting for response/);
    } finally { restoreGlobals(); }
});

test('a failed Parallel lane reads as one plain sentence with a way to try again', async () => {
    const restoreGlobals = installTemplateGlobals();
    try {
        const { buildMessageHTML } = await import('../../chat/components/MessageTemplates.js');
        const helpers = { processContentWithLatex: escapeHtml, formatTime: () => '' };
        const lanes = [
            { label: 'Response A', laneId: 'primary', model: 'GPT', status: 'complete', response: 'Hello' },
            { label: 'Response B', laneId: 'secondary', model: 'Image', status: 'error', error: 'Request failed. (HTTP 429)' }
        ];
        const parallel = buildMessageHTML({
            id: 'm1', role: 'assistant', model: 'Parallel', content: 'Hello',
            council: { enabled: true, stage1: lanes, errors: [{ model: 'Image', message: 'Request failed. (HTTP 429)' }] }
        }, helpers, [], 'GPT');
        assert.match(parallel, /response-error[\s\S]*<strong>Error:<\/strong> The model is temporarily busy\. Please try again\./);
        assert.match(parallel, /regenerate-council-lane-btn[\s\S]*data-council-lane-id="secondary"/);
        assert.doesNotMatch(parallel, /council-lane-error|council-lane-retry-btn/);
        assert.doesNotMatch(parallel, /model request failed|Request failed\.|council-stage-warning|>Failed</);

        // With a Council review the lane cannot be retried on its own.
        const council = buildMessageHTML({
            id: 'm2', role: 'assistant', model: 'Council', content: '',
            council: { enabled: true, stage1: lanes, synthesis: { model: 'Fable', status: 'partial', response: 'Review' } }
        }, helpers, [], 'GPT');
        assert.match(council, /The model is temporarily busy\. Please try again\./);
        assert.doesNotMatch(council, /data-council-lane-id="secondary"[^>]*data-tooltip="Regenerate/);
    } finally { restoreGlobals(); }
});

test('lane images render, and a quiet running lane says it is still working', async () => {
    const restoreGlobals = installTemplateGlobals();
    try {
        const { buildMessageHTML } = await import('../../chat/components/MessageTemplates.js');
        const helpers = { processContentWithLatex: escapeHtml, formatTime: () => '' };
        const image = { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } };
        const html = buildMessageHTML({
            id: 'm3', role: 'assistant', model: 'Parallel', content: '',
            council: { enabled: true, stage1: [
                { label: 'Response A', laneId: 'primary', model: 'Image', status: 'complete', response: '', images: [image] },
                { label: 'Response B', laneId: 'secondary', model: 'GPT Image', status: 'running', response: 'Making it now.', stillWorking: true, stillWorkingSince: Date.now() - 4200 }
            ] }
        }, helpers, [], 'Image');
        assert.match(html, /class="council-lane-images"[\s\S]*data:image\/png;base64,AAAA/);
        assert.doesNotMatch(html, /copy-council-lane-btn/, 'image-only answers have nothing to copy as text');
        assert.match(html, /regenerate-council-lane-btn/, 'image-only answers can still regenerate');
        assert.match(html, /Still working<span aria-hidden="true"> · <span class="still-working-seconds">4<\/span>s<\/span>/, 'the lane says how long it has been quiet');
        assert.match(html, /data-still-working-since="\d+"/, 'a re-render keeps counting from the stored start');

        const streaming = buildMessageHTML({
            id: 'm4', role: 'assistant', model: 'Parallel', content: '',
            council: { enabled: true, stage1: [
                { label: 'Response A', laneId: 'primary', model: 'GPT', status: 'running', response: 'Streaming text' }
            ] }
        }, helpers, [], 'GPT');
        assert.doesNotMatch(streaming, /Still working/, 'text that is still arriving needs no label');
    } finally { restoreGlobals(); }
});

test('describeCouncilLaneError states the error: the status by name, the code as detail', async () => {
    const { describeCouncilLaneError } = await import('../../chat/components/MessageTemplates.js');
    assert.deepEqual(describeCouncilLaneError('Request failed. (HTTP 429)'), { message: 'The model is temporarily busy. Please try again.', detail: '' });
    assert.deepEqual(describeCouncilLaneError('Request failed. (HTTP 503, PROVIDER_ERROR)'), { message: 'Service unavailable.', detail: 'Error 503' });
    assert.deepEqual(describeCouncilLaneError('Request failed. (HTTP 418)'), { message: 'Request failed.', detail: 'Error 418' });
    assert.deepEqual(describeCouncilLaneError('Request failed.'), { message: 'Request failed.', detail: '' });
    assert.equal(describeCouncilLaneError('Context window exceeded').message, 'Context window exceeded');
});

test('lane display distinguishes provider SSE codes from actual HTTP errors', async () => {
    const { describeCouncilLaneError } = await import('../../chat/components/MessageTemplates.js');
    assert.deepEqual(describeCouncilLaneError('Request failed. (PROVIDER_CODE_429)'),
        { message: 'The model is temporarily busy. Please try again.', detail: '' });
    assert.deepEqual(describeCouncilLaneError('Request failed. (PROVIDER_CODE_502)'),
        { message: 'Bad gateway.', detail: 'Provider error 502' });
    assert.deepEqual(describeCouncilLaneError('Request failed. (PROVIDER_STREAM_ERROR)'),
        { message: 'The provider reported an error.', detail: '' });
    assert.deepEqual(describeCouncilLaneError('Request failed. (PROVIDER_CODE_123456)'),
        { message: 'Request failed.', detail: '' });
});

test('a reply saved with an old replacement notice renders as the plain answer, no status box', async () => {
    const restore = installTemplateGlobals();
    try {
        const { buildMessageHTML } = await import('../../chat/components/MessageTemplates.js');
        for (const notice of ['stopped', 'failed']) {
            const saved = {id:'original',sessionId:'chat',role:'assistant',content:'The original answer.',model:'Test',timestamp:1,regenerationNotice:notice};
            const html = buildMessageHTML(saved, {processContentWithLatex:escapeHtml,formatTime:()=>''}, [], 'Test');
            assert.match(html,/The original answer/);
            assert.doesNotMatch(html,/regeneration-status|previous answer was kept|Retry response/);
        }
    } finally { restore(); }
});

test('reply actions appear only once the reply has ended', async () => {
    const restoreGlobals = installTemplateGlobals();
    try {
        const { buildMessageHTML } = await import('../../chat/components/MessageTemplates.js');
        const { messageLifecycleState, MESSAGE_STATE } = await import('../../chat/domain/messageLifecycle.js');
        const helpers = { processContentWithLatex: escapeHtml, formatTime: () => '' };
        const base = Object.freeze({ id: 'reply', sessionId: 'chat', role: 'assistant', model: 'Test', timestamp: 1 });
        const streaming = { ...base, content: 'The first sentence of the answer', streamingTokens: 8 };
        const streamingAfterThinking = { ...streaming, reasoning: 'Considered it', streamingReasoning: false };
        const complete = { ...base, content: 'The whole answer.', streamingTokens: null };
        const interrupted = { ...base, content: 'Half', inferenceError: 'The connection was lost.' };

        assert.equal(messageLifecycleState(streaming), MESSAGE_STATE.STREAMING);
        assert.equal(messageLifecycleState({ ...base, streamingPending: true }), MESSAGE_STATE.PENDING);
        assert.equal(messageLifecycleState(complete), MESSAGE_STATE.COMPLETE);
        assert.equal(messageLifecycleState(interrupted), MESSAGE_STATE.INTERRUPTED);
        assert.equal(messageLifecycleState({ ...base, content: '', inferenceError: 'Failed' }), MESSAGE_STATE.ERROR);

        for (const live of [streaming, streamingAfterThinking]) {
            const html = buildMessageHTML(live, helpers, [], 'Test', { isSessionStreaming: true });
            assert.doesNotMatch(html, /copy-message-btn|regenerate-message-btn/, 'no actions while text is arriving');
            assert.match(html, /assistant-actions-placeholder/, 'the row footprint is reserved so nothing jumps');
        }
        assert.match(buildMessageHTML(complete, helpers, [], 'Test'), /copy-message-btn/);
        assert.match(buildMessageHTML(interrupted, helpers, [], 'Test'), /regenerate-message-btn/);
    } finally { restoreGlobals(); }
});
