import test from 'node:test';
import assert from 'node:assert/strict';
import tlsSecurityModal from '../../chat/components/TLSSecurityModal.js';

function listeners() {
    const active = new Map();
    return {
        active,
        addEventListener(type, fn) {
            if (!active.has(type)) active.set(type, new Set());
            active.get(type).add(fn);
        },
        removeEventListener(type, fn) { active.get(type)?.delete(fn); }
    };
}

test('closing Security Details while the asset check is pending does not render a removed dialog', async t => {
    const previousFetch = globalThis.fetch;
    t.after(() => { globalThis.fetch = previousFetch; });
    let resolveFetch;
    globalThis.fetch = () => new Promise(resolve => { resolveFetch = resolve; });
    const modal = new tlsSecurityModal.constructor();
    // The dialog has been closed; completion must not touch its removed DOM or services.
    const pending = modal.verifyWasmIntegrity();
    resolveFetch({ ok: false });
    await pending;
    assert.equal(modal.isVerifying, false);
    assert.equal(modal.overlay, null);
    assert.equal(modal.wasmIntegrity.error, 'Could not fetch local asset');
});

test('security details rerenders replace Escape and backdrop listeners', t => {
    const previousDocument = globalThis.document;
    const document = listeners();
    globalThis.document = document;
    t.after(() => { globalThis.document = previousDocument; });
    const modal = new tlsSecurityModal.constructor();
    const overlay = { ...listeners(), querySelector: () => null };
    modal.overlay = overlay;
    let closed = 0;
    modal.close = () => { closed++; };
    modal.setupEventListeners();
    modal.setupEventListeners();
    assert.equal(document.active.get('keydown').size, 1);
    assert.equal(overlay.active.get('click').size, 1);
    for (const handler of document.active.get('keydown')) handler({ key: 'Escape' });
    assert.equal(closed, 1);
});
