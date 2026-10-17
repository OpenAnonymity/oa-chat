import test from 'node:test';
import assert from 'node:assert/strict';
import { buildReasoningTrace } from '../../chat/components/MessageTemplates.js';
import ChatArea from '../../chat/components/ChatArea.js';

test('provider headings again label live and restored streaming traces', () => {
    const reasoning = '# Searching the web\n**Comparing results**\nThe answer follows.';
    assert.equal(ChatArea.prototype.extractReasoningSubtitle.call(ChatArea.prototype, reasoning), 'Comparing results');
    const html = buildReasoningTrace(reasoning, 'restored', true, text => text, 2000);
    assert.match(html, /id="reasoning-subtitle-restored"[^>]*>Comparing results<\/span>/);
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


test('brief reasoning uses the original rounded seconds in live and restored headers', () => {
    for (const [duration, expected] of [[200, 'Thought for 0s'], [499, 'Thought for 0s'], [500, 'Thought for 1s'], [800, 'Thought for 1s'], [1500, 'Thought for 2s'], [60000, 'Thought for 1m'], [61000, 'Thought for 1m 1s']]) {
        assert.equal(ChatArea.prototype.formatReasoningDuration(duration), expected);
        for (const withheld of [false, true]) {
            const html = buildReasoningTrace(withheld ? '' : 'A trace.', 'brief', false, text => text, duration, null, { withheld });
            assert.ok(html.includes(expected));
            assert.doesNotMatch(html, /less than 1s/);
        }
    }
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

test('a restored trace with no time uses its heading or Reasoning complete', () => {
    const html = buildReasoningTrace('**Sorting the shelves**\nFiction first.', 'notime', false, text => text, undefined, null, {});
    assert.match(html, /id="reasoning-subtitle-notime"[^>]*>Sorting the shelves<\/span>/);
    assert.match(buildReasoningTrace('Fiction first.', 'untimed', false, text => text), />Reasoning complete</);
    assert.match(buildReasoningTrace('Fiction first.', 'timed', false, text => text, 2000), />Thought for 2s</);
});

test('provider headings are escaped and clipped when used as header text', () => {
    const reasoning = '# <img src=x onerror=alert(1)> heading';
    for (const streaming of [true, false]) {
        const html = buildReasoningTrace(reasoning, 'escaped', streaming, () => 'Rendered trace');
        assert.match(html, /id="reasoning-subtitle-escaped"[^>]*>&lt;img/);
        assert.doesNotMatch(html, /<img/);
        const long = buildReasoningTrace('# ' + 'x'.repeat(180), 'long', streaming, () => 'Rendered trace');
        assert.ok(long.includes('x'.repeat(147) + '...</span>'));
    }
    assert.equal(ChatArea.prototype.extractReasoningSubtitle.call(ChatArea.prototype, 'No heading here.'), 'Thinking...');
});

test('rounded headers stay consistent through settling, resuming and settling again', () => {
    const previous = globalThis.document;
    const classes = new Set(['reasoning-subtitle-streaming']);
    let withheld = true;
    const subtitle = { textContent: 'Thinking...', closest: () => withheld ? {} : null, classList: {
        add: value => classes.add(value), remove: value => classes.delete(value)
    } };
    globalThis.document = { getElementById: () => subtitle };
    try {
        const area = Object.create(ChatArea.prototype);
        area.settleThinkingHeader('hidden', 200);
        assert.equal(subtitle.textContent, 'Thought for 0s');
        assert.equal(classes.size, 0);
        area.resumeReasoningDisplay('hidden');
        assert.equal(subtitle.textContent, 'Thinking...');
        assert.ok(classes.has('reasoning-subtitle-streaming'));
        area.settleThinkingHeader('hidden', 1200);
        assert.equal(subtitle.textContent, 'Thought for 1s');
        withheld = false;
        area.settleThinkingHeader('visible', 1200);
        assert.equal(subtitle.textContent, 'Thought for 1s');
        area.settleThinkingHeader('visible', undefined);
        assert.equal(subtitle.textContent, 'Reasoning complete');
    } finally { globalThis.document = previous; }
});
