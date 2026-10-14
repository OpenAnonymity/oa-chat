import test from 'node:test';
import assert from 'node:assert/strict';

// While tickets the org had already seen are set aside, the pending reply
// says so once, with a count that ticks up in place; the sweep ends with a
// single toast. Before 2026-10-14 every refusal raised its own toast.

function installBrowser() {
    const keys = ['window', 'location', 'localStorage', 'sessionStorage', 'document', 'fetch', 'requestAnimationFrame'];
    const descriptors = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    const storage = { getItem: () => null, setItem() {}, removeItem() {} };
    const events = { addEventListener() {}, removeEventListener() {}, dispatchEvent() {} };
    const location = { href: 'http://localhost/', hostname: 'localhost', origin: 'http://localhost', search: '', pathname: '/' };
    const values = {
        window: { ...events, location, localStorage: storage, sessionStorage: storage },
        location, localStorage: storage, sessionStorage: storage,
        document: { ...events, querySelector: () => null, getElementById: () => null,
            documentElement: { classList: { contains: () => false }, dataset: {} } },
        fetch: async () => { throw new Error('These tests must never use the network.'); },
        requestAnimationFrame: callback => callback()
    };
    for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    return () => {
        for (const [key, descriptor] of descriptors) {
            if (descriptor) Object.defineProperty(globalThis, key, descriptor);
            else delete globalThis[key];
        }
    };
}

const restoreImport = installBrowser();
const { default: preferencesStore } = await import('../../chat/services/preferencesStore.js');
const getPreference = preferencesStore.getPreference;
preferencesStore.getPreference = async () => false;
const { ChatApp } = await import('../../chat/app.js');
const { default: VanillaChatUi } = await import('../../chat/ui/vanilla/VanillaChatUi.js');
const { buildTypingIndicator } = await import('../../chat/components/MessageTemplates.js');
preferencesStore.getPreference = getPreference;
restoreImport();

function pendingHarness() {
    const label = { textContent: 'Requesting ephemeral key', classList: { add() {} } };
    const indicator = { dataset: { phase: 'requesting-key', pendingSessionId: 'one' }, querySelector: selector => selector === '.pending-response-label' ? label : null };
    const ui = Object.assign(Object.create(VanillaChatUi.prototype), { interfaces: { componentApp: { services: {} } } });
    const toasts = [];
    const app = Object.assign(Object.create(ChatApp.prototype), {
        ui,
        sessionStreamingStates: new Map([['one', { isStreaming: true, abortController: null, phase: 'requesting-key' }]]),
        showToast: (message, type, duration) => toasts.push({ message, type, duration })
    });
    document.querySelector = selector => selector.includes('data-pending-session-id="one"') ? indicator : null;
    return { app, ui, label, indicator, toasts };
}

test('the pending reply counts the tickets being set aside, in place', async () => {
    const restore = installBrowser();
    try {
        const { app, ui, label, indicator, toasts } = pendingHarness();
        app.showTicketSweepPending('one', 1);
        assert.equal(label.textContent, 'Skipping already-used tickets · 1');
        assert.equal(app.getSessionStreamingState('one').phase, 'skipping-used-tickets');
        app.showTicketSweepPending('one', 2);
        app.showTicketSweepPending('one', 37);
        assert.equal(label.textContent, 'Skipping already-used tickets · 37');
        assert.deepEqual(toasts, []);
        // The granted key moves the label on as before.
        ui.updatePendingIndicator(indicator, 'waiting-response');
        assert.equal(label.textContent, 'Waiting for response');
    } finally {
        restore();
    }
});

test('a sweep ends with one line naming what left the wallet', async () => {
    const restore = installBrowser();
    try {
        const { app, toasts } = pendingHarness();
        app.settleTicketSweep('one', { skipped: 213, recovered: true });
        app.settleTicketSweep('one', { skipped: 1, recovered: false });
        app.settleTicketSweep('one', { skipped: 0, recovered: true });
        assert.deepEqual(toasts.map(toast => toast.message), [
            'Removed 213 already-used tickets',
            'Removed 1 already-used ticket'
        ]);
        assert.ok(toasts.every(toast => toast.type === 'success'));
    } finally {
        restore();
    }
});

test('a reload mid-sweep restores the row with the same label', async () => {
    const restore = installBrowser();
    try {
        document.createElement = () => {
            const element = { textContent: '' };
            Object.defineProperty(element, 'innerHTML', {
                get: () => String(element.textContent).replace(/[&<>]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[char])
            });
            return element;
        };
        const html = buildTypingIndicator('typing-1', 'xAI', 'Grok 4.7', Date.now(), 'skipping-used-tickets', null, 'one');
        assert.match(html, /Skipping already-used tickets</);
        assert.match(html, /data-phase="skipping-used-tickets"/);
        const counted = buildTypingIndicator('typing-1', 'xAI', 'Grok 4.7', Date.now(), 'skipping-used-tickets', { skippedTickets: 5 }, 'one');
        assert.match(counted, /Skipping already-used tickets · 5</);
    } finally {
        restore();
    }
});
