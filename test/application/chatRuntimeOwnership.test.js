import test, { describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

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
        fetch: async () => { throw new Error('These controller tests must never use the network.'); },
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

// Import the real production controller without booting an app, opening
// IndexedDB, synchronizing accounts or using a browser-wallet singleton.
const restoreImport = installBrowser();
const { default: preferencesStore } = await import('../../chat/services/preferencesStore.js');
const getPreference = preferencesStore.getPreference;
preferencesStore.getPreference = async () => false;
const { ChatApp } = await import('../../chat/app.js');
const { chatDB } = await import('../../chat/db.js');
const { createInferenceService } = await import('../../chat/publicInferenceApi.js');
const { default: RightPanel } = await import('../../chat/components/RightPanel.js');
const { createModelPickerInterface } = await import('../../chat/ui/appInterface.js');
preferencesStore.getPreference = getPreference;
restoreImport();

function deferred() {
    let resolve;
    const promise = new Promise(value => { resolve = value; });
    return { promise, resolve };
}

function appHarness() {
    return Object.assign(Object.create(ChatApp.prototype), {
        runtime: {},
        state: { currentSessionId: 'one', pendingModelName: 'Model one', models: [], sessions: [],
            sessionsById: new Map([['one', { id: 'one', model: 'Model one' }], ['two', { id: 'two' }]]) },
        elements: { messageInput: { value: 'Original prompt', focus() {} } },
        uploadedFiles: [],
        sendSubmissionsInFlight: new Map(),
        accessAcquisitionInFlight: new Map(),
        sessionStreamingStates: new Map(),
        titleGenerationJobs: new Map(),
        quickAskJobs: new Map(),
        regenerationJobs: new Map(),
        sessionMutationOwners: new Map(),
        exclusiveSessionMutationOwners: new Map(),
        deletingSessionIds: new Set(),
        deletedSessionIds: new Set(),
        sessionMutationReservations: new Map(),
        sessionNavigationGeneration: 0,
        searchEnabled: true,
        reasoningEnabled: true,
        reasoningEffort: 'high',
        memoryMode: false,
        memoryFeatureEnabled: true,
        updateInputState() {},
        getCurrentSession() { return this.state.sessionsById.get(this.state.currentSessionId) || null; },
        showToast() {},
        clearMemoryApiOverrideContent() {},
        announceChatOperation() {}
    });
}

function streamHarness(stream) {
    const app = appHarness();
    const records = new Map();
    let sequence = 0;
    app.state.models = [{ id: 'accepted-model', name: 'Accepted model' }];
    app.state.sessionsById.get('one').model = 'Accepted model';
    app.generateId = () => `message-${++sequence}`;
    app.ensureDatabaseReady = async () => true;
    app.preflightTurnTicketBudget = async () => true;
    app.activateCouncilLayoutForSubmittedTurn = async () => {};
    app.reserveAccessAcquisitionHandoff = () => {};
    app.resolvePendingPhaseForSession = () => 'waiting-response';
    app.showTypingIndicator = () => null;
    app.setSessionStreamingState = (id, active, controller) => app.sessionStreamingStates.set(id, { isStreaming: active, abortController: controller });
    app.renderFilePreviews = app.updateFileCountBadge = app.resetMessageInputLayout = app.startPromptSlideUpEffect = () => {};
    app.updateScrollButtonVisibility = () => {};
    app.normalizeModelName = value => value;
    app.isCouncilModeActive = () => false;
    app.generateSessionTitleIfNeeded = async () => {};
    app.getMessageTextContent = value => value;
    app.sanitizeMessagesForApi = app.processMessagesWithFiles = messages => messages;
    app.hasScrubberContext = () => false;
    app.createAssistantScrubberMetadata = () => null;
    app.refreshProcessedMessagesIfMemoryOverrideChanged = messages => ({ processedMessages: messages });
    app.refreshSessionConversationSearchText = async () => {};
    app.triggerPostTurnMemoryExtraction = () => {};
    app.addImagesWithDedup = (target, images) => target.push(...images);
    app.setSessionPendingProgress = () => {};
    chatDB.getSessionMessages = async () => [...records.values()].map(message => structuredClone(message));
    chatDB.saveMessage = async message => { records.set(message.id, structuredClone(message)); };
    chatDB.deleteMessage = async id => { records.delete(id); };
    chatDB.saveSession = async () => {};
    app.addMessage = async (role, content, metadata, session) => {
        const message = { id: app.generateId(), sessionId: session.id, role, content, ...metadata, ...metadata.extra };
        delete message.extra;
        delete message.onPersisted;
        await chatDB.saveMessage(message);
        metadata.onPersisted?.(message);
        return message;
    };
    app.inferenceService = {
        getVerificationAdapter: () => ({ supports: false }), getAccessInfo: () => null,
        getAccessToken: () => 'opaque', isAccessExpired: () => false,
        getAccessLabel: () => 'access', getDisplayName: () => 'Accepted model',
        streamCompletion: stream
    };
    return { app, records };
}

function backendHarness() {
    const app = appHarness();
    app.features = { tickets: true };
    app.uiOptions = {};
    app.inferenceService = createInferenceService({ backends: ['ticket', 'paid'].map(id => ({
        id,
        getAccessToken: session => session.apiKey,
        setAccessInfo: (session, info) => { session.apiKey = info.token; },
        clearAccessInfo: session => { session.apiKey = null; session.apiKeyInfo = null; session.expiresAt = null; }
    })) });
    app.state.sessionsById.get('one').inferenceBackend = 'paid';
    app.state.sessionsById.get('two').inferenceBackend = 'ticket';
    app.refreshBackendPresentation = async () => {};
    app.normalizeModelName = value => value;
    return app;
}

describe('production ChatApp runtime ownership', () => {
    let restore;
    let databaseMethods;
    beforeEach(() => {
        restore = installBrowser();
        databaseMethods = Object.fromEntries(['saveMessage', 'deleteMessage', 'getSessionMessages', 'saveSession', 'saveSessionWithMessages', 'getSetting', 'saveSetting'].map(name => [name, chatDB[name]]));
    });
    afterEach(() => { Object.assign(chatDB, databaseMethods); restore(); });

    test('switching stages settlement metadata and preserves transcript, draft and navigation', async () => {
        const app = backendHarness();
        const session = app.getCurrentSession();
        Object.assign(session, { zkapiSessionId: 'lease', apiKey: 'old', councilAccess: { primary: { apiKey: 'old' } },
            shareInfo: { apiKeyShared: true } });
        const settlement = deferred();
        let staged;
        let persisted;
        app.runtime.beforeBackendChange = async args => {
            staged = args.session;
            assert.equal(args.previousBackendId, 'paid');
            assert.equal(args.backendId, 'ticket');
            delete staged.zkapiSessionId;
            await settlement.promise;
        };
        chatDB.saveSession = async record => { persisted = structuredClone(record); };
        const switching = app.changeSessionBackend('ticket');
        await Promise.resolve();
        assert.notEqual(staged, session);
        assert.equal(session.zkapiSessionId, 'lease');
        assert.equal(app.isSessionBusy('one'), true);
        let sent = false;
        app.sendCapturedMessage = async () => { sent = true; };
        await app.sendMessage();
        assert.equal(sent, false);
        await assert.rejects(app.inlineQuickAsk('selection'), /current chat action/);
        await assert.rejects(app.acquireAndSetAccess(session), /cancelled/);
        await app.generateSessionTitleIfNeeded('one', 'prompt');
        assert.equal(app.titleGenerationJobs.size, 0);
        await assert.rejects(app.changeSessionBackend('ticket'), /current chat action/);
        app.state.currentSessionId = 'two';
        app.elements.messageInput.value = 'Draft in chat two';
        settlement.resolve();
        await switching;
        assert.equal(session.inferenceBackend, 'ticket');
        assert.equal(persisted.zkapiSessionId, undefined);
        assert.equal(session.zkapiSessionId, undefined);
        assert.equal(session.councilAccess, undefined);
        assert.equal(session.shareInfo.apiKeyShared, false);
        assert.equal(session.apiKey, null);
        assert.equal(app.state.currentSessionId, 'two');
        assert.equal(app.elements.messageInput.value, 'Draft in chat two');
        assert.equal(app.isSessionBusy('one'), false);
    });

    test('failed settlement or storage retains the original backend and its recovery metadata', async () => {
        for (const failure of ['hook', 'storage']) {
            const app = backendHarness();
            const session = app.getCurrentSession();
            Object.assign(session, { zkapiSessionId: 'recoverable', apiKey: 'old' });
            const snapshot = structuredClone(session);
            app.runtime.beforeBackendChange = async ({ session: staged }) => {
                delete staged.zkapiSessionId;
                if (failure === 'hook') throw new Error('settlement failed');
            };
            chatDB.saveSession = async () => { throw new Error('storage failed'); };
            await assert.rejects(app.changeSessionBackend('ticket'), /failed/);
            assert.deepEqual(session, snapshot);
            assert.equal(app.isSessionBusy('one'), false);
        }
    });

    test('switch drains a captured Quick Ask before settlement and Delete waits for its reservation', async () => {
        const app = backendHarness();
        const controller = new AbortController();
        app.quickAskJobs.set('one', new Set([{ controller }]));
        controller.signal.addEventListener('abort', () => app.quickAskJobs.delete('one'));
        const settlement = deferred();
        let entered = false;
        app.runtime.beforeBackendChange = async () => { entered = true; await settlement.promise; };
        let saves = 0;
        chatDB.saveSession = async () => { saves++; };
        const switching = app.changeSessionBackend('ticket');
        await Promise.resolve();
        assert.equal(controller.signal.aborted, true);
        assert.equal(entered, true);
        let deleted = false;
        app.deleteIdleSession = async () => { deleted = true; };
        const deleting = app.deleteSession('one');
        assert.equal(deleted, false);
        settlement.resolve();
        await assert.rejects(switching, /unavailable/);
        assert.equal(await deleting, true);
        assert.equal(deleted, true);
        assert.equal(saves, 0);
    });

    test('empty composer default is captured by Send before database or preference delays', async () => {
        const app = backendHarness();
        app.state.currentSessionId = null;
        await app.changeSessionBackend('paid');
        assert.equal(app.state.sessionsById.get('two').inferenceBackend, 'ticket');
        const gate = deferred();
        let captured;
        app.sendCapturedMessage = async submission => { captured = submission; await gate.promise; };
        const sending = app.sendMessage();
        await assert.rejects(app.changeSessionBackend('ticket'), /finish sending/);
        app.inferenceService.setDefaultBackendId('ticket');
        assert.equal(captured.inferenceBackend, 'paid');
        gate.resolve();
        await sending;
    });

    test('per-session ticket policy keeps paid access off the ticket pricing and redemption path', async () => {
        const app = backendHarness();
        app.runtime.usesTicketAccess = session => session.inferenceBackend === 'ticket';
        const paid = app.getCurrentSession();
        assert.equal(app.usesTicketAccess(paid), false);
        assert.equal(app.usesTicketAccess(app.state.sessionsById.get('two')), true);
        let checked;
        app.runtime.checkCanSend = async args => { checked = args.session; return true; };
        assert.equal(await app.preflightTurnTicketBudget(paid, 'prompt'), true);
        assert.equal(checked, paid);
        app.runtime.acquireAccess = async () => ({ token: 'paid-key' });
        chatDB.saveSession = async () => {};
        assert.equal(await app.acquireAndSetAccess(paid), 'paid-key');
        assert.equal(paid.inferenceBackend, 'paid');
        delete app.runtime.checkCanSend;
        await assert.rejects(app.preflightTurnTicketBudget(paid, 'prompt'), /not configured/);
    });

    test('model refresh cannot replace the catalog after navigation to another backend', async () => {
        const app = backendHarness();
        const gate = deferred();
        app.inferenceService.fetchModels = () => gate.promise;
        app.filterDisabledModels = models => models;
        app.state.models = [{ id: 'current' }];
        const refresh = app.loadModels();
        app.state.currentSessionId = 'two';
        gate.resolve([{ id: 'stale-paid-model' }]);
        await refresh;
        assert.deepEqual(app.state.models, [{ id: 'current' }]);
        assert.equal(app.state.modelsLoading, false);
    });

    test('all configured verifier caches initialize even when paid is the new-chat default', async () => {
        const app = backendHarness();
        const calls = [];
        const verifier = { supports: true, init: async () => { calls.push('init'); },
            setBannedWarningCallback() {}, startBroadcastCheck() { calls.push('broadcast'); } };
        app.inferenceService.getBackend('ticket').verification = verifier;
        app.inferenceService.setDefaultBackendId('paid');
        await app.initVerifier();
        await app.initVerifier({ inferenceBackend: 'ticket' });
        assert.deepEqual(calls, ['init', 'broadcast']);
    });

    test('ticket key request reserves its captured session across animations and navigation', async t => {
        t.mock.timers.enable({ apis: ['setTimeout'] });
        const app = backendHarness();
        const session = app.getCurrentSession();
        session.inferenceBackend = 'ticket';
        const panel = Object.assign(Object.create(RightPanel.prototype), {
            app, currentSession: session, currentTicket: {},
            renderTopSectionOnly() {}, loadNextTicket() {}, startExpirationTimer() {}, updateStatusIndicator() {}
        });
        app.services = { inference: app.inferenceService };
        let acquired;
        app.acquireAndSetAccess = async target => { acquired = target; target.apiKey = 'new-ticket-key'; };
        const requesting = panel.handleRequestApiKey();
        assert.equal(app.isSessionBusy('one'), true);
        await assert.rejects(app.changeSessionBackend('paid'), /current chat action/);
        app.state.currentSessionId = 'two';
        panel.currentSession = app.getCurrentSession();
        panel.apiKey = 'chat-two-key';
        t.mock.timers.tick(500);
        await Promise.resolve();
        t.mock.timers.tick(1000);
        await requesting;
        assert.equal(acquired, session);
        assert.equal(session.apiKey, 'new-ticket-key');
        assert.equal(panel.apiKey, 'chat-two-key');
        assert.equal(app.isSessionBusy('one'), false);
    });

    test('backend navigation immediately replaces the prior model catalog while fetching current data', async () => {
        const app = backendHarness();
        app.state.modelsBackendId = 'paid';
        app.state.models = [{ id: 'paid-model' }];
        app.state.currentSessionId = 'two';
        const fresh = deferred();
        app.inferenceService.getBackend('ticket').getCachedModels = () => [{ id: 'ticket-cached' }];
        app.inferenceService.getBackend('ticket').fetchModels = () => fresh.promise;
        app.filterDisabledModels = models => models;
        app.renderCurrentModel = () => {};
        const refreshing = app.refreshModelsForSessionBackend();
        assert.deepEqual(app.state.models, [{ id: 'ticket-cached' }]);
        assert.equal(app.state.modelsBackendId, 'ticket');
        fresh.resolve([{ id: 'ticket-fresh' }]);
        await refreshing;
        assert.deepEqual(app.state.models, [{ id: 'ticket-fresh' }]);
    });

    test('backend settlement serializes rename, star and model changes without overwriting metadata', async () => {
        const app = backendHarness();
        const session = app.getCurrentSession();
        Object.assign(session, { title: 'Original title', starred: true });
        app.state.sessions = [session];
        app.acknowledgeSessionMutationBusy = async () => {};
        const settlement = deferred();
        app.runtime.beforeBackendChange = () => settlement.promise;
        chatDB.saveSession = async () => {};
        const switching = app.changeSessionBackend('ticket');
        await Promise.resolve();
        assert.equal(await app.updateSessionTitle('one', 'Concurrent title'), false);
        assert.equal(await app.toggleSessionStar('one'), false);
        const picker = createModelPickerInterface(app, { chatDBImpl: {
            saveSetting: () => assert.fail('A blocked model change must not persist preferences'),
            saveSession: () => assert.fail('A blocked model change must not overwrite the session')
        } });
        assert.equal((await picker.actions.selectModel('Concurrent model')).busy, true);
        settlement.resolve();
        await switching;
        assert.equal(session.title, 'Original title');
        assert.equal(session.starred, true);
        assert.equal(session.model, 'Model one');
    });

    test('a deferred key acquisition and response retain their backend model after navigation', async () => {
        let streamed;
        const { app } = streamHarness(async (...args) => { streamed = args; return { totalTokens: 1 }; });
        const session = app.getCurrentSession();
        session.inferenceBackend = 'ticket';
        app.features = { tickets: false };
        app.state.modelsBackendId = 'ticket';
        app.modelCatalogsByBackend = new Map([['ticket', app.state.models]]);
        app.state.sessionsById.get('two').inferenceBackend = 'paid';
        app.inferenceService.getDefaultBackendId = () => 'ticket';
        app.inferenceService.getAccessToken = target => target.apiKey || null;
        app.inferenceService.setAccessInfo = (target, info) => { target.apiKey = info.token; };
        app.inferenceService.getCachedModels = () => [];
        const entered = deferred();
        const acquisition = deferred();
        let accessModels;
        app.runtime.acquireAccess = async ({ models }) => {
            accessModels = models;
            entered.resolve();
            await acquisition.promise;
            return { token: 'ticket-key' };
        };
        const sending = app.sendMessage();
        await entered.promise;
        app.state.currentSessionId = 'two';
        app.state.modelsBackendId = 'paid';
        app.state.models = [{ id: 'paid-model', name: 'Paid model' }];
        acquisition.resolve();
        await sending;
        assert.equal(accessModels[0].id, 'accepted-model');
        assert.equal(streamed[1], 'accepted-model');
        assert.equal(streamed[2], session);
        assert.equal(session.model, 'Accepted model');
    });

    test('a dual runtime can preserve ticket streaming on New Chat while retiring paid work', async () => {
        const app = backendHarness();
        const canceled = [];
        const notified = [];
        app.runtime.onNewChat = ({ sessionId }) => notified.push(sessionId);
        app.runtime.shouldCancelOnNewChat = ({ session }) => session?.inferenceBackend === 'paid';
        app.cancelSessionWork = async id => canceled.push(id);
        app.clearCurrentSession = async () => {};
        app.isMobileView = () => false;
        app.state.currentSessionId = 'two';
        await app.handleNewChatRequest();
        assert.deepEqual(canceled, []);
        app.state.currentSessionId = 'one';
        await app.handleNewChatRequest();
        assert.deepEqual(canceled, ['one']);
        assert.deepEqual(notified, ['two', 'one']);
    });

    test('composer announcements reuse one screen-reader-only status node', () => {
        const nodes = [];
        document.getElementById = id => nodes.find(node => node.id === id) || null;
        document.createElement = tagName => ({
            tagName, attributes: {},
            setAttribute(name, value) { this.attributes[name] = value; }
        });
        const app = { elements: { inputCard: { append: node => nodes.push(node) } } };

        ChatApp.prototype.announceChatOperation.call(app, 'Message accepted.');
        const status = nodes[0];
        assert.equal(status.textContent, 'Message accepted.');
        ChatApp.prototype.announceChatOperation.call(app, 'Response complete.');

        assert.equal(nodes.length, 1);
        assert.equal(nodes[0], status);
        assert.equal(status.id, 'chat-operation-status');
        assert.equal(status.tagName, 'span');
        assert.equal(status.className, 'sr-only');
        assert.equal(status.attributes.role, 'status');
        assert.equal(status.attributes['aria-hidden'], undefined);
        assert.equal(status.attributes.hidden, undefined);
        assert.equal(status.textContent, 'Response complete.');
    });

    test('Send captures composer state before awaits and deduplicates only its owned session', async () => {
        const app = appHarness();
        const gate = deferred();
        const submissions = [];
        const firstFile = { name: 'original.txt' };
        app.uploadedFiles = [firstFile];
        app.memoryMode = true;
        app.sendCapturedMessage = async submission => { submissions.push(submission); await gate.promise; };
        const first = app.sendMessage();
        app.elements.messageInput.value = 'New draft';
        app.reasoningEffort = 'low';
        app.memoryMode = false;
        app.memoryFeatureEnabled = false;
        app.uploadedFiles.push({ name: 'later.txt' });
        await app.sendMessage();
        assert.equal(submissions.length, 1);
        assert.equal(submissions[0].rawContent, 'Original prompt');
        assert.equal(submissions[0].reasoningEffort, 'high');
        assert.equal(submissions[0].memoryMode, true);
        assert.equal(submissions[0].memoryFeatureEnabled, true);
        assert.deepEqual(submissions[0].files, [firstFile]);
        app.state.currentSessionId = 'two';
        const second = app.sendMessage();
        assert.equal(submissions.length, 2);
        assert.equal(submissions[1].sessionId, 'two');
        gate.resolve();
        await Promise.all([first, second]);
        assert.equal(app.sendSubmissionsInFlight.size, 0);
    });

    test('database delay cannot redirect an existing-chat Send to the newly selected chat', async () => {
        const app = appHarness();
        const gate = deferred();
        let checkedSession;
        app.ensureDatabaseReady = () => gate.promise;
        app.inferenceService = { getVerificationAdapter: () => ({ supports: false }), getAccessInfo: () => null };
        app.preflightTurnTicketBudget = async session => { checkedSession = session.id; return false; };
        const sending = app.sendMessage();
        app.state.currentSessionId = 'two';
        gate.resolve(true);
        await sending;
        assert.equal(checkedSession, 'one');
        assert.equal(app.getBannedAccessWarning(app.state.sessionsById.get('one')), null);
    });

    test('New Chat on an empty composer does not start an all-session cancellation loop', async () => {
        const app = appHarness();
        app.state.currentSessionId = null;
        app.runtime.onNewChat = () => {};
        const canceled = [];
        app.cancelSessionWork = async id => canceled.push(id);
        app.clearCurrentSession = async () => {};
        app.isMobileView = () => false;
        await app.handleNewChatRequest();
        assert.deepEqual(canceled, []);
    });

    test('an exclusive timeline mutation blocks Send before any asynchronous work', async () => {
        const app = appHarness();
        const token = app.beginSessionMutation('one', { exclusive: true });
        assert.ok(token);
        let sends = 0;
        app.sendCapturedMessage = async () => { sends += 1; };
        await app.sendMessage();
        assert.equal(sends, 0);
        assert.equal(app.beginSessionMutation('one', { exclusive: true }), null);
        app.endSessionMutation('one', token);
        await app.sendMessage();
        assert.equal(sends, 1);
    });

    test('timeline actions may interrupt a live stream but cannot compete with another reservation', () => {
        const app = appHarness();
        app.sessionStreamingStates.set('one', { isStreaming: true, abortController: new AbortController() });
        assert.equal(app.beginSessionMutation('one', { exclusive: true }), null);
        const token = app.beginSessionMutation('one', { exclusive: true, interruptStreaming: true });
        assert.ok(token);
        assert.equal(app.beginSessionMutation('one', { exclusive: true, interruptStreaming: true }), null);
        assert.equal(app.beginSessionMutation('one'), null);
        app.endSessionMutation('one', token);
        assert.ok(app.beginSessionMutation('one', { exclusive: true, interruptStreaming: true }));
    });

    test('stopping a session drains a pending Send before its stream has mounted', async () => {
        const app = appHarness();
        let signal;
        app.sendCapturedMessage = async submission => {
            signal = submission.controller.signal;
            await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
        };
        const sending = app.sendMessage();
        assert.equal(app.getSessionStreamingState('one').isStreaming, false);
        const stopped = app.stopSessionStreamingAndWait('one');
        assert.equal(signal.aborted, true);
        assert.equal(await stopped, true);
        await sending;
        assert.equal(app.sendSubmissionsInFlight.size, 0);
    });

    test('deletion draining waits for in-flight timeline reservations to release', async () => {
        const app = appHarness();
        const token = app.beginSessionMutation('one', { exclusive: true });
        let drained = false;
        const draining = app.cancelSessionWork('one', { waitForMutations: true }).then(() => { drained = true; });
        await Promise.resolve();
        assert.equal(drained, false);
        app.endSessionMutation('one', token);
        await draining;
        assert.equal(drained, true);
    });

    test('deleting history blocks a blank-composer Send before it creates another session', async () => {
        const app = appHarness();
        app.state.currentSessionId = null;
        app.historyDeletionInProgress = true;
        let sends = 0;
        app.sendCapturedMessage = async () => { sends += 1; };
        await app.sendMessage();
        assert.equal(sends, 0);
        assert.equal(app.sendSubmissionsInFlight.size, 0);
    });

    test('accepting an earlier draft preserves later text/files and passes captured Memory intent to preflight', async () => {
        const app = appHarness();
        const writing = deferred();
        const entered = deferred();
        const initialFile = { name: 'initial.txt' };
        const laterFile = { name: 'later.txt' };
        app.uploadedFiles = [initialFile];
        app.memoryMode = true;
        app.ensureDatabaseReady = async () => true;
        app.inferenceService = { getVerificationAdapter: () => ({ supports: false }), getAccessInfo: () => null };
        let preflight;
        app.preflightTurnTicketBudget = async (_session, _content, options) => { preflight = options; return true; };
        app.activateCouncilLayoutForSubmittedTurn = async () => {};
        app.reserveAccessAcquisitionHandoff = () => {};
        app.resolvePendingPhaseForSession = () => 'requesting-key';
        app.setSessionStreamingState = () => {};
        app.buildMessageFileMetadata = async files => files;
        app.addMessage = async (_role, _content, metadata) => {
            entered.resolve(); await writing.promise;
            const message = { id: 'accepted', metadata };
            metadata.onPersisted?.(message);
            return message;
        };
        app.ensureMessageFileMetadata = async () => [];
        app.renderFilePreviews = app.updateFileCountBadge = app.resetMessageInputLayout = app.startPromptSlideUpEffect = () => {};
        app.buildConversationText = () => '';
        chatDB.getSessionMessages = async () => [];
        let memoryOptions;
        app.runMemoryAugmentFlow = async (_content, _message, _session, options) => {
            memoryOptions = options;
            throw Object.assign(new Error('Stop after acceptance'), { isCancelled: true });
        };
        app.updateScrollButtonVisibility = () => {};
        const sending = app.sendMessage();
        await entered.promise;
        app.elements.messageInput.value = 'Later draft';
        app.uploadedFiles.push(laterFile);
        app.memoryMode = false;
        writing.resolve();
        await sending;
        assert.equal(app.elements.messageInput.value, 'Later draft');
        assert.deepEqual(app.uploadedFiles, [laterFile]);
        assert.equal(preflight.memoryMode, true);
        assert.equal(memoryOptions.memoryMode, true);
        assert.equal(memoryOptions.memoryFeatureEnabled, true);
    });

    test('session creation cannot restore an old URL after navigation during settings persistence', async () => {
        const app = appHarness();
        const saving = deferred();
        const entered = deferred();
        const urls = [];
        app.ensureDatabaseReady = async () => true;
        app.normalizeModelName = value => value;
        app.upgradeDefaultModelPreference = value => value;
        app.buildPersistedParallelCouncilConfig = () => ({ enabled: false });
        app.inferenceService = { getDefaultBackendId: () => 'test' };
        app.generateId = () => 'created-session';
        app.chatInput = { updateSearchToggleUI() {}, updateMemoryToggleUI() {} };
        app.updateUrlWithSession = id => urls.push(id);
        app.hideScrollToBottomButton = () => {};
        app.renderSessions = app.renderMessages = app.renderCurrentModel = app.updateShareButtonUI = () => {};
        chatDB.getSetting = async () => 'Model one';
        chatDB.saveSession = async () => {};
        chatDB.saveSetting = async () => { entered.resolve(); await saving.promise; };
        const creating = app.createSession();
        await entered.promise;
        app.state.currentSessionId = 'two';
        app.sessionNavigationGeneration += 1;
        saving.resolve();
        await creating;
        assert.deepEqual(urls, []);
    });

    test('title jobs are owned before asynchronous reads and deduplicate while canceling cleanly', async () => {
        const app = appHarness();
        const gate = deferred();
        let calls = 0;
        let signal;
        app.generateSessionTitleForJob = async (_id, _message, options) => {
            calls += 1;
            signal = options.signal;
            await gate.promise;
        };
        const first = app.generateSessionTitleIfNeeded('one', 'message');
        const second = app.generateSessionTitleIfNeeded('one', 'message');
        assert.equal(calls, 1);
        assert.equal(app.titleGenerationJobs.size, 1);
        const cancellation = app.cancelSessionWork('one');
        assert.equal(signal.aborted, true);
        gate.resolve();
        await Promise.all([first, second, cancellation]);
        assert.equal(app.titleGenerationJobs.size, 0);
    });

    test('an older session load cannot override a newer navigation intent with the same previous chat', async () => {
        const app = appHarness();
        const loading = deferred();
        app.ensureSessionLoaded = () => loading.promise;
        const switching = app.switchSession('two');
        app.sessionNavigationGeneration += 1;
        loading.resolve();
        await switching;
        assert.equal(app.state.currentSessionId, 'one');
    });

    test('A to B to A navigation cancels the stale load and Send waits for the selected transcript', async () => {
        const app = appHarness();
        const loading = deferred();
        app.ensureSessionLoaded = () => loading.promise;
        const staleB = app.switchSession('two');
        assert.equal(app.sessionSwitchInFlight.targetSessionId, 'two');
        await app.switchSession('one');
        assert.equal(app.sessionSwitchInFlight, null);
        loading.resolve();
        await staleB;
        assert.equal(app.state.currentSessionId, 'one');

        const rendering = deferred();
        const entered = deferred();
        app.ensureSessionLoaded = async () => {};
        app.saveCurrentSessionScrollPosition = app.saveChatbarStateForSession = () => {};
        app.editDrafts = new Map();
        app.inferenceService = { getCachedModels: () => [] };
        app.chatInput = { updateSearchToggleUI() {} };
        app.updateUrlWithSession = app.hideScrollToBottomButton = app.renderSessions = app.renderCurrentModel = () => {};
        app.resetMessageInputLayout = app.restoreChatbarStateForSession = app.updateShareButtonUI = () => {};
        app.isMobileView = () => false;
        chatDB.saveSetting = async () => {};
        app.renderMessages = async () => { entered.resolve(); await rendering.promise; };
        let sent = false;
        app.sendCapturedMessage = async () => { sent = true; };
        const switching = app.switchSession('two');
        await entered.promise;
        await app.sendMessage();
        assert.equal(sent, false);
        assert.equal(app.sessionSwitchInFlight.targetSessionId, 'two');
        rendering.resolve();
        await switching;
        assert.equal(app.sessionSwitchInFlight, null);
        await app.sendMessage();
        assert.equal(sent, true);
    });

    test('clearing a chat resets immediately but cannot overwrite navigation after settings normalization', async () => {
        const app = appHarness();
        const saving = deferred();
        const entered = deferred();
        app.saveChatbarStateForSession = app.saveCurrentSessionScrollPosition = app.updateUrlWithSession = () => {};
        app.resetMessageInputLayout = () => {};
        app.applyChatbarState = () => { app.elements.messageInput.value = ''; };
        app.normalizeModelName = value => value;
        app.upgradeDefaultModelPreference = () => 'Upgraded model';
        chatDB.getSetting = async () => 'Old model';
        chatDB.saveSetting = async () => { entered.resolve(); await saving.promise; };
        const clearing = app.clearCurrentSession();
        assert.equal(app.state.currentSessionId, null);
        assert.equal(app.elements.messageInput.value, '');
        app.elements.messageInput.value = 'Brand new draft';
        await entered.promise;
        app.state.currentSessionId = 'two';
        app.sessionNavigationGeneration += 1;
        app.state.pendingModelName = 'Destination model';
        saving.resolve();
        await clearing;
        assert.equal(app.state.pendingModelName, 'Destination model');
        assert.equal(app.elements.messageInput.value, 'Brand new draft');
    });

    test('actual title generation attributes provider usage to its original session and a distinct request', async () => {
        const app = appHarness();
        const session = app.state.sessionsById.get('one');
        Object.assign(session, { title: 'Local title', titleSource: 'local', titleGenerationPending: true });
        const updates = [];
        chatDB.getSessionMessages = async () => [{ id: 'prompt-one', role: 'user', content: 'Explain HTTPS' }];
        chatDB.saveSession = async () => {};
        app.getMessageTextContent = text => text;
        app.cleanGeneratedSessionTitle = title => title;
        app.renderSessions = () => {};
        app.runtime.recordUsage = async data => updates.push(data);
        app.inferenceService = { getAccessToken: () => 'key', isAccessExpired: () => false,
            generateSessionTitle: async (accessSession, _prompt, options) => {
                assert.equal(accessSession, session);
                assert.ok(options.signal);
                app.state.currentSessionId = 'two';
                await options.onUsage({ model: 'cheap-title-model', promptTokens: 15, completionTokens: 3 });
                return 'HTTPS explained';
            } };
        await app.generateSessionTitleIfNeeded('one', 'prompt-one');
        assert.equal(session.title, 'HTTPS explained');
        assert.deepEqual(updates.map(update => [update.sessionId, update.requestId, update.kind, update.usage.model]),
            [['one', 'title-prompt-one', 'title', 'cheap-title-model']]);
    });

    test('actual Quick Ask waits for the runtime barrier and records separate owned usage', async () => {
        const app = appHarness();
        const barrier = deferred();
        const entered = deferred();
        const updates = [];
        let acquisitions = 0;
        let requests = 0;
        let requestNumber = 0;
        app.generateId = () => `quick-${++requestNumber}`;
        app.resolveModelForQuickAsk = async () => ({ modelId: 'instant-model', modelName: 'Instant' });
        app.runtime.prepareTurn = async options => { assert.equal(options.sessionId, 'one'); entered.resolve(); await barrier.promise; };
        app.ensureQuickAskAccess = async session => { acquisitions += 1; return session; };
        app.getQuickAskConversationMessages = messages => messages;
        app.sanitizeMessagesForApi = app.processMessagesWithFiles = messages => messages;
        app.normalizeModelName = value => value;
        app.runtime.recordUsage = async data => updates.push(data);
        chatDB.getSessionMessages = async id => { assert.equal(id, 'one'); return [{ role: 'user', content: 'Explain HTTPS' }]; };
        app.inferenceService = {
            getDisplayName: () => 'Instant',
            streamCompletion: async (...args) => {
                requests += 1;
                assert.equal(args[2].id, 'one');
                assert.equal(args[0][0].content, 'Explain HTTPS');
                await args[3]('It encrypts the connection.');
                return { model: 'instant-model', promptTokens: 20, completionTokens: 8, totalTokens: 28 };
            }
        };
        const first = app.inlineQuickAsk('HTTPS');
        await entered.promise;
        app.state.currentSessionId = 'two';
        assert.equal(acquisitions, 0);
        assert.equal(requests, 0);
        barrier.resolve();
        assert.equal((await first).content, 'It encrypts the connection.');
        app.state.currentSessionId = 'one';
        await app.inlineQuickAsk('Encryption');
        assert.deepEqual(updates.map(update => [update.sessionId, update.requestId, update.kind]),
            [['one', 'quick-1', 'quick-ask'], ['one', 'quick-2', 'quick-ask']]);
    });

    test('message render invokes captured-session recovery without blocking the visible transcript', async () => {
        const app = appHarness();
        const reading = deferred();
        const recovered = deferred();
        const session = app.state.sessionsById.get('one');
        app.chatArea = { render: async () => {} };
        app.updateWideModeButtonVisibility = () => {};
        chatDB.getSessionMessages = () => reading.promise;
        app.runtime.restoreSession = async (owner, messages) => { recovered.resolve({ owner, messages }); };
        await app.renderMessages();
        app.state.currentSessionId = 'two';
        reading.resolve([{ id: 'history' }]);
        assert.deepEqual(await recovered.promise, { owner: session, messages: [{ id: 'history' }] });
    });

    test('late history recovery cannot call the runtime for a deleted session', async () => {
        const app = appHarness();
        const reading = deferred();
        chatDB.getSessionMessages = () => reading.promise;
        let recovered = false;
        app.runtime.restoreSession = () => { recovered = true; };
        const recovery = app.restoreRuntimeSession(app.state.sessionsById.get('one'));
        app.state.sessionsById.delete('one');
        reading.resolve([]);
        await recovery;
        assert.equal(recovered, false);
    });

    test('Quick Ask acquires session ownership before model lookup and receives an owned abort signal', async () => {
        const app = appHarness();
        const gate = deferred();
        let captured;
        app.performInlineQuickAsk = async (_text, options) => { captured = options; await gate.promise; };
        const quickAsk = app.inlineQuickAsk('Selected phrase');
        assert.equal(app.quickAskJobs.get('one').size, 1);
        app.state.currentSessionId = 'two';
        const cancellation = app.cancelSessionWork('one');
        assert.equal(captured.sessionId, 'one');
        assert.equal(captured.abortController.signal.aborted, true);
        gate.resolve();
        await Promise.all([quickAsk, cancellation]);
        assert.equal(app.quickAskJobs.size, 0);
    });

    test('finishing one session removes only its own pending placeholder and progress', () => {
        const app = appHarness();
        const removed = [];
        app.pendingProgress = new Map([['one', { phase: 'working' }], ['two', { phase: 'working' }]]);
        app.elements.messagesContainer = { querySelectorAll: () => ['one', 'two'].map(id => ({
            dataset: { sessionId: id }, remove: () => removed.push(id)
        })) };
        app.flushPendingStorageRefresh = () => {};
        app.setSessionStreamingState('one', false);
        assert.deepEqual(removed, ['one']);
        assert.equal(app.pendingProgress.has('one'), false);
        assert.equal(app.pendingProgress.has('two'), true);
    });

    test('preparation errors are attached to the captured chat and cancellation adds no error bubble', async () => {
        const app = appHarness();
        const added = [];
        app.runtime.prepareTurn = async () => { throw new Error('Could not settle'); };
        app.addMessage = async (_role, _text, metadata, session) => added.push({ metadata, session });
        const owner = app.state.sessionsById.get('one');
        app.state.currentSessionId = 'two';
        await assert.rejects(app.prepareRuntimeTurn(owner, new AbortController().signal), /Could not settle/);
        assert.equal(added[0].session, owner);
        assert.equal(added[0].metadata.isLocalOnly, true);
        const controller = new AbortController();
        controller.abort();
        await assert.rejects(app.prepareRuntimeTurn(owner, controller.signal), error => error.name === 'AbortError' || error.isCancelled);
        assert.equal(added.length, 1);
    });

    test('a captured-session message is not appended to another chat after a database delay', async () => {
        const app = appHarness();
        const gate = deferred();
        const appended = [];
        chatDB.saveSessionWithMessages = async () => gate.promise;
        chatDB.getSessionMessages = async () => [];
        chatDB.saveSession = async () => {};
        app.generateId = () => 'owned-message';
        app.applySessionConversationSearchText = () => {};
        app.renderSessions = () => {};
        app.chatArea = { appendMessage: async message => appended.push(message) };
        const owner = app.state.sessionsById.get('one');
        const saving = app.addMessage('assistant', 'Owned status', { isLocalOnly: true }, owner);
        app.state.currentSessionId = 'two';
        gate.resolve();
        const message = await saving;
        assert.equal(message.sessionId, 'one');
        assert.deepEqual(appended, []);
    });

    test('successful streaming remains successful when final usage persistence fails', async () => {
        const app = appHarness();
        const result = { completionTokens: 5, promptTokens: 10 };
        app.runtime.recordUsage = async options => { if (options.final !== false) throw new Error('Storage temporarily unavailable'); };
        app.inferenceService = { streamCompletion: async (...args) => { await args[4](result); return result; } };
        assert.equal(await app.streamCompletionWithRuntime([], 'model', { id: 'one' }, () => {}, () => {},
            [], false, new AbortController(), null, null, true, 'high', 'message'), result);
    });

    test('an opaque session binding remains securing until the backend reports real transport access', () => {
        const app = appHarness();
        let ready = false;
        app.inferenceService = { isTransportAccessReady: () => ready };
        const phases = [];
        app.updateSessionStreamingPhase = (_id, phase) => phases.push(phase);
        app.updateTypingIndicator = () => {};
        assert.equal(app.advancePendingStateAfterAccessGranted('one'), 'requesting-key');
        ready = true;
        assert.equal(app.advancePendingStateAfterAccessGranted('one'), 'waiting-response');
        assert.deepEqual(phases, ['requesting-key', 'waiting-response']);
    });

    test('credit refresh keeps the owned signal/settings and cannot repaint a different selected chat', async () => {
        const app = appHarness();
        const controller = new AbortController();
        const session = app.state.sessionsById.get('one');
        app.state.currentSessionId = 'two';
        app.inferenceService = { getAccessLabel: () => 'access', clearAccessInfo() {} };
        app.updateSessionStreamingPhase = () => {};
        app.rightPanel = { onSessionChange: () => assert.fail('Background access must not replace the visible chat panel') };
        chatDB.saveSession = async () => {};
        let acquired;
        app.acquireAndSetAccess = async (_session, options) => { acquired = options; };
        await app.refreshAccessAfterCreditExhaustion(session, { signal: controller.signal,
            modelNameOverride: 'Accepted model', reasoningEnabled: false });
        assert.equal(acquired.signal, controller.signal);
        assert.equal(acquired.modelNameOverride, 'Accepted model');
        assert.equal(acquired.reasoningEnabled, false);
        acquired = null;
        chatDB.saveSession = async () => { controller.abort(); };
        await assert.rejects(app.refreshAccessAfterCreditExhaustion(session, { signal: controller.signal }),
            error => error.isCancelled || error.name === 'AbortError');
        assert.equal(acquired, null, 'canceled replacement must not issue another key');
    });

    for (const action of ['send', 'retry']) {
        for (const payload of ['image-cancel', 'text-reasoning-error']) {
            test(`${action} persists ${payload} partial output without replacing it with an error`, async () => {
                const failure = payload === 'image-cancel'
                    ? Object.assign(new Error('Canceled by user'), { isCancelled: true })
                    : Object.assign(new Error('Provider failed mid-stream'), { status: 400 });
                const { app, records } = streamHarness(async (...args) => {
                    if (payload === 'image-cancel') await args[3]('', { images: [{ image_url: { url: 'data:image/png;base64,test' } }] });
                    else { await args[3]('Partial answer'); await args[9]('Partial reasoning'); }
                    throw failure;
                });
                if (action === 'retry') {
                    records.set('accepted', { id: 'accepted', role: 'user', content: 'Earlier prompt', model: 'Accepted model', memoryMode: false });
                    await app.regenerateResponse();
                } else await app.sendMessage();
                const assistant = [...records.values()].find(message => message.role === 'assistant');
                assert.ok(assistant, 'partial provider output must remain in durable history');
                assert.equal(assistant.streamingPending, false);
                assert.equal(assistant.streamingPhase, null);
                assert.equal(assistant.isLocalOnly, false);
                if (payload === 'image-cancel') assert.equal(assistant.images.length, 1);
                else { assert.equal(assistant.content, 'Partial answer'); assert.equal(assistant.reasoning, 'Partial reasoning'); }
                assert.equal(app.regenerationJobs.size, 0);
                assert.equal(app.sendSubmissionsInFlight.size, 0);
            });
        }
    }

    test('Retry uses accepted model/search/Memory/reasoning and prepares recoverable files before inference', async () => {
        let streamed;
        const { app, records } = streamHarness(async (...args) => { streamed = args; return { totalTokens: 1 }; });
        const fileGate = deferred();
        const fileEntered = deferred();
        app.state.sessionsById.get('one').model = 'Later model';
        app.searchEnabled = false;
        app.reasoningEnabled = true;
        app.reasoningEffort = 'high';
        app.memoryMode = true;
        records.set('accepted', { id: 'accepted', role: 'user', content: 'Earlier prompt', model: 'Accepted model',
            searchEnabled: true, memoryMode: false, reasoningEnabled: false, reasoningEffort: 'low',
            pendingFileObjects: [{ name: 'recovery.txt' }] });
        app.ensureMessageFileMetadata = async message => {
            fileEntered.resolve(); await fileGate.promise;
            delete message.pendingFileObjects;
            message.files = [{ name: 'recovery.txt', content: 'File content' }];
            await chatDB.saveMessage(message);
        };
        app.runMemoryAugmentFlow = async () => assert.fail('The accepted prompt had Memory disabled');
        let preflight;
        app.preflightTurnTicketBudget = async (_session, _content, options) => { preflight = options; return true; };
        const retrying = app.regenerateResponse();
        await fileEntered.promise;
        assert.equal(streamed, undefined);
        fileGate.resolve();
        await retrying;
        assert.equal(streamed[1], 'accepted-model');
        assert.equal(streamed[6], true);
        assert.equal(streamed[10], false);
        assert.equal(streamed[11], 'low');
        assert.equal(preflight.memoryMode, false);
        assert.equal(preflight.modelName, 'Accepted model');
        assert.equal(streamed[0][0].files[0].name, 'recovery.txt');
    });

    test('an initial prompt estimate is not committed as usage when HTTP fails before provider output', async () => {
        const app = appHarness();
        const updates = [];
        const discarded = [];
        const failure = Object.assign(new Error('Credit unavailable'), { status: 402 });
        app.runtime.recordUsage = async options => updates.push(options);
        app.runtime.discardUsagePreview = options => discarded.push(options);
        app.inferenceService = { streamCompletion: async (...args) => {
            await args[4]({ promptTokens: 200, completionTokens: 0, estimated: true, isStreaming: true });
            throw failure;
        } };
        await assert.rejects(app.streamCompletionWithRuntime([], 'model', { id: 'one' }, () => {}, () => {},
            [], false, new AbortController(), null, null, true, 'high', 'failed-request'), error => error === failure);
        assert.equal(updates.filter(update => update.final !== false).length, 0);
        assert.deepEqual(discarded, [{ sessionId: 'one', requestId: 'failed-request' }]);
    });

    test('cancellation is not replaced by a usage-persistence error', async () => {
        const app = appHarness();
        const cancellation = Object.assign(new Error('Canceled by user'), { name: 'AbortError', isCancelled: true });
        app.runtime.recordUsage = async options => { if (options.final !== false) throw new Error('Storage temporarily unavailable'); };
        app.inferenceService = { streamCompletion: async (...args) => {
            await args[4]({ completionTokens: 1 });
            throw cancellation;
        } };
        await assert.rejects(app.streamCompletionWithRuntime([], 'model', { id: 'one' }, () => {}, () => {},
            [], false, new AbortController(), null, null, true, 'high', 'message'), error => error === cancellation);
    });

    test('a canceled partial response still persists its latest usage estimate', async () => {
        const app = appHarness();
        const updates = [];
        const cancellation = Object.assign(new Error('Canceled'), { name: 'AbortError', isCancelled: true });
        app.runtime.recordUsage = async data => updates.push(data);
        app.inferenceService = { streamCompletion: async (...args) => {
            await args[3]('Partial response');
            await args[4]({ promptTokens: 100, completionTokens: 4, estimated: true, isStreaming: true });
            throw cancellation;
        } };
        await assert.rejects(app.streamCompletionWithRuntime([], 'model', { id: 'one' }, null, null,
            [], false, new AbortController(), null, null, true, 'high', 'partial'), error => error === cancellation);
        assert.equal(updates.filter(update => update.final !== false).length, 1);
        assert.equal(updates.at(-1).usage.completionTokens, 4);
    });

    test('authoritative provider usage persists even if canceled before a visible chunk', async () => {
        const app = appHarness();
        const updates = [];
        const cancellation = Object.assign(new Error('Canceled'), { name: 'AbortError', isCancelled: true });
        app.runtime.recordUsage = async data => updates.push(data);
        app.inferenceService = { streamCompletion: async (...args) => {
            await args[4]({ promptTokens: 100, completionTokens: 0, cost: 0.001, isStreaming: false });
            throw cancellation;
        } };
        await assert.rejects(app.streamCompletionWithRuntime([], 'model', { id: 'one' }, null, null,
            [], false, new AbortController(), null, null, true, 'high', 'charged'), error => error === cancellation);
        assert.equal(updates.filter(update => update.final !== false).length, 1);
        assert.equal(updates.at(-1).usage.cost, 0.001);
    });
});
