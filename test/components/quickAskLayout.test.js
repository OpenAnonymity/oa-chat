import test from 'node:test';
import assert from 'node:assert/strict';
import ChatArea from '../../chat/components/ChatArea.js';

function withViewport(run) {
    const previous = globalThis.window;
    globalThis.window = { innerWidth: 1000, innerHeight: 800 };
    try { run(); } finally { globalThis.window = previous; }
}
function harness() {
    const chat = { scrollTop: 0, scrollLeft: 0,
        getBoundingClientRect: () => ({ left: 100, top: 0, bottom: window.innerHeight }) };
    const panel = {
        style: { setProperty(name, value) { this[name] = value; } },
        getBoundingClientRect: () => ({ width: Math.min(520, window.innerWidth - 32), height: 100 })
    };
    const area = Object.create(ChatArea.prototype);
    area.app = { elements: { chatArea: chat } };
    area.quickAsk = {};
    return { area, panel, chat };
}
function assertFits(panel) {
    const top = parseFloat(panel.style.top);
    const available = parseFloat(panel.style['--quick-ask-available-height']);
    assert.ok(top >= 16);
    assert.ok(available > 0);
    assert.ok(top + available <= window.innerHeight - 16);
    assert.ok(parseFloat(panel.style.left) >= 16);
}
test('a low Ask popup caps future answer growth at the remaining screen space', () => withViewport(() => {
    const { area, panel } = harness();
    area.positionQuickAskWindow(panel, { left: 300, top: 550, bottom: 575, width: 100 });
    assert.equal(panel.style.top, '591px');
    assert.equal(panel.style['--quick-ask-available-height'], '193px');
    assertFits(panel);
}));
test('Ask re-fits a smaller viewport and retains its content anchor', () => withViewport(() => {
    const { area, panel } = harness();
    area.positionQuickAskWindow(panel, { left: 800, top: 550, bottom: 575, width: 100 });
    const anchor = { ...area.quickAsk.windowAnchor };
    window.innerWidth = 360;
    window.innerHeight = 400;
    area.positionQuickAskWindow(panel, null, { preserveAnchor: true });
    assertFits(panel);
    assert.equal(panel.style.left, '16px');
    assert.deepEqual(area.quickAsk.windowAnchor, anchor);
}));
test('Ask follows chat scrolling and hides outside the chat viewport', () => withViewport(() => {
    const { area, panel, chat } = harness();
    area.positionQuickAskWindow(panel, { left: 300, top: 550, bottom: 575, width: 100 });
    chat.scrollTop = 100;
    area.positionQuickAskWindow(panel, null, { preserveAnchor: true });
    assert.equal(panel.style.top, '491px');
    assertFits(panel);
    chat.scrollTop = 900;
    area.positionQuickAskWindow(panel, null, { preserveAnchor: true });
    assert.equal(panel.style.visibility, 'hidden');
}));
for (const atBottom of [true, false]) {
    test(`streaming Ask ${atBottom ? 'follows the latest text at the bottom' : 'preserves the reader position after scrolling up'}`, () => {
        const area = Object.create(ChatArea.prototype);
        const scroller = { scrollHeight: 900, clientHeight: 200, scrollTop: atBottom ? 700 : 100 };
        const answer = {
            closest: () => ({ classList: { remove() {} } }),
            set innerHTML(value) { scroller.scrollHeight = 1200; }
        };
        area.quickAsk = { window: { querySelector: selector => selector === '.quick-ask-answer' ? answer : scroller } };
        area.app = { processContentWithLatex: content => content };
        area.updateQuickAskStatus = () => {};
        area.updateQuickAskAnswer('A longer answer');
        assert.equal(scroller.scrollTop, atBottom ? 1200 : 100);
    });
}
