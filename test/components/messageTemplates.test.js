import test from 'node:test';
import assert from 'node:assert/strict';

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

test('memory agent failure messages render safe retrieval failure reason', async () => {
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
            content: 'Memory context was not added this time. Sending without it.',
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

        assert.match(html, /Memory context was not added this time\. Sending without it\./);
        assert.match(html, /Note:/);
        assert.match(html, /Connection issue\./);
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
