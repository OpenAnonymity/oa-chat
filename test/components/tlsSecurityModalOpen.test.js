import test from 'node:test';
import assert from 'node:assert/strict';

// The Security Details dialog (System Panel → Network Proxy) must open on
// every press: "open" is the overlay being on the page, not a flag.

function element() {
    const el = {
        children: [], className: '', innerHTML: '', isConnected: false, style: { setProperty() {}, getPropertyValue: () => '', getPropertyPriority: () => '', removeProperty() {} },
        dataset: {}, classList: { add() {}, remove() {}, contains: () => false },
        listeners: {},
        get firstElementChild() { return this.children[0] || null; },
        appendChild(child) { this.children.push(child); child.isConnected = true; child.parentNode = this; return child; },
        remove() { this.isConnected = false; },
        querySelector: () => null,
        addEventListener(type, fn) { this.listeners[type] = fn; },
        removeEventListener() {},
        removeAttribute() {},
        get offsetWidth() { return 0; }
    };
    return el;
}

async function fixture() {
    const oldDocument = globalThis.document;
    const body = element();
    const inPage = [];
    globalThis.document = {
        body,
        createElement: () => { const el = element(); return el; },
        querySelector: () => inPage.at(-1) || null,
        addEventListener() {}, removeEventListener() {}
    };
    const { default: modal } = await import('../../chat/components/TLSSecurityModal.js');
    modal.isOpen = false; modal.overlay = null; modal.wasmIntegrity = { verified: true };
    let renders = 0;
    modal.render = function () { renders += 1; if (this.overlay) { this.overlay.innerHTML = '<div class="tls-modal-content"></div>'; this.overlay.children = [element()]; } };
    modal.setupEventListeners = () => {};
    return { modal, body, renders: () => renders, cleanup() { globalThis.document = oldDocument; } };
}

test('a stale open flag (overlay gone without close) does not stop the dialog from opening', async () => {
    const f = await fixture();
    try {
        await f.modal.open();
        assert.equal(f.modal.isOpen, true);
        const first = f.modal.overlay;
        assert.equal(first.isConnected, true);
        // The overlay leaves the page by some other route; the flag is left behind.
        first.remove();
        await f.modal.open();
        assert.notEqual(f.modal.overlay, first, 'a new overlay was built');
        assert.equal(f.modal.overlay.isConnected, true);
        // While it is on the page, a second press is a no-op.
        const second = f.modal.overlay;
        await f.modal.open();
        assert.equal(f.modal.overlay, second);
        assert.equal(f.renders(), 2);
    } finally { f.cleanup(); }
});

test('a build that throws leaves the dialog closed, not stuck open', async () => {
    const f = await fixture();
    try {
        const render = f.modal.render;
        f.modal.render = () => { throw new Error('no services yet'); };
        await assert.rejects(f.modal.open(), /no services yet/);
        assert.equal(f.modal.isOpen, false);
        assert.equal(f.modal.overlay, null);
        f.modal.render = render;
        await f.modal.open();
        assert.equal(f.modal.isOpen, true);
        assert.equal(f.modal.overlay.isConnected, true);
    } finally { f.cleanup(); }
});
