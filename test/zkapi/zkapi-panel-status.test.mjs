import assert from 'node:assert/strict';
import test from 'node:test';
import { deriveZkapiUxState, ZKAPI_UX_PROPOSALS } from '../../chat/zkapi/services/zkapiUxState.mjs';

// Minimal browser shell for importing the real panel and wallet singleton.
// No provider, wallet request, or persistent user storage is involved.
globalThis.localStorage = globalThis.sessionStorage = {
    getItem() { return null; }, setItem() {}, removeItem() {}
};
globalThis.window = globalThis;
globalThis.location = { hostname: 'localhost', href: 'http://localhost/funding/' };
globalThis.addEventListener = () => {};
globalThis.dispatchEvent = () => {};
globalThis.document = { documentElement: { dataset: {} } };
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

const { default: RightPanel } = await import('../../chat/zkapi/components/RightPanel.js');
const { default: zkapiClient } = await import('@openanonymity/zkapi-browser-sdk/client');

function snapshot(overrides = {}) {
    return {
        config: { ux_proposal: 'quiet' },
        wallet: { note: {
            note_id: 7, deposit_amount: 2_000_000, current_balance: 1_610_000,
            expiry_ts: Math.floor(Date.now() / 1000) + 86400
        } },
        withdrawal: null,
        withdrawals: [],
        activities: [],
        lastError: null,
        loading: false,
        ...overrides
    };
}

function renderPanel({ transition = null, ...overrides } = {}) {
    Object.assign(zkapiClient, snapshot(overrides));
    const panel = Object.create(RightPanel.prototype);
    panel.currentSession = { id: 'new-chat' };
    panel.app = { integration: {
        getTransition: () => transition,
        getSessionUsageSummary: () => ({ hasEstimate: true, estimatedCostUsd: 0.0883,
            promptTokens: 8922, completionTokens: 3829 })
    } };
    panel.escapeHtml = value => String(value ?? '')
        .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;').replaceAll("'", '&#39;');
    return panel.billingSectionHTML();
}

test('System Panel shows only the active previous-chat closure card', () => {
    for (const proposal of ZKAPI_UX_PROPOSALS) {
        for (const phase of ['settling', 'waiting']) {
            const html = renderPanel({ config: { ux_proposal: proposal }, transition: { phase } });
            assert.match(html, /zkapi-panel-experience/);
            assert.match(html, /<strong>Closing previous chat<\/strong>/);
        }
        for (const phase of [null, 'ready', 'error']) {
            const html = renderPanel({ config: { ux_proposal: proposal },
                transition: phase ? { phase, message: 'Please retry closing.' } : null });
            assert.doesNotMatch(html, /zkapi-panel-experience|Ready for a new chat/);
            assert.match(html, /Private balance:/);
            assert.match(html, /Estimated this chat/);
            assert.match(html, /id="zkapi-panel-fund"/);
            if (phase === 'error') assert.match(html, />attention</);
            else assert.match(html, />ready</);
        }
    }
});

test('concurrent wallet work keeps its badge while the separate card describes closure', () => {
    const activities = [{ kind: 'deposit', phase: 'wallet', status: 'waiting',
        title: 'Adding funds', message: 'Confirm in MetaMask.' }];
    const html = renderPanel({ activities, transition: { phase: 'waiting' } });
    assert.match(html, /<strong>Closing previous chat<\/strong>/);
    assert.match(html, /send automatically/);
    // The badge spins while wallet work runs and keeps the words for
    // assistive tech; the sentence itself is the toast over the chat bar.
    assert.match(html, /class="zkapi-pill-spinner" role="img" aria-label="Adding funds"/);
    assert.doesNotMatch(html, /<strong>Adding funds<\/strong>/);
    const state = deriveZkapiUxState({ snapshot: snapshot({ activities }), transition: { phase: 'waiting' } });
    assert.equal(state.composerPrimary.phase, 'queued');
    assert.equal(state.balancePrimary.activity.kind, 'deposit');
});

test('standalone settlement activity removes its card when the operation finishes', () => {
    const activity = { kind: 'settlement', phase: 'syncing', status: 'running',
        title: 'Finishing previous chat', message: 'Closing its temporary key.' };
    assert.match(renderPanel({ activities: [activity] }), /<strong>Closing previous chat<\/strong>/);
    for (const status of ['success', 'error', 'canceled']) {
        assert.doesNotMatch(renderPanel({ activities: [{ ...activity, status }] }), /zkapi-panel-experience/);
    }
});

test('other payment phases retain funding, errors, withdrawal recovery, and pending response state', () => {
    const recovery = { phase: 'pending', mode: 'escape', challengeDeadline: Math.floor(Date.now() / 1000) + 600 };
    const scenarios = [
        { wallet: { note: null } },
        { loading: true, wallet: { note: null } },
        { config: { pending_deposit: { phase: 'submitted' } }, wallet: { note: null } },
        { activities: [{ kind: 'access', phase: 'proving', status: 'running', title: 'Starting private chat', blocksSend: true }] },
        { lastError: new Error('Balance refresh failed safely.') },
        { withdrawal: recovery, withdrawals: [{ id: 'saved-withdrawal', ...recovery }] }
    ];
    for (const scenario of scenarios) {
        const html = renderPanel(scenario);
        assert.doesNotMatch(html, /zkapi-panel-experience/);
        assert.match(html, /id="zkapi-panel-fund"/);
        if (scenario.lastError) assert.match(html, /Balance refresh failed safely/);
        if (scenario.withdrawal) {
            assert.match(html, /id="zkapi-panel-withdrawals"/);
            assert.match(html, /Payment history/);
            assert.match(html, /Recovery window in progress/);
        }
        if (scenario.activities) {
            const state = deriveZkapiUxState({ snapshot: snapshot(scenario) });
            assert.equal(state.composerPrimary.phase, 'proving');
            assert.equal(state.composerPrimary.blocksSend, true);
        }
    }
});
