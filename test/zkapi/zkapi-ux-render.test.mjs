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
    renderZkapiComposerStatus,
    renderZkapiPanelExperience
} = await import('../../chat/zkapi/components/ZkapiStateExperience.js');
const { createVanillaUiInterface } = await import('../../chat/ui/appInterface.js');
const { default: Sidebar } = await import('../../chat/components/Sidebar.js');
const { default: RightPanel } = await import('../../chat/zkapi/components/RightPanel.js');
const { default: AccountModal } = await import('../../chat/zkapi/components/AccountModal.js');
const { default: WelcomePanel } = await import('../../chat/zkapi/components/WelcomePanel.js');
const { default: zkapiClient, ZkapiClient } = await import('@openanonymity/zkapi-browser-sdk/client');
const {
    buildMessageHTML,
    buildTypingIndicator,
    configureMessageTemplateServices
} = await import('../../chat/components/MessageTemplates.js');
const { processMessagesForApi } = await import('../../chat/domain/messageContent.js');
const { createZkapiUi } = await import('../../chat/zkapi/ui/createZkapiUi.js');
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
    panel.updateUsageEstimate();
    assert.equal(keyLabel.textContent, '$1 per key');
    await picker.actions.selectModel('GPT-6 Astra Pro');
    assert.equal(keyLabel.textContent, '$6 per key');
    assert.equal(panel.currentSession, session, 'same-chat snapshots are refreshed from the live selection');

    zkapiClient.config = { active_lease: { session_id: session.id,
        spending_limit_usd: 4.5, expires_at: Date.now() / 1000 + 300 } };
    await picker.actions.selectModel('GPT-4o Mini');
    assert.equal(keyLabel.textContent, '$4.50 per key', 'a live owned key still displays its actual cap');

    session = { id: 'another-chat', model: 'GPT-6 Astra Pro' };
    app.renderCurrentModel();
    assert.equal(keyLabel.textContent, '$4.50 per key', 'navigation waits for its own panel update');
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
        newChatSettlementState: null
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
        badgeClass: 'bg-amber-100 text-amber-800 dark:bg-amber-500\/15 dark:text-amber-200'
    });

    app.newChatSettlementState = {
        phase: 'ready',
        sessionId: oldChat.id,
        message: 'Finished.'
    };
    assert.match(sidebar.buildSessionHTML(oldChat), /Private key settled/);
    assert.equal(panel.getMissingApiKeyStatus().badge, 'Ready');
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
        assert.equal(finalizeButton.textContent, 'Finalize in MetaMask');
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
            demo_mint_enabled: false,
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
        assert.match(html, /Private deposit ready to resume/);
        assert.match(html, /value="5" readonly/);
        assert.doesNotMatch(html, /value="99"/);
        assert.match(html, /Resume deposit with MetaMask/);
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
            assert.doesNotMatch(html, /zkapi-watch-token-btn|Add USDC to MetaMask|<dt>Network|<dt>Request mode|<dt>Vault/);
            assert.match(html, note ? /Withdraw/ : /Continue with MetaMask/);
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
            /Amount returned|id="zkapi-retry-dropped-withdrawal-btn"|id="zkapi-retry-withdrawal-btn"|id="zkapi-finalize-btn"|id="zkapi-withdraw-btn"/);
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
    assert.equal(label.textContent, 'Waiting for MetaMask');
    modal.backgroundProgress.phase = 'confirming';
    modal.updateBackgroundProgress();
    assert.equal(label.textContent, 'Confirming transaction');
    assert.equal(modal.backgroundProgressLabel('new-note'), null);
});

test('mined withdrawals with a temporary status outage get neutral feedback instead of a failed-payment toast', async t => {
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
    assert.equal(toasts[0][0], error.shortMessage);
    assert.equal(toasts[0][1], 'info');
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
        assert.match(html, /No receipt was found/);
        assert.match(html, /Resubmit with original nonce/);
        assert.match(html, /id="zkapi-sync-withdrawal-btn"/);
        assert.doesNotMatch(html, /id="zkapi-withdraw-btn"/);
    } finally {
        zkapiClient.wallet = originalWallet;
        zkapiClient.config = originalConfig;
        zkapiClient.withdrawal = originalWithdrawal;
        zkapiClient.formatMoney = originalFormatMoney;
    }
});

test('funding rerenders keep pasted quote characters inside the amount value', () => {
    const originalDocument = globalThis.document;
    const originalWallet = zkapiClient.wallet;
    const originalConfig = zkapiClient.config;
    globalThis.document = {
        ...originalDocument,
        createElement() {
            return {
                textContent: '',
                // Browser text-node serialization does not escape quotes.
                get innerHTML() { return this.textContent.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;'); }
            };
        }
    };
    zkapiClient.wallet = { has_note: false, note: null };
    zkapiClient.config = { funding: {} };
    try {
        const amount = '5" autofocus onfocus="alert(1)';
        const welcome = Object.create(WelcomePanel.prototype);
        welcome.depositAmount = amount;
        const account = Object.create(AccountModal.prototype);
        account.depositAmount = amount;
        account.renderWithdrawalStatusLink = () => '';
        for (const html of [welcome.renderWelcome(), account.renderBalance()]) {
            const input = html.match(/<input\b[^>]*>/)?.[0];
            assert.ok(input);
            assert.equal(input.match(/\bvalue="([^"]*)"/)?.[1], '5&quot; autofocus onfocus=&quot;alert(1)');
            assert.doesNotMatch(input, /"\s+autofocus/);
        }
    } finally {
        globalThis.document = originalDocument;
        zkapiClient.wallet = originalWallet;
        zkapiClient.config = originalConfig;
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

test('balance panel and modal expose billing and expiry help without the redundant bottom disclosure', () => {
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
        assert.match(modal.overlay.innerHTML, /zkapi-modal-billing-help-toggle/);
        assert.match(modal.overlay.innerHTML, /data-zkapi-balance-expiry>[^<]+<\/span><button id="zkapi-modal-expiry-help-toggle"/);
        assert.match(modal.overlay.innerHTML, /data-zkapi-help-content="billing" hidden/);
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
        assert.match(claimedPanel, />claimed<\/span>/);
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
        assert.match(thinking, />Thinking</);
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
            current: 'Thinking',
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
    assert.match(shell, /panelToggle\.before\(balance\)/);
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
    assert.match(element.innerHTML, /zkapi-state-glyph--error/);
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
    const reducedMotion = css.slice(css.lastIndexOf('@media (prefers-reduced-motion: reduce)'));

    assert.doesNotMatch(css, /\.user-delivery-(?:row|details|glyph|label|popover|actions)/);
    assert.doesNotMatch(css, /zkapiReceiptOrbit/);
    assert.match(css, /\.message-action-btn\.is-processing::after,[\s\S]*?animation: zkapiActionOrbit/);
    assert.match(css, /\.chat-session\[data-deleting="true"\]\s*\{[\s\S]*?cursor: wait/);
    assert.match(css, /\.zkapi-composer-live-status\s*\{[\s\S]*?clip: rect\(0, 0, 0, 0\)/);
    assert.match(reducedMotion, /\.pending-response-streaming\s*\{[\s\S]*?animation: none !important/);
    assert.match(reducedMotion, /\.message-action-btn\.is-processing::after/);
    assert.match(reducedMotion, /-webkit-text-fill-color: currentColor !important/);
});
