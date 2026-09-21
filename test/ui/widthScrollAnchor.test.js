import test from 'node:test';
import assert from 'node:assert/strict';
import { preserveBottomDuringWidthChange } from '../../chat/ui/widthScrollAnchor.js';

function fixture({ gap = 0, duration = '0.2s', delay = '0s' } = {}) {
    const frames = new Map(), timers = new Map(), events = new Map(), keys = new Map();
    let sequence = 0, current = true;
    const view = {
        performance: { now: () => 0 },
        getComputedStyle: element => ({ transitionDuration: element.duration ?? duration, transitionDelay: delay }),
        requestAnimationFrame: fn => { const id = ++sequence; frames.set(id, fn); return id; },
        cancelAnimationFrame: id => frames.delete(id),
        setTimeout: (fn, wait) => { const id = ++sequence; timers.set(id, { fn, wait }); return id; },
        clearTimeout: id => timers.delete(id)
    };
    const document = { defaultView: view, addEventListener: (name, fn) => keys.set(name, fn), removeEventListener: name => keys.delete(name) };
    const scroller = { ownerDocument: document, scrollHeight: 2000, clientHeight: 500, scrollTop: 1500 - gap,
        style: { scrollBehavior: 'smooth', overflowAnchor: '' }, isConnected: true,
        addEventListener: (name, fn) => events.set(name, fn), removeEventListener: name => events.delete(name) };
    return { scroller, frames, timers, events, keys,
        start: (transitionElements = []) => preserveBottomDuringWidthChange({ scroller, content: {}, transitionElements, isCurrent: () => current }),
        changeSession: () => { current = false; },
        frame(time) { const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach(fn => fn(time)); }
    };
}

test('follows shrink and growth through the full width transition, then restores scrolling', () => {
    const f = fixture(); f.start();
    f.scroller.scrollHeight = 1200; f.frame(16);
    assert.equal(f.scroller.scrollTop, 700);
    f.scroller.scrollHeight = 2500; f.frame(150);
    assert.equal(f.scroller.scrollTop, 2000);
    f.scroller.scrollHeight = 2600; f.frame(240);
    assert.equal(f.scroller.scrollTop, 2100);
    assert.deepEqual(f.scroller.style, { scrollBehavior: 'smooth', overflowAnchor: '' });
    assert.equal(f.frames.size + f.timers.size + f.events.size + f.keys.size, 0);
});

test('does not pull a reader above the bottom to the end', () => {
    const f = fixture({ gap: 80 }); f.start(); f.scroller.scrollHeight = 2500; f.frame(240);
    assert.equal(f.scroller.scrollTop, 1420);
    assert.equal(f.frames.size + f.events.size, 0);
    assert.equal(f.scroller.style.scrollBehavior, 'smooth');
});

test('wheel, touch, scrollbar dragging and scroll keys immediately release the anchor', () => {
    for (const event of ['wheel', 'touchstart', 'pointerdown', 'keydown']) {
        const f = fixture(); f.start();
        if (event === 'keydown') f.keys.get(event)({ key: 'PageUp' });
        else f.events.get(event)();
        f.scroller.scrollTop = 100; f.frame(100);
        assert.equal(f.scroller.scrollTop, 100, event);
        assert.equal(f.scroller.style.scrollBehavior, 'smooth');
        assert.equal(f.frames.size + f.timers.size, 0);
    }
});

test('a switched or removed conversation is never scrolled by stale work', () => {
    for (const detached of [false, true]) {
        const f = fixture(); f.start();
        if (detached) f.scroller.isConnected = false;
        else f.changeSession();
        f.scroller.scrollTop = 100; f.frame(16);
        assert.equal(f.scroller.scrollTop, 100);
        assert.equal(f.frames.size + f.timers.size, 0);
    }
});

test('rapid reversal cancels earlier frames and starts from the current bottom', () => {
    const f = fixture(); const stop = f.start();
    f.scroller.scrollHeight = 1200; f.frame(16);
    const stale = [...f.frames.values()][0]; stop();
    f.start(); f.scroller.scrollHeight = 2500; f.frame(16);
    assert.equal(f.scroller.scrollTop, 2000);
    f.scroller.scrollTop = 123; stale(32);
    assert.equal(f.scroller.scrollTop, 123);
    f.frame(240);
    assert.equal(f.scroller.style.scrollBehavior, 'smooth');
});

test('zero-duration transitions still settle and background-tab timeout releases the lock', () => {
    const f = fixture({ duration: '0s' }); f.start();
    f.scroller.scrollHeight = 3000; f.frame(32);
    assert.equal(f.scroller.scrollTop, 2500);
    assert.equal(f.frames.size + f.timers.size, 0);
    const g = fixture({ duration: '150ms, 0.3s', delay: '50ms' }); g.start();
    const timer = [...g.timers.values()][0];
    assert.equal(timer.wait, 450);
    g.scroller.scrollHeight = 3100; timer.fn();
    assert.equal(g.scroller.scrollTop, 2600);
    assert.equal(g.frames.size + g.timers.size + g.events.size + g.keys.size, 0);
});


test('panel reflow remains anchored beyond the shorter message width transition', () => {
    const f = fixture();
    f.start([{ duration: '400ms' }]);
    f.scroller.scrollHeight = 2500; f.frame(240);
    assert.equal(f.scroller.scrollTop, 2000);
    assert.equal(f.scroller.style.overflowAnchor, 'none');
    f.scroller.scrollHeight = 2700; f.frame(432);
    assert.equal(f.scroller.scrollTop, 2200);
    assert.equal(f.frames.size + f.timers.size, 0);
});

test('opening a panel uses the destination duration after classes change', () => {
    const f = fixture();
    const panel = { duration: '220ms' };
    f.start([panel]);
    panel.duration = '440ms';
    f.frame(16);
    assert.equal([...f.timers.values()][0].wait, 540);
    f.scroller.scrollHeight = 2900; f.frame(300);
    assert.equal(f.scroller.scrollTop, 2400);
    assert.equal(f.scroller.style.overflowAnchor, 'none');
    f.scroller.scrollHeight = 3100; f.frame(472);
    assert.equal(f.scroller.scrollTop, 2600);
    assert.equal(f.frames.size + f.timers.size, 0);
});
