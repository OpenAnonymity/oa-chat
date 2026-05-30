import test from 'node:test';
import assert from 'node:assert/strict';

const { default: CouncilController } = await import('../../chat/application/councilController.js');

function createController({
    costs = {},
    reasoningEnabled = false,
    ticketCount = 0,
    chatDB = {},
    inferenceService = {},
    models = []
} = {}) {
    const app = {
        state: { models },
        reasoningEnabled,
        reasoningEffort: 'medium',
        normalizeModelName: (modelName) => modelName,
        getTicketCost: (modelId) => costs[modelId] ?? 1,
        processMessagesWithFiles: (messages) => messages,
        isAccessCreditExhaustedError: (error) => error?.status === 402
    };
    return new CouncilController({
        app,
        chatDB,
        inferenceService,
        ticketClient: {
            getTicketCount: () => ticketCount
        }
    });
}

test('ensureAccessForEntries requests each missing lane with its own model ticket cost', async () => {
    const controller = createController({
        ticketCount: 10,
        costs: {
            'openai/gpt': 3,
            'anthropic/claude': 2
        }
    });
    const session = { id: 'session-1', councilAccess: {} };
    const requests = [];
    controller.requestLaneAccess = async (targetSession, entry) => {
        requests.push({
            laneId: entry.laneId,
            modelId: entry.id,
            tickets: controller.getTicketCostForEntry(entry)
        });
        return controller.setLaneAccess(targetSession, entry.laneId, {
            key: `${entry.laneId}-key`,
            modelId: entry.id,
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
            ticketsConsumed: controller.getTicketCostForEntry(entry)
        });
    };

    const ticketsRequired = await controller.ensureAccessForEntries(session, [
        { laneId: 'primary', id: 'openai/gpt', name: 'GPT' },
        { laneId: 'secondary', id: 'anthropic/claude', name: 'Claude' }
    ]);

    assert.equal(ticketsRequired, 5);
    assert.deepEqual(requests, [
        { laneId: 'primary', modelId: 'openai/gpt', tickets: 3 },
        { laneId: 'secondary', modelId: 'anthropic/claude', tickets: 2 }
    ]);
    assert.equal(session.councilAccess.primary.ticketsConsumed, 3);
    assert.equal(session.councilAccess.secondary.ticketsConsumed, 2);
});

test('requestLaneAccess passes the lane model cost to the access issuer', async () => {
    const requests = [];
    const savedSessions = [];
    const controller = createController({
        ticketCount: 10,
        costs: {
            'openai/gpt': 3,
            'anthropic/claude': 2
        },
        chatDB: {
            saveSession: async (session) => {
                savedSessions.push(JSON.parse(JSON.stringify(session)));
            }
        },
        inferenceService: {
            getAccessLabel: () => 'OpenRouter key',
            requestAccess: async (_session, request) => {
                requests.push(request);
                return {
                    key: `key-for-${request.ticketsRequired}`,
                    expiresAt: new Date(Date.now() + 60_000).toISOString(),
                    ticketsConsumed: request.ticketsRequired
                };
            },
            setAccessInfo: (session, result) => {
                session.apiKey = result.key;
                session.apiKeyInfo = result;
                session.expiresAt = result.expiresAt;
            },
            getVerificationAdapter: () => ({ supports: false })
        }
    });
    const session = { id: 'session-1', councilAccess: {} };

    await controller.requestLaneAccess(
        session,
        { laneId: 'primary', id: 'openai/gpt', name: 'GPT' },
        null
    );
    await controller.requestLaneAccess(
        session,
        { laneId: 'secondary', id: 'anthropic/claude', name: 'Claude' },
        null
    );

    assert.deepEqual(requests, [
        { ticketsRequired: 3 },
        { ticketsRequired: 2 }
    ]);
    assert.equal(session.councilAccess.primary.apiKey, 'key-for-3');
    assert.equal(session.councilAccess.primary.ticketsConsumed, 3);
    assert.equal(session.councilAccess.primary.modelId, 'openai/gpt');
    assert.equal(session.councilAccess.secondary.apiKey, 'key-for-2');
    assert.equal(session.councilAccess.secondary.ticketsConsumed, 2);
    assert.equal(session.councilAccess.secondary.modelId, 'anthropic/claude');
    assert.equal(savedSessions.length, 2);
});

test('ensureAccessForEntries reuses valid single-chat primary access and only charges missing secondary lane', async () => {
    const validExpiry = new Date(Date.now() + 60_000).toISOString();
    const controller = createController({
        ticketCount: 2,
        models: [
            { id: 'openai/gpt', name: 'GPT' },
            { id: 'anthropic/claude', name: 'Claude' }
        ],
        costs: {
            'openai/gpt': 3,
            'anthropic/claude': 2
        },
        inferenceService: {
            isAccessExpired: () => false,
            getAccessInfo: (session) => ({
                token: session.apiKey,
                info: session.apiKeyInfo,
                expiresAt: session.expiresAt
            })
        }
    });
    const session = {
        id: 'session-1',
        model: 'GPT',
        apiKey: 'single-primary-key',
        apiKeyInfo: { stationId: 'station-a', modelId: 'openai/gpt' },
        expiresAt: validExpiry,
        councilAccess: {}
    };
    const requests = [];
    controller.requestLaneAccess = async (targetSession, entry) => {
        requests.push(entry.laneId);
        return controller.setLaneAccess(targetSession, entry.laneId, {
            key: `${entry.laneId}-key`,
            modelId: entry.id,
            expiresAt: validExpiry,
            ticketsConsumed: controller.getTicketCostForEntry(entry)
        });
    };

    const ticketsRequired = await controller.ensureAccessForEntries(session, [
        { laneId: 'primary', id: 'openai/gpt', name: 'GPT' },
        { laneId: 'secondary', id: 'anthropic/claude', name: 'Claude' }
    ]);

    assert.equal(ticketsRequired, 5);
    assert.deepEqual(requests, ['secondary']);
    assert.equal(session.councilAccess.primary.apiKey, 'single-primary-key');
    assert.equal(session.councilAccess.primary.modelId, 'openai/gpt');
    assert.equal(session.councilAccess.primary.ticketsConsumed, 0);
    assert.equal(session.councilAccess.secondary.apiKey, 'secondary-key');
});

test('ensureAccessForEntries does not seed primary lane when session access lacks model metadata', async () => {
    const validExpiry = new Date(Date.now() + 60_000).toISOString();
    const controller = createController({
        ticketCount: 5,
        models: [
            { id: 'openai/gpt', name: 'GPT' },
            { id: 'anthropic/claude', name: 'Claude' }
        ],
        costs: {
            'openai/gpt': 3,
            'anthropic/claude': 2
        },
        inferenceService: {
            isAccessExpired: () => false,
            getAccessInfo: (session) => ({
                token: session.apiKey,
                info: session.apiKeyInfo,
                expiresAt: session.expiresAt
            })
        }
    });
    const session = {
        id: 'session-1',
        model: 'GPT',
        apiKey: 'single-key-without-model-metadata',
        apiKeyInfo: {},
        expiresAt: validExpiry,
        councilAccess: {}
    };
    const requests = [];
    controller.requestLaneAccess = async (targetSession, entry) => {
        requests.push(entry.laneId);
        return controller.setLaneAccess(targetSession, entry.laneId, {
            key: `${entry.laneId}-key`,
            modelId: entry.id,
            expiresAt: validExpiry
        });
    };

    await controller.ensureAccessForEntries(session, [
        { laneId: 'primary', id: 'openai/gpt', name: 'GPT' },
        { laneId: 'secondary', id: 'anthropic/claude', name: 'Claude' }
    ]);

    assert.deepEqual(requests, ['primary', 'secondary']);
    assert.equal(session.councilAccess.primary.apiKey, 'primary-key');
});

test('ensureAccessForEntries does not seed primary lane when access model metadata differs', async () => {
    const validExpiry = new Date(Date.now() + 60_000).toISOString();
    const controller = createController({
        ticketCount: 5,
        models: [
            { id: 'openai/gpt', name: 'GPT' },
            { id: 'anthropic/claude', name: 'Claude' }
        ],
        costs: {
            'openai/gpt': 3,
            'anthropic/claude': 2
        },
        inferenceService: {
            isAccessExpired: () => false,
            getAccessInfo: (session) => ({
                token: session.apiKey,
                info: session.apiKeyInfo,
                expiresAt: session.expiresAt
            })
        }
    });
    const session = {
        id: 'session-1',
        model: 'GPT',
        apiKey: 'single-claude-key',
        apiKeyInfo: { modelId: 'anthropic/claude' },
        expiresAt: validExpiry,
        councilAccess: {}
    };
    const requests = [];
    controller.requestLaneAccess = async (targetSession, entry) => {
        requests.push(entry.laneId);
        return controller.setLaneAccess(targetSession, entry.laneId, {
            key: `${entry.laneId}-key`,
            modelId: entry.id,
            expiresAt: validExpiry
        });
    };

    await controller.ensureAccessForEntries(session, [
        { laneId: 'primary', id: 'openai/gpt', name: 'GPT' },
        { laneId: 'secondary', id: 'anthropic/claude', name: 'Claude' }
    ]);

    assert.deepEqual(requests, ['primary', 'secondary']);
    assert.equal(session.councilAccess.primary.apiKey, 'primary-key');
});

test('ensureAccessForEntries refreshes only the lane whose model changed', async () => {
    const controller = createController({
        ticketCount: 5,
        costs: {
            'openai/gpt': 1,
            'anthropic/claude-3': 2
        }
    });
    const validExpiry = new Date(Date.now() + 60_000).toISOString();
    const session = {
        id: 'session-1',
        councilAccess: {
            primary: {
                apiKey: 'primary-existing',
                apiKeyInfo: {},
                expiresAt: validExpiry,
                modelId: 'openai/gpt'
            },
            secondary: {
                apiKey: 'secondary-old',
                apiKeyInfo: {},
                expiresAt: validExpiry,
                modelId: 'anthropic/claude-2'
            }
        }
    };
    const refreshed = [];
    controller.requestLaneAccess = async (targetSession, entry) => {
        refreshed.push(entry.laneId);
        return controller.setLaneAccess(targetSession, entry.laneId, {
            key: `${entry.laneId}-new`,
            modelId: entry.id,
            expiresAt: validExpiry
        });
    };

    await controller.ensureAccessForEntries(session, [
        { laneId: 'primary', id: 'openai/gpt', name: 'GPT' },
        { laneId: 'secondary', id: 'anthropic/claude-3', name: 'Claude 3' }
    ]);

    assert.deepEqual(refreshed, ['secondary']);
    assert.equal(session.councilAccess.primary.apiKey, 'primary-existing');
    assert.equal(session.councilAccess.secondary.apiKey, 'secondary-new');
    assert.equal(session.councilAccess.secondary.modelId, 'anthropic/claude-3');
});

test('ensureAccessForEntries rejects insufficient tickets before acquiring any lane', async () => {
    const controller = createController({
        ticketCount: 2,
        costs: {
            'openai/gpt': 2,
            'anthropic/claude': 2
        }
    });
    let requestCount = 0;
    controller.requestLaneAccess = async () => {
        requestCount += 1;
        throw new Error('should not acquire partial council access');
    };

    await assert.rejects(
        controller.ensureAccessForEntries(
            { id: 'session-1', councilAccess: {} },
            [
                { laneId: 'primary', id: 'openai/gpt', name: 'GPT' },
                { laneId: 'secondary', id: 'anthropic/claude', name: 'Claude' }
            ]
        ),
        /Not enough tickets for multi-model response\. Need 4, but only 2 available\./
    );
    assert.equal(requestCount, 0);
});

test('sendLaneCompletion retries credit exhaustion by refreshing only the failed lane', async () => {
    const savedSessions = [];
    const sendTokens = [];
    const controller = createController({
        chatDB: {
            saveSession: async (session) => {
                savedSessions.push(JSON.parse(JSON.stringify(session)));
            }
        },
        inferenceService: {
            sendCompletionStrict: async (_messages, modelId, laneSession) => {
                sendTokens.push({ modelId, token: laneSession.apiKey });
                if (sendTokens.length === 1) {
                    const error = new Error('Can only afford 1 max_tokens');
                    error.status = 402;
                    throw error;
                }
                return { content: 'secondary response' };
            }
        }
    });
    const session = {
        id: 'session-1',
        councilAccess: {
            primary: {
                apiKey: 'primary-key',
                apiKeyInfo: {},
                expiresAt: new Date(Date.now() + 60_000).toISOString(),
                modelId: 'openai/gpt'
            },
            secondary: {
                apiKey: 'secondary-old-key',
                apiKeyInfo: {},
                expiresAt: new Date(Date.now() + 60_000).toISOString(),
                modelId: 'anthropic/claude'
            }
        }
    };
    const refreshed = [];
    controller.requestLaneAccess = async (targetSession, entry) => {
        refreshed.push(entry.laneId);
        return controller.setLaneAccess(targetSession, entry.laneId, {
            key: 'secondary-new-key',
            modelId: entry.id,
            expiresAt: new Date(Date.now() + 60_000).toISOString()
        });
    };

    const result = await controller.sendLaneCompletion({
        session,
        entry: { laneId: 'secondary', id: 'anthropic/claude', name: 'Claude' },
        sanitizedMessages: [{ role: 'user', content: 'hello' }],
        searchEnabled: false,
        abortController: null
    });

    assert.equal(result.content, 'secondary response');
    assert.deepEqual(refreshed, ['secondary']);
    assert.deepEqual(sendTokens, [
        { modelId: 'anthropic/claude', token: 'secondary-old-key' },
        { modelId: 'anthropic/claude', token: 'secondary-new-key' }
    ]);
    assert.equal(session.councilAccess.primary.apiKey, 'primary-key');
    assert.equal(session.councilAccess.secondary.apiKey, 'secondary-new-key');
    assert.equal(savedSessions[0].councilAccess.secondary.apiKey, null);
});
