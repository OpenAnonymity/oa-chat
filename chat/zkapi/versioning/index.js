// Runtime facade for zkAPI protocol versions (docs/ZKAPI_VERSIONING.md,
// "The runtime facade").
//
// One object, `zkapiVersioning`, is the host's only answer to "which protocol
// version is this tab on, may a deposit start, may a chat start, what should
// the person be told". Boot attaches it to the SDK client as
// `zkapiClient.oaVersioning`, so components that cannot gain imports (the four
// vm-evaluated sources) reach it through `zkapiClient.oaVersioning?.`.
//
// SDK-FREE. This module imports no SDK module, statically or dynamically; it
// is handed the client and runtime by boot.
//
// Dormant means identical. The facade is inert (gates open, no state, no UI)
// unless the build is "versioning active" (isVersioningActive below): more
// than one registry row, or a lone row that is not the deposit target. The
// gates are fail-CLOSED in exactly one situation: a versioned build in which no
// version was installed (boot failed or has not finished). There
// `depositGate()` says `version_unavailable`, and an exception while deciding
// closes it as well.
//
// Nothing here signs, broadcasts, deposits or reloads on its own; every
// switch is a user gesture routed through `requestSwitch`, and the only
// persisted state is the upgrade intent (version ids and a stage), written by
// the user's own upgrade steps.
//
// A version whose SDK did not start (its operator did not answer) cannot read
// the balance the wallet holds for it, and its snapshot says "no note". The
// facade passes that fact on (`initFailed`: the client is not initialized and
// reported an error while it was not) and the state derivation, which also has
// the host's own read of the database, turns the pair into `state.held`: a
// balance that is there and cannot be read, never an empty one. The failure is
// remembered until the client reports that it started, not read again from
// `lastError`: a client that never started can clear that error without
// starting (a refresh that is answered with a page and not with data).
//
// What the page learns by being refused (a chat key refused near expiry, a
// withdrawal that must wait for a settling chat, a paused service) is held
// here in memory, bounded in time and tied to the balance it was about, and
// handed to the state as an input that can only make a fact stricter. Nothing
// of it is stored: a reload asks the SDK again. The facade never pre-blocks an
// exit on its own reading; the SDK enforces its rules at the call.
import {
    getActiveAdapter, getActiveVersion, getSelection, getVersionTable
} from './activeVersion.mjs';
import { deriveVersionState } from './versionState.mjs';
import {
    clearUpgradeIntent, readUpgradeIntent, requestVersionSwitch, writeUpgradeIntent
} from './switchProtocol.mjs';
import { assertServedIdentity } from './configIntegrity.mjs';
import { intentProvesWithdrawal } from './upgradeFlow.mjs';
import { isOpenWithdrawalRecord } from './walletHoldings.mjs';
import { readExitRefusal, readServiceRefusal } from './exitRefusal.mjs';
import { abandonStatus, classifyBalance, nativeUsdMicros } from './abandonNote.mjs';

/** localStorage key of the last reminder tier the person was shown. */
export const REMINDER_KEY = 'oa-zkapi-upgrade-reminder-v1';

const DAY_MS = 86_400_000;
const MAX_TIMER_MS = 2 ** 31 - 1;
// Reasons whose switch needs somewhere specific to go.
const PREVIOUS_REASONS = new Set(['finish_previous', 'claim_credit']);

// How long a refusal that said a service was paused is believed without
// asking again. An attempt that succeeds says nothing back to the facade, so
// the latch is bounded in time and "Check again" clears it at once.
const SERVICE_LATCH_MS = 5 * 60_000;
// How long a refusal that names no end (a release with no usable time, a lock
// with no end, a settlement with an unusable instant) is shown, and how long
// one that has an end is still held after it (the snapshot may be catching
// up; see refusalStillApplies). Refusals that are facts about the balance
// itself are held until the balance changes, when the caller said they were
// about it. A refusal nobody tied to the slot note is held this long whatever
// it says.
const REFUSAL_HOLD_MS = 60_000;
// A read of the other versions' payment history is reused this long.
const HISTORY_FRESH_MS = 10_000;
// How long the facade waits for work it does not control before it answers
// without it: a history read, the SDK's service check, a give-up (its code
// is fetched on use). The work itself is not cancelled; a page must not stay
// "busy" or "loading" for good because a chunk or a request never answered.
const DEFAULT_LIMITS = Object.freeze({ historyMs: 15_000, serviceCheckMs: 20_000, abandonMs: 60_000 });
// Refusals that state a fact about the balance and not a wait: they stay until
// the slot holds another note. Every other kind ends at its own instant or
// after REFUSAL_HOLD_MS. Only a refusal the caller tied to the slot note
// stands (see refusalAttribution).
const STANDING_REFUSALS = new Set(['near', 'device']);

function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// A note number as the SDK reports it (a number, or its decimal string), else
// null. A record without one matches nothing.
function noteNumber(value) {
    const number = typeof value === 'string' && /^\d{1,15}$/.test(value) ? Number(value) : value;
    return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

// The id of the note in the runtime slot, read the way the adapters read it
// (adapters/noteBoundV1.mjs slotNote): the client snapshot's wallet status,
// else the runtime's own state. Null when no slot note is reported.
function slotNoteId(raw) {
    if (!isRecord(raw)) return null;
    const wallet = raw.wallet;
    if (isRecord(wallet) && wallet.has_note && isRecord(wallet.note)) return noteNumber(wallet.note.note_id);
    const state = isRecord(raw.runtime) ? raw.runtime.state : null;
    return isRecord(state) ? noteNumber(state.note_id) : null;
}

// An amount in the SDK's unit as a canonical decimal string, from a safe
// integer, a bigint or digits; null for anything else (never a guess).
//
// Strict on purpose. The result is the slot note's balance: it is shown to
// the person and compared with the balance a give-up was confirmed for
// (previewFor, giveUpBalance), so text that is not exactly what the SDK
// writes ('007', '+7', ' 7', '1e3') is "not known" here and is never read as
// another number. The display-side normalizers (versionState.mjs, copy.mjs,
// exitRefusal.mjs, adapters/concessionV1.mjs, components/RecordExtras.js)
// canonicalize leading zeros and take up to 30 digits instead, because they
// only print what they are given; components/ExitChoice.js is exact like this
// one but also takes 30. The give-up dialog (components/AbandonDialog.js)
// applies this same 20-digit rule. Every copy agrees on every value the SDK
// emits (safe integers and canonical decimal strings), and
// test/zkapi/zkapi-versioning-facade.test.mjs pins each copy's contract, so a
// change to one shows up as a failing test.
function amountText(value) {
    if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 ? String(value) : null;
    if (typeof value === 'bigint') return value >= 0n ? String(value) : null;
    if (typeof value === 'string' && /^(?:0|[1-9][0-9]{0,19})$/.test(value)) return value;
    return null;
}

// The slot note's id, balance (gwei, decimal string) and expiry (ms), as the
// client snapshot reports them, else the runtime's own state. Each is null
// when it is not reported.
function slotNoteFacts(raw) {
    const facts = { noteId: slotNoteId(raw), balanceUnits: null, expiryMs: null };
    if (!isRecord(raw)) return facts;
    const wallet = isRecord(raw.wallet) && raw.wallet.has_note && isRecord(raw.wallet.note) ? raw.wallet.note : null;
    const state = isRecord(raw.runtime) && isRecord(raw.runtime.state) ? raw.runtime.state : null;
    const source = wallet && wallet.current_balance !== undefined ? wallet : state;
    if (source) {
        facts.balanceUnits = amountText(source.current_balance);
        const expiry = Number(source.expiry_ts);
        if (Number.isSafeInteger(expiry) && expiry > 0) facts.expiryMs = expiry * 1000;
    }
    return facts;
}

// Which balance a refusal was about, as far as the caller said. An error
// carries no balance of its own: the same refusal comes back for the slot
// note and for a set-aside record that is finished or restored, and only the
// caller knows which attempt it made. `about` ({slot?, noteId?, recordId?}):
//   'slot'         the caller said the attempt acted on the balance in the
//                  wallet slot (`slot: true`), or named a note or record that
//                  is the slot note
//   'unspecified'  the caller named nothing. This may be a set-aside record's
//                  action, so what the refusal said is not about the slot note
//                  as far as the page knows (see noteRefusal)
//   null           the caller named a balance this cannot tie to the slot
//                  note (another note, another deployment's record, a record
//                  the snapshot does not list): never attached to it
function refusalAttribution(about, raw, slotId, version) {
    if (!isRecord(about)) return 'unspecified';
    if (about.noteId !== undefined && about.noteId !== null) {
        const named = noteNumber(about.noteId);
        return named !== null && named === slotId ? 'slot' : null;
    }
    if (typeof about.recordId === 'string' && about.recordId) {
        const records = isRecord(raw) && Array.isArray(raw.withdrawals) ? raw.withdrawals : [];
        const record = records.find(entry => isRecord(entry) && entry.recordId === about.recordId);
        if (!record) return null;
        if (typeof record.deploymentId === 'string' && record.deploymentId
            && record.deploymentId !== version.deploymentId) return null;
        return noteNumber(record.noteId) === slotId ? 'slot' : null;
    }
    return about.slot === true ? 'slot' : 'unspecified';
}

// `promise`'s outcome, or `fallback` once `ms` have passed. The timer never
// keeps a process alive and is cleared as soon as the race is decided.
function within(promise, ms, fallback) {
    let timer = null;
    const limit = new Promise(resolve => {
        timer = globalThis.setTimeout(() => resolve(fallback), ms);
        timer?.unref?.();
    });
    return Promise.race([promise, limit]).finally(() => globalThis.clearTimeout(timer));
}

function guarded(read) {
    try {
        return read();
    } catch {
        return undefined;
    }
}

function openGate() {
    return { canStart: true, canResume: false, code: null, successor: null };
}

function closedGate(code) {
    return { canStart: false, canResume: false, code, successor: null };
}

// The version table the build was compiled with. Absent in plain Node, in the
// dev server (zkAPI is never enabled there) and in ticket-only builds.
function readDefinedTable() {
    try {
        if (typeof __OA_ZKAPI_VERSIONS__ === 'undefined') return null;
        const table = __OA_ZKAPI_VERSIONS__;
        return Array.isArray(table) ? table : null;
    } catch {
        return null;
    }
}

function readDefinedNetwork() {
    try {
        return typeof __OA_ZKAPI_NETWORK__ === 'string' ? __OA_ZKAPI_NETWORK__ : '';
    } catch {
        return '';
    }
}

/**
 * "Versioning active": the build has something to tell apart or something
 * closed, so the probe, the deposit guard, the watcher and the gates run.
 *
 * Dormant (false) means exactly two things and nothing else: no registry rows
 * at all (sdk-default) or ONE row that is the deposit target (`active`), which
 * is today's single-version app and must stay byte-identical.
 *
 * Everything else is versioning-active, in particular:
 *   - more than one row (two live versions, or a live one and a tombstone)
 *   - a lone row that is not `active`. A registry may close the only live
 *     version while its successor is still `pending` ("deposits unavailable");
 *     the pinned legacy SDK ignores the profile's deposits flag, so the guard
 *     here is the only layer that stops a new deposit, and a build that
 *     treated this as "single version" would silently keep funding a vault the
 *     operator closed. Any status other than `active` fails toward closed.
 *
 * The one definition boot.js and the facade share, so they cannot drift.
 * Rows are the table's own (live ones first, retired tombstones after).
 *
 * @param {object[]|null|undefined} table the build's runtime version table
 * @returns {boolean}
 */
export function isVersioningActive(table) {
    if (!Array.isArray(table)) return false;
    const rows = table.filter(isRecord);
    if (rows.length === 0) return false;
    if (rows.length > 1) return true;
    return rows[0].status !== 'active';
}

function browserStorage(name) {
    try {
        return globalThis[name] || null;
    } catch {
        return null;
    }
}

/**
 * Create a facade. The exported `zkapiVersioning` is the one production
 * instance; tests build their own with injected clocks, storage and tables.
 *
 * @param {{buildTable?: object[]|null, network?: string, now?: () => number,
 *   context?: () => object|null, sessionStorage?: Storage, localStorage?: Storage,
 *   reload?: () => void, setTimer?: Function, clearTimer?: Function,
 *   limits?: {historyMs?: number, serviceCheckMs?: number, abandonMs?: number}}} [options]
 */
export function createZkapiVersioning(options = {}) {
    const limits = { ...DEFAULT_LIMITS };
    for (const key of Object.keys(DEFAULT_LIMITS)) {
        const given = isRecord(options.limits) ? options.limits[key] : undefined;
        if (Number.isFinite(given) && given > 0) limits[key] = given;
    }
    const env = {
        now: typeof options.now === 'function' ? options.now : Date.now,
        setTimer: options.setTimer || ((...args) => globalThis.setTimeout(...args)),
        clearTimer: options.clearTimer || (timer => globalThis.clearTimeout(timer)),
        sessionStorage: options.sessionStorage || null,
        localStorage: options.localStorage || null,
        reload: typeof options.reload === 'function' ? options.reload : null
    };
    let attached = null;
    let detachClient = null;
    // Facts that only ever move toward "more restricted" (or that a reload
    // clears). None is persisted.
    const flags = {
        preview: null,
        staleBuild: false,
        admissionClosed: false,
        draftDiscarded: false,
        discardLoop: false,
        integrity: 'unverified',
        identity: null
    };
    const listeners = new Set();
    const triggers = new Set();
    const busyProviders = new Set();
    let lastSignature = null;
    let lastFingerprint = null;
    let lastOpenRecords = new Set();
    let viewOpen = false;
    // The intent of an upgrade that just completed: the stored one is cleared
    // at once (it must not survive a reload), while this page keeps showing
    // "Upgrade complete" until it is left.
    let completedIntent = null;
    let boundaryTimer = null;
    // What this page has seen of the upgrade's own withdrawal. In memory only,
    // never persisted (a note number does not belong in storage), and cleared
    // with the page.
    //   upgradeNoteId       the slot note the upgrade view was opened on
    //   closedUnproven      withdrawal records seen closing WITHOUT payout
    //                       evidence (a later update may add it)
    //   withdrawalObserved  a payout-verified closure of the upgrade's note
    //                       was observed, whether or not it could be stored
    //   abandoned           the person dismissed the upgrade; the page stops
    //                       reading the stored intent even if it cannot be
    //                       removed
    let upgradeNoteId = null;
    let closedUnproven = new Set();
    let withdrawalObserved = false;
    let abandoned = false;
    // The newest reminder tier acknowledged on this page, per version, for
    // storage that refuses writes (see acknowledgeReminder).
    const reminderMemo = new Map();
    // What this page has been refused for, in memory only (see the header).
    //   heldRefusals   by refusal kind: {refusal, noteId, at, sawStale,
    //                  attributed}. The refusal is exitRefusal.readExitRefusal's
    //                  object, `noteId` the slot note it was noted against, `at`
    //                  when it was noted, `sawStale` whether the snapshot was
    //                  seen reporting an unresolved request since (a settlement
    //                  wait is dropped the first time the snapshot says the
    //                  request settled) and `attributed` whether the caller
    //                  said it was about the slot note (an unattributed one is
    //                  held REFUSAL_HOLD_MS and no longer)
    //   serviceLatch   {code, at}: a service refusal the snapshot may not
    //                  report (the vault check is only known by trying)
    //   kitUnsaved     {noteId}: an exit kit was created for that note in this
    //                  page and its file was not saved
    //   refusalsSeen   error objects already read, so the three producers
    //                  (chat key request, the dialog's catch paths, the
    //                  welcome panel) cannot count one error twice
    const heldRefusals = new Map();
    let serviceLatch = null;
    let kitUnsaved = null;
    let refusalsSeen = new WeakSet();
    // The errors the SDK client reported while it had not started (the one
    // that stopped its start and every later one it replaced it with). A
    // refresh on a client that never started fails again and replaces
    // `lastError`, so what the page was shown last is not always the error
    // that stopped it. Only objects, in memory, forgotten with the client.
    let startErrors = new WeakSet();
    // Whether the client reported an error while it had not started, and has
    // not started since. The legacy client never recovers from a failed start
    // in place (its start is attempted once), and a refresh that is answered
    // with something that is not data (a host that serves its own page for any
    // path) clears `lastError` and leaves it not started, so the error itself
    // is not the memory. Cleared when the client reports it started and when
    // the facade is attached again.
    let startLatched = false;
    // In-flight work of the facade itself. `epoch` moves whenever the facade is
    // attached again or reset, so a promise that settles after that is ignored.
    let epoch = 0;
    let recheckInFlight = null;
    let abandonInFlight = false;
    // The other versions' payment history (see history below).
    const historyState = {
        rows: Object.freeze([]), settled: 'idle', loading: null, readAt: 0, stale: true, revision: 0, fingerprint: ''
    };

    const clock = () => {
        const value = env.now();
        return Number.isFinite(value) ? value : Date.now();
    };
    const network = () => (typeof options.network === 'string' ? options.network : readDefinedNetwork());
    const session = () => env.sessionStorage || browserStorage('sessionStorage');
    const local = () => env.localStorage || browserStorage('localStorage');
    const builtTable = () => (options.buildTable !== undefined ? options.buildTable : readDefinedTable());

    // -- Version context ------------------------------------------------------

    // The installed version, its table, selection and adapter, or null. An
    // adapter this build does not contain is "not installed": the build is
    // wrong, so nothing is allowed.
    function installedContext() {
        if (typeof options.context === 'function') return options.context() || null;
        const version = getActiveVersion();
        if (!version) return null;
        let adapter;
        try {
            adapter = getActiveAdapter();
        } catch {
            return null;
        }
        return { table: getVersionTable(), version, selection: getSelection(), adapter };
    }

    // { ctx, multi, unavailable }. Never throws.
    function mode() {
        try {
            const ctx = installedContext();
            if (ctx) return { ctx, multi: isVersioningActive(ctx.table), unavailable: false };
            const built = builtTable();
            const versioned = isVersioningActive(built);
            return { ctx: null, multi: versioned, unavailable: versioned };
        } catch {
            // Cannot even tell: a build that has the table decides, otherwise
            // this is the dormant single-version page.
            let versioned = false;
            try {
                const built = builtTable();
                versioned = isVersioningActive(built);
            } catch { /* dormant */ }
            return { ctx: null, multi: versioned, unavailable: versioned };
        }
    }

    // -- SDK facts ------------------------------------------------------------

    // `given` is the snapshot the SDK just handed to a change listener; using it
    // avoids copying the withdrawal and deposit lists a second time per event.
    function rawSnapshot(given = null) {
        const client = attached?.client;
        if (!client || typeof client.snapshot !== 'function') return null;
        try {
            const snapshot = isRecord(given) ? given : client.snapshot();
            if (!isRecord(snapshot)) return null;
            const slot = attached.runtime?.runtime;
            // The in-memory slot tightens the adapter's reading of a pending
            // deposit toward "started". It is only ever reduced to booleans
            // and dates by the adapter.
            return isRecord(slot) ? { ...snapshot, runtime: slot } : snapshot;
        } catch {
            return null;
        }
    }

    function normalizedSnapshot(ctx, raw, now) {
        try {
            if (ctx.adapter && typeof ctx.adapter.normalizeSnapshot === 'function') {
                return ctx.adapter.normalizeSnapshot(raw || {}, { nowMs: now });
            }
        } catch { /* an unreadable snapshot reads as nothing to report */ }
        return {};
    }

    // The adapter's narrowing of its reading to the facts that can change what
    // a fresh load would pick (adapter.watchFacts). A reading carries facts
    // that move with every settled chat or while one is in flight; they decide
    // nothing about which build loads, so fingerprinting them would read the
    // shared wallet database after every chat. An adapter with no narrowing,
    // or one that cannot narrow this reading, is fingerprinted whole: waking
    // the watcher once too often is the safe error.
    function watchFacts(adapter, reading) {
        try {
            if (adapter && typeof adapter.watchFacts === 'function') return adapter.watchFacts(reading);
        } catch { /* fingerprinted whole */ }
        return reading;
    }

    function isBusy(raw) {
        // Our own write to the wallet is work in flight even though no SDK
        // activity says so.
        if (abandonInFlight) return true;
        for (const provider of busyProviders) {
            try {
                if (provider() === true) return true;
            } catch {
                // A provider that cannot answer is assumed to be working.
                return true;
            }
        }
        const activities = isRecord(raw) && Array.isArray(raw.activities) ? raw.activities : [];
        return activities.some(activity => isRecord(activity) && activity.status === 'running');
    }

    function currentWithdrawalPhase(raw) {
        if (!isRecord(raw)) return null;
        const records = Array.isArray(raw.withdrawals) ? raw.withdrawals.filter(isRecord) : [];
        const open = records.filter(record => isOpenWithdrawalRecord(record))
            .sort((left, right) => Number(right.updatedAt || 0) - Number(left.updatedAt || 0));
        if (open.length && typeof open[0].phase === 'string') return open[0].phase;
        if (isRecord(raw.withdrawal) && typeof raw.withdrawal.phase === 'string') return raw.withdrawal.phase;
        return null;
    }

    // After the SDK's first successful init, the deployment it reached must be
    // the loaded version's own. Evaluated once; a mismatch is a latch.
    function identityBlocks(ctx) {
        if (flags.identity === null && attached?.client?.initialized === true) {
            flags.identity = assertServedIdentity({
                client: attached.client, runtime: attached.runtime, version: ctx.version
            });
        }
        return flags.identity === 'mismatch';
    }

    // The loaded version's SDK tried to start and did not: its client is not
    // initialized and has reported the error that stopped it. A client that
    // has not finished starting yet has reported none, so a slow start is not
    // a failure. The failure is latched (see startLatched): it holds until the
    // client says it started, whatever `lastError` is by then. Every error
    // the client holds meanwhile is remembered (startErrors) for the words
    // that must not show it. Never throws.
    function startFailed() {
        const client = attached?.client;
        if (!client) return false;
        if (guarded(() => client.initialized) === true) {
            startLatched = false;
            return false;
        }
        const error = guarded(() => client.lastError);
        if (error) {
            if (typeof error === 'object') startErrors.add(error);
            startLatched = true;
        }
        return startLatched;
    }

    function unreachable(ctx) {
        return ctx.selection?.reason === 'requested_previous' && startFailed();
    }

    // -- Upgrade intent -------------------------------------------------------

    function storedIntent(now) {
        if (abandoned) return null;
        const net = network();
        if (!net) return null;
        return readUpgradeIntent({ network: net, storage: local() || undefined, now });
    }

    function currentIntent(now) {
        return completedIntent || storedIntent(now);
    }

    // The stored intent already says this page's version's upgrade withdrawal
    // ended (`withdrawn` or `depositing`).
    function storedIntentProves(m, now) {
        const intent = storedIntent(now);
        return Boolean(intent) && intent.from === m.ctx.version.id && intentProvesWithdrawal(intent);
    }

    function saveIntent(intent) {
        return writeUpgradeIntent(intent, { storage: local() || undefined });
    }

    // -- Held refusals ---------------------------------------------------------

    // Whether a held refusal still applies at `now`. `known` is false when the
    // snapshot could not be read at all: then nothing is learned about the
    // slot note, and only time ends a refusal.
    //
    // The state decides what is SHOWN (a wait is over at its instant, and a
    // request that settled is no wait); this decides what is still HELD, so
    // that a refusal cannot come back for something it was not about:
    //   - the slot holds another note (or none): the refusal was about a
    //     balance that is no longer there
    //   - its end passed a minute ago. The grace is for a snapshot that is
    //     still catching up: while the SDK reports a newer unresolved request
    //     the settlement wait lasts until that request's own time
    //   - it names no end and was noted a minute ago (the facts about the
    //     balance itself, near expiry and a device that is not the newest, are
    //     held until the note changes)
    //   - a settlement wait is dropped on the FIRST report of "settled" after
    //     one of "unresolved": a snapshot that still read settled when the
    //     refusal arrived is only stale, and the state ignores the wait
    //     meanwhile. A later request has its own time and bound, the snapshot's
    //   - nobody said which balance it was about and a minute passed. The
    //     attempt may have been a set-aside record's, so what it said (too
    //     close to its expiry, used on another device, frozen) may not be true
    //     of the slot note, and an error cannot say. A minute covers the
    //     SDK's own snapshot catching up with the fact; past that the
    //     snapshot is the only source, so a wrong claim about the live balance
    //     cannot outlast it (and cannot hide its withdraw and reminder
    //     notices for the rest of the page's life)
    function refusalStillApplies(kind, entry, { known, noteId, exit, now }) {
        if (known && noteId !== entry.noteId) return false;
        if (!entry.attributed && now - entry.at >= REFUSAL_HOLD_MS) return false;
        let end = entry.refusal.untilMs;
        if (kind === 'settlement' && exit) {
            if (exit.stateFresh === false) {
                entry.sawStale = true;
                if (Number.isFinite(exit.escapeAt)) end = end === null ? exit.escapeAt : Math.max(end, exit.escapeAt);
            } else if (exit.stateFresh === true && entry.sawStale) {
                return false;
            }
        }
        if (end !== null) return now <= end + REFUSAL_HOLD_MS;
        return STANDING_REFUSALS.has(kind) || now - entry.at < REFUSAL_HOLD_MS;
    }

    // A refusal about the balance itself (it is too close to its expiry, another
    // device used it) is a fact that only tightens what the SDK's snapshot
    // says, whichever other refusals are held, so it is applied to the reading
    // the state is derived from. The waits and the frozen balance describe the
    // latest attempt, so the state is given the newest of them.
    function chosenRefusal() {
        let newest = null;
        for (const [kind, entry] of heldRefusals) {
            if (STANDING_REFUSALS.has(kind)) continue;
            if (newest === null || entry.at > newest.at) newest = entry;
        }
        return newest ? newest.refusal : null;
    }

    // `snapshot` with the held facts about the balance applied. A snapshot
    // with no exit summary (no slot note) has nothing to tighten.
    function tightened(snapshot) {
        const near = heldRefusals.has('near');
        const device = heldRefusals.has('device');
        if ((!near && !device) || !isRecord(snapshot.exit)) return snapshot;
        return {
            ...snapshot,
            exit: {
                ...snapshot.exit,
                ...(near ? { nearExpiry: true } : {}),
                ...(device ? { deviceNotNewest: true } : {})
            }
        };
    }

    // What the held facts contribute to a state computed at `now`, after
    // dropping every one that no longer applies.
    function heldFacts(snapshot, raw, now) {
        const known = isRecord(raw);
        const noteId = known ? slotNoteId(raw) : null;
        const exit = isRecord(snapshot.exit) ? snapshot.exit : null;
        for (const [kind, entry] of [...heldRefusals]) {
            if (!refusalStillApplies(kind, entry, { known, noteId, exit, now })) heldRefusals.delete(kind);
        }
        if (serviceLatch && now - serviceLatch.at >= SERVICE_LATCH_MS) serviceLatch = null;
        if (kitUnsaved && known && kitUnsaved.noteId !== noteId) kitUnsaved = null;
        return {
            snapshot: tightened(snapshot),
            exitRefusal: chosenRefusal(),
            serviceRefusal: serviceLatch ? { code: serviceLatch.code } : null,
            kitUnsaved: kitUnsaved !== null
        };
    }

    // The instants at which a held fact ends by itself (so the page says so
    // without waiting for another event).
    function heldInstants() {
        const instants = [];
        for (const [kind, entry] of heldRefusals) {
            // An unattributed refusal is dropped after the hold, whatever it
            // says. An attributed one with an end is shown until it (the
            // state's own boundary); one with none is dropped after the hold
            // unless it states a standing fact.
            if (!entry.attributed || (entry.refusal.untilMs === null && !STANDING_REFUSALS.has(kind))) {
                instants.push(entry.at + REFUSAL_HOLD_MS);
            }
        }
        if (serviceLatch) instants.push(serviceLatch.at + SERVICE_LATCH_MS);
        return instants;
    }

    // -- Giving up a balance ---------------------------------------------------

    // The deployment's charge cap for one chat key (gwei), or undefined.
    function chargeCapUnits() {
        return guarded(() => attached?.client?.config?.request_charge_cap)
            ?? guarded(() => attached?.runtime?.config?.request_charge_cap);
    }

    // Every fact the display verdict (abandonNote.abandonStatus) needs, read
    // once from the page's own views. `supported` also requires that boot gave
    // the facade the means to act: an action that could not run is not offered.
    function abandonFacts(m, snapshot, raw, { claimed, configBlock }) {
        const { version, adapter, table } = m.ctx;
        const data = isRecord(adapter) && isRecord(adapter.abandon) ? adapter.abandon : null;
        const transition = isRecord(version.transition) ? version.transition : {};
        const target = table.find(row => isRecord(row) && row.status === 'active') || null;
        const client = attached?.client;
        const note = slotNoteFacts(raw);
        const slot = isRecord(raw) && isRecord(raw.runtime) ? raw.runtime : null;
        const config = isRecord(raw) && isRecord(raw.config) ? raw.config : null;
        // A chat key that is not settled: the slot's journal or lease, this
        // tab's own key, or the SDK's report of one.
        const inFlight = Boolean(slot && (slot.journal || slot.lease))
            || Boolean(guarded(() => attached?.runtime?.activeLease))
            || Boolean(config && config.active_lease)
            || (isRecord(raw?.wallet) && raw.wallet.pending_request === true);
        const deadlines = Array.isArray(snapshot.deadlines) ? snapshot.deadlines : [];
        return {
            noteId: note.noteId,
            expiryMs: note.expiryMs,
            status: version.status,
            supported: data !== null && data.supported === true && typeof attached?.abandonNote === 'function',
            // The registry's default (on) is applied here, never by the
            // service: an omitted switch refuses there.
            enabled: transition.abandonEnabled !== false,
            hasTarget: target !== null && target.id !== version.id,
            hasNote: snapshot.hasNote === true,
            configMismatch: configBlock === true,
            balanceUnits: note.balanceUnits,
            chargeCapUnits: chargeCapUnits(),
            quote: guarded(() => client?.nativePriceQuote) ?? null,
            thresholdUsdMicros: transition.dustThresholdUsdMicros,
            smallestTierUsdMicros: data ? data.smallestChatTierUsdMicros : undefined,
            ceilingUnits: data ? data.dustCeilingUnits : undefined,
            inFlight,
            claimed: claimed === true,
            hasOpenWithdrawal: snapshot.hasOpenWithdrawal === true,
            hasPreparedWithdrawal: snapshot.hasPreparedWithdrawal === true,
            hasPendingDeposit: snapshot.hasPendingDeposit === true,
            hasUnsentPrepared: snapshot.hasUnsentPrepared === true,
            lockHeld: isRecord(snapshot.exit) && snapshot.exit.lockHeld === true,
            setAsideCount: deadlines.filter(entry => isRecord(entry) && entry.source === 'set-aside').length,
            unresolvedRequests: Number.isSafeInteger(snapshot.unresolvedRequests) ? snapshot.unresolvedRequests : 0
        };
    }

    // -- State ----------------------------------------------------------------

    function computeState(m, now, raw = rawSnapshot()) {
        const { ctx } = m;
        const snapshot = normalizedSnapshot(ctx, raw, now);
        const target = ctx.table.find(row => isRecord(row) && row.status === 'active') || null;
        const client = attached?.client;
        let claimed = false;
        try {
            claimed = Boolean(client?.noteExpiryClaim);
        } catch { /* absent or unreadable: not claimed */ }
        const configBlock = flags.integrity === 'mismatch' || identityBlocks(ctx);
        const held = heldFacts(snapshot, raw, now);
        // Presentation: a verdict that cannot be computed is "nothing to
        // offer" and must never decide whether a deposit may start.
        let abandon = null;
        try {
            abandon = abandonStatus(abandonFacts(m, snapshot, raw, { claimed, configBlock }));
        } catch { /* no verdict */ }
        return deriveVersionState({
            table: ctx.table,
            active: ctx.version,
            target,
            selection: ctx.selection,
            snapshot: held.snapshot,
            intent: currentIntent(now),
            previewSelection: flags.preview,
            now,
            busy: isBusy(raw),
            admissionClosed: flags.admissionClosed,
            buildClosed: flags.staleBuild,
            configBlock,
            unreachable: unreachable(ctx),
            initFailed: startFailed(),
            adapter: ctx.adapter,
            claimed,
            viewOpen,
            withdrawalPhase: currentWithdrawalPhase(raw),
            exitRefusal: held.exitRefusal,
            serviceRefusal: held.serviceRefusal,
            // Computed from the same facts and re-checked by the derivation
            // against the rest of the snapshot, so a contradiction demotes it.
            abandon,
            kitUnsaved: held.kitUnsaved
        });
    }

    function stateNow(now = clock()) {
        const m = mode();
        if (!m.multi || !m.ctx) return null;
        return computeState(m, now);
    }

    // -- Change handling ------------------------------------------------------

    // Whether a withdrawal record that just closed is evidence that the
    // upgrade's own balance was paid out to the person. Both are required:
    //   - payout evidence on the record (`payoutVerified === true`). A record
    //     can close without it by design (a canonical closure, or a note the
    //     treasury claimed at expiry), and "Your balance is back in your
    //     wallet" must not be said about that;
    //   - the record is the note the upgrade started from: the slot note id
    //     captured when the upgrade view armed the intent (and the loaded
    //     deployment). Without a captured id only a wallet that now holds
    //     nothing at all can be attributed to the upgrade. A parked or
    //     set-aside note closed from Payment history while the slot note is
    //     still held never matches.
    function provesUpgradeWithdrawal(record, snapshot, version) {
        if (record.payoutVerified !== true) return false;
        if (typeof record.deploymentId === 'string' && record.deploymentId
            && typeof version.deploymentId === 'string' && record.deploymentId !== version.deploymentId) {
            return false;
        }
        if (upgradeNoteId !== null) return noteNumber(record.noteId) === upgradeNoteId;
        return snapshot.hasNote !== true && snapshot.hasOpenWithdrawal !== true
            && snapshot.hasPreparedWithdrawal !== true
            && (!Array.isArray(snapshot.deadlines) || snapshot.deadlines.length === 0);
    }

    // Facts a change event can add to the upgrade intent. Everything keys off
    // what THIS tab observed the SDK do, never off merely empty holdings: an
    // expired and archived balance also leaves nothing behind. A record that
    // was open and is now closed counts as the upgrade's withdrawal only with
    // payout evidence for the upgrade's own note (provesUpgradeWithdrawal); one
    // that closes without it stays unproven, and is looked at again on later
    // events in case the SDK adds the evidence to the same record.
    function advanceIntent(m, raw, now) {
        const records = isRecord(raw) && Array.isArray(raw.withdrawals) ? raw.withdrawals : [];
        const version = m.ctx.version;
        const openNow = new Set();
        const closing = [];
        for (const record of records) {
            if (!isRecord(record) || typeof record.recordId !== 'string' || !record.recordId) continue;
            if (isOpenWithdrawalRecord(record)) openNow.add(record.recordId);
            else if (record.phase === 'closed'
                && (lastOpenRecords.has(record.recordId) || closedUnproven.has(record.recordId))) {
                closing.push(record);
            }
        }
        lastOpenRecords = openNow;

        // The adapter's reading, taken only when something needs it.
        let reading = null;
        const snapshotNow = () => {
            if (reading === null) reading = normalizedSnapshot(m.ctx, raw, now);
            return reading;
        };
        const stillUnproven = new Set();
        let proven = false;
        for (const record of closing) {
            if (provesUpgradeWithdrawal(record, snapshotNow(), version)) proven = true;
            else stillUnproven.add(record.recordId);
        }
        closedUnproven = stillUnproven;

        // Only an upgrade this browser started (from this version) has
        // anything to advance; a dismissed or never-started one is left alone.
        const intent = storedIntent(now);
        if (!intent) return;
        if (proven && intent.from === version.id) withdrawalObserved = true;
        if (proven && intent.stage === 'withdrawing' && intent.from === version.id) {
            saveIntent({ ...intent, stage: 'withdrawn', since: now });
            return;
        }
        if (intent.stage === 'withdrawn' && intent.to === version.id) {
            if (snapshotNow().hasPendingDeposit === true) saveIntent({ ...intent, stage: 'depositing', since: now });
        }
    }

    function signatureOf(state) {
        try {
            return JSON.stringify(state);
        } catch {
            return null;
        }
    }

    // The session facts the notice surfaces need and VersionState does not
    // carry (additive; booleans only). `withdrawalConfirmed` is the persisted
    // upgrade intent saying the upgrade's own withdrawal ended with payout
    // evidence (the intent only reaches `withdrawn` through
    // provesUpgradeWithdrawal), so "Withdrawal confirmed" is a fact.
    function sessionFlags(m, now) {
        const ctx = m?.ctx || null;
        const intent = ctx ? currentIntent(now) : null;
        return {
            draftDiscarded: flags.draftDiscarded || ctx?.selection?.draftDiscarded === true,
            discardLoop: flags.discardLoop,
            admissionClosed: flags.admissionClosed,
            staleBuild: flags.staleBuild,
            configMismatch: flags.integrity === 'mismatch' || flags.identity === 'mismatch',
            withdrawalConfirmed: Boolean(intent) && intent.from === ctx.version.id && intentProvesWithdrawal(intent)
        };
    }

    // What subscribers compare: the state and the session flags (the watcher
    // raises a discarded draft or a discard loop without the state moving),
    // the other versions' payment history (a re-read that changed a row, a
    // deadline crossed) and whether an exit kit is waiting to be saved, plus
    // whether the UI helpers have arrived (attachUi is a change they must
    // hear about, although neither moved). Never the exact balance and never
    // a ticking time: a chat must not wake every subscriber.
    function stateSignature(state, m, now) {
        const signature = signatureOf({
            state,
            flags: sessionFlags(m, now),
            history: history.signature(now),
            kit: kitUnsaved !== null
        });
        return signature === null ? null : `${attached?.ui ? 'ui' : 'no-ui'}|${signature}`;
    }

    function armBoundaryTimer(m, state, now) {
        if (boundaryTimer !== null) {
            env.clearTimer(boundaryTimer);
            boundaryTimer = null;
        }
        if (!state || listeners.size === 0) return;
        const instants = [];
        const policies = [m.ctx.version, ...m.ctx.table.filter(row => isRecord(row) && row.status === 'exit-only')]
            .map(row => row?.transition).filter(isRecord);
        if (Number.isFinite(state.closeByTs)) {
            instants.push(state.closeByTs);
            for (const policy of policies) {
                for (const days of Array.isArray(policy.reminderDays) ? policy.reminderDays : []) {
                    if (Number.isFinite(days)) instants.push(state.closeByTs - days * DAY_MS);
                }
                if (Number.isFinite(policy.promptWindowDays)) {
                    instants.push(state.closeByTs - policy.promptWindowDays * DAY_MS);
                }
            }
        }
        if (Number.isFinite(state.expiryTs)) instants.push(state.expiryTs);
        // A wait or a frozen balance ends at an instant the SDK gave, and a
        // held refusal ends by itself; the page says so then, not at the next
        // unrelated event.
        const exit = isRecord(state.exit) ? state.exit : null;
        if (exit) {
            if (isRecord(exit.wait) && Number.isFinite(exit.wait.untilMs)) instants.push(exit.wait.untilMs);
            if (isRecord(exit.frozen) && Number.isFinite(exit.frozen.untilMs)) instants.push(exit.frozen.untilMs);
        }
        instants.push(...heldInstants());
        const upcoming = instants.filter(instant => Number.isFinite(instant) && instant > now);
        if (!upcoming.length) return;
        // A little after the boundary, so the state computed there is past it.
        const delay = Math.min(Math.max(Math.min(...upcoming) - now + 50, 50), MAX_TIMER_MS);
        boundaryTimer = env.setTimer(() => {
            boundaryTimer = null;
            publish();
        }, delay);
        boundaryTimer?.unref?.();
    }

    // Recompute, retire a finished upgrade intent, tell subscribers if the
    // state they would see actually changed, and re-arm the boundary timer.
    function publish(raw) {
        try {
            const m = mode();
            if (!m.multi || !m.ctx) return;
            const now = clock();
            let state = computeState(m, now, raw);
            if (state.upgrade.stage === 'done' && !completedIntent) {
                const intent = storedIntent(now);
                if (intent) {
                    completedIntent = intent;
                    clearUpgradeIntent({ storage: local() || undefined });
                    state = computeState(m, now, raw);
                }
            }
            armBoundaryTimer(m, state, now);
            const signature = stateSignature(state, m, now);
            if (signature === null || signature === lastSignature) return;
            lastSignature = signature;
            for (const listener of [...listeners]) {
                try {
                    listener(state);
                } catch { /* a subscriber's bug is not the wallet's */ }
            }
        } catch { /* presentation only */ }
    }

    // Make the current state the baseline for change detection and start the
    // boundary timer, without notifying anyone.
    function primeBaseline() {
        try {
            const m = mode();
            if (!m.multi || !m.ctx) return;
            const now = clock();
            const state = computeState(m, now);
            if (lastSignature === null) lastSignature = stateSignature(state, m, now);
            armBoundaryTimer(m, state, now);
        } catch { /* presentation only */ }
    }

    function fireTriggers() {
        for (const trigger of [...triggers]) {
            try {
                trigger();
            } catch { /* the watcher's bug is not the wallet's */ }
        }
    }

    function onClientChange(given = null) {
        let raw;
        try {
            const m = mode();
            if (!m.multi || !m.ctx) return;
            const now = clock();
            raw = rawSnapshot(given);
            advanceIntent(m, raw, now);
            // The fingerprint is the adapter's reading (narrowed to what a
            // fresh load decides on), so clock-driven noise in the raw
            // snapshot and the facts that move with every settled chat never
            // wake the holdings watcher.
            const fingerprint = signatureOf(watchFacts(m.ctx.adapter, normalizedSnapshot(m.ctx, raw, now)));
            if (fingerprint !== null && fingerprint !== lastFingerprint) {
                lastFingerprint = fingerprint;
                fireTriggers();
            }
        } catch { /* presentation only */ }
        // One copy of the SDK's lists per event: the state reads the same one.
        publish(raw === null ? undefined : raw);
    }

    // -- Other versions' payment history ---------------------------------------

    // The reader is boot's (`attach({readHistory})`): wallet-database code
    // bound to the loaded deployment. What it returns is the provider's own
    // projection of public fields, rows that are never edited and are replaced
    // by each read. A history that could not be read is unknown, never empty:
    // `settled` says so and the last rows that were read are kept.
    function fingerprintOf(rows) {
        try {
            const text = JSON.stringify(rows);
            let hash = 0x811c9dc5;
            for (let index = 0; index < text.length; index += 1) {
                hash = Math.imul(hash ^ text.charCodeAt(index), 0x01000193) >>> 0;
            }
            return `${rows.length}:${text.length}:${hash.toString(36)}`;
        } catch {
            return null;
        }
    }

    function adoptHistoryRows(rows) {
        const list = rows.filter(isRecord);
        const fingerprint = fingerprintOf(list);
        // A projection that cannot be fingerprinted is taken as changed.
        if (fingerprint !== null && fingerprint === historyState.fingerprint) return;
        historyState.fingerprint = fingerprint;
        historyState.rows = Object.freeze(list);
        historyState.revision += 1;
    }

    function ensureHistoryFresh() {
        try {
            const reader = attached?.readHistory;
            if (typeof reader !== 'function' || !mode().multi) return Promise.resolve();
            // One read at a time: callers share it.
            if (historyState.loading) return historyState.loading;
            const now = clock();
            if (!historyState.stale && historyState.readAt > 0 && now - historyState.readAt < HISTORY_FRESH_MS) {
                return Promise.resolve();
            }
            const started = epoch;
            const read = (async () => {
                // `loading` is set below, before anything here continues.
                await Promise.resolve();
                let result = null;
                try {
                    // A read that never answers is an unreadable history.
                    result = await within(Promise.resolve().then(reader), limits.historyMs, null);
                } catch {
                    result = null;
                }
                try {
                    // Attached again or reset meanwhile: the answer belongs to
                    // a reader that is no longer this facade's.
                    if (started !== epoch) return;
                    if (historyState.loading === read) historyState.loading = null;
                    historyState.readAt = clock();
                    historyState.stale = false;
                    if (isRecord(result) && Array.isArray(result.rows)) {
                        historyState.settled = 'ready';
                        adoptHistoryRows(result.rows);
                    } else {
                        historyState.settled = 'unreadable';
                    }
                    publish();
                } catch { /* presentation only: the read never rejects */ }
            })();
            historyState.loading = read;
            return read;
        } catch {
            return Promise.resolve();
        }
    }

    const history = Object.freeze({
        /** 'idle' (nothing read), 'loading', 'ready' or 'unreadable'. */
        status() {
            return historyState.loading ? 'loading' : historyState.settled;
        },
        /** The rows of the last good read (a frozen list, replaced by each read). */
        rows() {
            return historyState.rows;
        },
        /**
         * Read the history unless a read is in flight or a recent one still
         * stands (and nothing invalidated it). Never rejects. Subscribers are
         * told once when a read changed what is shown.
         * @returns {Promise<void>}
         */
        ensureFresh: ensureHistoryFresh,
        /** The wallet moved: the next ensureFresh() reads again. Reads nothing itself. */
        invalidate() {
            historyState.stale = true;
        },
        /**
         * Changes exactly when what the rows show would: a read that changed a
         * row or the outcome, and, once the UI helpers are attached, a
         * deadline crossed since the read (their signature). No amount of the
         * loaded version and no ticking time.
         */
        signature(nowMs) {
            let crossing = '';
            try {
                const ui = attached?.ui;
                const value = ui && typeof ui.historySignature === 'function' ? ui.historySignature(nowMs) : '';
                crossing = typeof value === 'string' ? value : '';
            } catch { /* the rows' own revision still says they changed */ }
            return `${historyState.settled}:${historyState.revision}:${crossing}`;
        }
    });

    // Forget everything the facade holds about attempts, a kit, the history
    // and work in flight. Called when the facade is attached to a client
    // again and by resetForTests.
    function forgetHeldFacts() {
        epoch += 1;
        heldRefusals.clear();
        serviceLatch = null;
        kitUnsaved = null;
        refusalsSeen = new WeakSet();
        startErrors = new WeakSet();
        startLatched = false;
        recheckInFlight = null;
        abandonInFlight = false;
        Object.assign(historyState, {
            rows: Object.freeze([]), settled: 'idle', loading: null, readAt: 0, stale: true, revision: 0, fingerprint: ''
        });
    }

    // -- Giving up a balance: the confirmation -----------------------------------

    // What the person is shown before they confirm, for a balance the state
    // says can be given up, or null. Bound to the note and balance shown: the
    // service refuses a confirmation whose note or balance differs.
    function previewFor(m, state, raw) {
        if (!state || !isRecord(state.abandon) || state.abandon.available !== true) return null;
        const kind = state.abandon.kind;
        if (kind !== 'zero' && kind !== 'dust') return null;
        const note = slotNoteFacts(raw);
        if (note.noteId === null || note.balanceUnits === null) return null;
        const { version, adapter, table } = m.ctx;
        const data = isRecord(adapter) && isRecord(adapter.abandon) ? adapter.abandon : {};
        const transition = isRecord(version.transition) ? version.transition : {};
        const quote = guarded(() => attached?.client?.nativePriceQuote) ?? null;
        let limitUnits = null;
        if (kind === 'dust') {
            const verdict = classifyBalance({
                balanceUnits: note.balanceUnits,
                chargeCapUnits: chargeCapUnits(),
                quote,
                thresholdUsdMicros: transition.dustThresholdUsdMicros,
                smallestTierUsdMicros: data.smallestChatTierUsdMicros,
                ceilingUnits: data.dustCeilingUnits
            });
            // The state said dust a moment ago from the same facts.
            if (verdict.kind !== 'dust') return null;
            limitUnits = verdict.limitUnits;
        } else if (note.balanceUnits !== '0') {
            return null;
        }
        const micros = units => {
            if (units === null || quote === null) return null;
            const value = nativeUsdMicros(units, quote);
            return Number.isSafeInteger(value) ? value : null;
        };
        const target = table.find(row => isRecord(row) && row.status === 'active') || null;
        const labelOf = row => (typeof row?.label === 'string' && row.label ? row.label : row?.id ?? null);
        return {
            kind,
            noteId: note.noteId,
            balanceUnits: note.balanceUnits,
            limitUnits,
            balanceUsdMicros: micros(note.balanceUnits),
            limitUsdMicros: micros(limitUnits),
            expiryMs: note.expiryMs,
            currentLabel: labelOf(version) ?? '',
            targetLabel: target && target.id !== version.id ? labelOf(target) : null
        };
    }

    // -- The facade -----------------------------------------------------------

    function switchTarget(reason, prefer, m) {
        if (!PREVIOUS_REASONS.has(reason)) return prefer || null;
        if (prefer) return prefer;
        const state = computeState(m, clock());
        return state.previous && state.previous.versionId !== m.ctx.version.id ? state.previous.versionId : null;
    }

    const watch = Object.freeze({
        /** The newest holdings preview (a Selection), or null when unreadable. */
        setPreview(selection) {
            if (!isRecord(selection) || !isRecord(selection.version)) return;
            flags.preview = selection;
            // The watcher re-read the shared wallet because something in it
            // moved, so the other versions' history may have too. Marked for
            // the next read; nothing is read here.
            historyState.stale = true;
            publish();
        },
        /** A newer build says deposits moved: restrict-only, cleared by reload. */
        latchStaleBuild() {
            if (flags.staleBuild) return;
            flags.staleBuild = true;
            publish();
        },
        noteDraftDiscarded() {
            if (flags.draftDiscarded) return;
            flags.draftDiscarded = true;
            publish();
        },
        noteDiscardLoop(blocked = true) {
            const next = blocked === true;
            if (flags.discardLoop === next) return;
            flags.discardLoop = next;
            publish();
        },
        /** Called when the SDK's own state changed or a probe was requested. */
        onTrigger(listener) {
            if (typeof listener !== 'function') return () => {};
            triggers.add(listener);
            return () => { triggers.delete(listener); };
        },
        requestProbe: fireTriggers
    });

    const facade = {
        get multiVersion() {
            return mode().multi;
        },
        get active() {
            return mode().ctx?.version || null;
        },
        get target() {
            const ctx = mode().ctx;
            return ctx ? ctx.table.find(row => isRecord(row) && row.status === 'active') || null : null;
        },
        get table() {
            const ctx = mode().ctx;
            return ctx ? [...ctx.table] : [];
        },
        get selection() {
            return mode().ctx?.selection || null;
        },
        get ui() {
            const m = mode();
            return m.multi ? attached?.ui || null : null;
        },
        /** Host plumbing for the version watcher. UI code must not call it. */
        watch,

        /**
         * Hand the facade the SDK singletons, once, at boot (and again only
         * in tests). `integrity` is verifyServedConfig's answer;
         * `discardUnsent` performs the user-confirmed discard (it needs the
         * SDK, so boot supplies it). `abandonNote` performs the confirmed
         * give-up of an empty or very small balance and `readHistory` reads
         * the other versions' payment history; both need SDK-bound or
         * wallet-database code, so boot supplies them, and only for a build
         * that has versions to tell apart.
         * @param {{client: object, runtime: object, ui?: object|null,
         *   integrity?: 'ok'|'mismatch'|'unverified', discardUnsent?: () => Promise<boolean>,
         *   abandonNote?: (args: object) => Promise<{done: boolean, kind?: string, why?: string}>,
         *   readHistory?: () => Promise<{rows: object[], truncated?: boolean}>,
         *   reload?: () => void, storage?: Storage}} input
         */
        attach({
            client, runtime, ui = null, integrity = 'unverified', discardUnsent = null,
            abandonNote = null, readHistory = null, reload, storage
        } = {}) {
            if (!client || typeof client !== 'object') throw new TypeError('The versioning facade needs the SDK client.');
            if (detachClient) {
                detachClient();
                detachClient = null;
            }
            attached = {
                client,
                runtime: runtime || null,
                ui: isRecord(ui) ? ui : null,
                discardUnsent,
                abandonNote: typeof abandonNote === 'function' ? abandonNote : null,
                readHistory: typeof readHistory === 'function' ? readHistory : null
            };
            flags.integrity = integrity === 'mismatch' || integrity === 'ok' ? integrity : 'unverified';
            flags.identity = null;
            if (typeof reload === 'function') env.reload = reload;
            if (storage) env.sessionStorage = storage;
            lastFingerprint = null;
            lastOpenRecords = new Set();
            upgradeNoteId = null;
            closedUnproven = new Set();
            withdrawalObserved = false;
            abandoned = false;
            forgetHeldFacts();
            // A dormant (single-version) page has no state, no notices and no
            // watcher, so it has no use for change events. Not subscribing keeps
            // today's page byte-for-byte as cheap as it was: the SDK's
            // `subscribe` copies a full snapshot for every listener on every
            // change. The mode is fixed once the version is installed.
            if (!mode().multi) return;
            if (typeof client.subscribe === 'function') {
                try {
                    const unsubscribe = client.subscribe(snapshot => onClientChange(snapshot));
                    if (typeof unsubscribe === 'function') detachClient = unsubscribe;
                } catch { /* the facade still answers from fresh reads */ }
            }
            onClientChange();
        },

        /**
         * Hand over the version UI helpers once they have loaded. Boot does
         * not wait for them, so a page without them is complete (no version
         * notices, everything else working) and gains them when they arrive;
         * subscribers are told so they can render the notices.
         * @param {object} ui versionUi
         * @returns {boolean} whether it was taken
         */
        attachUi(ui) {
            if (!attached || !isRecord(ui)) return false;
            attached.ui = ui;
            publish();
            return true;
        },

        /** May a new deposit start? Never throws. */
        depositGate() {
            try {
                const m = mode();
                if (!m.multi) return openGate();
                if (!m.ctx) return closedGate('version_unavailable');
                const state = computeState(m, clock());
                const gate = state.gate;
                return {
                    canStart: gate.canStart === true,
                    canResume: gate.canResume === true,
                    code: gate.code ?? null,
                    successor: gate.successor ? { ...gate.successor } : null
                };
            } catch {
                return closedGate('version_unavailable');
            }
        },

        /**
         * May a new chat key start? Fails open on anything unexpected: a
         * balance must never become unspendable because a helper broke.
         */
        sendGate(now = clock()) {
            try {
                const m = mode();
                if (!m.multi || !m.ctx) return { canSend: true, code: null };
                const snapshot = normalizedSnapshot(m.ctx, rawSnapshot(), now);
                // A family with a host cutoff (the legacy SDK has no rule of
                // its own): inside it a new key could leave a lease unsettled
                // when the note expires, which can make the note un-exitable.
                const cutoff = m.ctx.adapter?.chatCutoffSeconds;
                if (Number.isFinite(cutoff) && cutoff > 0 && snapshot.hasNote === true
                    && Number.isFinite(snapshot.expiryTs)
                    && now >= snapshot.expiryTs * 1000 - cutoff * 1000) {
                    return { canSend: false, code: 'near_expiry' };
                }
                // A family whose SDK says so itself (at most seconds stale; the
                // SDK enforces it again at the call). Only its own flag counts
                // here: a refusal held from an earlier attempt could outlive
                // the fact, and a balance must never become unspendable
                // because the page remembered wrongly.
                if (snapshot.exit?.nearExpiry === true) return { canSend: false, code: 'near_expiry' };
                return { canSend: true, code: null };
            } catch {
                return { canSend: true, code: null };
            }
        },

        /** The VersionState, or null when versioning is not active. Never throws. */
        state(now = clock()) {
            try {
                return stateNow(now);
            } catch {
                return null;
            }
        },

        /**
         * Call `listener(state)` when what the person would see changes: the
         * SDK's snapshot, a tier boundary, a watcher event. Never per clock
         * tick. Returns the unsubscribe function.
         */
        subscribe(listener) {
            if (typeof listener !== 'function') return () => {};
            listeners.add(listener);
            // Baseline for "what changed since": the subscriber reads state()
            // itself, so it is not called back with the state it already has.
            primeBaseline();
            return () => {
                listeners.delete(listener);
                if (!listeners.size && boundaryTimer !== null) {
                    env.clearTimer(boundaryTimer);
                    boundaryTimer = null;
                }
            };
        },

        /** The watcher's newest preview of what a fresh load would pick. */
        previewSelection() {
            return flags.preview;
        },

        /**
         * Reload into whichever build the next boot selects. Refuses while
         * work is in flight or in a reload loop; never reloads by itself.
         */
        requestSwitch({ reason, view = null, prefer = null } = {}) {
            try {
                const m = mode();
                if (!m.multi || !m.ctx) return { ok: false, why: 'no_target' };
                const preferred = switchTarget(reason, prefer, m);
                if (PREVIOUS_REASONS.has(reason) && !preferred) return { ok: false, why: 'no_target' };
                const busy = isBusy(rawSnapshot());
                // The intent is only ever promoted on evidence; a switch
                // asked for as "the withdrawal ended" records nothing the
                // facade has not already seen proven (an unproven one just
                // reloads, and the next page tells the neutral story).
                if (reason === 'upgrade_withdrawn' && !busy && storedIntentProves(m, clock())) facade.markWithdrawn();
                return requestVersionSwitch({
                    reason,
                    view: view || null,
                    prefer: preferred,
                    from: m.ctx.version.id,
                    canReload: !busy,
                    storage: session() || undefined,
                    reload: env.reload || undefined,
                    now: clock()
                });
            } catch (error) {
                // A malformed request is a caller bug; anything else is
                // unexpected. Neither may throw into a click handler, and
                // neither reloads the page.
                return { ok: false, why: error?.code === 'invalid_switch_request' ? 'no_target' : 'busy' };
            }
        },

        /**
         * Register a flag for "the page is working": `fn()` true means a
         * reload would interrupt something. Returns the unregister function.
         */
        registerBusy(provider) {
            if (typeof provider !== 'function') return () => {};
            busyProviders.add(provider);
            return () => { busyProviders.delete(provider); };
        },

        /**
         * The person entered the upgrade flow. Opens the review step and, on
         * a version that no longer takes deposits, remembers which upgrade
         * this browser started so a new tab or a later day can continue it.
         */
        beginUpgrade() {
            try {
                const m = mode();
                if (!m.multi || !m.ctx) return;
                viewOpen = true;
                const now = clock();
                const net = network();
                const state = computeState(m, now);
                if (net && state.upgrade.available && m.ctx.version.status === 'exit-only' && state.target) {
                    // An explicit new start (only here, where an upgrade can
                    // exist): a dismissed upgrade is not "still dismissed"
                    // once the person opens the upgrade view again.
                    abandoned = false;
                    // Arm the evidence rule: the note this upgrade starts from
                    // is the one in the slot now. Kept in memory only; when no
                    // slot note is reported (a set-aside-only balance, or a
                    // withdrawal already in motion) the earlier capture, if any,
                    // stands.
                    const noteId = slotNoteId(rawSnapshot());
                    if (noteId !== null) upgradeNoteId = noteId;
                    const intent = storedIntent(now);
                    const same = intent && intent.from === m.ctx.version.id && intent.to === state.target.id;
                    if (!same) {
                        saveIntent({
                            v: 1, network: net, from: m.ctx.version.id, to: state.target.id,
                            stage: 'withdrawing', since: now
                        });
                    }
                }
                publish();
            } catch { /* presentation only */ }
        },

        /** The upgrade view was closed. */
        endUpgrade() {
            if (!viewOpen) return;
            viewOpen = false;
            publish();
        },

        /**
         * The withdrawal is over and the person is about to reload into the
         * new version: record it so the deposit step is the first thing shown.
         *
         * Only on evidence, and only for an upgrade this browser started.
         * "Withdrawn" is a fact the next page tells the person ("Your balance
         * is withdrawn. Deposit to finish upgrading"), so it is written only
         * when the stored intent already says the withdrawal ended, or this
         * page observed the upgrade note's payout-verified closure (a write
         * that may have failed earlier is retried here). A balance that
         * merely vanished (expired, claimed by the treasury, archived) writes
         * nothing, and neither does a call with no stored intent: this never
         * creates an upgrade, so a dismissed one is not revived.
         */
        markWithdrawn() {
            try {
                const m = mode();
                const net = network();
                if (!m.multi || !m.ctx || !net) return;
                const now = clock();
                const stored = storedIntent(now);
                if (!stored || stored.from !== m.ctx.version.id) return;
                const proven = intentProvesWithdrawal(stored);
                if (!proven && !withdrawalObserved) return;
                const state = computeState(m, now);
                const to = (state.reload.required ? state.reload.targetId : null) || state.target?.id || null;
                if (!to || to === m.ctx.version.id) return;
                // Never rewind a later stage of the same upgrade.
                const stage = proven && stored.to === to ? stored.stage : 'withdrawn';
                saveIntent({ v: 1, network: net, from: m.ctx.version.id, to, stage, since: now });
                publish();
            } catch { /* the reload still works without the intent */ }
        },

        /**
         * The person dismissed the upgrade (for instance the "Your balance is
         * withdrawn. Deposit to finish upgrading" notice, which would
         * otherwise come back on every page for the intent's 45 days).
         * Forgets the persisted intent and everything this page has noted
         * about it, and stops this page reading a stored one even if storage
         * refuses the removal. Nothing but an explicit `beginUpgrade()`
         * writes an intent again, and that is a new start, not a revival.
         * `endUpgrade()` is the view closing; it neither clears nor is
         * reachable on the deposit page.
         * @returns {boolean} whether there was an upgrade to forget
         */
        abandonUpgrade() {
            try {
                const m = mode();
                if (!m.multi || !m.ctx) return false;
                const now = clock();
                const had = storedIntent(now) !== null || completedIntent !== null;
                // The stored key is shared by networks; only this network's
                // intent is the person's to dismiss here.
                if (storedIntent(now) !== null) clearUpgradeIntent({ storage: local() || undefined });
                abandoned = true;
                completedIntent = null;
                upgradeNoteId = null;
                closedUnproven = new Set();
                withdrawalObserved = false;
                publish();
                return had;
            } catch {
                return false;
            }
        },

        upgradeStage() {
            try {
                return stateNow()?.upgrade.stage || 'idle';
            } catch {
                return 'idle';
            }
        },

        /**
         * Remember the newest reminder tier the person has been shown. Kept
         * in memory for the page as well as in storage, so storage that
         * refuses writes (quota, restricted mode) cannot make every later
         * state change announce the same tier again.
         */
        acknowledgeReminder(tier) {
            try {
                const m = mode();
                if (!m.ctx || !Number.isFinite(tier) || tier < 0) return;
                const net = network();
                const key = `${net}:${m.ctx.version.id}`;
                reminderMemo.set(key, tier);
                const store = local();
                if (!net || !store) return;
                let tiers = {};
                try {
                    const parsed = JSON.parse(store.getItem(REMINDER_KEY) || 'null');
                    if (isRecord(parsed) && parsed.v === 1 && isRecord(parsed.tiers)) tiers = parsed.tiers;
                } catch { /* start over */ }
                tiers[key] = tier;
                store.setItem(REMINDER_KEY, JSON.stringify({ v: 1, tiers }));
            } catch { /* a per-viewer convenience */ }
        },

        /**
         * The reminder tier last acknowledged for this version, or null: the
         * lower (more urgent) of what this page acknowledged and what storage
         * holds, so a tier shown in another tab is not shown again here and
         * a failed write is not forgotten.
         */
        lastReminderTier() {
            try {
                const m = mode();
                if (!m.ctx) return null;
                const net = network();
                const key = `${net}:${m.ctx.version.id}`;
                const known = [];
                if (reminderMemo.has(key)) known.push(reminderMemo.get(key));
                try {
                    const store = local();
                    if (net && store) {
                        const parsed = JSON.parse(store.getItem(REMINDER_KEY) || 'null');
                        known.push(isRecord(parsed) && parsed.v === 1 && isRecord(parsed.tiers) ? parsed.tiers[key] : null);
                    }
                } catch { /* unreadable storage: the page's own memory stands */ }
                const tiers = known.filter(value => Number.isFinite(value) && value >= 0);
                return tiers.length ? Math.min(...tiers) : null;
            } catch {
                return null;
            }
        },

        /**
         * Discard a deposit draft or a never-sent deposit plan that pins this
         * version (a user-confirmed step; the facade never does this alone).
         * @returns {Promise<{discarded: boolean, why?: string}>}
         */
        async discardUnsentDeposit() {
            try {
                if (typeof attached?.discardUnsent !== 'function') return { discarded: false, why: 'unavailable' };
                if (isBusy(rawSnapshot())) return { discarded: false, why: 'busy' };
                const discarded = await attached.discardUnsent() === true;
                if (!discarded) return { discarded: false, why: 'not_discardable' };
                // The slot changed under the SDK: let the watcher re-read it.
                fireTriggers();
                publish();
                return { discarded: true };
            } catch {
                return { discarded: false, why: 'failed' };
            }
        },

        /** The only signal a response can raise: this deployment stopped starting chats. */
        noteSignal(code) {
            if (code !== 'deployment_retiring' || flags.admissionClosed) return;
            flags.admissionClosed = true;
            publish();
        },

        /**
         * An attempt was refused with `error`. When it is one of the SDK's
         * refusals about exiting a balance or a paused service, hold what it
         * said (bounded, in memory) so the balance can say it as a notice and
         * not only as a toast. Only ever tightens a fact: nothing here turns
         * a fact off, and the SDK enforces its own rules at the call.
         *
         * Called from catch paths. Never throws, is a no-op on a page with no
         * versions to tell apart, and reads each error object once however
         * many producers hand it over.
         *
         * An error carries no balance of its own, so `about` says which one
         * the attempt was about:
         *   {slot: true}   it acted on the balance in the wallet slot (a chat
         *                  key request, a withdrawal of the shown balance)
         *   {noteId}       a note, or {recordId} a withdrawal record: held
         *                  when it is the slot note, otherwise not attached
         *                  to it at all (a set-aside record being finished
         *                  does not make the live balance "used on another
         *                  device")
         * A refusal that is given no `about` is held for REFUSAL_HOLD_MS only:
         * the attempt may have been a set-aside record's, and a page that
         * guessed would keep a wrong fact about the live balance until
         * reload. A paused service names no balance and latches either way.
         * @param {unknown} error
         * @param {{slot?: boolean, noteId?: number, recordId?: string}|null} [about]
         */
        noteRefusal(error, about = null) {
            try {
                if (!error || typeof error !== 'object') return;
                const m = mode();
                if (!m.multi || !m.ctx) return;
                if (refusalsSeen.has(error)) return;
                refusalsSeen.add(error);
                const now = clock();
                let changed = false;
                const service = readServiceRefusal(error);
                if (service) {
                    serviceLatch = { code: service.code, at: now };
                    changed = true;
                }
                const refusal = readExitRefusal(error, now);
                if (refusal) {
                    const raw = rawSnapshot();
                    const noteId = slotNoteFacts(raw).noteId;
                    // With no slot note there is no balance for it to be about.
                    const attribution = noteId === null
                        ? null : refusalAttribution(about, raw, noteId, m.ctx.version);
                    if (attribution !== null) {
                        const attributed = attribution === 'slot';
                        const held = heldRefusals.get(refusal.kind);
                        // A standing fact an attempt known to be about this
                        // balance established is not replaced by a guess,
                        // which would end it after a minute. The other kinds
                        // describe the latest attempt: the newest is held.
                        const keep = !attributed && STANDING_REFUSALS.has(refusal.kind)
                            && held && held.attributed && held.noteId === noteId;
                        if (!keep) {
                            const reading = normalizedSnapshot(m.ctx, raw, now);
                            heldRefusals.set(refusal.kind, {
                                refusal: Object.freeze({ ...refusal }),
                                noteId,
                                at: now,
                                // Fresh when it arrived is only a snapshot that has
                                // not caught up (see refusalStillApplies).
                                sawStale: isRecord(reading.exit) && reading.exit.stateFresh === false,
                                attributed
                            });
                            changed = true;
                        }
                    }
                }
                if (changed) publish();
            } catch { /* presentation only, never into the caller's error path */ }
        },

        /**
         * Ask the service again now (the SDK's own check, the one every
         * deposit and chat starts with). A successful check lifts the held
         * refusal and the state follows the SDK. Never rejects.
         * @returns {Promise<{ok: true}|{ok: false, why: 'unavailable'|'still_unavailable'|'busy'}>}
         *   `unavailable`: this page's runtime cannot be asked (the caller
         *   offers a reload instead)
         */
        recheckService() {
            try {
                const m = mode();
                const client = attached?.client;
                const runtime = attached?.runtime;
                if (!m.multi || !m.ctx || !client || client.initialized !== true || !runtime
                    || typeof runtime.assertServiceAvailable !== 'function') {
                    return Promise.resolve({ ok: false, why: 'unavailable' });
                }
                if (recheckInFlight) return recheckInFlight;
                if (isBusy(rawSnapshot())) return Promise.resolve({ ok: false, why: 'busy' });
                const started = epoch;
                const run = (async () => {
                    try {
                        // A check that never answers is a service that is
                        // still unavailable, not a button that stays stuck.
                        const answered = await within(
                            Promise.resolve().then(() => runtime.assertServiceAvailable()).then(() => true),
                            limits.serviceCheckMs, false
                        );
                        if (!answered) return { ok: false, why: 'still_unavailable' };
                    } catch (error) {
                        if (started === epoch) {
                            // Still refused: a service refusal names the cause
                            // again, anything else leaves what was held.
                            const service = readServiceRefusal(error);
                            if (service) serviceLatch = { code: service.code, at: clock() };
                            publish();
                        }
                        return { ok: false, why: 'still_unavailable' };
                    }
                    if (started === epoch) {
                        serviceLatch = null;
                        // The runtime says it changed; the client re-reads on
                        // its own event, this just does not wait for it.
                        try { await client.refresh?.({ quiet: true }); } catch { /* it re-reads on its own */ }
                        onClientChange();
                    }
                    return { ok: true };
                })();
                recheckInFlight = run;
                const release = () => { if (recheckInFlight === run) recheckInFlight = null; };
                run.then(release, release);
                return run;
            } catch {
                return Promise.resolve({ ok: false, why: 'unavailable' });
            }
        },

        /**
         * Whether `error` is what stopped this page's SDK from starting (or
         * a later failure of a client that never started) while the wallet
         * holds a balance of the loaded version that the page therefore
         * cannot read (`state().held`). Such an error is the SDK's words for
         * an engineer and can name the operator's address; the balance says
         * it in plain words instead (zkapiErrorCopy.versionRefusalMessage).
         * False on a page with no versions to tell apart and for every other
         * error. Never throws.
         * @param {unknown} error
         * @returns {boolean}
         */
        isStartFailure(error) {
            try {
                if (!error || typeof error !== 'object') return false;
                const m = mode();
                if (!m.multi || !m.ctx) return false;
                // The cheap question first: most errors were never held while
                // the client had not started.
                const cause = error.cause;
                const known = startErrors.has(error)
                    || (Boolean(cause) && typeof cause === 'object' && startErrors.has(cause));
                return known && computeState(m, clock()).held?.unreachable === true;
            } catch {
                return false;
            }
        },

        /**
         * Create an encrypted exit kit of the balance in the slot (the SDK's
         * exportExitKit). Resolves with the kit's JSON text, which the caller
         * hands to the person and then drops: the facade keeps neither the
         * text nor the passphrase. Rejects with code `exit_kit_unavailable`
         * when this page's client cannot make one (the legacy SDK has none).
         * @param {string} passphrase
         * @returns {Promise<string>}
         */
        async exportExitKit(passphrase) {
            const m = mode();
            const client = attached?.client;
            if (!m.multi || !m.ctx || !client || typeof client.exportExitKit !== 'function') {
                const error = new Error('This browser can’t create an exit kit.');
                error.code = 'exit_kit_unavailable';
                throw error;
            }
            return client.exportExitKit(passphrase);
        },

        /** Whether exportExitKit can work on this page (a revision 3 client). */
        canExportExitKit() {
            try {
                return mode().multi && typeof attached?.client?.exportExitKit === 'function';
            } catch {
                return false;
            }
        },

        /**
         * Whether the file of a kit this page created was saved. The SDK
         * counts a kit as created before the browser delivers it and the page
         * forgets what happened to the file when it reloads, so the page
         * remembers a kit that was not saved (`false`) until one is (`true`),
         * for the balance it was about. Memory only.
         * @param {boolean} saved
         */
        noteKitSaved(saved) {
            try {
                const m = mode();
                if (!m.multi || !m.ctx) return;
                // With no slot note there is no balance a kit could be of.
                const noteId = slotNoteFacts(rawSnapshot()).noteId;
                const next = saved === true || noteId === null ? null : { noteId };
                const unchanged = next === null
                    ? kitUnsaved === null
                    : kitUnsaved !== null && kitUnsaved.noteId === next.noteId;
                if (unchanged) return;
                kitUnsaved = next;
                publish();
            } catch { /* the notice keeps its last words */ }
        },

        /**
         * An amount in the SDK's unit in the page's money words: dollars when
         * the client has a price, else ETH. '' when it can not be said.
         * @param {string|number} units
         * @returns {string}
         */
        formatAmount(units) {
            try {
                const client = attached?.client;
                if (!client || units === null || units === undefined) return '';
                const dollars = typeof client.formatMoney === 'function' ? client.formatMoney(units) : '';
                const text = typeof dollars === 'string' ? dollars.trim() : '';
                if (text && !/^[—–-]$/.test(text)) return text;
                if (client.isNativeEthFunding === true && typeof client.formatBillingAmount === 'function') {
                    const eth = client.formatBillingAmount(units);
                    if (typeof eth === 'string' || typeof eth === 'number') return `${eth} ETH`;
                }
                return '';
            } catch {
                return '';
            }
        },

        /**
         * Whether a withdrawal must re-verify the displayed balance and plan
         * under the wallet lock right before it starts: a build with versions
         * to tell apart whose protocol family lists the recheck among its
         * required behaviors. Everywhere else the request path is untouched.
         */
        operationRecheckRequired() {
            try {
                const m = mode();
                if (!m.multi || !m.ctx) return false;
                const wiring = m.ctx.adapter?.requiredWiring;
                return Array.isArray(wiring) && wiring.includes('withdrawal-operation-recheck');
            } catch {
                return false;
            }
        },

        /**
         * What the person would give up and where it goes, for a balance the
         * state offers to give up (an empty or very small one on a version
         * that no longer takes deposits); null when there is none. The
         * confirmation is bound to the note number and balance it names.
         * @returns {null|{kind: 'zero'|'dust', noteId: number, balanceUnits: string,
         *   limitUnits: string|null, balanceUsdMicros: number|null,
         *   limitUsdMicros: number|null, expiryMs: number|null,
         *   currentLabel: string, targetLabel: string|null}}
         */
        abandonPreview() {
            try {
                const m = mode();
                if (!m.multi || !m.ctx) return null;
                const raw = rawSnapshot();
                return previewFor(m, computeState(m, clock(), raw), raw);
            } catch {
                return null;
            }
        },

        /**
         * Give up the balance the preview named, if it is still exactly that
         * balance and still worth giving up. The decision is the service's, on
         * a fresh read under the wallet lock; this only refuses what the page
         * can already see is not on offer. Never throws.
         * @param {{noteId: number, balanceUnits: string}} args
         * @returns {Promise<{done: true, kind: string}|{done: false, why: string}>}
         */
        async giveUpBalance({ noteId, balanceUnits } = {}) {
            try {
                const m = mode();
                const abandonNote = attached?.abandonNote;
                if (!m.multi || !m.ctx || typeof abandonNote !== 'function') return { done: false, why: 'unavailable' };
                // Work in flight, including a give-up that is still writing.
                const raw = rawSnapshot();
                if (isBusy(raw)) return { done: false, why: 'busy' };
                const state = computeState(m, clock(), raw);
                const verdict = state.abandon;
                if (!isRecord(verdict) || verdict.available !== true) {
                    // `service_unreachable` is the state's own word for a
                    // balance the page cannot read; the dialog's reasons are
                    // the service's, and for it this is plain "unavailable".
                    const why = isRecord(verdict) ? verdict.blockedBy : null;
                    return { done: false, why: why && why !== 'service_unreachable' ? why : 'unavailable' };
                }
                const preview = previewFor(m, state, raw);
                if (!preview) return { done: false, why: 'unavailable' };
                if (noteNumber(noteId) !== preview.noteId || amountText(balanceUnits) !== preview.balanceUnits) {
                    return { done: false, why: 'changed' };
                }
                const { version, adapter } = m.ctx;
                const data = isRecord(adapter?.abandon) ? adapter.abandon : {};
                const transition = isRecord(version.transition) ? version.transition : {};
                abandonInFlight = true;
                const started = epoch;
                // The slot is empty once the write is done. There is no
                // balance left to upgrade, so a stored upgrade intent must not
                // tell "Upgrade complete"; the watcher re-reads the wallet and
                // the state moves on.
                const settled = () => {
                    facade.abandonUpgrade();
                    fireTriggers();
                    publish();
                };
                const write = Promise.resolve().then(() => abandonNote({
                    expectedNoteId: preview.noteId,
                    expectedBalanceUnits: preview.balanceUnits,
                    expectedDeploymentId: version.deploymentId,
                    supported: data.supported === true,
                    enabled: transition.abandonEnabled !== false,
                    thresholdUsdMicros: transition.dustThresholdUsdMicros,
                    smallestTierUsdMicros: data.smallestChatTierUsdMicros,
                    ceilingUnits: data.dustCeilingUnits
                }));
                let answer;
                try {
                    // A write that does not answer in time is reported as one
                    // that could not be confirmed ("reload to see where it
                    // stands") and the page does not stay busy for good. It is
                    // not cancelled: when it does finish, the same follow-up
                    // runs. Asking again meanwhile is safe: the service
                    // re-checks everything under the wallet lock.
                    answer = await within(write, limits.abandonMs, null);
                } finally {
                    abandonInFlight = false;
                }
                if (answer === null) {
                    write.then(late => {
                        if (isRecord(late) && late.done === true && started === epoch) settled();
                    }, () => {});
                    return { done: false, why: 'failed' };
                }
                if (!isRecord(answer) || answer.done !== true) {
                    const why = isRecord(answer) && typeof answer.why === 'string' && answer.why ? answer.why : 'failed';
                    return { done: false, why };
                }
                settled();
                return { done: true, kind: answer.kind === 'zero' || answer.kind === 'dust' ? answer.kind : preview.kind };
            } catch {
                abandonInFlight = false;
                return { done: false, why: 'failed' };
            }
        },

        /**
         * The other versions' payment history, on a page that has versions to
         * tell apart; absent (undefined) everywhere else.
         */
        get history() {
            return mode().multi ? history : undefined;
        },

        /**
         * Session facts the notice surfaces need and VersionState does not
         * carry (additive; booleans only): draftDiscarded, discardLoop,
         * admissionClosed, staleBuild, configMismatch and withdrawalConfirmed
         * (the upgrade's withdrawal ended WITH payout evidence). They are part
         * of what subscribers are notified about.
         */
        flags() {
            return sessionFlags(mode(), clock());
        },

        /** Forget everything attached or observed. Tests only. */
        resetForTests() {
            if (detachClient) detachClient();
            detachClient = null;
            attached = null;
            Object.assign(flags, {
                preview: null, staleBuild: false, admissionClosed: false, draftDiscarded: false,
                discardLoop: false, integrity: 'unverified', identity: null
            });
            listeners.clear();
            triggers.clear();
            busyProviders.clear();
            if (boundaryTimer !== null) env.clearTimer(boundaryTimer);
            boundaryTimer = null;
            lastSignature = null;
            lastFingerprint = null;
            lastOpenRecords = new Set();
            viewOpen = false;
            completedIntent = null;
            upgradeNoteId = null;
            closedUnproven = new Set();
            withdrawalObserved = false;
            abandoned = false;
            reminderMemo.clear();
            forgetHeldFacts();
        }
    };
    return facade;
}

/** The page's facade; boot attaches it as `zkapiClient.oaVersioning`. */
export const zkapiVersioning = createZkapiVersioning();

export default zkapiVersioning;
