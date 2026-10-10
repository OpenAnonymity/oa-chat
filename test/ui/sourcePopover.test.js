import test from 'node:test';
import assert from 'node:assert/strict';
import { canAnchorSources, setSourcePopover } from '../../chat/ui/sourcePopover.js';

function fixture({ reduced = false, below = false } = {}) {
    const timers = new Map(); let timerId = 0, mutation;
    const rect = (top, bottom, width = 650) => ({ top, bottom, left: 16, right: 16 + width, width, height: bottom - top });
    const view = Object.assign(new EventTarget(), {
        innerHeight: 750, innerWidth: 900,
        matchMedia: query => Object.assign(new EventTarget(), { matches: query.includes('reduced-motion') ? reduced : true }),
        getComputedStyle: () => ({ getPropertyValue: () => '150ms' }),
        setTimeout: fn => { timers.set(++timerId, fn); return timerId; },
        clearTimeout: id => timers.delete(id),
        MutationObserver: class { constructor(fn) { mutation = fn; } observe() {} disconnect() {} }
    });
    const doc = Object.assign(new EventTarget(), { defaultView: view });
    function element(bounds) {
        const classes = new Set(), styles = new Map(), attrs = new Map();
        return Object.assign(new EventTarget(), {
            ownerDocument: doc, isConnected: true, dataset: {}, inert: false,
            getBoundingClientRect: () => bounds,
            contains(node) { return node === this || node === this.child; },
            setAttribute: (key, value) => attrs.set(key, value), removeAttribute: key => attrs.delete(key),
            hasAttribute: key => attrs.has(key),
            classList: { add: (...names) => names.forEach(n => classes.add(n)), remove: (...names) => names.forEach(n => classes.delete(n)), contains: n => classes.has(n) },
            style: { setProperty: (key, value) => styles.set(key, value), removeProperty: key => styles.delete(key), getPropertyValue: key => styles.get(key) },
            showPopover() { this.opened = true; },
            hidePopover() { assert.equal(this.isConnected, true, 'detached native popovers must not be hidden again'); this.opened = false; },
            matches() { return !!this.opened; }
        });
    }
    const scroller = element(rect(0, 750)), section = element(rect(540, 540));
    const trigger = element(below ? rect(150, 174) : rect(530, 554));
    const panel = element(rect(0, 96)); panel.scrollHeight = 96; panel.firstElementChild = element(rect(0, 96)); section.child = panel;
    const options = { scroller, section, panel, trigger, toolbar: element(rect(0, 60)), composer: element(rect(580, 750)), opening: true, wasOpen: false, preferPopover: true };
    const flush = () => { const callbacks = [...timers.values()]; timers.clear(); callbacks.forEach(fn => fn()); };
    return { options, panel, section, trigger, view, doc, flush, timers, mutation: () => mutation() };
}

test('anchoring needs a mouse-like pointer; phone and hybrid touch stay inline', () => {
    assert.equal(canAnchorSources({ matchMedia: () => ({ matches: true }) }, 'mouse'), true);
    assert.equal(canAnchorSources({ matchMedia: () => ({ matches: true }) }, 'touch'), false);
    assert.equal(canAnchorSources({ matchMedia: () => ({ matches: false }) }), false);
    assert.equal(canAnchorSources(null), false);
});

test('Sources chooses above when needed and below when it fits', () => {
    for (const below of [false, true]) {
        const h = fixture({ below }); assert.equal(setSourcePopover(h.options), true);
        assert.equal(h.panel.dataset.origin, below ? 'top-right' : 'bottom-right');
        assert.equal(h.panel.classList.contains('is-open'), true);
        setSourcePopover({ ...h.options, opening: false });
        assert.equal(h.panel.inert, true); assert.equal(h.panel.opened, true, 'paint the exit before leaving the top layer');
        h.flush(); assert.equal(h.panel.opened, false); assert.equal(h.panel.hasAttribute('popover'), false);
    }
});

test('rapid reopening cancels exit cleanup and repeated cycles leave no stale motion state', () => {
    const h = fixture();
    setSourcePopover(h.options);
    setSourcePopover({ ...h.options, opening: false });
    setSourcePopover(h.options); h.flush();
    assert.equal(h.panel.opened, true); assert.equal(h.panel.inert, false);
    setSourcePopover({ ...h.options, opening: false }); h.flush();
    assert.equal(h.panel.opened, false); assert.equal(h.panel.classList.contains('t-dropdown'), false);
    setSourcePopover(h.options); assert.equal(h.panel.classList.contains('t-dropdown'), true);
    setSourcePopover({ ...h.options, opening: false }); h.flush();
});

test('reduced-motion exits immediately; removing a message clears the native popup safely', () => {
    const h = fixture({ reduced: true }); setSourcePopover(h.options);
    setSourcePopover({ ...h.options, opening: false });
    assert.equal(h.panel.opened, false); assert.equal(h.timers.size, 0);
    const removed = fixture(); setSourcePopover(removed.options);
    removed.panel.isConnected = false; removed.panel.opened = false; removed.mutation();
    assert.equal(removed.panel.hasAttribute('popover'), false);
    assert.equal(removed.trigger.dataset.open, 'false');
});

test('unsupported browsers, existing inline lists and offscreen triggers keep the normal reveal', () => {
    const h = fixture();
    assert.equal(setSourcePopover({ ...h.options, preferPopover: false }), false);
    assert.equal(setSourcePopover({ ...h.options, wasOpen: true }), false);
    h.trigger.getBoundingClientRect = () => ({ top: 1000, bottom: 1030 });
    assert.equal(setSourcePopover(h.options), false);
    h.panel.showPopover = undefined;
    assert.equal(setSourcePopover(h.options), false);
});
