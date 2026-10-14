import test from 'node:test';
import assert from 'node:assert/strict';

// A reply saved mid-stream is painted from storage by any tab showing the
// chat, and by this tab whenever it re-reads the chat. Three things keep that
// paint honest: the tab writing the reply holds the session's turn lock for
// exactly as long as it writes (turnOwnership.js); a regeneration's placeholder
// is a pending turn like a send's; and the chat list reload (reloadSessions)
// never makes the chat being written in unresolvable, which read as "not this
// tab's reply" and painted it as interrupted.

function installBrowser(extra = {}) {
    const keys = ['window', 'location', 'localStorage', 'sessionStorage', 'document', 'fetch', 'requestAnimationFrame', 'navigator'];
    const descriptors = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    const storage = { getItem: () => null, setItem() {}, removeItem() {} };
    const events = { addEventListener() {}, removeEventListener() {}, dispatchEvent() {} };
    const location = { href: 'http://localhost/', hostname: 'localhost', origin: 'http://localhost', search: '', pathname: '/' };
    const values = {
        window: { ...events, location, localStorage: storage, sessionStorage: storage },
        location, localStorage: storage, sessionStorage: storage,
        document: { ...events, querySelector: () => null, getElementById: () => null, activeElement: null,
            documentElement: { classList: { contains: () => false }, dataset: {} } },
        fetch: async () => { throw new Error('These controller tests must never use the network.'); },
        requestAnimationFrame: callback => callback(),
        navigator: extra.navigator || descriptors.get('navigator')?.value || {}
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
const { chatDB } = await import('../../chat/db.js');
const { turnLockName } = await import('../../chat/services/turnOwnership.js');
preferencesStore.getPreference = getPreference;
restoreImport();

function deferred() {
    let resolve;
    const promise = new Promise(value => { resolve = value; });
    return { promise, resolve };
}

// Records every Web Lock request the way a tab would see it.
function lockRecorder() {
    const held = new Map();
    const log = [];
    return {
        held, log,
        locks: {
            request(name, options, callback) {
                log.push({ name, mode: options.mode, ifAvailable: options.ifAvailable === true });
                if (held.has(name) && options.ifAvailable) return Promise.resolve().then(() => callback(null));
                held.set(name, options.mode);
                return Promise.resolve().then(() => callback({ name, mode: options.mode })).finally(() => held.delete(name));
            }
        }
    };
}

function appHarness() {
    return Object.assign(Object.create(ChatApp.prototype), {
        runtime: {},
        signInPolicy: { required: false },
        state: { currentSessionId: 'one', pendingModelName: 'Model one', models: [{ id: 'accepted-model', name: 'Accepted model' }],
            sessions: [], sessionsById: new Map([['one', { id: 'one', model: 'Accepted model' }]]) },
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
        searchEnabled: false,
        reasoningEnabled: true,
        reasoningEffort: 'high',
        memoryMode: false,
        memoryFeatureEnabled: false,
        updateInputState() {},
        showToast() {},
        clearMemoryApiOverrideContent() {},
        announceChatOperation() {}
    });
}

function streamHarness(stream) {
    const app = appHarness();
    const records = new Map();
    const paints = [];
    app.chatArea = new Proxy({}, { get: (_, name) => (...args) => { paints.push({ name, args }); return undefined; } });
    let sequence = 0;
    app.generateId = () => `message-${++sequence}`;
    app.ensureDatabaseReady = async () => true;
    app.preflightTurnTicketBudget = async () => true;
    app.activateCouncilLayoutForSubmittedTurn = async () => {};
    app.reserveAccessAcquisitionHandoff = () => {};
    app.resolvePendingPhaseForSession = () => 'waiting-response';
    app.showTypingIndicator = () => null;
    app.removeTypingIndicator = () => {};
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
    app.takeAccessTrace = () => null;
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
    const assistant = () => [...records.values()].filter(message => message.role === 'assistant');
    return { app, records, paints, assistant };
}

test('a send holds the chat\'s turn lock from the moment it streams until the reply is settled on disk', async t => {
    const recorder = lockRecorder();
    const restore = installBrowser({ navigator: { locks: recorder.locks } });
    t.after(restore);
    const opened = deferred();
    const finish = deferred();
    const { app, assistant } = streamHarness(async (...args) => {
        await args[3]('The answer');
        opened.resolve();
        await finish.promise;
        return { totalTokens: 1, completionTokens: 1 };
    });
    const turn = app.sendMessage();
    await opened.promise;
    assert.equal(recorder.held.get(turnLockName('one')), 'exclusive', 'held while the reply is being written');
    assert.deepEqual(recorder.log.map(entry => entry.ifAvailable), [true], 'asked for only if free: never waits on another tab');
    finish.resolve();
    await turn;
    assert.equal(recorder.held.has(turnLockName('one')), false, 'released once the turn settled');
    assert.equal(assistant().at(-1).content, 'The answer');
    assert.equal(assistant().at(-1).streamingTokens, null);
});

test('a regeneration\'s placeholder is a local-only pending turn until its first chunk, like a send\'s', async t => {
    const restore = installBrowser();
    t.after(restore);
    const placeholderSaved = deferred();
    const release = deferred();
    const { app, records, assistant } = streamHarness(async (...args) => {
        placeholderSaved.resolve();
        await release.promise;
        await args[3]('Regenerated answer');
        return { totalTokens: 1, completionTokens: 1 };
    });
    records.set('prompt', { id: 'prompt', sessionId: 'one', role: 'user', content: 'Prompt', model: 'Accepted model' });
    const retrying = app.regenerateResponse();
    await placeholderSaved.promise;
    const placeholder = assistant().at(-1);
    assert.equal(placeholder.streamingPending, true);
    assert.equal(placeholder.isLocalOnly, true, 'never model context, shares or memory');
    assert.equal(placeholder.pendingTurn, true, 'a reload before the first chunk shows "no reply was received" with Retry');
    release.resolve();
    await retrying;
    const settled = assistant().at(-1);
    assert.equal(settled.id, placeholder.id);
    assert.equal(settled.content, 'Regenerated answer');
    assert.equal(settled.isLocalOnly, false);
    assert.equal('pendingTurn' in settled, false);
    assert.equal(settled.streamingPending, false);
    assert.equal(settled.streamingTokens, null);
});

test('the chat being written in stays this tab\'s while the chat list reloads from storage', async t => {
    const restore = installBrowser();
    t.after(restore);
    const app = appHarness();
    const live = app.state.sessionsById.get('one');
    app.state.sessionsById.set('two', { id: 'two', model: 'Accepted model' });
    app.state.currentSessionId = 'one';
    app.sessionStreamingStates.set('one', { isStreaming: true, abortController: new AbortController(), phase: 'stream-open' });
    app.inferenceService = { ensureSessionBackend: () => {} };
    app.hasActiveSessionListCriteria = () => false;
    app.renderSessions = () => {};
    app.migrateSessionsInBackground = () => {};
    app.sanitizePersistedSessionAccess = () => {};
    app.normalizeSessionCouncilState = () => {};
    const pageRead = deferred();
    const fresh = { id: 'one', model: 'Accepted model', title: 'Renamed in another tab' };
    app.loadInitialSessions = async () => { await pageRead.promise; app.cacheSessions([fresh]); app.state.sessions = [fresh]; };
    chatDB.getSession = async id => (id === 'one' ? fresh : null);

    const reloading = app.reloadSessions();
    // Mid-reload: the page from storage has not arrived.
    assert.equal(app.getCurrentSession(), live, 'the current chat resolves to the object the turn is using');
    assert.equal(app.isCurrentSessionStreaming(), true, 'its reply still reads as this tab\'s');
    assert.equal(app.state.sessionsById.has('two'), false, 'idle chats are rebuilt from storage as before');
    pageRead.resolve();
    await reloading;
    assert.equal(app.getCurrentSession(), fresh, 'the fresh copy replaces the carried one once loaded');
    assert.equal(app.isCurrentSessionStreaming(), true);

    // A chat carried only because it was selected, that storage no longer
    // has (deleted in another tab), is dropped as before.
    app.sessionStreamingStates.set('one', { isStreaming: false });
    app.state.currentSessionId = 'gone';
    const gone = { id: 'gone', model: 'Accepted model' };
    app.state.sessionsById.set('gone', gone);
    app.loadInitialSessions = async () => { app.cacheSessions([fresh]); app.state.sessions = [fresh]; };
    await app.reloadSessions();
    assert.equal(app.state.sessionsById.has('gone'), false);
    assert.equal(app.getCurrentSession() ?? null, null);
    assert.equal(app.isCurrentSessionStreaming(), false);

    // ...unless this tab is still writing in it.
    app.state.sessionsById.set('gone', gone);
    app.sessionStreamingStates.set('gone', { isStreaming: true, abortController: new AbortController() });
    await app.reloadSessions();
    assert.equal(app.state.sessionsById.get('gone'), gone);
    assert.equal(app.isCurrentSessionStreaming(), true);
});

test('isCurrentSessionStreaming answers by chat id, so a pending send or a live reply never depends on the cached session object', () => {
    const app = appHarness();
    app.state.sessionsById = new Map();
    app.sessionStreamingStates.set('one', { isStreaming: true });
    assert.equal(app.isCurrentSessionStreaming(), true);
    app.sessionStreamingStates.set('one', { isStreaming: false });
    assert.equal(app.isCurrentSessionStreaming(), false);
    app.sendSubmissionsInFlight.set('one', { sessionId: 'one', generation: 0 });
    assert.equal(app.isCurrentSessionStreaming(), true);
    app.state.currentSessionId = null;
    assert.equal(app.isCurrentSessionStreaming(), false);
});
