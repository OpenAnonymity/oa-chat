import test from 'node:test';
import assert from 'node:assert/strict';
import { buildReasoningTrace } from '../../chat/components/MessageTemplates.js';
import ChatArea from '../../chat/components/ChatArea.js';

test('provider headings cannot replace Thinking in live or restored streaming headers', () => {
    const reasoning = '# Searching the web\n**Comparing results**\nThe answer follows.';
    assert.equal(ChatArea.prototype.extractReasoningSubtitle(reasoning), 'Thinking...');
    const html = buildReasoningTrace(reasoning, 'restored', true, text => text, 2000);
    assert.match(html, /id="reasoning-subtitle-restored"[^>]*>Thinking\.\.\.<\/span>/);
    assert.match(html, /Comparing results/, 'the reasoning body still contains the provider text');
});

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

test('wordless thinking that resumed after part of the answer renders as Thinking..., still with nothing to open', () => {
    const html = buildReasoningTrace('', 'again', true, null, 800, null, { withheld: true });
    assert.match(html, /reasoning-trace-withheld/);
    assert.match(html, /class="text-xs text-muted-foreground reasoning-subtitle-streaming">Thinking\.\.\.<\/span>/);
    assert.doesNotMatch(html, /Thought for/);
    assert.doesNotMatch(html, /reasoning-body|reasoning-chevron|reasoning-loading-indicator/);
});

test('a finished trace with words and no known time reads "Thought", never a summary or "Reasoning complete"', () => {
    const html = buildReasoningTrace('**Sorting the shelves**\nFiction first.', 'notime', false, text => text, undefined, null, {});
    assert.match(html, /id="reasoning-subtitle-notime"[^>]*>Thought<\/span>/);
    assert.doesNotMatch(html, /Reasoning complete|>Sorting the shelves</);
    assert.match(buildReasoningTrace('Fiction first.', 'timed', false, text => text, 2000, null, {}), />Thought for 2s</);
});
