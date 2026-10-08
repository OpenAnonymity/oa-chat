import test from 'node:test';
import assert from 'node:assert/strict';
import MessageNavigation from '../../chat/components/MessageNavigation.js';

function navigation(t) {
    const nav = Object.assign(Object.create(MessageNavigation.prototype), {
        isVisible: true, isNavigating: false, awaitingScrollEnd: false,
        scrollFrame: null, clickedIndex: null, currentMessageIndex: 0,
        messages: [], container: { classList: { add() {} } }, hidePreview() {}
    });
    const frames = new Map();
    let id = 0;
    t.mock.method(globalThis, 'requestAnimationFrame', fn => { frames.set(++id, fn); return id; });
    t.mock.method(globalThis, 'cancelAnimationFrame', id => frames.delete(id));
    return { nav, frames, flush() {
        const pending = [...frames.values()]; frames.clear(); pending.forEach(fn => fn());
    } };
}

globalThis.requestAnimationFrame ??= () => {};
globalThis.cancelAnimationFrame ??= () => {};
globalThis.document ??= {};

test('a burst of manual scrolls measures the latest position once per frame', t => {
    const { nav, frames, flush } = navigation(t);
    let calls = 0;
    nav.clickedIndex = 3;
    nav.updateCurrentMessageIndex = () => calls++;
    for (let i = 0; i < 60; i++) nav.handleScroll();
    assert.equal(frames.size, 1);
    assert.equal(calls, 0);
    flush();
    assert.equal(calls, 1);
    assert.equal(nav.clickedIndex, null);
    nav.handleScroll(); flush();
    assert.equal(calls, 2);
});

test('a queued manual scroll cannot override a navigation click', t => {
    const { nav, flush } = navigation(t);
    nav.updateCurrentMessageIndex = () => assert.fail('must keep clicked selection');
    nav.handleScroll();
    nav.isNavigating = true;
    nav.clickedIndex = 4;
    flush();
    assert.equal(nav.clickedIndex, 4);
    assert.equal(nav.scrollFrame, null);
});

test('hiding navigation cancels pending scroll work and clears stale state', t => {
    t.mock.property(globalThis, 'document', { getElementById: () => null });
    const { nav, frames, flush } = navigation(t);
    nav.updateCurrentMessageIndex = () => assert.fail('hidden navigation must not measure');
    nav.handleScroll(); nav.hide(); flush();
    assert.equal(frames.size, 0);
    assert.equal(nav.isVisible, false);
    assert.equal(nav.scrollFrame, null);
});

test('long mixed chats select the nearest assistant with linear ID lookup and no redundant mutations', t => {
    const { nav } = navigation(t);
    let idReads = 0, writes = 0;
    const count = 300;
    nav.messages = Array.from({ length: count }, (_, i) => ({ get id() { idReads++; return `a-${i}`; } }));
    const elements = Array.from({ length: count * 2 }, (_, i) => ({
        dataset: { messageId: i % 2 ? `a-${(i - 1) / 2}` : `u-${i / 2}` },
        offsetTop: i * 100, getBoundingClientRect: () => ({ height: 80 })
    }));
    const indicators = nav.messages.map(() => {
        let active = false, current = 'false';
        return {
            classList: { contains: () => active, toggle: (_key, value) => { writes++; active = value; } },
            getAttribute: () => current, setAttribute: (_key, value) => { writes++; current = value; }
        };
    });
    const chat = { scrollTop: 29940, clientHeight: 400 };
    t.mock.property(globalThis, 'document', {
        querySelectorAll: selector => selector === '[data-message-id]' ? elements : indicators,
        getElementById: () => chat
    });
    nav.updateCurrentMessageIndex();
    assert.equal(nav.currentMessageIndex, 150);
    assert.equal(idReads, count);
    assert.equal(writes, 2);
    nav.updateCurrentMessageIndex();
    assert.equal(writes, 2, 'same nearest message should not mutate indicators');
    chat.scrollTop += 200;
    nav.updateCurrentMessageIndex();
    assert.equal(nav.currentMessageIndex, 151);
    assert.equal(writes, 6, 'only the old and new active indicator change');
});
