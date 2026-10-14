// Switching zkAPI builds (a full page reload) and the small amount of state that
// has to survive it.
//
// Everything here is tab-presentation state, validated on the way back in:
//
//   sessionStorage  oa-zkapi-version-switch      one-shot hint for the next boot
//   sessionStorage  oa-zkapi-version-switch-log  loop guard: switch and discard
//                                                timestamps; consuming a hint
//                                                never clears it
//   localStorage    oa-zkapi-upgrade-v1          upgrade intent (version ids and
//                                                a stage only)
//
// The hint can only carry values from fixed enums and version ids that exist in
// the build's table, and it is never a way to choose a build by itself: the
// selection (versionLoader.mjs) honors `prefer` only for an empty slot with
// something to finish. Nothing is ever read from a URL. Every storage access is
// inside try/catch and every failure resolves to the safe answer (no hint, no
// intent, "do not switch / do not discard").
//
// None of these keys is account-synced and none holds a note id, deployment id,
// amount or address.

export const SWITCH_HINT_KEY = 'oa-zkapi-version-switch';
export const SWITCH_LOG_KEY = 'oa-zkapi-version-switch-log';
export const UPGRADE_INTENT_KEY = 'oa-zkapi-upgrade-v1';
// Owned by AccountModal; rewritten here so a reload does not reopen a view that
// no longer exists in the next build.
const RUNNING_MODAL_KEY = 'oa-zkapi-running-modal';

export const SWITCH_REASONS = Object.freeze([
    'upgrade_withdrawn', 'moved_in_other_tab', 'previous_withdrawal_finished',
    'finish_previous', 'claim_credit', 'draft_cleared'
]);
export const SWITCH_VIEWS = Object.freeze(['balance', 'fund', 'withdrawals']);
export const UPGRADE_STAGES = Object.freeze(['withdrawing', 'withdrawn', 'depositing']);

// A third switch or a third discard inside one window is refused.
export const LOOP_WINDOW_MS = 60 * 1000;
export const MAX_SWITCHES_PER_WINDOW = 2;
export const MAX_DISCARDS_PER_WINDOW = 2;
// A hint older than this is a leftover from a boot that never consumed it.
export const SWITCH_HINT_MAX_AGE_MS = 5 * 60 * 1000;
export const UPGRADE_INTENT_TTL_MS = 45 * 24 * 60 * 60 * 1000;

const LOG_MAX_ENTRIES = 16;
const FUTURE_SKEW_MS = 5 * 60 * 1000;
const VERSION_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,31}$/i;
const NETWORK_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/i;

function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isVersionId(value) {
    return typeof value === 'string' && VERSION_ID_PATTERN.test(value);
}

function resolveNow(now) {
    return Number.isFinite(now) ? now : Date.now();
}

// Reading the property itself can throw (blocked site data); absent outside a
// browser.
function defaultStorage(name) {
    try {
        return globalThis[name] || null;
    } catch {
        return null;
    }
}

function invalidRequest(message) {
    const error = new TypeError(message);
    error.code = 'invalid_switch_request';
    return error;
}

// The log's entries inside the window, or null when storage cannot be read
// (the guard cannot be evaluated, so callers refuse). An unparsable value is
// treated as an empty log: nothing in the app writes one.
function readLog(storage, nowMs) {
    let raw;
    try {
        raw = storage.getItem(SWITCH_LOG_KEY);
    } catch {
        return null;
    }
    if (raw === null || raw === undefined) return [];
    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return [];
    }
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(entry => isRecord(entry) && Number.isFinite(entry.t)
        && (entry.k === 'switch' || entry.k === 'discard')
        && Math.abs(nowMs - entry.t) < LOOP_WINDOW_MS)
        .map(entry => ({ t: entry.t, k: entry.k }));
}

function countKind(entries, kind) {
    return entries.filter(entry => entry.k === kind).length;
}

function appendLog(storage, entries, kind, nowMs) {
    try {
        const next = [...entries, { t: nowMs, k: kind }].slice(-LOG_MAX_ENTRIES);
        storage.setItem(SWITCH_LOG_KEY, JSON.stringify(next));
        return true;
    } catch {
        return false;
    }
}

function removeKey(storage, key) {
    try {
        storage.removeItem(key);
    } catch { /* nothing else to do */ }
}

function rewriteRunningModal(storage, view) {
    try {
        if (view) storage.setItem(RUNNING_MODAL_KEY, JSON.stringify({ view }));
        else storage.removeItem(RUNNING_MODAL_KEY);
    } catch { /* A stale dialog view is cosmetic; the switch does not depend on it. */ }
}

function defaultReload() {
    globalThis.location.reload();
}

/**
 * Ask for a page reload into whichever build the next boot selects, carrying a
 * one-shot hint.
 *
 * Refuses (and does not reload) when the caller says work is in flight
 * (`canReload` false, `why: 'busy'`), when it is the third switch inside a
 * minute, and when the loop guard or the hint cannot be stored
 * (`why: 'loop'`): without that record a reload could not be bounded, and the
 * person can always reload the page themselves.
 *
 * This sits on a click path (the reload button), so only the two fields that
 * say what is happening throw. A `view` outside the fixed set, such as a
 * dialog view this build does not know, becomes null: the reloaded page opens
 * on its default view and the saved view is removed. A `prefer` that is not a
 * version id is dropped the same way (the boot then decides from the wallet
 * alone, which is what it does without a hint).
 *
 * @param {{reason: string, view?: 'balance'|'fund'|'withdrawals'|null,
 *   prefer?: string|null, from: string, canReload: boolean, storage?: Storage,
 *   reload?: () => void, now?: number}} options
 * @returns {{ok: boolean, why?: 'busy'|'loop'}}
 * @throws {TypeError} for a reason or source version outside the fixed sets
 *   (a caller bug, never user input).
 */
export function requestVersionSwitch({ reason, view = null, prefer = null, from, canReload, storage, reload, now } = {}) {
    if (!SWITCH_REASONS.includes(reason)) throw invalidRequest('Unknown version switch reason.');
    if (!isVersionId(from)) throw invalidRequest('Invalid source version.');
    if (canReload !== true) return { ok: false, why: 'busy' };
    const switchView = SWITCH_VIEWS.includes(view) ? view : null;
    const preferred = isVersionId(prefer) ? prefer : null;

    const store = storage || defaultStorage('sessionStorage');
    if (!store) return { ok: false, why: 'loop' };
    const nowMs = resolveNow(now);
    const log = readLog(store, nowMs);
    if (log === null || countKind(log, 'switch') >= MAX_SWITCHES_PER_WINDOW) return { ok: false, why: 'loop' };

    try {
        store.setItem(SWITCH_HINT_KEY, JSON.stringify({
            v: 1, at: nowMs, from, reason, view: switchView, prefer: preferred
        }));
    } catch {
        return { ok: false, why: 'loop' };
    }
    if (!appendLog(store, log, 'switch', nowMs)) {
        removeKey(store, SWITCH_HINT_KEY);
        return { ok: false, why: 'loop' };
    }
    rewriteRunningModal(store, switchView);
    try {
        (reload || defaultReload)();
    } catch {
        removeKey(store, SWITCH_HINT_KEY);
        return { ok: false, why: 'busy' };
    }
    return { ok: true };
}

/**
 * Read and delete the hint left by requestVersionSwitch. Called once at boot.
 *
 * Only the hint is deleted: the loop-guard log is a separate key precisely so
 * that consuming a hint cannot reset it. Anything that does not validate
 * (shape, enums, age, a version id the build does not contain) yields null.
 *
 * @param {{storage?: Storage, table?: object[], now?: number}} [options]
 * @returns {{reason: string, view: string|null, from: string, prefer: string|null}|null}
 */
export function consumeVersionSwitch({ storage, table, now } = {}) {
    const store = storage || defaultStorage('sessionStorage');
    if (!store) return null;
    let raw;
    try {
        raw = store.getItem(SWITCH_HINT_KEY);
    } catch {
        return null;
    }
    if (raw === null || raw === undefined) return null;
    // One shot. A hint that cannot be deleted stops being honored when it ages out.
    removeKey(store, SWITCH_HINT_KEY);

    let hint;
    try {
        hint = JSON.parse(raw);
    } catch {
        return null;
    }
    if (!isRecord(hint) || hint.v !== 1) return null;
    const nowMs = resolveNow(now);
    if (!Number.isFinite(hint.at) || hint.at > nowMs + FUTURE_SKEW_MS || nowMs - hint.at > SWITCH_HINT_MAX_AGE_MS) return null;
    if (!SWITCH_REASONS.includes(hint.reason)) return null;
    if (hint.view !== null && !SWITCH_VIEWS.includes(hint.view)) return null;
    if (!isVersionId(hint.from)) return null;
    if (hint.prefer !== null && !isVersionId(hint.prefer)) return null;
    if (Array.isArray(table) && table.length) {
        const known = table.filter(version => isRecord(version)).map(version => version.id);
        if (!known.includes(hint.from)) return null;
        if (hint.prefer !== null) {
            const preferred = table.find(version => isRecord(version) && version.id === hint.prefer);
            if (!preferred || preferred.status === 'retired') return null;
        }
    }
    return { reason: hint.reason, view: hint.view, from: hint.from, prefer: hint.prefer };
}

/**
 * Count one host-side draft discard against the loop guard.
 *
 * Call before attempting a discard. A pre-rollout tab that keeps a deposit
 * screen open re-creates its draft every few seconds; the third discard inside
 * a minute is refused so the two builds cannot trade writes indefinitely. When
 * the guard cannot be stored the answer is "not allowed".
 *
 * This charges the attempt, which is what a retrying watcher wants (it charges
 * a pinned draft once, before its first attempt). A caller that makes a single
 * attempt per page load uses canDiscard before and noteDiscard after instead,
 * so only a discard that happened is counted.
 *
 * @param {{storage?: Storage, now?: number}} [options]
 * @returns {{allowed: boolean}}
 */
export function recordDiscard({ storage, now } = {}) {
    const store = storage || defaultStorage('sessionStorage');
    if (!store) return { allowed: false };
    const nowMs = resolveNow(now);
    const log = readLog(store, nowMs);
    if (log === null || countKind(log, 'discard') >= MAX_DISCARDS_PER_WINDOW) return { allowed: false };
    return { allowed: appendLog(store, log, 'discard', nowMs) };
}

/**
 * Whether one more host-side draft discard is allowed, without counting it.
 *
 * The check-only half of recordDiscard, for a caller that charges the guard
 * only once a discard has really happened (see noteDiscard): an attempt that
 * was refused, found the lock busy or found nothing to clear must not use up
 * the allowance, or a few reloads beside a busy tab would raise the loop
 * notice without anything having been written. Reads only; never writes the
 * log. When the guard cannot be read the answer is "not allowed".
 *
 * @param {{storage?: Storage, now?: number}} [options]
 * @returns {{allowed: boolean}}
 */
export function canDiscard({ storage, now } = {}) {
    const store = storage || defaultStorage('sessionStorage');
    if (!store) return { allowed: false };
    const log = readLog(store, resolveNow(now));
    return { allowed: log !== null && countKind(log, 'discard') < MAX_DISCARDS_PER_WINDOW };
}

/**
 * Count one host-side draft discard that has happened.
 *
 * Call after the discard committed (`canDiscard` said yes before it). The write
 * is best effort: the discard cannot be undone, so a log that cannot be written
 * is reported (`recorded: false`) and nothing else changes; the next
 * `canDiscard` then fails closed if the log is unreadable. Counting here is
 * what keeps the invariant of recordDiscard: successful discards per window
 * stay capped at MAX_DISCARDS_PER_WINDOW.
 *
 * @param {{storage?: Storage, now?: number}} [options]
 * @returns {{recorded: boolean}}
 */
export function noteDiscard({ storage, now } = {}) {
    const store = storage || defaultStorage('sessionStorage');
    if (!store) return { recorded: false };
    const nowMs = resolveNow(now);
    const log = readLog(store, nowMs);
    if (log === null) return { recorded: false };
    return { recorded: appendLog(store, log, 'discard', nowMs) };
}

// A clean copy of a valid intent, or null.
function normalizeIntent(value) {
    if (!isRecord(value) || value.v !== 1) return null;
    if (typeof value.network !== 'string' || !NETWORK_PATTERN.test(value.network)) return null;
    if (!isVersionId(value.from) || !isVersionId(value.to) || value.from === value.to) return null;
    if (!UPGRADE_STAGES.includes(value.stage)) return null;
    if (!Number.isFinite(value.since) || value.since <= 0) return null;
    return { v: 1, network: value.network, from: value.from, to: value.to, stage: value.stage, since: value.since };
}

/**
 * The saved upgrade intent for `network`, or null when there is none, it is for
 * another network, it is malformed, in the future or older than 45 days.
 * Read-only: it never deletes what it rejects.
 *
 * @param {{network: string, storage?: Storage, now?: number}} options
 * @returns {{v: 1, network: string, from: string, to: string, stage: string, since: number}|null}
 */
export function readUpgradeIntent({ network, storage, now } = {}) {
    if (typeof network !== 'string' || !NETWORK_PATTERN.test(network)) return null;
    const store = storage || defaultStorage('localStorage');
    if (!store) return null;
    let intent;
    try {
        const raw = store.getItem(UPGRADE_INTENT_KEY);
        if (raw === null || raw === undefined) return null;
        intent = normalizeIntent(JSON.parse(raw));
    } catch {
        return null;
    }
    if (!intent || intent.network !== network) return null;
    const nowMs = resolveNow(now);
    if (intent.since > nowMs + FUTURE_SKEW_MS || nowMs - intent.since > UPGRADE_INTENT_TTL_MS) return null;
    return intent;
}

/**
 * Save the upgrade intent. Only the six fields of a valid intent are stored.
 * @param {{v: 1, network: string, from: string, to: string, stage: string, since: number}} intent
 * @param {{storage?: Storage}} [options]
 * @returns {boolean} whether it was stored
 */
export function writeUpgradeIntent(intent, { storage } = {}) {
    const clean = normalizeIntent(intent);
    if (!clean) return false;
    const store = storage || defaultStorage('localStorage');
    if (!store) return false;
    try {
        store.setItem(UPGRADE_INTENT_KEY, JSON.stringify(clean));
        return true;
    } catch {
        return false;
    }
}

/** Forget the upgrade intent (the upgrade finished or the person abandoned it). */
export function clearUpgradeIntent({ storage } = {}) {
    const store = storage || defaultStorage('localStorage');
    if (store) removeKey(store, UPGRADE_INTENT_KEY);
}
