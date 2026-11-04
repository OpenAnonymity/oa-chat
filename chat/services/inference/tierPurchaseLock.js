import { findTierAccess, mergeTicketAccessHistory } from './ticketTierAccess.js';

// Serialize purchases for this chat across tabs. Re-read only access fields;
// never overwrite the caller's selected model or messages with a stale tab.
export async function withTierPurchaseLock({ session, modelId, cost, service, db, signal, acquire,
    locks = globalThis.navigator?.locks }) {
    if (!locks?.request) throw new Error('Secure ticket access requires browser locking support.');
    return locks.request(`oa-tier-purchase:${session.id}`, { mode: 'exclusive', ...(signal ? { signal } : {}) }, async () => {
        if (signal?.aborted) throw new DOMException('Request aborted', 'AbortError');
        const stored = await db.getSession(session.id);
        if (!stored) throw new Error('This chat is no longer available.');
        Object.assign(session, mergeTicketAccessHistory(session, stored));
        Object.assign(stored, mergeTicketAccessHistory(stored, session));
        const candidates = [stored, session];
        for (const candidate of candidates) {
            const info = findTierAccess(candidate, modelId, cost, service);
            if (info) {
                service.setAccessInfo(session, info);
                await db.updateExistingSession(session.id, latest => {
                    Object.assign(latest, mergeTicketAccessHistory(session, latest));
                    for (const field of ['apiKey', 'apiKeyInfo', 'expiresAt', 'currentEphemeralKeyId', 'ephemeralKeyMappings']) latest[field] = session[field];
                    return true;
                });
                return service.getAccessToken(session);
            }
        }
        // Preserve both tabs' paid access before installing a replacement.
        session.ticketAccessHistory = [...(stored.ticketAccessHistory || []), ...(session.ticketAccessHistory || [])];
        if (stored.apiKeyInfo && stored.apiKey) session.ticketAccessHistory.push({ ...stored.apiKeyInfo, key: stored.apiKey, expiresAt: stored.expiresAt });
        return acquire();
    });
}
