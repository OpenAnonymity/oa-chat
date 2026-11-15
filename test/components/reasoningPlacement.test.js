import test from 'node:test';
import assert from 'node:assert/strict';
import ChatArea from '../../chat/components/ChatArea.js';

// Minimal sibling model: exercise the actual live insertion paths, including
// replacing withheld reasoning, without needing a text bubble to find the row.
function fixture(t, withAccess = false) {
    const children = ['model', ...(withAccess ? ['access'] : []), 'answer'];
    const anchor = name => ({
        insertAdjacentHTML(position, html) {
            assert.equal(position, 'afterend');
            assert.match(html, /id="reasoning-m1"/);
            children.splice(children.indexOf(name) + 1, 0, 'reasoning');
        }
    });
    const model = anchor('model');
    model.parentElement = { querySelector: () => withAccess ? anchor('access') : null };
    t.mock.method(globalThis, 'setTimeout', () => 1);
    const prior = Object.getOwnPropertyDescriptor(globalThis, 'document');
    Object.defineProperty(globalThis, 'document', { configurable: true, value: {
        querySelector: () => ({ querySelector: selector => selector === '[data-assistant-header]' ? model : null }),
        getElementById: id => id === 'reasoning-m1' && children.includes('reasoning') ? {
            remove: () => children.splice(children.indexOf('reasoning'), 1)
        } : null
    } });
    t.after(() => prior ? Object.defineProperty(globalThis, 'document', prior) : delete globalThis.document);
    const area = Object.assign(Object.create(ChatArea.prototype), {
        settledReasoningIds: new Map(), reasoningBuffer: {},
        resumeReasoningDisplay() {}, settleThinkingHeader() {}
    });
    return { area, children };
}

for (const withAccess of [false, true]) {
    test(`late hidden and visible reasoning follows model${withAccess ? ' and access trace' : ''}`, t => {
        const { area, children } = fixture(t, withAccess);
        const expected = ['model', ...(withAccess ? ['access'] : []), 'reasoning', 'answer'];
        area.updateWithheldReasoning('m1', true);
        assert.deepEqual(children, expected);
        area.updateStreamingReasoning('m1', 'Visible reasoning after hidden reasoning.');
        assert.deepEqual(children, expected, 'replacement must preserve order without duplicating the trace');
    });
}

test('first visible reasoning after an answer stays below the model header', t => {
    const { area, children } = fixture(t);
    area.updateStreamingReasoning('m1', 'First visible reasoning.');
    assert.deepEqual(children, ['model', 'reasoning', 'answer']);
});
