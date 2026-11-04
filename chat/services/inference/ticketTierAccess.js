// Staging evaluation only. No picker changes and no network reads on key reuse.
export function ticketTierPolicyEnabled() {
    return globalThis.location?.hostname === 'staging.openanonymity.ai';
}

export function accessCoversModel(info, modelId, ticketCost) {
    if (!info || !modelId) return false;
    const policy = info.modelPolicy || info.model_policy;
    if (policy != null) {
        // Honor the immutable list purchased with the key, even if prices change.
        return policy.version === 1 && Array.isArray(policy.allowed_models)
            && policy.allowed_models.includes(modelId);
    }
    // Transition for pre-rollout keys: use their recorded purchase, never the
    // currently selected model as evidence of how much was paid.
    const paid = Number(info.ticketsConsumed ?? info.tickets_consumed ?? info.ticketsUsed?.length);
    return Number.isInteger(paid) && paid > 0 && Number.isFinite(ticketCost)
        && ticketCost > 0 && paid >= ticketCost;
}

export function retainTicketAccess(session) {
    const valid = item => item?.key && Date.parse(item.expiresAt || item.expires_at || '') > Date.now();
    const prior = (session.ticketAccessHistory || []).filter(valid);
    const current = session.apiKeyInfo;
    if (session.apiKey && valid({ ...current, key: session.apiKey })) {
        prior.push({ ...current, key: session.apiKey, expiresAt: session.expiresAt });
    }
    session.ticketAccessHistory = [...new Map(prior.map(item => [item.key, item])).values()];
}

export function mergeTicketAccessHistory(incoming, stored = {}) {
    const unexpired = info => Date.parse(info?.expiresAt || info?.expires_at || '') > Date.now();
    const retired = [...(incoming.retiredTicketAccess || []), ...(stored.retiredTicketAccess || [])].filter(unexpired);
    const retiredKeys = new Set(retired.map(info => info.key));
    const history = [...(stored.ticketAccessHistory || []), ...(incoming.ticketAccessHistory || [])];
    if (stored.apiKey && stored.apiKeyInfo) history.push({ ...stored.apiKeyInfo, key: stored.apiKey, expiresAt: stored.expiresAt });
    const councilAccess = { ...(stored.councilAccess || {}), ...(incoming.councilAccess || {}) };
    const ticketLaneHistory = {};
    const lanes = new Set([...Object.keys(councilAccess), ...Object.keys(stored.ticketLaneHistory || {}), ...Object.keys(incoming.ticketLaneHistory || {})]);
    for (const lane of lanes) {
        const previous = stored.councilAccess?.[lane];
        const current = incoming.councilAccess?.[lane];
        if ((previous?.updatedAt || 0) > (current?.updatedAt || 0)) councilAccess[lane] = previous;
        const entries = [...(stored.ticketLaneHistory?.[lane] || []), ...(incoming.ticketLaneHistory?.[lane] || []), previous, current];
        ticketLaneHistory[lane] = [...new Map(entries.filter(item => item?.apiKey && unexpired(item)
            && !retiredKeys.has(item.apiKey)).map(item => [item.apiKey, item])).values()];
    }
    return {
        ticketAccessHistory: [...new Map(history.filter(info => info?.key && unexpired(info)
            && !retiredKeys.has(info.key) && info.key !== incoming.apiKey).map(info => [info.key, info])).values()],
        retiredTicketAccess: [...new Map(retired.map(info => [info.key, info])).values()],
        ...(lanes.size ? { councilAccess, ticketLaneHistory } : {})
    };
}

export function findTierAccess(session, modelId, cost, service) {
    const retired = new Set((session.retiredTicketAccess || []).map(info => info.key));
    const notBanned = candidate => {
        const verifier = service.getVerificationAdapter?.(candidate);
        const stationId = verifier?.getAccessId?.(candidate.apiKeyInfo);
        return !stationId || !(verifier?.isAccessBanned?.(stationId) || verifier?.getAccessState?.(stationId)?.banned);
    };
    const usable = candidate => !retired.has(candidate.apiKey) && notBanned(candidate) && Boolean(service.getAccessToken(candidate))
        && !service.isAccessExpired(candidate)
        && accessCoversModel(candidate.apiKeyInfo, modelId, cost);
    if (usable(session)) return session.apiKeyInfo;
    for (const info of session.ticketAccessHistory || []) {
        const candidate = { ...session, apiKey: info.key, apiKeyInfo: info, expiresAt: info.expiresAt };
        if (usable(candidate)) return info;
    }
    return null;
}
