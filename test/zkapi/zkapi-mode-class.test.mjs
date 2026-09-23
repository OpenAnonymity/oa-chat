import test from 'node:test';
import assert from 'node:assert/strict';
import { applyZkapiModeClass, ZKAPI_MODE_CLASS } from '../../chat/zkapi/services/zkapiModeClass.js';

function root(...classes) {
    const set = new Set(classes);
    return { classList: {
        contains: c => set.has(c), add: c => set.add(c), remove: c => set.delete(c),
        toggle: (c, on) => { on ? set.add(c) : set.delete(c); return on; }
    }, has: c => set.has(c) };
}
const sync = { requestFrame: fn => fn() };

test('a zkAPI chat turns the colour axis on; a tickets chat turns it off', () => {
    const html = root('theme-light');
    assert.equal(applyZkapiModeClass(html, 'zkapi', sync), true);
    assert.ok(html.has(ZKAPI_MODE_CLASS));
    assert.equal(applyZkapiModeClass(html, 'tickets', sync), true);
    assert.ok(!html.has(ZKAPI_MODE_CLASS));
});

test('re-rendering in the same mode changes nothing', () => {
    const html = root('theme-dark', ZKAPI_MODE_CLASS);
    assert.equal(applyZkapiModeClass(html, 'zkapi', sync), false);
    assert.ok(!html.has('switching-theme'));
});

test('the swap is wrapped like a theme change and the guard comes off after two frames', () => {
    const html = root();
    const frames = [];
    applyZkapiModeClass(html, 'zkapi', { requestFrame: fn => frames.push(fn) });
    assert.ok(html.has('switching-theme'));
    frames.shift()(); frames.shift()();
    assert.ok(!html.has('switching-theme'));
    assert.ok(html.has(ZKAPI_MODE_CLASS));
});

test('no document is a no-op', () => {
    assert.equal(applyZkapiModeClass(null, 'zkapi', sync), false);
});
