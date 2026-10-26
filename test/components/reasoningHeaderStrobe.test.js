import test from 'node:test';
import assert from 'node:assert/strict';
import ChatArea from '../../chat/components/ChatArea.js';

// The reasoning header during streaming shows the latest heading from the
// trace. Every chunk used to reset it to "Thinking..." synchronously before the
// debounced flush put the heading back, so headers of models whose traces carry
// **bold** headings strobed for the whole thinking phase.
function fixture(t) {
    const writes = [];
    const subtitle = {
        _text: 'Thinking...', classList: new Set(['reasoning-subtitle-streaming']),
        get textContent() { return this._text; },
        set textContent(value) { this._text = value; writes.push(value); },
        closest: () => null
    };
    subtitle.classList.contains = subtitle.classList.has;
    const content = { classList: { add() {} }, querySelector: () => null, appendChild() {} };
    const flushes = [];
    t.mock.method(globalThis, 'setTimeout', fn => { flushes.push(fn); return flushes.length; });
    t.mock.method(globalThis, 'setInterval', () => 1);
    const prior = Object.getOwnPropertyDescriptor(globalThis, 'document');
    Object.defineProperty(globalThis, 'document', { configurable: true, value: {
        getElementById: id => id === 'reasoning-subtitle-m1' ? subtitle
            : id === 'reasoning-content-m1' ? content : null
    } });
    t.after(() => prior ? Object.defineProperty(globalThis, 'document', prior) : delete globalThis.document);
    const area = Object.assign(Object.create(ChatArea.prototype), {
        settledReasoningIds: new Map(),
        reasoningBuffer: { content: '', messageId: null, timeout: null },
        typewriter: { interval: null, targetContent: '', displayedLength: 0, tickMs: 100, charsPerTick: 10 },
        reasoningAutoScrollPaused: false
    });
    const flush = () => { const fn = flushes.shift(); area.reasoningBuffer.timeout = null; fn?.(); };
    return { area, subtitle, writes, flush };
}

test('the streaming header keeps the latest heading between chunks instead of strobing to "Thinking..."', t => {
    const { area, subtitle, writes, flush } = fixture(t);
    area.updateStreamingReasoning('m1', '**Weighing the question**\nFirst thoughts.');
    flush();
    assert.equal(subtitle.textContent, 'Weighing the question');
    writes.length = 0;
    area.updateStreamingReasoning('m1', '**Weighing the question**\nFirst thoughts. More words');
    assert.equal(subtitle.textContent, 'Weighing the question', 'a plain chunk must not touch the header before the flush');
    flush();
    area.updateStreamingReasoning('m1', '**Weighing the question**\nFirst thoughts. More words\n**Checking the edge case**\n');
    flush();
    assert.deepEqual(writes.filter(w => w === 'Thinking...'), [], `header reverted to "Thinking..." mid-stream: ${JSON.stringify(writes)}`);
    assert.equal(subtitle.textContent, 'Checking the edge case');
});

test('thinking that resumes after a settled answer still sends the header back to "Thinking..."', t => {
    const { area, subtitle, writes, flush } = fixture(t);
    const first = '**Weighing the question**\nFirst thoughts.';
    area.updateStreamingReasoning('m1', first);
    flush();
    area.settledReasoningIds.set('m1', first.length);
    subtitle.textContent = 'Thought for 3s';
    subtitle.classList.delete('reasoning-subtitle-streaming');
    writes.length = 0;
    area.updateStreamingReasoning('m1', first + '\n**Rechecking after the lookup**\n');
    assert.equal(writes[0], 'Thinking...', 'the settled -> thinking transition reopens the shimmer');
    assert.ok(subtitle.classList.has('reasoning-subtitle-streaming'));
    flush();
    assert.equal(subtitle.textContent, 'Rechecking after the lookup');
});
