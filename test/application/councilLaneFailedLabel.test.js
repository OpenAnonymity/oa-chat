import test from 'node:test';
import assert from 'node:assert/strict';

// Prod, 2026-10-14: a Parallel lane that failed before answering was labelled
// "unknown" (the router's `model` on its error event) and said only "Request
// failed." (the router's numeric error code was dropped). A failed lane keeps
// the model that was asked for and names what it got — the provider's code as
// a provider code (PROVIDER_CODE_nnn, "Provider error nnn"), never passed off
// as the HTTP status of the response, which stays "HTTP nnn" / "Error nnn".
const { default: CouncilController } = await import('../../chat/application/councilController.js');
const { resolveResponseModelName, isReportedModelId } = await import('../../chat/domain/modelSelection.js');

function createHarness({ sendLaneCompletion }) {
    const savedMessages = [];
    const userMessage = { id: 'user-1', sessionId: 'session-1', role: 'user', content: 'best restaurants in palo alto', timestamp: Date.now() };
    const session = {
        id: 'session-1', model: 'GPT', responseMode: 'council',
        councilConfig: { enabled: true, members: ['GPT', 'Gemini'], synthesisModel: 'GPT', outputMode: 'parallel', reviewEnabled: false },
        councilAccess: {}
    };
    const models = [{ id: 'openai/gpt', name: 'GPT' }, { id: 'google/gemini', name: 'Gemini' }];
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
        deleteMessage: async () => {}
    };
    const controller = new CouncilController({ app, chatDB, inferenceService: { getDefaultModelName: () => 'GPT' }, ticketClient: { getTicketCount: () => 10 } });
    controller.ensureAccessForEntries = async () => {};
    controller.assertSufficientTicketsForEntries = () => 0;
    controller.sendLaneCompletion = sendLaneCompletion;
    return { controller, session, userMessage, savedMessages };
}

// What api.js throws for a router error event: a numeric HTTP-style code on a
// 200 stream, no `status`.
const routerError = (code, message = 'Provider returned error') => Object.assign(new Error(message), {
    code, providerReported: true, isStreamError: true, retryable: false
});

test('a lane that fails before answering keeps the requested model and names the status', async () => {
    const { controller, session, userMessage, savedMessages } = createHarness({
        sendLaneCompletion: async ({ entry, streamTarget }) => {
            if (entry.laneId === 'primary') return { content: 'Evvia, Protégé, Ettan.', model: 'openai/gpt' };
            // The router reported a routed id on the way to the error, then failed.
            controller.updateLaneResponseModel(streamTarget.laneState, 'google/gemini-routed', entry, session);
            assert.equal(streamTarget.laneState.responseModel, 'google/gemini-routed', 'a concrete routed id is shown while the lane runs');
            throw routerError(502);
        }
    });

    await controller.runMultiModelTurn({ session, userMessage, searchEnabled: false, abortController: new AbortController(), initialPendingPhase: 'requesting-key' });

    const final = savedMessages.at(-1);
    const [primary, secondary] = final.council.stage1;
    assert.equal(primary.status, 'complete');
    assert.equal(secondary.status, 'error');
    assert.equal(secondary.model, 'Gemini', 'the lane is still the model that was asked for');
    assert.equal(secondary.responseModel, undefined, 'nothing answered, so no response model is shown');
    assert.equal(secondary.error, 'Request failed. (PROVIDER_CODE_502)', 'a provider code, not an HTTP status');
    assert.deepEqual(final.council.errors, [{ model: 'Gemini', message: 'Request failed. (PROVIDER_CODE_502)' }]);
    assert.equal(final.content, 'Evvia, Protégé, Ettan.', 'the completed lane is the turn');
});

test('a lane that answered partially and then failed keeps the model that answered', async () => {
    const { controller, session, userMessage, savedMessages } = createHarness({
        sendLaneCompletion: async ({ entry, streamTarget }) => {
            if (entry.laneId === 'primary') return { content: 'Evvia.', model: 'openai/gpt' };
            controller.updateLaneResponseModel(streamTarget.laneState, 'google/gemini-routed', entry, session);
            streamTarget.laneState.response = 'Here is my shortlist';
            throw routerError('PROVIDER_STREAM_ERROR', 'stream closed');
        }
    });

    await controller.runMultiModelTurn({ session, userMessage, searchEnabled: false, abortController: new AbortController(), initialPendingPhase: 'requesting-key' });

    const secondary = savedMessages.at(-1).council.stage1[1];
    assert.equal(secondary.status, 'error');
    assert.equal(secondary.responseModel, 'google/gemini-routed');
    assert.equal(secondary.error, 'Request failed. (PROVIDER_STREAM_ERROR)', 'a typed string code stays the detail');
});

test('the router\'s "unknown" names no model, for a lane or a single chat', () => {
    assert.equal(isReportedModelId('unknown'), false);
    assert.equal(isReportedModelId(' Unknown '), false);
    assert.equal(isReportedModelId(''), false);
    assert.equal(isReportedModelId('google/gemini-3.8-flash'), true);
    assert.equal(resolveResponseModelName('unknown', {
        models: [{ id: 'google/gemini', name: 'Gemini' }], requestedModelId: 'google/gemini', requestedModelName: 'Gemini'
    }), null);
    assert.equal(resolveResponseModelName('google/gemini', {
        models: [{ id: 'google/gemini', name: 'Gemini' }], requestedModelId: 'google/gemini', requestedModelName: 'Gemini'
    }), 'Gemini');
});

test('a provider\'s numeric error code is named as a provider error, apart from an HTTP status', async () => {
    const { describeCouncilLaneError } = await import('../../chat/components/MessageTemplates.js');
    const { controller, session, userMessage, savedMessages } = createHarness({
        sendLaneCompletion: async ({ entry }) => {
            if (entry.laneId === 'primary') return { content: 'ok', model: 'openai/gpt' };
            throw routerError(429, 'Rate limit exceeded');
        }
    });
    await controller.runMultiModelTurn({ session, userMessage, searchEnabled: false, abortController: new AbortController(), initialPendingPhase: 'requesting-key' });
    const secondary = savedMessages.at(-1).council.stage1[1];
    assert.equal(secondary.error, 'Request failed. (PROVIDER_CODE_429)');
    assert.deepEqual(describeCouncilLaneError(secondary.error), { message: 'Too many requests.', detail: 'Provider error 429' });
    // The same number as the response status reads as the response status.
    assert.deepEqual(describeCouncilLaneError('Request failed. (HTTP 429)'), { message: 'Too many requests.', detail: 'Error 429' });
});

test('an HTTP status is the response\'s; a provider code off the list is a stream error; a typed code stays the detail', async () => {
    const run = async (error) => {
        const { controller, session, userMessage, savedMessages } = createHarness({
            sendLaneCompletion: async ({ entry }) => {
                if (entry.laneId === 'primary') return { content: 'ok', model: 'openai/gpt' };
                throw error;
            }
        });
        await controller.runMultiModelTurn({ session, userMessage, searchEnabled: false, abortController: new AbortController(), initialPendingPhase: 'requesting-key' });
        return savedMessages.at(-1).council.stage1[1].error;
    };
    assert.equal(await run(Object.assign(new Error('nope'), { status: 503 })), 'Request failed. (HTTP 503)');
    assert.equal(await run(routerError('503')), 'Request failed. (PROVIDER_STREAM_ERROR)', 'a provider code is never read as the HTTP status');
    assert.equal(await run(routerError(599)), 'Request failed. (PROVIDER_STREAM_ERROR)');
    assert.equal(await run(Object.assign(new Error('nope'), { status: 403, code: 'KEY_LIMIT' })), 'Request failed. (HTTP 403, KEY_LIMIT)');
    assert.equal(await run(new Error('closed')), 'Request failed.');
});
