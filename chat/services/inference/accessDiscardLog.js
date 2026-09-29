// Why a session's key went away.
//
// The release browser audit (2026-09-29, finding 1) saw a still-valid key
// disappear between two messages after a return from checkout, so the next
// message spent another ticket. Nothing in the timeline said why. Every path
// that drops or replaces a ticket-bought key now records its reason as a local
// Activity Timeline event, so the next occurrence is traceable from the panel
// or from `[access]` console lines. Nothing secret is logged: the reason, the
// ephemeral key id, the station and the verification status, never the key.

export const ACCESS_DISCARD_ACTION = 'access-discard';
export const ACCESS_REPLACE_ACTION = 'access-replace';

const REASONS = {
    'backend-change': 'the chat switched payment mode',
    'verification-declined': 'you chose to continue without the key after verification failed',
    'credits-exhausted': 'the provider reported the key’s credit as used up',
    'station-banned': 'the key’s station was banned',
    'verifier-rejected': 'the verifier rejected the new key',
    'verifier-retry-rejected': 'a background re-verification rejected the key',
    'persisted-unverified': 'a stored key had no usable verification',
    'council-lane': 'the council lane changed',
    'expired': 'the key had expired',
    'not-usable': 'the key had no usable verification',
    'unspecified': 'no reason was given'
};

export function describeAccessDiscard(reason) {
    return REASONS[reason] || REASONS.unspecified;
}

function keyFacts(session, accessInfo = session?.apiKeyInfo) {
    return {
        ephemeralKeyId: session?.currentEphemeralKeyId || null,
        stationId: accessInfo?.stationId || accessInfo?.station_id || null,
        verification: accessInfo?.verifierSubmitKeyProof?.status || null,
        verificationDetail: accessInfo?.verifierSubmitKeyProof?.detail || null,
        expiresAt: session?.expiresAt || accessInfo?.expiresAt || accessInfo?.expires_at || null,
        backend: session?.inferenceBackend || 'openrouter'
    };
}

function record(action, session, reason, facts, message) {
    const details = { ...facts, reason };
    try {
        console.info(`[access] ${message}`, { sessionId: session?.id || null, ...details });
    } catch { /* logging is best effort */ }
    const logger = globalThis.window?.networkLogger;
    if (!logger || typeof logger.logRequest !== 'function' || !session?.id) return;
    try {
        logger.logRequest({
            type: 'local', method: 'LOCAL', status: 200,
            sessionId: session.id, action, message, response: details
        });
    } catch { /* the timeline never breaks the send path */ }
}

/** A key the session held is being dropped. Call before the fields are cleared. */
export function logAccessDiscard(session, reason = 'unspecified', extra = {}) {
    if (!session?.apiKey) return;
    record(ACCESS_DISCARD_ACTION, session, reason, { ...keyFacts(session), ...extra },
        `Session key discarded: ${describeAccessDiscard(reason)}`);
}

/** A key the session still holds is about to be replaced by a new request. */
export function logAccessReplace(session, reason = 'unspecified', extra = {}) {
    if (!session?.apiKey) return;
    record(ACCESS_REPLACE_ACTION, session, reason, { ...keyFacts(session), ...extra },
        `Requesting a new session key although one is stored: ${describeAccessDiscard(reason)}`);
}
