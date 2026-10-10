import test from 'node:test';
import assert from 'node:assert/strict';
import { revealSources, cancelSourceReveal, isSourceRevealActive } from '../../chat/ui/sourceReveal.js';

function fixture({ panelBottom = 760, reduced = false, maxScroll = 1000, current = true } = {}) {
    let nextId = 0;
    const frames = new Map(), listeners = new Map(), calls = [];
    const state = { current };
    const view = { innerHeight: 800, performance: { now: () => 0 },
        matchMedia: () => ({ matches: reduced }),
        requestAnimationFrame: fn => { frames.set(++nextId, fn); return nextId; },
        cancelAnimationFrame: id => frames.delete(id) };
    const rect = (top, bottom) => ({ top, bottom, left: 0, right: 900, height: bottom - top });
    const scroller = { isConnected: true, scrollTop: 0, clientTop: 0, clientHeight: 800, scrollHeight: 800 + maxScroll,
        ownerDocument: { defaultView: view }, getBoundingClientRect: () => rect(0, 800),
        scrollTo: options => calls.push(options),
        addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener: name => listeners.delete(name) };
    const panel = { isConnected: true, classList: { contains: () => false }, getBoundingClientRect: () => rect(640, panelBottom) };
    const options = { scroller, panel, trigger: { isConnected: true, getBoundingClientRect: () => rect(610, 634) },
        toolbar: { getBoundingClientRect: () => rect(0, 80) }, composer: { getBoundingClientRect: () => rect(650, 800) },
        isCurrent: () => state.current };
    const tick = time => { const pending = [...frames.values()]; frames.clear(); pending.forEach(fn => fn(time)); };
    return { options, state, view, scroller, panel, frames, listeners, calls, tick };
}

test('Sources reveals the cards above the composer, not at the bottom of chat', () => {
    const h = fixture(); revealSources(h.options);
    assert.equal(h.calls.length, 0);
    h.tick(125);
    assert.deepEqual(h.calls, [{ top: 106.75, behavior: 'instant' }]);
    assert.equal(isSourceRevealActive(h.scroller), true);
    h.tick(300);
    assert.deepEqual(h.calls.at(-1), { top: 122, behavior: 'instant' });
    assert.equal(isSourceRevealActive(h.scroller), false);
    assert.equal(h.frames.size, 0); assert.equal(h.listeners.size, 0);
});

test('already visible sources do not move the reader', () => {
    const h = fixture({ panelBottom: 625 }); revealSources(h.options);
    assert.equal(h.calls.length, 0); assert.equal(h.frames.size, 0);
});

test('tall sources retain their trigger below the toolbar and respect scroll limits', () => {
    const h = fixture({ panelBottom: 1300 }); revealSources(h.options);
    h.tick(250); assert.equal(h.calls[0].top, 518);
    cancelSourceReveal(h.scroller);
    const clamped = fixture({ maxScroll: 80 }); revealSources(clamped.options);
    clamped.tick(250); assert.equal(clamped.calls[0].top, 80);
    cancelSourceReveal(clamped.scroller);
});

test('phone visual viewport bounds and reduced motion are respected', () => {
    const h = fixture({ reduced: true }); h.view.visualViewport = { offsetTop: 0, height: 600 };
    revealSources(h.options);
    assert.deepEqual(h.calls, [{ top: 172, behavior: 'instant' }]);
    assert.equal(h.frames.size, 0); assert.equal(isSourceRevealActive(h.scroller), false);
});

test('manual gestures cancel pending frames without moving the reading position', () => {
    for (const event of ['wheel', 'touchstart', 'pointerdown', 'keydown']) {
        const h = fixture(); revealSources(h.options); h.scroller.scrollTop = 40;
        h.listeners.get(event)();
        h.tick(250);
        assert.equal(h.calls.length, 0);
        assert.equal(h.scroller.scrollTop, 40);
        assert.equal(h.frames.size, 0); assert.equal(h.listeners.size, 0);
        assert.equal(isSourceRevealActive(h.scroller), false);
    }
});

test('collapse and same-chat replacement stop motion; a different chat keeps its new scroll', () => {
    for (const type of ['collapse', 'replace', 'switch']) {
        const h = fixture(); revealSources(h.options);
        if (type === 'collapse') h.panel.classList.contains = () => true;
        if (type === 'replace') h.panel.isConnected = false;
        if (type === 'switch') h.state.current = false;
        h.tick(16);
        assert.equal(h.calls.length, 0);
        assert.equal(h.frames.size, 0); assert.equal(h.listeners.size, 0);
    }
});

test('a new disclosure cancels the previous one and a delayed frame finishes without chasing growth', () => {
    const h = fixture(); revealSources(h.options); const first = [...h.frames.keys()][0];
    revealSources(h.options);
    assert.equal(h.frames.has(first), false); assert.equal(h.frames.size, 1);
    h.tick(1501);
    assert.equal(h.frames.size, 0); assert.equal(h.listeners.size, 0);
    assert.equal(isSourceRevealActive(h.scroller), false);
});
