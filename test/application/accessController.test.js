import test from 'node:test';
import assert from 'node:assert/strict';
import { recordedTrustedAccess, recordedTrustedResult } from '../helpers/trustedStation.js';
import {
    acquireSessionAccess,
    acquireVerifiedAccess,
    buildSafeAccessErrorMetadata,
    buildVerifierSubmitKeyProof,
    isAccessCreditExhaustedError,
    persistVerifierSubmitKeyProof
} from '../../chat/application/accessController.js';

test('an explicitly composed access implementation does not require ticket dependencies', async () => {
    const session = { id: 'custom-session', shareInfo: { apiKeyShared: true } };
    const saves = [];
    const customAccess = { token: 'opaque-chat-binding' };
    const service = {
        setAccessInfo: (target, info) => { target.access = info; },
        getAccessToken: target => target.access?.token,
        getVerificationAdapter: () => ({ supports: false })
    };
    const token = await acquireSessionAccess({
        session,
        inferenceService: service,
        chatDB: { saveSession: async target => saves.push(target) },
        acquireAccess: async options => {
            assert.equal(options.session, session);
            return customAccess;
        }
    });
    assert.equal(token, 'opaque-chat-binding');
    assert.equal(saves.length, 1);
    assert.equal(session.shareInfo.apiKeyShared, false);
});

test('custom access failure or late cancellation never activates a credential', async () => {
    for (const abortAfterGrant of [false, true]) {
        const controller = new AbortController();
        let activated = false;
        let saved = false;
        await assert.rejects(acquireSessionAccess({
            session: { id: 'custom-session' },
            inferenceService: { setAccessInfo: () => { activated = true; } },
            chatDB: { saveSession: async () => { saved = true; } },
            signal: controller.signal,
            acquireAccess: async () => {
                if (abortAfterGrant) {
                    controller.abort();
                    return { token: 'do-not-activate' };
                }
                throw new Error('Custom access unavailable');
            }
        }), abortAfterGrant ? /aborted/ : /Custom access unavailable/);
        assert.equal(activated, false);
        assert.equal(saved, false);
    }
});

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
    const accessResult = overrides.accessResult ?? { key: 'secret-key', stationId: 'station-a' };
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
            getTicketCount: () => (
                typeof overrides.ticketCount === 'function'
                    ? overrides.ticketCount()
                    : overrides.ticketCount ?? 5
            )
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

test('isAccessCreditExhaustedError recognizes the 403 "Key limit exceeded" shape OpenRouter sends since October 2026', () => {
    const spent = 'Key limit exceeded (total limit). Manage it using https://openrouter.ai/settings/keys';
    // The 403 body carries no metadata; the words are the only signal.
    assert.equal(isAccessCreditExhaustedError({ status: 403, message: spent, data: { error: { message: spent, code: 403 } } }), true);
    assert.equal(isAccessCreditExhaustedError({ status: 403, message: 'Key limit exceeded (daily limit). Manage it using https://openrouter.ai/settings/keys' }), true);
    // Display text may be rewritten; the retained original still decides.
    assert.equal(isAccessCreditExhaustedError({ status: 403, message: 'Forbidden.', creditRecoveryMessage: spent }), true);
    // Other 403s keep the key: a refresh spends a ticket.
    assert.equal(isAccessCreditExhaustedError({ status: 403, message: 'Your input was flagged for moderation', data: { error: { message: 'Your input was flagged for moderation', code: 403 } } }), false);
    assert.equal(isAccessCreditExhaustedError({ status: 403, message: 'Insufficient credits' }), false);
    assert.equal(isAccessCreditExhaustedError({ status: 403 }), false);
    // The old 402 shape keeps working.
    assert.equal(isAccessCreditExhaustedError({ status: 402, message: spent, data: { error: { message: spent, metadata: { limit_source: 'openrouter_key_limit' } } } }), true);
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

test('explicit loopback bypass skips the verifier without claiming verified status', async () => {
    const harness = createAccessHarness({
        verifier: {
            supports: true,
            allowsLocalBypass: () => true
        }
    });

    const result = await acquireVerifiedAccess({
        session: harness.session,
        models: [{ id: 'model-a', name: 'Model A' }],
        reasoningEnabled: true,
        inferenceService: harness.inferenceService,
        ticketClient: harness.ticketClient,
        getTicketCost: harness.getTicketCost,
        getFallbackModelEntry: harness.getFallbackModelEntry,
        ...harness.callbacks
    });

    assert.equal(result.key, 'secret-key');
    assert.equal(result.verifierSubmitKeyProof.status, 'local-loopback-bypass');
    assert.equal(result.verifierSubmitKeyProof.detail, 'explicit_loopback_development');
    assert.equal(harness.verificationInputs.length, 0);
    assert.equal(harness.setAccessCalls.length, 0);
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

// A wallet whose tickets the org has already seen: each refusal sets one
// ticket aside (the store shrinks by one), as the real ticket store does.
function createStaleWalletHarness({ stale, tickets, ticketsRequired = 2, onAttempt = null }) {
    let remaining = tickets;
    let attempts = 0;
    const sweeps = [];
    const harness = createAccessHarness({
        ticketCount: () => remaining,
        getTicketCost: () => ticketsRequired,
        requestAccess: async () => {
            attempts += 1;
            await onAttempt?.(attempts);
            if (remaining < ticketsRequired) {
                throw Object.assign(new Error('Not enough tickets.'), {
                    code: remaining === 0 ? 'NO_TICKETS' : 'INSUFFICIENT_TICKETS', availableTickets: remaining
                });
            }
            if (attempts <= stale) {
                remaining -= 1;
                throw Object.assign(new Error('used'), { code: 'TICKET_USED', consumeTickets: true });
            }
            remaining -= ticketsRequired;
            return { key: 'fresh-key', stationId: 'station-b' };
        }
    });
    harness.callbacks.onTicketSweepEnd = outcome => sweeps.push(outcome);
    harness.sweeps = sweeps;
    harness.remaining = () => remaining;
    return harness;
}

function acquireWith(harness, extra = {}) {
    return acquireSessionAccess({
        session: harness.session,
        models: [{ id: 'model-a', name: 'Model A' }],
        reasoningEnabled: false,
        inferenceService: harness.inferenceService,
        ticketClient: harness.ticketClient,
        chatDB: harness.chatDB,
        getTicketCost: harness.getTicketCost,
        getFallbackModelEntry: harness.getFallbackModelEntry,
        ...harness.callbacks,
        ...extra
    });
}

test('acquireSessionAccess retries spent tickets before succeeding', async () => {
    const harness = createStaleWalletHarness({ stale: 1, tickets: 5 });
    const token = await acquireWith(harness);
    assert.equal(token, 'fresh-key');
    assert.equal(harness.requested.length, 2);
    assert.deepEqual(harness.ticketUsed, [1]);
    assert.deepEqual(harness.sweeps, [{ skipped: 1, removed: 1, recovered: true, reason: null, tier: 2 }]);
});

test('a sweep past already-used tickets is bounded by the wallet, not by ten', async () => {
    // 2026-10-14: a 477-ticket wallet whose first hundreds were spent from
    // another device stopped after ticketsRequired + 10 refusals with
    // "All available tickets were already spent" and a toast per refusal.
    const harness = createStaleWalletHarness({ stale: 120, tickets: 477, ticketsRequired: 3 });
    const token = await acquireWith(harness);
    assert.equal(token, 'fresh-key');
    assert.equal(harness.requested.length, 121);
    assert.equal(harness.ticketUsed.length, 120);
    assert.equal(harness.ticketUsed.at(-1), 120);
    assert.deepEqual(harness.sweeps, [{ skipped: 120, removed: 120, recovered: true, reason: null, tier: 3 }]);
    assert.equal(harness.remaining(), 477 - 120 - 3);
});

test('a wallet that runs out during the sweep becomes an ordinary shortage', async () => {
    const shortages = [];
    const harness = createStaleWalletHarness({ stale: 6, tickets: 6, ticketsRequired: 2 });
    await assert.rejects(acquireWith(harness, {
        onTicketShortage: shortage => { shortages.push(shortage); return { retry: false }; }
    }), { code: 'TICKET_SHORTAGE' });
    // Five refusals leave one ticket, which is not enough for two.
    assert.equal(harness.ticketUsed.length, 5);
    assert.deepEqual(shortages, [{ requiredTickets: 2, availableTickets: 1, label: 'this model' }]);
    assert.deepEqual(harness.sweeps, [{ skipped: 5, removed: 5, recovered: false, reason: 'TICKET_SHORTAGE', tier: 2 }]);
});

test('a refusal that does not shrink the wallet stops the sweep instead of looping', async () => {
    const harness = createAccessHarness({
        ticketCount: () => 5,
        requestAccess: async () => {
            throw Object.assign(new Error('used'), { code: 'TICKET_USED', consumeTickets: true });
        }
    });
    const sweeps = [];
    await assert.rejects(acquireWith(harness, { onTicketSweepEnd: outcome => sweeps.push(outcome) }),
        { code: 'TICKET_SWEEP_STALLED' });
    assert.equal(harness.requested.length, 1);
    assert.deepEqual(harness.ticketUsed, []);
    assert.deepEqual(sweeps, []);
});

test('Stop during a sweep cancels it and reports the sweep as not recovered', async () => {
    const controller = new AbortController();
    const harness = createStaleWalletHarness({
        stale: 50, tickets: 60, onAttempt: attempt => {
            if (attempt !== 4) return;
            // Stop lands while the fourth key request is in flight.
            controller.abort();
            throw Object.assign(new Error('Request aborted'), { name: 'AbortError', isCancelled: true });
        }
    });
    await assert.rejects(acquireWith(harness, { signal: controller.signal }), { name: 'AbortError' });
    assert.equal(harness.requested.length, 4);
    assert.deepEqual(harness.sweeps, [{ skipped: 3, removed: 3, recovered: false, reason: 'AbortError', tier: 2 }]);
});

test('a sweep hook that throws does not change the outcome', async () => {
    const harness = createStaleWalletHarness({ stale: 2, tickets: 5 });
    harness.callbacks.onTicketSweepEnd = () => { throw new Error('hook'); };
    assert.equal(await acquireWith(harness), 'fresh-key');
    assert.equal(harness.warnings.length, 1);
    assert.match(harness.warnings[0][0], /sweep hook/);
});

test('a refusal that sets a whole selection aside counts the tickets the wallet lost, not the refusals', async () => {
    // An org that names no failed_ticket.index: the client archives the
    // whole 3-ticket selection per refusal. The count shown ticks by what
    // the wallet actually lost.
    let remaining = 12;
    let attempts = 0;
    const harness = createAccessHarness({
        ticketCount: () => remaining,
        getTicketCost: () => 3,
        requestAccess: async () => {
            attempts += 1;
            if (attempts <= 2) {
                remaining -= 3;
                throw Object.assign(new Error('used'), { code: 'TICKET_USED', consumeTickets: true });
            }
            remaining -= 3;
            return { key: 'fresh-key', stationId: 'station-b' };
        }
    });
    const sweeps = [];
    assert.equal(await acquireWith(harness, { onTicketSweepEnd: outcome => sweeps.push(outcome) }), 'fresh-key');
    assert.deepEqual(harness.ticketUsed, [3, 6], 'the running count is tickets, not refusals');
    assert.deepEqual(sweeps, [{ skipped: 2, removed: 6, recovered: true, reason: null, tier: 3 }]);
});

test('several old signing-key generations ahead of the current tickets are all retired, bounded by the wallet, not by a count', async () => {
    // Review 2026-10-14 (ticket-rotation-repro.mjs): four invalidated
    // generations followed by four current tickets, a one-ticket model. A
    // hard three-retry cap stopped at the fourth refusal with "4 valid
    // tickets remain, but this model needs 1"; the baseline reached the
    // fifth request.
    let count = 8;
    let attempts = 0;
    const harness = createAccessHarness({
        ticketCount: () => count,
        getTicketCost: () => 1,
        requestAccess: async () => {
            attempts += 1;
            if (attempts <= 4) {
                count -= 1;
                throw Object.assign(new Error('old generation'), { code: 'TICKET_KEY_INVALIDATED' });
            }
            return { key: 'fresh-key', stationId: 'station-b' };
        }
    });
    assert.equal(await acquireWith(harness), 'fresh-key');
    assert.equal(attempts, 5);
    assert.equal(count, 4);
    assert.deepEqual(harness.ticketUsed, [], 'an invalidated generation is not an already-used ticket');
});

test('an invalidation that does not shrink the wallet stops instead of looping', async () => {
    const harness = createAccessHarness({
        ticketCount: () => 5,
        getTicketCost: () => 1,
        requestAccess: async () => {
            throw Object.assign(new Error('old generation'), { code: 'TICKET_KEY_INVALIDATED' });
        }
    });
    await assert.rejects(acquireWith(harness), { code: 'TICKET_SWEEP_STALLED', message: /Couldn’t update the tickets saved on this device/ });
    assert.equal(harness.requested.length, 1);
});

test('Stop during a run of invalidated generations cancels it', async () => {
    const controller = new AbortController();
    let count = 20;
    let attempts = 0;
    const harness = createAccessHarness({
        ticketCount: () => count,
        getTicketCost: () => 1,
        requestAccess: async () => {
            attempts += 1;
            if (attempts === 3) controller.abort();
            count -= 1;
            throw Object.assign(new Error('old generation'), { code: 'TICKET_KEY_INVALIDATED' });
        }
    });
    await assert.rejects(acquireWith(harness, { signal: controller.signal }), { name: 'AbortError' });
    assert.equal(attempts, 3);
});

test('acquireSessionAccess retries after an invalidated generation is removed', async () => {
    let remainingTickets = 4;
    const harness = createAccessHarness({
        ticketCount: () => remainingTickets,
        requestAccess: async (targetSession, request, attempt) => {
            if (attempt === 1) {
                remainingTickets = 2;
                const error = new Error('old generation');
                error.code = 'TICKET_KEY_INVALIDATED';
                error.invalidatedTicketsRemoved = 2;
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
});

test('acquireSessionAccess explains when rotation removes too many tickets', async () => {
    let remainingTickets = 2;
    const harness = createAccessHarness({
        ticketCount: () => remainingTickets,
        getTicketCost: () => 2,
        requestAccess: async () => {
            remainingTickets = 0;
            const error = new Error('old generation');
            error.code = 'TICKET_KEY_INVALIDATED';
            throw error;
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
        /rotated its ticket signing key.*Redeem a new invite code/
    );
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

test('outage access activates once, persists its warning state, and consumes no extra ticket', async () => {
    const accessResult = recordedTrustedAccess('secret-key');
    const harness = createAccessHarness({ accessResult, verification: recordedTrustedResult(accessResult) });
    const token = await acquireSessionAccess({
        session: harness.session,
        models: [{ id: 'model-a', name: 'Model A' }],
        inferenceService: harness.inferenceService,
        ticketClient: harness.ticketClient,
        chatDB: harness.chatDB,
        getTicketCost: harness.getTicketCost,
        ...harness.callbacks
    });
    assert.equal(token, 'secret-key');
    assert.equal(harness.requested.length, 1);
    assert.equal(harness.verificationInputs[0].activeKeyDuringVerification, null);
    assert.equal(harness.savedSessions[0].apiKeyInfo.verifierSubmitKeyProof.status, 'verifier-unavailable');
});

function pricingHarness(overrides = {}) {
    const harness = createAccessHarness({ ticketCount: 20, ...overrides });
    return { harness, options: {
        session: harness.session,
        models: [{ id: 'model-a', name: 'Model A' }],
        reasoningEnabled: false,
        inferenceService: harness.inferenceService,
        ticketClient: harness.ticketClient,
        getTicketCost: () => 5,
        ...harness.callbacks
    } };
}

const priceChanged = () => Object.assign(new Error('Model pricing changed. Please try again.'), {
    code: 'TICKET_PRICE_CHANGED', status: 400
});

test('new access refreshes pricing even when an old count would still be accepted', async () => {
    const { harness, options } = pricingHarness();
    harness.inferenceService.getAccessTicketCost = async (session, { modelId, forceRefresh }) => {
        assert.equal(session, harness.session);
        assert.equal(modelId, 'model-a');
        assert.equal(forceRefresh, true);
        return 9;
    };
    await acquireVerifiedAccess(options);
    assert.deepEqual(harness.requested.map(x => x.request.ticketsRequired), [9]);
});

test('a price change during redemption refreshes and retries once before verification', async () => {
    const { harness, options } = pricingHarness({ requestAccess: async (_s, _r, attempt) => {
        if (attempt === 1) throw priceChanged();
        return { key: 'test-key' };
    } });
    const reads = [];
    harness.inferenceService.getAccessTicketCost = async (_session, { forceRefresh }) => {
        reads.push(forceRefresh);
        return reads.length === 1 ? 5 : 9;
    };
    await acquireVerifiedAccess(options);
    assert.deepEqual(harness.requested.map(x => x.request.ticketsRequired), [5, 9]);
    // Both the spending boundary and the one rejected-count retry refresh.
    assert.deepEqual(reads, [true, true]);
    assert.equal(harness.verificationInputs.length, 1);
    assert.equal(harness.ticketUsed.length, 0);
});

test('repricing rechecks the balance and never submits an unaffordable retry', async () => {
    const { harness, options } = pricingHarness({ ticketCount: 7, requestAccess: async () => { throw priceChanged(); } });
    let reads = 0;
    harness.inferenceService.getAccessTicketCost = async () => ++reads === 1 ? 5 : 9;
    await assert.rejects(acquireVerifiedAccess(options), error => {
        assert.match(error.message, /Need 9, but only 7 available/);
        assert.equal(error.code, 'TICKET_SHORTAGE');
        assert.deepEqual([error.requiredTickets, error.availableTickets], [9, 7]);
        return true;
    });
    assert.equal(harness.requested.length, 1);
    assert.equal(harness.verificationInputs.length, 0);
});

test('a shortage found at the key request asks the caller, and a reload that lands lets it continue', async () => {
    let balance = 7;
    const { harness, options } = pricingHarness({ ticketCount: 7, requestAccess: async (_s, _r, attempt) => {
        if (attempt === 1) throw priceChanged();
        return { key: 'test-key' };
    } });
    harness.ticketClient.getTicketCount = () => balance;
    let reads = 0;
    harness.inferenceService.getAccessTicketCost = async () => ++reads === 1 ? 5 : 9;
    const shortages = [];
    const onTicketShortage = async shortage => { shortages.push(shortage); balance = 27; return { retry: true }; };
    await acquireVerifiedAccess({ ...options, onTicketShortage });
    assert.deepEqual(shortages, [{ requiredTickets: 9, availableTickets: 7, label: 'this model' }]);
    assert.deepEqual(harness.requested.map(x => x.request.ticketsRequired), [5, 9]);
    assert.equal(harness.verificationInputs.length, 1);
});

test('a shortage the caller cannot cover stops before any further request', async () => {
    const { harness, options } = pricingHarness({ ticketCount: 7, requestAccess: async () => { throw priceChanged(); } });
    let reads = 0;
    harness.inferenceService.getAccessTicketCost = async () => ++reads === 1 ? 5 : 9;
    for (const outcome of [{ retry: false }, { retry: true }, undefined]) {
        harness.requested.length = 0;
        reads = 0;
        let asked = 0;
        await assert.rejects(acquireVerifiedAccess({ ...options, onTicketShortage: async () => { asked += 1; return outcome; } }),
            { code: 'TICKET_SHORTAGE' });
        assert.equal(asked, 1);
        assert.equal(harness.requested.length, 1);
    }
});

test('a cancellation during the shortage answer is reported as cancelled, not as a shortage', async () => {
    const controller = new AbortController();
    const { harness, options } = pricingHarness({ ticketCount: 7, requestAccess: async () => { throw priceChanged(); } });
    let reads = 0;
    harness.inferenceService.getAccessTicketCost = async () => ++reads === 1 ? 5 : 9;
    await assert.rejects(acquireVerifiedAccess({ ...options, signal: controller.signal,
        onTicketShortage: async () => { controller.abort(); return { retry: false }; } }), { name: 'AbortError' });
    assert.equal(harness.requested.length, 1);
});

test('repeated price rejection stops after one recovery attempt', async () => {
    const { harness, options } = pricingHarness({ requestAccess: async () => { throw priceChanged(); } });
    harness.inferenceService.getAccessTicketCost = async () => 9;
    await assert.rejects(acquireVerifiedAccess(options), { code: 'TICKET_PRICE_CHANGED' });
    assert.equal(harness.requested.length, 2);
});

test('failed or cancelled repricing never issues a second request', async () => {
    for (const cancel of [false, true]) {
        const controller = new AbortController();
        const { harness, options } = pricingHarness({ requestAccess: async () => { throw priceChanged(); } });
        let reads = 0;
        harness.inferenceService.getAccessTicketCost = async () => {
            if (++reads === 2) {
                if (cancel) controller.abort();
                else throw Object.assign(new Error('Pricing unavailable'), { code: 'MODEL_TIER_CONFIG_UNAVAILABLE' });
            }
            return 5;
        };
        await assert.rejects(acquireVerifiedAccess({ ...options, signal: controller.signal }),
            cancel ? { name: 'AbortError' } : { code: 'MODEL_TIER_CONFIG_UNAVAILABLE' });
        assert.equal(harness.requested.length, 1);
    }
});

test('ambiguous access failures are not retried as price changes', async () => {
    const { harness, options } = pricingHarness({ requestAccess: async () => {
        throw Object.assign(new Error('Network failure'), { status: 503 });
    } });
    let reads = 0;
    harness.inferenceService.getAccessTicketCost = async () => { reads++; return 9; };
    await assert.rejects(acquireVerifiedAccess(options), /Network failure/);
    assert.equal(harness.requested.length, 1);
    assert.equal(reads, 1);
});

test('an explicit ticket budget is neither repriced nor retried as a model price', async () => {
    const { harness, options } = pricingHarness({ requestAccess: async () => { throw priceChanged(); } });
    harness.inferenceService.getAccessTicketCost = async () => assert.fail('Explicit budget must stay fixed');
    await assert.rejects(acquireVerifiedAccess({ ...options, ticketsRequiredOverride: 4 }),
        { code: 'TICKET_PRICE_CHANGED' });
    assert.deepEqual(harness.requested.map(x => x.request.ticketsRequired), [4]);
});

test('zero tickets at acquisition can reload once and issue a key', async () => {
    let balance = 0, reloads = 0;
    const { harness, options } = pricingHarness({ ticketCount: () => balance });
    await acquireVerifiedAccess({ ...options, onTicketShortage: async () => {
        reloads++; balance = 10; return { retry: true };
    } });
    assert.equal(reloads, 1);
    assert.equal(harness.requested.length, 1);
});

test('held previous-version tickets never trigger a purchase at acquisition', async () => {
    const { harness, options } = pricingHarness({ ticketCount: 6 });
    harness.ticketClient.getHeldTicketCount = () => 5;
    await assert.rejects(acquireVerifiedAccess({ ...options,
        onTicketShortage: () => assert.fail('Held tickets must not cause a reload')
    }), { code: 'TICKETS_MOVING' });
    assert.equal(harness.requested.length, 0);
});

test('locked selection shortages recover once, and repeated races stop without another reload', async () => {
    for (const repeat of [false, true]) {
        let reloads = 0;
        const { harness, options } = pricingHarness({ requestAccess: async (_s, _r, attempt) => {
            if (attempt === 1 || repeat) throw Object.assign(new Error('Another tab spent tickets'), {
                code: 'INSUFFICIENT_TICKETS', availableTickets: 1, heldTickets: 0
            });
            return { key: 'race-recovered' };
        } });
        const work = acquireVerifiedAccess({ ...options, onTicketShortage: async shortage => {
            assert.equal(shortage.availableTickets, 1);
            reloads++; return { retry: true };
        } });
        if (repeat) await assert.rejects(work, { code: 'TICKET_SHORTAGE' });
        else await work;
        assert.equal(reloads, 1);
        assert.equal(harness.requested.length, 2);
    }
});

test('a hold discovered at locked selection preserves tickets without reload', async () => {
    const { options } = pricingHarness({ requestAccess: async () => {
        throw Object.assign(new Error('Held'), { code: 'NO_TICKETS', availableTickets: 0, heldTickets: 6 });
    } });
    await assert.rejects(acquireVerifiedAccess({ ...options,
        onTicketShortage: () => assert.fail('Must not purchase')
    }), { code: 'TICKETS_MOVING' });
});

test('Stop cancels a hung shortage wait promptly and cannot issue a late key', async () => {
    let release, entered;
    const started = new Promise(resolve => { entered = resolve; });
    const controller = new AbortController();
    const { harness, options } = pricingHarness({ ticketCount: 0 });
    const work = acquireVerifiedAccess({ ...options, signal: controller.signal,
        onTicketShortage: () => { entered(); return new Promise(resolve => { release = resolve; }); }
    });
    await started;
    controller.abort();
    await assert.rejects(work, { name: 'AbortError' });
    release({ retry: true });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(harness.requested.length, 0);
});

test('a cancellation during pricing never starts shortage billing', async () => {
    const controller = new AbortController();
    const { harness, options } = pricingHarness({ ticketCount: 0 });
    harness.inferenceService.getAccessTicketCost = async () => { controller.abort(); return 5; };
    await assert.rejects(acquireVerifiedAccess({ ...options, signal: controller.signal,
        onTicketShortage: () => assert.fail('Cancelled send must not buy tickets')
    }), { name: 'AbortError' });
});
