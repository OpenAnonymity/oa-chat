import test from 'node:test';
import assert from 'node:assert/strict';
import {
    acquireSessionAccess,
    buildVerifierSubmitKeyProof,
    isAccessCreditExhaustedError,
    persistVerifierSubmitKeyProof
} from '../../chat/application/accessController.js';

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
            targetSession.apiKey = result.key;
            targetSession.apiKeyInfo = result;
        },
        getVerificationAdapter: () => overrides.verifier ?? { supports: true },
        getAccessInfo: (targetSession) => ({
            token: targetSession.apiKey,
            info: targetSession.apiKeyInfo,
            expiresAt: null
        }),
        verifyAccess: async () => verification,
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
    assert.equal(isAccessCreditExhaustedError({ status: 402, data: { detail: 'unrelated billing text' } }), false);
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
    assert.equal(harness.session.apiKeyInfo.verifierSubmitKeyProof.status, 'verified');
    assert.deepEqual(harness.changed, ['session-1']);
    assert.equal(harness.savedSessions.length, 1);
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
    assert.equal(harness.savedSessions.length, 1);
    assert.deepEqual(harness.changed, []);
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
