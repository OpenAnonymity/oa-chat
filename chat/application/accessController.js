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

export function buildVerifierSubmitKeyProof(verifyResult, accessInfo = null, options = {}) {
    const now = typeof options.now === 'function'
        ? options.now
        : () => new Date().toISOString();
    const detail = verifyResult?.detail || verifyResult?.data?.detail || null;
    const verifierResponse = verifyResult?.data || null;
    const stationId = accessInfo?.stationId || accessInfo?.station_id || accessInfo?.station_name || null;
    const keyHashFromOrg = accessInfo?.keyHash || accessInfo?.key_hash || null;
    const keyHashFromVerifier = verifierResponse?.key_hash || null;

    return {
        recordedAt: now(),
        status: verifyResult?.status || 'unknown',
        detail,
        stationId,
        keyHashFromOrg,
        keyHashFromVerifier,
        verifierResponse,
        retryable: typeof verifierResponse?.retryable === 'boolean' ? verifierResponse.retryable : null,
        error: verifyResult?.error?.message || null,
        bannedStation: verifyResult?.bannedStation || null
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

    inferenceService.setAccessInfo(session, result);

    const verifier = inferenceService.getVerificationAdapter(session);
    if (verifier?.supports) {
        const accessInfo = inferenceService.getAccessInfo(session);
        const verifyResult = await inferenceService.verifyAccess(session, accessInfo?.info);
        persistVerifierSubmitKeyProof(session, verifyResult);

        if (verifyResult?.status === 'unverified') {
            const detail = verifyResult?.detail || verifyResult?.data?.detail;
            if (detail === 'key_near_expiry') {
                onVerificationWarning('Key expires too soon to verify, continuing without verification');
            } else if (detail === 'ownership_check_error') {
                onVerificationWarning('Ownership verification temporarily unavailable, continuing without verification');
            } else {
                onVerificationWarning('Key verification unverified, continuing without verification');
            }
        }

        if (verifyResult?.status === 'rejected') {
            inferenceService.clearAccessInfo(session);
            await chatDB.saveSession(session);

            const errorMsg = verifyResult.error?.message || 'Verification failed';
            if (verifyResult.bannedStation) {
                const bs = verifyResult.bannedStation;
                throw new Error(`Station ${bs.stationId} is banned: ${bs.reason || 'Unknown reason'}`);
            }
            throw new Error(`Key verification failed: ${errorMsg}`);
        }

        inferenceService.setCurrentAccess(session, accessInfo?.info);
    }

    if (session.shareInfo?.apiKeyShared) {
        session.shareInfo.apiKeyShared = false;
    }

    await chatDB.saveSession(session);
    onSessionChanged(session);

    return inferenceService.getAccessToken(session);
}
