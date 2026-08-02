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
        reasoning: '## Finished phase\nChecking another source.',
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
    assert.match(html, /Thinking\.\.\./);
    assert.match(html, /reasoning-subtitle-streaming/);
    assert.match(html, /id="reasoning-subtitle-interleaved"[^>]*>Thinking\.\.\.<\/span>/);
    assert.doesNotMatch(html, /Thought for/);
});

test('streaming image events retain their position around the live thinking trace', async () => {
    installTemplateGlobals();
    const { buildMessageHTML } = await import('../../chat/components/MessageTemplates.js');
    const before = 'Visible before.';
    const after = 'Visible after.';
    const content = `${before}\n\n${after}`;
    const firstImage = 'data:image/png;base64,AAAA';
    const secondImage = 'data:image/png;base64,BBBB';

    const html = buildMessageHTML({
        id: 'interleaved-images',
        role: 'assistant',
        model: 'xAI: Grok Test',
        content,
        reasoning: 'Thinking with images.',
        images: [
            { type: 'image_url', image_url: { url: firstImage } },
            { type: 'image_url', image_url: { url: secondImage } }
        ],
        streamingReasoning: true,
        streamingTokens: 12,
        streamingReasoningContentOffset: before.length,
        streamingReasoningImageCount: 1,
        streamingImageSegments: [
            { startIndex: 0, count: 1, contentOffset: before.length },
            { startIndex: 1, count: 1, contentOffset: content.length }
        ]
    }, {
        processContentWithLatex: escapeHtml,
        formatTime: () => '18:15:12'
    }, [], 'xAI: Grok Test');

    const beforeIndex = html.indexOf(before);
    const firstImageIndex = html.indexOf(firstImage);
    const thinkingIndex = html.indexOf('reasoning-trace');
    const afterIndex = html.indexOf(after);
    const secondImageIndex = html.indexOf(secondImage);

    assert.ok(beforeIndex < firstImageIndex);
    assert.ok(firstImageIndex < thinkingIndex);
    assert.ok(thinkingIndex < afterIndex);
    assert.ok(afterIndex < secondImageIndex);
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
