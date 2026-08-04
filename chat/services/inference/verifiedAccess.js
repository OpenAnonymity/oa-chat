export const LOCAL_LOOPBACK_VERIFIER_BYPASS_STATUS = 'local-loopback-bypass';

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

export function isLocalLoopbackVerifierBypassProof(proof) {
    return proof?.status === LOCAL_LOOPBACK_VERIFIER_BYPASS_STATUS;
}

export function isVerifierProofUsable(proof, options = {}) {
    return isVerifierProofApproved(proof) ||
        (options.allowLocalBypass === true && isLocalLoopbackVerifierBypassProof(proof));
}

export function hasUsableVerifierApproval(session, options = {}) {
    return isVerifierProofUsable(session?.apiKeyInfo?.verifierSubmitKeyProof, options);
}

export function hasUsableVerifierApprovalForAccessInfo(accessInfo, options = {}) {
    return isVerifierProofUsable(accessInfo?.verifierSubmitKeyProof, options);
}

export function buildExplicitlyVerifiedOpenRouterSharePayload(accessInfo) {
    if (!accessInfo || !hasExplicitVerifierApprovalForAccessInfo(accessInfo)) return null;
    return {
        backendId: 'openrouter',
        token: accessInfo.key || accessInfo.token || null,
        expiresAt: accessInfo.expiresAt || accessInfo.expires_at || null,
        expiresAtUnix: accessInfo.expiresAtUnix || accessInfo.expires_at_unix || null,
        stationId: accessInfo.stationId || accessInfo.station_id || accessInfo.station_name || null,
        recentlyAttested: accessInfo.recentlyAttested || accessInfo.station_recently_attested || false,
        stationSignature: accessInfo.stationSignature || accessInfo.station_signature || null,
        orgSignature: accessInfo.orgSignature || accessInfo.org_signature || null,
        usage: accessInfo.usage || null
    };
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

function getRetainedAccessKeys(session, options = {}) {
    const retained = new Set();
    if (session?.apiKey && hasUsableVerifierApproval(session, options)) {
        retained.add(session.apiKey);
    }
    for (const lane of Object.values(session?.councilAccess || {})) {
        if (lane?.apiKey && hasUsableVerifierApprovalForAccessInfo(lane.apiKeyInfo, options)) {
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
        const unsafe = !hasUsableVerifierApprovalForAccessInfo(lane.apiKeyInfo, options)
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

    const retainedKeys = getRetainedAccessKeys(session, options);
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
    if (session.apiKey && !hasUsableVerifierApproval(session, options)) {
        const discardedKey = session.apiKey;
        session.apiKey = null;
        session.apiKeyInfo = null;
        session.expiresAt = null;
        session.currentEphemeralKeyId = null;
        changed = true;
        changed = removeRawKeyMappings(session, discardedKey, getRetainedAccessKeys(session, options)) || changed;
    }

    return changed;
}
