import assert from 'node:assert/strict';
import test from 'node:test';

// Import the production panel with local, inert browser dependencies.
globalThis.localStorage = globalThis.sessionStorage = {
    getItem() { return null; }, setItem() {}, removeItem() {}
};
globalThis.window = globalThis;
globalThis.location = { hostname: 'localhost', origin: 'http://localhost', href: 'http://localhost/funding/' };
globalThis.addEventListener = () => {};
globalThis.dispatchEvent = () => {};
globalThis.document = {
    documentElement: { dataset: {} },
    getElementById: () => null,
    createElement() {
        return {
            textContent: '',
            get innerHTML() {
                return String(this.textContent ?? '')
                    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
            }
        };
    }
};
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
const { default: ZkapiRightPanel } = await import('../../chat/zkapi/components/RightPanel.js');
const { default: zkapiBackend } = await import('../../chat/zkapi/services/inference/backends/zkapiBackend.js');
const { default: openRouterBackend } = await import('../../chat/services/inference/backends/openRouterBackend.js');
const { createInferenceService } = await import('../../chat/services/inference/inferenceService.js');

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

function fullPanelFixture({ commercial, mode, active = false }) {
    const panel = Object.create(PaymentModeRightPanel.prototype);
    const session = { id: 'chat-fixture-0123456789abcdef' };
    const inference = createInferenceService({ backends: [openRouterBackend, zkapiBackend] });
    let currentMode;
    let transition = null;
    panel.ticketCount = 12;
    panel.currentSession = session;
    panel.timeRemaining = '04:12';
    panel.app = {
        state: { sessions: [session], models: [] },
        hasTicketManagementAction: () => commercial,
        supportsFeature: (_feature, owner) => (owner?.inferenceBackend || currentMode) !== 'zkapi',
        services: {
            inference,
            account: { getState: () => ({}) },
            networkProxy: {
                getSettings: () => ({ enabled: true }),
                getStatus: () => ({ usingProxy: true, connected: true }),
                getTlsInfo: () => ({ version: null })
            }
        },
        integration: {
            getMode: () => currentMode,
            getTransition: () => transition
        }
    };
    function setMode(nextMode, hasKey = active) {
        currentMode = nextMode;
        session.inferenceBackend = nextMode === 'tickets' ? 'openrouter' : 'zkapi';
        // zkAPI stores an opaque chat binding, never the provider credential.
        session.apiKey = hasKey ? nextMode === 'tickets'
            ? 'sk-ticket-fixture-secret-0123456789' : session.id : null;
        session.apiKeyInfo = hasKey ? { stationId: `${nextMode}-fixture-station` } : null;
        panel.apiKey = session.apiKey;
        panel.apiKeyInfo = session.apiKeyInfo;
    }
    setMode(mode);
    return { panel, session, setMode, setTransition: value => { transition = value; } };
}

for (const commercial of [false, true]) {
    for (const mode of ['tickets', 'zkapi']) {
        for (const active of [false, true]) {
            test(`${commercial ? 'commercial' : 'standalone'} ${mode} renders one ${active ? 'active' : 'pending'} access panel`, () => {
                const { panel, session } = fullPanelFixture({ commercial, mode, active });
                const html = panel.generateTopSectionHTML();
                assert.equal((html.match(/>Ephemeral Access Key<\/span>/g) || []).length, 1);
                assert.equal((html.match(/id="verifier-attestation-btn"/g) || []).length, 1);
                assert.equal((html.match(/id="proxy-toggle-btn"/g) || []).length, 1);
                assert.equal((html.match(/id="proxy-security-details-btn"/g) || []).length, 1);
                assert.equal((html.match(/id="open-ticket-manager-btn"/g) || []).length,
                    commercial && mode === 'tickets' ? 1 : 0);
                assert.equal((html.match(/id="zkapi-panel-fund"/g) || []).length, mode === 'zkapi' ? 1 : 0);
                assert.equal((html.match(/class="system-panel-divider"/g) || []).length,
                    commercial && mode === 'tickets' ? 1 : 0);
                assert.equal((html.match(/id="ephemeral-key-display"/g) || []).length, active ? 1 : 0);
                assert.equal((html.match(/id="renew-key-btn"/g) || []).length, active ? 1 : 0);
                assert.equal((html.match(/id="api-key-expiry"/g) || []).length, active ? 1 : 0);
                if (active) {
                    assert.ok(html.includes(panel.app.services.inference.maskAccessToken(session, session.apiKey)));
                    assert.ok(!html.includes(session.apiKey), 'raw ticket key or complete private chat binding stays masked');
                    assert.ok(html.includes(`${mode}-fixture-station`));
                    assert.match(html, /04:12/);
                    assert.equal(panel.getKeyDisplayInfo().hoverContentHtml, null);
                } else {
                    assert.ok(html.includes(mode === 'tickets' ? 'Requested on message send' : 'Key created when you send'));
                    assert.match(html, /To be assigned/);
                }
                assert.ok(html.indexOf('Ephemeral Access Key') < html.indexOf('Network Proxy'));
            });
        }
    }
}

test('private-only panel keeps shared access even when its host also manages tickets', () => {
    const { panel } = fullPanelFixture({ commercial: true, mode: 'zkapi', active: true });
    Object.setPrototypeOf(panel, ZkapiRightPanel.prototype);
    const html = panel.generateTopSectionHTML();
    assert.equal((html.match(/>Ephemeral Access Key<\/span>/g) || []).length, 1);
    assert.match(html, /id="zkapi-panel-fund"/);
    assert.match(html, /id="renew-key-btn"/);
    assert.doesNotMatch(html, /id="open-ticket-manager-btn"/);
});

test('mode changes preserve single private access and commercial Parallel lane controls during settlement', () => {
    const { panel, session, setMode, setTransition } = fullPanelFixture({ commercial: true, mode: 'tickets' });
    session.responseMode = 'council';
    session.councilConfig = { enabled: true, outputMode: 'parallel' };
    session.councilAccess = {
        primary: {
            apiKey: 'sk-parallel-fixture-secret-0123456789',
            apiKeyInfo: { stationId: 'parallel-fixture-station' },
            expiresAt: new Date(Date.now() + 120_000).toISOString()
        }
    };
    for (const mode of ['tickets', 'zkapi', 'tickets']) {
        setMode(mode, mode === 'zkapi');
        setTransition(mode === 'tickets' ? { phase: 'settling' } : null);
        const html = panel.generateTopSectionHTML();
        assert.equal((html.match(/>Ephemeral Access Keys?<\/span>/g) || []).length, 1);
        if (mode === 'tickets') {
            assert.match(html, />Ephemeral Access Keys<\/span>/);
            assert.equal((html.match(/data-council-attestation-lane="primary"/g) || []).length, 1);
            assert.match(html, /parallel-fixture-station/);
            assert.match(html, /Requested on message send/);
            assert.match(html, /You can keep using Tickets\./);
            assert.doesNotMatch(html.match(/<div id="zkapi-ticket-closing-notice"[^>]*>/)?.[0] || '', /hidden/);
            assert.doesNotMatch(html, /id="verifier-attestation-btn"/);
        } else {
            assert.match(html, />Ephemeral Access Key<\/span>/);
            assert.equal((html.match(/id="verifier-attestation-btn"/g) || []).length, 1);
            assert.doesNotMatch(html, /data-council-attestation-lane|parallel-fixture-station/);
        }
        assert.doesNotMatch(html, /sk-parallel-fixture-secret-0123456789/);
    }
    assert.equal(session.councilConfig.enabled, true, 'payment selection does not discard the saved Parallel preference');
});
