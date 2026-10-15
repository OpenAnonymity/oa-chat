// Which protocol version this tab is on, what that means for the user's
// balance and deposits, and whether to nudge an upgrade (docs/ZKAPI_VERSIONING.md,
// "The runtime facade").
//
// One pure function turns facts into a VersionState: the loaded version, the
// deposit target, the SDK snapshot normalized by the adapter, the boot-time
// selection, a fresh preview of that selection, the persisted upgrade intent
// and the clock. It runs on every snapshot change and clock tick, so it never
// throws, never mutates its input and never reads a global. `now` is an
// argument; so is everything else.
//
// The nudge is orthogonal to the UX state machine (zkapiUxState): it never
// blocks chat, and a user with nothing to move is never prompted.
//
// Units: `closeByTs`, `expiryTs` and every field named `...Ms` are epoch
// MILLISECONDS (the same unit as `now`), although the SDK's note expiry is in
// seconds.

import { boundedOperatorText } from './copy.mjs';
import { deriveUpgradeStage, intentProvesWithdrawal } from './upgradeFlow.mjs';

/**
 * @typedef {object} DepositGate
 * @property {boolean} canStart  a new deposit may begin
 * @property {boolean} canResume a deposit that already started may be finished
 * @property {null|'version_unavailable'|'foreign_runtime'|'holdings_unreadable'|'config_mismatch'
 *   |'stale_build'|'deposits_closed'|'previous_withdrawal_open'|'reload_required'} code
 *   why `canStart` is false. `reload_required` is restrict-only: a fresh read
 *   of the wallet found the slot held by another live version (the balance
 *   moved in another tab), so this tab, which would otherwise take deposits,
 *   is not the build to deposit with until it reloads. It never reopens a gate
 *   another code closed and is cleared by the reload itself.
 * @property {{id: string, label: string}|null} successor
 *
 * @typedef {object} VersionNotice  an operator notice that took effect
 * @property {string} versionId  the version whose operator announced it
 * @property {string} text       bounded operator text: at most 280 UTF-16 units,
 *   control characters removed, whitespace collapsed. Plain text and NOT
 *   html-escaped: the renderer escapes (safeOperatorText) or sets textContent.
 *
 * @property {number|null} noteId  the note the notice is about. A note number
 *   is only meaningful with its version (numbers repeat across vaults), so it
 *   is shown as a reference beside the version, never on its own.
 *
 * @typedef {object} VersionState  The fields are
 *   show, current, target, holding, depositsOpen, gate, phase, closeByTs,
 *   expiryTs, deadlineSource, reminderTier, upgrade, reload, previous, unsent
 *   and service; `notices` is additive: Array<VersionNotice>, the
 *   matched, unexpired operator `stuck_escape` notices that relaxed the
 *   deposit gate for a record this browser holds (the same match rule as the
 *   relaxation itself: note id, mode `escape`, phase `pending`, notice not
 *   expired). `[]` otherwise, and always JSON-serializable and stable (ordered
 *   by version ordinal, then by the table's notice order) so it can be part of
 *   a change signature.
 *
 *   Five more fields are additive facts about the balance. The first four are
 *   not phases (the precedence below does not move for them): each is a
 *   notice the renderers add. The fifth, `held`, is a phase of its own,
 *   `balance-unreachable`, placed in the precedence below.
 *     service  null | {message, code}. `message` is the SDK's own text and is
 *              never shown (copy.mjs speaks by `code`); `code` is a machine
 *              word or null.
 *     exit     null | the slot note's exit facts: nearExpiry,
 *              mustInitiateByMs, boundAtState (gwei string), stateFresh,
 *              escapeAtMs, frozen {untilMs, mode}|null, deviceNotNewest,
 *              wait {kind, untilMs, escapeAtMs, mustInitiateByMs,
 *              boundAtState}|null, kit {exported, outOfDate, depositPathSaved,
 *              unsaved}, rpc {recommended, wrongChain}. null when the
 *              snapshot reports no exit (no slot note, or a protocol that has
 *              none). `exitRefusal` and `kitUnsaved` can only tighten it.
 *     payouts  {credited, alerts}: this version's own unclaimed credited
 *              payouts and payouts that exceeded their disclosed bound
 *     setAside {near, earliestMustInitiateByMs, device}: set-aside records
 *              near their deadline, the earliest instant one must be
 *              withdrawn by, and records this device may not exit
 *     abandon  null | {available, kind, blockedBy}: the facade's verdict on
 *              giving up a zero or dust balance (null when not computed)
 *     held     null | {unreachable: true}: this browser's wallet holds a
 *              balance of THIS version (the host's own read of the database
 *              says so) and the version's SDK did not start, so its snapshot
 *              has no note and the page cannot read the balance. It is not an
 *              empty balance: `holding` is not `none`, `phase` is
 *              `balance-unreachable`, and nothing that needs a started SDK
 *              (an upgrade, a withdrawal, giving the balance up) is on offer
 *              (`upgrade.blockedBy` and `abandon.blockedBy` are
 *              `service_unreachable`). It also closes the deposit gate with
 *              `holdings_unreadable` when nothing else did (the version that
 *              takes deposits: the SDK that would start a deposit is the one
 *              that did not start). null whenever the SDK started, the slot
 *              is empty or another version holds it, or the SDK reads a note.
 */

const DAY_MS = 86_400_000;
const DEFAULT_REMINDER_DAYS = Object.freeze([7, 3, 1]);
const DEFAULT_PROMPT_WINDOW_DAYS = 14;
const DEFAULT_SWEEPABLE_PHASES = Object.freeze(['parked']);
// Holder of open records whose deployment this build has no row for: they
// still block deposits (fail closed) but cannot be named or opened.
const UNKNOWN_VERSION = '\u0000unknown';

// Previews that are not evidence for "reload". A failed probe says nothing
// about the database, and a foreign or retired slot owner is the deposit
// gate's business (a reload would not make the tab more correct).
const NO_RELOAD_PREVIEW_REASONS = new Set(['holdings_unreadable', 'unknown_deployment', 'retired_deployment']);
// Selection reasons that positively say the slot is taken or unknown.
const SLOT_NOT_EMPTY_REASONS = new Set([
    'runtime_holds_note', 'unknown_deployment', 'retired_deployment', 'holdings_unreadable', 'single_version'
]);

const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const asArray = value => (Array.isArray(value) ? value : []);
const finiteNumber = value => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const positiveNumber = value => {
    const number = finiteNumber(value);
    return number !== null && number > 0 ? number : null;
};
const nonEmptyString = value => (typeof value === 'string' && value ? value : null);
const VERSION_STATUSES = new Set(['active', 'exit-only', 'retired']);

// Machine words the SDK and the facade write (service codes, lock modes, a
// verdict's reason). Operator text is never one of these: a value that is not
// word-shaped is "no code".
const MACHINE_WORD = /^[a-z][a-z0-9_]{0,63}$/;
const machineWord = value => (typeof value === 'string' && MACHINE_WORD.test(value) ? value : null);

// An amount in gwei as a canonical decimal string (the SDK writes bounds as
// strings and balances as numbers), or null.
function amountString(value) {
    if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 ? String(value) : null;
    if (typeof value === 'string' && /^[0-9]{1,30}$/.test(value)) return String(BigInt(value));
    return null;
}

// The larger of two amountStrings, ignoring one that is null.
function largerAmount(a, b) {
    if (a === null) return b;
    if (b === null) return a;
    return BigInt(a) >= BigInt(b) ? a : b;
}

// The later of two instants, ignoring one that is null.
const latest = (a, b) => (a === null ? b : b === null ? a : Math.max(a, b));

const nonNegativeCount = value => (Number.isSafeInteger(value) && value >= 0 ? value : 0);

// An epoch-millisecond instant that a deadline notice may print or arm a timer
// for. The SDK mixes seconds and milliseconds, and the normalizer has already
// made every instant here milliseconds, but a value that slips through in
// seconds (a date in January 1970) or in microseconds (the year 58000) must
// read as "not known" and never as a date. Same window as the normalizer's.
const MIN_EPOCH_MS = 1e11;
const MAX_EPOCH_MS = 1e14;
const epochMs = value => (typeof value === 'number' && Number.isFinite(value)
    && value >= MIN_EPOCH_MS && value <= MAX_EPOCH_MS ? value : null);

function usableVersion(version) {
    return isRecord(version) && nonEmptyString(version.id) !== null && VERSION_STATUSES.has(version.status);
}

function versionRef(version) {
    return isRecord(version) && nonEmptyString(version.id)
        ? { id: version.id, label: typeof version.label === 'string' ? version.label : version.id }
        : null;
}

// ---------------------------------------------------------------------------
// Time: close-by and reminder tiers
// ---------------------------------------------------------------------------

// The version's own policy, tolerant of a malformed row: the registry
// validator guarantees the shape for every shipped row, so this only matters
// for hand-built input, where "remind more, not less" is the safe direction.
function transitionOf(version) {
    const transition = isRecord(version?.transition) ? version.transition : {};
    const days = Array.isArray(transition.reminderDays)
        ? [...new Set(transition.reminderDays.filter(day => positiveNumber(day) !== null))].sort((a, b) => a - b)
        : [...DEFAULT_REMINDER_DAYS].sort((a, b) => a - b);
    const windowDays = positiveNumber(transition.promptWindowDays) ?? DEFAULT_PROMPT_WINDOW_DAYS;
    return { reminderDays: days, promptWindowMs: windowDays * DAY_MS };
}

// Close-by instant (epoch ms) of a note expiring at `expirySeconds`. The
// adapter owns the rule (and may override it for exit mechanics); without one
// the version's own margin applies, which is the same arithmetic.
function closeByFor(adapter, expirySeconds, version) {
    if (adapter && typeof adapter.closeBy === 'function') {
        let value;
        try {
            value = adapter.closeBy(expirySeconds, version);
        } catch {
            return null;
        }
        return positiveNumber(value);
    }
    const margin = version?.transition?.closeByMarginSeconds;
    if (!Number.isSafeInteger(margin) || margin < 0 || margin >= expirySeconds) return null;
    return (expirySeconds - margin) * 1000;
}

// null | one of reminderDays | 0.
//   0      the close-by instant has been reached and the note has not expired
//   d      the smallest configured day count that is at least the time left
//          to close-by (7 days left or fewer, but more than 3, is tier 7)
//   null   farther away than every reminder, no close-by, or already expired
// Bounds are inclusive: exactly 7 days left is tier 7.
function reminderTierFor(closeByTs, expiryMs, now, reminderDays) {
    if (closeByTs === null || now === null) return null;
    if (now >= expiryMs) return null;
    const remaining = closeByTs - now;
    if (remaining <= 0) return 0;
    for (const days of reminderDays) {
        if (remaining <= days * DAY_MS) return days;
    }
    return null;
}

// ---------------------------------------------------------------------------
// Deadlines
// ---------------------------------------------------------------------------

// Every deadline the loaded SDK reports: the slot note plus set-aside notes.
// A hand-built snapshot that has a note and an expiry but no deadline list
// still yields the slot deadline; an extra deadline only reminds earlier.
//
// Each entry says whether this device may still exit that note
// (`deviceFlagged`: another device or copy spent its successor, so a
// withdrawal from here would be rejected). A flagged note keeps its deadline,
// because it still holds funds and still expires, but it is never nudged
// toward a withdrawal. `slotFlagged` is the same fact for the slot note, which
// the snapshot reports on its exit summary and not on a deadline entry. The
// flag is part of the dedup key: two records that share an expiry second are
// two deadlines when only one of them can be exited here.
function loadedDeadlines(snapshot, slotFlagged) {
    const list = [];
    const add = (source, expiryTs, deviceFlagged) => {
        const expirySeconds = positiveNumber(expiryTs);
        if (expirySeconds === null) return;
        if (list.some(entry => entry.source === source && entry.expirySeconds === expirySeconds
            && entry.deviceFlagged === deviceFlagged)) return;
        list.push({ source, expirySeconds, deviceFlagged });
    };
    for (const deadline of snapshot.deadlines) {
        if (!isRecord(deadline)) continue;
        if (deadline.source === 'slot') add('slot', deadline.expiryTs, slotFlagged);
        else if (deadline.source === 'set-aside') add('set-aside', deadline.expiryTs, deadline.deviceFlagged === true);
    }
    if (snapshot.hasNote && !list.some(entry => entry.source === 'slot')) add('slot', snapshot.expiryTs, slotFlagged);
    return list;
}

function earliest(candidates, key) {
    let best = null;
    for (const candidate of candidates) {
        if (best === null || candidate[key] < best[key]) best = candidate;
    }
    return best;
}

function earliestCloseBy(candidates) {
    const dated = candidates.filter(candidate => candidate.closeByTs !== null);
    return dated.length ? earliest(dated, 'closeByTs').closeByTs : null;
}

// The records a holdings map (Selection.open, Selection.credits) lists for
// one version id.
function recordsFor(map, id) {
    return isRecord(map) && hasOwn(map, id) ? asArray(map[id]) : [];
}

// The candidate that drives the reminder: the earliest close-by (so the note
// that must move first wins), then the earliest expiry, then the slot note.
function pickDeadline(candidates) {
    let best = null;
    for (const candidate of candidates) {
        if (best === null) { best = candidate; continue; }
        const a = candidate.closeByTs ?? Infinity;
        const b = best.closeByTs ?? Infinity;
        if (a < b
            || (a === b && (candidate.expirySeconds < best.expirySeconds
                || (candidate.expirySeconds === best.expirySeconds && candidate.source === 'slot' && best.source !== 'slot')))) {
            best = candidate;
        }
    }
    return best;
}

// ---------------------------------------------------------------------------
// Other versions' open withdrawals and credits
// ---------------------------------------------------------------------------

function recordKey(record, index, prefix) {
    const id = nonEmptyString(record.recordId);
    return id ? `${prefix}:${id}` : `${prefix}:#${index}:${record.noteId ?? ''}`;
}

// An operator-announced stuck escape relaxes the gate for exactly that record
// (registry code `notice`): same note, an escape, still pending, notice
// unexpired. Without a clock nothing is covered. Returns the notice that
// covers the record, or null; the gate and the text shown to the holder share
// this one rule, so a notice is only ever explained where it took effect.
function matchingNotice(version, record, now) {
    if (!version || now === null || !Array.isArray(version.notices)) return null;
    if (record.mode !== 'escape' || record.phase !== 'pending') return null;
    if (!Number.isSafeInteger(record.noteId)) return null;
    return version.notices.find(notice => isRecord(notice)
        && notice.kind === 'stuck_escape'
        && notice.noteId === record.noteId
        && finiteNumber(notice.expiresAt) !== null
        && notice.expiresAt > now) || null;
}

function versionByDeployment(table, deploymentId) {
    if (typeof deploymentId !== 'string' || !deploymentId) return null;
    return table.find(version => isRecord(version) && version.deploymentId === deploymentId) || null;
}

// Per other (non-loaded) version: its open withdrawals that still block
// deposits and its unclaimed credits. Sources are the holdings facts of the
// freshest readable selection and, for SDKs that report it, the loaded SDK's
// own list of other deployments; both are kept (union, deduplicated by record
// id) because either may know something the other does not yet. Records of
// retired deployments are ignored: no bundle can finish them.
function collectOthers({ table, active, facts, snapshot, now }) {
    const byVersion = new Map();
    const bucket = (id, version) => {
        if (!byVersion.has(id)) byVersion.set(id, { id, version, withdrawals: new Map(), credits: new Map() });
        return byVersion.get(id);
    };
    const target = (id, version) => (version && version.status === 'retired' ? null : bucket(id, version));

    const open = isRecord(facts.open) ? facts.open : {};
    for (const id of Object.keys(open)) {
        if (id === active.id) continue;
        const version = table.find(entry => isRecord(entry) && entry.id === id) || null;
        const entry = target(version ? id : UNKNOWN_VERSION, version);
        if (!entry) continue;
        asArray(open[id]).forEach((record, index) => {
            if (isRecord(record)) entry.withdrawals.set(recordKey(record, index, 'w'), record);
        });
    }
    const credits = isRecord(facts.credits) ? facts.credits : {};
    for (const id of Object.keys(credits)) {
        if (id === active.id) continue;
        const version = table.find(entry => isRecord(entry) && entry.id === id) || null;
        const entry = target(version ? id : UNKNOWN_VERSION, version);
        if (!entry) continue;
        asArray(credits[id]).forEach((record, index) => {
            if (isRecord(record)) entry.credits.set(recordKey(record, index, 'c'), record);
        });
    }

    const fromSdk = (records, kind) => {
        asArray(records).forEach((record, index) => {
            if (!isRecord(record)) return;
            const version = versionByDeployment(table, record.deploymentId);
            if (version && version.id === active.id) return;
            const entry = target(version ? version.id : UNKNOWN_VERSION, version);
            if (!entry) return;
            if (kind === 'w') entry.withdrawals.set(recordKey(record, index, 'w'), record);
            else entry.credits.set(recordKey(record, index, 'c'), record);
        });
    };
    fromSdk(snapshot.otherDeploymentWithdrawals, 'w');
    fromSdk(snapshot.otherDeploymentCredits, 'c');

    return [...byVersion.values()].map(entry => {
        const open = [];
        const covered = [];
        for (const record of entry.withdrawals.values()) {
            const notice = matchingNotice(entry.version, record, now);
            // Covered records do not block deposits and are not "unfinished
            // business": the operator's notice tells the user what to do.
            if (notice) covered.push(notice);
            else open.push(record);
        }
        return {
            id: entry.id,
            version: entry.version,
            open,
            covered,
            credits: [...entry.credits.values()]
        };
    });
}

// The operator text of every notice that relaxed the gate (collectOthers'
// `covered`), bounded and without duplicates, ordered by version ordinal then
// by the order the registry lists them. Only named versions have a row to
// attribute a notice to, and a notice only exists on a row.
function collectNotices(others) {
    const named = others.filter(entry => entry.version !== null && entry.covered.length > 0);
    named.sort((a, b) => (finiteNumber(a.version.ordinal) ?? Infinity) - (finiteNumber(b.version.ordinal) ?? Infinity));
    const seen = new Set();
    const notices = [];
    for (const entry of named) {
        for (const notice of entry.covered) {
            const text = boundedOperatorText(notice.text);
            if (!text) continue;
            // A matched notice always has a note id (the match requires one).
            // Two notes with the same words are two notices: each has its own
            // reference number.
            const noteId = Number.isSafeInteger(notice.noteId) ? notice.noteId : null;
            const key = `${entry.id}\u0000${noteId}\u0000${text}`;
            if (seen.has(key)) continue;
            seen.add(key);
            notices.push({ versionId: entry.id, text, noteId });
        }
    }
    return notices;
}

// ---------------------------------------------------------------------------
// The fail-closed shape
// ---------------------------------------------------------------------------

// An input the function cannot reason about (no loaded version, no
// selection): nothing is shown and nothing may be deposited. The UI renders
// as it would without version context, with the deposit gate shut.
function unavailableState(active, busy) {
    return {
        show: false,
        current: {
            id: nonEmptyString(active?.id) || '',
            label: typeof active?.label === 'string' ? active.label : '',
            status: VERSION_STATUSES.has(active?.status) ? active.status : 'retired'
        },
        target: null,
        holding: 'none',
        depositsOpen: false,
        gate: { canStart: false, canResume: false, code: 'version_unavailable', successor: null },
        phase: 'current',
        closeByTs: null,
        expiryTs: null,
        deadlineSource: null,
        reminderTier: null,
        upgrade: { available: false, canStart: false, blockedBy: null, stage: 'idle' },
        reload: { required: false, canReload: busy !== true, reason: null, targetId: null },
        previous: null,
        unsent: false,
        service: null,
        notices: [],
        exit: null,
        payouts: { credited: 0, alerts: 0 },
        setAside: { near: 0, earliestMustInitiateByMs: null, device: 0 },
        abandon: null,
        held: null
    };
}

function readSnapshot(value) {
    const input = isRecord(value) ? value : {};
    return {
        hasNote: input.hasNote === true,
        expiryTs: positiveNumber(input.expiryTs),
        deadlines: asArray(input.deadlines),
        hasPendingDeposit: input.hasPendingDeposit === true,
        hasUnsentPrepared: input.hasUnsentPrepared === true,
        hasPreparedWithdrawal: input.hasPreparedWithdrawal === true,
        hasOpenWithdrawal: input.hasOpenWithdrawal === true,
        sdkDepositsClosed: input.sdkDepositsClosed === true,
        service: isRecord(input.service) ? input.service : null,
        otherDeploymentWithdrawals: asArray(input.otherDeploymentWithdrawals),
        otherDeploymentCredits: asArray(input.otherDeploymentCredits),
        // Only the concession family reports these. A snapshot without them
        // (note-bound-v1, emptyNormalizedSnapshot) reads as nothing to report.
        exit: isRecord(input.exit) ? input.exit : null,
        ownCredits: asArray(input.ownCredits),
        payoutAlerts: asArray(input.payoutAlerts),
        deviceNotNewestRecords: asArray(input.deviceNotNewestRecords),
        setAsideNear: asArray(input.setAsideNear),
        unresolvedRequests: nonNegativeCount(input.unresolvedRequests)
    };
}

// ---------------------------------------------------------------------------
// Reload
// ---------------------------------------------------------------------------

// Whether a fresh load would pick a different version than this tab runs, and
// why. The preview comes from the holdings watcher (chooseZkapiVersion on a
// fresh read); `null` means no preview, which is never a reason to reload.
//
// One deliberate guard: a tab that was opened ON a version to finish its open
// withdrawals or claim its credits (or that just withdrew its note and is
// waiting for the chain) is exactly where it should be. A fresh load with no
// hint would pick the deposit target instead, so without this guard the user
// would be told to reload away from the build that can finish their work,
// and would be sent back by the next "open version" button: a loop. The tab
// stays until nothing is left open here; then the reload becomes required.
function deriveReload({ active, selection, preview, snapshot, intent, busy }) {
    const canReload = busy !== true;
    const none = { required: false, canReload, reason: null, targetId: null };
    if (!isRecord(preview) || !isRecord(preview.version) || !nonEmptyString(preview.version.id)) return none;
    if (NO_RELOAD_PREVIEW_REASONS.has(preview.reason)) return none;
    if (preview.version.id === active.id) return none;

    if (preview.reason === 'no_runtime_note') {
        const unfinishedHere = recordsFor(preview.open, active.id).length > 0
            || recordsFor(preview.credits, active.id).length > 0
            || snapshot.hasOpenWithdrawal || snapshot.hasPreparedWithdrawal;
        if (unfinishedHere) return none;
    }

    // Each specific reason is a CLAIM the words then make as fact, so each
    // needs its own evidence; anything weaker is the neutral reason, which
    // only says deposits moved.
    let reason = 'previous_withdrawal_finished';
    if (isRecord(intent) && intent.from === active.id && intent.to === preview.version.id
        && intentProvesWithdrawal(intent)) {
        // "Your balance is back in your wallet". A bare `withdrawing` intent
        // only says the review step was opened: a balance that expired, was
        // claimed by the treasury or was archived leaves the wallet just as
        // empty. The facade promotes the intent when it observes a
        // payout-verified closure, so the in-tab path keeps this reason.
        reason = 'upgrade_withdrawn';
    } else if ((selection.slotKind === 'draft_only' || selection.slotKind === 'unsent_prepared')
        && preview.slotKind === 'empty') {
        reason = 'draft_cleared';
    } else if (preview.reason === 'runtime_holds_note') {
        // A fresh read found a runtime-held note in the database that this
        // tab is not on: another tab moved it. This tab's own `hasNote` alone
        // is not that evidence (a fresh read may well find the wallet empty:
        // the note was withdrawn or forfeited elsewhere).
        reason = 'moved_in_other_tab';
    }
    return { required: true, canReload, reason, targetId: preview.version.id };
}

// ---------------------------------------------------------------------------
// Gate
// ---------------------------------------------------------------------------

// First match wins: version_unavailable is decided by the caller, then
// selection blocks, the served-config check, the stale-build latch, closed
// deposits, another version's unfinished withdrawal, and finally a required
// reload (the balance moved to another version in another tab).
function selectionBlock(selection, preview) {
    const block = selection.depositBlock;
    if (block === 'foreign_runtime' || block === 'holdings_unreadable') return block;
    if (block !== null && block !== undefined) return 'holdings_unreadable';
    // A row the loader reports without its block would be a loader bug; the
    // reason is enough to close deposits.
    if (selection.reason === 'holdings_unreadable') return 'holdings_unreadable';
    if (selection.reason === 'unknown_deployment' || selection.reason === 'retired_deployment') return 'foreign_runtime';
    // A fresh preview that finds a slot owner this build cannot open closes
    // deposits too. It never reopens them: a blocked boot stays blocked until
    // the user reloads.
    if (isRecord(preview) && (preview.depositBlock === 'foreign_runtime'
        || preview.reason === 'unknown_deployment' || preview.reason === 'retired_deployment')) {
        return 'foreign_runtime';
    }
    return null;
}

// The kind of the slot ('draft_only', 'unsent_prepared', 'note', ...) from the
// freshest facts. A preview built without the probe's slot kind reports
// 'other' for an owned slot (chooseZkapiVersion cannot invent a kind), which
// would erase a draft the boot probe did classify and take the "cancel
// unfinished deposit" step away from someone still pinned by it. The same
// owner with no finer kind keeps the boot kind; a different owner or an empty
// slot is a real change and is taken as read.
function slotKindOf(facts, selection) {
    const kind = nonEmptyString(facts.slotKind);
    if (facts === selection) return kind;
    const unclassified = kind === null || kind === 'other';
    const sameOwner = nonEmptyString(facts.slotOwner) !== null && facts.slotOwner === selection.slotOwner;
    return unclassified && sameOwner ? nonEmptyString(selection.slotKind) : kind;
}

// ---------------------------------------------------------------------------
// Exit, payouts, set-aside records and giving up a balance
// ---------------------------------------------------------------------------
//
// These are additive facts, not phases. They come from the normalized
// snapshot (the SDK's own accounting) and from three facade-held inputs that
// can only make a fact stricter:
//
//   exitRefusal     the last refusal of an exit attempt (exitRefusal.mjs). It
//                   may turn on `nearExpiry`, `deviceNotNewest`, `frozen` or
//                   `wait`; it never turns anything off, except that a wait
//                   that has run out, or whose cause the snapshot no longer
//                   reports, is no longer shown. Where the snapshot reports an
//                   unresolved request, a settlement wait takes the later of
//                   the two times and the larger of the two bounds, so a
//                   refusal about an earlier request never states less.
//   serviceRefusal  a refusal that says the service is paused although the
//                   snapshot still reads as available
//   kitUnsaved      an exit kit was created in this page session and its file
//                   was not saved

const REFUSAL_KINDS = new Set(['settlement', 'proof', 'release', 'locked', 'device', 'near']);

// The refusal as the facade holds it (exitRefusal.readExitRefusal), reduced to
// what the state uses and re-checked: a value that does not look right is no
// refusal.
function readRefusal(value) {
    if (!isRecord(value) || !REFUSAL_KINDS.has(value.kind)) return null;
    return {
        kind: value.kind,
        untilMs: epochMs(value.untilMs),
        escapeAtMs: epochMs(value.escapeAtMs),
        mustInitiateByMs: epochMs(value.mustInitiateByMs),
        boundAtState: amountString(value.boundAtState)
    };
}

// The slot note's exit facts. `exit` is the normalized snapshot's summary
// (null when the SDK reports none), `refusal` a held refusal or null.
function deriveExit({ exit, refusal, kitUnsaved, now }) {
    if (exit === null) return null;
    // An instant that has not passed yet. Without a clock nothing is known to
    // have passed.
    const pending = value => value !== null && (now === null || value > now);
    const lock = isRecord(exit.lock) ? exit.lock : null;
    const kit = isRecord(exit.kit) ? exit.kit : null;

    let frozen = null;
    if (lock !== null || exit.lockHeld === true || (refusal && refusal.kind === 'locked' && (
        refusal.untilMs === null || pending(refusal.untilMs)))) {
        const reported = epochMs(lock?.releasableAfterMs);
        const refused = refusal && refusal.kind === 'locked' ? refusal.untilMs : null;
        const untilMs = pending(reported) ? reported : pending(refused) ? refused : null;
        frozen = { untilMs, mode: machineWord(lock?.mode) };
    }

    // A wait is the answer to a refused exit attempt. It is over at the
    // instant the SDK gave. A settlement wait is also over when the snapshot
    // says the state is fresh again: nothing is unresolved any more, and a
    // retry would not be refused for it.
    //
    // A held refusal can be older than the request that is unresolved now:
    // the chat it was about settled, then a new one started (a new state has
    // its own settlement time and its own bound). While the snapshot reports an
    // unresolved state its facts are the SDK's current ones, so a settlement
    // wait is never shorter than the standing one and never states a smaller
    // bound than the standing one. A disclosure that said less than the most
    // that can be given up would be the wrong way to be stale.
    let wait = null;
    if (refusal && (refusal.kind === 'settlement' || refusal.kind === 'proof' || refusal.kind === 'release')) {
        const settlement = refusal.kind === 'settlement';
        const standingAt = settlement && exit.stateFresh === false ? epochMs(exit.escapeAt) : null;
        const untilMs = settlement ? latest(refusal.untilMs, standingAt) : refusal.untilMs;
        const escapeAtMs = settlement ? latest(refusal.escapeAtMs, standingAt) : refusal.escapeAtMs;
        const over = untilMs !== null && !pending(untilMs);
        const settled = settlement && exit.stateFresh === true;
        if (!over && !settled) {
            wait = {
                kind: refusal.kind,
                untilMs,
                escapeAtMs,
                mustInitiateByMs: refusal.mustInitiateByMs,
                boundAtState: largerAmount(refusal.boundAtState, amountString(exit.boundAtState))
            };
        }
    }

    return {
        nearExpiry: exit.nearExpiry === true || refusal?.kind === 'near',
        mustInitiateByMs: epochMs(exit.mustInitiateBy),
        boundAtState: amountString(exit.boundAtState),
        stateFresh: typeof exit.stateFresh === 'boolean' ? exit.stateFresh : null,
        escapeAtMs: epochMs(exit.escapeAt),
        frozen,
        deviceNotNewest: exit.deviceNotNewest === true || refusal?.kind === 'device',
        wait,
        kit: {
            // The SDK counts a kit as created once it has a sequence number;
            // that says it was made, never that the file was saved.
            exported: kit !== null && Number.isSafeInteger(kit.exportedSeq) && kit.exportedSeq >= 0,
            // A missing answer is "out of date": a kit is only called current
            // when the SDK says so.
            outOfDate: kit !== null && typeof kit.outOfDate === 'boolean' ? kit.outOfDate : exit.kitOutOfDate !== false,
            depositPathSaved: typeof exit.depositPathSaved === 'boolean' ? exit.depositPathSaved : null,
            unsaved: kitUnsaved === true
        },
        rpc: { recommended: exit.rpcRecommended === true, wrongChain: exit.rpcWrongChain === true }
    };
}

// Set-aside records near their deadline and records this device may not exit.
// `device` counts a record once however many lists name it. The count reads
// the snapshot's own deadline entries, not the deduplicated list above: two
// records that share an expiry second are still two records.
function summarizeSetAside(snapshot) {
    const near = snapshot.setAsideNear.filter(isRecord);
    const dated = near.map(entry => epochMs(entry.mustInitiateByMs)).filter(value => value !== null);
    const flaggedIds = new Set();
    let anonymousRecords = 0;
    for (const id of snapshot.deviceNotNewestRecords) {
        if (nonEmptyString(id)) flaggedIds.add(id);
        else anonymousRecords += 1;
    }
    let anonymousDeadlines = 0;
    for (const entry of snapshot.deadlines) {
        if (!isRecord(entry) || entry.source !== 'set-aside' || entry.deviceFlagged !== true) continue;
        const id = nonEmptyString(entry.recordId);
        if (id) flaggedIds.add(id);
        else anonymousDeadlines += 1;
    }
    return {
        near: near.length,
        earliestMustInitiateByMs: dated.length ? Math.min(...dated) : null,
        device: flaggedIds.size + Math.max(anonymousRecords, anonymousDeadlines)
    };
}

// The facade's verdict on giving up a zero or dust balance, re-read against
// the facts this derivation holds. The verdict also changes what the person
// is told (the reminders for this slot note and the upgrade notice give way
// to it), so an `available` that this snapshot contradicts is refused here
// and the reminders stay: a balance that is mid-withdrawal, has a set-aside
// note beside it or is frozen is not something to offer to clear. The
// refusals use the vocabulary of abandonNote.mjs (ABANDON_BLOCKED_BY), plus
// `service_unreachable`: a balance this page holds but cannot read (the SDK did
// not start) has no note in the snapshot, which the verdict reports as
// `no_note`. That would say the balance is not there, so the first refusal
// that is only true because nothing could be read is named for its cause.
// Anything the facade did not compute is null, which shows nothing.
function reviewAbandon(value, facts) {
    if (!isRecord(value)) return null;
    const refuse = blockedBy => ({ available: false, kind: null, blockedBy });
    if (value.available !== true) {
        const why = machineWord(value.blockedBy);
        return refuse(facts.heldUnreachable && why === 'no_note' ? 'service_unreachable' : why);
    }
    if (!facts.relevant) return refuse('not_applicable');
    if (facts.configBlock) return refuse('config_mismatch');
    if (facts.reloadRequired) return refuse('reload_required');
    if (!facts.hasNote) return refuse(facts.heldUnreachable ? 'service_unreachable' : 'no_note');
    if (facts.claimed) return refuse('claimed');
    if (facts.openWithdrawal) return refuse('open_withdrawal');
    if (facts.pendingDeposit) return refuse('pending_deposit');
    if (facts.frozen) return refuse('exit_lock');
    if (facts.unresolvedRequests > 0) return refuse('unresolved_request');
    if (value.kind !== 'zero' && value.kind !== 'dust') return refuse('unknown_state');
    return { available: true, kind: value.kind, blockedBy: null };
}

// ---------------------------------------------------------------------------
// The state
// ---------------------------------------------------------------------------

/**
 * Derive the version state (see docs/ZKAPI_VERSIONING.md, "The runtime
 * facade").
 *
 * Phase precedence (a tab shows at most one):
 *   reload-required > balance-unreachable > legacy-unreachable > service-paused
 *   > admission-closed > finish-previous-withdrawal | claim-previous-credit
 *   > withdrawing > expired > upgrade-overdue > upgrade-soon > upgrade-available
 *   > current
 *
 * `balance-unreachable` sits right after the reload: it says the balance this
 * browser holds on THIS version cannot be read because the version's SDK did
 * not start (`held`), and every phase below it would speak from a snapshot
 * that has nothing in it (an empty balance, a paused service whose "you can
 * still withdraw" is false while the SDK is not running).
 *
 * @param {object} input
 * @param {object[]} input.table       ResolvedVersion[] (live, then retired)
 * @param {object} input.active        the loaded version
 * @param {object|null} input.target   the deposit target (the one `active` row)
 * @param {object} input.selection     the boot-time Selection
 * @param {object} input.snapshot      adapter.normalizeSnapshot() result
 * @param {object|null} input.intent   persisted upgrade intent, if any
 * @param {object|null} input.previewSelection  Selection of a fresh holdings read
 * @param {number} input.now           epoch milliseconds
 * @param {boolean} input.busy         wallet or settlement work is running
 * @param {boolean} input.admissionClosed  the gateway refused new leases (410)
 * @param {boolean} input.buildClosed  a newer build says deposits moved
 * @param {boolean} input.configBlock  the served config does not match the pins
 * @param {boolean} input.unreachable  the selected previous version failed to start
 * @param {boolean} [input.initFailed]  the loaded version's SDK tried to start
 *   and did not (its client is not initialized and reported an error; the
 *   caller keeps this true until the client reports it started, whatever the
 *   client holds meanwhile). With a slot the host itself read as holding a
 *   note of this deployment and a snapshot with no note, that is `held`
 *   (optional)
 * @param {object} input.adapter       the loaded version's adapter
 * @param {boolean} [input.claimed]    the note's expiry claim was confirmed
 *   (optional; the normalized snapshot has no field for it)
 * @param {boolean} [input.viewOpen]   the upgrade view is on screen (optional)
 * @param {string|null} [input.withdrawalPhase]  phase of the SDK's current
 *   withdrawal record (optional); refines `upgrade.stage`
 * @param {object|null} [input.exitRefusal]  the facade's held refusal of an
 *   exit attempt (exitRefusal.readExitRefusal). It can only tighten the exit
 *   facts; a wait that ran out is not shown
 * @param {{code: string}|null} [input.serviceRefusal]  a service refusal that
 *   an attempt raised although the snapshot reads as available (the facade
 *   latches it for a few minutes)
 * @param {{available: boolean, kind: string|null, blockedBy: string|null}|null} [input.abandon]
 *   the facade's verdict on giving up a zero or dust balance, computed from
 *   the same snapshot (abandonNote.abandonStatus); null when not computed
 * @param {boolean} [input.kitUnsaved]  an exit kit was created in this page
 *   session and its file was not saved
 * @returns {object} VersionState
 */
export function deriveVersionState(input) {
    const i = isRecord(input) ? input : {};
    const busy = i.busy === true;
    const active = i.active;
    if (!usableVersion(active) || !isRecord(i.selection)) return unavailableState(active, busy);

    const table = asArray(i.table).filter(isRecord);
    const selection = i.selection;
    const snapshot = readSnapshot(i.snapshot);
    const adapter = isRecord(i.adapter) ? i.adapter : null;
    const now = finiteNumber(i.now);
    const intent = isRecord(i.intent) ? i.intent : null;
    const preview = isRecord(i.previewSelection) && isRecord(i.previewSelection.version) ? i.previewSelection : null;
    // The freshest trustworthy view of the other versions' records.
    const facts = preview && preview.reason !== 'holdings_unreadable' ? preview : selection;

    // The deposit target. `active` is it whenever it is the `active` row, so a
    // caller that forgot to pass it does not close deposits on the live build.
    // A different `active` row than the loaded one is an inconsistent input
    // and closes deposits here (below).
    // An omitted target is read from the table (the one `active` row); an
    // explicit null is the caller saying there is none.
    const suppliedTarget = i.target === undefined
        ? table.find(version => usableVersion(version) && version.status === 'active') || null
        : i.target;
    const targetVersion = usableVersion(suppliedTarget) && suppliedTarget.status === 'active' ? suppliedTarget
        : active.status === 'active' ? active : null;
    const isTarget = targetVersion !== null && targetVersion.id === active.id;
    const successor = active.status !== 'active' && targetVersion && targetVersion.id !== active.id
        ? versionRef(targetVersion) : null;
    const liveCount = table.filter(version => version.status !== 'retired').length;
    const show = liveCount > 1;

    // -- Exit facts ---------------------------------------------------------
    // Before the deadlines: whether this device may still exit the slot note
    // decides whether it is nudged toward a withdrawal.
    const exitRefusal = readRefusal(i.exitRefusal);
    const exit = deriveExit({ exit: snapshot.exit, refusal: exitRefusal, kitUnsaved: i.kitUnsaved === true, now });
    const slotFlagged = exit !== null && exit.deviceNotNewest;

    // -- Deadlines ----------------------------------------------------------
    const loaded = loadedDeadlines(snapshot, slotFlagged);
    const setAside = loaded.filter(entry => entry.source === 'set-aside');
    // The notes a withdrawal nudge may be about. A note this device cannot
    // exit is still a deadline (it holds funds and expires) and still part of
    // `withdrawalInMotion` below, but it is never offered for withdrawal.
    const setAsideActionable = setAside.filter(entry => !entry.deviceFlagged);
    const slotDeadline = loaded.find(entry => entry.source === 'slot') || null;
    const unexpired = entry => now === null || entry.expirySeconds * 1000 > now;
    const slotExpired = snapshot.hasNote && slotDeadline !== null && now !== null
        && slotDeadline.expirySeconds * 1000 <= now;
    const everyDeadlineExpired = loaded.length > 0 && now !== null && !loaded.some(unexpired);

    // An upgrade only exists for a balance that sits on a version that no
    // longer takes deposits, with somewhere to move it.
    const upgradeRelevant = active.status === 'exit-only' && targetVersion !== null && !isTarget;
    const upgradeAvailable = upgradeRelevant && ((snapshot.hasNote && !slotFlagged) || setAsideActionable.length > 0);

    // Set-aside notes are live and swept at their expiry, but they are not a
    // withdrawal in motion. A loaded SDK that reports an open record while it
    // also lists set-aside deadlines is taken to be reporting those. The full
    // list decides "in motion": an open record that is only a note this
    // device cannot exit must not read as a withdrawal.
    const setAsideOnly = upgradeRelevant && !snapshot.hasNote && setAsideActionable.some(unexpired);
    const withdrawalInMotion = snapshot.hasPreparedWithdrawal
        || (snapshot.hasOpenWithdrawal && setAside.length === 0);

    // -- Other versions -----------------------------------------------------
    const others = collectOthers({ table, active, facts, snapshot, now });
    const blocksDeposits = others.some(entry => entry.open.length > 0);
    const named = others.filter(entry => entry.version !== null);
    const withOpen = named.filter(entry => entry.open.length > 0);
    const withCredits = named.filter(entry => entry.credits.length > 0);
    const byOrdinal = (a, b) => (finiteNumber(a.version.ordinal) ?? Infinity) - (finiteNumber(b.version.ordinal) ?? Infinity);
    const chosenOther = (withOpen.length ? withOpen : withCredits).sort(byOrdinal)[0] || null;

    const sweepable = new Set(Array.isArray(adapter?.sweepablePhases) ? adapter.sweepablePhases : DEFAULT_SWEEPABLE_PHASES);
    const previousCandidates = [];
    for (const entry of withOpen) {
        for (const record of entry.open) {
            if (!sweepable.has(record.phase)) continue;
            const expirySeconds = positiveNumber(record.expiryTs);
            if (expirySeconds === null) continue;
            previousCandidates.push({
                source: 'set-aside',
                expirySeconds,
                version: entry.version,
                owner: entry.id,
                closeByTs: closeByFor(adapter, expirySeconds, entry.version)
            });
        }
    }

    // -- Reload -------------------------------------------------------------
    const reload = deriveReload({ active, selection, preview, snapshot, intent, busy });

    // -- A balance this page cannot read --------------------------------------
    // The host's own read of the wallet database (the boot selection, or a
    // fresher readable preview of it) says the slot holds a note of THIS
    // deployment, and the SDK that should read it did not start: its snapshot
    // has no note, no deadline and no record, which reads as "nothing held"
    // everywhere below. The balance is there; the page just cannot see it.
    // A started SDK that reports no note is the opposite fact (the slot really
    // is empty, or the SDK disagrees with the host, which is for the SDK's own
    // reading to settle), so only a failed start counts.
    const slotHeldHere = facts.reason === 'runtime_holds_note' && facts.slotOwner === active.id
        && slotKindOf(facts, selection) === 'note';
    const heldUnreachable = i.initFailed === true && slotHeldHere && !snapshot.hasNote && loaded.length === 0;

    // -- Giving up a balance --------------------------------------------------
    // A zero or dust balance on a version that takes no deposits is offered
    // for clearing instead of a withdrawal that costs more than it returns.
    // While that is on offer this slot note, and only it, is not chased with
    // withdraw-by reminders. Every other deadline keeps its tier: the verdict
    // is refused above when any set-aside record or withdrawal exists, and a
    // previous version's records are a different holder's.
    const abandon = reviewAbandon(i.abandon, {
        relevant: upgradeRelevant,
        configBlock: i.configBlock === true,
        reloadRequired: reload.required,
        hasNote: snapshot.hasNote,
        claimed: i.claimed === true,
        openWithdrawal: snapshot.hasOpenWithdrawal || snapshot.hasPreparedWithdrawal || setAside.length > 0,
        pendingDeposit: snapshot.hasPendingDeposit || snapshot.hasUnsentPrepared,
        frozen: exit !== null && exit.frozen !== null,
        unresolvedRequests: snapshot.unresolvedRequests,
        heldUnreachable
    });
    const slotGivenUp = abandon !== null && abandon.available;

    // -- Close-by and tier --------------------------------------------------
    const upgradeCandidates = upgradeRelevant
        ? loaded
            .filter(entry => !entry.deviceFlagged && !(entry.source === 'slot' && slotGivenUp))
            .map(entry => ({
                ...entry,
                version: active,
                owner: active.id,
                closeByTs: closeByFor(adapter, entry.expirySeconds, active)
            }))
        : [];
    const actionable = [
        ...upgradeCandidates.filter(unexpired),
        ...previousCandidates.filter(unexpired)
    ];
    let chosen;
    let informational = false;
    if (actionable.length) {
        chosen = pickDeadline(actionable);
    } else {
        informational = true;
        const live = loaded.filter(unexpired);
        // With nothing left to live, report the slot note (the one the
        // existing expired notice is about), else the earliest.
        chosen = live.length
            ? pickDeadline(live.map(entry => ({ ...entry, closeByTs: null })))
            : (loaded.find(entry => entry.source === 'slot') || earliest(loaded, 'expirySeconds'));
    }
    const expiryTs = chosen ? chosen.expirySeconds * 1000 : null;
    const deadlineSource = chosen ? chosen.source : null;
    const closeByTs = !informational && chosen ? chosen.closeByTs : null;
    const policy = chosen && !informational ? transitionOf(chosen.version) : transitionOf(active);
    const reminderTier = closeByTs !== null ? reminderTierFor(closeByTs, expiryTs, now, policy.reminderDays) : null;

    // -- Gate ---------------------------------------------------------------
    // Version-level: this version takes deposits at all (status, and the SDK's
    // own flag for SDKs that report one). Either source saying closed wins.
    const depositsOpen = active.status === 'active' && !snapshot.sdkDepositsClosed
        && (targetVersion === null || targetVersion.id === active.id);
    const deposit = selectionBlock(selection, preview);
    let code = null;
    if (deposit) code = deposit;
    else if (i.configBlock === true) code = 'config_mismatch';
    else if (i.buildClosed === true) code = 'stale_build';
    else if (!depositsOpen) code = 'deposits_closed';
    else if (blocksDeposits) code = 'previous_withdrawal_open';
    // A balance this page holds and cannot read pins the wallet's one slot, and
    // the SDK that would start the deposit did not start: nothing may be
    // offered that would fail on it. Only reached when nothing above already
    // closed the gate, so it can only restrict (an exit-only version's gate is
    // closed for its own reason above and keeps it). Reload is its remedy.
    else if (heldUnreachable) code = 'holdings_unreadable';
    // A tab that is told to reload because the wallet now belongs to another
    // live version must not start a deposit under that notice: the SDK would
    // refuse it as a foreign wallet, and the form would sit there looking
    // usable. Only reached when nothing above already closed the gate, so it
    // can only restrict. A started deposit stays completable (`canResume`).
    else if (reload.required) code = 'reload_required';
    // Mirrors a STARTED pending deposit. A prepared plan that was never sent
    // is not resumable: it holds no funds and nothing can finish it.
    const gate = {
        canStart: code === null,
        canResume: snapshot.hasPendingDeposit && !snapshot.hasUnsentPrepared,
        code,
        successor
    };

    // -- Holding, unsent plan -----------------------------------------------
    const holdsFunds = snapshot.hasNote || loaded.length > 0
        || snapshot.hasOpenWithdrawal || snapshot.hasPreparedWithdrawal || heldUnreachable;
    const holding = !holdsFunds ? 'none' : successor ? 'previous' : 'current';

    // A deposit quote or prepared plan that was never sent, pinning a version
    // that no longer takes deposits, is what the user must clear before the
    // wallet can move on. On the live version it is just a deposit in
    // progress, so it only counts when this version cannot deposit. The
    // holdings facts name the slot's owner, so another version's draft does
    // not raise it here.
    const slotKind = slotKindOf(facts, selection);
    const unsent = !depositsOpen && (snapshot.hasUnsentPrepared
        || (facts.slotOwner === active.id
            && (slotKind === 'unsent_prepared' || slotKind === 'draft_only')));

    // -- Previous version ---------------------------------------------------
    // `canOpen`: the loader honors a preference only with an empty slot, so
    // while this tab's own balance or deposit holds it, the other version
    // cannot be opened until that is withdrawn.
    const slotEmpty = !SLOT_NOT_EMPTY_REASONS.has(facts.reason)
        && (facts.slotOwner === null || facts.slotOwner === undefined)
        && (facts.foreignDeploymentId === null || facts.foreignDeploymentId === undefined)
        && !snapshot.hasNote && !snapshot.hasPendingDeposit && !snapshot.hasUnsentPrepared;
    let previous = null;
    if (chosenOther) {
        previous = {
            versionId: chosenOther.id,
            openWithdrawals: chosenOther.open.length,
            credits: chosenOther.credits.length,
            canOpen: slotEmpty && !busy && chosenOther.id !== active.id,
            closeByTs: earliestCloseBy(previousCandidates.filter(entry => entry.owner === chosenOther.id && unexpired(entry)))
        };
    } else if (setAsideOnly) {
        // The holder is this very version: its balance is only a set-aside
        // note, so the action is Withdraw or Restore here, not "open" another.
        previous = {
            versionId: active.id,
            openWithdrawals: setAsideActionable.length,
            credits: 0,
            canOpen: false,
            closeByTs: earliestCloseBy(upgradeCandidates.filter(entry => entry.source === 'set-aside' && unexpired(entry)))
        };
    }

    // -- Service ------------------------------------------------------------
    // Paused when the snapshot says so, or when an attempt was refused for a
    // service reason the snapshot does not report (the vault check is only
    // known by trying). The refusal is newer than a snapshot that reads
    // available, so its code names the cause; the SDK's own message is kept
    // for callers but is never shown (copy.mjs speaks by code).
    const refusedService = isRecord(i.serviceRefusal) ? machineWord(i.serviceRefusal.code) : null;
    const servicePaused = (snapshot.service !== null && snapshot.service.available === false) || refusedService !== null;
    const service = servicePaused
        ? {
            message: typeof snapshot.service?.message === 'string' ? snapshot.service.message : '',
            code: refusedService ?? machineWord(snapshot.service?.code)
        }
        : null;

    // -- Phase --------------------------------------------------------------
    // A confirmed treasury claim (the existing "claimed" state) is something
    // only the client knows; it is an optional input. A claim implies expiry.
    const claimed = i.claimed === true;
    const promptWindowOpen = closeByTs !== null && now !== null && closeByTs - now <= policy.promptWindowMs;
    let phase = 'current';
    if (reload.required) phase = 'reload-required';
    else if (heldUnreachable) phase = 'balance-unreachable';
    else if (i.unreachable === true && selection.reason === 'requested_previous') phase = 'legacy-unreachable';
    else if (servicePaused) phase = 'service-paused';
    else if (i.admissionClosed === true) phase = 'admission-closed';
    else if ((chosenOther && chosenOther.open.length > 0) || setAsideOnly) phase = 'finish-previous-withdrawal';
    else if (chosenOther && chosenOther.credits.length > 0) phase = 'claim-previous-credit';
    else if (withdrawalInMotion) phase = 'withdrawing';
    else if (everyDeadlineExpired || claimed) phase = 'expired';
    else if (upgradeAvailable) {
        if (reminderTier === 0) phase = 'upgrade-overdue';
        else if (promptWindowOpen || reminderTier !== null) phase = 'upgrade-soon';
        else phase = 'upgrade-available';
    }

    // -- Upgrade ------------------------------------------------------------
    // What stops an upgrade from starting, most final first.
    // Reported for any holder of a closed version (a started deposit or an
    // unsent plan is worth explaining before there is a note to upgrade);
    // `in_flight` is only a hold for someone who could otherwise start.
    let blockedBy = null;
    if (upgradeRelevant) {
        // Before everything else: no other fact below can be known while the
        // balance cannot be read, and each of them would be a guess.
        if (heldUnreachable) blockedBy = 'service_unreachable';
        else if (claimed) blockedBy = 'claimed';
        else if (slotExpired || everyDeadlineExpired) blockedBy = 'expired';
        else if (unsent) blockedBy = 'unsent_deposit';
        else if (gate.canResume) blockedBy = 'pending_deposit';
        else if (withdrawalInMotion || setAsideOnly) blockedBy = 'open_withdrawal';
        else if (busy && upgradeAvailable) blockedBy = 'in_flight';
    }

    const partial = {
        show,
        current: {
            id: active.id,
            label: typeof active.label === 'string' ? active.label : active.id,
            protocolVersion: nonEmptyString(active.protocolVersion) || null,
            status: active.status
        },
        target: versionRef(targetVersion),
        holding,
        depositsOpen,
        gate,
        phase,
        closeByTs,
        expiryTs,
        deadlineSource,
        reminderTier,
        reload,
        previous,
        unsent,
        service,
        held: heldUnreachable ? { unreachable: true } : null
    };
    // The stage needs two things the normalized snapshot does not carry: whether
    // the upgrade view is open, and the phase of the SDK's current withdrawal
    // record. A caller that has them passes `viewOpen` and `withdrawalPhase`
    // (both optional) and gets the exact stage;
    // without them the stage is the view-independent one, where a prepared
    // withdrawal is `withdrawing` and an open record is not told apart.
    const withdrawalPhase = typeof i.withdrawalPhase === 'string' && i.withdrawalPhase ? i.withdrawalPhase
        : snapshot.hasPreparedWithdrawal ? 'prepared' : null;
    const stage = deriveUpgradeStage({
        versionState: partial,
        intent,
        viewOpen: i.viewOpen === true,
        withdrawalPhase
    });
    const upgrade = {
        available: upgradeAvailable,
        canStart: upgradeAvailable && blockedBy === null && !reload.required,
        blockedBy,
        stage
    };

    return {
        show: partial.show,
        current: partial.current,
        target: partial.target,
        holding: partial.holding,
        depositsOpen: partial.depositsOpen,
        gate: partial.gate,
        phase: partial.phase,
        closeByTs: partial.closeByTs,
        expiryTs: partial.expiryTs,
        deadlineSource: partial.deadlineSource,
        reminderTier: partial.reminderTier,
        upgrade,
        reload: partial.reload,
        previous: partial.previous,
        unsent: partial.unsent,
        service: partial.service,
        notices: collectNotices(others),
        exit,
        payouts: {
            credited: snapshot.ownCredits.filter(isRecord).length,
            alerts: snapshot.payoutAlerts.length
        },
        setAside: summarizeSetAside(snapshot),
        abandon,
        held: partial.held
    };
}
