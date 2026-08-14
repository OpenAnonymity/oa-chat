import test from 'node:test';
import assert from 'node:assert/strict';
import {
    createComponentAppFacade,
    createComponentDataInterface,
    createComponentServicesInterface,
    createModelPickerInterface,
    createSidebarInterface,
    createVanillaUiInterface
} from '../../chat/ui/appInterface.js';

function createMockApp(overrides = {}) {
    const calls = [];
    const session = overrides.session ?? null;
    const app = {
        elements: {
            modelPickerBtn: { id: 'modelPickerBtn' },
            modelPickerModal: { id: 'modelPickerModal' },
            closeModalBtn: { id: 'closeModalBtn' },
            modelsList: { id: 'modelsList' },
            modelSearch: { id: 'modelSearch' },
            modelListScrollArea: { id: 'modelListScrollArea' },
            messageInput: { id: 'messageInput' },
            sessionsScrollArea: { id: 'sessionsScrollArea' },
            sessionsList: { id: 'sessionsList' },
            sidebar: { id: 'sidebar' }
        },
        state: {
            models: [{ id: 'model-a', name: 'Model A' }],
            pendingModelName: null,
            currentSessionId: session?.id || null
        },
        cachedModelDisplayMetadata: overrides.cachedModelDisplayMetadata || [],
        reasoningEnabled: true,
        memoryFeatureEnabled: true,
        sessionSearchQuery: 'query',
        getCurrentSession: () => session,
        getDefaultModelName: () => 'Default Model',
        getFallbackModelEntry: () => ({ id: 'model-a', name: 'Model A' }),
        normalizeModelName: (modelName) => `${modelName} normalized`,
        setParallelDefaults: (options) => {
            calls.push(['setParallelDefaults', options]);
            return options;
        },
        renderCurrentModel: () => calls.push(['renderCurrentModel']),
        getFilteredSessions: () => [{ id: 'session-1' }],
        toggleSessionStar: (sessionId) => calls.push(['toggleSessionStar', sessionId]),
        deleteSession: (sessionId) => calls.push(['deleteSession', sessionId]),
        switchSession: (sessionId) => calls.push(['switchSession', sessionId]),
        shareCurrentSession: () => calls.push(['shareCurrentSession']),
        copySessionLink: () => calls.push(['copySessionLink']),
        deleteCurrentSessionShare: () => calls.push(['deleteCurrentSessionShare']),
        exportChatToPdf: () => calls.push(['exportChatToPdf']),
        exportChatAsMarkdown: (sessionId) => calls.push(['exportChatAsMarkdown', sessionId]),
        updateSessionTitle: (sessionId, title) => calls.push(['updateSessionTitle', sessionId, title]),
        updateToolbarDivider: () => calls.push(['updateToolbarDivider']),
        setMemoryFeatureEnabled: async (enabled) => calls.push(['setMemoryFeatureEnabled', enabled]),
        hasActiveSessionListCriteria: () => true,
        getSessionListEmptyText: () => 'No sessions'
    };
    return { app, calls, session };
}

test('model picker interface exposes only model-picker elements and state selectors', () => {
    const cachedModel = { id: 'openrouter/auto', name: 'Auto Router', provider: 'OpenRouter' };
    const { app } = createMockApp({ cachedModelDisplayMetadata: [cachedModel] });
    const ui = createModelPickerInterface(app, {
        chatDBImpl: { saveSetting: async () => {}, saveSession: async () => {} }
    });

    assert.equal(ui.elements.modelPickerBtn.id, 'modelPickerBtn');
    assert.equal(ui.elements.sessionsList, undefined);
    assert.equal(ui.state, app.state);
    assert.equal(ui.reasoningEnabled, true);
    assert.deepEqual(ui.cachedModelDisplayMetadata, [cachedModel]);
    assert.equal(ui.getCurrentSession(), null);
    assert.equal(ui.getDefaultModelName(), 'Default Model');
    assert.equal(ui.normalizeModelName('Model A'), 'Model A normalized');

    app.cachedModelDisplayMetadata = [];
    assert.deepEqual(ui.cachedModelDisplayMetadata, [], 'cache exposure should remain a live read-only view');
});

test('model picker selectModel stores pending model when there is no session', async () => {
    const { app, calls } = createMockApp();
    const savedSettings = [];
    const savedSessions = [];
    const ui = createModelPickerInterface(app, {
        chatDBImpl: {
            saveSetting: async (...args) => savedSettings.push(args),
            saveSession: async (...args) => savedSessions.push(args)
        }
    });

    const result = await ui.actions.selectModel('Model A');

    assert.deepEqual(result, { session: null, modelName: 'Model A normalized' });
    assert.equal(app.state.pendingModelName, 'Model A normalized');
    assert.deepEqual(savedSettings, [['selectedModel', 'Model A normalized']]);
    assert.deepEqual(savedSessions, []);
    assert.deepEqual(calls, [['renderCurrentModel']]);
});

test('model picker selectModel updates active session through injected persistence', async () => {
    const activeSession = { id: 'session-1', model: 'Old Model' };
    const { app, calls } = createMockApp({ session: activeSession });
    const savedSettings = [];
    const savedSessions = [];
    const ui = createModelPickerInterface(app, {
        chatDBImpl: {
            saveSetting: async (...args) => savedSettings.push(args),
            saveSession: async (...args) => savedSessions.push(args)
        }
    });

    const result = await ui.actions.selectModel('Model A');

    assert.equal(result.session, activeSession);
    assert.equal(activeSession.model, 'Model A normalized');
    assert.deepEqual(savedSettings, [['selectedModel', 'Model A normalized']]);
    assert.deepEqual(savedSessions, [[activeSession]]);
    assert.deepEqual(calls, [['renderCurrentModel']]);
});

test('model picker renders cached provider metadata through its narrowed interface', async () => {
    const originalDocument = globalThis.document;
    const originalLocalStorage = globalThis.localStorage;
    globalThis.document = {
        addEventListener() {},
        getElementById() {
            return null;
        }
    };
    globalThis.localStorage = {
        getItem() {
            return null;
        },
        setItem() {}
    };

    try {
        const { default: ModelPicker } = await import('../../chat/components/ModelPicker.js');
        const cachedModel = { id: 'openrouter/auto', name: 'Auto Router normalized', provider: 'OpenRouter' };
        const { app } = createMockApp({ cachedModelDisplayMetadata: [cachedModel] });
        app.state.models = [];
        app.state.pendingModelName = 'Auto Router';
        app.elements.modelPickerBtn = {
            innerHTML: '',
            title: '',
            classList: { add() {} },
            setAttribute() {}
        };
        const ui = createModelPickerInterface(app, {
            chatDBImpl: { saveSetting: async () => {}, saveSession: async () => {} }
        });

        new ModelPicker(ui).renderCurrentModel();

        assert.match(app.elements.modelPickerBtn.innerHTML, /src="img\/openrouter\.svg"/);
        assert.match(app.elements.modelPickerBtn.innerHTML, /alt="OpenRouter"/);
    } finally {
        if (originalDocument === undefined) {
            delete globalThis.document;
        } else {
            globalThis.document = originalDocument;
        }
        if (originalLocalStorage === undefined) {
            delete globalThis.localStorage;
        } else {
            globalThis.localStorage = originalLocalStorage;
        }
    }
});

test('model picker secondary selection delegates to chat input without changing primary model', async () => {
    const activeSession = { id: 'session-1', model: 'Primary Model' };
    const { app } = createMockApp({ session: activeSession });
    const delegatedSelections = [];
    app.chatInput = {
        getPrimaryModelName: () => 'Primary Model',
        getSelectedCouncilSecondaryModelName: () => 'Old Secondary',
        selectCouncilSecondaryModel: async (modelName) => delegatedSelections.push(modelName)
    };
    const ui = createModelPickerInterface(app, {
        chatDBImpl: {
            saveSetting: async () => {},
            saveSession: async () => {}
        }
    });

    const result = await ui.actions.selectCouncilSecondaryModel('Model A');

    assert.deepEqual(result, { session: activeSession, modelName: 'Model A normalized' });
    assert.equal(ui.getPrimaryModelName(), 'Primary Model');
    assert.equal(ui.getCouncilSecondaryModelName(), 'Old Secondary');
    assert.equal(activeSession.model, 'Primary Model');
    assert.deepEqual(delegatedSelections, ['Model A normalized']);
});

test('model picker council selection delegates to chat input without changing primary model', async () => {
    const activeSession = { id: 'session-1', model: 'Primary Model' };
    const { app } = createMockApp({ session: activeSession });
    const delegatedSelections = [];
    app.chatInput = {
        getPrimaryModelName: () => 'Primary Model',
        getCouncilSynthesisModelForSelection: () => 'Old Council',
        selectCouncilSynthesisModel: async (modelName) => delegatedSelections.push(modelName)
    };
    const ui = createModelPickerInterface(app, {
        chatDBImpl: {
            saveSetting: async () => {},
            saveSession: async () => {}
        }
    });

    const result = await ui.actions.selectCouncilSynthesisModel('Model A');

    assert.deepEqual(result, { session: activeSession, modelName: 'Model A normalized' });
    assert.equal(ui.getPrimaryModelName(), 'Primary Model');
    assert.equal(ui.getCouncilSynthesisModelName(), 'Old Council');
    assert.equal(activeSession.model, 'Primary Model');
    assert.deepEqual(delegatedSelections, ['Model A normalized']);
});

test('sidebar interface exposes sidebar-only elements and proxies actions', async () => {
    const { app, calls } = createMockApp();
    const ui = createSidebarInterface(app);

    assert.equal(ui.elements.sessionsList.id, 'sessionsList');
    assert.equal(ui.elements.modelPickerBtn, undefined);
    assert.equal(ui.sessionSearchQuery, 'query');
    assert.deepEqual(ui.getFilteredSessions(), [{ id: 'session-1' }]);
    assert.equal(ui.hasActiveSessionListCriteria(), true);
    assert.equal(ui.getSessionListEmptyText(), 'No sessions');

    await ui.toggleSessionStar('session-1');
    await ui.switchSession('session-2');
    await ui.updateSessionTitle('session-2', 'Title');
    await ui.exportChatAsMarkdown('session-2');
    ui.updateToolbarDivider();

    assert.deepEqual(calls, [
        ['toggleSessionStar', 'session-1'],
        ['switchSession', 'session-2'],
        ['updateSessionTitle', 'session-2', 'Title'],
        ['exportChatAsMarkdown', 'session-2'],
        ['updateToolbarDivider']
    ]);
});

test('vanilla UI interface groups component-specific interfaces', () => {
    const { app } = createMockApp();
    const ui = createVanillaUiInterface(app, {
        chatDBImpl: { saveSetting: async () => {}, saveSession: async () => {} }
    });

    assert.ok(ui.modelPicker);
    assert.ok(ui.sidebar);
    assert.equal(ui.modelPicker.elements.modelPickerBtn.id, 'modelPickerBtn');
    assert.equal(ui.sidebar.elements.sessionsList.id, 'sessionsList');
});

test('component data interface isolates persistence calls behind an adapter', async () => {
    const calls = [];
    const data = createComponentDataInterface({
        chatDBImpl: {
            getSessionMessages: async (...args) => {
                calls.push(['getSessionMessages', ...args]);
                return [{ id: 'message-1' }];
            },
            getAllSessions: async (...args) => {
                calls.push(['getAllSessions', ...args]);
                return [{ id: 'session-1' }];
            },
            collectImportedSessionKeys: async (...args) => {
                calls.push(['collectImportedSessionKeys', ...args]);
                return new Set(['source:external-1']);
            },
            saveMessage: async (...args) => calls.push(['saveMessage', ...args]),
            deleteMessage: async (...args) => calls.push(['deleteMessage', ...args]),
            deleteSessionMessages: async (...args) => calls.push(['deleteSessionMessages', ...args]),
            saveSession: async (...args) => calls.push(['saveSession', ...args]),
            saveSessionWithMessages: async (...args) => calls.push(['saveSessionWithMessages', ...args]),
            getSetting: async (...args) => {
                calls.push(['getSetting', ...args]);
                return 'setting-value';
            },
            saveSetting: async (...args) => calls.push(['saveSetting', ...args])
        }
    });

    assert.equal(data.hasImportedSessionKeyIndex, true);
    assert.deepEqual(await data.getSessionMessages('session-1'), [{ id: 'message-1' }]);
    assert.deepEqual(await data.getAllSessions(), [{ id: 'session-1' }]);
    assert.deepEqual(await data.collectImportedSessionKeys('source'), new Set(['source:external-1']));
    await data.saveMessage({ id: 'message-2' });
    await data.deleteMessage('message-2');
    await data.deleteSessionMessages('session-1');
    await data.saveSession({ id: 'session-1' });
    await data.saveSessionWithMessages({ id: 'session-2' }, [{ id: 'message-3' }]);
    assert.equal(await data.getSetting('searchEnabled'), 'setting-value');
    await data.saveSetting('searchEnabled', true);

    assert.deepEqual(calls, [
        ['getSessionMessages', 'session-1'],
        ['getAllSessions'],
        ['collectImportedSessionKeys', 'source'],
        ['saveMessage', { id: 'message-2' }],
        ['deleteMessage', 'message-2'],
        ['deleteSessionMessages', 'session-1'],
        ['saveSession', { id: 'session-1' }],
        ['saveSessionWithMessages', { id: 'session-2' }, [{ id: 'message-3' }]],
        ['getSetting', 'searchEnabled'],
        ['saveSetting', 'searchEnabled', true]
    ]);
});

test('component services interface groups backend-facing services for UI injection', () => {
    const services = createComponentServicesInterface({
        ticketClientImpl: { name: 'tickets' },
        networkLoggerImpl: { name: 'logger' },
        networkProxyImpl: { name: 'proxy' },
        inferenceServiceImpl: { name: 'inference' },
        verifierServiceImpl: { name: 'verifier' },
        shareServiceImpl: { name: 'share' },
        accountServiceImpl: { name: 'account' },
        syncServiceImpl: { name: 'sync' }
    });

    assert.deepEqual(services.tickets, { name: 'tickets' });
    assert.deepEqual(services.networkLogger, { name: 'logger' });
    assert.deepEqual(services.networkProxy, { name: 'proxy' });
    assert.deepEqual(services.inference, { name: 'inference' });
    assert.deepEqual(services.verifier, { name: 'verifier' });
    assert.deepEqual(services.share, { name: 'share' });
    assert.deepEqual(services.account, { name: 'account' });
    assert.deepEqual(services.sync, { name: 'sync' });
});

test('component app facade exposes memory feature controls', async () => {
    const { app, calls } = createMockApp();
    const facade = createComponentAppFacade(app);

    assert.equal(facade.memoryFeatureEnabled, true);

    await facade.setMemoryFeatureEnabled(false);

    assert.deepEqual(calls, [['setMemoryFeatureEnabled', false]]);
});

test('component app facade exposes an explicit compatibility contract', () => {
    const { app, calls } = createMockApp();
    const facade = createComponentAppFacade(app, undefined, {
        ticketClientImpl: { getTicketCount: () => 0 }
    });

    assert.equal(facade.__appFacade, true);
    assert.equal(typeof facade.services.tickets.getTicketCount, 'function');
    assert.equal(facade.elements.sessionsList.id, 'sessionsList');
    assert.equal(facade.getCurrentSession(), null);
    assert.equal(facade.getDefaultModelName(), 'Default Model');
    assert.deepEqual(facade.getFallbackModelEntry(), { id: 'model-a', name: 'Model A' });
    assert.deepEqual(facade.setParallelDefaults({ enabled: true }), { enabled: true });
    assert.deepEqual(calls, [['setParallelDefaults', { enabled: true }]]);
    assert.equal(facade.notARealAppField, undefined);

    facade.searchEnabled = false;
    assert.equal(app.searchEnabled, false);
    assert.throws(() => {
        facade.randomNewField = true;
    }, /unsupported app field/);
});
