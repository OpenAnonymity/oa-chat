import test from 'node:test';
import assert from 'node:assert/strict';
import { canFloatToolbar, updateToolbarBackdrop, watchToolbarLayout } from '../../chat/ui/toolbarLayout.js';

const layout = { viewportWidth: 1440, contentLeft: 320, contentRight: 1120,
    controls: [{ left: 8, right: 84 }, { left: 1210, right: 1432 }] };

test('Share and payment controls need their full width plus clearance, not a fixed gutter', () => {
    assert.equal(canFloatToolbar(layout), true);
    // The former 52px margin allowed this overlap at intermediate widths.
    assert.equal(canFloatToolbar({ ...layout, contentLeft: 100, contentRight: 1340 }), false);
    assert.equal(canFloatToolbar({ ...layout, contentRight: 1199 }), false);
    assert.equal(canFloatToolbar({ ...layout, contentRight: 1198 }), true);
    assert.equal(canFloatToolbar({ ...layout, contentLeft: 90 }), false);
});

test('phone, wide transcript, and unavailable geometry keep an opaque header', () => {
    assert.equal(canFloatToolbar({ ...layout, viewportWidth: 767 }), false);
    assert.equal(canFloatToolbar({ ...layout, contentLeft: 24, contentRight: 1416 }), false);
    assert.equal(canFloatToolbar({ ...layout, contentRight: layout.contentLeft }), false);
});

function fixture() {
    let callback;
    const observed = [];
    const state = new Set();
    const view = { innerWidth: 1440, getComputedStyle: () => ({ paddingLeft: '24px', paddingRight: '24px' }),
        ResizeObserver: class {
            constructor(fn) { callback = fn; }
            observe(node) { observed.push(node); }
            disconnect() { observed.length = 0; }
        } };
    const control = { left: 1210, right: 1432, getBoundingClientRect() { return this; } };
    const toolbar = { ownerDocument: { defaultView: view }, children: [control],
        classList: { remove: key => state.delete(key), toggle: (key, value) => value ? state.add(key) : state.delete(key) } };
    const messagesContainer = { left: 300, right: 1140, getBoundingClientRect() { return this; } };
    const chatArea = {};
    return { toolbar, messagesContainer, chatArea, control, view, observed, state, resize: () => callback() };
}

test('payment controls appearing or growing update the header without window resize', () => {
    const f = fixture();
    const stop = watchToolbarLayout(f);
    assert.equal(f.state.has('toolbar-wide'), true);
    assert.ok(f.observed.includes(f.control));
    f.control.left = 1090;
    f.resize();
    assert.equal(f.state.has('toolbar-wide'), false);
    f.control.left = 1210;
    f.resize();
    assert.equal(f.state.has('toolbar-wide'), true);
    stop();
    assert.equal(f.observed.length, 0);
});

test('panel prediction covers immediately; measured narrowing and mobile cannot retain transparency', () => {
    const f = fixture();
    watchToolbarLayout(f);
    updateToolbarBackdrop({ ...f, widthDelta: -288 });
    assert.equal(f.state.has('toolbar-wide'), false);
    f.messagesContainer.right = 1310;
    f.resize();
    assert.equal(f.state.has('toolbar-wide'), false);
    f.messagesContainer.right = 1140;
    f.resize();
    assert.equal(f.state.has('toolbar-wide'), true);
    f.view.innerWidth = 640;
    updateToolbarBackdrop(f);
    assert.equal(f.state.has('toolbar-wide'), false);
});
