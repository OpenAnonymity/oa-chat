import test from 'node:test';
import assert from 'node:assert/strict';
import { showSurface, hideSurface } from '../../chat/ui/uiMotion.js';

function fixture({ reduced = false, display = '' } = {}) {
    const classes = () => {
        const values = new Set();
        return { add(...items) { items.forEach(x => values.add(x)); }, remove(...items) { items.forEach(x => values.delete(x)); }, contains: x => values.has(x) };
    };
    const style = new Map(display ? [['display', display]] : []);
    const panel = () => ({ classList: classes(), offsetWidth: 560, ownerDocument: { defaultView: view } });
    const view = { matchMedia: () => ({ matches: reduced }), getComputedStyle: () => ({ display: display || 'flex', getPropertyValue: () => '12ms' }) };
    const root = { classList: classes(), dataset: {}, isConnected: true, innerHTML: 'private dialog content',
        style: { getPropertyValue: key => style.get(key) || '', getPropertyPriority: () => '', setProperty: (key,value) => style.set(key,value), removeProperty: key => style.delete(key) },
        ownerDocument: { defaultView: view }, removeAttribute() {}, remove() { this.isConnected = false; }, firstElementChild: panel() };
    return { root, panel, style };
}
const finish = () => new Promise(resolve => setTimeout(resolve, 35));

test('outgoing controls become inert and logically hidden before removal', async () => {
    const { root } = fixture(); showSurface(root); hideSurface(root, { remove: true });
    assert.equal(root.inert, true); assert.equal(root.classList.contains('hidden'), true);
    assert.equal(root.isConnected, true); await finish(); assert.equal(root.isConnected, false);
});
test('rapid reopen cancels stale clear and restores an explicit display value', async () => {
    const { root, style } = fixture({ display: 'grid' });
    showSurface(root); hideSurface(root, { clear: true }); showSurface(root); await finish();
    assert.equal(root.innerHTML, 'private dialog content'); assert.equal(root.inert, false);
    assert.equal(root.classList.contains('hidden'), false); assert.equal(style.get('display'), 'grid');
});
test('closing animates the current dialog after its content was rerendered', async () => {
    const { root, panel } = fixture(); showSurface(root); root.firstElementChild = panel();
    hideSurface(root, { clear: true }); assert.equal(root.firstElementChild.classList.contains('is-closing'), true);
    await finish(); assert.equal(root.innerHTML, '');
});
test('reduced motion performs immediate cleanup with no stranded controls', () => {
    const { root } = fixture({ reduced: true }); showSurface(root); hideSurface(root, { clear: true });
    assert.equal(root.innerHTML, ''); assert.equal(root.inert, true);
});

test('disclosure close measures visible height before becoming hidden', async () => {
    const { setDisclosure } = await import('../../chat/ui/uiMotion.js');
    const { root } = fixture(); let frames;
    root.hidden = false; root.scrollHeight = 96;
    root.classList.toggle = (name, on) => on ? root.classList.add(name) : root.classList.remove(name);
    root.getBoundingClientRect = () => ({ height: root.hidden ? 0 : 96 });
    root.animate = value => { frames = value; return { finished: Promise.resolve(), cancel() {} }; };
    setDisclosure(root, false);
    assert.equal(frames[0].height, '96px');
    assert.equal(frames[1].height, '0px');
    assert.equal(root.hidden, true); assert.equal(root.inert, true);
    await Promise.resolve(); assert.equal(root.style.getPropertyValue('display'), '');
});
