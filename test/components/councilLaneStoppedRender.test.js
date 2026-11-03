import test from 'node:test';
import assert from 'node:assert/strict';

// Round-2 check: changing an unfinished Parallel lane to cancelled hid its
// text and offered no retry. The real template, synthetic text.
const escape = v => String(v || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const helpers = { processContentWithLatex: escape, formatTime: () => '' };

async function renderMessage(value) {
    // The full suite shares a process. Install these only while rendering so
    // other fixtures cannot replace them or inherit a pretend browser page.
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

function message(primaryStatus, primaryResponse) {
    return {
        id: 'synthetic', role: 'assistant', model: 'Parallel', content: '', timestamp: 1,
        council: { enabled: true, currentStage: 'stage1', stage1: [
            { label: 'Response A', laneId: 'primary', model: 'OpenAI: Test', status: primaryStatus, response: primaryResponse, reasoning: '' },
            { label: 'Response B', laneId: 'secondary', model: 'Google: Test', status: 'complete', response: 'OTHER_LANE_COMPLETE_XYZ', reasoning: '' }
        ] }
    };
}

test('a lane stopped mid-answer keeps its text on screen, says it stopped, and can be retried', async () => {
    const html = await renderMessage(message('cancelled', 'VISIBLE_PARTIAL_ANSWER_ABC'));
    assert.match(html, /VISIBLE_PARTIAL_ANSWER_ABC/);
    assert.match(html, /OTHER_LANE_COMPLETE_XYZ/);
    assert.match(html, /council-response-stopped[^>]*>Stopped here\./);
    assert.match(html, /regenerate-council-lane-btn[^>]*data-council-lane-id="primary"/);
    assert.doesNotMatch(html, /Cancelled before this model finished/);
});

test('a lane stopped before it spoke says so and offers Try again', async () => {
    const html = await renderMessage(message('cancelled', ''));
    assert.match(html, /Stopped before this model answered\./);
    assert.match(html, /council-lane-retry-btn[^>]*regenerate-council-lane-btn[^>]*data-council-lane-id="primary"/s);
    assert.match(html, /OTHER_LANE_COMPLETE_XYZ/);
});

test('chart-only lanes and synthesis render their charts before their actions', async () => {
    const artifact = title => ({ version: 1, type: 'chart', spec: { chartType: 'bar', title, xLabels: ['A'], series: [{ name: 'Count', values: [2] }] } });
    const msg = message('complete', '');
    msg.council.stage1[0].artifacts = [artifact('Lane chart')];
    const laneHtml = await renderMessage(msg);
    assert.match(laneHtml, /copy-council-lane-btn[^>]*data-council-lane-id="primary"/s);
    assert.match(laneHtml, /regenerate-council-lane-btn[^>]*data-council-lane-id="primary"/s);
    assert.ok(laneHtml.indexOf('Lane chart') < laneHtml.indexOf('copy-council-lane-btn'));
    msg.council.synthesis = { status: 'complete', response: '', artifacts: [artifact('Review chart')], model: 'Review' };
    msg.artifacts = msg.council.synthesis.artifacts;
    const html = await renderMessage(msg);
    assert.match(html, /Lane chart/);
    assert.match(html, /Review chart/);
    assert.match(html, /copy-message-btn/);
    assert.ok(html.indexOf('Review chart') < html.indexOf('copy-message-btn'));
});
