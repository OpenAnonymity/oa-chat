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
export const ACCESS_MISSING_ACTION = 'access-missing';
export const ACCESS_OVERWRITE_ACTION = 'access-overwrite';
const HELD_ACCESS_STORAGE_KEY = 'oa-held-access';

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
    'missing-after-reload': 'the chat was reloaded from storage without the key this tab held',
    'missing-after-navigation': 'the chat came back from storage without the key this tab held before navigating',
    'stale-save': 'a save without a key is replacing a stored, unexpired key',
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
    markDiscarded(session);
    forgetHeldAccess(session.id);
}

/** A key the session still holds is about to be replaced by a new request. */
export function logAccessReplace(session, reason = 'unspecified', extra = {}) {
    if (!session?.apiKey) return;
    record(ACCESS_REPLACE_ACTION, session, reason, { ...keyFacts(session), ...extra },
        `Requesting a new session key although one is stored: ${describeAccessDiscard(reason)}`);
}

// --- Keys that go missing without a discard ---------------------------------
//
// The discard and replace events above only fire in the tab that acts. A key
// can also vanish with no such act: another tab saves a stale copy of the
// chat over the stored one, a save drops it, or a commit is rolled back. Two
// detectors cover that: the storage layer notices a save that would erase a
// stored, unexpired key (access-overwrite, in the saving tab), and the loading
// side notices a chat coming back without the key this tab held
// (access-missing), across an in-tab reload or a navigation such as the
// return from checkout. The per-tab record lives in sessionStorage and holds
// only the ephemeral key id, station and expiry.

const recentlyDiscarded = new Set();

function unexpired(expiresAt, now = Date.now()) {
    const at = Date.parse(expiresAt || '');
    return Number.isFinite(at) && at > now;
}

function heldStore() {
    try { return globalThis.window?.sessionStorage || null; } catch { return null; }
}

function readHeld() {
    const store = heldStore();
    if (!store) return {};
    try { return JSON.parse(store.getItem(HELD_ACCESS_STORAGE_KEY) || '{}') || {}; } catch { return {}; }
}

function writeHeld(held) {
    const store = heldStore();
    if (!store) return;
    try {
        if (Object.keys(held).length === 0) store.removeItem(HELD_ACCESS_STORAGE_KEY);
        else store.setItem(HELD_ACCESS_STORAGE_KEY, JSON.stringify(held));
    } catch { /* private mode or quota: the detector simply stays quiet */ }
}

/** Record, for this tab, that the session holds a key. Call after setAccessInfo. */
export function rememberHeldAccess(session) {
    if (!session?.id || !session.apiKey) return;
    // A key granted again (the same underlying key keeps its ephemeral id) is
    // live once more; a later loss of it must be reported.
    recentlyDiscarded.delete(session.currentEphemeralKeyId || session.apiKey);
    const facts = keyFacts(session);
    if (!unexpired(facts.expiresAt)) return;
    const held = readHeld();
    held[session.id] = { ephemeralKeyId: facts.ephemeralKeyId, stationId: facts.stationId, expiresAt: facts.expiresAt, backend: facts.backend };
    writeHeld(held);
}

/** The session's key was discarded on purpose; nothing to miss later. */
export function forgetHeldAccess(sessionId) {
    if (!sessionId) return;
    const held = readHeld();
    if (!(sessionId in held)) return;
    delete held[sessionId];
    writeHeld(held);
}

/**
 * A session was loaded from storage. `previous` is the copy this tab held
 * before (if any). Logs when a still-valid key is gone.
 */
export function noteLoadedSession(loaded, previous = null) {
    if (!loaded?.id) return;
    if (loaded.apiKey) {
        rememberHeldAccess(loaded);
        return;
    }
    const held = readHeld()[loaded.id] || null;
    if (previous?.apiKey && unexpired(previous.expiresAt || previous.apiKeyInfo?.expiresAt)
        && !recentlyDiscarded.has(previous.currentEphemeralKeyId || previous.apiKey)) {
        record(ACCESS_MISSING_ACTION, loaded, 'missing-after-reload', keyFacts(previous),
            `Session key missing: ${describeAccessDiscard('missing-after-reload')}`);
    } else if (held && unexpired(held.expiresAt) && !recentlyDiscarded.has(held.ephemeralKeyId)) {
        record(ACCESS_MISSING_ACTION, loaded, 'missing-after-navigation', { ...held, verification: null, verificationDetail: null },
            `Session key missing: ${describeAccessDiscard('missing-after-navigation')}`);
    }
    if (held) forgetHeldAccess(loaded.id);
}

/**
 * The storage layer is about to write `incoming` over `existing`. Logs when
 * that erases a stored, unexpired key that this tab did not discard.
 */
export function logAccessOverwrite(existing, incoming) {
    if (!existing?.apiKey || incoming?.apiKey || existing.id !== incoming?.id) return;
    if (!unexpired(existing.expiresAt || existing.apiKeyInfo?.expiresAt)) return;
    if (recentlyDiscarded.has(existing.currentEphemeralKeyId || existing.apiKey)) return;
    record(ACCESS_OVERWRITE_ACTION, existing, 'stale-save', keyFacts(existing),
        `Session key overwritten: ${describeAccessDiscard('stale-save')}`);
}

function markDiscarded(session) {
    const id = session?.currentEphemeralKeyId || session?.apiKey;
    if (!id) return;
    recentlyDiscarded.add(id);
    if (recentlyDiscarded.size > 64) recentlyDiscarded.delete(recentlyDiscarded.values().next().value);
}
