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
        reasoningEnabled: true,
        sessionSearchQuery: 'query',
        getCurrentSession: () => session,
        normalizeModelName: (modelName) => `${modelName} normalized`,
        renderCurrentModel: () => calls.push(['renderCurrentModel']),
        getFilteredSessions: () => [{ id: 'session-1' }],
        toggleSessionStar: (sessionId) => calls.push(['toggleSessionStar', sessionId]),
        deleteSession: (sessionId) => calls.push(['deleteSession', sessionId]),
        switchSession: (sessionId) => calls.push(['switchSession', sessionId]),
        shareCurrentSession: () => calls.push(['shareCurrentSession']),
        copySessionLink: () => calls.push(['copySessionLink']),
        deleteCurrentSessionShare: () => calls.push(['deleteCurrentSessionShare']),
        exportChatToPdf: () => calls.push(['exportChatToPdf']),
        updateSessionTitle: (sessionId, title) => calls.push(['updateSessionTitle', sessionId, title]),
        updateToolbarDivider: () => calls.push(['updateToolbarDivider']),
        hasActiveSessionListCriteria: () => true,
        getSessionListEmptyText: () => 'No sessions'
    };
    return { app, calls, session };
}

test('model picker interface exposes only model-picker elements and state selectors', () => {
    const { app } = createMockApp();
    const ui = createModelPickerInterface(app, {
        chatDBImpl: { saveSetting: async () => {}, saveSession: async () => {} }
    });

    assert.equal(ui.elements.modelPickerBtn.id, 'modelPickerBtn');
    assert.equal(ui.elements.sessionsList, undefined);
    assert.equal(ui.state, app.state);
    assert.equal(ui.reasoningEnabled, true);
    assert.equal(ui.getCurrentSession(), null);
    assert.equal(ui.normalizeModelName('Model A'), 'Model A normalized');
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
    ui.updateToolbarDivider();

    assert.deepEqual(calls, [
        ['toggleSessionStar', 'session-1'],
        ['switchSession', 'session-2'],
        ['updateSessionTitle', 'session-2', 'Title'],
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

test('component app facade exposes an explicit compatibility contract', () => {
    const { app } = createMockApp();
    const facade = createComponentAppFacade(app, undefined, {
        ticketClientImpl: { getTicketCount: () => 0 }
    });

    assert.equal(facade.__appFacade, true);
    assert.equal(typeof facade.services.tickets.getTicketCount, 'function');
    assert.equal(facade.elements.sessionsList.id, 'sessionsList');
    assert.equal(facade.getCurrentSession(), null);
    assert.equal(facade.notARealAppField, undefined);

    facade.searchEnabled = false;
    assert.equal(app.searchEnabled, false);
    assert.throws(() => {
        facade.randomNewField = true;
    }, /unsupported app field/);
});
