import test from 'node:test';
import assert from 'node:assert/strict';
import AccountModal from '../../chat/zkapi/components/AccountModal.js';
import WelcomePanel from '../../chat/zkapi/components/WelcomePanel.js';
import { attachWalletModalRestoreCancellation, currentWalletModalRestore, finishWalletModalRestore } from '../../chat/zkapi/components/WalletModalView.js';

function fixture(t, Component) {
    const oldWindow = globalThis.window;
    const storage = new Map();
    globalThis.window = { sessionStorage: { setItem: (key, value) => storage.set(key, value) } };
    t.after(() => { globalThis.window = oldWindow; });
    let position = 0;
    // Model actual browser clamping: a loading layout is too short to scroll.
    const scroller = { clientHeight: 650, scrollHeight: 400,
        get scrollTop() { return position; },
        set scrollTop(value) { position = Math.min(Math.max(0, this.scrollHeight - this.clientHeight), value); } };
    const handlers = new Map();
    const frames = [];
    const owner = Object.assign(Object.create(Component.prototype), { isOpen: true, view: 'fund', step: 'welcome',
        restoredModalView: { scroll: 812, setup: false, method: 'address', view: 'fund', step: 'welcome' },
        overlay: { querySelector: selector => selector === '[data-funding-scroll]' ? scroller : null,
            addEventListener: (name, handler) => handlers.set(name, handler),
            ownerDocument: { defaultView: { requestAnimationFrame: callback => frames.push(callback) } } }
    });
    attachWalletModalRestoreCancellation(owner);
    return { owner, scroller, handlers, frames,
        saved: () => JSON.parse([...storage.values()][0]) };
}

for (const Component of [AccountModal, WelcomePanel]) {
    test(`${Component.name} retains an 812px target across short loading layouts and repeated reload markers`, t => {
        const f = fixture(t, Component);
        for (let render = 0; render < 3; render++) {
            finishWalletModalRestore(f.owner, { hydrating: true, method: 'address' });
            f.owner.rememberRunningModal();
            assert.equal(f.scroller.scrollTop, 0, 'temporary loading view clamps scroll');
            assert.equal(f.saved().scroll, 812, 'clamped position cannot replace the intended reload position');
        }
        f.scroller.scrollHeight = 1900;
        finishWalletModalRestore(f.owner, { hydrating: false, method: 'address' });
        f.owner.rememberRunningModal();
        assert.equal(f.scroller.scrollTop, 812);
        assert.equal(f.saved().scroll, 812);
        assert.equal(f.owner.restoredModalView, null);
        f.scroller.scrollTop = 200;
        finishWalletModalRestore(f.owner, { method: 'address' });
        assert.equal(f.scroller.scrollTop, 200, 'later refreshes cannot reapply a completed restore');
    });
}

for (const event of ['pointerdown', 'wheel', 'touchstart', 'keydown', 'input']) {
    test(`user ${event} takes precedence over delayed funding scroll restoration`, t => {
        const f = fixture(t, AccountModal);
        finishWalletModalRestore(f.owner, { hydrating: true, method: 'address' });
        f.handlers.get(event)();
        f.scroller.scrollHeight = 1900;
        f.scroller.scrollTop = 200;
        finishWalletModalRestore(f.owner, { method: 'address' });
        assert.equal(f.scroller.scrollTop, 200);
        assert.equal(f.owner.restoredModalView, null);
    });
}

test('a final error layout consumes the restore at its real scroll limit', t => {
    const f = fixture(t, AccountModal);
    f.scroller.scrollHeight = 850;
    finishWalletModalRestore(f.owner, { hydrating: false, method: 'address' });
    f.owner.rememberRunningModal();
    assert.equal(f.scroller.scrollTop, 200);
    assert.equal(f.saved().scroll, 200);
    assert.equal(f.owner.restoredModalView, null);
});

test('a full view rendered while hidden restores after showSurface makes it measurable', t => {
    const f = fixture(t, WelcomePanel);
    f.scroller.clientHeight = 0;
    finishWalletModalRestore(f.owner, { method: 'address' });
    assert.ok(f.owner.restoredModalView);
    f.scroller.clientHeight = 650;
    f.scroller.scrollHeight = 1900;
    f.frames.shift()();
    assert.equal(f.scroller.scrollTop, 812);
    assert.equal(f.owner.restoredModalView, null);
});

for (const change of [{ view: 'withdrawals' }, { step: 'success' }, { isOpen: false }]) {
    test(`navigation invalidates an old funding scroll target: ${JSON.stringify(change)}`, t => {
        const f = fixture(t, AccountModal);
        Object.assign(f.owner, change);
        assert.equal(currentWalletModalRestore(f.owner, 'address'), null);
        assert.equal(f.owner.restoredModalView, null);
    });
}

test('changing methods cancels restoration before capture applies the previous position', t => {
    const f = fixture(t, AccountModal);
    assert.equal(currentWalletModalRestore(f.owner, 'metamask'), null);
    assert.equal(f.scroller.scrollTop, 0);
});
