import test from 'node:test';
import assert from 'node:assert/strict';
import { ChatApp } from '../../chat/app.js';
import { watchToastPosition, stopToastPositioning } from '../../chat/ui/toastPosition.js';

function fixture(t, { centered = false, position = 'composer' } = {}) {
    const previousWindow = globalThis.window;
    const previousDocument = globalThis.document;
    const f = { centered, rect: { top: 400, bottom: 500 }, toast: { dataset: { position }, style: {}, offsetHeight: 40 } };
    globalThis.window = { innerHeight: 900 };
    const container = { querySelector: () => f.centered ? {} : null };
    globalThis.document = { getElementById: id => ({
        'app-toast': f.toast, 'messages-container': container,
        'input-card': { getBoundingClientRect: () => f.rect }
    })[id] };
    t.after(() => { globalThis.window = previousWindow; globalThis.document = previousDocument; });
    f.update = () => ChatApp.prototype.updateToastPosition.call({});
    return f;
}

test('payment confirmation stays at top center in either composer layout', t => {
    const f = fixture(t, { centered: true, position: 'top-center' });
    f.update();
    assert.equal(f.toast.style.top, 'calc(env(safe-area-inset-top, 0px) + 72px)');
    assert.equal(f.toast.style.bottom, 'auto');
    f.centered = false; f.update();
    assert.equal(f.toast.style.top, 'calc(env(safe-area-inset-top, 0px) + 72px)');
});

test('centered toast sits below the composer and stays still when it docks', t => {
    const f = fixture(t, { centered: true });
    f.update();
    assert.equal(f.toast.style.top, '516px');
    f.centered = false; f.rect = { top: 750, bottom: 850 };
    f.update();
    assert.equal(f.toast.style.top, '516px');
    stopToastPositioning(f.toast);
    f.update();
    assert.equal(f.toast.style.top, '516px', 'exit fade retains its frozen position');
    // A subsequent notification uses the new layout, with its own lifetime.
    f.toast = { dataset: {}, style: {}, offsetHeight: 40 };
    f.update();
    assert.equal(f.toast.style.top, '694px');
    assert.equal(f.toast.style.bottom, 'auto');
});

test('docked toast stays still on New Chat, but follows resizing within the same layout', t => {
    const f = fixture(t);
    f.update();
    assert.equal(f.toast.style.top, '344px');
    f.rect = { top: 380, bottom: 500 }; f.update();
    assert.equal(f.toast.style.top, '324px');
    f.centered = true; f.update();
    assert.equal(f.toast.style.top, '324px');
});

test('long notifications stay within the visible phone viewport', t => {
    const f = fixture(t, { centered: true });
    globalThis.window.visualViewport = { offsetTop: 50, height: 400 };
    f.toast.offsetHeight = 100;
    f.update();
    assert.equal(f.toast.style.top, '334px');
});

test('live toasts respond to viewport events and detach listeners on dismissal', t => {
    const f = fixture(t, { centered: true });
    const viewport = Object.assign(new EventTarget(), { offsetTop: 0, height: 900 });
    const view = Object.assign(new EventTarget(), { innerHeight: 900, visualViewport: viewport });
    watchToastPosition(f.toast, { document: globalThis.document, window: view });
    t.after(() => stopToastPositioning(f.toast));
    assert.equal(f.toast.style.top, '516px');
    viewport.height = 400;
    viewport.dispatchEvent(new Event('resize'));
    assert.equal(f.toast.style.top, '344px');
    viewport.offsetTop = 40;
    viewport.dispatchEvent(new Event('scroll'));
    assert.equal(f.toast.style.top, '384px');
    viewport.height = 900;
    view.dispatchEvent(new Event('resize'));
    assert.equal(f.toast.style.top, '516px');
    stopToastPositioning(f.toast);
    viewport.height = 300;
    viewport.dispatchEvent(new Event('resize'));
    view.dispatchEvent(new Event('resize'));
    assert.equal(f.toast.style.top, '516px');
});
