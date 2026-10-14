import test from 'node:test';
import assert from 'node:assert/strict';

// While tickets the org had already seen are set aside, one quiet toast
// covers the whole sweep ("Removing already-used tickets…") and becomes one
// line when it ends. Before 2026-10-14 every refusal raised its own toast.

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
preferencesStore.getPreference = getPreference;
restoreImport();

function harness() {
    const events = [];
    const app = Object.assign(Object.create(ChatApp.prototype), {
        showToast: (message, type) => events.push({ toast: message, type }),
        showLoadingToast: message => { events.push({ loading: message }); return () => events.push({ stopped: message }); },
        isViewingSession: () => true,
        notifyTicketShortage: async () => ({ retry: false })
    });
    return { app, events };
}

test('one loading toast for the whole sweep, then one line', () => {
    const restore = installBrowser();
    try {
        const { app, events } = harness();
        for (let skipped = 1; skipped <= 37; skipped += 1) app.showTicketSweepPending('one', skipped);
        assert.deepEqual(events, [{ loading: 'Removing already-used tickets…' }]);
        app.settleTicketSweep('one', { skipped: 37, recovered: true });
        assert.deepEqual(events.slice(1), [
            { stopped: 'Removing already-used tickets…' },
            { toast: 'Removed 37 already-used tickets', type: 'success' }
        ]);
        app.settleTicketSweep('one', { skipped: 37, recovered: true });
        assert.equal(events.length, 4, 'a second settle only toasts');
    } finally { restore(); }
});

test('a sweep that empties the wallet says so in its own toast, not a second red one', async () => {
    const restore = installBrowser();
    try {
        const { app, events } = harness();
        app.showTicketSweepPending('one', 1);
        assert.deepEqual(await app.handleAcquisitionTicketShortage({ id: 'one' }, { requiredTickets: 3, availableTickets: 1, label: 'Grok 4.7' }),
            { retry: false });
        app.settleTicketSweep('one', { skipped: 476, recovered: false, reason: 'TICKET_SHORTAGE' });
        assert.deepEqual(events.filter(event => event.toast), [
            { toast: 'Removed 476 already-used tickets. No tickets left for this message.', type: 'success' }
        ]);
        assert.ok(events.every(event => event.type !== 'error'));
    } finally { restore(); }
});

test('an ordinary shortage toast is quiet, not red', async () => {
    const restore = installBrowser();
    try {
        const { app, events } = harness();
        await app.handleAcquisitionTicketShortage({ id: 'one' }, { requiredTickets: 3, availableTickets: 1, label: 'Grok 4.7' });
        assert.equal(events.length, 1);
        assert.equal(events[0].type, 'success');
        assert.match(events[0].toast, /Grok 4\.7/);
    } finally { restore(); }
});
