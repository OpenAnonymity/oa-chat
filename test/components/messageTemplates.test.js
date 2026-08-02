import test from 'node:test';
import assert from 'node:assert/strict';

function installTemplateGlobals() {
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
    installTemplateGlobals();
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
    }
});

test('assistant model IDs use author providers without family-logo guessing', async () => {
    installTemplateGlobals();
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
});

test('interleaved streams restore content around the current thinking section', async () => {
    installTemplateGlobals();
    const { buildMessageHTML } = await import('../../chat/components/MessageTemplates.js');

    const html = buildMessageHTML({
        id: 'interleaved',
        role: 'assistant',
        model: 'Anthropic: Claude Test',
        content: 'Visible before.\n\nVisible after.',
        reasoning: 'Checking another source.',
        streamingReasoning: true,
        streamingTokens: 8,
        streamingReasoningContentOffset: 'Visible before.'.length
    }, {
        processContentWithLatex: escapeHtml,
        formatTime: () => '18:15:12'
    }, [], 'Anthropic: Claude Test');

    const beforeIndex = html.indexOf('Visible before.');
    const thinkingIndex = html.indexOf('reasoning-trace');
    const afterIndex = html.indexOf('Visible after.');

    assert.ok(beforeIndex >= 0);
    assert.ok(thinkingIndex > beforeIndex);
    assert.ok(afterIndex > thinkingIndex);
});

test('completed reasoning ignores transient offsets and renders above the answer', async () => {
    installTemplateGlobals();
    const { buildMessageHTML } = await import('../../chat/components/MessageTemplates.js');

    const html = buildMessageHTML({
        id: 'completed-interleaved',
        role: 'assistant',
        model: 'xAI: Grok Test',
        content: 'Visible before.\n\nVisible after.',
        reasoning: 'Finished checking sources.',
        reasoningDuration: 17000,
        streamingReasoning: false,
        streamingTokens: null,
        streamingReasoningContentOffset: 'Visible before.'.length
    }, {
        processContentWithLatex: escapeHtml,
        formatTime: () => '18:15:12'
    }, [], 'xAI: Grok Test');

    const thinkingIndex = html.indexOf('reasoning-trace');
    const beforeIndex = html.indexOf('Visible before.');
    const afterIndex = html.indexOf('Visible after.');

    assert.ok(thinkingIndex >= 0);
    assert.ok(beforeIndex > thinkingIndex);
    assert.ok(afterIndex > beforeIndex);
    assert.match(html, /Thought for 17s/);
    assert.doesNotMatch(html, /reasoning-subtitle-streaming/);
});
