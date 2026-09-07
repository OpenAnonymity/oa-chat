import test from 'node:test';
import assert from 'node:assert/strict';

const storageDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: { getItem: () => null, setItem() {}, removeItem() {} }
});
const { default: ChatInput } = await import('../../chat/components/ChatInput.js');
const { default: scrubberService } = await import('../../chat/services/scrubberService.js');
if (storageDescriptor) Object.defineProperty(globalThis, 'localStorage', storageDescriptor);
else delete globalThis.localStorage;

function element(dataset = {}) {
    const attributes = new Map();
    const classes = new Set();
    return {
        dataset,
        style: {},
        disabled: false,
        value: '',
        classList: {
            add: (...names) => names.forEach(name => classes.add(name)),
            remove: (...names) => names.forEach(name => classes.delete(name)),
            toggle(name, enabled) { if (enabled) classes.add(name); else classes.delete(name); },
            contains: name => classes.has(name)
        },
        setAttribute: (name, value) => attributes.set(name, value),
        getAttribute: name => attributes.get(name),
        removeAttribute: name => attributes.delete(name),
        querySelector: () => null,
        dispatchEvent() {},
        setSelectionRange() {}
    };
}

function fixture({ backend = 'openrouter', globalMemory = true } = {}) {
    const chatButton = element({ modeOption: 'chat' });
    const parallelButton = element({ modeOption: 'parallel' });
    const memoryButton = element();
    const modeControl = element();
    modeControl.querySelectorAll = () => [chatButton, parallelButton];
    const messageInput = element();
    const writes = [];
    const toasts = [];
    let current = { id: 'owner', inferenceBackend: backend, responseMode: 'council', councilConfig: { enabled: true } };
    const reservations = new Set();
    const app = {
        elements: { memoryToggle: modeControl, memoryContextToggle: memoryButton, messageInput, inputCard: element() },
        features: { memory: true, council: true, scrubber: true },
        memoryFeatureEnabled: globalMemory,
        memoryMode: true,
        sessionNavigationGeneration: 1,
        getCurrentSession: () => current,
        getPendingCouncilConfig: () => ({ enabled: true }),
        supportsFeature: (_feature, session = current) => (session?.inferenceBackend || backend) === 'openrouter',
        getFeatureUnavailableReason: feature => `${feature} requires Tickets.`,
        data: { saveSetting: async (...args) => writes.push(args) },
        showToast: (...args) => toasts.push(args),
        showLoadingToast: () => () => {},
        beginFeatureOperation(feature, session) {
            const controller = new AbortController();
            const operation = { feature, sessionId: session?.id, signal: controller.signal, controller };
            reservations.add(operation);
            return operation;
        },
        bindFeatureOperation(operation, session) { operation.sessionId = session.id; return true; },
        finishFeatureOperation: operation => reservations.delete(operation)
    };
    const input = Object.create(ChatInput.prototype);
    input.app = app;
    input.scrubberState = { isRunning: false, draftRevision: 0 };
    input.scrubberDiffState = {};
    input.updateScrubberHintVisibility = () => {};
    input.updateScrubberPreviewHintVisibility = () => {};
    return { input, app, chatButton, parallelButton, memoryButton, modeControl, messageInput, writes, toasts, reservations,
        navigate(session) { current = session; app.sessionNavigationGeneration += 1; },
        setCurrent(session) { current = session; } };
}

function deferred() {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
}

test('composer restores ticket features and remembered choices after an unsupported payment mode', () => {
    const previousDocument = globalThis.document;
    globalThis.document = { documentElement: { dataset: {} } };
    try {
        const f = fixture();
        f.input.updateMemoryToggleUI();
        assert.equal(f.modeControl.dataset.mode, 'parallel');
        assert.equal(f.memoryButton.getAttribute('aria-checked'), 'true');
        assert.equal(f.parallelButton.disabled, false);

        f.app.getCurrentSession().inferenceBackend = 'zkapi';
        f.input.updateMemoryToggleUI();
        assert.equal(f.modeControl.dataset.mode, 'chat');
        assert.equal(f.parallelButton.disabled, true);
        assert.equal(f.parallelButton.getAttribute('aria-disabled'), 'true');
        assert.match(f.parallelButton.title, /requires Tickets/);
        assert.equal(f.memoryButton.disabled, true);
        assert.equal(f.memoryButton.getAttribute('aria-checked'), 'false');
        assert.equal(f.app.memoryMode, true);
        assert.equal(f.app.getCurrentSession().councilConfig.enabled, true);
        assert.equal(f.writes.length, 0);

        f.app.getCurrentSession().inferenceBackend = 'openrouter';
        f.input.updateMemoryToggleUI();
        assert.equal(f.modeControl.dataset.mode, 'parallel');
        assert.equal(f.parallelButton.disabled, false);
        assert.equal(f.memoryButton.disabled, false);
        assert.equal(f.memoryButton.getAttribute('aria-checked'), 'true');
    } finally {
        globalThis.document = previousDocument;
    }
});

test('global Memory off remains disabled when ticket feature support returns', () => {
    const previousDocument = globalThis.document;
    globalThis.document = { documentElement: { dataset: {} } };
    try {
        const f = fixture({ globalMemory: false });
        f.input.updateMemoryToggleUI();
        assert.equal(f.memoryButton.disabled, true);
        assert.match(f.memoryButton.title, /off in settings/);
        assert.equal(f.parallelButton.disabled, false);
    } finally {
        globalThis.document = previousDocument;
    }
});

test('unsupported composer actions cannot mutate saved Memory or Parallel preferences or redeem a key', async () => {
    const f = fixture({ backend: 'zkapi' });
    f.messageInput.value = 'A draft';
    await f.input.setMemoryContextEnabled(true);
    await f.input.setCouncilModeFromComposer(true);
    await f.input.setCouncilReviewEnabledFromSettings(true);
    await f.input.persistCouncilSelectionFromControls();
    await f.input.runScrubberShortcut();
    assert.equal(f.writes.length, 0);
    assert.equal(f.reservations.size, 0);
    assert.equal(f.app.memoryMode, true);
    assert.ok(f.toasts.every(([message]) => /requires Tickets/.test(message)));
});

test('scrubber keeps its owner reserved and discards late results after navigation', async () => {
    const originalRedact = scrubberService.redactPrompt;
    const result = deferred();
    const f = fixture();
    f.messageInput.value = 'Original private draft';
    let owner;
    scrubberService.redactPrompt = async (_text, session) => { owner = session; return result.promise; };
    try {
        const work = f.input.runScrubberShortcut();
        assert.equal(owner.id, 'owner');
        assert.equal(f.reservations.size, 1);
        f.navigate({ id: 'other', inferenceBackend: 'zkapi' });
        f.messageInput.value = 'Other draft';
        result.resolve({ success: true, text: 'Redacted' });
        await work;
        assert.equal(f.messageInput.value, 'Other draft');
        assert.equal(f.app.scrubberPending, undefined);
        assert.equal(f.reservations.size, 0);
    } finally {
        scrubberService.redactPrompt = originalRedact;
    }
});

test('scrubber does not replace a draft edited and changed back during its request', async () => {
    const originalRedact = scrubberService.redactPrompt;
    const result = deferred();
    const f = fixture();
    f.messageInput.value = 'Original draft';
    scrubberService.redactPrompt = () => result.promise;
    try {
        const work = f.input.runScrubberShortcut();
        f.input.scrubberState.draftRevision += 2;
        result.resolve({ success: true, text: 'Redacted' });
        await work;
        assert.equal(f.messageInput.value, 'Original draft');
        assert.equal(f.app.scrubberPending, undefined);
        assert.equal(f.reservations.size, 0);
    } finally {
        scrubberService.redactPrompt = originalRedact;
    }
});

test('scrubber binds a new chat before session persistence and updates only its unchanged draft', async () => {
    const originalRedact = scrubberService.redactPrompt;
    const persisted = deferred();
    const f = fixture();
    f.setCurrent(null);
    f.messageInput.value = 'Original draft';
    const created = { id: 'created', inferenceBackend: 'openrouter' };
    f.app.createSession = async (_title, options) => {
        f.setCurrent(created);
        options.onCreated(created);
        assert.equal([...f.reservations][0].sessionId, 'created');
        await persisted.promise;
        return created;
    };
    scrubberService.redactPrompt = async (_text, session) => {
        assert.equal(session, created);
        return { success: true, text: 'Redacted' };
    };
    try {
        const work = f.input.runScrubberShortcut();
        assert.equal(f.reservations.size, 1);
        persisted.resolve();
        await work;
        assert.equal(f.messageInput.value, 'Redacted');
        assert.equal(f.app.scrubberPending.original, 'Original draft');
        assert.equal(f.reservations.size, 0);
    } finally {
        scrubberService.redactPrompt = originalRedact;
    }
});
