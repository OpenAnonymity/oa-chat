import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

function installBrowser() {
    const keys = ['localStorage', 'sessionStorage', 'location', 'window', 'document'];
    const original = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    const storage = { getItem: () => null, setItem() {}, removeItem() {} };
    const location = { href: 'http://localhost/', origin: 'http://localhost', hostname: 'localhost', search: '', pathname: '/' };
    const values = { localStorage: storage, sessionStorage: storage, location,
        window: { location, localStorage: storage, sessionStorage: storage, addEventListener() {}, dispatchEvent() {} },
        document: { addEventListener() {}, getElementById: () => null, querySelector: () => null,
            documentElement: { classList: { contains: () => false }, dataset: {} } } };
    for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    return () => { for (const [key, descriptor] of original) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else delete globalThis[key];
    } };
}
const restoreImport = installBrowser();
const { default: preferencesStore } = await import('../../chat/services/preferencesStore.js');
const originalPreference = preferencesStore.getPreference;
preferencesStore.getPreference = async () => false;
const { ChatApp } = await import('../../chat/app.js');
const { chatDB } = await import('../../chat/db.js');
preferencesStore.getPreference = originalPreference;
restoreImport();

let database;
let restoreBrowser;
beforeEach(() => { restoreBrowser = installBrowser(); database = Object.fromEntries(['getSessionMessages', 'saveSessionWithMessages', 'saveSession', 'saveMessage', 'saveSetting', 'deleteSession', 'deleteSessionMessages', 'deleteSessionWithMessages'].map(key => [key, chatDB[key]])); });
afterEach(() => { Object.assign(chatDB, database); restoreBrowser(); });

function deferred() {
    let resolve;
    return { promise: new Promise(done => { resolve = done; }), resolve: (...args) => resolve(...args) };
}

function harness(runtime = {}) {
    const source = { id: 'source', model: 'Model', title: 'Source', apiKey: 'source-access' };
    let nextId = 0;
    const app = Object.assign(Object.create(ChatApp.prototype), {
        runtime, state: { currentSessionId: source.id, sessions: [source], sessionsById: new Map([[source.id, source]]) },
        sessionNavigationGeneration: 0, deletedSessionIds: new Set(), deletingSessionIds: new Set(),
        sessionMutationReservations: new Map(), exclusiveSessionMutationOwners: new Map(),
        sendSubmissionsInFlight: new Map(), regenerationJobs: new Map(), sessionStreamingStates: new Map(),
        messageFilePreparationInFlight: new Map(), messageFilePreparationSessions: new Map(),
        editDrafts: new Map(), searchEnabled: false,
        inferenceService: { getDefaultBackendId: () => 'example', getAccessInfo: () => ({ token: source.apiKey, info: {}, expiresAt: 999 }) },
        generateId: () => `new-${++nextId}`,
        getCurrentSession: () => source,
        buildForkSessionTitleFields: () => ({ title: 'Fork', titleSource: 'local', titleSearchText: 'fork' }),
        applySessionConversationSearchText() {}, messagesUseCouncilLayout: () => false,
        updateInputState() {}, saveChatbarStateForSession() {}, renderSessions() {}, renderMessages() {},
        renderCurrentModel() {}, resetMessageInputLayout() {}, restoreChatbarStateForSession() {},
        updateUrlWithSession() {}, isMobileView: () => false
    });
    chatDB.getSessionMessages = async () => [{ id: 'prompt', role: 'user', content: 'Explain HTTPS' },
        { id: 'answer', role: 'assistant', content: 'Uses TLS', estimatedCostUsd: 1 }];
    chatDB.saveSetting = async () => {};
    return app;
}

test('fork persists transcript atomically and keeps ordinary OA access reuse by default', async () => {
    const app = harness();
    let saved;
    chatDB.saveSessionWithMessages = async (session, messages) => { saved = { session, messages }; };
    await app.forkConversation('answer');
    assert.equal(saved.session.apiKey, 'source-access');
    assert.equal(saved.messages.length, 3);
    assert.ok(saved.messages.every(message => message.sessionId === saved.session.id));
    assert.equal(app.state.currentSessionId, saved.session.id);
    assert.equal(app.sessionMutationReservations.size, 0);
});

test('product forks can require distinct access and sanitize copied billing metadata', async () => {
    const retired = [];
    const app = harness({ reuseAccessOnFork: false,
        transformForkMessage(snapshot) { const result = { ...snapshot }; delete result.estimatedCostUsd; return result; },
        onNewChat: ({ sessionId }) => retired.push(sessionId) });
    let saved;
    chatDB.saveSessionWithMessages = async (session, messages) => { saved = { session, messages }; };
    await app.forkConversation('answer');
    assert.equal(saved.session.apiKey, null);
    assert.equal(saved.session.apiKeyInfo, null);
    assert.equal(saved.messages[1].content, 'Uses TLS');
    assert.equal(saved.messages[1].estimatedCostUsd, undefined);
    assert.deepEqual(retired, ['source']);
});

test('deletion during an atomic fork removes its result instead of resurrecting history', async () => {
    const app = harness();
    const gate = deferred();
    let saved;
    const removed = [];
    chatDB.saveSessionWithMessages = async session => { saved = session; await gate.promise; };
    chatDB.deleteSessionMessages = async id => removed.push(['messages', id]);
    chatDB.deleteSession = async id => removed.push(['session', id]);
    const forking = app.forkConversation('answer');
    await Promise.resolve();
    app.deletingSessionIds.add('source');
    gate.resolve();
    await forking;
    assert.deepEqual(removed, [['messages', saved.id], ['session', saved.id]]);
    assert.equal(app.state.sessionsById.has(saved.id), false);
    assert.equal(app.sessionMutationReservations.size, 0);
});

test('navigation during fork persistence does not steal the new composer or URL', async () => {
    const app = harness();
    const gate = deferred();
    let renders = 0;
    app.renderMessages = () => { renders++; };
    app.updateUrlWithSession = () => assert.fail('A stale fork must not change the URL');
    chatDB.saveSessionWithMessages = () => gate.promise;
    const forking = app.forkConversation('answer');
    await Promise.resolve();
    app.sessionNavigationGeneration++;
    app.state.currentSessionId = null;
    gate.resolve();
    await forking;
    assert.equal(app.state.currentSessionId, null);
    assert.equal(renders, 0);
    assert.equal(app.state.sessions.length, 2);
});

test('Fork remains available while its source response streams', async () => {
    const app = harness();
    app.sessionStreamingStates.set('source', { isStreaming: true, abortController: new AbortController() });
    let saved = false;
    chatDB.saveSessionWithMessages = async () => { saved = true; };
    await app.forkConversation('answer');
    assert.equal(saved, true);
    assert.equal(app.sessionStreamingStates.get('source').abortController.signal.aborted, false);
});

test('first committed prompt acknowledges acceptance even if later indexing fails', async () => {
    const app = harness();
    const events = [];
    chatDB.saveSessionWithMessages = async (session, messages) => {
        assert.equal(messages[0].content, 'new prompt');
        assert.equal(session.id, 'source');
        events.push('committed');
    };
    chatDB.saveSession = async () => { throw new Error('index failed'); };
    await assert.rejects(app.addMessage('user', 'new prompt', { onPersisted: () => events.push('accepted') }), /index failed/);
    assert.deepEqual(events, ['committed', 'accepted']);
});

test('a failed first transaction never acknowledges or consumes the draft', async () => {
    const app = harness();
    chatDB.saveSessionWithMessages = async () => { throw new Error('quota'); };
    await assert.rejects(app.addMessage('user', 'draft', { onPersisted: () => assert.fail('Not accepted') }), /quota/);
});

test('pending attachment conversion survives failure and resumes from a stored message clone', async () => {
    const app = harness();
    let durable = { id: 'prompt', sessionId: 'source', role: 'user', content: '',
        files: [{ name: 'test.txt', type: 'text/plain', size: 4 }],
        pendingFileObjects: [{ name: 'test.txt', type: 'text/plain', size: 4 }] };
    chatDB.getSessionMessages = async () => [structuredClone(durable)];
    chatDB.saveMessage = async value => { durable = structuredClone(value); };
    app.buildMessageFileMetadata = async () => { throw new Error('decoder failed'); };
    await assert.rejects(app.ensureMessageFileMetadata(structuredClone(durable)), /decoder failed/);
    assert.equal(durable.pendingFileObjects.length, 1);
    assert.equal(app.messageFilePreparationInFlight.size, 0);
    app.buildMessageFileMetadata = async files => files.map(file => ({ ...file, dataUrl: 'data:text/plain;base64,dGVzdA==' }));
    const retry = structuredClone(durable);
    await app.ensureMessageFileMetadata(retry);
    assert.equal(durable.files.length, 1);
    assert.ok(durable.files[0].dataUrl);
    assert.equal(durable.pendingFileObjects, undefined);
    assert.equal(retry.pendingFileObjects, undefined);
});

test('deleting a chat cannot replace navigation performed during its transaction', async () => {
    const app = harness();
    const gate = deferred();
    app.sessionScrollPositions = new Map();
    app.sessionPromptScrollAnchors = new Map();
    app.clearChatbarStateForSession = () => {};
    app.switchSession = () => assert.fail('Must not navigate');
    app.clearCurrentSession = () => assert.fail('Must not clear the new composer');
    chatDB.deleteSessionWithMessages = () => gate.promise;
    const deleting = app.deleteIdleSession('source');
    app.state.currentSessionId = 'another';
    app.sessionNavigationGeneration++;
    gate.resolve();
    await deleting;
    assert.equal(app.state.currentSessionId, 'another');
    assert.equal(app.state.sessionsById.has('source'), false);
});

test('accountless runtime cannot bootstrap an account through an extension capability', async () => {
    const app = harness();
    app.features = { accounts: false };
    await assert.rejects(app.resolveExtensionAuthContext(), error => error.code === 'ACCOUNTS_DISABLED');
});
