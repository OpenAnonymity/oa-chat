import test from 'node:test';
import assert from 'node:assert/strict';
import { buildReasoningTrace } from '../../chat/components/MessageTemplates.js';

// Reasoning not shared by the provider (encrypted reasoning only): the trace is
// a quiet timed header with nothing to open.
test('withheld reasoning renders a timed header with nothing to open', () => {
    const html = buildReasoningTrace('', 'm1', false, null, 12000, null, { withheld: true });
    assert.match(html, /reasoning-trace-withheld/);
    assert.match(html, /Thought for 12s/);
    assert.doesNotMatch(html, /not shared by the provider/);
    assert.doesNotMatch(html, /reasoning-chevron/);
    assert.doesNotMatch(html, /reasoning-body/);
    assert.doesNotMatch(html, /<button/);
});

test('no reasoning and no withheld flag renders nothing', () => {
    assert.equal(buildReasoningTrace('', 'm2', false, null, 12000, null, {}), '');
    assert.equal(buildReasoningTrace('', 'm3', false, null, undefined, null), '');
});

test('words win over the withheld flag', () => {
    const html = buildReasoningTrace('Step one.', 'm4', false, text => text, 3000, null, { withheld: true });
    assert.match(html, /reasoning-body/);
    assert.doesNotMatch(html, /not shared by the provider/);
});


test('brief reasoning never rounds down to Thought for 0s', () => {
    const html = buildReasoningTrace('', 'brief', false, null, 200, null, { withheld: true });
    assert.match(html, /Thought for less than 1s/);
    assert.doesNotMatch(html, /Thought for 0s|not shared by the provider/);
    const unknown = buildReasoningTrace('', 'unknown', false, null, 0, null, { withheld: true });
    assert.match(unknown, />Thought<\/span>/);
    assert.doesNotMatch(unknown, /Thought for/);
});
