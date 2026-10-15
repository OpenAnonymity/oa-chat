import { reportDiagnostic } from '../services/diagnostics.js';
import {
    isVerifierResultUsable,
    LOCAL_LOOPBACK_VERIFIER_BYPASS_STATUS
} from '../services/inference/verifiedAccess.js';
import { getCreditLimitSource, isKeyLimitExceededResponse, parseOutputAffordability } from '../services/inference/openRouterCreditRecovery.js';
import { logAccessReplace } from '../services/inference/accessDiscardLog.js';
import { waitForSignal } from '../services/inference/reliability.js';

export function isAccessCreditExhaustedError(error) {
    const status = error?.status;
    if (status !== 402 && status !== 403) return false;
    const responseData = error.data || error.responseData || null;
    // Richer display text must not widen the legacy credit-refresh heuristic:
    // a refresh can spend a ticket. Provider adapters retain its original text.
    const recoveryMessage = typeof error.creditRecoveryMessage === 'string'
        ? error.creditRecoveryMessage : error.message;
    // A 403 is a key whose limit is spent only when OpenRouter says so in
    // words; every other 403 (moderation, permissions) keeps the key.
    if (status === 403) return isKeyLimitExceededResponse(status, responseData, recoveryMessage);
    const source = getCreditLimitSource(responseData);
    // Account-wide funding and in-flight holds cannot be repaired by spending
    // another ticket. Nor is a key exhausted when a smaller output still fits.
    if (source && source !== 'openrouter_key_limit') return false;
    const affordability = parseOutputAffordability(responseData?.error?.message || recoveryMessage);
    if (affordability?.affordable > 0) return false;
    if (source === 'openrouter_key_limit') return true;
    const details = [
        recoveryMessage,
        responseData?.error?.message,
        responseData?.detail,
        responseData?.message
    ].filter(Boolean).join(' ').toLowerCase();

    return details.includes('credit') ||
        details.includes('can only afford') ||
        details.includes('more credits') ||
        details.includes('max_tokens');
}

export function buildSafeAccessErrorMetadata(error) {
    const status = Number(error?.status ?? error?.response?.status);
    const code = typeof error?.code === 'string'
        ? error.code.replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 80)
        : null;

    return {
        name: typeof error?.name === 'string'
            ? error.name.replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 80)
            : 'Error',
        code: code || null,
        status: Number.isFinite(status) ? status : null,
        retryable: typeof error?.retryable === 'boolean' ? error.retryable : null
    };
}

function redactProofValue(value, accessInfo = null, fieldName = '') {
    const sensitiveFields = new Set([
        'key',
        'api_key',
        'apikey',
        'token',
        'access_token',
        'accesstoken',
        'client_token',
        'clienttoken',
        'session_token',
        'sessiontoken',
        'child_key',
        'childkey',
        'authorization',
        'cookie',
        'cookies',
        'password'
    ]);
    const normalizedField = String(fieldName).replace(/[^a-z0-9_]/gi, '').toLowerCase();
    if (sensitiveFields.has(normalizedField)) return '[REDACTED]';

    if (Array.isArray(value)) {
        return value.map(item => redactProofValue(item, accessInfo));
    }
    if (value && typeof value === 'object') {
        return Object.fromEntries(
            Object.entries(value).map(([name, nested]) => [
                name,
                redactProofValue(nested, accessInfo, name)
            ])
        );
    }
    if (typeof value !== 'string') return value;

    let redacted = value;
    for (const secret of [accessInfo?.key, accessInfo?.token]) {
        if (typeof secret === 'string' && secret) {
            redacted = redacted.split(secret).join('[REDACTED]');
        }
    }
    return redacted;
}

export function buildVerifierSubmitKeyProof(verifyResult, accessInfo = null, options = {}) {
    const now = typeof options.now === 'function'
        ? options.now
        : () => new Date().toISOString();
    const detail = redactProofValue(
        verifyResult?.detail || verifyResult?.data?.detail || null,
        accessInfo
    );
    const verifierResponse = redactProofValue(verifyResult?.data || null, accessInfo);
    const stationId = redactProofValue(
        accessInfo?.stationId || accessInfo?.station_id || accessInfo?.station_name || null,
        accessInfo,
    );
    const keyHashFromOrg = redactProofValue(
        accessInfo?.keyHash || accessInfo?.key_hash || null,
        accessInfo,
    );
    const keyHashFromVerifier = redactProofValue(
        verifierResponse?.key_hash || null,
        accessInfo,
    );

    return {
        recordedAt: now(),
        status: redactProofValue(verifyResult?.status || 'unknown', accessInfo),
        detail,
        stationId,
        keyHashFromOrg,
        keyHashFromVerifier,
        ...(verifyResult?.trustedStationFallback ? {
            trustedStationFallback: redactProofValue(verifyResult.trustedStationFallback, accessInfo)
        } : {}),
        verifierResponse,
        retryable: typeof verifierResponse?.retryable === 'boolean' ? verifierResponse.retryable : null,
        error: redactProofValue(verifyResult?.error?.message || null, accessInfo),
        bannedStation: redactProofValue(verifyResult?.bannedStation || null, accessInfo)
    };
}

export function persistVerifierSubmitKeyProof(session, verifyResult, options = {}) {
    if (!session?.apiKeyInfo || !verifyResult) return;
    session.apiKeyInfo.verifierSubmitKeyProof = buildVerifierSubmitKeyProof(
        verifyResult,
        session.apiKeyInfo,
        options
    );
}

function createVerificationFailure(verifyResult, proof) {
    let message;
    if (proof.bannedStation) {
        const station = proof.bannedStation;
        message = `Station ${station.stationId} is banned: ${station.reason || 'Unknown reason'}`;
    } else {
        const detail = proof.detail || proof.error || 'verification_not_confirmed';
        if (verifyResult?.status === 'pending') {
            message = `Key verification pending: ${detail}. The disposable key was not activated.`;
        } else if (verifyResult?.status === 'unverified') {
            message = `Key verification required: ${detail}. The disposable key was not activated.`;
        } else {
            message = `Key verification failed: ${detail}`;
        }
    }

    const error = new Error(message);
    error.code = 'ACCESS_VERIFICATION_FAILED';
    error.verifierSubmitKeyProof = proof;
    return error;
}

export async function acquireVerifiedAccess(options = {}) {
    try { return await acquireVerifiedAccessMeasured(options); }
    catch (error) {
        options.requestTiming?.outcome(options.signal?.aborted || error?.isCancelled || error?.name === 'AbortError' ? 'cancelled' : 'error');
        throw error;
    }
}

async function acquireVerifiedAccessMeasured(options) {
    const {
        session,
        models,
        reasoningEnabled,
        inferenceService,
        ticketClient,
        getTicketCost,
        getFallbackModelEntry,
        onTicketUsed = () => {},
        onTicketSweepEnd = null,
        onNetworkSession = () => {},
        onGranted = null,
        onAccessRequestError = () => {},
        onVerificationWarning = () => {},
        onTicketShortage = null,
        modelIdOverride = null,
        modelNameOverride = null,
        modelEntryOverride = null,
        signal = null,
        ticketsRequiredOverride = null,
        ticketRequirementLabel = 'this model'
    } = options;

    if (!session) throw new Error('No active session found.');
    if (!inferenceService || !ticketClient || typeof getTicketCost !== 'function') {
        throw new Error('Access controller is missing required dependencies.');
    }

    const modelName = modelNameOverride || session.model || inferenceService.getDefaultModelName(session);
    const modelEntry = modelEntryOverride || (modelIdOverride && Array.isArray(models)
        ? models.find(model => model.id === modelIdOverride)
        : null) ||
        (Array.isArray(models) ? models : []).find(model => model.name === modelName) ||
        (typeof getFallbackModelEntry === 'function' ? getFallbackModelEntry(session) : null);
    if (!modelEntry) {
        throw new Error('No enabled models are currently available. Please try again later.');
    }
    const modelId = modelEntry.id;
    const overrideTickets = Number(ticketsRequiredOverride);
    const hasTicketOverride = Number.isFinite(overrideTickets) && overrideTickets > 0;
    // The org chooses a tier by ticket count, not model ID. Refresh here,
    // after accepting the prompt, so a still-valid old tier cannot overcharge.
    const resolveTicketCost = async ({ forceRefresh = true } = {}) => {
        if (hasTicketOverride) return Math.ceil(overrideTickets);
        const liveCost = await inferenceService.getAccessTicketCost?.(session, { modelId, signal, forceRefresh });
        return liveCost ?? getTicketCost(modelId, reasoningEnabled);
    };
    const shortageError = balance => Object.assign(
        new Error(`Not enough tickets for ${ticketRequirementLabel}. Need ${ticketsRequired}, but only ${balance} available.`),
        { code: 'TICKET_SHORTAGE', requiredTickets: ticketsRequired, availableTickets: balance }
    );
    // A shortage found here (the price rose after the send was accepted) gets
    // the same answer as one found before it: the caller may reload the wallet
    // and ask for one more balance check, or open its offers and stop.
    const throwIfCancelled = () => {
        if (!signal?.aborted) return;
        throw Object.assign(new Error('Request aborted'), { name: 'AbortError', isCancelled: true });
    };
    const spendableBalance = () => Math.max(0, ticketClient.getTicketCount() - (ticketClient.getHeldTicketCount?.() || 0));
    let shortageHandled = false;
    const checkBalance = async (selectionError = null) => {
        throwIfCancelled();
        let balance = Number.isFinite(selectionError?.availableTickets)
            ? selectionError.availableTickets : spendableBalance();
        if (balance >= ticketsRequired) return;
        if ((selectionError?.heldTickets || ticketClient.getHeldTicketCount?.() || 0) > 0) {
            throw Object.assign(new Error('Your tickets from the previous version are still being moved. Try again in a moment.'), { code: 'TICKETS_MOVING' });
        }
        if (!shortageHandled && typeof onTicketShortage === 'function') {
            shortageHandled = true;
            const outcome = await waitForSignal(onTicketShortage({ requiredTickets: ticketsRequired, availableTickets: balance, label: ticketRequirementLabel }), signal);
            throwIfCancelled();
            balance = spendableBalance();
            if (outcome?.retry === true && balance >= ticketsRequired) return;
        }
        throw shortageError(balance);
    };
    let ticketsRequired = await resolveTicketCost();
    await checkBalance();

    if (signal?.aborted) {
        const error = new Error('Request aborted');
        error.name = 'AbortError';
        error.isCancelled = true;
        throw error;
    }

    onNetworkSession(session.id);

    let result;
    let pricingRetried = false;
    let selectionRetried = false;
    // Tickets the org had already seen — spent from another device or
    // browser, or left behind by a lost sync. Each one is archived locally
    // and the next is tried, for as long as the wallet lasts: the user
    // asked for a reply, and a wallet with hundreds of such tickets must
    // still get one. Stop cancels; a wallet that runs out is a shortage.
    // `ticketsSkipped` counts refusals; `ticketsRemoved` counts what the
    // wallet actually lost to them (an org that names no index sets a whole
    // selection aside), which is the number the user is told.
    let ticketsSkipped = 0;
    let ticketsRemoved = 0;
    let sweepSettled = false;
    const settleSweep = (recovered, reason = null) => {
        if (sweepSettled || ticketsSkipped === 0) return;
        sweepSettled = true;
        if (typeof onTicketSweepEnd !== 'function') return;
        try {
            onTicketSweepEnd({ skipped: ticketsSkipped, removed: ticketsRemoved, recovered, reason, tier: ticketsRequired });
        } catch (hookError) {
            onVerificationWarning('Ticket sweep hook failed:', buildSafeAccessErrorMetadata(hookError));
        }
    };

    try {
        for (;;) {
            throwIfCancelled();
            const balanceBeforeRequest = spendableBalance();
            try {
                options.requestTiming?.setModel(modelEntry?.id || modelIdOverride);
                options.requestTiming?.setKey('new');
                options.requestTiming?.begin('access_ms');
                try {
                    result = await inferenceService.requestAccess(session, {
                        ticketsRequired, ...(signal ? { signal } : {})
                    });
                } finally { options.requestTiming?.end('access_ms'); }
                break;
            } catch (error) {
                if (['NO_TICKETS', 'INSUFFICIENT_TICKETS'].includes(error.code)) {
                    if (selectionRetried) throw shortageError(error.availableTickets ?? spendableBalance());
                    selectionRetried = true;
                    await checkBalance(error);
                    continue;
                }
                if (error.code === 'TICKET_PRICE_CHANGED' && !pricingRetried && !hasTicketOverride
                    && typeof inferenceService.getAccessTicketCost === 'function') {
                    pricingRetried = true;
                    ticketsRequired = await resolveTicketCost({ forceRefresh: true });
                    await checkBalance();
                    continue;
                }
                if (error.code === 'TICKET_USED') {
                    // The wallet must shrink for every refusal, or the same
                    // ticket is being offered again (a store that cannot
                    // write, an org that refuses everything): stop rather
                    // than loop.
                    const removedNow = balanceBeforeRequest - spendableBalance();
                    if (!(removedNow > 0)) {
                        error.message = 'Couldn’t update the tickets saved on this device. Please try again.';
                        error.code = 'TICKET_SWEEP_STALLED';
                        reportDiagnostic('access.sweep_stalled', { tier: ticketsRequired });
                        onAccessRequestError(buildSafeAccessErrorMetadata(error));
                        throw error;
                    }
                    ticketsSkipped += 1;
                    ticketsRemoved += removedNow;
                    await onTicketUsed(ticketsRemoved, error);
                    continue;
                }
                if (error.code === 'TICKET_KEY_INVALIDATED') {
                    // Each refusal retires one old signing-key generation from
                    // the wallet; the next request uses what is left. Bounded
                    // by the wallet shrinking (and by Stop), never by a count:
                    // a wallet holding several old generations ahead of its
                    // current tickets must still reach them.
                    const remainingTickets = ticketClient.getTicketCount();
                    if (remainingTickets >= ticketsRequired && spendableBalance() < balanceBeforeRequest) {
                        continue;
                    }
                    if (remainingTickets >= ticketsRequired) {
                        error.message = 'Couldn’t update the tickets saved on this device. Please try again.';
                        error.code = 'TICKET_SWEEP_STALLED';
                        reportDiagnostic('access.sweep_stalled', { tier: ticketsRequired });
                    } else {
                        error.message = remainingTickets > 0
                            ? `The org rotated its ticket signing key and invalidated the old tickets. ${remainingTickets} valid ticket${remainingTickets === 1 ? '' : 's'} remain, but this model needs ${ticketsRequired}.`
                            : 'The org rotated its ticket signing key and invalidated your old tickets. Redeem a new invite code to continue.';
                    }
                }
                onAccessRequestError(buildSafeAccessErrorMetadata(error));
                throw error;
            }
        }
    } catch (error) {
        settleSweep(false, error?.code || error?.name || null);
        throw error;
    }

    if (!result) {
        const error = new Error('No usable ticket was found. Please try again.');
        error.code = 'ACCESS_NOT_GRANTED';
        throw error;
    }
    settleSweep(true);

    if (typeof onGranted === 'function') {
        try {
            await onGranted(result);
        } catch (error) {
            onVerificationWarning(
                'Pending-state update after access grant failed:',
                buildSafeAccessErrorMetadata(error)
            );
        }
    }

    result.modelId = result.modelId || modelId;
    result.modelName = result.modelName || modelName;
    const verifier = inferenceService.getVerificationAdapter(session);
    if (verifier?.supports) {
        if (verifier.allowsLocalBypass?.() === true) {
            const proof = buildVerifierSubmitKeyProof({
                status: LOCAL_LOOPBACK_VERIFIER_BYPASS_STATUS,
                detail: verifier.getLocalBypassDetail?.() ||
                    'explicit_loopback_development'
            }, result);
            result = {
                ...result,
                verifierSubmitKeyProof: proof
            };
            return result;
        }

        let verifyResult;
        try {
            options.requestTiming?.begin('verification_ms');
            try { verifyResult = await inferenceService.verifyAccess(session, result); }
            finally { options.requestTiming?.end('verification_ms'); }
        } catch (error) {
            verifyResult = { status: 'rejected', error };
        }

        const proof = buildVerifierSubmitKeyProof(verifyResult, result);
        if (!isVerifierResultUsable(verifyResult)) {
            throw createVerificationFailure(verifyResult, proof);
        }

        result = {
            ...result,
            verifierSubmitKeyProof: proof
        };
    }

    return result;
}

export async function acquireSessionAccess(options = {}) {
    const {
        session,
        inferenceService,
        chatDB,
        onSessionChanged = () => {}
    } = options;

    if (!session || !inferenceService || !chatDB) {
        throw new Error('Access controller is missing required session dependencies.');
    }

    if (session.apiKey) {
        // A stored key is being passed over. Say why in the timeline before a
        // ticket is spent on its replacement.
        const expiresAt = Date.parse(session.expiresAt || session.apiKeyInfo?.expiresAt || session.apiKeyInfo?.expires_at || '');
        logAccessReplace(session, !inferenceService.getAccessToken(session) ? 'not-usable'
            : !Number.isFinite(expiresAt) || expiresAt <= Date.now() ? 'expired' : 'unspecified');
    }

    let result;
    try {
        // An explicitly composed access implementation owns its acquisition policy.
        // Standalone/ticket products use the verifier and its explicit outage policy.
        const acquireAccess = options.acquireAccess || acquireVerifiedAccess;
        if (typeof acquireAccess !== 'function') {
            throw new Error('The configured access acquisition must be a function.');
        }
        result = await acquireAccess(options);
        if (options.signal?.aborted) {
            const error = new Error('Request aborted');
            error.name = 'AbortError';
            error.isCancelled = true;
            throw error;
        }
    } catch (error) {
        if (error?.verifierSubmitKeyProof) {
            inferenceService.clearAccessInfo(session, { reason: 'verifier-rejected' });
            session.lastVerifierSubmitKeyProof = error.verifierSubmitKeyProof;
            await chatDB.saveSession(session);
            onSessionChanged(session);
        }
        throw error;
    }

    delete session.lastVerifierSubmitKeyProof;
    inferenceService.setAccessInfo(session, result);
    if (inferenceService.getVerificationAdapter(session)?.supports &&
        isVerifierResultUsable(result?.verifierSubmitKeyProof)) {
        inferenceService.setCurrentAccess(session, result);
    }

    if (session.shareInfo?.apiKeyShared) {
        session.shareInfo.apiKeyShared = false;
    }

    await chatDB.saveSession(session);
    onSessionChanged(session);

    return inferenceService.getAccessToken(session);
}
