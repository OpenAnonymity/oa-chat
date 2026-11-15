import test from 'node:test';
import assert from 'node:assert/strict';

// Prod, 2026-10-14: a failed Parallel lane rendered the router's "unknown" as
// its model (header and "U" avatar) and a bare "Request failed." Conversations
// saved by earlier builds still hold that value, so the template skips it.
const escape = v => String(v || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const helpers = { processContentWithLatex: escape, formatTime: () => '' };

async function renderMessage(value) {
    const previousDocument = globalThis.document;
    const previousWindow = globalThis.window;
    globalThis.document = { createElement() { return { innerHTML: '', set textContent(v) { this.innerHTML = escape(v); } }; } };
    globalThis.window = { location: { hostname: 'localhost' }, app: { getDefaultModelName() { return 'Test'; } } };
    try {
        const { buildMessageHTML } = await import('../../chat/components/MessageTemplates.js');
        return buildMessageHTML(value, helpers, [], 'Test');
    } finally {
        if (previousDocument === undefined) delete globalThis.document;
        else globalThis.document = previousDocument;
        if (previousWindow === undefined) delete globalThis.window;
        else globalThis.window = previousWindow;
    }
}

function message(secondary) {
    return {
        id: 'synthetic', role: 'assistant', model: 'Parallel', content: '', timestamp: 1,
        council: { enabled: true, currentStage: 'complete', stage1: [
            { label: 'Response A', laneId: 'primary', model: 'OpenAI: GPT-6.1 Sol', status: 'complete', response: 'Evvia, Protégé, Ettan.', reasoning: '' },
            { label: 'Response B', laneId: 'secondary', model: 'Google: Gemini 3.8 Flash', status: 'error', response: '', reasoning: '', ...secondary }
        ] }
    };
}

const laneHeader = (html, laneId) => {
    const start = html.indexOf(`data-council-lane-id="${laneId}"`);
    assert.ok(start > -1, `lane ${laneId} rendered`);
    return html.slice(start, html.indexOf('council-response-meta', start) + 1200);
};

test('a stored "unknown" response model is not shown: the failed lane keeps the model it was asked for', async () => {
    const html = await renderMessage(message({ responseModel: 'unknown', error: 'Request failed.' }));
    const header = laneHeader(html, 'secondary');
    assert.match(header, /council-response-model-name">Gemini 3\.8 Flash</);
    assert.doesNotMatch(html, /council-response-model-name">unknown</);
    assert.doesNotMatch(html, /font-semibold">U</, 'no "U" avatar for a model that does not exist');
    assert.match(html, /regenerate-council-lane-btn[\s\S]*?data-council-lane-id="secondary"/, 'retry is the lane action');
});

test('a numeric router code is named on the failed lane', async () => {
    const html = await renderMessage(message({ error: 'Request failed. (HTTP 502)' }));
    assert.match(html, /<strong>Error:<\/strong> Bad gateway \(HTTP 502\)\./);
});

test('a concrete routed model still labels the lane that it answered', async () => {
    const html = await renderMessage(message({ status: 'complete', response: 'Routed answer.', responseModel: 'Google: Gemini 3.8 Flash Lite' }));
    assert.match(laneHeader(html, 'secondary'), /council-response-model-name">Gemini 3\.8 Flash Lite</);
});


test('compact lane errors distinguish an HTTP status from the same provider code', async () => {
    const http = await renderMessage(message({ error: 'Request failed. (HTTP 504)' }));
    const provider = await renderMessage(message({ error: 'Request failed. (PROVIDER_CODE_504)' }));
    assert.match(http, /<strong>Error:<\/strong> Gateway timeout \(HTTP 504\)\./);
    assert.match(provider, /<strong>Error:<\/strong> Gateway timeout \(provider error 504\)\./);
    assert.doesNotMatch(provider, /HTTP 504/);
});

test('Council review errors retain provider or HTTP provenance in their compact fallback line', async () => {
    for (const [error, expected] of [
        ['Request failed. (HTTP 504)', /Continuing from Response A \(HTTP 504\)\./],
        ['Request failed. (PROVIDER_CODE_504)', /Continuing from Response A \(provider error 504\)\./]
    ]) {
        const value = message({ status: 'complete', response: 'Other answer.' });
        value.council.synthesis = { status: 'error', model: 'Test', fallbackLabel: 'Response A', error };
        const html = await renderMessage(value);
        assert.match(html, expected);
    }
});
