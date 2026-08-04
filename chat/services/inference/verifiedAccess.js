export function isVerifierProofApproved(proof) {
    return proof?.status === 'verified';
}

export function isVerifierResultApproved(result) {
    return result?.status === 'verified';
}

export function hasExplicitVerifierApproval(session) {
    return isVerifierProofApproved(session?.apiKeyInfo?.verifierSubmitKeyProof);
}

export function hasExplicitVerifierApprovalForAccessInfo(accessInfo) {
    return isVerifierProofApproved(accessInfo?.verifierSubmitKeyProof);
}

function removeRawKeyMappings(session, discardedKey, retainedKeys = new Set()) {
    if (!discardedKey || retainedKeys.has(discardedKey) || !session?.ephemeralKeyMappings) {
        return false;
    }

    let changed = false;
    for (const [mappingId, mapping] of Object.entries(session.ephemeralKeyMappings)) {
        if (mapping?.underlyingKeyId === discardedKey) {
            delete session.ephemeralKeyMappings[mappingId];
            changed = true;
        }
    }
    if (Object.keys(session.ephemeralKeyMappings).length === 0) {
        delete session.ephemeralKeyMappings;
    }
    return changed;
}

function getRetainedAccessKeys(session) {
    const retained = new Set();
    if (session?.apiKey && hasExplicitVerifierApproval(session)) {
        retained.add(session.apiKey);
    }
    for (const lane of Object.values(session?.councilAccess || {})) {
        if (lane?.apiKey && hasExplicitVerifierApprovalForAccessInfo(lane.apiKeyInfo)) {
            retained.add(lane.apiKey);
        }
    }
    return retained;
}

export function clearUnsafeOpenRouterCouncilAccess(session, options = {}) {
    if (!session?.councilAccess || typeof session.councilAccess !== 'object') {
        return false;
    }

    const now = typeof options.now === 'function' ? options.now : () => Date.now();
    const isBanned = typeof options.isBanned === 'function' ? options.isBanned : () => false;
    const discardedKeys = [];
    let changed = false;

    for (const [laneId, lane] of Object.entries(session.councilAccess)) {
        if (!lane || typeof lane !== 'object' || !lane.apiKey) continue;
        const expiresAtMs = Date.parse(lane.expiresAt || lane.apiKeyInfo?.expiresAt || lane.apiKeyInfo?.expires_at || '');
        const expired = !Number.isFinite(expiresAtMs) || expiresAtMs <= now();
        const unsafe = !hasExplicitVerifierApprovalForAccessInfo(lane.apiKeyInfo)
            || expired
            || isBanned(lane.apiKeyInfo);
        if (!unsafe) continue;

        discardedKeys.push(lane.apiKey);
        delete session.councilAccess[laneId];
        changed = true;
    }

    if (Object.keys(session.councilAccess).length === 0) {
        delete session.councilAccess;
    }

    const retainedKeys = getRetainedAccessKeys(session);
    for (const discardedKey of discardedKeys) {
        changed = removeRawKeyMappings(session, discardedKey, retainedKeys) || changed;
    }
    return changed;
}

export function clearUnverifiedOpenRouterAccess(session, options = {}) {
    if (!session || (session.inferenceBackend && session.inferenceBackend !== 'openrouter')) {
        return false;
    }

    let changed = clearUnsafeOpenRouterCouncilAccess(session, options);
    if (session.apiKey && !hasExplicitVerifierApproval(session)) {
        const discardedKey = session.apiKey;
        session.apiKey = null;
        session.apiKeyInfo = null;
        session.expiresAt = null;
        session.currentEphemeralKeyId = null;
        changed = true;
        changed = removeRawKeyMappings(session, discardedKey, getRetainedAccessKeys(session)) || changed;
    }

    return changed;
}
