import {
    isVerifierProofApproved,
    isVerifierResultApproved,
    LOCAL_LOOPBACK_VERIFIER_BYPASS_STATUS
} from '../services/inference/verifiedAccess.js';

export function isAccessCreditExhaustedError(error) {
    if (error?.status !== 402) return false;
    const responseData = error.data || error.responseData || null;
    const details = [
        error.message,
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
    const {
        session,
        models,
        reasoningEnabled,
        inferenceService,
        ticketClient,
        getTicketCost,
        getFallbackModelEntry,
        onTicketUsed = () => {},
        onNetworkSession = () => {},
        onGranted = null,
        onAccessRequestError = () => {},
        onVerificationWarning = () => {},
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

    const availableTickets = ticketClient.getTicketCount();
    if (availableTickets === 0) {
        throw new Error('You have no inference tickets left. Please redeem an invite code for more tickets at the System Panel (right) or request invite code at [here](https://openanonymity.ai/beta/).');
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
    const ticketsRequired = Number.isFinite(overrideTickets) && overrideTickets > 0
        ? Math.ceil(overrideTickets)
        : getTicketCost(modelId, reasoningEnabled);

    if (availableTickets < ticketsRequired) {
        throw new Error(`Not enough tickets for ${ticketRequirementLabel}. Need ${ticketsRequired}, but only ${availableTickets} available.`);
    }

    if (signal?.aborted) {
        const error = new Error('Request aborted');
        error.name = 'AbortError';
        error.isCancelled = true;
        throw error;
    }

    onNetworkSession(session.id);

    let result;
    let retries = 0;
    const maxRetries = Math.min(availableTickets, ticketsRequired + 10);

    while (retries < maxRetries) {
        try {
            result = await inferenceService.requestAccess(session, {
                ticketsRequired,
                ...(signal ? { signal } : {})
            });
            break;
        } catch (error) {
            if (error.code === 'TICKET_USED') {
                retries += 1;
                await onTicketUsed(retries, error);
                continue;
            }
            onAccessRequestError(buildSafeAccessErrorMetadata(error));
            throw error;
        }
    }

    if (!result) {
        throw new Error('All available tickets were already spent');
    }

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
                detail: 'explicit_loopback_development'
            }, result);
            result = {
                ...result,
                verifierSubmitKeyProof: proof
            };
            return result;
        }

        let verifyResult;
        try {
            verifyResult = await inferenceService.verifyAccess(session, result);
        } catch (error) {
            verifyResult = { status: 'rejected', error };
        }

        const proof = buildVerifierSubmitKeyProof(verifyResult, result);
        if (!isVerifierResultApproved(verifyResult)) {
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

    let result;
    try {
        result = await acquireVerifiedAccess(options);
    } catch (error) {
        if (error?.verifierSubmitKeyProof) {
            inferenceService.clearAccessInfo(session);
            session.lastVerifierSubmitKeyProof = error.verifierSubmitKeyProof;
            await chatDB.saveSession(session);
            onSessionChanged(session);
        }
        throw error;
    }

    delete session.lastVerifierSubmitKeyProof;
    inferenceService.setAccessInfo(session, result);
    if (inferenceService.getVerificationAdapter(session)?.supports &&
        isVerifierProofApproved(result?.verifierSubmitKeyProof)) {
        inferenceService.setCurrentAccess(session, result);
    }

    if (session.shareInfo?.apiKeyShared) {
        session.shareInfo.apiKeyShared = false;
    }

    await chatDB.saveSession(session);
    onSessionChanged(session);

    return inferenceService.getAccessToken(session);
}
