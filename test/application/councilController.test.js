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
        getFallbackModelEntry: () => models[0] || null,
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
            'anthropic/claude': 2,
            'google/gemini': 4
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
        { laneId: 'secondary', id: 'anthropic/claude', name: 'Claude' },
        { laneId: 'synthesis', id: 'google/gemini', name: 'Gemini' }
    ]);

    assert.equal(ticketsRequired, 9);
    assert.deepEqual(requests, [
        { laneId: 'primary', modelId: 'openai/gpt', tickets: 3 },
        { laneId: 'secondary', modelId: 'anthropic/claude', tickets: 2 },
        { laneId: 'synthesis', modelId: 'google/gemini', tickets: 4 }
    ]);
    assert.equal(session.councilAccess.primary.ticketsConsumed, 3);
    assert.equal(session.councilAccess.secondary.ticketsConsumed, 2);
    assert.equal(session.councilAccess.synthesis.ticketsConsumed, 4);
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

test('requestLaneAccess passes abort signal and rejects already-aborted requests', async () => {
    const requests = [];
    const controller = createController({
        ticketCount: 3,
        costs: {
            'openai/gpt': 3
        },
        chatDB: {
            saveSession: async () => {}
        },
        inferenceService: {
            getAccessLabel: () => 'OpenRouter key',
            requestAccess: async (_session, request) => {
                requests.push(request);
                return {
                    key: 'key-for-signal',
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
    const abortController = new AbortController();

    await controller.requestLaneAccess(
        session,
        { laneId: 'primary', id: 'openai/gpt', name: 'GPT' },
        null,
        abortController.signal
    );

    assert.equal(requests.length, 1);
    assert.equal(requests[0].signal, abortController.signal);

    const alreadyAborted = new AbortController();
    alreadyAborted.abort();
    await assert.rejects(
        () => controller.requestLaneAccess(
            session,
            { laneId: 'primary', id: 'openai/gpt', name: 'GPT' },
            null,
            alreadyAborted.signal
        ),
        { name: 'AbortError' }
    );
    assert.equal(requests.length, 1);
});

test('resolveModelEntries adds Gemini 3.5 Flash as fallback secondary model when config only has primary', () => {
    const controller = createController({
        models: [
            { id: 'openai/gpt', name: 'GPT' },
            { id: 'openai/gpt-oss-120b', name: 'GPT OSS' },
            { id: 'google/gemini-3.5-flash', name: 'Gemini 3.5 Flash', provider: 'Google' },
            { id: 'anthropic/claude', name: 'Claude' }
        ],
        inferenceService: {
            getDefaultModelName: () => 'GPT'
        }
    });
    const session = {
        id: 'session-1',
        model: 'GPT',
        councilConfig: {
            enabled: true,
            members: ['GPT'],
            outputMode: 'parallel'
        }
    };

    const entries = controller.resolveModelEntries(session);

    assert.deepEqual(entries.map((entry) => entry.name), ['GPT', 'Gemini 3.5 Flash']);
    assert.deepEqual(entries.map((entry) => entry.laneId), ['primary', 'secondary']);
});

test('resolveModelEntries preserves configured secondary lane', () => {
    const controller = createController({
        models: [
            { id: 'openai/gpt', name: 'GPT' },
            { id: 'google/gemini', name: 'Gemini' },
            { id: 'anthropic/claude', name: 'Claude' }
        ],
        inferenceService: {
            getDefaultModelName: () => 'GPT'
        }
    });
    const session = {
        id: 'session-1',
        model: 'GPT',
        councilConfig: {
            enabled: true,
            members: ['openai/gpt', 'anthropic/claude'],
            outputMode: 'parallel'
        }
    };

    const entries = controller.resolveModelEntries(session);

    assert.deepEqual(entries.map((entry) => entry.id), ['openai/gpt', 'anthropic/claude']);
    assert.deepEqual(entries.map((entry) => entry.laneId), ['primary', 'secondary']);
});

test('resolveModelEntries allows the same model in both Parallel lanes', () => {
    const controller = createController({
        models: [
            { id: 'openai/gpt', name: 'GPT' },
            { id: 'anthropic/claude', name: 'Claude' }
        ],
        inferenceService: {
            getDefaultModelName: () => 'GPT'
        }
    });
    const session = {
        id: 'session-1',
        model: 'GPT',
        councilConfig: {
            enabled: true,
            members: ['GPT', 'GPT'],
            outputMode: 'parallel'
        }
    };

    const entries = controller.resolveModelEntries(session);

    assert.deepEqual(entries.map((entry) => entry.id), ['openai/gpt', 'openai/gpt']);
    assert.deepEqual(entries.map((entry) => entry.laneId), ['primary', 'secondary']);
});

test('resolveModelEntries matches trimmed configured secondary against trailing-space catalog names', () => {
    const controller = createController({
        models: [
            { id: 'openai/gpt', name: 'GPT' },
            { id: 'baidu/ernie-4.5-vl-424b-a47b', name: 'Baidu: ERNIE 4.5 VL 424B A47B ' },
            { id: 'anthropic/claude', name: 'Claude' }
        ],
        inferenceService: {
            getDefaultModelName: () => 'GPT'
        }
    });
    const session = {
        id: 'session-1',
        model: 'GPT',
        councilConfig: {
            enabled: true,
            members: ['GPT', 'Baidu: ERNIE 4.5 VL 424B A47B'],
            outputMode: 'parallel'
        }
    };

    const entries = controller.resolveModelEntries(session);

    assert.deepEqual(entries.map((entry) => entry.id), ['openai/gpt', 'baidu/ernie-4.5-vl-424b-a47b']);
    assert.deepEqual(entries.map((entry) => entry.name), ['GPT', 'Baidu: ERNIE 4.5 VL 424B A47B ']);
    assert.deepEqual(entries.map((entry) => entry.laneId), ['primary', 'secondary']);
});

test('resolveModelEntries uses fallback primary before configured secondary when session model is stale', () => {
    const controller = createController({
        models: [
            { id: 'openai/gpt', name: 'GPT' },
            { id: 'anthropic/claude', name: 'Claude' }
        ],
        inferenceService: {
            getDefaultModelName: () => 'GPT'
        }
    });
    const session = {
        id: 'session-1',
        model: 'Missing Model',
        councilConfig: {
            enabled: true,
            members: ['Missing Model', 'anthropic/claude'],
            outputMode: 'parallel'
        }
    };

    const entries = controller.resolveModelEntries(session);

    assert.deepEqual(entries.map((entry) => entry.id), ['openai/gpt', 'anthropic/claude']);
    assert.deepEqual(entries.map((entry) => entry.laneId), ['primary', 'secondary']);
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

test('seedSessionAccessFromPrimaryLane restores valid primary lane access for single chat', () => {
    const validExpiry = new Date(Date.now() + 60_000).toISOString();
    const setAccessCalls = [];
    const setCurrentAccessCalls = [];
    const controller = createController({
        inferenceService: {
            setAccessInfo: (session, accessInfo) => {
                setAccessCalls.push(accessInfo);
                session.apiKey = accessInfo.key;
                session.apiKeyInfo = accessInfo;
                session.expiresAt = accessInfo.expiresAt;
            },
            setCurrentAccess: (session, accessInfo) => {
                setCurrentAccessCalls.push({ sessionId: session.id, accessInfo });
            },
            getVerificationAdapter: () => ({ supports: false })
        }
    });
    const session = {
        id: 'session-1',
        apiKey: null,
        apiKeyInfo: null,
        expiresAt: null,
        councilAccess: {
            primary: {
                apiKey: 'primary-lane-key',
                apiKeyInfo: { stationId: 'station-a', modelId: 'openai/gpt-old' },
                expiresAt: validExpiry,
                modelId: 'openai/gpt-new'
            },
            secondary: {
                apiKey: 'secondary-lane-key',
                apiKeyInfo: { stationId: 'station-b' },
                expiresAt: validExpiry,
                modelId: 'anthropic/claude'
            }
        }
    };

    const laneAccess = controller.seedSessionAccessFromPrimaryLane(session);

    assert.equal(laneAccess.apiKey, 'primary-lane-key');
    assert.equal(session.apiKey, 'primary-lane-key');
    assert.equal(session.expiresAt, validExpiry);
    assert.equal(setAccessCalls.length, 1);
    assert.equal(setAccessCalls[0].key, 'primary-lane-key');
    assert.equal(setAccessCalls[0].modelId, 'openai/gpt-new');
    assert.equal(setCurrentAccessCalls.length, 1);
    assert.equal(setCurrentAccessCalls[0].accessInfo.key, 'primary-lane-key');
    assert.notEqual(session.apiKey, 'secondary-lane-key');
});

test('seedSessionAccessFromPrimaryLane skips expired primary lane access', () => {
    let setAccessCalled = false;
    const controller = createController({
        inferenceService: {
            setAccessInfo: () => {
                setAccessCalled = true;
            },
            getVerificationAdapter: () => ({ supports: false })
        }
    });
    const session = {
        id: 'session-1',
        apiKey: null,
        councilAccess: {
            primary: {
                apiKey: 'expired-primary-key',
                apiKeyInfo: { stationId: 'station-a' },
                expiresAt: new Date(Date.now() - 60_000).toISOString(),
                modelId: 'openai/gpt'
            }
        }
    };

    const laneAccess = controller.seedSessionAccessFromPrimaryLane(session);

    assert.equal(laneAccess, null);
    assert.equal(setAccessCalled, false);
    assert.equal(session.apiKey, null);
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

test('ensureAccessForEntries reuses valid lane keys after primary and secondary model switches', async () => {
    const controller = createController({
        ticketCount: 0,
        costs: {
            'openai/gpt-4': 4,
            'anthropic/claude-3': 3
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
                modelId: 'openai/gpt-3'
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

    const ticketsRequired = await controller.ensureAccessForEntries(session, [
        { laneId: 'primary', id: 'openai/gpt-4', name: 'GPT 4' },
        { laneId: 'secondary', id: 'anthropic/claude-3', name: 'Claude 3' }
    ]);

    assert.equal(ticketsRequired, 7);
    assert.equal(controller.calculateFreshTicketRequirement(session, [
        { laneId: 'primary', id: 'openai/gpt-4', name: 'GPT 4' },
        { laneId: 'secondary', id: 'anthropic/claude-3', name: 'Claude 3' }
    ]), 0);
    assert.deepEqual(refreshed, []);
    assert.equal(session.councilAccess.primary.apiKey, 'primary-existing');
    assert.equal(session.councilAccess.primary.modelId, 'openai/gpt-3');
    assert.equal(session.councilAccess.secondary.apiKey, 'secondary-old');
    assert.equal(session.councilAccess.secondary.modelId, 'anthropic/claude-2');
});

test('ensureAccessForEntries refreshes expired lane access for the selected model', async () => {
    const controller = createController({
        ticketCount: 3,
        costs: {
            'anthropic/claude-3': 3
        }
    });
    const expiredAt = new Date(Date.now() - 60_000).toISOString();
    const validExpiry = new Date(Date.now() + 60_000).toISOString();
    const session = {
        id: 'session-1',
        councilAccess: {
            secondary: {
                apiKey: 'secondary-expired',
                apiKeyInfo: {},
                expiresAt: expiredAt,
                modelId: 'anthropic/claude-2'
            }
        }
    };
    const refreshed = [];
    controller.requestLaneAccess = async (targetSession, entry) => {
        refreshed.push({ laneId: entry.laneId, modelId: entry.id, tickets: controller.getTicketCostForEntry(entry) });
        return controller.setLaneAccess(targetSession, entry.laneId, {
            key: 'secondary-new',
            modelId: entry.id,
            expiresAt: validExpiry,
            ticketsConsumed: controller.getTicketCostForEntry(entry)
        });
    };

    await controller.ensureAccessForEntries(session, [
        { laneId: 'secondary', id: 'anthropic/claude-3', name: 'Claude 3' }
    ]);

    assert.deepEqual(refreshed, [
        { laneId: 'secondary', modelId: 'anthropic/claude-3', tickets: 3 }
    ]);
    assert.equal(session.councilAccess.secondary.apiKey, 'secondary-new');
    assert.equal(session.councilAccess.secondary.modelId, 'anthropic/claude-3');
});

test('ensureAccessForEntries refreshes a lane whose station is now banned', async () => {
    const savedSessions = [];
    const controller = createController({
        ticketCount: 2,
        costs: {
            'anthropic/claude': 2
        },
        chatDB: {
            saveSession: async (session) => {
                savedSessions.push(JSON.parse(JSON.stringify(session)));
            }
        },
        inferenceService: {
            getVerificationAdapter: () => ({
                supports: true,
                getAccessId: (info) => info?.stationId || null,
                getAccessState: (accessId) => accessId === 'station-banned'
                    ? { banned: true, banReason: 'policy violation', bannedAt: '2026-05-31T00:00:00Z' }
                    : { banned: false },
                isAccessBanned: (accessId) => accessId === 'station-banned',
                getLastBroadcastData: () => ({
                    banned_stations: [
                        {
                            station_id: 'station-banned',
                            reason: 'policy violation',
                            banned_at: '2026-05-31T00:00:00Z'
                        }
                    ]
                })
            })
        }
    });
    const validExpiry = new Date(Date.now() + 60_000).toISOString();
    const session = {
        id: 'session-1',
        councilAccess: {
            secondary: {
                apiKey: 'secondary-banned-key',
                apiKeyInfo: { stationId: 'station-banned' },
                expiresAt: validExpiry,
                modelId: 'anthropic/claude'
            }
        }
    };
    const refreshed = [];
    controller.requestLaneAccess = async (targetSession, entry) => {
        refreshed.push(entry.laneId);
        return controller.setLaneAccess(targetSession, entry.laneId, {
            key: 'secondary-new-key',
            apiKeyInfo: { stationId: 'station-ok' },
            modelId: entry.id,
            expiresAt: validExpiry
        });
    };

    await controller.ensureAccessForEntries(session, [
        { laneId: 'secondary', id: 'anthropic/claude', name: 'Claude' }
    ]);

    assert.deepEqual(refreshed, ['secondary']);
    assert.equal(savedSessions[0].councilAccess.secondary.apiKey, null);
    assert.equal(session.councilAccess.secondary.apiKey, 'secondary-new-key');
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
        /Not enough tickets for selected model responses\. Need 4, but only 2 available\./
    );
    assert.equal(requestCount, 0);
});

test('sendLaneCompletion retries credit exhaustion after model switch by refreshing only the failed lane', async () => {
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
                modelId: 'anthropic/claude-2'
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
        entry: { laneId: 'secondary', id: 'anthropic/claude-3', name: 'Claude 3' },
        sanitizedMessages: [{ role: 'user', content: 'hello' }],
        searchEnabled: false,
        abortController: null
    });

    assert.equal(result.content, 'secondary response');
    assert.deepEqual(refreshed, ['secondary']);
    assert.deepEqual(sendTokens, [
        { modelId: 'anthropic/claude-3', token: 'secondary-old-key' },
        { modelId: 'anthropic/claude-3', token: 'secondary-new-key' }
    ]);
    assert.equal(session.councilAccess.primary.apiKey, 'primary-key');
    assert.equal(session.councilAccess.secondary.apiKey, 'secondary-new-key');
    assert.equal(session.councilAccess.secondary.modelId, 'anthropic/claude-3');
    assert.equal(savedSessions[0].councilAccess.secondary.apiKey, null);
});

test('sendLaneMessagesCompletion retries synthesis credit exhaustion without clearing response lanes', async () => {
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
                return { content: 'council synthesis' };
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
                apiKey: 'secondary-key',
                apiKeyInfo: {},
                expiresAt: new Date(Date.now() + 60_000).toISOString(),
                modelId: 'anthropic/claude'
            },
            synthesis: {
                apiKey: 'synthesis-old-key',
                apiKeyInfo: {},
                expiresAt: new Date(Date.now() + 60_000).toISOString(),
                modelId: 'google/gemini'
            }
        }
    };
    const refreshed = [];
    controller.requestLaneAccess = async (targetSession, entry) => {
        refreshed.push(entry.laneId);
        return controller.setLaneAccess(targetSession, entry.laneId, {
            key: 'synthesis-new-key',
            modelId: entry.id,
            expiresAt: new Date(Date.now() + 60_000).toISOString()
        });
    };

    const result = await controller.sendLaneMessagesCompletion({
        session,
        entry: { laneId: 'synthesis', id: 'google/gemini', name: 'Gemini' },
        messages: [{ role: 'user', content: 'synthesize' }],
        searchEnabled: false,
        abortController: null
    });

    assert.equal(result.content, 'council synthesis');
    assert.deepEqual(refreshed, ['synthesis']);
    assert.deepEqual(sendTokens, [
        { modelId: 'google/gemini', token: 'synthesis-old-key' },
        { modelId: 'google/gemini', token: 'synthesis-new-key' }
    ]);
    assert.equal(session.councilAccess.primary.apiKey, 'primary-key');
    assert.equal(session.councilAccess.secondary.apiKey, 'secondary-key');
    assert.equal(session.councilAccess.synthesis.apiKey, 'synthesis-new-key');
    assert.equal(savedSessions[0].councilAccess.synthesis.apiKey, null);
});

function createRunTurnHarness({ councilConfig = {}, sendLaneCompletion, runSynthesisCompletion, messages = null } = {}) {
    const savedMessages = [];
    const savedSessions = [];
    const memoryExtractionCalls = [];
    const userMessage = {
        id: 'user-1',
        sessionId: 'session-1',
        role: 'user',
        content: 'Explain the issue.',
        timestamp: Date.now()
    };
    const session = {
        id: 'session-1',
        model: 'GPT',
        responseMode: 'council',
        councilConfig: {
            enabled: true,
            members: ['GPT', 'Claude'],
            synthesisModel: 'Gemini',
            outputMode: 'council',
            reviewEnabled: false,
            ...councilConfig
        },
        councilAccess: {}
    };
    const chatDB = {
        getSessionMessages: async () => messages || [userMessage],
        saveMessage: async (message) => {
            savedMessages.push(JSON.parse(JSON.stringify(message)));
        },
        saveSession: async (targetSession) => {
            savedSessions.push(JSON.parse(JSON.stringify(targetSession)));
        },
        deleteMessage: async () => {}
    };
    const controller = createController({
        ticketCount: 10,
        models: [
            { id: 'openai/gpt', name: 'GPT' },
            { id: 'anthropic/claude', name: 'Claude' },
            { id: 'google/gemini', name: 'Gemini' }
        ],
        chatDB,
        inferenceService: {
            getDefaultModelName: () => 'GPT'
        }
    });
    Object.assign(controller.app, {
        loadModels: async () => {},
        addMessage: async () => {},
        isViewingSession: () => false,
        showTypingIndicator: () => null,
        removeTypingIndicator: () => {},
        generateSessionTitleIfNeeded: () => Promise.resolve(),
        sanitizeMessagesForApi: (messages) => messages,
        refreshSessionConversationSearchText: async () => {},
        renderSessions: () => {},
        triggerPostTurnMemoryExtraction: (targetSession) => {
            memoryExtractionCalls.push(targetSession?.id || null);
        },
        enrichCitationsAndUpdateUI: () => {},
        clearSessionTitleGenerationPending: async () => {},
        generateId: (() => {
            let counter = 0;
            return () => `assistant-${counter += 1}`;
        })(),
        getFallbackModelEntry: () => ({ id: 'openai/gpt', name: 'GPT' })
    });
    controller.ensureAccessForEntries = async () => {};
    controller.assertSufficientTicketsForEntries = () => 0;
    if (sendLaneCompletion) {
        controller.sendLaneCompletion = sendLaneCompletion;
    }
    if (runSynthesisCompletion) {
        controller.runSynthesisCompletion = runSynthesisCompletion;
    }
    return { controller, session, userMessage, savedMessages, savedSessions, memoryExtractionCalls };
}

test('runMultiModelTurn stores successful synthesis as canonical message content', async () => {
    const synthesisCalls = [];
    const { controller, session, userMessage, savedMessages } = createRunTurnHarness({
        sendLaneCompletion: async ({ entry }) => ({ content: `${entry.name} first response` }),
        runSynthesisCompletion: async (request) => {
            synthesisCalls.push(request);
            return { content: 'Council final answer' };
        }
    });

    await controller.runMultiModelTurn({
        session,
        userMessage,
        searchEnabled: false,
        abortController: new AbortController(),
        initialPendingPhase: 'requesting-key'
    });

    const finalMessage = savedMessages.at(-1);
    assert.equal(finalMessage.content, 'Council final answer');
    assert.equal(finalMessage.model, 'Council');
    assert.equal(finalMessage.council.synthesis.status, 'complete');
    assert.equal(finalMessage.council.synthesis.modelId, 'google/gemini');
    assert.equal(finalMessage.council.stage1.length, 2);
    assert.equal(synthesisCalls.length, 1);
    assert.equal(synthesisCalls[0].synthesisEntry.laneId, 'synthesis');
});

test('runMultiModelTurn sends one memory-processed prompt to both lanes without duplicating it into synthesis context', async () => {
    const stageRequests = [];
    const processCalls = [];
    const synthesisMessages = [];
    const { controller, session, userMessage, savedMessages } = createRunTurnHarness({
        runSynthesisCompletion: async ({ sanitizedMessages }) => {
            synthesisMessages.push(JSON.parse(JSON.stringify(sanitizedMessages)));
            return { content: 'Council final answer' };
        }
    });
    controller.app.processMessagesWithFiles = (messages, modelId) => {
        processCalls.push({
            modelId,
            messages: JSON.parse(JSON.stringify(messages))
        });
        return messages.map((message) => message.role === 'user'
            ? { ...message, content: 'Explain the issue with approved memory.' }
            : message
        );
    };
    controller.inferenceService.sendCompletionStrict = async (messages, modelId) => {
        stageRequests.push({
            modelId,
            lastUserContent: messages.findLast((message) => message.role === 'user')?.content || ''
        });
        return { content: `${modelId} response` };
    };

    await controller.runMultiModelTurn({
        session,
        userMessage,
        searchEnabled: false,
        abortController: new AbortController(),
        initialPendingPhase: 'requesting-key'
    });

    assert.deepEqual(processCalls.map((call) => call.modelId), ['openai/gpt', 'anthropic/claude']);
    assert.deepEqual(stageRequests, [
        { modelId: 'openai/gpt', lastUserContent: 'Explain the issue with approved memory.' },
        { modelId: 'anthropic/claude', lastUserContent: 'Explain the issue with approved memory.' }
    ]);
    assert.equal(synthesisMessages.length, 1);
    assert.equal(synthesisMessages[0].findLast((message) => message.role === 'user')?.content, 'Explain the issue.');
    assert.equal(savedMessages.at(-1).content, 'Council final answer');
});

test('runMultiModelTurn saves pending lane cards before acquiring access', async () => {
    const accessSnapshots = [];
    const { controller, session, userMessage, savedMessages } = createRunTurnHarness({
        councilConfig: { outputMode: 'parallel' },
        sendLaneCompletion: async ({ entry }) => ({ content: `${entry.name} first response` })
    });
    let showTypingCalls = 0;
    controller.app.isViewingSession = () => true;
    controller.app.showTypingIndicator = () => {
        showTypingCalls += 1;
        return 'typing-should-not-render';
    };
    controller.ensureAccessForEntries = async (_session, entries) => {
        accessSnapshots.push({
            laneIds: entries.map((entry) => entry.laneId),
            savedMessage: JSON.parse(JSON.stringify(savedMessages.at(-1)))
        });
    };

    await controller.runMultiModelTurn({
        session,
        userMessage,
        searchEnabled: false,
        abortController: new AbortController(),
        initialPendingPhase: 'requesting-key'
    });

    assert.equal(showTypingCalls, 0);
    assert.equal(accessSnapshots.length, 1);
    assert.deepEqual(accessSnapshots[0].laneIds, ['primary', 'secondary']);
    assert.deepEqual(
        accessSnapshots[0].savedMessage.council.stage1.map((entry) => ({
            model: entry.model,
            status: entry.status
        })),
        [
            { model: 'GPT', status: 'pending' },
            { model: 'Claude', status: 'pending' }
        ]
    );
});

test('runMultiModelTurn skips synthesis in parallel output mode', async () => {
    let synthesisCalls = 0;
    const accessEntryBatches = [];
    const { controller, session, userMessage, savedMessages } = createRunTurnHarness({
        councilConfig: { outputMode: 'parallel' },
        sendLaneCompletion: async ({ entry }) => ({ content: `${entry.name} first response` }),
        runSynthesisCompletion: async () => {
            synthesisCalls += 1;
            return { content: 'should not run' };
        }
    });
    controller.ensureAccessForEntries = async (_session, entries) => {
        accessEntryBatches.push(entries.map((entry) => entry.laneId));
        return 0;
    };

    await controller.runMultiModelTurn({
        session,
        userMessage,
        searchEnabled: false,
        abortController: new AbortController(),
        initialPendingPhase: 'requesting-key'
    });

    const finalMessage = savedMessages.at(-1);
    assert.equal(savedMessages[0].council.statusMessage, 'Waiting for responses...');
    assert.equal(finalMessage.content, 'GPT first response');
    assert.equal(finalMessage.model, 'GPT');
    assert.equal(finalMessage.council.synthesis, null);
    assert.equal(finalMessage.council.outputMode, 'parallel');
    assert.equal(finalMessage.council.statusMessage, null);
    assert.equal(synthesisCalls, 0);
    assert.deepEqual(accessEntryBatches, [['primary', 'secondary']]);
});

test('removeAssistantMessagesAfter can preserve the current local Memory Agent row during council regenerate', async () => {
    const deletedMessages = [];
    const controller = createController({
        chatDB: {
            getSessionMessages: async () => [
                { id: 'user-1', role: 'user', content: 'retry this' },
                { id: 'memory-1', role: 'assistant', model: 'memory agent', isLocalOnly: true },
                { id: 'assistant-1', role: 'assistant', model: 'Parallel' },
                { id: 'status-1', role: 'assistant', isLocalOnly: true }
            ],
            deleteMessage: async (messageId) => {
                deletedMessages.push(messageId);
            }
        }
    });
    controller.app.isViewingSession = () => false;

    await controller.removeAssistantMessagesAfter('session-1', 'user-1', { preserveLocalOnlyMessages: true });

    assert.deepEqual(deletedMessages, ['assistant-1']);
});

test('runMultiModelTurn triggers post-turn memory extraction in parallel output mode', async () => {
    const { controller, session, userMessage, memoryExtractionCalls } = createRunTurnHarness({
        councilConfig: { outputMode: 'parallel' },
        sendLaneCompletion: async ({ entry }) => ({ content: `${entry.name} first response` })
    });

    await controller.runMultiModelTurn({
        session,
        userMessage,
        searchEnabled: false,
        abortController: new AbortController(),
        initialPendingPhase: 'requesting-key'
    });

    assert.deepEqual(memoryExtractionCalls, ['session-1']);
});

test('runMultiModelTurn skips post-turn memory extraction when every lane fails', async () => {
    const { controller, session, userMessage, memoryExtractionCalls } = createRunTurnHarness({
        councilConfig: { outputMode: 'parallel' },
        sendLaneCompletion: async () => {
            throw new Error('lane failed');
        }
    });

    await controller.runMultiModelTurn({
        session,
        userMessage,
        searchEnabled: false,
        abortController: new AbortController(),
        initialPendingPhase: 'requesting-key'
    });

    assert.deepEqual(memoryExtractionCalls, []);
});

test('runMultiModelTurn uses each lane previous Stage 1 response in parallel output mode', async () => {
    const sentMessagesByLane = new Map();
    const previousUserMessage = {
        id: 'user-0',
        sessionId: 'session-1',
        role: 'user',
        content: 'First question',
        timestamp: Date.now() - 2
    };
    const previousCouncilMessage = {
        id: 'assistant-0',
        sessionId: 'session-1',
        role: 'assistant',
        content: 'Prior GPT response',
        model: 'GPT',
        timestamp: Date.now() - 1,
        council: {
            stage1: [
                {
                    label: 'Response A',
                    laneId: 'primary',
                    model: 'GPT',
                    modelId: 'openai/gpt',
                    status: 'complete',
                    response: 'Prior GPT response'
                },
                {
                    label: 'Response B',
                    laneId: 'secondary',
                    model: 'Claude',
                    modelId: 'anthropic/claude',
                    status: 'complete',
                    response: 'Prior Claude response'
                }
            ],
            synthesis: null,
            outputMode: 'parallel'
        }
    };
    const currentUserMessage = {
        id: 'user-1',
        sessionId: 'session-1',
        role: 'user',
        content: 'Second question',
        timestamp: Date.now()
    };
    const { controller, session, savedMessages } = createRunTurnHarness({
        councilConfig: { outputMode: 'parallel' },
        messages: [previousUserMessage, previousCouncilMessage, currentUserMessage],
        sendLaneCompletion: async ({ entry, sanitizedMessages }) => {
            sentMessagesByLane.set(entry.laneId, sanitizedMessages);
            return { content: `${entry.name} second response` };
        }
    });

    await controller.runMultiModelTurn({
        session,
        userMessage: currentUserMessage,
        searchEnabled: false,
        abortController: new AbortController(),
        initialPendingPhase: 'requesting-key'
    });

    const primaryAssistantHistory = sentMessagesByLane.get('primary').filter((message) => message.role === 'assistant');
    const secondaryAssistantHistory = sentMessagesByLane.get('secondary').filter((message) => message.role === 'assistant');
    assert.equal(primaryAssistantHistory[0].content, 'Prior GPT response');
    assert.equal(secondaryAssistantHistory[0].content, 'Prior Claude response');
    assert.ok(!sentMessagesByLane.get('primary').some((message) => message.content === 'Prior Claude response'));
    assert.ok(!sentMessagesByLane.get('secondary').some((message) => message.content === 'Prior GPT response'));
    assert.equal(savedMessages.at(-1).council.synthesis, null);
});

test('runRegenerateLaneTurn refreshes only the selected Parallel lane', async () => {
    const userMessage = {
        id: 'user-1',
        sessionId: 'session-1',
        role: 'user',
        content: 'Compare this',
        timestamp: Date.now() - 1
    };
    const assistantMessage = {
        id: 'assistant-1',
        sessionId: 'session-1',
        role: 'assistant',
        content: 'Original GPT response',
        model: 'GPT',
        timestamp: Date.now(),
        council: {
            stage1: [
                {
                    label: 'Response A',
                    laneId: 'primary',
                    model: 'GPT',
                    modelId: 'openai/gpt',
                    status: 'complete',
                    response: 'Original GPT response'
                },
                {
                    label: 'Response B',
                    laneId: 'secondary',
                    model: 'Claude',
                    modelId: 'anthropic/claude',
                    status: 'complete',
                    response: 'Original Claude response'
                }
            ],
            synthesis: null,
            outputMode: 'parallel',
            canonicalStage1Label: 'Response A',
            canonicalModel: 'GPT',
            errors: []
        }
    };
    const messages = [userMessage, assistantMessage];
    const savedMessages = [];
    const accessEntries = [];
    const sentMessagesByLane = new Map();
    const memoryExtractionCalls = [];
    const controller = createController({
        ticketCount: 10,
        models: [
            { id: 'openai/gpt', name: 'GPT' },
            { id: 'anthropic/claude', name: 'Claude' }
        ],
        chatDB: {
            getSessionMessages: async () => messages,
            saveMessage: async (message) => {
                savedMessages.push(JSON.parse(JSON.stringify(message)));
            },
            saveSession: async () => {}
        },
        inferenceService: {
            getDefaultModelName: () => 'GPT'
        }
    });
    Object.assign(controller.app, {
        loadModels: async () => {},
        sanitizeMessagesForApi: (targetMessages) => targetMessages,
        refreshSessionConversationSearchText: async () => {},
        renderSessions: () => {},
        isViewingSession: () => false,
        recomputeSessionCouncilTranscriptHint: async () => {},
        triggerPostTurnMemoryExtraction: (targetSession) => {
            memoryExtractionCalls.push(targetSession?.id || null);
        }
    });
    controller.ensureAccessForEntries = async (_session, entries) => {
        accessEntries.push(entries.map((entry) => entry.laneId));
    };
    controller.assertSufficientTicketsForEntries = () => 0;
    controller.sendLaneCompletion = async ({ entry, sanitizedMessages }) => {
        sentMessagesByLane.set(entry.laneId, sanitizedMessages);
        return { content: 'Regenerated Claude response' };
    };

    await controller.runRegenerateLaneTurn({
        session: {
            id: 'session-1',
            model: 'GPT',
            councilConfig: {
                members: ['GPT', 'Claude'],
                outputMode: 'parallel'
            },
            councilAccess: {}
        },
        assistantMessageId: 'assistant-1',
        laneId: 'secondary',
        userMessage,
        searchEnabled: false,
        abortController: new AbortController(),
        initialPendingPhase: 'requesting-key'
    });

    const finalMessage = savedMessages.at(-1);
    assert.deepEqual(accessEntries, [['secondary']]);
    assert.equal(finalMessage.council.stage1[0].response, 'Original GPT response');
    assert.equal(finalMessage.council.stage1[1].response, 'Regenerated Claude response');
    assert.equal(finalMessage.council.stage1[1].status, 'complete');
    assert.equal(finalMessage.content, 'Original GPT response');
    assert.equal(finalMessage.model, 'GPT');
    assert.deepEqual(sentMessagesByLane.get('secondary').map((message) => message.id), ['user-1']);
    assert.deepEqual(memoryExtractionCalls, ['session-1']);
});

test('runMultiModelTurn attempts partial synthesis when one Stage 1 lane succeeds', async () => {
    const { controller, session, userMessage, savedMessages } = createRunTurnHarness({
        sendLaneCompletion: async ({ entry }) => {
            if (entry.laneId === 'secondary') {
                throw new Error('secondary failed');
            }
            return { content: 'Primary first response' };
        },
        runSynthesisCompletion: async () => ({ content: 'Council answer from one response' })
    });

    await controller.runMultiModelTurn({
        session,
        userMessage,
        searchEnabled: false,
        abortController: new AbortController(),
        initialPendingPhase: 'requesting-key'
    });

    const finalMessage = savedMessages.at(-1);
    assert.equal(finalMessage.content, 'Council answer from one response');
    assert.equal(finalMessage.model, 'Council');
    assert.equal(finalMessage.council.synthesis.status, 'partial');
    assert.equal(finalMessage.council.stage1[1].status, 'error');
});

test('runMultiModelTurn preserves Stage 1 fallback and records synthesis failure state', async () => {
    const { controller, session, userMessage, savedMessages } = createRunTurnHarness({
        sendLaneCompletion: async ({ entry }) => ({ content: `${entry.name} first response` }),
        runSynthesisCompletion: async () => {
            throw new Error('synthesis unavailable');
        }
    });

    await controller.runMultiModelTurn({
        session,
        userMessage,
        searchEnabled: false,
        abortController: new AbortController(),
        initialPendingPhase: 'requesting-key'
    });

    const finalMessage = savedMessages.at(-1);
    assert.equal(finalMessage.content, 'GPT first response');
    assert.equal(finalMessage.model, 'GPT');
    assert.equal(finalMessage.council.synthesis.status, 'error');
    assert.equal(finalMessage.council.synthesis.fallbackUsed, true);
    assert.equal(finalMessage.council.synthesis.error, 'synthesis unavailable');
    assert.match(finalMessage.council.statusMessage, /Council synthesis failed\. Continuing from Response A\./);
});
