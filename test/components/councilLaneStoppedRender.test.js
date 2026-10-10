import test from 'node:test';
import assert from 'node:assert/strict';

// Round-2 check: changing an unfinished Parallel lane to cancelled hid its
// text and offered no retry. The real template, synthetic text.
const escape = v => String(v || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
globalThis.document = { createElement() { return { innerHTML: '', set textContent(v) { this.innerHTML = escape(v); } }; } };
globalThis.window = { location: { hostname: 'localhost' }, app: { getDefaultModelName() { return 'Test'; } } };
const { buildMessageHTML } = await import('../../chat/components/MessageTemplates.js');
const helpers = { processContentWithLatex: escape, formatTime: () => '' };

function message(primaryStatus, primaryResponse) {
    return {
        id: 'synthetic', role: 'assistant', model: 'Parallel', content: '', timestamp: 1,
        council: { enabled: true, currentStage: 'stage1', stage1: [
            { label: 'Response A', laneId: 'primary', model: 'OpenAI: Test', status: primaryStatus, response: primaryResponse, reasoning: '' },
            { label: 'Response B', laneId: 'secondary', model: 'Google: Test', status: 'complete', response: 'OTHER_LANE_COMPLETE_XYZ', reasoning: '' }
        ] }
    };
}

test('a lane stopped mid-answer keeps its text on screen, says it stopped, and can be retried', () => {
    const html = buildMessageHTML(message('cancelled', 'VISIBLE_PARTIAL_ANSWER_ABC'), helpers, [], 'Test');
    assert.match(html, /VISIBLE_PARTIAL_ANSWER_ABC/);
    assert.match(html, /OTHER_LANE_COMPLETE_XYZ/);
    assert.match(html, /council-response-stopped[^>]*>Stopped here\./);
    assert.match(html, /regenerate-council-lane-btn[^>]*data-council-lane-id="primary"/);
    assert.doesNotMatch(html, /Cancelled before this model finished/);
});

test('a lane stopped before it spoke says so and offers Try again', () => {
    const html = buildMessageHTML(message('cancelled', ''), helpers, [], 'Test');
    assert.match(html, /Stopped before this model answered\./);
    assert.match(html, /council-lane-retry-btn[^>]*regenerate-council-lane-btn[^>]*data-council-lane-id="primary"/s);
    assert.match(html, /OTHER_LANE_COMPLETE_XYZ/);
});
