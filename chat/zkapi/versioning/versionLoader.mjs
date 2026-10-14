// Which zkAPI protocol version a page loads.
//
// One SDK build runs per page (a build switch is a full reload), and the wallet
// database is shared, so the build is chosen from what that database holds
// before any SDK module is imported. The choice is a pure function of
// (version table, holdings, one validated one-shot `prefer`). It never reads a
// URL, a hash, localStorage or the network: a link or a script must not be able
// to steer a user into a build.
//
// chooseZkapiVersion   pure N-version decision table (docs/ZKAPI_VERSIONING.md).
// selectZkapiVersion   bounded read-only probe -> optional draft discard ->
//                      decision. Never throws for probe or discard failures.
//                      A lost discard race (another tab holds the lock or has
//                      already cleared the draft) is re-read once, so a tab
//                      never acts on a slot that is no longer pinned.
import { readWalletHoldings, discardDepositDraft } from './walletHoldings.mjs';
import { versionForDeployment } from './registryModel.mjs';
import { canDiscard as canDiscardAttempt, noteDiscard as noteDiscardAttempt } from './switchProtocol.mjs';

const DEFAULT_PROBE_TIMEOUT_MS = 2000;
const SLOT_KINDS = new Set(['empty', 'draft_only', 'unsent_prepared', 'pending_deposit', 'note', 'other']);
// The discard clears only these two (they hold no funds and no chain footprint).
const DISCARDABLE_SLOT_KINDS = new Set(['draft_only', 'unsent_prepared']);

function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function tableError(message) {
    const error = new Error(message);
    error.code = 'invalid_version_table';
    return error;
}

// The table's live rows (active or exit-only), its tombstones, and the two
// versions a decision can fall back to. A table the registry validator would
// have refused (no live row, two active rows, unknown status) is a build bug,
// not a runtime condition: it throws instead of guessing.
function describeTable(table) {
    if (!Array.isArray(table)) throw tableError('The version table must be an array.');
    const live = [];
    const retired = [];
    for (const version of table) {
        if (!isRecord(version) || typeof version.id !== 'string' || !version.id) {
            throw tableError('A version table entry has no id.');
        }
        if (version.status === 'active' || version.status === 'exit-only') live.push(version);
        else if (version.status === 'retired') retired.push(version);
        else throw tableError('A version table entry has an unknown status.');
    }
    if (!live.length) throw tableError('The version table has no live version.');
    const active = live.filter(version => version.status === 'active');
    if (active.length > 1) throw tableError('The version table has more than one deposit target.');
    const newest = live.reduce((best, version) => (Number(version.ordinal) > Number(best.ordinal) ? version : best));
    const target = active[0] || null;
    return { live, retired, target, loadTarget: target || newest };
}

// Strictly validated holdings, or null when they cannot be trusted. The probe
// always produces this shape; anything else means the read did not work.
function validateHoldings(holdings) {
    if (!Array.isArray(holdings)) return null;
    const normalized = [];
    let runtimeEntries = 0;
    for (const holding of holdings) {
        if (!isRecord(holding)) return null;
        if (holding.deploymentId !== null && typeof holding.deploymentId !== 'string') return null;
        if (typeof holding.runtime !== 'boolean') return null;
        if (!Array.isArray(holding.withdrawals)) return null;
        const credits = holding.credits === undefined ? [] : holding.credits;
        if (!Array.isArray(credits)) return null;
        if (holding.runtime) runtimeEntries += 1;
        normalized.push({
            deploymentId: holding.deploymentId,
            runtime: holding.runtime,
            withdrawals: holding.withdrawals,
            credits
        });
    }
    // The database has one runtime slot: two owners mean the data is not what
    // the probe produces.
    if (runtimeEntries > 1) return null;
    return normalized;
}

function emptySelection(version, reason, extras = {}) {
    return {
        version,
        reason,
        slotOwner: null,
        open: {},
        credits: {},
        foreignDeploymentId: null,
        depositBlock: null,
        draftDiscarded: extras.draftDiscarded === true,
        slotKind: extras.slotKind || 'other'
    };
}

/**
 * Decide which version to load. Pure: no storage, location, network or SDK.
 *
 * Rows, first match wins:
 *   1 one live version and no tombstone      that version (single_version)
 *   2 holdings not an array / malformed      load target, deposits blocked
 *                                            (holdings_unreadable)
 *   3 slot owned by a live version X         X (runtime_holds_note)
 *   4 slot owned by a retired version        load target, deposits blocked
 *                                            (retired_deployment, foreign_runtime)
 *   5 slot owner unknown or without an id    load target, deposits blocked
 *                                            (unknown_deployment, foreign_runtime)
 *   6 slot empty, `prefer` names a live      that version (requested_previous)
 *     version, other than the load target,
 *     holding an open withdrawal or credit
 *   7 slot empty                             load target (no_runtime_note)
 * "Load target" is the deposit target, else the newest live version. Open
 * withdrawals and unclaimed credits of every live version are reported in
 * `open` and `credits` (by version id) for banners.
 *
 * @param {{table: object[], holdings: unknown, prefer?: string|null,
 *   slotKind?: string, draftDiscarded?: boolean}} options `slotKind` and
 *   `draftDiscarded` are passed through for the caller that probed.
 * @returns {object} Selection (see docs/ZKAPI_VERSIONING.md).
 */
export function chooseZkapiVersion({ table, holdings, prefer = null, slotKind, draftDiscarded = false } = {}) {
    const { live, retired, loadTarget } = describeTable(table);
    const kind = SLOT_KINDS.has(slotKind) ? slotKind : null;
    const discarded = draftDiscarded === true;

    // Row 1: nothing to choose, and nothing worth reading the database for.
    // The slot was not read, so no kind is claimed beyond "nothing known".
    if (live.length === 1 && retired.length === 0) {
        return emptySelection(live[0], 'single_version', { slotKind: kind || 'empty', draftDiscarded: discarded });
    }

    // Row 2.
    const entries = validateHoldings(holdings);
    if (!entries) {
        const selection = emptySelection(loadTarget, 'holdings_unreadable', { slotKind: 'other', draftDiscarded: discarded });
        selection.depositBlock = 'holdings_unreadable';
        return selection;
    }

    const open = {};
    const credits = {};
    for (const version of live) {
        const owned = entries.filter(entry => entry.deploymentId !== null && entry.deploymentId === version.deploymentId);
        const withdrawals = owned.flatMap(entry => entry.withdrawals);
        const unclaimed = owned.flatMap(entry => entry.credits);
        if (withdrawals.length) open[version.id] = withdrawals.map(record => ({ ...record }));
        if (unclaimed.length) credits[version.id] = unclaimed.map(record => ({ ...record }));
    }
    const owner = entries.find(entry => entry.runtime) || null;
    const base = {
        open,
        credits,
        draftDiscarded: discarded,
        slotKind: kind || (owner ? 'other' : 'empty')
    };

    if (owner) {
        // Rows 3 to 5. The slot owner always wins; `prefer` is not consulted.
        const ownerVersion = owner.deploymentId === null ? null : versionForDeployment(table, owner.deploymentId);
        if (ownerVersion && ownerVersion.status !== 'retired') {
            return { version: ownerVersion, reason: 'runtime_holds_note', slotOwner: ownerVersion.id,
                foreignDeploymentId: null, depositBlock: null, ...base };
        }
        if (ownerVersion) {
            return { version: loadTarget, reason: 'retired_deployment', slotOwner: ownerVersion.id,
                foreignDeploymentId: owner.deploymentId, depositBlock: 'foreign_runtime', ...base };
        }
        return { version: loadTarget, reason: 'unknown_deployment', slotOwner: null,
            foreignDeploymentId: owner.deploymentId, depositBlock: 'foreign_runtime', ...base };
    }

    // Row 6: only for a live version other than the one that would load
    // anyway, and only with something there to finish. An id that names no
    // live version is ignored.
    if (typeof prefer === 'string' && prefer && prefer !== loadTarget.id) {
        const preferred = live.find(version => version.id === prefer);
        if (preferred && (open[preferred.id] || credits[preferred.id])) {
            return { version: preferred, reason: 'requested_previous', slotOwner: null,
                foreignDeploymentId: null, depositBlock: null, ...base };
        }
    }

    // Row 7.
    return { version: loadTarget, reason: 'no_runtime_note', slotOwner: null,
        foreignDeploymentId: null, depositBlock: null, ...base };
}

// A bounded probe that never throws: { ok: true, holdings, slot } or { ok: false }.
async function probe(readHoldings, database, timeoutMs) {
    let timer = null;
    try {
        const deadline = new Promise((resolve, reject) => {
            timer = setTimeout(() => reject(new Error('The holdings probe timed out.')), timeoutMs);
        });
        deadline.catch(() => {});
        const result = await Promise.race([
            Promise.resolve().then(() => readHoldings({ database, timeoutMs })),
            deadline
        ]);
        if (!isRecord(result) || validateHoldings(result.holdings) === null) return { ok: false };
        const kind = isRecord(result.slot) && SLOT_KINDS.has(result.slot.kind) ? result.slot.kind : 'other';
        const deploymentId = isRecord(result.slot) && typeof result.slot.deploymentId === 'string'
            ? result.slot.deploymentId : null;
        return { ok: true, holdings: result.holdings, slot: { deploymentId, kind } };
    } catch {
        return { ok: false };
    } finally {
        clearTimeout(timer);
    }
}

// Whether `selection`, decided from a slot of kind `slotKind`, is a user held
// on a non-target live version by something the host may clear. The same
// predicate gates the discard and the "was it really cleared" report.
function pinnedByDiscardable(selection, slotKind, target) {
    return selection.reason === 'runtime_holds_note'
        && target !== null
        && selection.version.id !== target.id
        && DISCARDABLE_SLOT_KINDS.has(slotKind);
}

// The discard's loop guard as a pair: `mayDiscard()` before an attempt and
// `charge()` after a discard that happened.
//
// Preferred (and the default): canDiscard / noteDiscard. An attempt that was
// refused, found the lock busy or found nothing to clear is not charged, so
// repeated reloads beside a busy tab cannot use up the allowance and raise the
// loop notice without anything having been written.
//
// Legacy: a lone `recordDiscard` is "check and charge", called once before the
// attempt, and nothing is charged afterwards. Hosts that still pass only it
// keep exactly their earlier accounting.
function resolveLoopGuard({ canDiscard, noteDiscard, recordDiscard }) {
    const given = fn => typeof fn === 'function';
    if (given(canDiscard) || given(noteDiscard)) {
        return {
            mayDiscard: given(canDiscard) ? canDiscard : () => canDiscardAttempt(),
            charge: given(noteDiscard) ? noteDiscard : () => noteDiscardAttempt()
        };
    }
    if (given(recordDiscard)) return { mayDiscard: recordDiscard, charge: null };
    return { mayDiscard: () => canDiscardAttempt(), charge: () => noteDiscardAttempt() };
}

// One bounded, never-throwing discard attempt: `{allowed, discarded, why}`.
async function attemptDiscard({ guard, discardDraft, database, bound, expectedDeploymentId }) {
    let allowed = false;
    try {
        allowed = guard.mayDiscard()?.allowed === true;
    } catch {
        allowed = false;
    }
    if (!allowed) return { allowed: false, discarded: false, why: 'loop_guard' };
    try {
        const outcome = await discardDraft({ database, timeoutMs: bound, expectedDeploymentId });
        if (outcome?.discarded === true) {
            if (guard.charge) {
                try { guard.charge(); } catch { /* the discard is done; the guard is best effort */ }
            }
            return { allowed: true, discarded: true, why: null };
        }
        return { allowed: true, discarded: false, why: typeof outcome?.why === 'string' ? outcome.why : null };
    } catch {
        return { allowed: true, discarded: false, why: 'error' };
    }
}

// A refusal that means another tab got there first: it holds the lock right
// now, or it already cleared the draft. The slot has changed or is changing,
// so the first read is stale. (no_locks, unreadable and a throwing discard say
// nothing about another tab: the read stands.)
const LOST_RACE = new Set(['lock_busy', 'not_discardable']);

/**
 * Probe the wallet database and choose a version.
 *
 * With a single live version and no tombstone nothing is probed (the database
 * is not even opened). Otherwise holdings are read once, bounded by
 * `timeoutMs`. When a non-target live version's slot is pinned only by a
 * deposit draft or a never-sent deposit plan, the host clears it (once per
 * attempt, rate limited by the shared loop-guard log) and decides again on a
 * fresh read.
 *
 * Several tabs booting together all see the same pinned draft, and only one
 * can clear it: the others get `lock_busy`, or `not_discardable` once it is
 * gone. They read once more and decide on what is really there, without
 * claiming the discard (`draftDiscarded` stays false). Only a read that still
 * shows the pin returns the pinned version.
 *
 * Never throws for probe, timeout or discard failures: they become
 * `holdings_unreadable` (deposits blocked) or simply no discard. It throws
 * only for a table no validated registry can produce.
 *
 * `draftDiscarded` is true only when this call cleared the draft AND the
 * slot is no longer pinned by a clearable draft on a non-target version; a
 * pre-rollout tab that recreated its draft in the meantime leaves it false,
 * and the person is shown the draft again as the unfinished deposit it is.
 *
 * @param {{table: object[], database: string, prefer?: string|null,
 *   timeoutMs?: number, readHoldings?: Function, discardDraft?: Function,
 *   canDiscard?: Function, noteDiscard?: Function,
 *   recordDiscard?: Function}} options
 *   Loop-guard seams: `canDiscard()` -> {allowed} is read-only and is asked
 *   before an attempt; `noteDiscard()` is called after a discard that
 *   happened (default: switchProtocol's, on session storage). The older
 *   `recordDiscard()` -> {allowed}, which checks and charges in one call
 *   before the attempt, is still accepted when neither new option is given.
 * @returns {Promise<object>} Selection.
 */
export async function selectZkapiVersion({
    table, database, prefer = null, timeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
    readHoldings = readWalletHoldings, discardDraft = discardDepositDraft,
    canDiscard, noteDiscard, recordDiscard
} = {}) {
    const { live, retired, target } = describeTable(table);
    if (live.length === 1 && retired.length === 0) {
        return chooseZkapiVersion({ table, holdings: [], prefer });
    }
    const bound = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_PROBE_TIMEOUT_MS;

    const first = await probe(readHoldings, database, bound);
    if (!first.ok) return chooseZkapiVersion({ table, holdings: null, prefer });
    const selection = chooseZkapiVersion({ table, holdings: first.holdings, prefer, slotKind: first.slot.kind });

    // Only a non-target live version can pin a user with something the host
    // may clear. Never the target's own draft, never a retired or unknown
    // owner, never a note or a started deposit.
    if (!pinnedByDiscardable(selection, first.slot.kind, target)) return selection;

    const attempt = await attemptDiscard({
        guard: resolveLoopGuard({ canDiscard, noteDiscard, recordDiscard }),
        discardDraft,
        database,
        bound,
        expectedDeploymentId: selection.version.deploymentId
    });

    if (!attempt.discarded) {
        if (!LOST_RACE.has(attempt.why)) return selection;
        // Another tab won the discard. Decide on the slot as it is now; if it
        // cannot be read, or still shows the pin, the first read stands.
        const reread = await probe(readHoldings, database, bound);
        if (!reread.ok) return selection;
        return chooseZkapiVersion({
            table, holdings: reread.holdings, prefer, slotKind: reread.slot.kind
        });
    }

    // The slot changed: decide again on what is really there now.
    const second = await probe(readHoldings, database, bound);
    if (!second.ok) {
        return chooseZkapiVersion({ table, holdings: null, prefer, draftDiscarded: true });
    }
    const decided = chooseZkapiVersion({
        table, holdings: second.holdings, prefer, slotKind: second.slot.kind, draftDiscarded: true
    });
    if (pinnedByDiscardable(decided, second.slot.kind, target)) {
        // Something recreated a clearable draft behind the discard. It was
        // cleared, but it is back, so the page must not say it is gone.
        return { ...decided, draftDiscarded: false };
    }
    return decided;
}
