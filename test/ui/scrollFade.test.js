import test from 'node:test';
import assert from 'node:assert/strict';
import { syncScrollFade, watchScrollFade, syncAllScrollFades } from '../../chat/ui/scrollFade.js';

const box = (scrollTop, scrollHeight, clientHeight) => ({ scrollTop, scrollHeight, clientHeight, dataset: {} });

test('the edge that hides more content is the one that fades', () => {
    assert.equal(syncScrollFade(box(0, 100, 100)), '', 'fits: no fade, last line stays whole');
    assert.equal(syncScrollFade(box(0, 400, 100)), 'bottom');
    assert.equal(syncScrollFade(box(300, 400, 100)), 'top');
    assert.equal(syncScrollFade(box(150, 400, 100)), 'both');
    assert.equal(syncScrollFade(box(0, 104, 100)), '', 'a few pixels of overflow is not a fade');
});

test('the stamp is written and cleared on the element', () => {
    const el = box(0, 400, 100);
    syncScrollFade(el);
    assert.equal(el.dataset.scrollFade, 'bottom');
    el.scrollHeight = 100;
    syncScrollFade(el);
    assert.equal('scrollFade' in el.dataset, false);
});

test('one capturing scroll listener serves every trace box', () => {
    const listeners = [];
    const root = { addEventListener: (type, fn, capture) => listeners.push({ type, fn, capture }), removeEventListener() {} };
    watchScrollFade(root, '.reasoning-content');
    assert.equal(listeners[0].type, 'scroll');
    assert.equal(listeners[0].capture, true, 'scroll does not bubble');
    const el = { ...box(0, 400, 100), matches: sel => sel === '.reasoning-content' };
    listeners[0].fn({ target: el });
    assert.equal(el.dataset.scrollFade, 'bottom');
    const other = { ...box(0, 400, 100), matches: () => false };
    listeners[0].fn({ target: other });
    assert.equal('scrollFade' in other.dataset, false);
});

test('after a render every visible box is stamped', () => {
    const boxes = [box(0, 400, 100), box(0, 50, 100)];
    syncAllScrollFades({ querySelectorAll: () => boxes }, '.reasoning-content');
    assert.deepEqual(boxes.map(b => b.dataset.scrollFade), ['bottom', undefined]);
});
