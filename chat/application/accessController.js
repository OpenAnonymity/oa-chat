import { LOCAL_LOOPBACK_VERIFIER_BYPASS_STATUS } from '../services/inference/verifiedAccess.js';

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

export async function acquireSessionAccess(options = {}) {
    const {
        session,
        models,
        reasoningEnabled,
        inferenceService,
        ticketClient,
        chatDB,
        getTicketCost,
        getFallbackModelEntry,
        onTicketUsed = () => {},
        onNetworkSession = () => {},
        onGranted = null,
        onAccessRequestError = () => {},
        onVerificationWarning = () => {},
        onSessionChanged = () => {},
        modelIdOverride = null,
        modelNameOverride = null,
        signal = null,
        ticketsRequiredOverride = null,
        ticketRequirementLabel = 'this model'
    } = options;

    if (!session) throw new Error('No active session found.');
    if (!inferenceService || !ticketClient || !chatDB || typeof getTicketCost !== 'function') {
        throw new Error('Access controller is missing required dependencies.');
    }

    const availableTickets = ticketClient.getTicketCount();
    if (availableTickets === 0) {
        throw new Error('You have no inference tickets left. Please redeem an invite code for more tickets at the System Panel (right) or request invite code at [here](https://openanonymity.ai/beta/).');
    }

    const modelName = modelNameOverride || session.model || inferenceService.getDefaultModelName(session);
    const modelEntry = (modelIdOverride && Array.isArray(models)
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
            onAccessRequestError(error);
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
            onVerificationWarning('Pending-state update after access grant failed:', error);
        }
    }

    result.modelId = result.modelId || modelId;
    result.modelName = result.modelName || modelName;
    const verifier = inferenceService.getVerificationAdapter(session);
    if (verifier?.supports) {
        const allowsLocalBypass = verifier.allowsLocalBypass?.() === true;
        if (allowsLocalBypass) {
            result = {
                ...result,
                verifierSubmitKeyProof: buildVerifierSubmitKeyProof({
                    status: LOCAL_LOOPBACK_VERIFIER_BYPASS_STATUS,
                    detail: 'explicit_loopback_development'
                }, result)
            };
        } else {
            let verifyResult;
            try {
                verifyResult = await inferenceService.verifyAccess(session, result);
            } catch (error) {
                verifyResult = { status: 'rejected', error };
            }

            const proof = buildVerifierSubmitKeyProof(verifyResult, result);
            if (verifyResult?.status !== 'verified') {
                inferenceService.clearAccessInfo(session);
                session.lastVerifierSubmitKeyProof = proof;
                await chatDB.saveSession(session);
                onSessionChanged(session);

                if (proof.bannedStation) {
                    const bs = proof.bannedStation;
                    throw new Error(`Station ${bs.stationId} is banned: ${bs.reason || 'Unknown reason'}`);
                }

                const detail = proof.detail || proof.error || 'verification_not_confirmed';
                if (verifyResult?.status === 'pending') {
                    throw new Error(
                        `Key verification pending: ${detail}. The disposable key was not activated.`
                    );
                }
                if (verifyResult?.status === 'unverified') {
                    throw new Error(
                        `Key verification required: ${detail}. The disposable key was not activated.`
                    );
                }
                throw new Error(`Key verification failed: ${detail}`);
            }

            result = {
                ...result,
                verifierSubmitKeyProof: proof
            };
        }
        delete session.lastVerifierSubmitKeyProof;
        inferenceService.setAccessInfo(session, result);
        if (!allowsLocalBypass) {
            inferenceService.setCurrentAccess(session, result);
        }
    } else {
        inferenceService.setAccessInfo(session, result);
    }

    if (session.shareInfo?.apiKeyShared) {
        session.shareInfo.apiKeyShared = false;
    }

    await chatDB.saveSession(session);
    onSessionChanged(session);

    return inferenceService.getAccessToken(session);
}
