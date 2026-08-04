import test from 'node:test';
import assert from 'node:assert/strict';
import {
    acquireSessionAccess,
    acquireVerifiedAccess,
    buildSafeAccessErrorMetadata,
    buildVerifierSubmitKeyProof,
    isAccessCreditExhaustedError,
    persistVerifierSubmitKeyProof
} from '../../chat/application/accessController.js';

test('buildSafeAccessErrorMetadata excludes messages and response bodies', () => {
    const metadata = buildSafeAccessErrorMetadata({
        name: 'ProviderError',
        code: 'ACCESS_FAILED',
        status: 503,
        retryable: true,
        message: 'secret-key prompt text',
        response: { data: { key: 'secret-key' } }
    });

    assert.deepEqual(metadata, {
        name: 'ProviderError',
        code: 'ACCESS_FAILED',
        status: 503,
        retryable: true
    });
    assert.doesNotMatch(JSON.stringify(metadata), /secret-key|prompt text/);
});

function createAccessHarness(overrides = {}) {
    const session = {
        id: 'session-1',
        model: 'Model A',
        apiKey: null,
        apiKeyInfo: null,
        shareInfo: { apiKeyShared: true }
    };
    const savedSessions = [];
    const requested = [];
    const warnings = [];
    const changed = [];
    const networkSessions = [];
    const ticketUsed = [];
    const verificationInputs = [];
    const setAccessCalls = [];
    const accessResult = { key: 'secret-key', stationId: 'station-a' };
    const verification = overrides.verification ?? {
        status: 'verified',
        data: { key_hash: 'verifier-hash', retryable: false }
    };

    const inferenceService = {
        getDefaultModelName: () => 'Model A',
        requestAccess: async (targetSession, request) => {
            requested.push({ targetSession, request });
            if (overrides.requestAccess) {
                return overrides.requestAccess(targetSession, request, requested.length);
            }
            return accessResult;
        },
        setAccessInfo: (targetSession, result) => {
            setAccessCalls.push(result);
            targetSession.apiKey = result.key;
            targetSession.apiKeyInfo = result;
        },
        getVerificationAdapter: () => overrides.verifier ?? { supports: true },
        getAccessInfo: (targetSession) => ({
            token: targetSession.apiKey,
            info: targetSession.apiKeyInfo,
            expiresAt: null
        }),
        verifyAccess: async (targetSession, accessInfo) => {
            verificationInputs.push({
                accessInfo,
                activeKeyDuringVerification: targetSession.apiKey
            });
            if (overrides.verifyAccess) {
                return overrides.verifyAccess(targetSession, accessInfo);
            }
            return verification;
        },
        clearAccessInfo: (targetSession) => {
            targetSession.apiKey = null;
            targetSession.apiKeyInfo = null;
        },
        setCurrentAccess: (targetSession, info) => {
            targetSession.currentAccess = info;
        },
        getAccessToken: (targetSession) => targetSession.apiKey
    };

    return {
        session,
        requested,
        warnings,
        changed,
        networkSessions,
        ticketUsed,
        verificationInputs,
        setAccessCalls,
        inferenceService,
        ticketClient: {
            getTicketCount: () => overrides.ticketCount ?? 5
        },
        chatDB: {
            saveSession: async (targetSession) => {
                savedSessions.push({ ...targetSession });
            }
        },
        getTicketCost: overrides.getTicketCost || (() => 2),
        getFallbackModelEntry: () => ({ id: 'model-a', name: 'Model A' }),
        callbacks: {
            onTicketUsed: (retry) => ticketUsed.push(retry),
            onNetworkSession: (sessionId) => networkSessions.push(sessionId),
            onVerificationWarning: (...args) => warnings.push(args),
            onSessionChanged: (targetSession) => changed.push(targetSession.id)
        },
        savedSessions
    };
}

test('isAccessCreditExhaustedError recognizes OpenRouter credit exhaustion shapes', () => {
    assert.equal(isAccessCreditExhaustedError({ status: 401, message: 'credits' }), false);
    assert.equal(isAccessCreditExhaustedError({ status: 402, message: 'More credits required' }), true);
    assert.equal(isAccessCreditExhaustedError({ status: 402, data: { error: { message: 'Can only afford 1 max_tokens' } } }), true);
    assert.equal(isAccessCreditExhaustedError({ status: 402, responseData: { error: { message: 'Can only afford 1 max_tokens' } } }), true);
    assert.equal(isAccessCreditExhaustedError({ status: 402, data: { detail: 'unrelated error text' } }), false);
});

test('buildVerifierSubmitKeyProof normalizes verifier and org key fields', () => {
    const proof = buildVerifierSubmitKeyProof(
        {
            status: 'unverified',
            data: { detail: 'ownership_check_error', key_hash: 'verifier-hash', retryable: true },
            error: { message: 'temporary' }
        },
        {
            station_name: 'station-a',
            key_hash: 'org-hash'
        },
        { now: () => '2026-05-06T00:00:00.000Z' }
    );

    assert.deepEqual(proof, {
        recordedAt: '2026-05-06T00:00:00.000Z',
        status: 'unverified',
        detail: 'ownership_check_error',
        stationId: 'station-a',
        keyHashFromOrg: 'org-hash',
        keyHashFromVerifier: 'verifier-hash',
        verifierResponse: { detail: 'ownership_check_error', key_hash: 'verifier-hash', retryable: true },
        retryable: true,
        error: 'temporary',
        bannedStation: null
    });
});

test('buildVerifierSubmitKeyProof never persists child keys from verifier diagnostics', () => {
    const proof = buildVerifierSubmitKeyProof(
        {
            status: 'rejected',
            data: {
                api_key: 'secret-key',
                key_hash: 'secret-key',
                nested: { echoed: 'failure for secret-key' }
            },
            error: { message: 'rejected secret-key' }
        },
        {
            key: 'secret-key',
            stationId: 'secret-key',
            keyHash: 'secret-key'
        }
    );

    const serialized = JSON.stringify(proof);
    assert.doesNotMatch(serialized, /secret-key/);
    assert.equal(proof.verifierResponse.api_key, '[REDACTED]');
    assert.equal(proof.verifierResponse.nested.echoed, 'failure for [REDACTED]');
    assert.equal(proof.stationId, '[REDACTED]');
    assert.equal(proof.keyHashFromOrg, '[REDACTED]');
    assert.equal(proof.keyHashFromVerifier, '[REDACTED]');
});

test('persistVerifierSubmitKeyProof writes proof onto active api key info', () => {
    const session = { apiKeyInfo: { stationId: 'station-a' } };
    persistVerifierSubmitKeyProof(
        session,
        { status: 'verified', data: { key_hash: 'hash' } },
        { now: () => 'now' }
    );

    assert.equal(session.apiKeyInfo.verifierSubmitKeyProof.status, 'verified');
    assert.equal(session.apiKeyInfo.verifierSubmitKeyProof.stationId, 'station-a');
});

test('acquireSessionAccess requests tickets, verifies access, saves, and clears shared flag', async () => {
    const harness = createAccessHarness();

    const token = await acquireSessionAccess({
        session: harness.session,
        models: [{ id: 'model-a', name: 'Model A' }],
        reasoningEnabled: true,
        inferenceService: harness.inferenceService,
        ticketClient: harness.ticketClient,
        chatDB: harness.chatDB,
        getTicketCost: harness.getTicketCost,
        getFallbackModelEntry: harness.getFallbackModelEntry,
        ...harness.callbacks
    });

    assert.equal(token, 'secret-key');
    assert.deepEqual(harness.requested.map(item => item.request), [{ ticketsRequired: 2 }]);
    assert.deepEqual(harness.networkSessions, ['session-1']);
    assert.equal(harness.session.shareInfo.apiKeyShared, false);
    assert.equal(harness.session.currentAccess.key, 'secret-key');
    assert.equal(harness.session.apiKeyInfo.modelId, 'model-a');
    assert.equal(harness.session.apiKeyInfo.modelName, 'Model A');
    assert.equal(harness.session.apiKeyInfo.verifierSubmitKeyProof.status, 'verified');
    assert.equal(harness.verificationInputs[0].activeKeyDuringVerification, null);
    assert.equal(harness.verificationInputs[0].accessInfo.key, 'secret-key');
    assert.equal(harness.setAccessCalls.length, 1);
    assert.deepEqual(harness.changed, ['session-1']);
    assert.equal(harness.savedSessions.length, 1);
});

test('acquireVerifiedAccess returns approved access without activating or persisting it', async () => {
    const harness = createAccessHarness();

    const result = await acquireVerifiedAccess({
        session: harness.session,
        models: [{ id: 'model-a', name: 'Model A' }],
        reasoningEnabled: false,
        inferenceService: harness.inferenceService,
        ticketClient: harness.ticketClient,
        getTicketCost: harness.getTicketCost,
        getFallbackModelEntry: harness.getFallbackModelEntry,
        ...harness.callbacks
    });

    assert.equal(result.key, 'secret-key');
    assert.equal(result.verifierSubmitKeyProof.status, 'verified');
    assert.equal(harness.session.apiKey, null);
    assert.equal(harness.session.apiKeyInfo, null);
    assert.equal(harness.setAccessCalls.length, 0);
    assert.equal(harness.savedSessions.length, 0);
});

test('acquireVerifiedAccess returns only redacted proof evidence when verification fails', async () => {
    const harness = createAccessHarness({
        verification: {
            status: 'pending',
            detail: 'waiting for secret-key',
            data: { detail: 'waiting for secret-key', api_key: 'secret-key' }
        }
    });

    await assert.rejects(
        acquireVerifiedAccess({
            session: harness.session,
            models: [{ id: 'model-a', name: 'Model A' }],
            reasoningEnabled: false,
            inferenceService: harness.inferenceService,
            ticketClient: harness.ticketClient,
            getTicketCost: harness.getTicketCost,
            getFallbackModelEntry: harness.getFallbackModelEntry,
            ...harness.callbacks
        }),
        (error) => {
            assert.equal(error.code, 'ACCESS_VERIFICATION_FAILED');
            assert.equal(error.verifierSubmitKeyProof.status, 'pending');
            assert.doesNotMatch(JSON.stringify(error.verifierSubmitKeyProof), /secret-key/);
            return true;
        }
    );

    assert.equal(harness.session.apiKey, null);
    assert.equal(harness.session.apiKeyInfo, null);
    assert.equal('lastVerifierSubmitKeyProof' in harness.session, false);
    assert.equal(harness.savedSessions.length, 0);
});

test('acquireSessionAccess rejects unverified access without activating the key', async () => {
    const harness = createAccessHarness({
        verification: {
            status: 'unverified',
            detail: 'ownership_check_error',
            data: { detail: 'ownership_check_error', retryable: false }
        }
    });

    await assert.rejects(
        acquireSessionAccess({
            session: harness.session,
            models: [{ id: 'model-a', name: 'Model A' }],
            reasoningEnabled: false,
            inferenceService: harness.inferenceService,
            ticketClient: harness.ticketClient,
            chatDB: harness.chatDB,
            getTicketCost: harness.getTicketCost,
            getFallbackModelEntry: harness.getFallbackModelEntry,
            ...harness.callbacks
        }),
        /Key verification required: ownership_check_error/
    );

    assert.equal(harness.session.apiKey, null);
    assert.equal(harness.session.apiKeyInfo, null);
    assert.equal(harness.session.lastVerifierSubmitKeyProof.status, 'unverified');
    assert.equal(harness.setAccessCalls.length, 0);
    assert.equal(harness.verificationInputs[0].activeKeyDuringVerification, null);
});

test('acquireSessionAccess uses model override for ticket cost without mutating session model', async () => {
    const harness = createAccessHarness({
        getTicketCost: (modelId) => modelId === 'model-instant' ? 1 : 4
    });

    const token = await acquireSessionAccess({
        session: harness.session,
        models: [
            { id: 'model-a', name: 'Model A' },
            { id: 'model-instant', name: 'OpenAI: GPT-5.3 Instant' }
        ],
        reasoningEnabled: false,
        inferenceService: harness.inferenceService,
        ticketClient: harness.ticketClient,
        chatDB: harness.chatDB,
        getTicketCost: harness.getTicketCost,
        getFallbackModelEntry: harness.getFallbackModelEntry,
        modelNameOverride: 'OpenAI: GPT-5.3 Instant',
        ...harness.callbacks
    });

    assert.equal(token, 'secret-key');
    assert.deepEqual(harness.requested.map(item => item.request), [{ ticketsRequired: 1 }]);
    assert.equal(harness.session.model, 'Model A');
});

test('acquireSessionAccess uses model id override when display name does not match catalog', async () => {
    const harness = createAccessHarness({
        getTicketCost: (modelId) => modelId === 'model-instant' ? 1 : 4
    });

    const token = await acquireSessionAccess({
        session: harness.session,
        models: [
            { id: 'model-a', name: 'Model A' },
            { id: 'model-instant', name: 'Raw Provider GPT Chat Name' }
        ],
        reasoningEnabled: false,
        inferenceService: harness.inferenceService,
        ticketClient: harness.ticketClient,
        chatDB: harness.chatDB,
        getTicketCost: harness.getTicketCost,
        getFallbackModelEntry: harness.getFallbackModelEntry,
        modelIdOverride: 'model-instant',
        modelNameOverride: 'OpenAI: GPT-5.3 Instant',
        ...harness.callbacks
    });

    assert.equal(token, 'secret-key');
    assert.deepEqual(harness.requested.map(item => item.request), [{ ticketsRequired: 1 }]);
    assert.equal(harness.session.model, 'Model A');
});

test('acquireSessionAccess retries spent tickets before succeeding', async () => {
    const harness = createAccessHarness({
        requestAccess: async (targetSession, request, attempt) => {
            if (attempt === 1) {
                const error = new Error('used');
                error.code = 'TICKET_USED';
                throw error;
            }
            return { key: 'fresh-key', stationId: 'station-b' };
        }
    });

    const token = await acquireSessionAccess({
        session: harness.session,
        models: [{ id: 'model-a', name: 'Model A' }],
        reasoningEnabled: false,
        inferenceService: harness.inferenceService,
        ticketClient: harness.ticketClient,
        chatDB: harness.chatDB,
        getTicketCost: harness.getTicketCost,
        getFallbackModelEntry: harness.getFallbackModelEntry,
        ...harness.callbacks
    });

    assert.equal(token, 'fresh-key');
    assert.equal(harness.requested.length, 2);
    assert.deepEqual(harness.ticketUsed, [1]);
});

test('acquireSessionAccess can request an explicit ticket budget', async () => {
    const harness = createAccessHarness({
        getTicketCost: () => 1
    });

    await acquireSessionAccess({
        session: harness.session,
        models: [{ id: 'model-a', name: 'Model A' }],
        reasoningEnabled: false,
        inferenceService: harness.inferenceService,
        ticketClient: harness.ticketClient,
        chatDB: harness.chatDB,
        getTicketCost: harness.getTicketCost,
        getFallbackModelEntry: harness.getFallbackModelEntry,
        ticketsRequiredOverride: 4,
        ticketRequirementLabel: 'multi-model response',
        ...harness.callbacks
    });

    assert.deepEqual(harness.requested.map(item => item.request), [{ ticketsRequired: 4 }]);
});

test('acquireSessionAccess validates explicit ticket budget before network calls', async () => {
    const harness = createAccessHarness({ ticketCount: 2 });

    await assert.rejects(
        acquireSessionAccess({
            session: harness.session,
            models: [{ id: 'model-a', name: 'Model A' }],
            reasoningEnabled: false,
            inferenceService: harness.inferenceService,
            ticketClient: harness.ticketClient,
            chatDB: harness.chatDB,
            getTicketCost: () => 1,
            getFallbackModelEntry: harness.getFallbackModelEntry,
            ticketsRequiredOverride: 4,
            ticketRequirementLabel: 'multi-model response',
            ...harness.callbacks
        }),
        /Not enough tickets for multi-model response. Need 4, but only 2 available./
    );

    assert.equal(harness.requested.length, 0);
});

test('acquireSessionAccess clears and saves rejected verifier access', async () => {
    const harness = createAccessHarness({
        verification: {
            status: 'rejected',
            error: { message: 'signature mismatch' }
        }
    });

    await assert.rejects(
        acquireSessionAccess({
            session: harness.session,
            models: [{ id: 'model-a', name: 'Model A' }],
            reasoningEnabled: false,
            inferenceService: harness.inferenceService,
            ticketClient: harness.ticketClient,
            chatDB: harness.chatDB,
            getTicketCost: harness.getTicketCost,
            getFallbackModelEntry: harness.getFallbackModelEntry,
            ...harness.callbacks
        }),
        /Key verification failed: signature mismatch/
    );

    assert.equal(harness.session.apiKey, null);
    assert.equal(harness.session.apiKeyInfo, null);
    assert.equal(harness.session.lastVerifierSubmitKeyProof.status, 'rejected');
    assert.equal(harness.savedSessions.length, 1);
    assert.deepEqual(harness.changed, ['session-1']);
});

for (const [status, expected] of [
    ['pending', /Key verification pending/],
    ['unknown', /Key verification failed/]
]) {
    test(`acquireSessionAccess fails closed for ${status} verifier status`, async () => {
        const harness = createAccessHarness({
            verification: { status, detail: `${status}_detail` }
        });

        await assert.rejects(
            acquireSessionAccess({
                session: harness.session,
                models: [{ id: 'model-a', name: 'Model A' }],
                reasoningEnabled: false,
                inferenceService: harness.inferenceService,
                ticketClient: harness.ticketClient,
                chatDB: harness.chatDB,
                getTicketCost: harness.getTicketCost,
                getFallbackModelEntry: harness.getFallbackModelEntry,
                ...harness.callbacks
            }),
            expected
        );

        assert.equal(harness.session.apiKey, null);
        assert.equal(harness.setAccessCalls.length, 0);
    });
}

test('acquireSessionAccess clears provisional access when verification throws', async () => {
    const harness = createAccessHarness({
        verifyAccess: async () => {
            throw new Error('verifier network failure');
        }
    });

    await assert.rejects(
        acquireSessionAccess({
            session: harness.session,
            models: [{ id: 'model-a', name: 'Model A' }],
            reasoningEnabled: false,
            inferenceService: harness.inferenceService,
            ticketClient: harness.ticketClient,
            chatDB: harness.chatDB,
            getTicketCost: harness.getTicketCost,
            getFallbackModelEntry: harness.getFallbackModelEntry,
            ...harness.callbacks
        }),
        /verifier network failure/
    );

    assert.equal(harness.session.apiKey, null);
    assert.equal(harness.setAccessCalls.length, 0);
});

test('acquireSessionAccess rejects insufficient tickets before network calls', async () => {
    const harness = createAccessHarness({ ticketCount: 1 });

    await assert.rejects(
        acquireSessionAccess({
            session: harness.session,
            models: [{ id: 'model-a', name: 'Model A' }],
            reasoningEnabled: true,
            inferenceService: harness.inferenceService,
            ticketClient: harness.ticketClient,
            chatDB: harness.chatDB,
            getTicketCost: () => 2,
            getFallbackModelEntry: harness.getFallbackModelEntry,
            ...harness.callbacks
        }),
        /Not enough tickets/
    );

    assert.equal(harness.requested.length, 0);
    assert.deepEqual(harness.networkSessions, []);
});

test('acquireSessionAccess rejects an aborted signal before network calls', async () => {
    const harness = createAccessHarness();
    const controller = new AbortController();
    controller.abort();

    await assert.rejects(
        acquireSessionAccess({
            session: harness.session,
            models: [{ id: 'model-a', name: 'Model A' }],
            reasoningEnabled: true,
            inferenceService: harness.inferenceService,
            ticketClient: harness.ticketClient,
            chatDB: harness.chatDB,
            getTicketCost: harness.getTicketCost,
            getFallbackModelEntry: harness.getFallbackModelEntry,
            signal: controller.signal,
            ...harness.callbacks
        }),
        /Request aborted/
    );

    assert.equal(harness.requested.length, 0);
    assert.equal(harness.savedSessions.length, 0);
    assert.deepEqual(harness.networkSessions, []);
});
