import test from 'node:test';
import assert from 'node:assert/strict';

// How a single-chat turn settles: Stop must stop every update to the reply,
// including deliveries that were already in flight, and a finished reply must
// free the composer as soon as it is saved and rendered, not after the
// bookkeeping that follows. The transport side (a confirmed finish followed by
// an open connection) is covered in test/zkapi/inference-reliability.test.cjs.

function installBrowser() {
    const keys = ['window', 'location', 'localStorage', 'sessionStorage', 'document', 'fetch', 'requestAnimationFrame'];
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

const restoreImport = installBrowser();
const { default: preferencesStore } = await import('../../chat/services/preferencesStore.js');
const getPreference = preferencesStore.getPreference;
preferencesStore.getPreference = async () => false;
const { ChatApp } = await import('../../chat/app.js');
const { chatDB } = await import('../../chat/db.js');
const { OpenRouterAPI } = await import('../../chat/publicInferenceApi.js');
const { default: ChatArea } = await import('../../chat/components/ChatArea.js');
preferencesStore.getPreference = getPreference;
restoreImport();

function deferred() {
    let resolve;
    const promise = new Promise(value => { resolve = value; });
    return { promise, resolve };
}

function cancellation() {
    return Object.assign(new DOMException('The operation was aborted.', 'AbortError'), { isCancelled: true });
}

// Rejects as the production transport does once Stop aborts the turn.
function untilStopped(abortController) {
    return new Promise((_, reject) => abortController.signal.addEventListener('abort', () => reject(cancellation()), { once: true }));
}

function streamHarness(stream) {
    const app = Object.assign(Object.create(ChatApp.prototype), {
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
        getCurrentSession() { return this.state.sessionsById.get(this.state.currentSessionId) || null; },
        showToast() {},
        clearMemoryApiOverrideContent() {},
        announceChatOperation() {}
    });
    const records = new Map();
    // Every ChatArea call, in order, so a test can assert what happened after Stop.
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
    // One write that can be held open, as a slow IndexedDB transaction would
    // be; later writes are not queued behind it.
    const gates = { saveMessage: null };
    chatDB.getSessionMessages = async () => [...records.values()].map(message => structuredClone(message));
    chatDB.saveMessage = async message => {
        records.set(message.id, structuredClone(message));
        const gate = gates.saveMessage;
        if (gate) { gates.saveMessage = null; await gate.promise; }
    };
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
    const paintsAfter = name => { const at = paints.findIndex(call => call.name === name); return at < 0 ? paints : paints.slice(at + 1); };
    return { app, records, paints, gates, assistant, paintsAfter };
}

test('a content delivery still writing when Stop lands cannot repaint or re-save the stopped reply', async t => {
    const restore = installBrowser();
    const entered = deferred();
    let callbacks = null;
    const { app, gates, assistant, paints, paintsAfter } = streamHarness(async (...args) => {
        callbacks = { chunk: args[3], abortController: args[7] };
        await callbacks.chunk('Partial answer ');
        // A second delivery whose periodic save is still open when Stop arrives.
        const gate = gates.saveMessage = deferred();
        const late = callbacks.chunk('x'.repeat(120)).then(() => 'resumed');
        entered.resolve({ late, gate });
        return untilStopped(callbacks.abortController);
    });
    t.after(() => { gates.saveMessage?.resolve(); restore(); });
    const turn = app.sendMessage();
    const { late, gate } = await entered.promise;
    app.stopSessionStreaming('one');
    await turn;
    assert.equal(app.getSessionStreamingState('one').isStreaming, false);
    const settled = assistant().at(-1);
    assert.equal(settled.content, 'Partial answer ' + 'x'.repeat(120), 'text received before Stop is kept');
    assert.equal(settled.streamingTokens, null);
    assert.equal(settled.streamingPending, false);
    assert.ok(paints.some(call => call.name === 'finalizeStreamingMessage'), 'Stop settled the row');
    const savesBefore = assistant().length;
    gate.resolve();
    assert.equal(await late, 'resumed');
    await new Promise(resolve => setTimeout(resolve, 5));
    assert.deepEqual(paintsAfter('finalizeStreamingMessage').map(call => call.name), [], 'no repaint after the row was settled');
    assert.deepEqual(assistant().at(-1), settled, 'the settled record is not written over');
    assert.equal(assistant().length, savesBefore);
});

test('Stop during desktop reasoning-to-answer persistence prevents late trace paints and image saves', async t => {
    const restore = installBrowser();
    const entered = deferred();
    const { app, gates, assistant, paints } = streamHarness(async (...args) => {
        await args[9]('Reasoning before the answer.');
        const gate = gates.saveMessage = deferred();
        const late = args[3]('Answer text', { images: ['synthetic-late-image'] });
        entered.resolve({ late, gate });
        return untilStopped(args[7]);
    });
    t.after(() => { gates.saveMessage?.resolve(); restore(); });
    const turn = app.sendMessage();
    const { late, gate } = await entered.promise;
    app.stopSessionStreaming('one');
    await turn;
    const settled = structuredClone(assistant().at(-1));
    const paintsBeforeResume = paints.length;
    gate.resolve();
    await late;
    assert.equal(paints.length, paintsBeforeResume);
    assert.deepEqual(assistant().at(-1), settled);
    assert.equal(settled.images, undefined);
});

test('a first thinking chunk still being written when Stop lands shows the row once and never repaints it as thinking', async t => {
    const restore = installBrowser();
    const entered = deferred();
    const { app, gates, assistant, paints, paintsAfter } = streamHarness(async (...args) => {
        const [abortController, reasoning] = [args[7], args[9]];
        // The first reasoning delivery persists the row; that write is still
        // open when Stop arrives.
        const gate = gates.saveMessage = deferred();
        entered.resolve({ late: reasoning('Thinking about it.').then(() => 'resumed'), gate });
        return untilStopped(abortController);
    });
    t.after(() => { gates.saveMessage?.resolve(); restore(); });
    const turn = app.sendMessage();
    const { late, gate } = await entered.promise;
    app.stopSessionStreaming('one');
    await turn;
    const settled = assistant().at(-1);
    assert.equal(settled.streamingReasoning, false);
    assert.equal(settled.streamingPending, false);
    assert.ok(paints.some(call => call.name === 'finalizeReasoningDisplay'), 'Stop settled the trace');
    gate.resolve();
    assert.equal(await late, 'resumed');
    await new Promise(resolve => setTimeout(resolve, 5));
    // The turn owner renders a missing row during finalization. The retired
    // callback must not append anything after the composer has been released.
    assert.deepEqual(paintsAfter('finalizeReasoningDisplay').map(call => call.name), []);
    assert.equal(paints.find(call => call.name === 'finalizeStreamingMessage').args[1].appendIfMissing, true);
    const persisted = assistant().at(-1);
    assert.deepEqual(persisted, settled, 'a reload must not show the stopped reply as thinking');
});

test('a delivery that starts after Stop is ignored entirely', async t => {
    const restore = installBrowser();
    let callbacks = null;
    const { app, assistant, paints } = streamHarness(async (...args) => {
        callbacks = { chunk: args[3], reasoning: args[9], abortController: args[7] };
        await callbacks.chunk('Partial answer');
        return untilStopped(callbacks.abortController);
    });
    t.after(restore);
    const turn = app.sendMessage();
    await new Promise(resolve => setTimeout(resolve, 5));
    app.stopSessionStreaming('one');
    await turn;
    const settled = assistant().at(-1);
    const paintCount = paints.length;
    await callbacks.chunk(' late text');
    await callbacks.reasoning('late reasoning');
    assert.equal(paints.length, paintCount);
    assert.deepEqual(assistant().at(-1), settled);
});

test('a finished reply frees the composer once it is saved and rendered; search indexing runs in the background', async t => {
    const restore = installBrowser();
    const indexing = deferred(), indexed = deferred();
    let calls = 0, indexRuns = 0;
    const { app, assistant, paints } = streamHarness(async (...args) => {
        calls++;
        await args[3](calls === 1 ? 'Complete answer.' : 'Follow-up answer.');
        return { completionTokens: 2, finishReason: 'stop', isStreaming: false };
    });
    app.refreshSessionConversationSearchText = async (session, messages, options) => {
        indexRuns++;
        assert.equal(options?.persist, true);
        indexed.resolve();
        await indexing.promise;
        if (indexRuns === 1) throw new Error('index write failed');
    };
    t.after(() => { indexing.resolve(); restore(); });
    await app.sendMessage();
    await indexed.promise;
    // The reply is on disk and rendered while the index refresh is still running.
    assert.equal(assistant().at(-1).content, 'Complete answer.');
    assert.ok(paints.some(call => call.name === 'finalizeStreamingMessage'));
    assert.equal(app.getSessionStreamingState('one').isStreaming, false);
    assert.equal(app.sendSubmissionsInFlight.size, 0, 'the turn is over before bookkeeping ends');
    app.elements.messageInput.value = 'FOLLOWUP';
    await app.sendMessage();
    assert.equal(calls, 2, 'the follow-up was sent while the first index refresh was still running');
    assert.equal(assistant().at(-1).content, 'Follow-up answer.');
    indexing.resolve();
    await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(indexRuns, 2);
    const first = assistant()[0];
    assert.equal(first.content, 'Complete answer.');
    assert.equal(first.inferenceError ?? null, null, 'a failed index write is not a reply failure');
});

test('the required save still holds the composer: a follow-up waits for the reply to be written', async t => {
    const restore = installBrowser();
    let calls = 0, gate = null;
    const { app, gates, assistant } = streamHarness(async (...args) => {
        calls++;
        await args[3](calls === 1 ? 'Complete answer.' : 'Follow-up answer.');
        // The first reply's final save (after the stream) is the one still open.
        if (calls === 1) gate = gates.saveMessage = deferred();
        return { completionTokens: 2, finishReason: 'stop', isStreaming: false };
    });
    t.after(() => { gate?.resolve(); restore(); });
    const first = app.sendMessage();
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(app.getSessionStreamingState('one').isStreaming, true, 'the reply is not on disk yet');
    app.stopSessionStreaming('one');
    app.elements.messageInput.value = 'FOLLOWUP';
    await app.sendMessage();
    assert.equal(calls, 1);
    assert.equal(app.elements.messageInput.value, 'FOLLOWUP', 'the draft stays in the composer');
    gate.resolve();
    await first;
    assert.equal(app.getSessionStreamingState('one').isStreaming, false);
    assert.equal(assistant().at(-1).content, 'Complete answer.', 'Stop after completion does not damage the finished reply');
    await app.sendMessage();
    assert.equal(calls, 2);
    assert.equal(assistant().at(-1).content, 'Follow-up answer.');
});


// Keep the real SSE parser/watchdog in this regression: its timeout aborts the
// transport signal without aborting ChatApp's turn controller. The DB fixture
// delays a save's promise after recording the write, not a real IDB transaction.
for (const operation of ['send', 'regenerate']) {
    for (const [delivery, holdAccounting] of [['reasoning', false], ['content', false], ['reasoning', true], ['content', true]]) {
        test(`${operation}: real timeout retires held ${delivery}${holdAccounting ? ' during accounting' : ' before follow-up'}`, { timeout: 5000 }, async t => {
            const restore = installBrowser();
            const gate = deferred(), entered = deferred(), ledger = deferred(), ledgerEntered = deferred();
            let stream, cancelled = false, calls = 0, hold = true, outerSignal;
            const api = new OpenRouterAPI({
                networkTransport: { fetchWithRetry: async () => ({ ok: true, status: 200,
                    body: new ReadableStream({ start(controller) { stream = controller; }, cancel() { cancelled = true; } }) }) },
                inferenceTiming: { warningMs: 40, connectionMs: 1000, idleMs: 150, outputMs: 500, pollMs: 5 }
            });
            const { app, records, paints } = streamHarness(async (...args) => {
                calls++;
                if (calls > 1) {
                    await args[3]('FOLLOWUP_OK');
                    return { completionTokens: 2, isStreaming: false };
                }
                outerSignal = args[7].signal;
                args[2] = 'synthetic';
                return api.streamCompletion(...args);
            });
            const save = chatDB.saveMessage;
            chatDB.saveMessage = async message => {
                await save(message);
                if (hold && message.role === 'assistant' && (message.reasoning || message.content)) {
                    hold = false;
                    entered.resolve();
                    await gate.promise;
                }
            };
            if (holdAccounting) app.tryRecordRuntimeUsage = async usage => {
                if (usage.final !== false) { ledgerEntered.resolve(); await ledger.promise; }
            };
            t.after(() => { gate.resolve(); ledger.resolve(); restore(); });
            if (operation === 'regenerate') records.set('prompt', { id: 'prompt', sessionId: 'one', role: 'user', content: 'Original prompt', model: 'Accepted model' });
            const first = operation === 'send' ? app.sendMessage() : app.regenerateResponse();
            while (!stream) await new Promise(resolve => setTimeout(resolve, 1));
            stream.enqueue(new TextEncoder().encode('data: ' + JSON.stringify({ choices: [{ delta: {
                [delivery]: 'PARTIAL_OUTPUT_LONG_ENOUGH_TO_FLUSH'
            } }] }) + '\n\n'));
            await entered.promise;
            if (holdAccounting) {
                await ledgerEntered.promise;
                assert.equal(cancelled, true);
                assert.equal(app.getSessionStreamingState('one').isStreaming, true, 'accounting still owns the turn');
                const count = paints.length;
                gate.resolve();
                await new Promise(resolve => setTimeout(resolve, 40));
                assert.equal(paints.length, count, 'no repaint after timeout while accounting waits');
                ledger.resolve();
            }
            await first;
            assert.equal(cancelled, true, 'the real watchdog cancelled the reader');
            assert.equal(outerSignal.aborted, false, 'a timeout is not a user Stop');
            assert.equal(app.getSessionStreamingState('one').isStreaming, false);
            assert.ok(paints.some(call => call.name === 'finalizeStreamingMessage' && call.args[1]?.appendIfMissing), 'the settled partial reply is rendered before releasing the turn');
            app.elements.messageInput.value = 'FOLLOWUP';
            await app.sendMessage();
            assert.equal(calls, 2, 'exactly one request per turn');
            assert.ok([...records.values()].some(message => message.content === 'FOLLOWUP_OK'));
            const before = structuredClone([...records.values()]), paintCount = paints.length;
            gate.resolve();
            await new Promise(resolve => setTimeout(resolve, 40));
            assert.equal(paints.length, paintCount, 'no late append or thinking update');
            assert.deepEqual([...records.values()], before, 'no stale persistence after follow-up');
        });
    }

    for (const accounting of ['transport', 'message']) {
    test(`${operation}: successful completion retires callbacks while ${accounting} usage is still awaited`, async t => {
        const restore = installBrowser();
        const usage = deferred(), usageEntered = deferred();
        let callbacks;
        const { app, records, paints } = streamHarness(async (...args) => {
            callbacks = args;
            await args[3]('Complete answer');
            return { completionTokens: 2, isStreaming: false };
        });
        const holdUsage = async () => { usageEntered.resolve(); await usage.promise; };
        if (accounting === 'transport') app.tryRecordRuntimeUsage = async data => { if (data.final !== false) await holdUsage(); };
        else app.recordRuntimeUsage = holdUsage;
        t.after(() => { usage.resolve(); restore(); });
        if (operation === 'regenerate') records.set('prompt', { id: 'prompt', sessionId: 'one', role: 'user', content: 'Original prompt', model: 'Accepted model' });
        const turn = operation === 'send' ? app.sendMessage() : app.regenerateResponse();
        await usageEntered.promise;
        assert.equal(app.getSessionStreamingState('one').isStreaming, true, 'usage remains required');
        const before = structuredClone([...records.values()]), count = paints.length;
        await callbacks[3]('STALE', { images: ['synthetic-image'] });
        callbacks[4]({ model: 'Stale model', completionTokens: 999 });
        await callbacks[8]();
        await callbacks[9]('STALE REASONING');
        await callbacks[9]('', { withheld: true });
        assert.equal(paints.length, count);
        assert.deepEqual([...records.values()], before);
        usage.resolve();
        await turn;
        assert.equal(app.getSessionStreamingState('one').isStreaming, false);
        const answer = [...records.values()].find(message => message.role === 'assistant');
        assert.equal(answer.content, 'Complete answer');
        assert.equal(answer.tokenCount, 2);
    });
    }
}

test('finalization renders a missing partial row only when its owner explicitly requests it', async t => {
    const restore = installBrowser();
    t.after(restore);
    const appended = [];
    const area = { settledReasoningIds: new Map(), appendMessage: async message => appended.push(structuredClone(message)) };
    const message = { id: 'partial', role: 'assistant', content: 'Kept partial', streamingReasoning: false };
    await ChatArea.prototype.finalizeStreamingMessage.call(area, message);
    assert.equal(appended.length, 0, 'other finalizers retain their missing-row behavior');
    await ChatArea.prototype.finalizeStreamingMessage.call(area, message, { appendIfMissing: true });
    assert.deepEqual(appended, [message]);
});
