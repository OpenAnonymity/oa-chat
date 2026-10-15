import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import concessionV1 from '../../chat/zkapi/versioning/adapters/concessionV1.mjs';
import { getAdapter } from '../../chat/zkapi/versioning/adapters/index.mjs';
import { copyTokens, versionCopyText } from '../../chat/zkapi/versioning/copy.mjs';
import { readExitRefusal, readServiceRefusal } from '../../chat/zkapi/versioning/exitRefusal.mjs';
import { deriveVersionState } from '../../chat/zkapi/versioning/versionState.mjs';
import {
    NOW_MS,
    activatedRegistry,
    normalizedSnapshot,
    resolvedTable,
    threeVersionRegistry
} from './_registryFixtures.mjs';

// VersionState for the balance facts a revision 3 SDK reports (near expiry,
// frozen and waiting balances, devices that are not the newest, credited and
// alerted payouts, set-aside records, giving up a balance), driven by the
// REAL snapshots the SDK emitted (test/fixtures/zkapi-v2-real-shapes) and by
// its real errors. `generatedAtMs` is the frozen clock; nothing reads
// Date.now() against these instants.

const FIXTURE = JSON.parse(fs.readFileSync(
    new URL('../fixtures/zkapi-v2-real-shapes/snapshots.json', import.meta.url), 'utf8'
));
const GENERATED = FIXTURE.generatedAtMs;
assert.equal(GENERATED, NOW_MS, 'the fixture clock is the registry fixtures clock');
const HOUR = 3_600_000;
const DAY = 86_400_000;
const CONCESSION = getAdapter('concession-v1');
const LEGACY = getAdapter('note-bound-v1');

// activatedRegistry(): v1 exit-only (note bound), v2 active (concession).
const TARGET_TABLE = resolvedTable(activatedRegistry(), 'mainnet');
const [LEGACY_ROW, TARGET_ROW] = TARGET_TABLE;
// threeVersionRegistry(): v1 and v2 exit-only, v3 active. v2 is a concession
// version that has a deposit target, so it is where upgrade nudges apply.
const THREE = resolvedTable(threeVersionRegistry(), 'mainnet');
const [LEGACY_OF_THREE, CLOSED_ROW] = THREE;

function selectionFor(version, overrides = {}) {
    return {
        version, reason: 'runtime_holds_note', slotOwner: version.id, open: {}, credits: {},
        foreignDeploymentId: null, depositBlock: null, draftDiscarded: false, slotKind: 'note', ...overrides
    };
}

// The snapshot of a scenario as the facade hands it to an adapter.
function scenario(name) {
    const { clientSnapshot, runtime } = FIXTURE.scenarios[name];
    return { ...clientSnapshot, runtime };
}

const normalized = name => concessionV1.normalizeSnapshot(scenario(name), { nowMs: GENERATED });

function derive({ table = THREE, active = CLOSED_ROW, snapshot = normalizedSnapshot(), now = GENERATED, ...rest } = {}) {
    return deriveVersionState({
        table,
        active,
        target: table.find(row => row.status === 'active') || null,
        selection: selectionFor(active),
        snapshot,
        intent: null,
        previewSelection: null,
        now,
        busy: false,
        admissionClosed: false,
        buildClosed: false,
        configBlock: false,
        unreachable: false,
        adapter: getAdapter(active.adapter),
        ...rest
    });
}

// A concession snapshot with nothing to report, to be amended.
const base = (overrides = {}) => ({
    ...normalizedSnapshot(),
    ownCredits: [], payoutAlerts: [], deviceNotNewestRecords: [], setAsideNear: [], unresolvedRequests: 0,
    ...overrides
});

const exitOf = (overrides = {}) => ({
    mustInitiateBy: GENERATED + 30 * DAY, nearExpiry: false, lockHeld: false, kitOutOfDate: true, rpcRecommended: false,
    boundAtState: '0', stateFresh: true, escapeAt: null, deviceNotNewest: false, lock: null,
    kit: { stateSeq: 2, exportedSeq: null, outOfDate: true }, depositPathSaved: true, rpcWrongChain: false,
    costWarning: false, ...overrides
});

const noteSnapshot = (expiryTs, overrides = {}) => base({
    hasNote: true, expiryTs, deadlines: [{ source: 'slot', expiryTs }], exit: exitOf(), ...overrides
});

const SECONDS = Math.floor(GENERATED / 1000);

// ---------------------------------------------------------------------------
// Near expiry
// ---------------------------------------------------------------------------

test('wiring:near-expiry the SDK flag and the instant a withdrawal must start by are in the state, in milliseconds', () => {
    const near = derive({ table: TARGET_TABLE, active: TARGET_ROW, snapshot: normalized('near_expiry') });
    assert.equal(near.exit.nearExpiry, true);
    // 1794770345000 is `must_initiate_by` as the SDK wrote it: already milliseconds.
    assert.equal(near.exit.mustInitiateByMs, 1794770345000);
    assert.ok(near.exit.mustInitiateByMs > GENERATED && near.exit.mustInitiateByMs < GENERATED + 2 * DAY);
    // The deposit target has nothing to upgrade to: near expiry is a fact, not a phase.
    assert.equal(near.phase, 'current');
    assert.equal(near.upgrade.available, false);
    assert.equal(near.reminderTier, null);

    // One hour farther from the deadline the SDK says it is not near: the flag is the SDK's, not a clock rule.
    const outside = derive({ table: TARGET_TABLE, active: TARGET_ROW, snapshot: normalized('just_outside_near_expiry') });
    assert.equal(outside.exit.nearExpiry, false);
    assert.equal(outside.exit.mustInitiateByMs, 1794774005000);
});

test('wiring:near-expiry a refused chat key makes the balance near expiry before the snapshot refreshes', () => {
    const snapshot = noteSnapshot(SECONDS + 5 * 86_400);
    assert.equal(derive({ table: TARGET_TABLE, active: TARGET_ROW, snapshot }).exit.nearExpiry, false);
    const refused = derive({
        table: TARGET_TABLE, active: TARGET_ROW, snapshot, exitRefusal: { kind: 'near', untilMs: null }
    });
    assert.equal(refused.exit.nearExpiry, true);
    // It can only tighten: the refusal does not clear a snapshot that already says near.
    const already = derive({
        table: TARGET_TABLE, active: TARGET_ROW,
        snapshot: noteSnapshot(SECONDS + 5 * 86_400, { exit: exitOf({ nearExpiry: true }) }),
        exitRefusal: null
    });
    assert.equal(already.exit.nearExpiry, true);
    // No slot note, no exit facts: a refusal has nothing to apply to.
    assert.equal(derive({ snapshot: base(), exitRefusal: { kind: 'near' } }).exit, null);
});

test('set-aside records near their deadline are counted with the earliest instant to withdraw by', () => {
    const state = derive({ snapshot: normalized('withdrawals_alert_credited_defeated') });
    assert.deepEqual(state.setAside, { near: 1, earliestMustInitiateByMs: 1795003200000, device: 1 });
    // Two near records: the earliest instant wins, whatever the order.
    const two = derive({
        snapshot: base({
            setAsideNear: [
                { recordId: 'a', mustInitiateByMs: GENERATED + 3 * DAY, expiryMs: GENERATED + 4 * DAY },
                { recordId: 'b', mustInitiateByMs: GENERATED + 1 * DAY, expiryMs: GENERATED + 2 * DAY },
                { recordId: 'c', mustInitiateByMs: null, expiryMs: null }
            ]
        })
    });
    assert.deepEqual(two.setAside, { near: 3, earliestMustInitiateByMs: GENERATED + 1 * DAY, device: 0 });
    // None dated: counted, no instant.
    const undated = derive({ snapshot: base({ setAsideNear: [{ recordId: 'a', mustInitiateByMs: null, expiryMs: null }] }) });
    assert.deepEqual(undated.setAside, { near: 1, earliestMustInitiateByMs: null, device: 0 });
});

// ---------------------------------------------------------------------------
// Devices that are not the newest
// ---------------------------------------------------------------------------

test('wiring:device-not-newest the slot note this device cannot exit is flagged and not nudged toward a withdrawal', () => {
    const flagged = derive({ snapshot: normalized('device_not_newest_evidence') });
    assert.equal(flagged.exit.deviceNotNewest, true);
    assert.equal(flagged.upgrade.available, false, 'this browser cannot withdraw it, so no upgrade is offered');
    assert.equal(flagged.upgrade.canStart, false);
    assert.equal(flagged.phase, 'current');
    assert.equal(flagged.reminderTier, null);
    assert.equal(flagged.closeByTs, null);
    // The note still holds funds and still expires: the deadline is reported.
    assert.equal(flagged.holding, 'previous');
    assert.equal(flagged.expiryTs, 1795953600 * 1000);

    // The same balance, not flagged, is nudged as before.
    const healthy = derive({ snapshot: normalized('kit_never_exported') });
    assert.equal(healthy.exit.deviceNotNewest, false);
    assert.equal(healthy.upgrade.available, true);
    assert.equal(healthy.phase, 'upgrade-soon');
    assert.equal(healthy.closeByTs, (1795953600 - 259200) * 1000);
});

test('wiring:device-not-newest a refusal of an exit attempt flags the balance before the snapshot does', () => {
    const snapshot = noteSnapshot(SECONDS + 10 * 86_400);
    const healthy = derive({ snapshot });
    assert.equal(healthy.upgrade.available, true);
    const refused = derive({ snapshot, exitRefusal: readExitRefusal(Object.assign(new Error('x'), {
        code: 'device_not_newest', data: { reason: 'defeated' }
    }), GENERATED) });
    assert.equal(refused.exit.deviceNotNewest, true);
    assert.equal(refused.upgrade.available, false);
    assert.equal(refused.phase, 'current');
    assert.equal(refused.reminderTier, null);
});

test('wiring:device-not-newest a set-aside record this device cannot exit is not nudged and is not "withdrawing"', () => {
    const FLAGGED = { source: 'set-aside', expiryTs: SECONDS + 4 * 86_400, recordId: 'flagged', deviceFlagged: true };
    const CLEAN = { source: 'set-aside', expiryTs: SECONDS + 30 * 86_400, recordId: 'clean', deviceFlagged: false };

    // Only a flagged record: current, one device record, no tier, and an open
    // record that is only this one does not read as a withdrawal in motion.
    const only = derive({
        snapshot: base({
            deadlines: [FLAGGED], hasOpenWithdrawal: true, deviceNotNewestRecords: ['flagged']
        })
    });
    assert.equal(only.phase, 'current');
    assert.deepEqual(only.setAside, { near: 0, earliestMustInitiateByMs: null, device: 1 });
    assert.equal(only.reminderTier, null);
    assert.equal(only.closeByTs, null);
    assert.equal(only.upgrade.available, false);
    assert.equal(only.previous, null);
    // It is still a deadline that holds funds.
    assert.equal(only.holding, 'previous');
    assert.equal(only.expiryTs, FLAGGED.expiryTs * 1000);

    // Beside an exitable one, the exitable one alone drives the nudge, even
    // when the flagged one expires first.
    const both = derive({
        snapshot: base({ deadlines: [FLAGGED, CLEAN], hasOpenWithdrawal: true, deviceNotNewestRecords: ['flagged'] })
    });
    assert.equal(both.phase, 'finish-previous-withdrawal');
    assert.equal(both.previous.openWithdrawals, 1);
    assert.equal(both.expiryTs, CLEAN.expiryTs * 1000);
    assert.equal(both.deadlineSource, 'set-aside');
    assert.equal(both.setAside.device, 1);
    // The close-by is the clean record's (expiry minus the version's margin).
    assert.equal(both.closeByTs, (CLEAN.expiryTs - 259200) * 1000);

    // The same two records, neither flagged, chase the earlier one.
    const unflagged = derive({ snapshot: base({ deadlines: [{ ...FLAGGED, deviceFlagged: false }, CLEAN], hasOpenWithdrawal: true }) });
    assert.equal(unflagged.closeByTs, (FLAGGED.expiryTs - 259200) * 1000);
    assert.equal(unflagged.previous.openWithdrawals, 2);
});

test('two records that share an expiry are two deadlines when only one can be exited here', () => {
    const expiryTs = SECONDS + 30 * 86_400;
    const state = derive({
        snapshot: base({
            deadlines: [
                { source: 'set-aside', expiryTs, recordId: 'a', deviceFlagged: true },
                { source: 'set-aside', expiryTs, recordId: 'b', deviceFlagged: false }
            ],
            hasOpenWithdrawal: true, deviceNotNewestRecords: ['a']
        })
    });
    assert.equal(state.previous.openWithdrawals, 1);
    assert.equal(state.setAside.device, 1);
    // Identical entries are still one.
    const same = derive({
        snapshot: base({
            deadlines: [
                { source: 'set-aside', expiryTs, recordId: 'a', deviceFlagged: false },
                { source: 'set-aside', expiryTs, recordId: 'b', deviceFlagged: false }
            ],
            hasOpenWithdrawal: true
        })
    });
    assert.equal(same.previous.openWithdrawals, 1);
});

test('the device count never counts one record twice', () => {
    const state = derive({
        snapshot: base({
            deadlines: [{ source: 'set-aside', expiryTs: SECONDS + 9 * 86_400, recordId: 'r', deviceFlagged: true }],
            hasOpenWithdrawal: true,
            deviceNotNewestRecords: ['r', 'r2']
        })
    });
    assert.equal(state.setAside.device, 2);
    // Records with no id are counted as many as the longer list names.
    const anonymous = derive({
        snapshot: base({
            deadlines: [{ source: 'set-aside', expiryTs: SECONDS + 9 * 86_400, recordId: null, deviceFlagged: true }],
            hasOpenWithdrawal: true,
            deviceNotNewestRecords: ['']
        })
    });
    assert.equal(anonymous.setAside.device, 1);
});

// ---------------------------------------------------------------------------
// Frozen balances and waits
// ---------------------------------------------------------------------------

test('a lock freezes the balance until the instant the SDK reports, in milliseconds', () => {
    const escape = derive({ snapshot: normalized('escape_lock_released_proof') });
    assert.deepEqual(escape.exit.frozen, { untilMs: 1794755700000, mode: 'escape' });
    const mutual = derive({ snapshot: normalized('mutual_lock_with_ownership_proof') });
    assert.deepEqual(mutual.exit.frozen, { untilMs: null, mode: 'mutual' });
    const free = derive({ snapshot: normalized('kit_never_exported') });
    assert.equal(free.exit.frozen, null);
    // A release instant that has passed is not a time to print.
    const passed = derive({ snapshot: normalized('escape_lock_released_proof'), now: 1794755700000 + 1 });
    assert.deepEqual(passed.exit.frozen, { untilMs: null, mode: 'escape' });
});

test('a refused chat key adds a frozen balance, and only until its instant', () => {
    const snapshot = noteSnapshot(SECONDS + 5 * 86_400);
    const locked = readExitRefusal(Object.assign(new Error('x'), {
        code: 'exit_locked', data: { mode: 'escape', released: 1, releasable_after: SECONDS + 7200, reason: 'proof_live' }
    }), GENERATED);
    const frozen = derive({ snapshot, exitRefusal: locked });
    assert.deepEqual(frozen.exit.frozen, { untilMs: (SECONDS + 7200) * 1000, mode: null });
    // Past its instant, with nothing in the snapshot: not frozen.
    assert.equal(derive({ snapshot, exitRefusal: locked, now: (SECONDS + 7200) * 1000 }).exit.frozen, null);
    // The snapshot's own lock is the better fact when both exist.
    const both = derive({
        snapshot: noteSnapshot(SECONDS + 5 * 86_400, {
            exit: exitOf({ lockHeld: true, lock: { mode: 'escape', sinceMs: GENERATED - 1000, released: 1, proofsReleased: 1, releasableAfterMs: GENERATED + HOUR } })
        }),
        exitRefusal: locked
    });
    assert.deepEqual(both.exit.frozen, { untilMs: GENERATED + HOUR, mode: 'escape' });
    // A lock with no end in either place is frozen with no instant.
    const open = readExitRefusal(Object.assign(new Error('x'), {
        code: 'exit_locked', data: { mode: 'mutual', releasable_after: null, reason: 'held' }
    }), GENERATED);
    assert.deepEqual(derive({ snapshot, exitRefusal: open }).exit.frozen, { untilMs: null, mode: null });
});

test('a refused withdrawal is a wait until the instant it says, and a settled state ends a settlement wait', () => {
    const snapshot = normalized('unresolved_request_settlement_wait');
    assert.equal(snapshot.exit.stateFresh, false);
    const refusal = readExitRefusal(Object.assign(new Error('x'), {
        code: 'request_settlement_pending',
        data: { escape_at: snapshot.exit.escapeAt, must_initiate_by: snapshot.exit.mustInitiateBy, bound_at_state: '1000000',
            forced_escape: { zero: '0', bound: '1000000' } }
    }), GENERATED);
    const waiting = derive({ snapshot, exitRefusal: refusal });
    assert.deepEqual(waiting.exit.wait, {
        kind: 'settlement', untilMs: snapshot.exit.escapeAt, escapeAtMs: snapshot.exit.escapeAt,
        mustInitiateByMs: snapshot.exit.mustInitiateBy, boundAtState: '1000000'
    });
    // The standing facts say the same thing before anyone tried.
    assert.equal(waiting.exit.stateFresh, false);
    assert.equal(waiting.exit.escapeAtMs, snapshot.exit.escapeAt);
    assert.equal(waiting.exit.boundAtState, '1000000');
    // Never a phase: the withdrawal is still the person's to make.
    assert.equal(waiting.phase, derive({ snapshot }).phase);

    // At its instant the wait is over.
    assert.equal(derive({ snapshot, exitRefusal: refusal, now: snapshot.exit.escapeAt }).exit.wait, null);
    // The request settled (the snapshot is fresh again): nothing to wait for.
    const settled = { ...snapshot, exit: { ...snapshot.exit, stateFresh: true, escapeAt: null, boundAtState: '0' } };
    assert.equal(derive({ snapshot: settled, exitRefusal: refusal }).exit.wait, null);
    // Without a slot note there is nothing it could apply to.
    assert.equal(derive({ snapshot: base(), exitRefusal: refusal }).exit, null);
});

test('a held settlement refusal never overrides or under-states what the snapshot reports now', () => {
    const standing = normalized('unresolved_request_settlement_wait');
    assert.equal(standing.exit.stateFresh, false);
    assert.equal(standing.exit.boundAtState, '1000000');
    const now = GENERATED + 60_000;
    const refusalOf = (escapeAt, bound) => readExitRefusal(Object.assign(new Error('x'), {
        code: 'request_settlement_pending',
        data: { escape_at: escapeAt, must_initiate_by: standing.exit.mustInitiateBy, bound_at_state: bound,
            forced_escape: { zero: '0', bound } }
    }), now - 120_000);
    // The refusal is about an EARLIER request: it settled, then a new chat on
    // a key with a higher cap started (a new state, its own time and bound).
    const earlier = refusalOf(standing.exit.escapeAt - 30 * 60_000, '1000');
    assert.equal(earlier.escapeAtMs, standing.exit.escapeAt - 30 * 60_000);
    const derived = snapshot => derive({ table: TARGET_TABLE, active: TARGET_ROW, snapshot, exitRefusal: earlier, now });

    // Settled: nothing is waited for.
    const settled = { ...standing, exit: { ...standing.exit, stateFresh: true, escapeAt: null, boundAtState: '0' } };
    assert.equal(derived(settled).exit.wait, null);
    // Unresolved again: the SDK's own time and bound, not the old refusal's.
    const again = derived(standing).exit.wait;
    assert.deepEqual(again, {
        kind: 'settlement', untilMs: standing.exit.escapeAt, escapeAtMs: standing.exit.escapeAt,
        mustInitiateByMs: standing.exit.mustInitiateBy, boundAtState: '1000000'
    });
    // What the person reads: the standing time and the standing bound.
    const formatAmount = units => `${units} gwei`;
    const tokens = copyTokens(derived(standing), { formatter: date => date.toISOString(), formatAmount, now });
    assert.equal(tokens.bound, '1000000 gwei');
    assert.equal(tokens.escapeAt, new Date(standing.exit.escapeAt).toISOString());
    assert.match(versionCopyText('exit.concede.bound', tokens), /^Give up up to 1000000 gwei now\./);

    // A refusal that is LATER or LARGER than the standing facts is never
    // shortened to them: the snapshot can be a few seconds behind an attempt.
    const larger = refusalOf(standing.exit.escapeAt + 10 * 60_000, '5000000');
    const kept = derive({ table: TARGET_TABLE, active: TARGET_ROW, snapshot: standing, exitRefusal: larger, now }).exit.wait;
    assert.equal(kept.escapeAtMs, standing.exit.escapeAt + 10 * 60_000);
    assert.equal(kept.untilMs, standing.exit.escapeAt + 10 * 60_000);
    assert.equal(kept.boundAtState, '5000000');
    // Compared as amounts, not as text: '9' is less than '10'.
    const text = derive({
        table: TARGET_TABLE, active: TARGET_ROW, exitRefusal: refusalOf(standing.exit.escapeAt, '9'), now,
        snapshot: { ...standing, exit: { ...standing.exit, boundAtState: '10' } }
    }).exit.wait;
    assert.equal(text.boundAtState, '10');

    // The refusal has run out but the snapshot still has an unresolved request
    // with a later time: the wait is not over, it is until that time.
    // (Read two minutes before `now`, so its instant was still ahead then.)
    const passed = refusalOf(now - 1_000, '1000');
    assert.equal(passed.untilMs, now - 1_000);
    const stillWaiting = derive({ table: TARGET_TABLE, active: TARGET_ROW, snapshot: standing, exitRefusal: passed, now }).exit.wait;
    assert.equal(stillWaiting.untilMs, standing.exit.escapeAt);
    assert.equal(stillWaiting.boundAtState, '1000000');
    // And without that standing request the same refusal is simply over.
    assert.equal(derive({
        table: TARGET_TABLE, active: TARGET_ROW, exitRefusal: passed, now,
        snapshot: { ...standing, exit: { ...standing.exit, stateFresh: null, escapeAt: null } }
    }).exit.wait, null);

    // The snapshot's standing time is only believed while it says a request
    // is unresolved: an unknown freshness leaves the refusal as it was.
    const unknown = derive({
        table: TARGET_TABLE, active: TARGET_ROW, exitRefusal: earlier, now,
        snapshot: { ...standing, exit: { ...standing.exit, stateFresh: null } }
    }).exit.wait;
    assert.equal(unknown.escapeAtMs, standing.exit.escapeAt - 30 * 60_000);
    assert.equal(unknown.boundAtState, '1000000', 'the standing bound is still not undercut');
});

test('the words of a settlement wait are built from the state and the clock alone', () => {
    const snapshot = normalized('unresolved_request_settlement_wait');
    const refusal = readExitRefusal(Object.assign(new Error('x'), {
        code: 'request_settlement_pending',
        data: {
            escape_at: snapshot.exit.escapeAt, must_initiate_by: snapshot.exit.mustInitiateBy,
            bound_at_state: '1000000', forced_escape: { zero: '0', bound: '1000000' }
        }
    }), GENERATED);
    const state = derive({ snapshot, exitRefusal: refusal });
    const formatter = date => date.toISOString().slice(0, 16).replace('T', ' ');
    // 1,000,000 gwei is 0.001 ether: the caller's own money words.
    const formatAmount = units => `${(Number(units) / 1e9).toFixed(3)} ether`;
    const tokens = copyTokens(state, { formatter, formatAmount, now: GENERATED });
    assert.equal(tokens.escapeAt, '2026-11-15 18:10');
    assert.equal(tokens.bound, '0.001 ether');
    assert.equal(
        versionCopyText('exit.settlement', tokens),
        'A recent chat may still be settling, so a normal withdrawal waits for it until 2026-11-15 18:10. '
        + 'You can wait, or leave now with an emergency exit, which takes longer to finish.'
    );
    assert.equal(
        versionCopyText('exit.concede.bound', tokens),
        'Give up up to 0.001 ether now. That chat isn’t recorded on Ethereum, so you may give up more than it actually cost.'
    );
    assert.equal(
        versionCopyText('exit.bound', tokens),
        'If a recent chat is still settling, a withdrawal can give up as much as 0.001 ether.'
    );
    // Before anyone tried, the standing bound is the one the fine print shows.
    const standing = copyTokens(derive({ snapshot }), { formatter, formatAmount });
    assert.equal(standing.bound, '0.001 ether');
    assert.equal('escapeAt' in standing, false);
    // A balance that cannot lose anything to a settling chat says nothing about it.
    assert.equal('bound' in copyTokens(derive({ snapshot: normalized('kit_never_exported') }), { formatter, formatAmount }), false);
});

test('a proof wait and a pending release are waits; the bound falls back to the standing one', () => {
    const snapshot = noteSnapshot(SECONDS + 5 * 86_400, { exit: exitOf({ boundAtState: '250000' }) });
    const proof = readExitRefusal(Object.assign(new Error('x'), {
        code: 'ownership_proof_wait', data: { retry_after: 4 }
    }), GENERATED);
    const waitingOnProof = derive({ snapshot, exitRefusal: proof });
    assert.deepEqual(waitingOnProof.exit.wait, {
        kind: 'proof', untilMs: GENERATED + 4000, escapeAtMs: null, mustInitiateByMs: null, boundAtState: '250000'
    });
    // Seconds later it is over.
    assert.equal(derive({ snapshot, exitRefusal: proof, now: GENERATED + 4000 }).exit.wait, null);
    assert.ok(derive({ snapshot, exitRefusal: proof, now: GENERATED + 3999 }).exit.wait);

    const release = readExitRefusal(Object.assign(new Error('x'), {
        code: 'exit_release_pending', data: { reason: 'finality_unknown', releasable_after: SECONDS + 600, must_initiate_by: SECONDS + 86_400 }
    }), GENERATED);
    const pending = derive({ snapshot, exitRefusal: release });
    assert.deepEqual(pending.exit.wait, {
        kind: 'release', untilMs: (SECONDS + 600) * 1000, escapeAtMs: null,
        mustInitiateByMs: (SECONDS + 86_400) * 1000, boundAtState: '250000'
    });
    // A release with no usable time is a wait with no end the state can name.
    const open = readExitRefusal(Object.assign(new Error('x'), { code: 'exit_release_pending', data: {} }), GENERATED);
    assert.deepEqual(derive({ snapshot, exitRefusal: open }).exit.wait, {
        kind: 'release', untilMs: null, escapeAtMs: null, mustInitiateByMs: null, boundAtState: '250000'
    });
});

test('refusal input is read as data: an unknown kind, a malformed value or a string time is no wait', () => {
    const snapshot = noteSnapshot(SECONDS + 5 * 86_400);
    for (const exitRefusal of [null, undefined, 'locked', 7, [], {}, { kind: 'bogus' }, { kind: 'toString' }]) {
        const state = derive({ snapshot, exitRefusal });
        assert.equal(state.exit.wait, null, JSON.stringify(exitRefusal));
        assert.equal(state.exit.frozen, null, JSON.stringify(exitRefusal));
        assert.equal(state.exit.nearExpiry, false, JSON.stringify(exitRefusal));
        assert.equal(state.exit.deviceNotNewest, false, JSON.stringify(exitRefusal));
    }
    const wait = derive({ snapshot, exitRefusal: { kind: 'proof', untilMs: '9999999999999', boundAtState: 'x' } });
    assert.deepEqual(wait.exit.wait, {
        kind: 'proof', untilMs: null, escapeAtMs: null, mustInitiateByMs: null, boundAtState: '0'
    });
});

// ---------------------------------------------------------------------------
// The exit kit and the exit summary
// ---------------------------------------------------------------------------

test('the exit kit facts come from the SDK, and the unsaved flag is the page\'s own', () => {
    const never = derive({ snapshot: normalized('kit_never_exported') });
    assert.deepEqual(never.exit.kit, { exported: false, outOfDate: true, depositPathSaved: true, unsaved: false });
    const stale = derive({ snapshot: normalized('kit_out_of_date') });
    assert.deepEqual(stale.exit.kit, { exported: true, outOfDate: true, depositPathSaved: true, unsaved: false });
    // The page created a kit and the file was not saved.
    const unsaved = derive({ snapshot: normalized('kit_never_exported'), kitUnsaved: true });
    assert.equal(unsaved.exit.kit.unsaved, true);
    for (const kitUnsaved of [false, undefined, null, 'yes', 1]) {
        assert.equal(derive({ snapshot: normalized('kit_never_exported'), kitUnsaved }).exit.kit.unsaved, false, String(kitUnsaved));
    }
    // A current kit: created and not out of date.
    const current = derive({
        snapshot: noteSnapshot(SECONDS + 5 * 86_400, {
            exit: exitOf({ kitOutOfDate: false, kit: { stateSeq: 4, exportedSeq: 4, outOfDate: false } })
        })
    });
    assert.deepEqual(current.exit.kit, { exported: true, outOfDate: false, depositPathSaved: true, unsaved: false });
    // The page-level flag has no kit to belong to when there is no exit summary.
    assert.equal(derive({ snapshot: base(), kitUnsaved: true }).exit, null);
});

test('the exit summary is "not known" where the snapshot does not say', () => {
    // A summary of an older shape: no kit block, no fresh flag.
    const old = derive({
        snapshot: noteSnapshot(SECONDS + 5 * 86_400, {
            exit: { mustInitiateBy: GENERATED + DAY, nearExpiry: false, lockHeld: false, kitOutOfDate: true, rpcRecommended: true }
        })
    });
    assert.deepEqual(old.exit, {
        nearExpiry: false, mustInitiateByMs: GENERATED + DAY, boundAtState: null, stateFresh: null, escapeAtMs: null,
        frozen: null, deviceNotNewest: false, wait: null,
        kit: { exported: false, outOfDate: true, depositPathSaved: null, unsaved: false },
        rpc: { recommended: true, wrongChain: false }
    });
    // A kit counts as current only when the SDK says it is not out of date.
    const missing = derive({ snapshot: noteSnapshot(SECONDS + 5 * 86_400, { exit: { kit: null } }) });
    assert.equal(missing.exit.kit.outOfDate, true);
    // RPC advice facts.
    const rpc = derive({
        snapshot: noteSnapshot(SECONDS + 5 * 86_400, { exit: exitOf({ rpcRecommended: true, rpcWrongChain: true }) })
    });
    assert.deepEqual(rpc.exit.rpc, { recommended: true, wrongChain: true });
});

test('an instant in the wrong unit is "not known" and never a date in 1970 or in the year 58000', () => {
    const seconds = Math.floor((GENERATED + DAY) / 1000);
    const state = derive({
        snapshot: noteSnapshot(SECONDS + 5 * 86_400, {
            exit: exitOf({
                mustInitiateBy: seconds, escapeAt: seconds, stateFresh: false,
                lockHeld: true, lock: { mode: 'escape', sinceMs: null, released: 1, proofsReleased: 1, releasableAfterMs: seconds }
            }),
            setAsideNear: [{ recordId: 'a', mustInitiateByMs: seconds, expiryMs: null }]
        }),
        exitRefusal: { kind: 'settlement', untilMs: seconds, escapeAtMs: seconds, mustInitiateByMs: seconds }
    });
    assert.equal(state.exit.mustInitiateByMs, null);
    assert.equal(state.exit.escapeAtMs, null);
    assert.deepEqual(state.exit.frozen, { untilMs: null, mode: 'escape' });
    assert.deepEqual(state.exit.wait, {
        kind: 'settlement', untilMs: null, escapeAtMs: null, mustInitiateByMs: null, boundAtState: '0'
    });
    assert.deepEqual(state.setAside, { near: 1, earliestMustInitiateByMs: null, device: 0 });
    // Microseconds are as far off in the other direction.
    const micros = derive({
        snapshot: noteSnapshot(SECONDS + 5 * 86_400, { exit: exitOf({ mustInitiateBy: (GENERATED + DAY) * 1000 }) })
    });
    assert.equal(micros.exit.mustInitiateByMs, null);
});

test('a protocol with no exit summary has none, however the facade is fed', () => {
    const legacy = deriveVersionState({
        table: TARGET_TABLE, active: LEGACY_ROW, target: TARGET_ROW, selection: selectionFor(LEGACY_ROW),
        snapshot: LEGACY.normalizeSnapshot({}, { nowMs: GENERATED }), intent: null, previewSelection: null, now: GENERATED,
        busy: false, admissionClosed: false, buildClosed: false, configBlock: false, unreachable: false, adapter: LEGACY,
        exitRefusal: { kind: 'device' }, kitUnsaved: true
    });
    assert.equal(legacy.exit, null);
    assert.deepEqual(legacy.payouts, { credited: 0, alerts: 0 });
    assert.deepEqual(legacy.setAside, { near: 0, earliestMustInitiateByMs: null, device: 0 });
});

// ---------------------------------------------------------------------------
// Payouts
// ---------------------------------------------------------------------------

test('own credits that were not claimed are counted, and so are payouts that exceeded their bound', () => {
    const state = derive({ snapshot: normalized('withdrawals_alert_credited_defeated') });
    // Two credited payouts are waiting (one with no known amount); the third was claimed.
    assert.deepEqual(state.payouts, { credited: 2, alerts: 1 });
    const none = derive({ snapshot: normalized('kit_never_exported') });
    assert.deepEqual(none.payouts, { credited: 0, alerts: 0 });
    // Hand-built input of the old shape (no such keys) says nothing.
    assert.deepEqual(derive({ snapshot: normalizedSnapshot() }).payouts, { credited: 0, alerts: 0 });
    // A malformed entry is not a payout.
    assert.deepEqual(
        derive({ snapshot: base({ ownCredits: [null, 7, { recordId: 'a' }], payoutAlerts: ['x'] }) }).payouts,
        { credited: 1, alerts: 1 }
    );
});

// ---------------------------------------------------------------------------
// The service
// ---------------------------------------------------------------------------

test('wiring:service-message a paused service is a phase with the SDK\'s code, and the words come from the code', () => {
    const expected = {
        service_missing: ['deployment_manifest_unavailable', 'service.paused.unreachable'],
        service_changed: ['deployment_manifest_mismatch', 'service.paused.changed'],
        service_legacy: ['incompatible_proof_circuit', 'service.paused.incompatible']
    };
    for (const [name, [code, key]] of Object.entries(expected)) {
        const state = derive({ table: TARGET_TABLE, active: TARGET_ROW, snapshot: normalized(name) });
        assert.equal(state.phase, 'service-paused', name);
        assert.equal(state.service.code, code, name);
        // The SDK's constant message is kept for callers and never shown.
        assert.match(state.service.message, /Withdrawals work, but/, name);
        assert.equal(versionCopyText('service.paused', copyTokens(state)), versionCopyText(key), name);
        assert.doesNotMatch(versionCopyText('service.paused', copyTokens(state)), /Withdrawals work, but|operator/, name);
        // Exits stay open: a pause is never a gate on withdrawing.
        assert.equal(state.upgrade.canStart, false, 'nothing to upgrade to on the target');
    }
    const healthy = derive({ table: TARGET_TABLE, active: TARGET_ROW, snapshot: normalized('kit_never_exported') });
    assert.equal(healthy.service, null);
    assert.notEqual(healthy.phase, 'service-paused');
});

test('wiring:service-message a refusal an attempt raised pauses the service although the snapshot reads as available', () => {
    const snapshot = normalized('kit_never_exported');
    assert.equal(snapshot.service.available, true);
    const latched = readServiceRefusal(Object.assign(new Error('x'), {
        status: 503, code: 'native_vault_unverified', data: { exits: true }
    }));
    const state = derive({ table: TARGET_TABLE, active: TARGET_ROW, snapshot, serviceRefusal: latched });
    assert.equal(state.phase, 'service-paused');
    assert.deepEqual(state.service, { message: '', code: 'native_vault_unverified' });
    assert.equal(
        versionCopyText('service.paused', copyTokens(state)),
        'We couldn’t confirm the payment contract with the network provider, so new chats and deposits are paused. '
        + 'You can still withdraw. Try again in a moment.'
    );
    // The refusal is the newer fact, so its code names the cause when the snapshot says another.
    const both = derive({
        table: TARGET_TABLE, active: TARGET_ROW, snapshot: normalized('service_missing'),
        serviceRefusal: { code: 'native_vault_unverified' }
    });
    assert.equal(both.service.code, 'native_vault_unverified');
    assert.match(both.service.message, /Withdrawals work, but/);
    // Not a machine word, or not a record: no pause.
    for (const serviceRefusal of [null, undefined, {}, { code: '' }, { code: 'Visit <b>x</b>' }, { code: 7 }, 'x']) {
        const read = derive({ table: TARGET_TABLE, active: TARGET_ROW, snapshot, serviceRefusal });
        assert.equal(read.service, null, JSON.stringify(serviceRefusal));
        assert.notEqual(read.phase, 'service-paused');
    }
    // Reload and the legacy-unreachable phase still outrank it (precedence unchanged).
    const reload = derive({
        table: TARGET_TABLE, active: TARGET_ROW, snapshot, serviceRefusal: latched,
        previewSelection: selectionFor(LEGACY_ROW, { reason: 'runtime_holds_note' })
    });
    assert.equal(reload.phase, 'reload-required');
    assert.equal(reload.service.code, 'native_vault_unverified');
});

// ---------------------------------------------------------------------------
// Giving up a balance
// ---------------------------------------------------------------------------

// A holder of a note-bound balance on the closed version, with somewhere to
// move it: the case the action is for.
function holder(expiryTs, overrides = {}) {
    return derive({
        table: TARGET_TABLE, active: LEGACY_ROW, adapter: LEGACY,
        snapshot: base({ hasNote: true, expiryTs, deadlines: [{ source: 'slot', expiryTs }] }),
        ...overrides
    });
}

const OFFER = { available: true, kind: 'dust', blockedBy: null };

test('giving up a balance: no verdict is no field, and a verdict is passed through', () => {
    const expiry = SECONDS + 20 * 86_400;
    assert.equal(holder(expiry).abandon, null);
    assert.equal(holder(expiry, { abandon: undefined }).abandon, null);
    for (const value of ['yes', 7, [], true]) assert.equal(holder(expiry, { abandon: value }).abandon, null, String(value));
    assert.deepEqual(holder(expiry, { abandon: OFFER }).abandon, OFFER);
    assert.deepEqual(holder(expiry, { abandon: { available: true, kind: 'zero', blockedBy: null } }).abandon,
        { available: true, kind: 'zero', blockedBy: null });
    // A refusal keeps its reason, as a machine word.
    assert.deepEqual(holder(expiry, { abandon: { available: false, kind: null, blockedBy: 'not_dust' } }).abandon,
        { available: false, kind: null, blockedBy: 'not_dust' });
    assert.deepEqual(holder(expiry, { abandon: { available: false, kind: 'dust', blockedBy: 'Not <b>dust</b>' } }).abandon,
        { available: false, kind: null, blockedBy: null });
    // Anything but a real `true` is not an offer.
    assert.equal(holder(expiry, { abandon: { available: 'true', kind: 'dust' } }).abandon.available, false);
    // An offer with no kind is not one the person can be told about.
    assert.deepEqual(holder(expiry, { abandon: { available: true, kind: 'big', blockedBy: null } }).abandon,
        { available: false, kind: null, blockedBy: 'unknown_state' });
});

test('giving up a balance stops the withdraw-by reminders for that note and no other', () => {
    // Close-by is expiry minus 72 h: this note is 2 days from its close-by.
    const expiry = SECONDS + 5 * 86_400;
    const chased = holder(expiry);
    assert.equal(chased.reminderTier, 3);
    assert.equal(chased.closeByTs, (expiry - 259200) * 1000);
    assert.equal(chased.phase, 'upgrade-soon');

    const offered = holder(expiry, { abandon: OFFER });
    assert.equal(offered.reminderTier, null);
    assert.equal(offered.closeByTs, null);
    // The upgrade is still available (withdrawing instead), at the neutral phase, never overdue.
    assert.equal(offered.phase, 'upgrade-available');
    assert.equal(offered.upgrade.available, true);
    assert.equal(offered.expiryTs, expiry * 1000);

    // Overdue becomes neutral too: this balance is not worth chasing.
    const overdue = holder(SECONDS + 2 * 86_400, { abandon: OFFER });
    assert.equal(overdue.phase, 'upgrade-available');
    assert.equal(holder(SECONDS + 2 * 86_400).phase, 'upgrade-overdue');

    // A verdict that says no changes nothing.
    const refused = holder(expiry, { abandon: { available: false, kind: null, blockedBy: 'not_dust' } });
    assert.equal(refused.reminderTier, 3);
    assert.equal(refused.phase, 'upgrade-soon');
});

test('giving up a balance never silences a set-aside note beside it, and is itself refused there', () => {
    const slot = SECONDS + 5 * 86_400;
    const aside = { source: 'set-aside', expiryTs: SECONDS + 6 * 86_400 };
    const withSetAside = holder(slot, {
        snapshot: base({ hasNote: true, expiryTs: slot, deadlines: [{ source: 'slot', expiryTs: slot }, aside] }),
        abandon: OFFER
    });
    // The offer is refused on the facts of this snapshot...
    assert.deepEqual(withSetAside.abandon, { available: false, kind: null, blockedBy: 'open_withdrawal' });
    // ...so the reminders are the ones there would be without it.
    const without = holder(slot, {
        snapshot: base({ hasNote: true, expiryTs: slot, deadlines: [{ source: 'slot', expiryTs: slot }, aside] })
    });
    assert.equal(withSetAside.reminderTier, without.reminderTier);
    assert.equal(withSetAside.closeByTs, without.closeByTs);
    assert.equal(withSetAside.phase, without.phase);
});

test('giving up a balance keeps the tiers of another version\'s set-aside record', () => {
    // v1 (note bound, exit-only) holds a dust note; v2 (also exit-only) has a
    // parked escape expiring soon. The note's own reminder gives way; the
    // other version's record keeps chasing.
    const closeBy = (SECONDS + 20 * 86_400);
    const other = { recordId: 'p', noteId: 3, mode: 'mutual', phase: 'parked', expiryTs: SECONDS + 5 * 86_400 };
    const input = {
        table: THREE, active: LEGACY_OF_THREE, adapter: LEGACY,
        snapshot: base({ hasNote: true, expiryTs: closeBy, deadlines: [{ source: 'slot', expiryTs: closeBy }] }),
        selection: selectionFor(LEGACY_OF_THREE, { open: { v2: [other] } })
    };
    const chased = derive(input);
    const offered = derive({ ...input, abandon: OFFER });
    assert.equal(chased.previous.versionId, 'v2');
    assert.equal(offered.previous.versionId, 'v2');
    assert.equal(offered.reminderTier, chased.reminderTier);
    assert.notEqual(offered.reminderTier, null);
    assert.equal(offered.closeByTs, (other.expiryTs - 259200) * 1000);
    assert.equal(offered.phase, 'finish-previous-withdrawal');
    // The note is still offered for clearing: the other holder's record is not this version's.
    assert.deepEqual(offered.abandon, OFFER);
});

test('giving up a balance is refused where the snapshot or the page contradicts the verdict', () => {
    const expiry = SECONDS + 20 * 86_400;
    const note = overrides => base({ hasNote: true, expiryTs: expiry, deadlines: [{ source: 'slot', expiryTs: expiry }], ...overrides });
    const cases = [
        ['open_withdrawal', { snapshot: note({ hasOpenWithdrawal: true }) }],
        ['open_withdrawal', { snapshot: note({ hasPreparedWithdrawal: true }) }],
        ['pending_deposit', { snapshot: note({ hasPendingDeposit: true }) }],
        ['pending_deposit', { snapshot: note({ hasUnsentPrepared: true }) }],
        ['exit_lock', { snapshot: note({ exit: exitOf({ lockHeld: true, lock: { mode: 'mutual', sinceMs: null, released: 0, proofsReleased: 0, releasableAfterMs: null } }) }) }],
        ['exit_lock', { snapshot: note({ exit: exitOf() }), exitRefusal: { kind: 'locked', untilMs: null } }],
        ['unresolved_request', { snapshot: note({ unresolvedRequests: 1 }) }],
        ['no_note', { snapshot: base() }],
        ['claimed', { claimed: true }],
        ['config_mismatch', { configBlock: true }],
        ['reload_required', { previewSelection: selectionFor(TARGET_ROW, { reason: 'runtime_holds_note' }) }]
    ];
    for (const [blockedBy, overrides] of cases) {
        const state = holder(expiry, { abandon: OFFER, ...overrides });
        assert.deepEqual(state.abandon, { available: false, kind: null, blockedBy }, JSON.stringify(Object.keys(overrides)));
    }
    // The target version has nothing to upgrade to, so nothing to give up for.
    const onTarget = derive({
        table: TARGET_TABLE, active: TARGET_ROW, adapter: CONCESSION,
        snapshot: base({ hasNote: true, expiryTs: expiry, deadlines: [{ source: 'slot', expiryTs: expiry }], exit: exitOf() }),
        abandon: OFFER
    });
    assert.deepEqual(onTarget.abandon, { available: false, kind: null, blockedBy: 'not_applicable' });
});

test('the fail-closed state carries none of the balance facts', () => {
    const state = deriveVersionState({ table: TARGET_TABLE, active: null, selection: null, abandon: OFFER, kitUnsaved: true });
    assert.equal(state.exit, null);
    assert.equal(state.abandon, null);
    assert.deepEqual(state.payouts, { credited: 0, alerts: 0 });
    assert.deepEqual(state.setAside, { near: 0, earliestMustInitiateByMs: null, device: 0 });
});

// ---------------------------------------------------------------------------
// What leaves the state
// ---------------------------------------------------------------------------

test('every scenario\'s state is plain data that carries no secret, address or raw field', () => {
    const refusals = [
        null,
        readExitRefusal(Object.assign(new Error('x'), { code: 'exit_locked', data: { releasable_after: SECONDS + 600 } }), GENERATED),
        readExitRefusal(Object.assign(new Error('x'), { code: 'ownership_proof_wait', data: { retry_after: 3 } }), GENERATED)
    ];
    for (const name of Object.keys(FIXTURE.scenarios)) {
        for (const exitRefusal of refusals) {
            const state = derive({ table: TARGET_TABLE, active: TARGET_ROW, snapshot: normalized(name), exitRefusal, kitUnsaved: true, abandon: OFFER });
            const text = JSON.stringify(state);
            assert.deepEqual(JSON.parse(text), state, name);
            assert.doesNotMatch(text, /SECRET|exit_rpc_url|https?:\/\/|0x[0-9a-fA-F]{8}/, name);
        }
    }
});

test('the state of a scenario is the same on every derivation and does not touch its input', () => {
    const snapshot = normalized('withdrawals_alert_credited_defeated');
    const before = JSON.stringify(snapshot);
    const input = { snapshot, exitRefusal: { kind: 'proof', untilMs: GENERATED + 4000, boundAtState: '5' }, abandon: OFFER };
    const first = derive(input);
    assert.deepEqual(derive(input), first);
    assert.equal(JSON.stringify(snapshot), before);
    assert.equal(Object.isFrozen(first), false);
});
