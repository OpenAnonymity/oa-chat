import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

// ZkapiStateExperience imports the browser client singleton even though the
// panel renderer itself is pure. Supply the smallest browser shell needed to
// import it so these tests exercise rendered markup rather than source text.
const storage = {
    getItem() { return null; },
    setItem() {},
    removeItem() {}
};
globalThis.localStorage = storage;
globalThis.sessionStorage = storage;
globalThis.window = globalThis;
globalThis.location = { hostname: 'localhost', href: 'http://localhost/funding/' };
globalThis.window.location = globalThis.location;
globalThis.window.addEventListener = () => {};
globalThis.window.dispatchEvent = () => {};
globalThis.document = {
    documentElement: { dataset: {} },
    createElement() {
        let textContent = '';
        return {
            set textContent(value) { textContent = String(value ?? ''); },
            get textContent() { return textContent; },
            get innerHTML() {
                return textContent
                    .replaceAll('&', '&amp;')
                    .replaceAll('<', '&lt;')
                    .replaceAll('>', '&gt;')
                    .replaceAll('"', '&quot;')
                    .replaceAll("'", '&#39;');
            }
        };
    }
};

// MessageTemplates loads the preference facade at module evaluation time.
// Give it a tiny successful IndexedDB shell so this DOM-rendering test remains
// deterministic and does not wait for the production database timeout.
const settings = new Map();
const request = (result) => {
    const value = {};
    queueMicrotask(() => {
        value.result = typeof result === 'function' ? result() : result;
        value.onsuccess?.({ target: value });
    });
    return value;
};
const settingsStore = {
    get(key) { return request(() => settings.has(key) ? { key, value: settings.get(key) } : undefined); },
    put(entry) { return request(() => { settings.set(entry.key, entry.value); return entry.key; }); },
    delete(key) { return request(() => settings.delete(key)); }
};
const fakeDb = {
    version: 4,
    close() {},
    transaction() { return { objectStore: () => settingsStore }; }
};
globalThis.indexedDB = {
    open() { return request(fakeDb); }
};
globalThis.zkapiWallet = {
    ABI: {},
    abiWord() {},
    addressWord() {},
    callData() {},
    encodeDeposit() {},
    encodeFinalizeEscape() {},
    encodeWithdrawal() {},
    escapePeriodBadge() {},
    escapePeriodLabel() {},
    escapePeriodPhrase() {},
    formatTokenAmount() {},
    parseNoteDeposited() {},
    parseTokenAmount() {},
    parseWithdrawalReceipt() {}
};

const {
    attachZkapiSettlementActions,
    renderZkapiComposerStatus,
    renderZkapiPanelExperience
} = await import('../../chat/zkapi/components/ZkapiStateExperience.js');
const { deriveZkapiUxState } = await import('../../chat/zkapi/services/zkapiUxState.mjs');
const { createVanillaUiInterface } = await import('../../chat/ui/appInterface.js');
const { default: Sidebar } = await import('../../chat/components/Sidebar.js');
const { default: RightPanel } = await import('../../chat/zkapi/components/RightPanel.js');
const { default: AccountModal } = await import('../../chat/zkapi/components/AccountModal.js');
const { addressFundingWallet } = await import('../../chat/zkapi/services/addressFundingProvider.mjs');
// The settings-only IndexedDB shell above has no transaction completion events.
// Supply the unrelated funding-account store independently for wallet UI runs.
addressFundingWallet.store = { load: async () => null, save: async () => {} };
addressFundingWallet.createChannel = () => null;
const { default: WelcomePanel } = await import('../../chat/zkapi/components/WelcomePanel.js');
const { default: zkapiClient, ZkapiClient } = await import('@openanonymity/zkapi-browser-sdk/client');
const {
    buildMessageHTML,
    buildTypingIndicator,
    configureMessageTemplateServices
} = await import('../../chat/components/MessageTemplates.js');
const { processMessagesForApi } = await import('../../chat/domain/messageContent.js');
const { createZkapiUi } = await import('../../chat/zkapi/ui/createZkapiUi.js');
const { createPaymentModeUi } = await import('../../chat/zkapi/ui/createPaymentModeUi.js');
const { ChatApp } = await import('../../chat/app.js');
const { createModelPickerInterface } = await import('../../chat/ui/appInterface.js');
configureMessageTemplateServices({ presentation: createZkapiUi({}).presentation });

test('private model pricing shows a compact minimum-balance badge with token rates', () => {
    const ui = createZkapiUi({});
    const copy = ui.presentation.getModelPricing({
        id: 'vendor/opus-unlisted', pricing: { prompt: '0.000001', completion: '0.000004' }
    }, { reasoningEnabled: true });
    assert.equal(copy.balanceBadgeLabel, '≥ $2');
    assert.equal(copy.label, '$1/M input · $4/M output');
    assert.match(copy.balanceBadgeTooltip, /at least \$2 for a new key/);
    assert.match(copy.balanceBadgeTooltip, /Only actual usage is deducted/);
    assert.match(copy.description, /Input \$0\.000001\/token/);
});

test('usage panel shows only the owning key cap, then the selected model cap after close', () => {
    const config = zkapiClient.config;
    const panel = Object.create(RightPanel.prototype);
    panel.currentSession = { id: 'chat-a', model: 'Premium model' };
    panel.app = {
        reasoningEnabled: true,
        state: { models: [{ id: 'vendor/opus-unlisted', name: 'Premium model' }] },
        integration: { getSessionUsageSummary: () => ({ hasEstimate: true, estimatedCostUsd: 0.12 }) }
    };
    try {
        zkapiClient.config = { active_lease: { session_id: 'chat-a', spending_limit_usd: 4.5, expires_at: Date.now() / 1000 + 300 } };
        assert.equal(panel.usageEstimateView().keyLimitLabel, '$4.50');
        zkapiClient.config = { active_lease: { session_id: 'chat-b', spending_limit_usd: 6, expires_at: Date.now() / 1000 + 300 } };
        assert.equal(panel.usageEstimateView().keyLimitLabel, '$2', 'another conversation’s key must not affect the cap');
        zkapiClient.config = {};
        assert.equal(panel.usageEstimateView().keyLimitLabel, '$2');
        panel.currentSession.model = 'Unresolved model name';
        assert.equal(panel.usageEstimateView().keyLimitLabel, null, 'unresolved display names must not silently become $1');
    } finally { zkapiClient.config = config; }
});

test('choosing a new model updates the existing panel budget before sending without remounting', async t => {
    const { ensureModelTiersReady } = await import('../../chat/publicModelTierApi.js');
    t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({
        'openai/gpt-4o-mini': 1, 'openai/gpt-6-astra-pro': 100
    }), { status: 200 }));
    await ensureModelTiersReady();
    const originalDocument = globalThis.document;
    const config = zkapiClient.config;
    t.after(() => { globalThis.document = originalDocument; zkapiClient.config = config; });
    let session = { id: 'model-change-chat', model: 'GPT-4o Mini' };
    const app = Object.create(ChatApp.prototype);
    const panel = Object.create(RightPanel.prototype);
    const keyLabel = { textContent: '' };
    const card = { classList: { toggle() {} },
        querySelector: selector => selector === '[data-chat-usage-key-limit]' ? keyLabel : null };
    globalThis.document = { querySelector: () => card };
    Object.assign(app, {
        state: { models: [{ id: 'openai/gpt-4o-mini', name: 'GPT-4o Mini' },
            { id: 'openai/gpt-6-astra-pro', name: 'GPT-6 Astra Pro' }] },
        elements: {}, reasoningEnabled: true, rightPanel: panel,
        getCurrentSession: () => session, normalizeModelName: value => value,
        beginSessionMutation: () => ({}), endSessionMutation() {}, updateCouncilLayoutMode() {},
        integration: { getSessionUsageSummary: () => ({ hasEstimate: true, estimatedCostUsd: 0.02 }) }
    });
    panel.app = app;
    panel.currentSession = { ...session };
    panel.renderTopSectionOnly = () => { throw new Error('Model selection must not remount the panel'); };
    zkapiClient.config = {};
    const picker = createModelPickerInterface(app, {
        chatDBImpl: { saveSetting: async () => {}, saveSession: async () => {} }
    });
    // The cap is per model and follows the live selection, but the panel no
    // longer prints it: "$1 per key" read as a fee. The picker shows it.
    const capLabel = () => { panel.updateUsageEstimate(); return panel.usageEstimateView().keyLimitLabel; };
    assert.equal(capLabel(), '$1');
    assert.equal(keyLabel.textContent, '', 'the usage box carries no per-key line');
    await picker.actions.selectModel('GPT-6 Astra Pro');
    assert.equal(capLabel(), '$6');
    assert.equal(panel.currentSession, session, 'same-chat snapshots are refreshed from the live selection');

    zkapiClient.config = { active_lease: { session_id: session.id,
        spending_limit_usd: 4.5, expires_at: Date.now() / 1000 + 300 } };
    await picker.actions.selectModel('GPT-4o Mini');
    assert.equal(capLabel(), '$4.50', 'a live owned key still reports its actual cap');

    session = { id: 'another-chat', model: 'GPT-6 Astra Pro' };
    app.renderCurrentModel();
    assert.equal(panel.usageEstimateView().keyLimitLabel, '$4.50', 'navigation waits for its own panel update');
});

test('right-panel runtime completion advances once without clock-driven remounts', () => {
    let transition = { phase: 'settling', sessionId: 'old-chat', message: 'Closing previous chat' };
    const panel = Object.create(RightPanel.prototype);
    panel.app = { integration: { getTransition: () => transition } };
    const statuses = [];
    panel.renderTopSectionOnly = () => statuses.push(panel.getMissingApiKeyStatus());
    panel.onRuntimePresentationChange();
    assert.match(statuses[0].label, /Closing previous chat key/);
    transition = { ...transition, updatedAt: Date.now() + 1000 };
    panel.onRuntimePresentationChange();
    assert.equal(statuses.length, 1, 'clock-only updates must preserve open panel disclosures');
    transition = { phase: 'ready', sessionId: 'old-chat', message: 'Previous chat settled' };
    panel.onRuntimePresentationChange();
    assert.equal(statuses.length, 2, 'completion must update the panel without a later wallet event');
    assert.doesNotMatch(statuses[1].label, /Closing/);
    transition = { phase: 'error', sessionId: 'old-chat', message: 'Try again' };
    panel.onRuntimePresentationChange();
    assert.equal(statuses.length, 3);
    assert.equal(statuses[2].badge, 'Action needed');
});

function lowTextState(proposal, overrides = {}) {
    const { primary: primaryOverrides = {}, ...stateOverrides } = overrides;
    const primary = {
        phase: 'queued',
        tone: 'working',
        title: 'Message queued',
        detail: 'Accepted. Waiting for the previous private chat to finish.',
        compact: 'Message queued',
        busy: true,
        blocksSend: true,
        ...primaryOverrides
    };
    return {
        proposal,
        showComposer: true,
        primary,
        panelPrimary: primary,
        activities: [],
        runningActivities: [],
        journey: [],
        ...stateOverrides
    };
}

function composerElement() {
    const attributes = new Map();
    let innerHTML = '';
    let innerHTMLWrites = 0;
    return {
        className: '',
        dataset: {},
        set innerHTML(value) {
            innerHTML = String(value);
            innerHTMLWrites += 1;
        },
        get innerHTML() {
            return innerHTML;
        },
        get innerHTMLWrites() {
            return innerHTMLWrites;
        },
        setAttribute(name, value) {
            attributes.set(name, String(value));
        },
        getAttribute(name) {
            return attributes.get(name) ?? null;
        },
        removeAttribute(name) {
            attributes.delete(name);
        },
        querySelector() {
            return { addEventListener() {} };
        }
    };
}

test('composer and panel show Stop waiting then Retry for every settlement proposal', () => {
    for (const proposal of ['quiet', 'guided', 'activity', 'receipt', 'relay', 'ambient', 'capsule']) {
        const element = composerElement();
        for (const phase of ['settling', 'error']) {
            const state = deriveZkapiUxState({
                snapshot: { config: { ux_proposal: proposal }, activities: [{
                    kind: 'access', status: 'waiting', phase: 'waiting', title: 'Still requesting'
                }] },
                transition: { phase, message: 'Your recovery record is saved.' }
            });
            renderZkapiComposerStatus(element, null, state);
            const panel = renderZkapiPanelExperience(state);
            const action = phase === 'error' ? 'retry' : 'stop';
            for (const html of [element.innerHTML, panel]) {
                assert.match(html, new RegExp(`data-zkapi-settlement-action="${action}"`));
                assert.match(html, phase === 'error' ? />Retry<\/button>/ : />Pause update<\/button>/);
                if (phase === 'error') assert.doesNotMatch(html, /zkapi-state-spinner/);
            }
            if (phase === 'error') assert.equal(element.getAttribute('aria-busy'), 'false');
            if (proposal === 'ambient') assert.match(element.className, /zkapi-composer-state--relay/);
        }
    }
});

test('settlement controls forward runtime actions, prevent duplicate retry, and surface failure', async () => {
    let listener;
    const button = { dataset: { zkapiSettlementAction: 'stop' }, disabled: false,
        addEventListener: (_name, handler) => { listener = handler; } };
    const element = { querySelector: () => button };
    const calls = [];
    let finishRetry;
    const runtime = {
        stopSettlementWaiting: () => { calls.push('stop'); },
        retrySettlement: () => { calls.push('retry'); return new Promise((_resolve, reject) => { finishRetry = reject; }); }
    };
    const app = { integration: createZkapiUi(runtime).integration,
        showToast: (...args) => calls.push(args) };
    attachZkapiSettlementActions(element, app);
    await listener();
    assert.deepEqual(calls, ['stop']);
    assert.equal(button.disabled, false);
    button.dataset.zkapiSettlementAction = 'retry';
    const pending = listener();
    assert.equal(button.disabled, true);
    await listener();
    assert.deepEqual(calls, ['stop', 'retry']);
    finishRetry(new Error('The temporary-key service is unavailable.'));
    await pending;
    assert.equal(button.disabled, false);
    assert.equal(calls[2][1], 'error');
});

test('mixed payment shell renders recovery above the private composer and clears it for Tickets', async t => {
    let privateModal;
    t.mock.method(AccountModal.prototype, 'restorePendingOperation', function () { privateModal = this; });
    const originalDocument = globalThis.document;
    t.after(() => { globalThis.document = originalDocument; });
    const nodes = new Map();
    const node = () => ({
        ...composerElement(),
        classList: { add() {}, contains: () => true },
        querySelector: () => null,
        querySelectorAll: () => [],
        addEventListener() {},
        before(child) { if (child.id) nodes.set(child.id, child); }
    });
    for (const id of ['chat-toolbar', 'chat-toolbar-panel-space', 'account-modal']) nodes.set(id, node());
    const actions = node();
    globalThis.document = {
        documentElement: { dataset: {} },
        getElementById: id => nodes.get(id) || null,
        createElement: node,
        querySelector: selector => selector === '.composer-bottom-actions' ? actions : null,
        body: { append: child => nodes.set(child.id, child) }
    };
    t.mock.method(zkapiClient, 'init', async () => {});
    t.mock.method(zkapiClient, 'subscribe', () => () => {});
    t.mock.method(zkapiClient, 'subscribeClock', () => () => {});
    t.mock.method(zkapiClient, 'snapshot', () => ({ config: { ux_proposal: 'quiet' }, activities: [] }));
    let mode = 'zkapi';
    let transition = { phase: 'settling' };
    const runtime = { getMode: () => mode, getTransition: () => transition,
        isModeLocked: () => false, isSwitching: () => false };
    const ui = createPaymentModeUi(runtime);
    const app = { integration: ui.integration, services: {
        account: { getState: () => ({}), subscribe: () => () => {} },
        sync: { getStatus: () => ({}), subscribe: () => () => {} }
    } };
    ui.components.accountModal(app);
    ui.mountShell();
    const status = nodes.get('zkapi-composer-status');
    assert.ok(status, 'the mixed shell must actually mount its private recovery control');
    assert.match(status.innerHTML, /data-zkapi-settlement-action="stop"/);
    transition = { phase: 'error', message: 'Your recovery record is saved.' };
    ui.presentation.renderComposer();
    assert.match(status.innerHTML, /data-zkapi-settlement-action="retry"/);
    assert.equal(status.getAttribute('aria-busy'), 'false');
    assert.equal(privateModal.canRestore({ hasSavedModal: true }), true);
    mode = 'tickets';
    ui.presentation.renderComposer();
    assert.equal(privateModal.canRestore({ hasSavedModal: true }), false, 'saved intent cannot bypass OA mode');
    assert.equal(privateModal.canOpen(), false, 'late payment-required events cannot open over OA');
    mode = 'zkapi';
    app.restoringInitialConversation = true;
    assert.equal(privateModal.canRestore({ hasSavedModal: true }), false);
    assert.equal(privateModal.canOpen(), false);
    app.restoringInitialConversation = false;
    mode = 'tickets';
    assert.equal(status.className, 'hidden');
    assert.equal(status.innerHTML, '');
    // Let wallet-method restoration finish while this test's DOM is mounted.
    await new Promise(resolve => setImmediate(resolve));
});

test('low-text proposal panels render compact summaries with detail collapsed', () => {
    for (const proposal of ['receipt', 'relay', 'ambient', 'capsule']) {
        const html = renderZkapiPanelExperience(lowTextState(proposal));
        const summary = html.match(/<summary>([\s\S]*?)<\/summary>/)?.[1] || '';

        assert.match(html, /<details\b/);
        assert.doesNotMatch(html, /<details\b[^>]*\sopen(?:\s|>)/);
        assert.match(summary, />Queued</);
        assert.doesNotMatch(summary, /Message queued/);
        assert.doesNotMatch(summary, /Waiting for the previous private chat/);
        assert.match(html, /<strong>Message queued<\/strong>/);
        assert.match(html, /Waiting for the previous private chat/);
    }
});

test('low-text panel escapes operation copy and stays hidden when idle', () => {
    const unsafe = lowTextState('receipt', {
        primary: {
            phase: 'error',
            tone: 'error',
            title: '<script>bad()</script>',
            detail: '<img src=x onerror=bad()>',
            compact: 'Unsafe',
            busy: false,
            blocksSend: true
        }
    });
    const html = renderZkapiPanelExperience(unsafe);
    assert.doesNotMatch(html, /<script>|<img/);
    assert.match(html, /&lt;script&gt;bad\(\)&lt;\/script&gt;/);
    assert.match(html, /&lt;img src=x onerror=bad\(\)&gt;/);

    const idle = lowTextState('receipt', {
        showComposer: false,
        primary: {
            phase: 'ready',
            tone: 'success',
            title: 'Ready',
            detail: 'Ready.',
            compact: 'Ready',
            busy: false,
            blocksSend: false
        }
    });
    assert.equal(renderZkapiPanelExperience(idle), '');
});

test('passive unfunded state stays hidden even when the send gate requests composer visibility', () => {
    for (const proposal of ['receipt', 'relay', 'ambient', 'capsule']) {
        const state = lowTextState(proposal, {
            showComposer: true,
            primary: {
                phase: 'unfunded',
                tone: 'neutral',
                title: 'Add funds to start chatting',
                detail: 'Use MetaMask once.',
                compact: 'Add funds',
                busy: false,
                blocksSend: true
            }
        });
        const element = composerElement();

        assert.equal(renderZkapiPanelExperience(state), '');
        renderZkapiComposerStatus(element, null, state);
        assert.equal(element.className, 'hidden');
        assert.equal(element.innerHTML, '');
        assert.equal(element.dataset.zkapiStateSignature, undefined);
    }
});

test('passive state clears the visual signature so the same active phase renders again', () => {
    const active = lowTextState('relay');
    const passive = lowTextState('relay', {
        showComposer: true,
        primary: {
            phase: 'ready',
            tone: 'success',
            title: 'Ready to chat',
            detail: 'A private key will be created when you send.',
            compact: 'Ready',
            busy: false,
            blocksSend: false
        }
    });
    const element = composerElement();

    renderZkapiComposerStatus(element, null, active);
    const activeSignature = element.dataset.zkapiStateSignature;
    assert.match(element.className, /zkapi-composer-state--relay/);
    assert.match(element.innerHTML, />Queued</);

    renderZkapiComposerStatus(element, null, passive);
    assert.equal(element.className, 'hidden');
    assert.equal(element.dataset.zkapiStateSignature, undefined);

    renderZkapiComposerStatus(element, null, active);
    assert.equal(element.dataset.zkapiStateSignature, activeSignature);
    assert.match(element.className, /zkapi-composer-state--relay/);
    assert.match(element.innerHTML, />Queued</);
});

test('unchanged clock renders retain composer descendants for every UX proposal', () => {
    for (const proposal of ['quiet', 'guided', 'activity', 'receipt', 'relay', 'ambient', 'capsule']) {
        const state = lowTextState(proposal, {
            journey: [
                { id: 'balance', label: 'Check balance', state: 'complete' },
                { id: 'key', label: 'Create private key', state: 'active' }
            ]
        });
        const element = composerElement();

        renderZkapiComposerStatus(element, null, state);
        const writesAfterFirstRender = element.innerHTMLWrites;
        renderZkapiComposerStatus(element, null, state);

        assert.equal(
            element.innerHTMLWrites,
            writesAfterFirstRender,
            `${proposal} must not replace identical animated descendants`
        );
    }
});

test('composer memoization still renders changed labels and guided journey steps', () => {
    const element = composerElement();
    const activityState = lowTextState('receipt', {
        primary: { phase: 'requesting', activity: { kind: 'settlement' } }
    });
    renderZkapiComposerStatus(element, null, activityState);
    const firstWrites = element.innerHTMLWrites;
    renderZkapiComposerStatus(element, null, lowTextState('receipt', {
        primary: { phase: 'requesting', activity: { kind: 'access' } }
    }));
    assert.equal(element.innerHTMLWrites, firstWrites + 1);
    assert.match(element.innerHTML, />Securing</);

    const guided = composerElement();
    const firstJourney = lowTextState('guided', {
        journey: [{ id: 'balance', label: 'Check balance', state: 'active' }]
    });
    renderZkapiComposerStatus(guided, null, firstJourney);
    const guidedWrites = guided.innerHTMLWrites;
    renderZkapiComposerStatus(guided, null, {
        ...firstJourney,
        journey: [{ id: 'balance', label: 'Check balance', state: 'complete' }]
    });
    assert.equal(guided.innerHTMLWrites, guidedWrites + 1);
    assert.match(guided.innerHTML, /data-state="complete"/);
});

test('same-phase lease retries refresh every proposal without adding low-text clutter', () => {
    const retryMessage = 'Temporary-key service is busy. Retrying in 2 seconds…';
    for (const proposal of ['quiet', 'guided', 'activity', 'receipt', 'relay', 'ambient', 'capsule']) {
        const activity = {
            id: `access-${proposal}`,
            kind: 'access',
            phase: 'requesting',
            status: 'running',
            title: 'Starting private chat',
            message: retryMessage,
            blocksSend: true,
            startedAt: 1,
            updatedAt: 2
        };
        const initial = lowTextState(proposal, {
            primary: {
                phase: 'requesting',
                title: activity.title,
                detail: 'Creating a temporary key for this chat…',
                compact: activity.title,
                activity
            },
            activities: [{ ...activity, message: 'Creating a temporary key for this chat…' }],
            runningActivities: [activity]
        });
        const retrying = lowTextState(proposal, {
            primary: {
                phase: 'requesting',
                title: activity.title,
                detail: retryMessage,
                compact: activity.title,
                activity
            },
            activities: [activity],
            runningActivities: [activity]
        });
        const element = composerElement();

        renderZkapiComposerStatus(element, null, initial);
        const before = element.innerHTML;
        renderZkapiComposerStatus(element, null, retrying);

        assert.notEqual(element.className, 'hidden', `${proposal} must retain an active retry signal`);
        assert.notEqual(element.innerHTML, before, `${proposal} must not memoize stale retry copy`);
        assert.match(element.innerHTML, /Temporary-key service is busy/);
        assert.equal(element.getAttribute('aria-busy'), 'true');
        assert.match(renderZkapiPanelExperience(retrying), /Temporary-key service is busy/);
        if (['receipt', 'relay'].includes(proposal)) {
            assert.match(element.innerHTML, />Retrying</);
        }
        if (['receipt', 'relay', 'ambient', 'capsule'].includes(proposal)) {
            assert.match(element.innerHTML, /role="status"/);
            assert.match(element.innerHTML, /aria-live="polite"/);
        }
    }
});

test('live UI facades render New Chat settlement state in sidebar and right panel', () => {
    const oldChat = { id: 'old-chat', title: 'Old chat' };
    const app = {
        state: {
            currentSessionId: 'new-chat',
            sessions: [oldChat],
            sessionsById: new Map([[oldChat.id, oldChat]])
        },
        elements: {},
        newChatSettlementState: null,
        isSessionStreaming: () => false
    };
    const productOptions = createZkapiUi({
        getTransition: () => app.newChatSettlementState,
        getSessionStatus: () => ({
            label: app.newChatSettlementState?.phase === 'ready' ? 'Private key settled' : 'Closing private key',
            tone: app.newChatSettlementState?.phase === 'ready' ? 'success' : 'working'
        })
    });
    const ui = createVanillaUiInterface(app, { chatDBImpl: {}, ...productOptions });
    const sidebar = Object.create(Sidebar.prototype);
    sidebar.app = ui.sidebar;
    sidebar.deletingSessionIds = new Set();
    const panel = Object.create(RightPanel.prototype);
    panel.app = ui.componentApp;

    app.newChatSettlementState = {
        phase: 'settling',
        sessionId: oldChat.id,
        message: 'Closing in the background.'
    };

    assert.equal(ui.sidebar.newChatSettlementState, undefined, 'product state stays behind explicit callbacks');
    assert.equal(ui.componentApp.integration.getTransition(), app.newChatSettlementState);
    assert.match(sidebar.buildSessionHTML(oldChat), /Closing private key/);
    assert.deepEqual(panel.getMissingApiKeyStatus(), {
        label: 'Closing previous chat key',
        badge: 'Settling',
        badgeClass: 'bg-muted text-muted-foreground'
    });

    app.newChatSettlementState = {
        phase: 'ready',
        sessionId: oldChat.id,
        message: 'Finished.'
    };
    assert.match(sidebar.buildSessionHTML(oldChat), /Private key settled/);
    assert.deepEqual(panel.getMissingApiKeyStatus(), { label: 'Requested on message send', badge: 'Pending', badgeClass: 'bg-muted/30 text-muted-foreground' });
});

test('time-only ticks use a separate channel from semantic client changes', () => {
    let clockEvents = 0;
    let semanticEvents = 0;
    let globalSemanticEvents = 0;
    const originalWindowDispatch = globalThis.window.dispatchEvent;
    globalThis.window.dispatchEvent = () => { globalSemanticEvents += 1; };
    const unsubscribeClock = zkapiClient.subscribeClock(detail => {
        clockEvents += 1;
        assert.equal(typeof detail.now, 'number');
    });
    const unsubscribeSemantic = zkapiClient.subscribe(() => { semanticEvents += 1; });

    try {
        zkapiClient.emitClock();
        assert.equal(clockEvents, 1);
        assert.equal(semanticEvents, 0);
        assert.equal(globalSemanticEvents, 0);

        zkapiClient.emitChange('runtime');
        assert.equal(clockEvents, 1);
        assert.equal(semanticEvents, 1);
        assert.equal(globalSemanticEvents, 1);
    } finally {
        unsubscribeClock();
        unsubscribeSemantic();
        globalThis.window.dispatchEvent = originalWindowDispatch;
    }
});

test('unchanged quiet refreshes do not fan out semantic UI events', async () => {
    const original = {
        browserMode: zkapiClient.browserMode,
        config: zkapiClient.config,
        wallet: zkapiClient.wallet,
        withdrawal: zkapiClient.withdrawal,
        lastError: zkapiClient.lastError,
        apiJson: zkapiClient.apiJson
    };
    zkapiClient.browserMode = false;
    zkapiClient.config = { version: 1 };
    zkapiClient.wallet = { note: null };
    zkapiClient.withdrawal = null;
    zkapiClient.lastError = null;
    zkapiClient.apiJson = async path => path === '/zkapi/v1/config'
        ? { version: 1 }
        : { note: null };
    let semanticEvents = 0;
    const unsubscribe = zkapiClient.subscribe(() => { semanticEvents += 1; });

    try {
        await zkapiClient.refresh({ quiet: true });
        assert.equal(semanticEvents, 0);

        zkapiClient.apiJson = async path => path === '/zkapi/v1/config'
            ? { version: 2 }
            : { note: null };
        await zkapiClient.refresh({ quiet: true });
        assert.equal(semanticEvents, 1, 'a real runtime change must still notify subscribers');
    } finally {
        unsubscribe();
        zkapiClient.browserMode = original.browserMode;
        zkapiClient.config = original.config;
        zkapiClient.wallet = original.wallet;
        zkapiClient.withdrawal = original.withdrawal;
        zkapiClient.lastError = original.lastError;
        zkapiClient.apiJson = original.apiJson;
    }
});

test('automatic daemon probe hides its expected failure from browser-wallet UI', async () => {
    const client = new ZkapiClient();
    client.apiJson = async () => {
        const error = new Error('HTTP 404');
        error.status = 404;
        throw error;
    };
    const events = [];
    const unsubscribe = client.subscribe((snapshot, detail) => {
        events.push({ reason: detail.reason, error: snapshot.lastError });
    });

    try {
        await assert.rejects(client.refresh({ speculative: true }), /HTTP 404/);
        assert.equal(client.lastError, null);
        assert.equal(client.loading, false);
        assert.deepEqual(events, []);
    } finally {
        unsubscribe();
    }
});

test('OA starts the configured browser SDK without URL-driven daemon probes', async () => {
    const originalSearch = globalThis.window.location.search;
    const originalSetInterval = globalThis.window.setInterval;
    const originalDocumentAddEventListener = globalThis.document.addEventListener;
    globalThis.window.setInterval = () => 1;
    globalThis.document.addEventListener = () => {};
    try {
        for (const search of ['', '?zkapiMode=daemon', '?zkapiMode=browser']) {
            globalThis.window.location.search = search;
            const client = new ZkapiClient();
            client.attachWalletEvents = () => {};
            client.reconcileBrowserWithdrawalsOnLoad = async () => true;
            let browserEnables = 0;
            const refreshes = [];
            client.enableBrowserMode = async () => {
                browserEnables += 1;
                client.browserMode = true;
            };
            client.refresh = async options => {
                refreshes.push(options);
                return client.snapshot();
            };
            await client.init();
            assert.equal(browserEnables, 1);
            assert.deepEqual(refreshes, [undefined]);
        }
    } finally {
        globalThis.window.location.search = originalSearch;
        globalThis.window.setInterval = originalSetInterval;
        globalThis.document.addEventListener = originalDocumentAddEventListener;
    }
});

test('right-panel clock ticks update countdown text without replacing interactive UI', () => {
    const originalDocument = globalThis.document;
    let loads = 0;
    let expiryText = '';
    globalThis.document = {
        querySelector(selector) {
            if (selector.includes('[data-zkapi-note-expiry]')) {
                return {
                    set textContent(value) { expiryText = value; },
                    get textContent() { return expiryText; }
                };
            }
            return null;
        }
    };

    const panel = Object.create(RightPanel.prototype);
    panel.loadSessionData = () => { loads += 1; };
    try {
        panel.handleZkapiClock();
        assert.equal(loads, 0, 'a clock tick must not rebuild the panel');
        panel.handleZkapiChange({ reason: 'clock' });
        assert.equal(loads, 0, 'a legacy clock event must remain non-rendering');
        panel.handleZkapiChange({ reason: 'note' });
        assert.equal(loads, 1, 'a real billing update should still rebuild the panel');
    } finally {
        globalThis.document = originalDocument;
    }
});

test('account clock patches preserve the modal and enable escape finalization at its deadline', () => {
    const originalWallet = zkapiClient.wallet;
    const originalWithdrawal = zkapiClient.withdrawal;
    const originalFormatExpiry = zkapiClient.formatExpiry;
    const originalActiveElement = globalThis.document.activeElement;
    const countdown = { textContent: '' };
    const finalizeButton = { textContent: '', disabled: true };
    const noteExpiry = { textContent: '' };
    const withdrawalCheckbox = { checked: true };
    let overlayWrites = 0;
    const overlay = {
        scrollTop: 137,
        set innerHTML(_value) { overlayWrites += 1; },
        querySelector(selector) {
            if (selector === '[data-zkapi-escape-countdown]') return countdown;
            if (selector === '#zkapi-finalize-btn') return finalizeButton;
            if (selector === '[data-zkapi-balance-expiry]') return noteExpiry;
            if (selector === '#zkapi-withdraw-confirm') return withdrawalCheckbox;
            return null;
        }
    };
    const deadline = 2_000_000_000;
    zkapiClient.wallet = { note: { expiry_ts: deadline + 10_000 } };
    zkapiClient.withdrawal = { phase: 'pending', challengeDeadline: deadline };
    let expiryLabel = '1m';
    zkapiClient.formatExpiry = () => expiryLabel;
    globalThis.document.activeElement = finalizeButton;

    const modal = Object.create(AccountModal.prototype);
    modal.isOpen = true;
    modal.overlay = overlay;
    modal.view = 'withdraw';
    modal.busy = false;
    try {
        modal.handleZkapiClock(deadline * 1000 - 1);
        assert.equal(finalizeButton.disabled, true);
        assert.equal(finalizeButton.textContent, 'Finalize in 1m');
        assert.equal(countdown.textContent, 'Finalize in 1m.');
        assert.equal(globalThis.document.activeElement, finalizeButton);
        assert.equal(withdrawalCheckbox.checked, true);
        assert.equal(overlay.scrollTop, 137);
        assert.equal(overlayWrites, 0, 'the dialog subtree must remain mounted');

        modal.handleZkapiClock(deadline * 1000);
        assert.equal(finalizeButton.disabled, false);
        assert.equal(finalizeButton.textContent, 'Finalize in your Ethereum wallet');
        assert.equal(countdown.textContent, 'The safety window is complete.');
        assert.equal(globalThis.document.activeElement, finalizeButton);
        assert.equal(withdrawalCheckbox.checked, true);
        assert.equal(overlay.scrollTop, 137);
        assert.equal(overlayWrites, 0, 'crossing the deadline must not rebuild the dialog');

        modal.view = 'balance';
        modal.handleZkapiClock(deadline * 1000);
        assert.equal(noteExpiry.textContent, 'expires in 1m');
        expiryLabel = 'expired';
        modal.handleZkapiClock(deadline * 1000 + 1);
        assert.equal(noteExpiry.textContent, 'expired');
        assert.equal(overlayWrites, 0);
    } finally {
        zkapiClient.wallet = originalWallet;
        zkapiClient.withdrawal = originalWithdrawal;
        zkapiClient.formatExpiry = originalFormatExpiry;
        globalThis.document.activeElement = originalActiveElement;
    }
});

test('closing the balance dialog restores a remounted trigger and retains connected ID-less focus targets', () => {
    const originalDocument = globalThis.document;
    let liveFocus = 0;
    let oldFocus = 0;
    let connectedFocus = 0;
    const liveTrigger = { focus: () => { liveFocus += 1; } };
    globalThis.document = { getElementById: id => id === 'zkapi-panel-fund' ? liveTrigger : null };
    const modal = Object.create(AccountModal.prototype);
    modal.overlay = { classList: { add() {} }, innerHTML: '<div>Balance</div>' };
    modal.returnFocusEl = { id: 'zkapi-panel-fund', isConnected: false, focus: () => { oldFocus += 1; } };
    modal.isOpen = true;
    try {
        modal.close();
        assert.equal(liveFocus, 1);
        assert.equal(oldFocus, 0);
        assert.equal(modal.returnFocusEl, null);
        modal.isOpen = true;
        modal.returnFocusEl = { isConnected: true, focus: () => { connectedFocus += 1; } };
        modal.close();
        assert.equal(connectedFocus, 1);
        modal.isOpen = true;
        modal.returnFocusEl = { isConnected: false, focus: () => assert.fail('A detached ID-less target cannot regain focus') };
        modal.close();
        assert.equal(liveFocus, 1, 'No unrelated fallback target is invented');
    } finally { globalThis.document = originalDocument; }
});

test('wallet work narrates inside the dialog: the action row becomes a status row, close goes quiet, no toast', () => {
    const originalWallet = zkapiClient.wallet;
    const originalConfig = zkapiClient.config;
    zkapiClient.wallet = { has_note: false, note: null };
    zkapiClient.config = { funding: { billing_token_symbol: 'USDC' } };
    const modal = Object.create(AccountModal.prototype);
    const toasts = [];
    modal.app = { showToast: (message, kind) => toasts.push(`${kind}:${message}`) };
    modal.isOpen = true;
    modal.busy = true;
    modal.status = 'Checking your wallet…';
    modal.depositAmount = '5';
    modal.renderWithdrawalStatusLink = () => '';
    let progressText = null;
    const progressElement = {
        textContent: 'Checking your wallet…',
        classList: { remove() {}, add(name) { progressText = `${this.owner.textContent}|${name}`; } },
        offsetWidth: 0
    };
    progressElement.classList.owner = progressElement;
    modal.overlay = { querySelector: selector => (selector === '[data-zkapi-progress-text]' ? progressElement : null) };

    try {
        const html = modal.renderBalance();
        assert.match(html, /class="zkapi-progress" role="status" aria-live="polite"/);
        assert.match(html, /data-zkapi-progress-text[^>]*>Checking your wallet…</);
        assert.doesNotMatch(html, /id="zkapi-deposit-btn"/, 'the button gives way to the status row');

        modal.setStatus('Waiting for MetaMask…');
        assert.equal(progressText, 'Waiting for your Ethereum wallet…|t-text-swap', 'new words settle into the same row');
        assert.deepEqual(toasts, [], 'the open dialog narrates; no toast');

        modal.close();
        assert.equal(modal.isOpen, true, 'the dialog cannot be left mid-work');

        modal.isOpen = false;
        modal.setStatus('Confirming the deposit…');
        assert.deepEqual(toasts, [], 'closed, no toast either: the right panel activity carries the words');
    } finally {
        zkapiClient.wallet = originalWallet;
        zkapiClient.config = originalConfig;
    }
});

test('a canceled custom deposit resumes from its durable amount after modal state changes', () => {
    const originalWallet = zkapiClient.wallet;
    const originalConfig = zkapiClient.config;
    const originalFormatBillingAmount = zkapiClient.formatBillingAmount;
    zkapiClient.wallet = { has_note: false, note: null };
    zkapiClient.config = {
        pending_deposit: {
            phase: 'prepared',
            amount: 5_000_000,
            next_note_id: 7
        },
        funding: {
            billing_token_symbol: 'USDC'
        }
    };
    zkapiClient.formatBillingAmount = amount => amount === 5_000_000 ? '5' : 'wrong';
    const modal = Object.create(AccountModal.prototype);
    modal.busy = false;
    modal.depositAmount = '99';
    modal.renderWithdrawalStatusLink = () => '';

    try {
        const html = modal.renderBalance();
        // The caption says "Saved deposit"; one short note says why. No lede.
        assert.doesNotMatch(html, /zkapi-lede/);
        assert.match(html, /Saved deposit/);
        assert.match(html, /Before resuming, check your Ethereum wallet for a pending transaction\./);
        assert.doesNotMatch(html, /value="99"/);
        assert.match(html, /Resume with Ethereum wallet/);
    } finally {
        zkapiClient.wallet = originalWallet;
        zkapiClient.config = originalConfig;
        zkapiClient.formatBillingAmount = originalFormatBillingAmount;
    }
});

test('balance views keep funding and payment history while omitting redundant wallet details', () => {
    const original = { wallet: zkapiClient.wallet, config: zkapiClient.config,
        withdrawals: zkapiClient.withdrawals, deposits: zkapiClient.deposits };
    const modal = Object.create(AccountModal.prototype);
    modal.busy = false;
    zkapiClient.config = { funding: { chain_id: 1, billing_token_symbol: 'USDC' } };
    zkapiClient.withdrawals = [];
    zkapiClient.deposits = [];
    try {
        for (const note of [null, { deposit_amount: 2_000_000, current_balance: 1_600_000 }]) {
            zkapiClient.wallet = { has_note: Boolean(note), note };
            const html = modal.renderBalance();
            assert.match(html, /Payment history/);
            assert.doesNotMatch(html, /zkapi-watch-token-btn|Add USDC to (?:MetaMask|your Ethereum wallet)|<dt>Network|<dt>Request mode|<dt>Vault/);
            assert.match(html, note ? /Withdraw/ : /Continue with Ethereum wallet/);
        }
        assert.match(modal.renderWithdrawalRecords(), /Your deposits and withdrawals will appear here/);
        assert.match(modal.renderWithdrawalRecords(), /Back to balance/);
    } finally { Object.assign(zkapiClient, original); }
});

test('payment history combines deposits and withdrawals by date without inventing missing details', () => {
    const original = { wallet: zkapiClient.wallet, config: zkapiClient.config,
        withdrawals: zkapiClient.withdrawals, deposits: zkapiClient.deposits };
    const modal = Object.create(AccountModal.prototype);
    modal.busy = false;
    const hash = `0x${'ab'.repeat(32)}`;
    zkapiClient.config = { funding: { chain_id: 1 } };
    zkapiClient.wallet = { has_note: false, note: null };
    zkapiClient.deposits = [
        { recordId: 'old-deposit', status: 'confirmed', amount: 5_000_000, createdAt: null, confirmedAt: null },
        { recordId: 'new-deposit', status: 'confirmed', amount: 2_000_000, confirmedAt: 3_000, transactionHash: hash }
    ];
    zkapiClient.withdrawals = [{ recordId: 'returned', mode: 'mutual', phase: 'closed', payoutVerified: true,
        finalBalance: 1_000_000, destination: '0x123456', createdAt: 2_000 }];
    try {
        const html = modal.renderWithdrawalRecords();
        assert.ok(html.indexOf('data-deposit-record="new-deposit"') < html.indexOf('data-withdrawal-record="returned"'));
        assert.ok(html.indexOf('data-withdrawal-record="returned"') < html.indexOf('data-deposit-record="old-deposit"'));
        assert.match(html, /Deposit/);
        assert.match(html, /added to private balance/);
        assert.match(html, /Withdrawal · Mutual close/);
        assert.match(html, /Date unavailable/);
        assert.match(html, new RegExp(`https://etherscan.io/tx/${hash}`));
        assert.equal((html.match(/View transaction/g) || []).length, 1);
        assert.doesNotMatch(modal.renderDepositRecord({ recordId: '<script>', status: 'confirmed',
            amount: 1, transactionHash: 'javascript:alert(1)' }), /<script>|href=/);
    } finally { Object.assign(zkapiClient, original); }
});

test('confirmed deposit history shows only receipt-backed ETH fees, including after reload', () => {
    const modal = Object.create(AccountModal.prototype);
    const record = { recordId: 'confirmed-fee', status: 'confirmed', amount: 2_000_000,
        feeWei: '351234567890123', transactionHash: `0x${'ef'.repeat(32)}` };
    const html = modal.renderDepositRecord(record);
    assert.match(html, /Actual network fee: 0\.000351234567890123 ETH/);
    assert.doesNotMatch(modal.renderDepositRecord({ ...record, feeWei: null }), /Actual network fee/);
    assert.doesNotMatch(modal.renderDepositRecord({ ...record, feeWei: '<script>123</script>' }), /Actual network fee|<script>/);
    assert.doesNotMatch(modal.renderDepositRecord({ ...record, status: 'pending' }), /Actual network fee/);
});

test('expiry history distinguishes a deadline from a verified payment, including after archival', () => {
    const original = { wallet: zkapiClient.wallet, config: zkapiClient.config,
        withdrawals: zkapiClient.withdrawals, deposits: zkapiClient.deposits };
    const modal = Object.create(AccountModal.prototype);
    modal.busy = false;
    const hash = `0x${'cd'.repeat(32)}`;
    zkapiClient.config = { funding: { chain_id: 11155111 } };
    zkapiClient.wallet = { has_note: false, note: null };
    zkapiClient.withdrawals = [];
    zkapiClient.deposits = [{ recordId: 'original', deploymentId: 'test', noteId: 7,
        status: 'confirmed', amount: 2_000_000, expiryTs: 1000, confirmedAt: 1000 }];
    try {
        const expired = modal.renderWithdrawalRecords();
        assert.match(expired, /Expiry deadline passed/);
        assert.match(expired, /No automatic refund/);
        assert.match(expired, /A treasury claim has not been confirmed here/);
        assert.match(expired, /Check expiry payments/);
        assert.doesNotMatch(expired, /No refund was made|was paid|View transaction/);
        zkapiClient.deposits[0].expiryClaim = { amount: 2_000_000, claimedAt: 1_100_000,
            transactionHash: hash, blockHash: `0x${'ef'.repeat(32)}`, blockNumber: 12 };
        const claimed = modal.renderWithdrawalRecords();
        assert.match(claimed, /Expiry claim/);
        assert.match(claimed, /\$2\.00 from the original deposit was paid to the service treasury\. No refund was made/);
        assert.match(claimed, new RegExp(`https://sepolia.etherscan.io/tx/${hash}`));
        assert.doesNotMatch(claimed, /Check expiry payments|Expiry deadline passed/);
        assert.ok(claimed.indexOf('data-expiry-record=') < claimed.indexOf('data-deposit-record='));
        delete zkapiClient.deposits[0].expiryClaim;
        zkapiClient.withdrawals = [{ deploymentId: 'test', noteId: 7, phase: 'closed', payoutVerified: true,
            mode: 'mutual', recordId: 'return', finalBalance: 1_000_000 }];
        assert.doesNotMatch(modal.renderWithdrawalRecords(), /Expiry deadline passed/,
            'an already returned deposit does not acquire an expiry payment');
    } finally { Object.assign(zkapiClient, original); }
});

test('payment history updates once at expiry without remounting on every clock tick', () => {
    const original = { wallet: zkapiClient.wallet, config: zkapiClient.config,
        withdrawals: zkapiClient.withdrawals, deposits: zkapiClient.deposits };
    const realNow = Date.now;
    const modal = Object.create(AccountModal.prototype);
    Object.assign(modal, { busy: false, isOpen: true, view: 'withdrawals',
        overlay: { querySelector: () => null, querySelectorAll: () => [] } });
    let renders = 0;
    modal.render = () => { renders += 1; modal.renderWithdrawalRecords(); };
    zkapiClient.config = {};
    zkapiClient.wallet = { has_note: false, note: null };
    zkapiClient.withdrawals = [];
    zkapiClient.deposits = [{ recordId: 'original', status: 'confirmed', amount: 2_000_000, expiryTs: 1000 }];
    try {
        Date.now = () => 999_999;
        modal.renderWithdrawalRecords();
        modal.handleZkapiClock(Date.now());
        assert.equal(renders, 0);
        Date.now = () => 1_000_000;
        modal.handleZkapiClock(Date.now());
        assert.equal(renders, 1);
        Date.now = () => 1_001_000;
        modal.handleZkapiClock(Date.now());
        assert.equal(renders, 1);
    } finally { Date.now = realNow; Object.assign(zkapiClient, original); }
});

test('unconfirmed deposits have honest status and link only to their current recovery flow', () => {
    const original = zkapiClient.config;
    const modal = Object.create(AccountModal.prototype);
    modal.busy = false;
    zkapiClient.config = { pending_deposit: { operation_id: 'current' } };
    try {
        const pending = modal.renderDepositRecord({ recordId: 'pending', operationId: 'current',
            status: 'pending', pendingPhase: 'ambiguous', amount: 2_000_000 });
        assert.match(pending, /Status unknown/);
        assert.match(pending, /View deposit/);
        assert.doesNotMatch(pending, /Added|added to private balance/);
        assert.doesNotMatch(modal.renderDepositRecord({ recordId: 'older', operationId: 'other',
            status: 'pending', amount: 2_000_000 }), /View deposit/);
        assert.match(modal.renderDepositRecord({ recordId: 'failed', status: 'failed', amount: 2_000_000 }), /Failed/);
    } finally { zkapiClient.config = original; }
});

test('a returned withdrawal is a success while network finality runs without user action', () => {
    const original = {
        wallet: zkapiClient.wallet,
        config: zkapiClient.config,
        withdrawals: zkapiClient.withdrawals
    };
    const hash = '0x34e298c17052af34acbbd1f1fd0e910f023af7938c5ff1656dd4bd669140ae48';
    const returned = {
        recordId: 'returned-mainnet',
        mode: 'mutual',
        phase: 'closed_unconfirmed',
        payoutVerified: true,
        chainStatus: 'closed',
        finalBalance: 1_972_567,
        destination: '0x68674ae1f6188391da867255d9ae0e099fc354c5',
        transactionHash: hash
    };
    zkapiClient.wallet = { has_note: false, note: null };
    zkapiClient.config = { funding: { chain_id: 1 } };
    zkapiClient.withdrawals = [returned];
    const modal = Object.create(AccountModal.prototype);
    modal.busy = false;
    try {
        const html = modal.renderWithdrawalRecords();
        assert.equal(modal.withdrawalRecordLabel(returned), 'Returned');
        assert.match(html, /returned to/);
        assert.match(html, /Funds are in your wallet/);
        assert.match(html, /no action is needed/);
        assert.match(html, new RegExp(`href="https://etherscan.io/tx/${hash}"`));
        // Funding happens in the balance view, which is where an empty modal
        // opens; the history offers no "Add a new private balance" of its own.
        assert.doesNotMatch(html, /Add a new private balance/);
        assert.doesNotMatch(html, /returning to|finalizing|Check status|Check on-chain status|data-finalize-withdrawal|Replace transaction/);
        assert.doesNotMatch(modal.renderWithdrawalStatusLink(), /withdrawals? to check/);

        const pendingEscape = {
            ...returned, recordId: 'pending-escape', mode: 'escape', phase: 'pending',
            chainStatus: 'pending_withdrawal', challengeDeadline: Math.floor(Date.now() / 1000) - 1
        };
        zkapiClient.withdrawals = [returned, pendingEscape];
        const mixedHtml = modal.renderWithdrawalRecords();
        assert.match(mixedHtml, /data-finalize-withdrawal="pending-escape"/);
        assert.doesNotMatch(mixedHtml, /data-finalize-withdrawal="returned-mainnet"/);
        assert.match(modal.renderWithdrawalStatusLink(), /1 withdrawal to check/);

        zkapiClient.config.funding.chain_id = 11155111;
        assert.equal(modal.withdrawalTransactionUrl(returned), `https://sepolia.etherscan.io/tx/${hash}`);
        assert.equal(modal.withdrawalTransactionUrl({ ...returned, transactionHash: 'javascript:alert(1)' }), null);
        assert.equal(modal.withdrawalTransactionUrl({ ...returned, mode: 'escape' }), null,
            'an escape-start transaction must not be linked as proof of payout');
        zkapiClient.config.funding.chain_id = 999;
        assert.equal(modal.withdrawalTransactionUrl(returned), null);
    } finally {
        Object.assign(zkapiClient, original);
    }
});

test('legacy closed records do not claim a payout or return amount without receipt verification', () => {
    const original = { wallet: zkapiClient.wallet, config: zkapiClient.config,
        withdrawals: zkapiClient.withdrawals, deposits: zkapiClient.deposits };
    Object.assign(zkapiClient, { wallet: { note: null }, config: { funding: { chain_id: 1 } }, deposits: [] });
    const modal = Object.create(AccountModal.prototype);
    try {
        for (const phase of ['closed', 'closed_unconfirmed']) {
            const record = { recordId: 'legacy-close', mode: 'mutual', phase, finalBalance: 1_900_000,
                transactionHash: `0x${'ab'.repeat(32)}`, destination: '0x123456' };
            zkapiClient.withdrawals = [record];
            const html = modal.renderWithdrawalRecords();
            assert.equal(modal.withdrawalRecordLabel(record), 'Balance closed');
            assert.match(html, /Payment not verified/);
            assert.doesNotMatch(html, /Returned|returned to|Funds are in your wallet|\$1\.90|badge-status-success/);
            assert.doesNotMatch(html, /data-withdraw-background|data-restore-withdrawal|data-finalize-withdrawal/);
            assert.match(html, /View transaction/);
        }
    } finally { Object.assign(zkapiClient, original); }
});

test('a verified expiry claim replaces obsolete withdrawal actions only for its exact deployment and note', () => {
    const original = { wallet: zkapiClient.wallet, config: zkapiClient.config,
        withdrawals: zkapiClient.withdrawals, deposits: zkapiClient.deposits };
    const hash = `0x${'cd'.repeat(32)}`;
    Object.assign(zkapiClient, { wallet: { note: null }, config: { funding: { chain_id: 1 },
        late_withdrawal_attempts: [{ deploymentId: 'test', note_id: 7, transaction_hash: hash }] },
    deposits: [{ recordId: 'original', deploymentId: 'test', noteId: 7, status: 'confirmed',
        amount: 2_000_000, expiryTs: 1000, expiryClaim: { amount: 2_000_000,
            claimedAt: 1_100_000, blockNumber: 12, blockHash: `0x${'ef'.repeat(32)}`, transactionHash: hash } }],
    withdrawals: [
        { recordId: 'obsolete-close', deploymentId: 'test', noteId: 7, mode: 'mutual', phase: 'closed', finalBalance: 1_900_000 },
        { recordId: 'obsolete-restore', deploymentId: 'test', noteId: 7, mode: 'escape', phase: 'restored', finalBalance: 1_900_000 },
        { recordId: 'other-deployment', deploymentId: 'other', noteId: 7, mode: 'mutual', phase: 'parked', finalBalance: 1_000_000 },
        { recordId: 'other-note', deploymentId: 'test', noteId: 8, mode: 'mutual', phase: 'parked', finalBalance: 1_000_000 }
    ] });
    const modal = Object.create(AccountModal.prototype);
    try {
        const html = modal.renderWithdrawalRecords();
        assert.match(html, /Expiry claim/);
        assert.match(html, /No refund was made/);
        assert.doesNotMatch(html, /obsolete-close|obsolete-restore/);
        assert.match(html, /data-sync-late-withdrawal/);
        assert.match(html, /data-withdrawal-record="other-deployment"/);
        assert.match(html, /data-withdrawal-record="other-note"/);
        assert.match(modal.renderWithdrawalStatusLink(), /3 withdrawals to check/);
    } finally { Object.assign(zkapiClient, original); }
});

test('an idle Withdraw dialog redirects to a claimed balance while live wallet recovery remains available', () => {
    const original = { wallet: zkapiClient.wallet, config: zkapiClient.config,
        withdrawal: zkapiClient.withdrawal, withdrawals: zkapiClient.withdrawals, deposits: zkapiClient.deposits };
    const hash = `0x${'cd'.repeat(32)}`;
    Object.assign(zkapiClient, { wallet: { note: { note_id: 7, expiry_ts: 1000,
        deposit_amount: 2_000_000, current_balance: 1_500_000 } }, config: {},
    withdrawal: null, withdrawals: [], deposits: [{ recordId: 'original', deploymentId: 'test',
        noteId: 7, status: 'confirmed', amount: 2_000_000, expiryTs: 1000,
        expiryClaim: { amount: 2_000_000, claimedAt: 1_100_000, blockNumber: 12,
            blockHash: `0x${'ef'.repeat(32)}`, transactionHash: hash } }] });
    const modal = Object.create(AccountModal.prototype);
    Object.assign(modal, { view: 'withdraw', busy: false,
        overlay: { innerHTML: '', querySelector: () => null, querySelectorAll: () => [] } });
    try {
        assert.match(modal.renderWithdrawal(), /id="zkapi-archive-expired-balance-btn"/);
        assert.doesNotMatch(modal.renderWithdrawal(), /id="zkapi-withdraw-btn"|id="zkapi-finalize-btn"/);
        modal.render();
        assert.equal(modal.view, 'balance');
        assert.match(modal.overlay.innerHTML, /id="zkapi-payment-title"[^>]*>Private balance/);
        modal.view = 'withdraw';
        modal.busy = true;
        modal.render();
        assert.equal(modal.view, 'withdraw', 'An owned wallet operation keeps its existing surface');
        modal.busy = false;
        zkapiClient.config.prepared_withdrawal = { phase: 'submitted', transaction_hash: hash };
        modal.render();
        assert.equal(modal.view, 'withdraw');
        assert.match(modal.overlay.innerHTML, /id="zkapi-sync-withdrawal-btn"/);
        assert.doesNotMatch(modal.overlay.innerHTML, /id="zkapi-withdraw-btn"/);
        zkapiClient.config.prepared_withdrawal = { phase: 'awaiting_wallet' };
        modal.render();
        assert.equal(modal.view, 'withdraw');
        assert.match(modal.overlay.innerHTML, /id="zkapi-recover-withdrawal-btn"/);
        zkapiClient.config.prepared_withdrawal = { phase: 'dropped_or_pending', transaction_hash: hash,
            replacement_available: true };
        modal.render();
        assert.equal(modal.view, 'withdraw');
        assert.match(modal.overlay.innerHTML, /id="zkapi-sync-withdrawal-btn"/);
        assert.doesNotMatch(modal.overlay.innerHTML,
            /Returned to (?:MetaMask|your Ethereum wallet)|id="zkapi-retry-dropped-withdrawal-btn"|id="zkapi-retry-withdrawal-btn"|id="zkapi-finalize-btn"|id="zkapi-withdraw-btn"/);
        delete zkapiClient.config.prepared_withdrawal;
        modal.render();
        assert.equal(modal.view, 'balance');
    } finally { Object.assign(zkapiClient, original); }
});

test('set-aside mutual balances stay independently withdrawable alongside a new note or deposit', () => {
    const original = { wallet: zkapiClient.wallet, config: zkapiClient.config, withdrawals: zkapiClient.withdrawals };
    const modal = Object.create(AccountModal.prototype);
    modal.busy = false;
    const record = { recordId: 'old-note', noteId: 7, mode: 'mutual', phase: 'parked', finalBalance: 1_900_000 };
    zkapiClient.wallet = { has_note: true, note: { note_id: 8, current_balance: 5_000_000 } };
    zkapiClient.config = { funding: { chain_id: 1 }, pending_deposit: { phase: 'prepared' } };
    zkapiClient.withdrawals = [record];
    try {
        const html = modal.renderWithdrawalRecords();
        assert.match(html, /Ready to withdraw/);
        assert.match(html, /\$1\.90 set aside/);
        assert.match(html, /data-withdraw-background="old-note"[^>]*>Withdraw \$1\.90/);
        assert.doesNotMatch(html, /data-withdraw-background="old-note"[^>]*disabled|data-restore-withdrawal|returning|Challenge/);
        for (const phase of ['challenged_unconfirmed', 'recovery_unconfirmed']) {
            record.phase = phase;
            const pending = modal.renderWithdrawalRecords();
            assert.match(pending, /Checking balance/);
            assert.match(pending, /data-sync-withdrawal="old-note"/);
            assert.doesNotMatch(pending, /The challenge|Challenge ·|data-withdraw-background/);
        }
        for (const phase of ['closed', 'closed_unconfirmed']) {
            assert.equal(modal.withdrawalRecordLabel({ ...record, phase, payoutVerified: true, startSubmissionId: 'old-claim' }), 'Returned');
        }
        Object.assign(record, { phase: 'submitted_unconfirmed', startSubmissionId: 'before-preflight',
            backgroundPreparationCancelable: true });
        const interrupted = modal.renderWithdrawalRecords();
        assert.match(interrupted, /Preparation incomplete/);
        assert.match(interrupted, /data-cancel-background-preparation="old-note"/);
        assert.doesNotMatch(interrupted, /data-withdraw-background/);
        record.backgroundPreparationCancelable = false;
        assert.doesNotMatch(modal.renderWithdrawalRecords(), /Cancel preparation/);
    } finally { Object.assign(zkapiClient, original); }
});

test('historical wallet progress changes in place without remounting the card', () => {
    const modal = Object.create(AccountModal.prototype);
    modal.busy = true;
    modal.backgroundProgress = { recordId: 'old-note', phase: 'preparing' };
    const label = { dataset: { backgroundProgress: 'old-note' }, textContent: 'Preparing withdrawal' };
    modal.overlay = { querySelectorAll: () => [label] };
    modal.render = () => assert.fail('progress must not rebuild the modal');
    modal.backgroundProgress.phase = 'wallet';
    modal.updateBackgroundProgress();
    assert.equal(label.textContent, 'Waiting for your Ethereum wallet');
    modal.backgroundProgress.phase = 'confirming';
    modal.updateBackgroundProgress();
    assert.equal(label.textContent, 'Confirming transaction');
    assert.equal(modal.backgroundProgressLabel('new-note'), null);
});

test('mined withdrawals with a temporary status outage get neutral feedback instead of a failed-payment outcome', async t => {
    const modal = Object.create(AccountModal.prototype);
    const toasts = [];
    modal.app = { showToast: (...args) => toasts.push(args) };
    modal.busy = false;
    modal.render = () => {};
    modal.setStatus = (message, isError) => { modal.status = message; modal.statusError = isError; };
    let completed;
    t.mock.method(zkapiClient, 'beginActivity', () => 'mined-activity');
    t.mock.method(zkapiClient, 'completeActivity', (id, detail) => { completed = { id, ...detail }; });
    t.mock.method(zkapiClient, 'failActivity', () => assert.fail('a mined transaction is not a failed payment'));
    const error = Object.assign(new Error('RPC temporarily unavailable'), {
        shortMessage: 'Your withdrawal transaction was mined. Its status will be checked automatically; you can close this window.',
        withdrawalConfirmationPending: true
    });
    await modal.run(async () => { throw error; }, { kind: 'withdrawal', title: 'Returning your balance' });
    assert.equal(modal.busy, false);
    assert.equal(modal.statusError, false);
    assert.deepEqual(toasts, [], 'outcomes are said in the dialog, never toasted');
    assert.equal(modal.outcome.message, error.shortMessage);
    assert.equal(modal.outcome.tone, 'info');
    assert.equal(completed.title, 'Withdrawal transaction mined');
    assert.equal(completed.phase, 'mined');
});

test('a missing withdrawal receipt exposes safe same-nonce replacement', () => {
    const originalWallet = zkapiClient.wallet;
    const originalConfig = zkapiClient.config;
    const originalWithdrawal = zkapiClient.withdrawal;
    const originalFormatMoney = zkapiClient.formatMoney;
    zkapiClient.wallet = {
        has_note: true,
        note: { note_id: 7, current_balance: 1_000_000 }
    };
    zkapiClient.config = {
        prepared_withdrawal: {
            phase: 'dropped_or_pending',
            mode: 'escape',
            note_id: 7,
            destination: `0x${'12'.repeat(20)}`,
            transaction_hash: `0x${'34'.repeat(32)}`,
            replacement_available: true,
            clearance_reserved: false
        }
    };
    zkapiClient.withdrawal = null;
    zkapiClient.formatMoney = () => '$1.00';
    const modal = Object.create(AccountModal.prototype);
    modal.busy = false;
    modal.withdrawMode = 'escape';

    try {
        const html = modal.renderWithdrawal();
        assert.match(html, /No receipt yet/);
        assert.match(html, /resubmit it with its original nonce/);
        assert.match(html, /id="zkapi-retry-dropped-withdrawal-btn"[^>]*>Resubmit</);
        assert.match(html, /id="zkapi-sync-withdrawal-btn"/);
        assert.doesNotMatch(html, /id="zkapi-withdraw-btn"/);
    } finally {
        zkapiClient.wallet = originalWallet;
        zkapiClient.config = originalConfig;
        zkapiClient.withdrawal = originalWithdrawal;
        zkapiClient.formatMoney = originalFormatMoney;
    }
});

test('welcome success is edge-triggered and retains focus across later state events', () => {
    const originalDocument = globalThis.document;
    const originalWallet = zkapiClient.wallet;
    const focusedChild = { id: 'welcome-continue' };
    const overlay = {};
    globalThis.document = {
        ...originalDocument,
        activeElement: focusedChild,
        getElementById(id) { return id === 'welcome-panel' ? overlay : null; }
    };
    zkapiClient.wallet = { has_note: true, note: { current_balance: 1 } };
    const panel = new WelcomePanel({});
    panel.isOpen = true;
    panel.step = 'welcome';
    panel.busy = false;
    let renders = 0;
    panel.render = () => { renders += 1; };

    try {
        zkapiClient.emitClock();
        assert.equal(renders, 0, 'clock ticks must not reach the welcome renderer');
        zkapiClient.emitChange('runtime');
        assert.equal(renders, 1);
        assert.equal(panel.step, 'success');
        assert.equal(globalThis.document.activeElement, focusedChild);

        zkapiClient.emitChange('runtime');
        assert.equal(renders, 1, 'duplicate funded state must retain the existing success DOM');
        assert.equal(globalThis.document.activeElement, focusedChild);
    } finally {
        panel.unsubscribe?.();
        zkapiClient.wallet = originalWallet;
        globalThis.document = originalDocument;
    }
});

test('right-panel progress disclosures preserve both open and closed state across real rerenders', () => {
    const originalDocument = globalThis.document;
    const basePrototype = Object.getPrototypeOf(RightPanel.prototype);
    const originalBaseRender = basePrototype.renderTopSectionOnly;
    const disclosure = (open) => {
        const listeners = new Map();
        return {
            open,
            addEventListener(type, listener) { listeners.set(type, listener); },
            toggle(value) {
                this.open = value;
                listeners.get('toggle')?.();
            }
        };
    };
    let current = disclosure(true);
    let replacement = disclosure(false);
    let afterBaseRender = false;
    globalThis.document = {
        querySelector(selector) {
            return selector.includes('zkapi-panel-experience') ? afterBaseRender ? replacement : current : null;
        }
    };
    basePrototype.renderTopSectionOnly = () => { afterBaseRender = true; };

    const panel = Object.create(RightPanel.prototype);
    try {
        panel.renderTopSectionOnly();
        assert.equal(replacement.open, true);

        replacement.toggle(false);
        current = replacement;
        replacement = disclosure(true);
        afterBaseRender = false;
        panel.renderTopSectionOnly();
        assert.equal(replacement.open, false, 'closing the progress disclosure must persist');
    } finally {
        basePrototype.renderTopSectionOnly = originalBaseRender;
        globalThis.document = originalDocument;
    }
});

test('balance panel keeps its billing ? ; the modal explains billing as a guide disclosure', () => {
    const original = { wallet: zkapiClient.wallet, config: zkapiClient.config,
        withdrawal: zkapiClient.withdrawal, withdrawals: zkapiClient.withdrawals, lastError: zkapiClient.lastError };
    Object.assign(zkapiClient, { wallet: { note: { note_id: 7, deposit_amount: 2_000_000,
        current_balance: 1_500_000, expiry_ts: Math.floor(Date.now() / 1000) + 86400 } },
    config: {}, withdrawal: null, withdrawals: [], lastError: null });
    const panel = Object.create(RightPanel.prototype);
    panel.app = { integration: { getTransition: () => null } };
    panel.privateBalanceHelpOpen = { billing: true, expiry: true };
    panel.escapeHtml = value => String(value ?? '');
    const modal = Object.create(AccountModal.prototype);
    modal.privateBalanceHelpOpen = { billing: false, expiry: true };
    modal.view = 'balance';
    modal.overlay = { innerHTML: '', querySelector: () => null, querySelectorAll: () => [] };
    try {
        const html = panel.billingSectionHTML();
        assert.doesNotMatch(html, /zkapi-billing-explainer/);
        assert.match(html, /Private balance:[\s\S]*?zkapi-panel-billing-help-toggle/);
        assert.match(html, /data-zkapi-note-expiry>[^<]+<\/span><button id="zkapi-panel-expiry-help-toggle"/);
        assert.match(html, /aria-controls="zkapi-panel-billing-help"/);
        assert.doesNotMatch(html, /data-zkapi-help-content="(?:billing|expiry)" hidden/);
        modal.render();
        // The dialog explains billing as a disclosure among its guides, not
        // as a ? in the header with a card above the deposit.
        assert.doesNotMatch(modal.overlay.innerHTML, /zkapi-modal-billing-help-toggle/);
        assert.doesNotMatch(modal.overlay.innerHTML, /data-zkapi-help-content="billing"/);
        assert.match(modal.overlay.innerHTML, /data-funding-disclosure="billing" data-open="false"/);
        assert.match(modal.overlay.innerHTML, /How private billing works/);
        assert.match(modal.overlay.innerHTML, /data-zkapi-balance-expiry>[^<]+<\/span><button id="zkapi-modal-expiry-help-toggle"/);
        assert.doesNotMatch(modal.overlay.innerHTML, /data-zkapi-help-content="expiry" hidden/);
        modal.render();
        assert.doesNotMatch(modal.overlay.innerHTML, /data-zkapi-help-content="expiry" hidden/,
            'Semantic updates retain the chosen open state');
    } finally {
        Object.assign(zkapiClient, original);
    }
});

test('expiry alone keeps funds withdrawable; a confirmed treasury claim shows zero without labeling it inference usage', () => {
    const original = { wallet: zkapiClient.wallet, config: zkapiClient.config,
        withdrawal: zkapiClient.withdrawal, withdrawals: zkapiClient.withdrawals,
        deposits: zkapiClient.deposits, lastError: zkapiClient.lastError };
    Object.assign(zkapiClient, { wallet: { note: { note_id: 7, deposit_amount: 2_000_000,
        current_balance: 1_500_000, expiry_ts: 1 } }, config: {},
    withdrawal: null, withdrawals: [], deposits: [], lastError: null });
    const panel = Object.create(RightPanel.prototype);
    panel.app = { integration: { getTransition: () => null } };
    panel.escapeHtml = value => String(value ?? '');
    const modal = Object.create(AccountModal.prototype);
    try {
        const unclaimedPanel = panel.billingSectionHTML();
        const unclaimedModal = modal.renderBalance();
        assert.match(unclaimedPanel, /Private balance:.*?\$1\.50/);
        assert.match(unclaimedPanel, /id="zkapi-panel-withdraw"/);
        assert.match(unclaimedModal, /\$1\.50/);
        assert.match(unclaimedModal, /id="zkapi-withdraw-view-btn"[^>]*>Withdraw/);
        assert.match(unclaimedModal, /data-private-balance-expired-notice >/);
        assert.match(unclaimedModal, /still try withdrawing while it remains unclaimed/);
        assert.doesNotMatch(unclaimedModal, /id="zkapi-archive-expired-balance-btn"/);
        assert.doesNotMatch(unclaimedModal, /expires in expired/);

        zkapiClient.deposits = [{ noteId: 7, status: 'confirmed',
            expiryClaim: { transactionHash: `0x${'ab'.repeat(32)}`, amount: 2_000_000 } }];
        const claimedPanel = panel.billingSectionHTML();
        const claimedModal = modal.renderBalance();
        assert.match(claimedPanel, /Private balance:.*?\$0\.00/);
        assert.match(claimedPanel, /Claimed after expiry/);
        assert.match(claimedModal, /Available<\/p>\s*<p[^>]*>\$0\.00/);
        for (const html of [claimedPanel, claimedModal]) {
            assert.match(html, /Claimed after expiry/);
            assert.doesNotMatch(html, /\$[\d.]+ used/);
        }
        assert.doesNotMatch(claimedPanel, /id="zkapi-panel-withdraw"/);
        assert.doesNotMatch(claimedModal, /id="zkapi-withdraw-view-btn"/);
        assert.match(claimedModal, /No refund was made/);
        assert.match(claimedModal, /id="zkapi-archive-expired-balance-btn"[^>]*>Start a new balance/);
    } finally {
        Object.assign(zkapiClient, original);
    }
});

test('user bubbles omit delivery state while assistant rows show precise private-access work', () => {
    for (const deliveryState of [null, 'queued', 'securing', 'sending', 'sent', 'failed', 'canceled']) {
        for (const isSessionStreaming of [true, false]) {
            const userHtml = buildMessageHTML({
                id: `user-${deliveryState || 'none'}`,
                sessionId: 'chat-a',
                role: 'user',
                content: 'Explain HTTPS',
                timestamp: 1,
                deliveryState
            }, {}, [], '', { isSessionStreaming });

            assert.doesNotMatch(userHtml, /user-delivery|data-delivery-state/);
            assert.doesNotMatch(userHtml, />\s*(?:Queued|Securing|Sending|Sent|Not sent|Canceled|Retry|Edit)\s*</);
            assert.match(userHtml, /resend-prompt-btn message-action-btn/);
            assert.match(userHtml, /edit-prompt-btn message-action-btn/);
            assert.match(userHtml, /aria-label="Resend prompt"/);
            assert.match(userHtml, /aria-label="Edit prompt"/);
        }
    }

    const proving = buildTypingIndicator(
        'typing-proving',
        'OpenAI',
        'OpenAI: GPT-5.3 Instant',
        1,
        'requesting-key',
        { kind: 'access', phase: 'proving', message: 'Proving this chat is funded…' },
        'chat-a'
    );
    assert.match(proving, /data-pending-session-id="chat-a"/);
    assert.match(proving, /data-phase="requesting-key"/);
    assert.match(proving, /data-progress-phase="proving"/);
    assert.match(proving, /role="status"/);
    assert.match(proving, /aria-live="polite"/);
    assert.match(proving, /aria-atomic="true"/);
    assert.match(proving, /pending-security-icon/);
    assert.match(proving, />Generating a zero-knowledge funding proof…</);
    assert.match(proving, /data-step-id="vault" data-state="complete"/);
    assert.match(proving, /data-step-id="proof" data-state="active" aria-label="Generate funding proof, current step" aria-current="step"/);
    assert.match(proving, /proof is generated on this device/i);

    window.rememberPendingSecurityTrace({
        open: true,
        dataset: { pendingSecurityTraceId: 'chat-a' }
    });
    const restoredExpanded = buildTypingIndicator(
        'typing-restored',
        'OpenAI',
        'OpenAI: GPT-5.3 Instant',
        1,
        'requesting-key',
        { kind: 'access', phase: 'requesting' },
        'chat-a'
    );
    assert.match(restoredExpanded, /data-pending-security-trace-id="chat-a"[^>]* open>/);
    window.rememberPendingSecurityTrace({
        open: false,
        dataset: { pendingSecurityTraceId: 'chat-a' }
    });

    const queued = buildTypingIndicator(
        'typing-queued',
        'OpenAI',
        'OpenAI: GPT-5.3 Instant',
        1,
        'preparing-access',
        { kind: 'settlement', phase: 'usage' },
        'chat-b'
    );
    assert.match(queued, /data-phase="preparing-access"/);
    assert.match(queued, /data-progress-phase="usage"/);
    assert.match(queued, />Confirming the previous chat’s usage…</);
    assert.match(queued, /data-step-id="usage" data-state="active" aria-label="Confirm final usage, current step" aria-current="step"/);

    for (const phase of ['waiting-response', 'stream-open']) {
        const thinking = buildTypingIndicator(
            `typing-${phase}`,
            'OpenAI',
            'OpenAI: GPT-5.3 Instant',
            1,
            phase,
            { kind: 'access', phase: 'proving' },
            'chat-c'
        );
        assert.match(thinking, /data-phase="waiting-response"/);
        assert.match(thinking, /data-progress-phase="waiting-response"/);
        assert.match(thinking, /pending-response-label pending-response-streaming">Waiting for response</);
        assert.doesNotMatch(thinking, /Generate funding proof|zero-knowledge proof is exchanged/);
    }

    const pendingAssistant = buildMessageHTML({
        id: 'assistant-pending',
        sessionId: 'chat-a',
        role: 'assistant',
        content: '',
        timestamp: 1,
        model: 'openai/gpt-5.3-chat',
        streamingPending: true,
        streamingPhase: 'requesting-key',
    }, {
        processContentWithLatex: value => value,
        formatTime: () => '00:00:01'
    }, [], 'openai/gpt-5.3-chat', { isSessionStreaming: true, pendingProgress: { kind: 'access', phase: 'verifying' } });
    assert.match(pendingAssistant, />Verifying private access with Open Anonymity…</);
    assert.match(pendingAssistant, /data-step-id="verify" data-state="active"/);
});

test('assistant pending rows keep verbose announcements clipped with one compact visible status', () => {
    const cases = [
        {
            name: 'private access',
            phase: 'requesting-key',
            progress: { kind: 'access', phase: 'proving' },
            current: 'Generating a zero-knowledge funding proof…',
            announcement: 'Securing private access. Generating a zero-knowledge funding proof…',
            securityVisible: true
        },
        {
            name: 'previous-chat settlement',
            phase: 'preparing-access',
            progress: { kind: 'settlement', phase: 'usage' },
            current: 'Confirming the previous chat’s usage…',
            announcement: 'Finishing the previous private chat. Confirming the previous chat’s usage…',
            securityVisible: true
        },
        {
            name: 'model wait',
            phase: 'waiting-response',
            progress: { kind: 'access', phase: 'Hold stale proof copy out of view' },
            current: 'Waiting for response',
            announcement: 'Message sent. Waiting for the response.',
            securityVisible: false
        }
    ];

    for (const testCase of cases) {
        const html = buildTypingIndicator(
            `typing-announcement-${testCase.name.replaceAll(' ', '-')}`,
            'OpenAI',
            'OpenAI: GPT-5.6 Sol',
            1,
            testCase.phase,
            testCase.progress,
            `announcement-${testCase.name}`
        );
        const announcement = html.match(/<span class="pending-response-announcement sr-only"([^>]*)>([\s\S]*?)<\/span>/);
        assert.ok(announcement, `${testCase.name} keeps an assistive live region in the DOM`);
        assert.match(announcement[1], /role="status"/);
        assert.match(announcement[1], /aria-live="polite"/);
        assert.match(announcement[1], /aria-atomic="true"/);
        assert.doesNotMatch(announcement[1], /(?:aria-hidden|\shidden(?:\s|=|$))/);
        assert.equal(announcement[2], testCase.announcement);

        const summary = html.match(/<summary class="pending-security-summary"[^>]*>([\s\S]*?)<\/summary>/)?.[1] || '';
        const simple = html.match(/<div class="pending-response-simple([^\"]*)">([\s\S]*?)<\/div>/);
        if (testCase.securityVisible) {
            assert.match(html, /<details class="pending-security-trace"/);
            assert.doesNotMatch(html, /<details class="pending-security-trace hidden"/);
            assert.match(simple?.[1] || '', /hidden/);
            assert.match(summary, new RegExp(`>${testCase.current.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}<`));
            assert.doesNotMatch(summary, new RegExp(testCase.announcement.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
        } else {
            assert.match(html, /<details class="pending-security-trace hidden"/);
            assert.doesNotMatch(simple?.[1] || '', /hidden/);
            assert.match(simple?.[2] || '', new RegExp(`>${testCase.current}<`));
            assert.doesNotMatch(html, /Hold stale proof copy out of view/);
        }
    }

    const styles = [
        fs.readFileSync(new URL('../../chat/styles.css', import.meta.url), 'utf8'),
        fs.readFileSync(new URL('../../chat/zkapi/zkapi.css', import.meta.url), 'utf8')
    ];
    const announcementRules = styles
        .map(css => css.replace(/\/\*[\s\S]*?\*\//g, ''))
        .flatMap(css => [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)])
        .filter(match => match[1].split(',').map(selector => selector.trim()).includes('.pending-response-announcement'))
        .map(match => match[2]);
    assert.ok(announcementRules.length > 0, 'the live-region class must not rely on an ungenerated sr-only utility');
    assert.ok(announcementRules.some(rule => (
        /position:\s*absolute/.test(rule)
        && /width:\s*1px/.test(rule)
        && /height:\s*1px/.test(rule)
        && /overflow:\s*hidden/.test(rule)
        && /white-space:\s*nowrap/.test(rule)
        && (/(?:^|;)\s*clip:\s*rect\(0(?:px)?,?\s*0(?:px)?,?\s*0(?:px)?,?\s*0(?:px)?\)/.test(rule)
            || /clip-path:\s*inset\(50%\)/.test(rule))
    )), 'the live region must be visually clipped in light, dark, and reduced-motion modes');
    assert.ok(announcementRules.every(rule => !/(?:display:\s*none|visibility:\s*hidden)/.test(rule)),
        'visual clipping must not remove the announcement from the accessibility tree');
});

test('returning to a chat preserves its complete conversation and excludes the other chat', () => {
    const chatA = [
        { role: 'user', content: 'Explain HTTPS.' },
        { role: 'assistant', content: 'HTTPS combines HTTP with TLS.' },
        { role: 'user', content: 'go on' }
    ];
    const chatB = [
        { role: 'user', content: 'Explain photosynthesis.' },
        { role: 'assistant', content: 'Plants turn light into chemical energy.' }
    ];

    // Reselecting a chat must rebuild from that chat's durable messages; a new
    // ephemeral key changes billing transport, not conversation semantics.
    const selectedSessionMessages = new Map([
        ['chat-a', chatA],
        ['chat-b', chatB]
    ]).get('chat-a');
    const request = processMessagesForApi(selectedSessionMessages, 'openai/gpt-5.3-chat');

    assert.deepEqual(request, chatA);
    assert.equal(request.some(message => /photosynthesis/i.test(message.content)), false);
    assert.deepEqual(request.map(message => message.role), ['user', 'assistant', 'user']);
});

test('consumer-facing payment UI omits note numbers and the redundant sidebar account pill', () => {
    const panel = fs.readFileSync(new URL('../../chat/zkapi/components/RightPanel.js', import.meta.url), 'utf8');
    const account = fs.readFileSync(new URL('../../chat/zkapi/components/AccountModal.js', import.meta.url), 'utf8');
    const client = fs.readFileSync(new URL(import.meta.resolve('@openanonymity/zkapi-browser-sdk/client')), 'utf8');
    const shell = fs.readFileSync(new URL('../../chat/zkapi/components/ZkapiShell.js', import.meta.url), 'utf8');

    for (const source of [panel, account, client]) {
        assert.doesNotMatch(source, /(?:private\s+)?note\s*#/i);
    }
    assert.match(shell, /toolbarAnchor\.before\(balance\)/);
    assert.match(shell, /getElementById\('account-nav'\)\?\.remove\(\)/);
    assert.match(shell, /data-private-balance-label/);
});

test('capsule uses static hold and error endpoints without implying accepted success', () => {
    const element = composerElement();
    const waiting = lowTextState('capsule', {
        primary: {
            phase: 'escape-wait',
            tone: 'waiting',
            title: 'Recovery window in progress',
            detail: 'Wait for the safety window.',
            compact: 'Recovery window in progress',
            busy: false,
            blocksSend: true
        }
    });

    renderZkapiComposerStatus(element, null, waiting);
    assert.match(element.innerHTML, /zkapi-state-glyph--waiting/);
    assert.match(element.innerHTML, /zkapi-capsule-origin--neutral/);
    assert.match(element.innerHTML, /zkapi-capsule-end--hold/);
    assert.doesNotMatch(element.innerHTML, /✓|→/);
    assert.equal(element.getAttribute('aria-busy'), 'false');

    const error = lowTextState('capsule', {
        primary: {
            phase: 'error',
            tone: 'error',
            title: 'Previous chat needs attention',
            detail: 'Try again.',
            compact: 'Needs attention',
            busy: false,
            blocksSend: true
        }
    });
    renderZkapiComposerStatus(element, null, error);
    assert.match(element.innerHTML, /data-status-icon="attention"/);
    assert.match(element.innerHTML, /zkapi-capsule-origin--neutral/);
    assert.match(element.innerHTML, /zkapi-capsule-end--error/);
    assert.doesNotMatch(element.innerHTML, /✓|→/);

    const closing = lowTextState('capsule', {
        primary: {
            phase: 'closing',
            tone: 'working',
            title: 'Finishing previous chat',
            detail: 'Closing its private key.',
            compact: 'Finishing previous chat',
            busy: true,
            blocksSend: false
        }
    });
    renderZkapiComposerStatus(element, null, closing);
    assert.match(element.innerHTML, /zkapi-capsule-origin--neutral/);
    assert.match(element.innerHTML, /zkapi-capsule-end--closing/);
    assert.doesNotMatch(element.innerHTML, /✓|→/);
});

test('message recovery controls have a visible busy state and reduced motion keeps pending copy readable', () => {
    const css = fs.readFileSync(new URL('../../chat/zkapi/zkapi.css', import.meta.url), 'utf8');
    const reducedMotion = (css.match(/@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\n\}/g) || []).join('\n');

    assert.doesNotMatch(css, /\.user-delivery-(?:row|details|glyph|label|popover|actions)/);
    assert.doesNotMatch(css, /zkapiReceiptOrbit/);
    assert.match(css, /\.message-action-btn\.is-processing::after,[\s\S]*?animation: zkapiActionOrbit/);
    assert.match(css, /\.chat-session\[data-deleting="true"\]\s*\{[\s\S]*?cursor: wait/);
    assert.match(css, /\.zkapi-composer-live-status\s*\{[\s\S]*?clip: rect\(0, 0, 0, 0\)/);
    assert.match(reducedMotion, /\.pending-response-streaming\s*\{[\s\S]*?animation: none !important/);
    assert.match(reducedMotion, /\.message-action-btn\.is-processing::after/);
    assert.match(reducedMotion, /-webkit-text-fill-color: currentColor !important/);
});


test('both payment shells mount into the toolbar independently of the floating panel toggle', () => {
    const html = fs.readFileSync(new URL('../../chat/index.html', import.meta.url), 'utf8');
    const toolbarStart = html.indexOf('id="chat-toolbar"');
    const anchor = html.indexOf('id="chat-toolbar-panel-space"');
    const toolbarEnd = html.indexOf('<!-- Status Indicator Dot', toolbarStart);
    assert.ok(toolbarStart > 0 && anchor > toolbarStart && anchor < toolbarEnd);
    assert.equal((html.match(/id="chat-toolbar-panel-space"/g) || []).length, 1);
    for (const file of ['components/ZkapiShell.js', 'ui/createPaymentModeUi.js']) {
        const source = fs.readFileSync(new URL(`../../chat/zkapi/${file}`, import.meta.url), 'utf8');
        assert.match(source, /getElementById\('chat-toolbar-panel-space'\)/);
        assert.match(source, /toolbarAnchor\.before\(/);
        assert.doesNotMatch(source, /getElementById\('show-right-panel-btn'\)/);
    }
});


test('phase notifications never describe closing a chat over OA tickets', t => {
    const originalDocument = globalThis.document;
    let currentToast = null;
    globalThis.document = { getElementById: id => id === 'app-toast' ? currentToast : null };
    t.after(() => { globalThis.document = originalDocument; });
    const calls = [];
    let mode = 'zkapi';
    const app = { integration: { getMode: () => mode },
        showToast(text) { currentToast = { textContent: text }; calls.push(text); },
        clearToast() { currentToast = null; calls.push('clear'); } };
    const element = composerElement();
    renderZkapiComposerStatus(element, app, lowTextState('quiet', {
        primary: { phase: 'requesting', compact: 'Requesting private key' }
    }));
    assert.equal(currentToast?.textContent, 'Requesting private key');
    mode = 'tickets';
    renderZkapiComposerStatus(element, app, lowTextState('quiet', {
        primary: { phase: 'closing', compact: 'Closing previous chat' }
    }));
    assert.equal(currentToast, null);
    assert.deepEqual(calls, ['Requesting private key', 'clear']);
    mode = 'zkapi';
    renderZkapiComposerStatus(element, app, lowTextState('quiet', {
        primary: { phase: 'closing', compact: 'Closing previous chat' }
    }));
    assert.equal(currentToast, null, 'background closure stays in the System Panel');
});


test('invalid deposit amounts never start wallet work', () => {
    for (const amount of ['', '   ', '0', '-1', 'abc', '1.1234567', '99999999999']) {
        const modal = Object.create(AccountModal.prototype);
        modal.overlay = { querySelector() { return null; } };
        modal.render = () => {};
        modal.run = () => assert.fail('invalid amount must not start wallet work');
        modal.startDeposit(amount);
        assert.equal(modal.outcome.tone, 'error');
        assert.equal(modal.outcome.field, 'deposit');
        assert.ok(modal.outcome.message);
        assert.match(modal.renderOutcome(), /id="zkapi-deposit-error" role="alert"/);
        assert.equal(modal.depositAmount, amount);
    }
});

// ---------------------------------------------------------------------------
// Payment history across protocol versions
// ---------------------------------------------------------------------------
//
// The other versions' payments are read by the facade (which owns the read)
// and drawn by the version helpers; this dialog only places them: merged into
// the list by date, as text, and never counted as a return this version has
// pending. The facade here is a stand-in over the real helpers, the real
// provider projection and the real renderers.

const { createVersionUi } = await import('../../chat/zkapi/versioning/ui.js');
const { projectOtherHistory } = await import('../../chat/zkapi/versioning/otherVersionHistory.mjs');
const { createDocument: createMiniDocument } = await import('./_miniDom.mjs');

const HISTORY_NOW = Date.parse('2026-11-15T12:00:00Z');
const HISTORY_DAY = 86_400_000;
const LOADED_DEPLOYMENT = 'zkapi-native-eth-mainnet-concession-v1-loaded';
const PREVIOUS_DEPLOYMENT = 'zkapi-native-eth-mainnet-note-bound-v1-previous';
const HISTORY_VAULT = `0x${'44'.repeat(20)}`;
const historyTable = (previousLabel = 'Version 1') => [
    { id: 'v1', ordinal: 1, label: previousLabel, adapter: 'note-bound-v1', status: 'exit-only',
        deploymentId: PREVIOUS_DEPLOYMENT, chainId: 1, vault: HISTORY_VAULT },
    { id: 'v2', ordinal: 2, label: 'Version 2', adapter: 'concession-v1', status: 'active',
        deploymentId: LOADED_DEPLOYMENT, chainId: 1, vault: `0x${'22'.repeat(20)}` }
];

// What the provider hands the facade for a wallet that holds an unfinished
// withdrawal and an old deposit of version 1 (public fields only).
function otherVersionRows({ label = 'Version 1', chainId = 1, withdrawalAt = HISTORY_NOW - 2 * HISTORY_DAY } = {}) {
    const hash = `0x${'ab'.repeat(32)}`;
    return projectOtherHistory({
        deposits: [{ recordId: 'old-v1-deposit', type: 'deposit', deploymentId: PREVIOUS_DEPLOYMENT, noteId: 4,
            amount: 2_000_000, expiryTs: Math.floor((HISTORY_NOW + 30 * HISTORY_DAY) / 1000), status: 'confirmed',
            createdAt: HISTORY_NOW - 40 * HISTORY_DAY, confirmedAt: HISTORY_NOW - 40 * HISTORY_DAY + 60_000,
            transactionHash: hash }],
        withdrawals: [{ recordId: 'raw-record-5', deploymentId: PREVIOUS_DEPLOYMENT, chainId, contractAddress: HISTORY_VAULT,
            noteId: 5, mode: 'mutual', phase: 'parked', destination: `0x${'34'.repeat(20)}`, finalBalance: 1_900_000,
            createdAt: withdrawalAt, updatedAt: withdrawalAt }]
    }, { table: historyTable(label), loadedDeploymentId: LOADED_DEPLOYMENT, nowMs: HISTORY_NOW }).rows;
}

function historyFacade({ rows = otherVersionRows(), previous = { versionId: 'v1', canOpen: true }, holding = 'none',
    multiVersion = true } = {}) {
    const calls = { ensure: 0, switches: [] };
    const facade = {
        multiVersion,
        calls,
        rows,
        state: () => ({ previous, holding, show: false, phase: 'current', gate: { canStart: true }, upgrade: {}, exit: null }),
        depositGate: () => ({ canStart: true, canResume: false, code: null, successor: null }),
        subscribe: () => () => {},
        registerBusy: () => () => {},
        history: {
            rows: () => facade.rows,
            ensureFresh() { calls.ensure += 1; return Promise.resolve(); },
            signature: () => 'history'
        },
        requestSwitch(options) { calls.switches.push(options); return { ok: true }; }
    };
    facade.ui = createVersionUi({ facade });
    return facade;
}

// The dialog reads the moment from Date.now when it draws, and the fixtures'
// deposit expires thirty days after HISTORY_NOW: without a pinned clock the
// deposit reads as expired once the real date passes that day, and a derived
// expiry row appears in the list.
const clockPinned = new WeakSet();
function pinHistoryClock(t) {
    if (clockPinned.has(t)) return;
    clockPinned.add(t);
    t.mock.method(Date, 'now', () => HISTORY_NOW);
}

// What the client held before a test first touched it, recorded once per test:
// a test that builds several modals must still leave the client as it found it
// (hooks run in the order they were added, so a restore recorded by a later
// call would put back an earlier call's facade).
const historyBefore = new WeakSet();

function historyModal(t, { facade, deposits = [], withdrawals = [], note = null } = {}) {
    pinHistoryClock(t);
    if (!historyBefore.has(t)) {
        historyBefore.add(t);
        const original = { wallet: zkapiClient.wallet, config: zkapiClient.config, withdrawals: zkapiClient.withdrawals,
            deposits: zkapiClient.deposits, oaVersioning: zkapiClient.oaVersioning };
        t.after(() => {
            Object.assign(zkapiClient, original);
            if (original.oaVersioning === undefined) delete zkapiClient.oaVersioning;
        });
    }
    Object.assign(zkapiClient, { wallet: { has_note: Boolean(note), note }, config: { funding: { chain_id: 1 } },
        withdrawals, deposits });
    if (facade) zkapiClient.oaVersioning = facade;
    else delete zkapiClient.oaVersioning;
    const modal = Object.create(AccountModal.prototype);
    Object.assign(modal, { busy: false, isOpen: true, view: 'withdrawals', status: '', statusError: false,
        overlay: { querySelector: () => null, querySelectorAll: () => [] } });
    return modal;
}

const FOREIGN_ACTIONS = /data-sync-withdrawal|data-finalize-withdrawal|data-withdraw-background|data-restore-withdrawal|data-retry-|data-cancel-background-preparation|data-recover-finalization|data-resolve-challenged|data-view-current-deposit|data-sync-late-withdrawal|data-claim-payout|data-zkapi-version-action/;
// The rows of the other versions, with the dialog's own around them cut away.
const foreignRows = html => [...html.matchAll(/<section[^>]*data-other-version-record="[^"]*"[\s\S]*?<\/section>/g)].map(match => match[0]);

test('the payments of other versions are rows of Payment history, by date, as text and nothing to act on', t => {
    const hash = `0x${'cd'.repeat(32)}`;
    const modal = historyModal(t, {
        facade: historyFacade(),
        deposits: [{ recordId: 'new-deposit', status: 'confirmed', amount: 3_000_000, confirmedAt: HISTORY_NOW - HISTORY_DAY, transactionHash: hash }],
        withdrawals: [{ recordId: 'own-return', mode: 'mutual', phase: 'closed', payoutVerified: true, finalBalance: 1_000_000,
            destination: `0x${'12'.repeat(20)}`, createdAt: HISTORY_NOW - 10 * HISTORY_DAY }]
    });
    const html = modal.renderWithdrawalRecords();
    const at = pattern => html.search(pattern);
    // Newest first: this version's deposit, version 1's withdrawal (2 days
    // old), this version's return (10 days), version 1's deposit (40 days).
    const order = [at(/data-deposit-record="new-deposit"/), at(/data-other-version-record="v1:withdrawal:5"/),
        at(/data-withdrawal-record="own-return"/), at(/data-other-version-record="v1:deposit:4"/)];
    assert.ok(order.every(position => position >= 0), `all four rows are drawn: ${order}`);
    assert.deepEqual([...order].sort((left, right) => left - right), order, 'by date, newest first');
    // They are said as another version's, with the version named.
    const rows = foreignRows(html);
    assert.equal(rows.length, 2);
    for (const row of rows) {
        assert.match(row, /data-zkapi-history-version="v1"/);
        assert.match(row, /Version 1/);
        // Whatever the dialog's own handlers act on is absent: a note or
        // record number of another contract would act on this one.
        assert.doesNotMatch(row, FOREIGN_ACTIONS);
    }
    assert.match(rows.find(row => /v1:withdrawal:5/.test(row)), /data-zkapi-history-open="v1"/);
    // Its transaction link follows the row's own network, not the page's.
    assert.match(rows.find(row => /v1:deposit:4/.test(row)), new RegExp(`https://etherscan.io/tx/0x${'ab'.repeat(32)}`));
    // The dialog's own row links its own transaction.
    assert.match(html, new RegExp(`data-deposit-record="new-deposit"[\\s\\S]*?https://etherscan.io/tx/${hash}`));
});

test('another version’s unfinished withdrawal is not a return this version has pending', t => {
    // Nothing of this version's own: only the other version's rows.
    const modal = historyModal(t, { facade: historyFacade() });
    const html = modal.renderWithdrawalRecords();
    assert.match(html, /data-other-version-record="v1:withdrawal:5"/);
    assert.doesNotMatch(html, /Your deposits and withdrawals will appear here/, 'not the empty state');
    // None of the lines and buttons a pending return of this version brings.
    assert.doesNotMatch(html, /These withdrawals run separately|You can add a new private balance while a return is pending|zkapi-sync-all-withdrawals-btn|Check on-chain status|Check expiry payments/);
    assert.doesNotMatch(modal.renderWithdrawalStatusLink(), /to check/);
    assert.doesNotMatch(modal.renderWithdrawalStatusLink(), /withdrawal[s]? to check/);
    // And the label of the disclosure counts this version's own work only.
    zkapiClient.withdrawals = [{ recordId: 'own-open', mode: 'mutual', phase: 'submitted_unconfirmed', finalBalance: 1 }];
    assert.match(modal.renderWithdrawalStatusLink(), /1 withdrawal to check/);
});

test('a list with nothing of this version and nothing of another is still the empty state', t => {
    const modal = historyModal(t, { facade: historyFacade({ rows: [] }) });
    const html = modal.renderWithdrawalRecords();
    assert.match(html, /Your deposits and withdrawals will appear here/);
    assert.doesNotMatch(html, /data-other-version-record/);
});

test('what another version’s row says is escaped, and it cannot add an element to the dialog', t => {
    const hostile = '<img src=x onerror=alert(1)>"\'&<script>boom()</script>';
    const modal = historyModal(t, { facade: historyFacade({ rows: otherVersionRows({ label: hostile }) }) });
    const html = modal.renderWithdrawalRecords();
    assert.doesNotMatch(html, /<img src=x|<script>boom/);
    assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
    // Parsed, the rows contribute only the elements the renderer writes.
    const root = createMiniDocument().createElement('div');
    root.innerHTML = html;
    assert.equal(root.querySelectorAll('img').length + root.querySelectorAll('script').length, 0);
    assert.equal(root.querySelectorAll('[data-other-version-record]').length, 2);
});

test('a page that has no versions to tell apart draws today’s Payment history, rows or not', t => {
    const records = {
        deposits: [{ recordId: 'new-deposit', status: 'confirmed', amount: 3_000_000, confirmedAt: HISTORY_NOW - HISTORY_DAY }],
        withdrawals: [{ recordId: 'own-return', mode: 'mutual', phase: 'closed', payoutVerified: true, finalBalance: 1_000_000,
            destination: `0x${'12'.repeat(20)}`, createdAt: HISTORY_NOW - 10 * HISTORY_DAY }]
    };
    const without = historyModal(t, records).renderWithdrawalRecords();
    // A facade that is not multi-version has no `ui` and no `history`.
    const dormant = { multiVersion: false, state: () => null, ui: null, depositGate: () => ({ canStart: true, canResume: false, code: null }),
        subscribe: () => () => {}, registerBusy: () => () => {} };
    assert.equal(historyModal(t, { ...records, facade: dormant }).renderWithdrawalRecords(), without);
    // Even a facade that held rows would not draw them when it says it is
    // not multi-version (its state is null, so there is no version context).
    const stale = historyFacade({ multiVersion: false });
    stale.state = () => null;
    assert.equal(historyModal(t, { ...records, facade: stale }).renderWithdrawalRecords(), without);
    // Helpers that have not loaded yet: the same list, no rows.
    const early = historyFacade();
    early.ui = null;
    assert.equal(historyModal(t, { ...records, facade: early }).renderWithdrawalRecords(), without);
});

test('another version’s list is read when the dialog opens and when its history opens, never from a render', t => {
    const facade = historyFacade();
    const modal = historyModal(t, { facade });
    // A render, whichever view it draws, asks nothing of the facade.
    Object.assign(modal, { isOpen: true, overlay: { innerHTML: '', querySelector: () => null, querySelectorAll: () => [] } });
    modal.render();
    modal.view = 'withdrawals';
    modal.render();
    modal.renderWithdrawalRecords();
    modal.renderWithdrawalStatusLink();
    assert.equal(facade.calls.ensure, 0, 'drawing is read-only');
    // Opening the dialog does (the wallet client is not started by this test).
    const originalDocument = globalThis.document;
    globalThis.document = { ...originalDocument, activeElement: null, getElementById: () => null,
        addEventListener() {}, removeEventListener() {} };
    t.after(() => { globalThis.document = originalDocument; });
    const closed = Object.create(AccountModal.prototype);
    Object.assign(closed, { busy: false, isOpen: false, view: 'balance', status: '', statusError: false, walletMethodReady: false,
        overlay: { innerHTML: '', classList: { add() {}, remove() {} }, removeAttribute() {}, querySelector: () => null,
            querySelectorAll: () => [], addEventListener() {} } });
    closed.open('balance');
    assert.equal(facade.calls.ensure, 1);
    // Navigating to Payment history does; the other views do not.
    closed.goToView('withdrawals');
    assert.equal(facade.calls.ensure, 2);
    closed.goToView('withdraw');
    assert.equal(facade.calls.ensure, 2, 'other views do not ask');
    // A facade announcement re-reads only while the history is on screen.
    closed.view = 'balance';
    closed.historyOpen = false;
    closed.handleVersionChange();
    assert.equal(facade.calls.ensure, 2);
    closed.historyOpen = true;
    closed.handleVersionChange();
    assert.equal(facade.calls.ensure, 3);
    closed.historyOpen = false;
    closed.view = 'withdrawals';
    closed.handleVersionChange();
    assert.equal(facade.calls.ensure, 4);
    // A page with no versions has nothing to ask.
    delete zkapiClient.oaVersioning;
    assert.doesNotThrow(() => closed.refreshOtherVersionHistory());
    assert.equal(facade.calls.ensure, 4);
});

test('opening Payment history reads the other versions’ payments, once per opening, and closing it reads nothing', t => {
    const facade = historyFacade();
    const modal = historyModal(t, { facade, note: { note_id: 7, deposit_amount: 2_000_000, current_balance: 1_500_000,
        expiry_ts: Math.floor(HISTORY_NOW / 1000) + 20 * 86_400 } });
    // A real tree: the disclosure's own trigger is what the person clicks.
    const root = createMiniDocument().createElement('div');
    Object.assign(modal, { view: 'balance', overlay: root, historyOpen: false });
    modal.render();
    assert.equal(facade.calls.ensure, 0, 'drawn closed: nothing read');
    const trigger = root.querySelector('#zkapi-withdrawal-status-btn');
    assert.ok(trigger, 'the Payment history disclosure is on the balance');
    trigger.click();
    assert.equal(modal.historyOpen, true);
    assert.equal(facade.calls.ensure, 1);
    trigger.click();
    assert.equal(modal.historyOpen, false);
    assert.equal(facade.calls.ensure, 1, 'closing it asks nothing');
    // Its rows are in the disclosure, merged with this version's own.
    assert.match(root.innerHTML, /data-other-version-record="v1:withdrawal:5"/);
});

test('payment history is drawn again once when the other versions’ list changes, and on no other tick', t => {
    const facade = historyFacade();
    const modal = historyModal(t, { facade });
    let renders = 0;
    modal.render = () => { renders += 1; modal.renderWithdrawalRecords(); };
    modal.renderWithdrawalRecords();
    modal.handleZkapiClock(HISTORY_NOW);
    assert.equal(renders, 0, 'nothing changed');
    // The facade's signature moves with a read that changed a row.
    facade.history.signature = () => 'read-2';
    facade.ui = { ...facade.ui, historySignature: () => 'read-2' };
    modal.handleZkapiClock(HISTORY_NOW + 1000);
    assert.equal(renders, 1);
    modal.handleZkapiClock(HISTORY_NOW + 2000);
    assert.equal(renders, 1, 'the same list is not drawn again');
});

test('opening a version from its row asks the facade for that version, with the reason the row gave', t => {
    const facade = historyFacade();
    const modal = historyModal(t, { facade });
    const root = createMiniDocument().createElement('div');
    root.innerHTML = modal.renderWithdrawalRecords();
    modal.overlay = root;
    modal.noticeVersionOutcome = text => { modal.said = text; };
    modal.attachHistoryOpen();
    // Bound once however often the dialog draws.
    modal.attachHistoryOpen();
    const button = root.querySelector('[data-zkapi-history-open]');
    assert.ok(button, 'the way into version 1 is on its row');
    button.click();
    assert.deepEqual(facade.calls.switches, [{ reason: 'finish_previous', view: 'withdrawals', prefer: 'v1' }]);
    // A credited payout asks for the claim.
    const credit = facade.ui.historyItems && otherVersionRows();
    assert.ok(credit.length);
    facade.calls.switches.length = 0;
    button.dataset.zkapiHistoryReason = 'claim_credit';
    button.click();
    assert.deepEqual(facade.calls.switches, [{ reason: 'claim_credit', view: 'withdrawals', prefer: 'v1' }]);
    // A refusal is said in words, and nothing reloads by itself.
    facade.requestSwitch = options => { facade.calls.switches.push(options); return { ok: false, why: 'busy' }; };
    button.click();
    assert.equal(modal.said, 'Finish the current step first.');
    // Clicks elsewhere in the dialog do nothing.
    facade.calls.switches.length = 0;
    root.append(root.ownerDocument.createElement('p'));
    root.querySelector('p').click();
    assert.deepEqual(facade.calls.switches, []);
});

test('a transaction link takes the network of the row it belongs to', () => {
    const modal = Object.create(AccountModal.prototype);
    const original = zkapiClient.config;
    zkapiClient.config = { funding: { chain_id: 1 } };
    try {
        const hash = `0x${'ab'.repeat(32)}`;
        assert.equal(modal.paymentTransactionUrl(hash), `https://etherscan.io/tx/${hash}`);
        assert.equal(modal.paymentTransactionUrl(hash, 11155111), `https://sepolia.etherscan.io/tx/${hash}`);
        assert.equal(modal.paymentTransactionUrl(hash, 1), `https://etherscan.io/tx/${hash}`);
        // A network that is not known, or a row with none, has no link.
        assert.equal(modal.paymentTransactionUrl(hash, 999), null);
        assert.equal(modal.paymentTransactionUrl(hash, null), null);
        assert.equal(modal.paymentTransactionUrl('javascript:alert(1)', 1), null);
    } finally { zkapiClient.config = original; }
});

// ---------------------------------------------------------------------------
// The panel's count of payouts to claim
// ---------------------------------------------------------------------------

test('a payout the payment contract holds is "to claim" in the panel, never "returned"', () => {
    const original = { wallet: zkapiClient.wallet, config: zkapiClient.config, withdrawal: zkapiClient.withdrawal,
        withdrawals: zkapiClient.withdrawals, lastError: zkapiClient.lastError };
    Object.assign(zkapiClient, { wallet: { has_note: false, note: null }, config: { funding: { chain_id: 1 } },
        withdrawal: null, lastError: null });
    const panel = Object.create(RightPanel.prototype);
    panel.app = { integration: { getTransition: () => null } };
    panel.escapeHtml = value => String(value ?? '');
    const history = html => /id="zkapi-panel-withdrawals"[^>]*><span>Payment history<\/span><strong[^>]*>([^<]*)</.exec(html)?.[1] ?? null;
    const escape = (recordId, extra = {}) => ({ recordId, mode: 'escape', phase: 'closed_unconfirmed', chainStatus: 'closed',
        finalBalance: 1_000_000, finalizeTransactionHash: `0x${'ab'.repeat(32)}`, payoutVerified: false, ...extra });
    try {
        // A returned payout is still "returned".
        zkapiClient.withdrawals = [escape('paid', { payoutVerified: true })];
        assert.equal(history(panel.billingSectionHTML()), '1 returned');
        // A credited one is held for the person to claim.
        zkapiClient.withdrawals = [escape('held', { payoutCredited: true, creditedAmount: 800_000, payoutCreditEvidence: 'receipt' })];
        assert.equal(history(panel.billingSectionHTML()), '1 to claim');
        // Two of them, and a delivered one that is not counted.
        zkapiClient.withdrawals = [
            escape('a', { payoutCredited: true }), escape('b', { payoutCredited: true, phase: 'closed' }),
            escape('claimed', { payoutCredited: true, payoutClaimed: true, payoutVerified: true })
        ];
        assert.equal(history(panel.billingSectionHTML()), '2 to claim');
        // A payout held with no finalization of its own is not an open
        // withdrawal of the SDK, and is still listed to claim.
        zkapiClient.withdrawals = [{ recordId: 'cleared', mode: 'escape', phase: 'closed', payoutCredited: true,
            payoutCreditEvidence: 'vault_credit', creditedAmount: null, finalBalance: 1_000_000 }];
        assert.equal(zkapiClient.openWithdrawals.length, 0);
        assert.equal(history(panel.billingSectionHTML()), '1 to claim');
        // A withdrawal that needs attention is said first.
        zkapiClient.withdrawals = [escape('held', { payoutCredited: true }), escape('stuck', { phase: 'ambiguous', error: 'no receipt' })];
        assert.equal(history(panel.billingSectionHTML()), '1 needs attention');
        // Nothing credited: the label is what it always was.
        zkapiClient.withdrawals = [];
        assert.equal(history(panel.billingSectionHTML()), null);
    } finally { Object.assign(zkapiClient, original); }
});

// ---------------------------------------------------------------------------
// The panel's notices of a revision 3 balance
// ---------------------------------------------------------------------------

test('the panel carries the new notices through its banner, and Withdraw from one opens the dialog’s Withdraw view', async t => {
    const { createZkapiVersioning } = await import('../../chat/zkapi/versioning/index.js');
    const { getAdapter } = await import('../../chat/zkapi/versioning/adapters/index.mjs');
    const { activatedRegistry, resolvedTable } = await import('./_registryFixtures.mjs');
    const { attachVersionNotices } = await import('../../chat/zkapi/components/VersionNotices.js');
    const shapes = JSON.parse(fs.readFileSync(new URL('../fixtures/zkapi-v2-real-shapes/snapshots.json', import.meta.url), 'utf8'));
    const real = structuredClone(shapes.scenarios.near_expiry);
    const table = resolvedTable(activatedRegistry(), 'mainnet');
    const version = table.find(row => row.adapter === 'concession-v1');
    const selection = { version, reason: 'runtime_holds_note', slotOwner: version.id, open: {}, credits: {},
        foreignDeploymentId: null, depositBlock: null, draftDiscarded: false, slotKind: 'note' };
    const original = { wallet: zkapiClient.wallet, config: zkapiClient.config, withdrawals: zkapiClient.withdrawals,
        deposits: zkapiClient.deposits, withdrawal: zkapiClient.withdrawal, lastError: zkapiClient.lastError,
        oaVersioning: zkapiClient.oaVersioning };
    // Not client fields: they are put back on their own owners below. Putting
    // them in `original` would assign them onto the client when it is restored.
    const globalsBefore = { dispatchEvent: globalThis.dispatchEvent, now: Date.now };
    Object.assign(zkapiClient, { wallet: real.clientSnapshot.wallet, config: real.clientSnapshot.config,
        withdrawals: real.clientSnapshot.withdrawals, deposits: real.clientSnapshot.deposits, withdrawal: null, lastError: null });
    Date.now = () => shapes.generatedAtMs;
    const store = { getItem: () => null, setItem() {}, removeItem() {} };
    const facade = createZkapiVersioning({
        buildTable: table, network: 'mainnet', now: () => shapes.generatedAtMs,
        context: () => ({ table, version, selection, adapter: getAdapter(version.adapter) }),
        localStorage: store, sessionStorage: store, reload() {}, setTimer: () => null, clearTimer() {}
    });
    zkapiClient.oaVersioning = facade;
    const { createVersionUi: composeUi } = await import('../../chat/zkapi/versioning/ui.js');
    facade.attach({ client: zkapiClient, runtime: { runtime: real.runtime }, ui: composeUi({ facade }) });
    const events = [];
    globalThis.dispatchEvent = event => { events.push(event); return true; };
    t.after(() => {
        facade.resetForTests();
        Object.assign(zkapiClient, original);
        if (original.oaVersioning === undefined) delete zkapiClient.oaVersioning;
        globalThis.dispatchEvent = globalsBefore.dispatchEvent;
        Date.now = globalsBefore.now;
    });
    const panel = Object.create(RightPanel.prototype);
    panel.app = { integration: { getTransition: () => null }, showToast() {} };
    panel.escapeHtml = value => String(value ?? '');
    const html = panel.billingSectionHTML();
    assert.match(html, /data-zkapi-version-banner="panel"/);
    assert.match(html, /data-zkapi-version-notice="near"/);
    const { createDocument } = await import('./_miniDom.mjs');
    const root = createDocument().createElement('div');
    root.innerHTML = html;
    attachVersionNotices(root, panel.versionActionContext());
    const button = root.querySelector('[data-zkapi-version-notice="near"] [data-zkapi-version-action="open-withdraw"]');
    assert.ok(button, 'the notice offers Withdraw');
    button.click();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'zkapi-payment-required');
    assert.deepEqual(events[0].detail, { view: 'withdraw' });
});

test('a row of another version says why it cannot be opened yet only when this version holds the wallet', t => {
    const held = historyModal(t, { facade: historyFacade({ previous: { versionId: 'v1', canOpen: false }, holding: 'note' }) });
    const heldRow = foreignRows(held.renderWithdrawalRecords()).find(row => /v1:withdrawal:5/.test(row));
    assert.doesNotMatch(heldRow, /data-zkapi-history-open/);
    assert.match(heldRow, /First withdraw or finish the balance on this version, then open version 1\./);
    // Nothing is claimed about the wallet when the state does not say.
    const unknown = historyModal(t, { facade: historyFacade({ previous: { versionId: 'v1', canOpen: false }, holding: null }) });
    const unknownRow = foreignRows(unknown.renderWithdrawalRecords()).find(row => /v1:withdrawal:5/.test(row));
    assert.doesNotMatch(unknownRow, /First withdraw or finish/);
});

// A balance held by an exit lock with no withdrawal of its own, through the real
// facade over the SDK's own snapshot (test/fixtures/zkapi-v2-real-shapes): the
// panel, the composer and the balance control said "Ready to chat" for it. They
// say frozen, in the words the balance dialog's notice uses, when the version
// helpers say so, and say what they said before when they do not.
async function frozenPage(t, { scenario = 'mutual_lock_with_ownership_proof', versioned = true, edit = null } = {}) {
    const { createZkapiVersioning } = await import('../../chat/zkapi/versioning/index.js');
    const { getAdapter } = await import('../../chat/zkapi/versioning/adapters/index.mjs');
    const { activatedRegistry, resolvedTable } = await import('./_registryFixtures.mjs');
    const { createVersionUi: composeUi } = await import('../../chat/zkapi/versioning/ui.js');
    const shapes = JSON.parse(fs.readFileSync(new URL('../fixtures/zkapi-v2-real-shapes/snapshots.json', import.meta.url), 'utf8'));
    const real = structuredClone(shapes.scenarios[scenario]);
    edit?.(real.clientSnapshot);
    const table = resolvedTable(activatedRegistry(), 'mainnet');
    const version = table.find(row => row.adapter === 'concession-v1');
    const selection = { version, reason: 'runtime_holds_note', slotOwner: version.id, open: {}, credits: {},
        foreignDeploymentId: null, depositBlock: null, draftDiscarded: false, slotKind: 'note' };
    const original = { wallet: zkapiClient.wallet, config: zkapiClient.config, withdrawals: zkapiClient.withdrawals,
        deposits: zkapiClient.deposits, withdrawal: zkapiClient.withdrawal, lastError: zkapiClient.lastError,
        activities: zkapiClient.activities, oaVersioning: zkapiClient.oaVersioning };
    const nowBefore = Date.now;
    Object.assign(zkapiClient, { wallet: real.clientSnapshot.wallet, config: real.clientSnapshot.config,
        withdrawals: real.clientSnapshot.withdrawals, deposits: real.clientSnapshot.deposits, withdrawal: null,
        lastError: null, activities: [] });
    Date.now = () => shapes.generatedAtMs;
    const store = { getItem: () => null, setItem() {}, removeItem() {} };
    const facade = createZkapiVersioning({
        buildTable: table, network: 'mainnet', now: () => shapes.generatedAtMs,
        context: () => ({ table, version, selection, adapter: getAdapter(version.adapter) }),
        localStorage: store, sessionStorage: store, reload() {}, setTimer: () => null, clearTimer() {}
    });
    facade.attach({ client: zkapiClient, runtime: { runtime: real.runtime }, ui: composeUi({ facade }) });
    if (versioned) zkapiClient.oaVersioning = facade;
    else delete zkapiClient.oaVersioning;
    t.after(() => {
        facade.resetForTests();
        Object.assign(zkapiClient, original);
        if (original.oaVersioning === undefined) delete zkapiClient.oaVersioning;
        Date.now = nowBefore;
    });
    return { facade, shapes, setProposal: proposal => { zkapiClient.config = { ...zkapiClient.config, ux_proposal: proposal }; } };
}

test('a frozen balance is said frozen on the panel, the composer and the balance control, for every proposal', async t => {
    const { getZkapiExperience, updateZkapiBalanceControl } = await import('../../chat/zkapi/components/ZkapiStateExperience.js');
    const { versionCopyText: copyText } = await import('../../chat/zkapi/versioning/copy.mjs');
    const page = await frozenPage(t);
    const app = { integration: { getTransition: () => null } };
    assert.notEqual(page.facade.state().exit.frozen, null, 'the facade knows');
    const detail = copyText('exit.frozen', { });
    for (const proposal of ['quiet', 'guided', 'activity', 'receipt', 'relay', 'ambient', 'capsule']) {
        page.setProposal(proposal);
        const experience = getZkapiExperience(app);
        assert.equal(experience.proposal, proposal);
        for (const key of ['primary', 'composerPrimary', 'balancePrimary', 'panelPrimary']) {
            assert.equal(experience[key].title, 'Balance frozen', `${proposal} ${key}`);
            assert.equal(experience[key].detail, detail, `${proposal} ${key}`);
        }
        // The panel.
        const panel = renderZkapiPanelExperience(experience);
        assert.ok(panel, `${proposal}: the panel says something`);
        assert.match(panel, /Balance frozen/);
        assert.doesNotMatch(panel, /Withdrawal ready|No transaction is moving|Ready to chat/);
        // The composer: a chat that cannot start is said where it is typed.
        const element = composerElement();
        renderZkapiComposerStatus(element, app);
        assert.notEqual(element.className, 'hidden', proposal);
        assert.match(element.innerHTML, /Balance frozen/);
        assert.doesNotMatch(element.innerHTML, /Withdrawal ready|No transaction is moving|Ready to chat/);
        assert.equal(element.getAttribute('aria-busy'), 'false');
        assert.equal(element.dataset.tone, 'waiting');
        // The balance control: the same dot a withdrawal in motion has, and the same words as its title.
        const button = { dataset: {}, attributes: new Map(), title: '',
            querySelector: () => ({ textContent: '' }),
            setAttribute(name, value) { this.attributes.set(name, value); } };
        updateZkapiBalanceControl(button, app);
        assert.equal(button.dataset.status, 'waiting', proposal);
        assert.equal(button.dataset.phase, 'withdrawal');
        // (The build's version is named after the words, as it is for every state.)
        assert.equal(button.title, `Balance frozen. ${detail}`);
    }
});

test('the right panel’s header calls a frozen balance frozen, not ready', async t => {
    const page = await frozenPage(t);
    page.setProposal('quiet');
    const panel = Object.create(RightPanel.prototype);
    panel.app = { integration: { getTransition: () => null }, showToast() {} };
    panel.escapeHtml = value => String(value ?? '');
    const html = panel.billingSectionHTML();
    assert.match(html, />Balance frozen</);
    assert.doesNotMatch(html, />ready</);
    assert.doesNotMatch(html, /data-private-balance-readiness/, 'the green readiness badge is for a balance that can chat');
});

test('a frozen balance another device has used says so on the panel, the composer, the balance control and the header', async t => {
    const { getZkapiExperience, updateZkapiBalanceControl } = await import('../../chat/zkapi/components/ZkapiStateExperience.js');
    const { versionCopyText: copyText } = await import('../../chat/zkapi/versioning/copy.mjs');
    const { renderVersionBanner } = await import('../../chat/zkapi/components/VersionNotices.js');
    const page = await frozenPage(t, { edit: client => { client.config.exit.device_not_newest = true; } });
    const app = { integration: { getTransition: () => null } };
    const state = page.facade.state();
    assert.notEqual(state.exit.frozen, null, 'the lock still holds the balance');
    assert.equal(state.exit.deviceNotNewest, true);
    const label = copyText('exit.device.label');
    const detail = copyText('exit.device');
    const WITHDRAWABLE = /can still withdraw|Withdrawal ready|Ready to chat|Balance frozen|New chats resume/;
    // The dialog's banner tells the same balance the device sentence and never
    // that it can still be withdrawn.
    const banner = renderVersionBanner(state, { surface: 'dialog', now: page.shapes.generatedAtMs });
    assert.match(banner, /data-zkapi-version-notice="device"/);
    assert.doesNotMatch(banner, /data-zkapi-version-notice="frozen"/);
    assert.doesNotMatch(banner, /can still withdraw/i);
    for (const proposal of ['quiet', 'guided', 'activity', 'receipt', 'relay', 'ambient', 'capsule']) {
        page.setProposal(proposal);
        const experience = getZkapiExperience(app);
        for (const key of ['primary', 'composerPrimary', 'balancePrimary', 'panelPrimary']) {
            assert.equal(experience[key].title, label, `${proposal} ${key}`);
            assert.equal(experience[key].detail, detail, `${proposal} ${key}`);
            assert.equal(experience[key].blocksSend, true, `${proposal} ${key}`);
        }
        const panel = renderZkapiPanelExperience(experience);
        assert.ok(panel, `${proposal}: the panel says something`);
        assert.match(panel, new RegExp(label));
        assert.doesNotMatch(panel, WITHDRAWABLE, proposal);
        // The composer says why a chat cannot start, where it is typed.
        const element = composerElement();
        renderZkapiComposerStatus(element, app);
        assert.notEqual(element.className, 'hidden', proposal);
        assert.match(element.innerHTML, new RegExp(label));
        assert.doesNotMatch(element.innerHTML, WITHDRAWABLE, proposal);
        assert.equal(element.dataset.tone, 'waiting');
        const button = { dataset: {}, attributes: new Map(), title: '',
            querySelector: () => ({ textContent: '' }),
            setAttribute(name, value) { this.attributes.set(name, value); } };
        updateZkapiBalanceControl(button, app);
        assert.equal(button.dataset.status, 'waiting', proposal);
        assert.equal(button.dataset.phase, 'withdrawal');
        assert.equal(button.title, `${label}. ${detail}`);
        assert.doesNotMatch(button.title, WITHDRAWABLE);
    }
    // The panel's header keeps its amber waiting badge, not the green ready one.
    page.setProposal('quiet');
    const header = Object.create(RightPanel.prototype);
    header.app = { integration: { getTransition: () => null }, showToast() {} };
    header.escapeHtml = value => String(value ?? '');
    const html = header.billingSectionHTML();
    assert.match(html, new RegExp(`>${label}<`));
    assert.doesNotMatch(html, />ready</);
    assert.doesNotMatch(html, /data-private-balance-readiness/);
});

test('a page without the version helpers says what it always said about the same balance', async t => {
    const { getZkapiExperience } = await import('../../chat/zkapi/components/ZkapiStateExperience.js');
    const page = await frozenPage(t, { versioned: false });
    page.setProposal('quiet');
    const app = { integration: { getTransition: () => null } };
    const experience = getZkapiExperience(app);
    assert.equal(experience.primary.phase, 'ready');
    assert.equal(experience.primary.title, 'Ready to chat');
    assert.equal(experience.primary.frozen, undefined);
    const element = composerElement();
    renderZkapiComposerStatus(element, app);
    assert.equal(element.className, 'hidden');
    // A facade that is not versioning-active answers null: the same page.
    zkapiClient.oaVersioning = { state: () => null };
    assert.equal(getZkapiExperience(app).primary.title, 'Ready to chat');
    // And one that throws leaves the page working.
    zkapiClient.oaVersioning = { state: () => { throw new Error('not now'); } };
    assert.equal(getZkapiExperience(app).primary.title, 'Ready to chat');
});

test('a prepared plan on a frozen balance keeps the plan’s words on every surface', async t => {
    const { getZkapiExperience } = await import('../../chat/zkapi/components/ZkapiStateExperience.js');
    const page = await frozenPage(t, { scenario: 'escape_lock_released_proof' });
    page.setProposal('quiet');
    assert.notEqual(page.facade.state().exit.frozen, null);
    const experience = getZkapiExperience({ integration: { getTransition: () => null } });
    for (const key of ['primary', 'composerPrimary', 'balancePrimary', 'panelPrimary']) {
        assert.equal(experience[key].title, 'Withdrawal paused', key);
        assert.equal(experience[key].frozen, undefined);
    }
});
