import test from 'node:test';
import assert from 'node:assert/strict';

// Round-2 robustness checks, 2026-10-09: Stop erased visible Parallel output,
// and a stopped lane's history ran user, user, user so the model reworked the
// old requests. Both paths, with the harness from councilController.test.js.
const { default: CouncilController } = await import('../../chat/application/councilController.js');

function createHarness({ sendLaneCompletion }) {
    const savedMessages = [];
    const deleted = [];
    const userMessage = { id: 'user-1', sessionId: 'session-1', role: 'user', content: 'A long numbered list, please.', timestamp: Date.now() };
    const session = {
        id: 'session-1', model: 'GPT', responseMode: 'council',
        councilConfig: { enabled: true, members: ['GPT', 'Claude'], synthesisModel: 'Gemini', outputMode: 'parallel', reviewEnabled: false },
        councilAccess: {}
    };
    const models = [{ id: 'openai/gpt', name: 'GPT' }, { id: 'anthropic/claude', name: 'Claude' }, { id: 'google/gemini', name: 'Gemini' }];
    const app = {
        state: { models }, reasoningEnabled: false, reasoningEffort: 'medium',
        normalizeModelName: name => name, getFallbackModelEntry: () => models[0], getTicketCost: () => 1,
        processMessagesWithFiles: messages => messages, isAccessCreditExhaustedError: () => false,
        loadModels: async () => {}, addMessage: async () => {}, isViewingSession: () => false,
        showTypingIndicator: () => null, removeTypingIndicator: () => {},
        generateSessionTitleIfNeeded: async () => {}, sanitizeMessagesForApi: messages => messages,
        refreshSessionConversationSearchText: async () => {}, recomputeSessionCouncilTranscriptHint: async () => {},
        triggerPostTurnMemoryExtraction: () => {}, clearSessionTitleGenerationPending: async () => {},
        enrichCitationsAndUpdateUI: () => {}, saveSessionsAndRender: async () => {}, renderSessions: () => {},
        getSessionStreamingState: () => ({}), updateSessionStreamingPhase: () => {},
        generateId: (() => { let n = 0; return () => `assistant-${n += 1}`; })()
    };
    const chatDB = {
        getSessionMessages: async () => [userMessage],
        saveMessage: async message => { savedMessages.push(JSON.parse(JSON.stringify(message))); },
        saveSession: async () => {},
        deleteMessage: async id => { deleted.push(id); }
    };
    const controller = new CouncilController({ app, chatDB, inferenceService: { getDefaultModelName: () => 'GPT' }, ticketClient: { getTicketCount: () => 10 } });
    controller.ensureAccessForEntries = async () => {};
    controller.assertSufficientTicketsForEntries = () => 0;
    controller.sendLaneCompletion = sendLaneCompletion;
    return { controller, session, userMessage, savedMessages, deleted };
}

const abortError = () => Object.assign(new Error('Request aborted'), { name: 'AbortError' });

test('Stop keeps a lane\'s partial text and reasoning instead of deleting the turn', async () => {
    const abortController = new AbortController();
    const { controller, session, userMessage, savedMessages, deleted } = createHarness({
        sendLaneCompletion: async ({ entry, streamTarget }) => {
            if (entry.laneId === 'primary') {
                // Several list items were visible when the user pressed Stop.
                streamTarget.laneState.response = '1. First\n2. Second\n3. Third';
                streamTarget.laneState.reasoning = 'Listing in order.';
                await new Promise(resolve => setTimeout(resolve, 5));
                abortController.abort();
                throw abortError();
            }
            // The other model had not said anything yet.
            await new Promise(resolve => setTimeout(resolve, 10));
            throw abortError();
        }
    });

    await controller.runMultiModelTurn({ session, userMessage, searchEnabled: false, abortController, initialPendingPhase: 'requesting-key' });

    assert.deepEqual(deleted, [], 'the turn stays');
    const final = savedMessages.at(-1);
    const [primary, secondary] = final.council.stage1;
    assert.equal(primary.status, 'cancelled');
    assert.equal(primary.response, '1. First\n2. Second\n3. Third');
    assert.equal(primary.reasoning, 'Listing in order.');
    assert.equal(secondary.status, 'cancelled');
    assert.equal(final.content, '1. First\n2. Second\n3. Third', 'the partial answer is the turn, as in a single chat');
    assert.equal(final.council.canonicalStage1Label, primary.label);
    assert.equal(final.council.statusMessage, 'Stopped before any model finished.');
    assert.equal(final.council.currentStage, 'complete');
    assert.equal(final.streamingTokens, null);
});

test('Stop before any lane has shown anything still removes the empty turn', async () => {
    const abortController = new AbortController();
    const { controller, session, userMessage, deleted } = createHarness({
        sendLaneCompletion: async () => { abortController.abort(); throw abortError(); }
    });
    await controller.runMultiModelTurn({ session, userMessage, searchEnabled: false, abortController, initialPendingPhase: 'requesting-key' });
    assert.equal(deleted.length, 1);
});

test('a stopped lane\'s history keeps its partial answer, and an unspoken turn is closed, not dropped', () => {
    const controller = Object.create(CouncilController.prototype);
    const entries = [{ laneId: 'primary', id: 'test/primary', name: 'Primary' }, { laneId: 'secondary', id: 'test/secondary', name: 'Secondary' }];
    const messages = [
        { role: 'user', content: 'Earlier difficult task I.' },
        { role: 'assistant', content: 'Primary completed I.', council: { stage1: [
            { laneId: 'primary', modelId: 'test/primary', model: 'Primary', status: 'complete', response: 'Primary completed I.' },
            { laneId: 'secondary', modelId: 'test/secondary', model: 'Secondary', status: 'cancelled', response: '', reasoning: 'Unfinished reasoning.' }
        ] } },
        { role: 'user', content: 'Another task J, stopped mid-answer.' },
        { role: 'assistant', content: 'Partial J from Primary', council: { stage1: [
            { laneId: 'primary', modelId: 'test/primary', model: 'Primary', status: 'cancelled', response: 'Partial J from Primary' },
            { laneId: 'secondary', modelId: 'test/secondary', model: 'Secondary', status: 'error', response: '', error: 'HTTP 502' }
        ] } },
        { role: 'user', content: 'Current task K: reply with only OK.' }
    ];
    const primary = controller.buildLaneConversationMessages(messages, entries[0], entries);
    const secondary = controller.buildLaneConversationMessages(messages, entries[1], entries);

    assert.deepEqual(primary.map(m => m.role), ['user', 'assistant', 'user', 'assistant', 'user']);
    assert.equal(primary[3].content, 'Partial J from Primary');

    assert.deepEqual(secondary.map(m => m.role), ['user', 'assistant', 'user', 'assistant', 'user']);
    assert.match(secondary[1].content, /stopped by the user before it began/);
    assert.match(secondary[3].content, /failed before it began/);
    assert.doesNotMatch(secondary[1].content, /Unfinished reasoning/, 'reasoning alone is not an answer');
    for (const history of [primary, secondary]) {
        for (let i = 1; i < history.length; i += 1) {
            assert.notEqual(history[i].role, history[i - 1].role, 'roles alternate, so only the last prompt is open');
        }
    }
});
