import assert from 'node:assert/strict';
import test from 'node:test';

// Import the production panel with local, inert browser dependencies.
globalThis.localStorage = globalThis.sessionStorage = {
    getItem() { return null; }, setItem() {}, removeItem() {}
};
globalThis.window = globalThis;
globalThis.location = { hostname: 'localhost', href: 'http://localhost/funding/' };
globalThis.addEventListener = () => {};
globalThis.dispatchEvent = () => {};
globalThis.document = { documentElement: { dataset: {} }, getElementById: () => null };
globalThis.zkapiWallet = {};
const request = result => {
    const entry = {};
    queueMicrotask(() => {
        entry.result = result;
        entry.onsuccess?.({ target: entry });
    });
    return entry;
};
globalThis.indexedDB = {
    open: () => request({
        version: 4,
        close() {},
        transaction: () => ({ objectStore: () => ({
            get: () => request(undefined), put: () => request(undefined), delete: () => request(undefined)
        }) })
    })
};

const { RightPanel: TicketRightPanel } = await import('../../chat/publicApi.js');
const { default: PaymentModeRightPanel } = await import('../../chat/zkapi/components/PaymentModeRightPanel.js');

function panelFixture() {
    let transition = null;
    const session = { id: 'ticket-chat', inferenceBackend: 'openrouter' };
    const panel = Object.create(PaymentModeRightPanel.prototype);
    panel.currentSession = session;
    panel.paymentMode = 'tickets';
    panel.app = {
        getCurrentSession: () => session,
        integration: { getMode: () => 'tickets', getTransition: () => transition }
    };
    return { panel, session, setTransition: value => { transition = value; } };
}

test('ticket funding keeps its controls and shows a non-blocking notice only during closure', t => {
    t.mock.method(TicketRightPanel.prototype, 'generateFundingSectionHTML', function () {
        assert.equal(this.currentSession.inferenceBackend, 'openrouter');
        return '<div id="normal-ticket-controls">Tickets and invitation form</div>';
    });
    const { panel, setTransition } = panelFixture();
    for (const phase of ['settling', 'waiting', 'ready', 'error', null]) {
        setTransition(phase ? { phase, message: 'Sensitive protocol diagnostic' } : null);
        const html = panel.generateFundingSectionHTML();
        assert.match(html, /id="normal-ticket-controls"/);
        assert.match(html, /Closing previous chat/);
        assert.match(html, /You can keep using Tickets\./);
        assert.match(html, /role="status" aria-live="polite"/);
        assert.doesNotMatch(html, /Ready for a new chat|Sending will wait|Sensitive protocol diagnostic/);
        const noticeTag = html.match(/<div id="zkapi-ticket-closing-notice"[^>]*>/)?.[0];
        assert.ok(noticeTag);
        assert.equal(/\bhidden\b/.test(noticeTag), !['settling', 'waiting'].includes(phase));
    }
});

test('settlement updates toggle only the keyed notice without remounting ticket controls', t => {
    const { panel, setTransition } = panelFixture();
    let hidden = true;
    let hiddenWrites = 0;
    const notice = {
        get hidden() { return hidden; },
        set hidden(value) { hidden = value; hiddenWrites += 1; }
    };
    t.mock.method(document, 'getElementById', id => {
        assert.equal(id, 'zkapi-ticket-closing-notice');
        return notice;
    });
    panel.loadSessionData = () => assert.fail('Settlement must not reload ticket access');
    panel.renderTopSectionOnly = () => assert.fail('Settlement must not remount ticket controls');

    setTransition({ phase: 'settling' });
    panel.onRuntimePresentationChange();
    assert.equal(hidden, false);
    assert.equal(hiddenWrites, 1);
    panel.handleZkapiChange({ reason: 'activity-update' });
    panel.handleZkapiChange({ reason: 'clock' });
    panel.onRuntimePresentationChange();
    assert.equal(hiddenWrites, 1, 'Repeated progress preserves the existing notice and spinner');

    setTransition({ phase: 'ready' });
    panel.handleZkapiChange({ reason: 'activity-complete' });
    assert.equal(hidden, true);
    assert.equal(hiddenWrites, 2);
    setTransition({ phase: 'error' });
    panel.onRuntimePresentationChange();
    assert.equal(hiddenWrites, 2, 'Failure adds no persistent error card');

    setTransition({ phase: 'waiting' });
    panel.onRuntimePresentationChange();
    assert.equal(hidden, false);
    setTransition(null);
    panel.handleZkapiChange({ reason: 'settlement-complete' });
    assert.equal(hidden, true);
    assert.equal(hiddenWrites, 4);
});

test('switching into Tickets loads its panel once and later settlement only updates the notice', t => {
    const { panel, session, setTransition } = panelFixture();
    const notice = { hidden: true };
    t.mock.method(document, 'getElementById', () => notice);
    panel.paymentMode = 'zkapi';
    panel.currentSession = { id: 'old-private-chat', inferenceBackend: 'zkapi' };
    let loads = 0;
    panel.loadSessionData = () => { loads += 1; };
    setTransition({ phase: 'settling' });

    panel.onRuntimePresentationChange();
    assert.equal(panel.currentSession, session);
    assert.equal(panel.paymentMode, 'tickets');
    assert.equal(loads, 1);
    assert.equal(notice.hidden, false);
    setTransition({ phase: 'ready' });
    panel.onRuntimePresentationChange();
    assert.equal(loads, 1);
    assert.equal(notice.hidden, true);
});
