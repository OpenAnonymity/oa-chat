// Freshly issued, verified ticket keys can be rejected by OpenRouter with
// HTTP 401 "User not found." for roughly the first half-minute, then accepted
// unchanged (observed once; the provider's internals are unknown). This module
// remembers, for this tab only, when such a key was received so the 401
// boundary can keep resending the identical request inside one absolute
// window. Nothing is persisted or reported. Keys it does not know (older,
// reloaded, restored, shared, private leases) keep the short default policy.

export const FRESH_KEY_READINESS_WINDOW_MS = 60_000;
const MAX_TRACKED_KEYS = 16;
// Keys that already had a window: a key is windowed at most once per page
// load, even after its window closed. Bounded; oldest forgotten first.
const MAX_SEEN_KEYS = 64;

export const readinessClock = Object.freeze({
    now: () => globalThis.performance?.now?.() ?? Date.now(),
    wallNow: () => Date.now()
});

// tag -> { deadline (monotonic), expiresAtMs (wall) }
const pending = new Map();
const seen = new Set();

// Map key for the registry, so it does not hold the credential string itself.
// FNV-1a is NOT cryptographic: this is a lookup tag, not a protection. The key
// is already held in memory by the session; nothing here is logged or stored.
function credentialTag(key) {
    if (typeof key !== 'string' || key.length < 8) return '';
    let a = 0x811c9dc5, b = 0x01000193 ^ key.length;
    for (let i = 0; i < key.length; i++) {
        const c = key.charCodeAt(i);
        a = Math.imul(a ^ c, 0x01000193) >>> 0;
        b = Math.imul(b ^ c ^ (i & 0xff), 0x01000193) >>> 0;
    }
    return `${a.toString(16).padStart(8, '0')}${b.toString(16).padStart(8, '0')}`;
}

export function bearerToken(headers) {
    if (!headers || typeof headers !== 'object') return '';
    const name = Object.keys(headers).find(key => key.toLowerCase() === 'authorization');
    const match = name ? /^\s*Bearer\s+(\S+)\s*$/i.exec(String(headers[name] || '')) : null;
    return match ? match[1] : '';
}

function prune(clock) {
    const now = clock.now();
    const wallNow = clock.wallNow();
    for (const [tag, entry] of pending) {
        if (now >= entry.deadline || (Number.isFinite(entry.expiresAtMs) && wallNow >= entry.expiresAtMs)) pending.delete(tag);
    }
}

/**
 * Record a key this tab just received from the station and the verifier then
 * explicitly approved. `receivedAt` is the monotonic time the key arrived
 * (before verification), so a slow verifier never extends the window. A key is
 * recorded at most once: a repeat call never opens or extends a window.
 */
export function markFreshInferenceKey(key, { receivedAt, expiresAt = null, clock = readinessClock } = {}) {
    const tag = credentialTag(key);
    if (!tag || seen.has(tag)) return;
    seen.add(tag);
    while (seen.size > MAX_SEEN_KEYS) seen.delete(seen.values().next().value);
    const start = Number.isFinite(receivedAt) ? receivedAt : clock.now();
    const expiresAtMs = expiresAt == null ? NaN : (typeof expiresAt === 'number' ? expiresAt : Date.parse(expiresAt));
    pending.set(tag, { deadline: start + FRESH_KEY_READINESS_WINDOW_MS, expiresAtMs });
    prune(clock);
    while (pending.size > MAX_TRACKED_KEYS) pending.delete(pending.keys().next().value);
}

/** The provider accepted this key: its window closes for every caller. */
export function markInferenceKeyAccepted(key) {
    const tag = credentialTag(key);
    if (tag) pending.delete(tag);
}

/**
 * For a key still inside its readiness window (and before its expiry): the
 * monotonic deadline and wall-clock expiry. Null otherwise.
 */
export function getFreshKeyReadiness(key, clock = readinessClock) {
    const tag = credentialTag(key);
    if (!tag) return null;
    prune(clock);
    const entry = pending.get(tag);
    return entry ? { deadline: entry.deadline, expiresAtMs: entry.expiresAtMs } : null;
}
