// What the SDK's refusals say about exiting a balance, read once.
//
// A revision 3 SDK refuses some actions for reasons the person can wait out
// (a chat may still be settling, an ownership proof is about to expire, an
// earlier exit can still land) or must act on (the balance is too close to
// its expiry for a new chat, another device spent it). Each refusal is an
// error that carries a machine code and a `data` object. This module is the
// one place those shapes are read: it turns an error into a small, bounded,
// JSON-serializable fact the facade can hold and the state can derive from.
// It never decides what the host does about it: the SDK enforces its own
// rules at the call, and the host never pre-blocks an exit.
//
// Pure module: no SDK, DOM, storage or clock (the caller passes `nowMs`).
//
// Units. The SDK mixes them, and the one table below is the only place the
// difference lives:
//
//   milliseconds   request_settlement_pending.data.{escape_at, must_initiate_by}
//   seconds        exit_release_pending.data.{releasable_after, must_initiate_by}
//                  exit_locked.data.releasable_after
//                  ownership_proof_wait.data.retry_after (a delay, not an instant)
//
// Every instant that leaves this module is epoch milliseconds, inside
// [nowMs, nowMs + 90 days]; anything else becomes null. A unit slip (seconds
// read as milliseconds is a date in January 1970, milliseconds read as
// seconds is a date in the year 58000) therefore reads as "not known" and can
// never arm a timer or print a date. One exception, in the other direction:
// an instant up to a minute behind `nowMs` is a deadline that was reached
// between the SDK computing it and the host reading the error, and is
// returned as `nowMs` ("just ended"), not as "not known": a wait with no end
// is shown until something drops it, a wait that has ended is not shown.
//
// Secrets. A refusal's `data` is read field by field; nothing is copied
// through. The SDK's message (it can name an operator URL or tell the person
// to set an exit RPC the host does not offer) is never read at all.

/** The refusals about exiting a balance, by the code the SDK throws. */
export const EXIT_REFUSAL_CODES = Object.freeze([
    'request_settlement_pending', 'ownership_proof_wait', 'exit_release_pending',
    'exit_locked', 'device_not_newest', 'note_near_expiry'
]);

/**
 * The codes of an exit-only service, by the code the SDK throws. The four
 * manifest codes only count together with a 503 status and `data.exits ===
 * true` (an exit-only refusal, see readServiceRefusal); `native_vault_unverified`
 * is a revision 3 name and counts by itself.
 */
export const SERVICE_REFUSAL_CODES = Object.freeze([
    'deployment_manifest_unavailable', 'deployment_manifest_mismatch', 'deployment_manifest_untrusted',
    'incompatible_proof_circuit', 'native_vault_unverified'
]);

/** How far ahead an instant may lie before it is not believed (90 days). */
export const REFUSAL_HORIZON_MS = 90 * 86_400_000;

/** How far behind the clock an instant may lie and still be "just ended" (60 s). */
export const REFUSAL_SKEW_MS = 60_000;

const MANIFEST_CODES = new Set(SERVICE_REFUSAL_CODES.slice(0, 4));
const VAULT_CODE = 'native_vault_unverified';

const KIND_BY_CODE = Object.freeze({
    request_settlement_pending: 'settlement',
    ownership_proof_wait: 'proof',
    exit_release_pending: 'release',
    exit_locked: 'locked',
    device_not_newest: 'device',
    note_near_expiry: 'near'
});

const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);

// Machine words the SDK writes (a reason, a mode). Anything else is not one.
const MACHINE_WORD = /^[a-z][a-z0-9_]{0,63}$/;
const machineWord = value => (typeof value === 'string' && MACHINE_WORD.test(value) ? value : null);

// An amount in gwei as a canonical decimal string, from a decimal string or a
// safe integer. The SDK writes bounds as strings; anything else is unknown.
function amountString(value) {
    if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 ? String(value) : null;
    if (typeof value === 'string' && /^[0-9]{1,30}$/.test(value)) return String(BigInt(value));
    return null;
}

// A finite number, or null. Strings are not numbers here: the SDK writes
// numeric fields as numbers, and a string is a different producer.
const finite = value => (typeof value === 'number' && Number.isFinite(value) ? value : null);

// An instant in epoch milliseconds inside the believable window, or null. A
// moment that has only just passed is `nowMs` (see the header).
function instant(ms, nowMs) {
    const value = finite(ms);
    if (value === null || nowMs === null) return null;
    if (value < nowMs && value >= nowMs - REFUSAL_SKEW_MS) return nowMs;
    return value >= nowMs && value <= nowMs + REFUSAL_HORIZON_MS ? value : null;
}

// Seconds-valued instant -> milliseconds inside the window, or null.
function secondsInstant(seconds, nowMs) {
    const value = finite(seconds);
    return value === null ? null : instant(value * 1000, nowMs);
}

// The objects an error can carry its code and data on, outermost first: the
// error, the error it wraps, and the `error` object some transports nest in
// the response body.
function layers(error) {
    const found = [];
    const add = value => { if (isRecord(value)) found.push(value); };
    add(error);
    add(error.cause);
    if (isRecord(error.data)) add(error.data.error);
    return found;
}

// The codes one layer names, in the order they are believed: its own `code`,
// then its `data.code`.
function layerCodes(layer) {
    const codes = [];
    if (typeof layer.code === 'string' && layer.code) codes.push(layer.code);
    if (isRecord(layer.data) && typeof layer.data.code === 'string' && layer.data.code) codes.push(layer.data.code);
    return codes;
}

// The record the fields of a refusal sit in: the layer's `data` (also when the
// code itself arrived as `data.code`, whose siblings are the fields). A layer
// with no `data` has no fields: its own properties are never read, because an
// error from another library can carry a `reason` or a `status` of its own.
function payloadOf(layer) {
    return isRecord(layer.data) ? layer.data : {};
}

/**
 * The exit refusal an error carries, or null for every other error.
 *
 * `request_settlement_pending` has two shapes: the withdrawal one carries
 * `escape_at` and is read here; the chat one (`{nullifier_status: 'reserved'}`
 * on a new chat key) says nothing about exiting and returns null, so the
 * SDK's own words stand for it.
 *
 * @param {unknown} error
 * @param {number} nowMs  epoch milliseconds; a refusal read without a usable
 *   clock has no instants (they cannot be checked)
 * @returns {null|{
 *   code: string,
 *   kind: 'settlement'|'proof'|'release'|'locked'|'device'|'near',
 *   untilMs: number|null,
 *   escapeAtMs: number|null,
 *   mustInitiateByMs: number|null,
 *   boundAtState: string|null,
 *   forcedEscape: {zero: string, bound: string}|null,
 *   reason: string|null
 * }}
 *   `untilMs` is when waiting is over: the earliest escape time of a
 *   settlement wait, the retry instant of a proof wait, the instant a pending
 *   release or a lock ends. `escapeAtMs`, `mustInitiateByMs`, `boundAtState`
 *   and `forcedEscape` are only read for a settlement wait (and
 *   `mustInitiateByMs` for a pending release).
 */
export function readExitRefusal(error, nowMs) {
    try {
        if (!error || typeof error !== 'object') return null;
        const now = finite(nowMs);
        for (const layer of layers(error)) {
            const code = layerCodes(layer).find(candidate => Object.prototype.hasOwnProperty.call(KIND_BY_CODE, candidate));
            if (code === undefined) continue;
            const kind = KIND_BY_CODE[code];
            const data = payloadOf(layer);
            const refusal = {
                code,
                kind,
                untilMs: null,
                escapeAtMs: null,
                mustInitiateByMs: null,
                boundAtState: null,
                forcedEscape: null,
                reason: machineWord(data.reason)
            };
            switch (kind) {
                case 'settlement': {
                    // The chat shape has no `escape_at` at all.
                    if (data.escape_at === undefined) return null;
                    refusal.escapeAtMs = instant(data.escape_at, now);
                    refusal.untilMs = refusal.escapeAtMs;
                    refusal.mustInitiateByMs = instant(data.must_initiate_by, now);
                    refusal.boundAtState = amountString(data.bound_at_state);
                    const forced = isRecord(data.forced_escape) ? data.forced_escape : null;
                    const zero = forced ? amountString(forced.zero) : null;
                    const bound = forced ? amountString(forced.bound) : null;
                    refusal.forcedEscape = zero !== null && bound !== null ? { zero, bound } : null;
                    break;
                }
                case 'proof': {
                    const delay = finite(data.retry_after);
                    // A delay in seconds from now; negative is not a delay.
                    if (delay !== null && delay >= 0 && now !== null) refusal.untilMs = instant(now + delay * 1000, now);
                    break;
                }
                case 'release':
                    refusal.untilMs = secondsInstant(data.releasable_after, now);
                    refusal.mustInitiateByMs = secondsInstant(data.must_initiate_by, now);
                    break;
                case 'locked':
                    refusal.untilMs = secondsInstant(data.releasable_after, now);
                    break;
                default:
                    break;
            }
            return refusal;
        }
    } catch { /* an unreadable error is not a refusal */ }
    return null;
}

/**
 * The exit-only service refusal an error carries, or null.
 *
 * The four manifest codes are an AND, not an OR: the code alone is not
 * enough, because the installed legacy SDK throws `incompatible_proof_circuit`
 * as a plain error of its own (no status, no `exits`) about a deployment it
 * cannot use, and that is not "the service is paused, withdrawals still
 * work". Only a 503 that also says `exits: true` is the exit-only refusal.
 * `native_vault_unverified` exists only in revision 3 SDKs and matches by
 * code; a caller applies it only on a page that has versions to tell apart.
 *
 * @param {unknown} error
 * @returns {null|{code: string}}
 */
export function readServiceRefusal(error) {
    try {
        if (!error || typeof error !== 'object') return null;
        for (const layer of layers(error)) {
            const codes = layerCodes(layer);
            if (codes.includes(VAULT_CODE)) return { code: VAULT_CODE };
            const code = codes.find(candidate => MANIFEST_CODES.has(candidate));
            if (code === undefined) continue;
            const data = isRecord(layer.data) ? layer.data : null;
            const status = layer.status ?? data?.status;
            if (status === 503 && data?.exits === true) return { code };
        }
    } catch { /* an unreadable error is not a refusal */ }
    return null;
}
