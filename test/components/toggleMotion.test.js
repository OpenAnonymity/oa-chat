import test from 'node:test';
import assert from 'node:assert/strict';
import { syncToggleMotion } from '../../chat/ui/toggleMotion.js';

test('toggle settles on load and consent-only clicks do not animate', () => {
    const attributes = new Map([['aria-checked', 'false']]), classes = new Set();
    const button = { querySelector: () => ({ classList: { add() {} } }),
        getAttribute: key => attributes.get(key) ?? null, setAttribute: (key,value) => attributes.set(key,value),
        classList: { add: value => classes.add(value) } };
    syncToggleMotion(button, { initial: true });
    assert.equal(attributes.get('data-on'), 'false'); assert.equal(classes.has('is-init'), false);
    syncToggleMotion(button, { interacted: true }); assert.equal(classes.has('is-init'), false);
    attributes.set('aria-checked', 'true'); syncToggleMotion(button, { interacted: true });
    assert.equal(attributes.get('data-on'), 'true'); assert.equal(classes.has('is-init'), true);
    classes.delete('is-init'); attributes.set('aria-checked', 'false');
    syncToggleMotion(button, { initial: true }); assert.equal(classes.has('is-init'), false);
});
