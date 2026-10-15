import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { getAdapter } from '../../chat/zkapi/versioning/adapters/index.mjs';
import { chooseZkapiVersion } from '../../chat/zkapi/versioning/versionLoader.mjs';
import { deriveVersionState } from '../../chat/zkapi/versioning/versionState.mjs';
import {
    NOW_MS,
    activatedRegistry,
    mutated,
    normalizedSnapshot,
    resolvedTable,
    rollbackRegistry,
    stuckEscapeNotice,
    threeVersionRegistry,
    validRegistry
} from './_registryFixtures.mjs';

const DAY = 86_400;
const NOW_S = Math.floor(NOW_MS / 1000);

// activatedRegistry(): v1 exit-only (the previous version), v2 active (target).
const TABLE = resolvedTable(activatedRegistry(), 'mainnet');
const [V1, V2] = TABLE;
const LEGACY = getAdapter('note-bound-v1');
const CONCESSION = getAdapter('concession-v1');

function selectionFor(version, overrides = {}) {
    return {
        version,
        reason: 'runtime_holds_note',
        slotOwner: version.id,
        open: {},
        credits: {},
        foreignDeploymentId: null,
        depositBlock: null,
        draftDiscarded: false,
        slotKind: 'note',
        ...overrides
    };
}

// A tab that loaded `version` for the note it holds.
function noteSnapshot(expiryTs, overrides = {}) {
    return normalizedSnapshot({
        hasNote: true,
        expiryTs,
        deadlines: [{ source: 'slot', expiryTs }],
        ...overrides
    });
}

function derive(overrides = {}) {
    const active = overrides.active || V1;
    const input = {
        table: TABLE,
        active,
        target: overrides.target === undefined ? TABLE.find(version => version.status === 'active') || null : overrides.target,
        selection: selectionFor(active),
        snapshot: normalizedSnapshot(),
        intent: null,
        previewSelection: null,
        now: NOW_MS,
        busy: false,
        admissionClosed: false,
        buildClosed: false,
        configBlock: false,
        unreachable: false,
        adapter: getAdapter(active.adapter),
        ...overrides
    };
    return deriveVersionState(input);
}

// A holder of a legacy note that expires `daysLeft` days from `now`, with the
// close-by (72 h earlier) `daysLeft - 3` days from now.
const holderExpiringIn = (seconds, overrides = {}) => derive({
    snapshot: noteSnapshot(NOW_S + seconds),
    ...overrides
});

const deepClone = value => JSON.parse(JSON.stringify(value));

// ---------------------------------------------------------------------------
// Shape
// ---------------------------------------------------------------------------

test('the state has exactly the documented shape', () => {
    const state = holderExpiringIn(20 * DAY);
    assert.deepEqual(Object.keys(state).sort(), [
        'abandon', 'closeByTs', 'current', 'deadlineSource', 'depositsOpen', 'exit', 'expiryTs', 'gate', 'held',
        'holding', 'notices', 'payouts', 'phase', 'previous', 'reload', 'reminderTier', 'service', 'setAside', 'show',
        'target', 'unsent', 'upgrade'
    ]);
    // `held` is the additive fact of a balance the page holds and cannot read:
    // null whenever the SDK started (or nothing is held).
    assert.equal(state.held, null);
    // `notices` is the additive field: operator text that took effect, [] when none did.
    assert.deepEqual(state.notices, []);
    // The balance facts are additive and say "nothing" for a protocol that reports none.
    assert.equal(state.exit, null);
    assert.equal(state.abandon, null);
    assert.deepEqual(state.payouts, { credited: 0, alerts: 0 });
    assert.deepEqual(state.setAside, { near: 0, earliestMustInitiateByMs: null, device: 0 });
    assert.deepEqual(state.current, { id: 'v1', label: 'Version 1', status: 'exit-only' });
    assert.deepEqual(state.target, { id: 'v2', label: 'Version 2' });
    assert.deepEqual(Object.keys(state.gate).sort(), ['canResume', 'canStart', 'code', 'successor']);
    assert.deepEqual(Object.keys(state.upgrade).sort(), ['available', 'blockedBy', 'canStart', 'stage']);
    assert.deepEqual(Object.keys(state.reload).sort(), ['canReload', 'reason', 'required', 'targetId']);
});

test('one live version shows nothing and behaves as a single-version build', () => {
    const single = resolvedTable(validRegistry(), 'mainnet');
    assert.equal(single.length, 1);
    const state = deriveVersionState({
        table: single,
        active: single[0],
        target: single[0],
        selection: selectionFor(single[0], { reason: 'single_version', slotOwner: null, slotKind: 'empty' }),
        snapshot: noteSnapshot(NOW_S + 5 * DAY),
        intent: null,
        previewSelection: null,
        now: NOW_MS,
        busy: false,
        admissionClosed: false,
        buildClosed: false,
        configBlock: false,
        unreachable: false,
        adapter: LEGACY
    });
    assert.equal(state.show, false);
    assert.equal(state.phase, 'current');
    assert.equal(state.holding, 'current');
    assert.equal(state.depositsOpen, true);
    assert.deepEqual(state.gate, { canStart: true, canResume: false, code: null, successor: null });
    assert.equal(state.upgrade.available, false);
    assert.equal(state.closeByTs, null);
    assert.equal(state.reminderTier, null);
});

test('two live versions show the pill; retiring one leaves nothing to compare', () => {
    assert.equal(derive().show, true);
    const retired = mutated(activatedRegistry(), registry => {
        const [v1] = registry.versions;
        for (const network of ['mainnet', 'sepolia']) {
            v1.networks[network].status = 'retired';
            v1.networks[network].retiredAt = '2027-01-01T00:00:00Z';
            v1.networks[network].tombstone = { deploymentId: 'zkapi-native-eth-mainnet-note-bound-v1-fresh-20260930', chainId: 1, vault: '0x4386FDbdA35D995beB3BF8625118Ec5982ec81fe' };
        }
    });
    const table = resolvedTable(retired, 'mainnet');
    assert.deepEqual(table.map(version => version.status), ['active', 'retired']);
    const state = deriveVersionState({
        table, active: table[0], target: table[0],
        selection: selectionFor(table[0], { reason: 'no_runtime_note', slotOwner: null, slotKind: 'empty' }),
        snapshot: normalizedSnapshot(), intent: null, previewSelection: null, now: NOW_MS, busy: false,
        admissionClosed: false, buildClosed: false, configBlock: false, unreachable: false, adapter: CONCESSION
    });
    assert.equal(state.show, false);
    assert.equal(state.gate.canStart, true);
});

// ---------------------------------------------------------------------------
// Close-by, tiers, prompt window
// ---------------------------------------------------------------------------

test('close-by is the earliest deadline minus the transition margin, in epoch ms', () => {
    const expiry = NOW_S + 20 * DAY;
    const state = holderExpiringIn(20 * DAY);
    assert.equal(state.expiryTs, expiry * 1000);
    assert.equal(state.closeByTs, expiry * 1000 - V1.transition.closeByMarginSeconds * 1000);
    assert.equal(state.closeByTs, (expiry - 3 * DAY) * 1000);
    assert.equal(state.deadlineSource, 'slot');
});

test('close-by follows the version policy, not a constant', () => {
    const custom = mutated(activatedRegistry(), registry => {
        registry.versions[0].transition = { closeByMarginSeconds: 86_400, reminderDays: [5, 2], promptWindowDays: 9 };
    });
    const table = resolvedTable(custom, 'mainnet');
    const state = deriveVersionState({
        table, active: table[0], target: table[1], selection: selectionFor(table[0]),
        snapshot: noteSnapshot(NOW_S + 10 * DAY), intent: null, previewSelection: null, now: NOW_MS, busy: false,
        admissionClosed: false, buildClosed: false, configBlock: false, unreachable: false, adapter: LEGACY
    });
    assert.equal(state.closeByTs, (NOW_S + 9 * DAY) * 1000);
    // 9 days to close-by is exactly the 9-day window: inside it.
    assert.equal(state.phase, 'upgrade-soon');
    assert.equal(state.reminderTier, null);
});

test('an adapter may override the close-by rule', () => {
    const adapter = { ...LEGACY, closeBy: expirySeconds => (expirySeconds - 10 * 3600) * 1000 };
    const state = holderExpiringIn(20 * DAY, { adapter });
    assert.equal(state.closeByTs, (NOW_S + 20 * DAY - 10 * 3600) * 1000);
});

test('reminder tiers: inclusive boundaries at 7, 3 and 1 days and 0 after close-by', () => {
    // seconds until close-by -> expected tier
    const expiryAfter = untilCloseBy => untilCloseBy + 3 * DAY;
    const at = untilCloseBy => holderExpiringIn(expiryAfter(untilCloseBy));
    assert.equal(at(7 * DAY + 1).reminderTier, null);
    assert.equal(at(7 * DAY).reminderTier, 7);
    assert.equal(at(5 * DAY).reminderTier, 7);
    assert.equal(at(3 * DAY + 1).reminderTier, 7);
    assert.equal(at(3 * DAY).reminderTier, 3);
    assert.equal(at(2 * DAY).reminderTier, 3);
    assert.equal(at(1 * DAY + 1).reminderTier, 3);
    assert.equal(at(1 * DAY).reminderTier, 1);
    assert.equal(at(1).reminderTier, 1);
    assert.equal(at(0).reminderTier, 0);
    assert.equal(at(-1).reminderTier, 0);
    assert.equal(at(-2 * DAY).reminderTier, 0);
});

test('the prompt window: neutral before it, amber and primary inside it', () => {
    const window = V1.transition.promptWindowDays * DAY;
    const phaseAt = untilCloseBy => holderExpiringIn(untilCloseBy + 3 * DAY).phase;
    assert.equal(phaseAt(window + 1), 'upgrade-available');
    assert.equal(phaseAt(window), 'upgrade-soon');
    assert.equal(phaseAt(8 * DAY), 'upgrade-soon');
    assert.equal(phaseAt(7 * DAY), 'upgrade-soon');
    assert.equal(phaseAt(1), 'upgrade-soon');
    assert.equal(phaseAt(0), 'upgrade-overdue');
    assert.equal(phaseAt(-DAY), 'upgrade-overdue');
});

test('the instant of the close-by is overdue, the instant before it is not', () => {
    const closeBy = (NOW_S + 5 * DAY) * 1000;
    const snapshot = noteSnapshot(NOW_S + 5 * DAY + 3 * DAY);
    const before = derive({ snapshot, now: closeBy - 1 });
    const exactly = derive({ snapshot, now: closeBy });
    assert.equal(before.phase, 'upgrade-soon');
    assert.equal(before.reminderTier, 1);
    assert.equal(exactly.phase, 'upgrade-overdue');
    assert.equal(exactly.reminderTier, 0);
});

test('a one-day note: close-by is already past, so it is overdue at once', () => {
    const table = resolvedTable(activatedRegistry(), 'sepolia');
    // A note deposited 2 hours ago with a one-day TTL.
    const expiry = NOW_S + 22 * 3600;
    const state = deriveVersionState({
        table, active: table[0], target: table[1], selection: selectionFor(table[0]),
        snapshot: noteSnapshot(expiry), intent: null, previewSelection: null, now: NOW_MS, busy: false,
        admissionClosed: false, buildClosed: false, configBlock: false, unreachable: false, adapter: LEGACY
    });
    assert.ok(state.closeByTs < NOW_MS);
    assert.equal(state.reminderTier, 0);
    assert.equal(state.phase, 'upgrade-overdue');
    assert.equal(state.upgrade.canStart, true);
    // Once expired it is the existing expired state, not an upgrade prompt.
    const expired = deriveVersionState({
        table, active: table[0], target: table[1], selection: selectionFor(table[0]),
        snapshot: noteSnapshot(expiry), intent: null, previewSelection: null, now: expiry * 1000, busy: false,
        admissionClosed: false, buildClosed: false, configBlock: false, unreachable: false, adapter: LEGACY
    });
    assert.equal(expired.phase, 'expired');
    assert.equal(expired.reminderTier, null);
    assert.equal(expired.upgrade.blockedBy, 'expired');
    assert.equal(expired.upgrade.canStart, false);
});

test('a confirmed expiry claim is the existing claimed state, and the upgrade cannot start', () => {
    const state = derive({
        snapshot: noteSnapshot(NOW_S - 100), claimed: true
    });
    assert.equal(state.phase, 'expired');
    assert.equal(state.upgrade.blockedBy, 'claimed');
    assert.equal(state.upgrade.canStart, false);
    assert.equal(state.upgrade.stage, 'blocked');
    // Only an explicit true counts.
    assert.equal(derive({ snapshot: noteSnapshot(NOW_S + 20 * DAY), claimed: 'yes' }).upgrade.blockedBy, null);
});

test('an empty balance is never prompted', () => {
    for (const snapshot of [
        normalizedSnapshot(),
        normalizedSnapshot({ hasNote: false, expiryTs: NOW_S + 2 * DAY }),
        normalizedSnapshot({ hasPendingDeposit: false })
    ]) {
        const state = derive({ snapshot });
        assert.equal(state.phase, 'current');
        assert.equal(state.holding, 'none');
        assert.equal(state.upgrade.available, false);
        assert.equal(state.upgrade.canStart, false);
        assert.equal(state.upgrade.stage, 'idle');
        assert.equal(state.closeByTs, null);
        assert.equal(state.reminderTier, null);
    }
});

test('an omitted target is read from the table; an explicit null means there is none', () => {
    const input = {
        table: TABLE, active: V1, selection: selectionFor(V1), snapshot: noteSnapshot(NOW_S + 20 * DAY),
        intent: null, previewSelection: null, now: NOW_MS, busy: false, admissionClosed: false, buildClosed: false,
        configBlock: false, unreachable: false, adapter: LEGACY
    };
    const omitted = deriveVersionState(input);
    assert.deepEqual(omitted.target, { id: 'v2', label: 'Version 2' });
    assert.equal(omitted.upgrade.available, true);
    const none = deriveVersionState({ ...input, target: null });
    assert.equal(none.target, null);
    assert.equal(none.upgrade.available, false);
    // The live version is its own target even if the caller forgot to say so.
    const live = deriveVersionState({ ...input, active: V2, selection: selectionFor(V2), adapter: CONCESSION, target: null });
    assert.deepEqual(live.target, { id: 'v2', label: 'Version 2' });
    assert.equal(live.gate.canStart, true);
});

test('the nudge exists only on a version that no longer takes deposits and only with somewhere to go', () => {
    // On the deposit target: nothing to upgrade, so no close-by or tier either.
    const onTarget = derive({
        active: V2, target: V2, selection: selectionFor(V2), snapshot: noteSnapshot(NOW_S + 2 * DAY), adapter: CONCESSION
    });
    assert.equal(onTarget.phase, 'current');
    assert.equal(onTarget.upgrade.available, false);
    assert.equal(onTarget.closeByTs, null);
    assert.equal(onTarget.reminderTier, null);
    assert.equal(onTarget.expiryTs, (NOW_S + 2 * DAY) * 1000);
    assert.equal(onTarget.holding, 'current');
    // No successor at all (deposits unavailable): exit-only version, no nudge.
    const noTarget = derive({ target: null, snapshot: noteSnapshot(NOW_S + 2 * DAY) });
    assert.equal(noTarget.phase, 'current');
    assert.equal(noTarget.upgrade.available, false);
    assert.equal(noTarget.target, null);
    assert.equal(noTarget.holding, 'current');
    assert.equal(noTarget.gate.successor, null);
    assert.equal(noTarget.gate.code, 'deposits_closed');
});

// ---------------------------------------------------------------------------
// Per-note deadlines
// ---------------------------------------------------------------------------

test('a holder with only a set-aside note is told to finish it, with its own deadline and tiers', () => {
    const expiry = NOW_S + 5 * DAY; // close-by in 2 days
    const state = derive({
        snapshot: normalizedSnapshot({
            hasNote: false,
            hasOpenWithdrawal: true,
            deadlines: [{ source: 'set-aside', expiryTs: expiry }]
        })
    });
    assert.equal(state.phase, 'finish-previous-withdrawal');
    assert.equal(state.deadlineSource, 'set-aside');
    assert.equal(state.expiryTs, expiry * 1000);
    assert.equal(state.closeByTs, (expiry - 3 * DAY) * 1000);
    assert.equal(state.reminderTier, 3);
    assert.deepEqual(state.previous, {
        versionId: 'v1', openWithdrawals: 1, credits: 0, canOpen: false, closeByTs: (expiry - 3 * DAY) * 1000
    });
    assert.equal(state.holding, 'previous');
    assert.equal(state.upgrade.available, true);
    assert.equal(state.upgrade.canStart, false);
    assert.equal(state.upgrade.blockedBy, 'open_withdrawal');
    assert.equal(state.upgrade.stage, 'blocked');
});

test('the earliest deadline among the slot note and set-aside notes drives the reminder', () => {
    const slot = NOW_S + 30 * DAY;
    const setAside = NOW_S + 5 * DAY;
    const state = derive({
        snapshot: normalizedSnapshot({
            hasNote: true,
            expiryTs: slot,
            hasOpenWithdrawal: true, // the parked record
            deadlines: [{ source: 'slot', expiryTs: slot }, { source: 'set-aside', expiryTs: setAside }]
        })
    });
    assert.equal(state.deadlineSource, 'set-aside');
    assert.equal(state.expiryTs, setAside * 1000);
    assert.equal(state.closeByTs, (setAside - 3 * DAY) * 1000);
    assert.equal(state.reminderTier, 3);
    // A parked record next to the slot note is not a withdrawal in motion.
    assert.equal(state.phase, 'upgrade-soon');
    assert.equal(state.upgrade.canStart, true);
    // And the slot note drives when it is the earlier one.
    const slotFirst = derive({
        snapshot: normalizedSnapshot({
            hasNote: true, expiryTs: setAside, hasOpenWithdrawal: true,
            deadlines: [{ source: 'slot', expiryTs: setAside }, { source: 'set-aside', expiryTs: slot }]
        })
    });
    assert.equal(slotFirst.deadlineSource, 'slot');
});

test('an expired set-aside note stops driving reminders for a note that is still alive', () => {
    const slot = NOW_S + 20 * DAY;
    const state = derive({
        snapshot: normalizedSnapshot({
            hasNote: true, expiryTs: slot, hasOpenWithdrawal: true,
            deadlines: [{ source: 'slot', expiryTs: slot }, { source: 'set-aside', expiryTs: NOW_S - DAY }]
        })
    });
    assert.equal(state.deadlineSource, 'slot');
    assert.equal(state.expiryTs, slot * 1000);
    assert.notEqual(state.phase, 'expired');
});

test('an expired slot note next to a live set-aside note still reminds about the live one, but cannot start', () => {
    const state = derive({
        snapshot: normalizedSnapshot({
            hasNote: true, expiryTs: NOW_S - 100, hasOpenWithdrawal: true,
            deadlines: [{ source: 'slot', expiryTs: NOW_S - 100 }, { source: 'set-aside', expiryTs: NOW_S + 4 * DAY }]
        })
    });
    assert.equal(state.deadlineSource, 'set-aside');
    assert.equal(state.upgrade.blockedBy, 'expired');
    assert.equal(state.upgrade.canStart, false);
});

test('a snapshot with a note and an expiry but no deadline list still yields the slot deadline', () => {
    const state = derive({ snapshot: normalizedSnapshot({ hasNote: true, expiryTs: NOW_S + 10 * DAY, deadlines: [] }) });
    assert.equal(state.deadlineSource, 'slot');
    assert.equal(state.closeByTs, (NOW_S + 7 * DAY) * 1000);
});

test('a note whose expiry is unknown is held but has no close-by to remind about', () => {
    const state = derive({ snapshot: normalizedSnapshot({ hasNote: true, expiryTs: null, deadlines: [] }) });
    assert.equal(state.holding, 'previous');
    assert.equal(state.upgrade.available, true);
    assert.equal(state.phase, 'upgrade-available');
    assert.equal(state.closeByTs, null);
    assert.equal(state.reminderTier, null);
    assert.equal(state.expiryTs, null);
});

test('set-aside deadlines of another version drive the reminder in the target build', () => {
    const expiry = NOW_S + 4 * DAY;
    const state = derive({
        active: V2,
        target: V2,
        selection: selectionFor(V2, {
            reason: 'no_runtime_note',
            slotOwner: null,
            slotKind: 'empty',
            open: { v1: [{ recordId: 'r1', noteId: 3, mode: 'mutual', phase: 'parked', expiryTs: expiry }] }
        }),
        snapshot: normalizedSnapshot(),
        adapter: CONCESSION
    });
    assert.equal(state.phase, 'finish-previous-withdrawal');
    assert.equal(state.deadlineSource, 'set-aside');
    // The exiting version's own margin applies to its own notes.
    assert.equal(state.closeByTs, (expiry - 3 * DAY) * 1000);
    assert.equal(state.reminderTier, 1);
    assert.deepEqual(state.previous, {
        versionId: 'v1', openWithdrawals: 1, credits: 0, canOpen: true, closeByTs: (expiry - 3 * DAY) * 1000
    });
    assert.equal(state.gate.code, 'previous_withdrawal_open');
    assert.equal(state.gate.canStart, false);
});

// ---------------------------------------------------------------------------
// Phase precedence
// ---------------------------------------------------------------------------

test('phase precedence, from reload-required down to current', () => {
    const preview = {
        ...selectionFor(V2, { reason: 'runtime_holds_note', slotOwner: 'v2' }),
        version: V2
    };
    // Every condition at once: the first in the order wins; removing it
    // exposes the next.
    const all = {
        previewSelection: preview,
        unreachable: true,
        admissionClosed: true,
        selection: selectionFor(V1, {
            reason: 'requested_previous',
            slotOwner: null,
            credits: { v2: [{ recordId: 'c1', noteId: 9 }] }
        }),
        snapshot: normalizedSnapshot({
            hasNote: true,
            expiryTs: NOW_S - 10,
            deadlines: [{ source: 'slot', expiryTs: NOW_S - 10 }],
            hasPreparedWithdrawal: true,
            service: { available: false, message: 'Paused.' },
            otherDeploymentWithdrawals: [{ deploymentId: V2.deploymentId, recordId: 'w1', noteId: 4, mode: 'mutual', phase: 'parked' }]
        })
    };
    const order = [
        ['reload-required', {}],
        ['legacy-unreachable', { previewSelection: null }],
        ['service-paused', { unreachable: false }],
        ['admission-closed', { snapshotService: false }],
        ['finish-previous-withdrawal', { admissionClosed: false }],
        ['claim-previous-credit', { snapshotOther: false }],
        ['withdrawing', { snapshotCredits: false }],
        ['expired', { snapshotPrepared: false }]
    ];
    const current = { ...all };
    const snapshot = { ...all.snapshot };
    const apply = change => {
        if (change.previewSelection === null) current.previewSelection = null;
        if (change.unreachable === false) current.unreachable = false;
        if (change.snapshotService === false) snapshot.service = null;
        if (change.admissionClosed === false) current.admissionClosed = false;
        if (change.snapshotOther === false) snapshot.otherDeploymentWithdrawals = [];
        if (change.snapshotCredits === false) current.selection = { ...current.selection, credits: {} };
        if (change.snapshotPrepared === false) snapshot.hasPreparedWithdrawal = false;
    };
    // A loaded v1 with a credit on v2 and an open withdrawal on v2 is not a
    // real combination, but each rung of the order must hold on its own.
    for (const [phase, change] of order) {
        apply(change);
        const state = derive({ ...current, snapshot, active: V1, adapter: LEGACY });
        assert.equal(state.phase, phase, `expected ${phase}`);
    }
    // And once the note is not expired the nudge appears.
    snapshot.expiryTs = NOW_S + 3 * DAY;
    snapshot.deadlines = [{ source: 'slot', expiryTs: NOW_S + 3 * DAY }];
    assert.equal(derive({ ...current, snapshot, active: V1, adapter: LEGACY }).phase, 'upgrade-overdue');
    // Nothing held: current.
    assert.equal(derive({ ...current, snapshot: normalizedSnapshot(), active: V1, adapter: LEGACY }).phase, 'current');
});

test('finish-previous-withdrawal outranks claim-previous-credit on one version', () => {
    const state = derive({
        active: V2, target: V2, adapter: CONCESSION,
        selection: selectionFor(V2, {
            reason: 'no_runtime_note', slotOwner: null, slotKind: 'empty',
            open: { v1: [{ recordId: 'r1', noteId: 3, mode: 'escape', phase: 'pending', expiryTs: null }] },
            credits: { v1: [{ recordId: 'c1', noteId: 3, destination: null }] }
        })
    });
    assert.equal(state.phase, 'finish-previous-withdrawal');
    assert.equal(state.previous.openWithdrawals, 1);
    assert.equal(state.previous.credits, 1);
});

test('unclaimed credits raise claim-previous-credit and never block deposits', () => {
    const state = derive({
        active: V2, target: V2, adapter: CONCESSION,
        selection: selectionFor(V2, {
            reason: 'no_runtime_note', slotOwner: null, slotKind: 'empty',
            credits: { v1: [{ recordId: 'c1', noteId: 3, destination: '0x1' }] }
        })
    });
    assert.equal(state.phase, 'claim-previous-credit');
    assert.equal(state.gate.canStart, true);
    assert.equal(state.gate.code, null);
    assert.deepEqual(state.previous, { versionId: 'v1', openWithdrawals: 0, credits: 1, canOpen: true, closeByTs: null });
});

test('a withdrawal in motion is its own phase; set-aside records alone are not', () => {
    const prepared = holderExpiringIn(20 * DAY, { snapshot: noteSnapshot(NOW_S + 20 * DAY, { hasPreparedWithdrawal: true }) });
    assert.equal(prepared.phase, 'withdrawing');
    assert.equal(prepared.upgrade.blockedBy, 'open_withdrawal');
    assert.equal(prepared.upgrade.canStart, false);
    const open = holderExpiringIn(20 * DAY, { snapshot: noteSnapshot(NOW_S + 20 * DAY, { hasOpenWithdrawal: true }) });
    assert.equal(open.phase, 'withdrawing');
    assert.equal(open.holding, 'previous');
});

test('service-paused and admission-closed come from facts, not from the nudge', () => {
    const paused = holderExpiringIn(20 * DAY, {
        snapshot: noteSnapshot(NOW_S + 20 * DAY, { service: { available: false, message: 'Back at noon.' } })
    });
    assert.equal(paused.phase, 'service-paused');
    // The SDK's message is kept for callers; the words come from the code.
    assert.deepEqual(paused.service, { message: 'Back at noon.', code: null });
    const coded = holderExpiringIn(20 * DAY, {
        snapshot: noteSnapshot(NOW_S + 20 * DAY, {
            service: { available: false, code: 'deployment_manifest_mismatch', message: 'Back at noon.' }
        })
    });
    assert.deepEqual(coded.service, { message: 'Back at noon.', code: 'deployment_manifest_mismatch' });
    // A code that is not a machine word is no code at all.
    const hostile = holderExpiringIn(20 * DAY, {
        snapshot: noteSnapshot(NOW_S + 20 * DAY, { service: { available: false, code: 'Visit <b>evil</b>', message: '' } })
    });
    assert.deepEqual(hostile.service, { message: '', code: null });
    const available = holderExpiringIn(20 * DAY, {
        snapshot: noteSnapshot(NOW_S + 20 * DAY, { service: { available: true, message: 'Note.' } })
    });
    assert.equal(available.service, null);
    assert.notEqual(available.phase, 'service-paused');
    const closed = holderExpiringIn(20 * DAY, { admissionClosed: true });
    assert.equal(closed.phase, 'admission-closed');
    // Withdrawing stays possible while admission is closed.
    assert.equal(closed.upgrade.canStart, true);
});

test('legacy-unreachable needs the "open previous version" load, not any failure', () => {
    const requested = derive({ unreachable: true, selection: selectionFor(V1, { reason: 'requested_previous', slotOwner: null }) });
    assert.equal(requested.phase, 'legacy-unreachable');
    const ordinary = derive({ unreachable: true, selection: selectionFor(V1) });
    assert.notEqual(ordinary.phase, 'legacy-unreachable');
});

// ---------------------------------------------------------------------------
// Reload
// ---------------------------------------------------------------------------

test('reload is required only when a fresh preview picks another version', () => {
    const same = derive({
        snapshot: noteSnapshot(NOW_S + 5 * DAY),
        previewSelection: selectionFor(V1)
    });
    assert.equal(same.reload.required, false);
    assert.equal(same.reload.targetId, null);
    assert.equal(same.reload.reason, null);
    assert.equal(same.reload.canReload, true);

    const none = derive({ snapshot: noteSnapshot(NOW_S + 5 * DAY), previewSelection: null });
    assert.equal(none.reload.required, false);
    assert.equal(none.phase.startsWith('upgrade'), true);

    const moved = derive({
        snapshot: noteSnapshot(NOW_S + 5 * DAY),
        previewSelection: selectionFor(V2, { reason: 'runtime_holds_note' })
    });
    assert.equal(moved.reload.required, true);
    assert.equal(moved.reload.targetId, 'v2');
    assert.equal(moved.reload.reason, 'moved_in_other_tab');
    assert.equal(moved.phase, 'reload-required');
    assert.equal(moved.upgrade.canStart, false);
});

test('a preview that is only a version is read as a version', () => {
    const state = derive({ snapshot: noteSnapshot(NOW_S + 5 * DAY), previewSelection: { version: V2 } });
    assert.equal(state.reload.required, true);
    assert.equal(state.reload.targetId, 'v2');
    assert.equal(derive({ snapshot: noteSnapshot(NOW_S + 5 * DAY), previewSelection: { version: V1 } }).reload.required, false);
    // A selection with only the facts the state needs still lets the previous
    // version be opened.
    const bare = derive({
        active: V2, target: V2, adapter: CONCESSION,
        selection: { version: V2, open: { v1: [{ recordId: 'r', noteId: 1, mode: 'mutual', phase: 'parked', expiryTs: null }] } }
    });
    assert.equal(bare.previous.canOpen, true);
    assert.equal(bare.gate.code, 'previous_withdrawal_open');
});

test('a failed or foreign preview is not a reason to reload', () => {
    const base = { snapshot: noteSnapshot(NOW_S + 5 * DAY) };
    const unreadable = derive({
        ...base,
        previewSelection: selectionFor(V2, { reason: 'holdings_unreadable', slotOwner: null, depositBlock: 'holdings_unreadable' })
    });
    assert.equal(unreadable.reload.required, false);
    for (const reason of ['unknown_deployment', 'retired_deployment']) {
        const foreign = derive({
            ...base,
            previewSelection: selectionFor(V2, { reason, slotOwner: null, foreignDeploymentId: 'other', depositBlock: 'foreign_runtime' })
        });
        assert.equal(foreign.reload.required, false, reason);
        assert.equal(foreign.gate.code, 'foreign_runtime', reason);
    }
});

test('reload is gated by busy', () => {
    const state = derive({
        busy: true,
        snapshot: noteSnapshot(NOW_S + 5 * DAY),
        previewSelection: selectionFor(V2, { reason: 'runtime_holds_note' })
    });
    assert.equal(state.reload.required, true);
    assert.equal(state.reload.canReload, false);
});

test('reload reasons: upgrade intent, a finished withdrawal, a cleared draft', () => {
    const emptyPreview = selectionFor(V2, { reason: 'no_runtime_note', slotOwner: null, slotKind: 'empty' });
    const intent = { v: 1, network: 'mainnet', from: 'v1', to: 'v2', stage: 'withdrawn', since: NOW_MS - 1000 };
    const upgraded = derive({ snapshot: normalizedSnapshot(), previewSelection: emptyPreview, intent });
    assert.equal(upgraded.reload.required, true);
    assert.equal(upgraded.reload.reason, 'upgrade_withdrawn');
    assert.equal(upgraded.reload.targetId, 'v2');
    assert.equal(upgraded.upgrade.stage, 'ready_to_switch');
    // `depositing` is past the withdrawal as well.
    const depositing = derive({
        snapshot: normalizedSnapshot(), previewSelection: emptyPreview, intent: { ...intent, stage: 'depositing' }
    });
    assert.equal(depositing.reload.reason, 'upgrade_withdrawn');

    const finished = derive({ snapshot: normalizedSnapshot(), previewSelection: emptyPreview });
    assert.equal(finished.reload.reason, 'previous_withdrawal_finished');

    const cleared = derive({
        snapshot: normalizedSnapshot(),
        selection: selectionFor(V1, { slotKind: 'draft_only' }),
        previewSelection: emptyPreview
    });
    assert.equal(cleared.reload.reason, 'draft_cleared');
});

test('a bare withdrawing intent is not proof of a withdrawal: the reload reason is the neutral one', () => {
    // The stage beginUpgrade() writes when the person merely opens the review
    // step. The balance later leaves the wallet WITHOUT a withdrawal (it
    // expired and the treasury claimed it, or it was archived): "Your balance
    // is back in your wallet" would be false.
    const emptyPreview = selectionFor(V2, { reason: 'no_runtime_note', slotOwner: null, slotKind: 'empty' });
    const bare = { v: 1, network: 'mainnet', from: 'v1', to: 'v2', stage: 'withdrawing', since: NOW_MS - 1000 };
    const state = derive({ snapshot: normalizedSnapshot(), previewSelection: emptyPreview, intent: bare });
    assert.equal(state.reload.required, true);
    assert.equal(state.reload.reason, 'previous_withdrawal_finished');
    assert.equal(state.reload.targetId, 'v2');
    // Everything else about the situation is the same as with proof.
    assert.equal(state.upgrade.stage, 'ready_to_switch');
    assert.equal(state.phase, 'reload-required');
    // An intent for another pair of versions never proves this one's.
    for (const stage of ['withdrawn', 'depositing']) {
        const other = derive({
            snapshot: normalizedSnapshot(), previewSelection: emptyPreview,
            intent: { ...bare, stage, from: 'v0', to: 'v2' }
        });
        assert.equal(other.reload.reason, 'previous_withdrawal_finished', stage);
        const wrongTarget = derive({
            snapshot: normalizedSnapshot(), previewSelection: emptyPreview,
            intent: { ...bare, stage, to: 'v3' }
        });
        assert.equal(wrongTarget.reload.reason, 'previous_withdrawal_finished', stage);
    }
});

test('moved_in_other_tab needs a fresh read that found the note held elsewhere, not this tab\'s own hasNote', () => {
    const held = noteSnapshot(NOW_S + 5 * DAY);
    // The wallet database is empty now (the note was withdrawn or forfeited
    // elsewhere): nothing "moved to" anywhere.
    const emptyPreview = selectionFor(V2, { reason: 'no_runtime_note', slotOwner: null, slotKind: 'empty' });
    const gone = derive({ snapshot: held, previewSelection: emptyPreview });
    assert.equal(gone.reload.required, true);
    assert.equal(gone.reload.reason, 'previous_withdrawal_finished');
    // A hand-built preview that is only a version is no evidence either.
    const bare = derive({ snapshot: held, previewSelection: { version: V2 } });
    assert.equal(bare.reload.reason, 'previous_withdrawal_finished');
    // The fresh read that does find the runtime note elsewhere is the evidence.
    const moved = derive({ snapshot: held, previewSelection: selectionFor(V2, { reason: 'runtime_holds_note' }) });
    assert.equal(moved.reload.reason, 'moved_in_other_tab');
    // And it is not hidden by a bare intent for the same pair.
    const intent = { v: 1, network: 'mainnet', from: 'v1', to: 'v2', stage: 'withdrawing', since: NOW_MS - 1000 };
    const withBare = derive({ snapshot: held, previewSelection: selectionFor(V2, { reason: 'runtime_holds_note' }), intent });
    assert.equal(withBare.reload.reason, 'moved_in_other_tab');
});

test('a tab that was opened to finish a withdrawal is not told to reload away from it', () => {
    // v1 was loaded to finish an open withdrawal. A fresh load with no hint
    // would pick v2, so a naive preview diff would say "reload" forever.
    const preview = selectionFor(V2, {
        reason: 'no_runtime_note', slotOwner: null, slotKind: 'empty',
        open: { v1: [{ recordId: 'r1', noteId: 5, mode: 'escape', phase: 'pending', expiryTs: null }] }
    });
    const waiting = derive({
        selection: selectionFor(V1, { reason: 'requested_previous', slotOwner: null, slotKind: 'empty' }),
        snapshot: normalizedSnapshot({ hasOpenWithdrawal: true }),
        previewSelection: preview
    });
    assert.equal(waiting.reload.required, false);
    assert.equal(waiting.phase, 'withdrawing');
    // The same from the SDK's own view when the probe has not caught up.
    const sdkOnly = derive({
        snapshot: normalizedSnapshot({ hasOpenWithdrawal: true }),
        previewSelection: selectionFor(V2, { reason: 'no_runtime_note', slotOwner: null, slotKind: 'empty' })
    });
    assert.equal(sdkOnly.reload.required, false);
    // Credits waiting to be claimed here count the same way.
    const credit = derive({
        selection: selectionFor(V1, { reason: 'requested_previous', slotOwner: null, slotKind: 'empty' }),
        snapshot: normalizedSnapshot(),
        previewSelection: selectionFor(V2, {
            reason: 'no_runtime_note', slotOwner: null, slotKind: 'empty',
            credits: { v1: [{ recordId: 'c', noteId: 1, destination: null }] }
        })
    });
    assert.equal(credit.reload.required, false);
    // Once nothing is left open here, the reload becomes required.
    const done = derive({
        selection: selectionFor(V1, { reason: 'requested_previous', slotOwner: null, slotKind: 'empty' }),
        snapshot: normalizedSnapshot(),
        previewSelection: selectionFor(V2, { reason: 'no_runtime_note', slotOwner: null, slotKind: 'empty' })
    });
    assert.equal(done.reload.required, true);
    assert.equal(done.reload.reason, 'previous_withdrawal_finished');
    // But a slot another version now owns is required whatever is open here.
    const taken = derive({
        snapshot: normalizedSnapshot({ hasOpenWithdrawal: true }),
        previewSelection: selectionFor(V2, { reason: 'runtime_holds_note', slotOwner: 'v2' })
    });
    assert.equal(taken.reload.required, true);
});

// ---------------------------------------------------------------------------
// Deposit gate
// ---------------------------------------------------------------------------

test('gate: the live target can start; an exit-only version cannot and names its successor', () => {
    const live = derive({ active: V2, target: V2, selection: selectionFor(V2), adapter: CONCESSION });
    assert.deepEqual(live.gate, { canStart: true, canResume: false, code: null, successor: null });
    assert.equal(live.depositsOpen, true);
    const closed = derive();
    assert.equal(closed.gate.canStart, false);
    assert.equal(closed.gate.code, 'deposits_closed');
    assert.deepEqual(closed.gate.successor, { id: 'v2', label: 'Version 2' });
    assert.equal(closed.depositsOpen, false);
});

test('gate: the SDK saying deposits are closed closes them on an active version', () => {
    const state = derive({
        active: V2, target: V2, selection: selectionFor(V2), adapter: CONCESSION,
        snapshot: normalizedSnapshot({ sdkDepositsClosed: true })
    });
    assert.equal(state.gate.code, 'deposits_closed');
    assert.equal(state.depositsOpen, false);
    // successor is only for a version that is not the target.
    assert.equal(state.gate.successor, null);
});

test('gate: a tab told its balance moved in another tab cannot start a deposit until it reloads', () => {
    // A tab on the deposit target with nothing in it.
    const emptyTarget = {
        active: V2, target: V2, adapter: CONCESSION,
        selection: selectionFor(V2, { reason: 'no_runtime_note', slotOwner: null, slotKind: 'empty' })
    };
    const open = derive(emptyTarget);
    assert.equal(open.gate.canStart, true);
    assert.equal(open.gate.code, null);
    assert.equal(open.reload.required, false);

    // A fresh read finds the balance held by the closed version: another tab
    // moved it. Chat is not touched; a new deposit is.
    const movedPreview = selectionFor(V1, { reason: 'runtime_holds_note' });
    const moved = derive({ ...emptyTarget, previewSelection: movedPreview });
    assert.equal(moved.reload.required, true);
    assert.equal(moved.reload.reason, 'moved_in_other_tab');
    assert.equal(moved.phase, 'reload-required');
    assert.deepEqual(moved.gate, { canStart: false, canResume: false, code: 'reload_required', successor: null });

    // A deposit that already started stays finishable: restrict-only.
    const resumable = derive({
        ...emptyTarget, previewSelection: movedPreview,
        snapshot: normalizedSnapshot({ hasPendingDeposit: true })
    });
    assert.equal(resumable.gate.canResume, true);
    assert.equal(resumable.gate.canStart, false);
    assert.equal(resumable.gate.code, 'reload_required');

    // It never reopens anything and never replaces a more specific code.
    const open1 = [{ recordId: 'r1', noteId: 3, mode: 'mutual', phase: 'parked', expiryTs: NOW_S + DAY }];
    assert.equal(derive({ ...emptyTarget, previewSelection: movedPreview, buildClosed: true }).gate.code, 'stale_build');
    assert.equal(derive({ ...emptyTarget, previewSelection: movedPreview, configBlock: true }).gate.code, 'config_mismatch');
    assert.equal(derive({
        ...emptyTarget, previewSelection: selectionFor(V1, { reason: 'runtime_holds_note', open: { v1: open1 } })
    }).gate.code, 'previous_withdrawal_open');
    // The closed version's own tab already says "deposits closed".
    assert.equal(derive({
        previewSelection: selectionFor(V2, { reason: 'runtime_holds_note' }),
        snapshot: noteSnapshot(NOW_S + 5 * DAY)
    }).gate.code, 'deposits_closed');

    // Cleared by the reload itself: a read that finds nothing to move.
    const settled = derive({
        ...emptyTarget,
        previewSelection: selectionFor(V2, { reason: 'no_runtime_note', slotOwner: null, slotKind: 'empty' })
    });
    assert.equal(settled.reload.required, false);
    assert.equal(settled.gate.canStart, true);
    // The state's own input is not mutated.
    const input = deepClone(movedPreview);
    derive({ ...emptyTarget, previewSelection: movedPreview });
    assert.deepEqual(movedPreview, input);
});

test('gate code precedence', () => {
    const open = [{ recordId: 'r1', noteId: 3, mode: 'mutual', phase: 'parked', expiryTs: NOW_S + DAY }];
    const everything = {
        active: V2,
        target: V2,
        adapter: CONCESSION,
        selection: selectionFor(V2, {
            reason: 'unknown_deployment', slotOwner: null, foreignDeploymentId: 'x', depositBlock: 'foreign_runtime',
            open: { v1: open }
        }),
        configBlock: true,
        buildClosed: true,
        snapshot: normalizedSnapshot({ sdkDepositsClosed: true })
    };
    assert.equal(derive(everything).gate.code, 'foreign_runtime');
    everything.selection = selectionFor(V2, {
        reason: 'holdings_unreadable', slotOwner: null, depositBlock: 'holdings_unreadable', open: { v1: open }
    });
    assert.equal(derive(everything).gate.code, 'holdings_unreadable');
    everything.selection = selectionFor(V2, { reason: 'no_runtime_note', slotOwner: null, open: { v1: open } });
    assert.equal(derive(everything).gate.code, 'config_mismatch');
    everything.configBlock = false;
    assert.equal(derive(everything).gate.code, 'stale_build');
    everything.buildClosed = false;
    assert.equal(derive(everything).gate.code, 'deposits_closed');
    everything.snapshot = normalizedSnapshot();
    assert.equal(derive(everything).gate.code, 'previous_withdrawal_open');
    everything.selection = selectionFor(V2, { reason: 'no_runtime_note', slotOwner: null });
    assert.equal(derive(everything).gate.code, null);
});

test('gate: the loader reason alone closes deposits even if its block was lost', () => {
    for (const [reason, code] of [['holdings_unreadable', 'holdings_unreadable'], ['retired_deployment', 'foreign_runtime'], ['unknown_deployment', 'foreign_runtime']]) {
        const state = derive({
            active: V2, target: V2, adapter: CONCESSION,
            selection: selectionFor(V2, { reason, slotOwner: null, depositBlock: null })
        });
        assert.equal(state.gate.canStart, false, reason);
        assert.equal(state.gate.code, code, reason);
    }
    const unknown = derive({
        active: V2, target: V2, adapter: CONCESSION,
        selection: selectionFor(V2, { reason: 'no_runtime_note', slotOwner: null, depositBlock: 'something_new' })
    });
    assert.equal(unknown.gate.canStart, false);
});

test('gate: another live version with an open withdrawal blocks, a retired one does not', () => {
    const open = [{ recordId: 'r1', noteId: 3, mode: 'mutual', phase: 'parked', expiryTs: null }];
    const blocked = derive({
        active: V2, target: V2, adapter: CONCESSION,
        selection: selectionFor(V2, { reason: 'no_runtime_note', slotOwner: null, open: { v1: open } })
    });
    assert.equal(blocked.gate.code, 'previous_withdrawal_open');
    // The SDK's own report counts too, matched to a version by deployment id.
    const sdk = derive({
        active: V2, target: V2, adapter: CONCESSION,
        selection: selectionFor(V2, { reason: 'no_runtime_note', slotOwner: null }),
        snapshot: normalizedSnapshot({
            otherDeploymentWithdrawals: [{ deploymentId: V1.deploymentId, recordId: 'r9', noteId: 2, mode: 'escape', phase: 'pending' }]
        })
    });
    assert.equal(sdk.gate.code, 'previous_withdrawal_open');
    assert.equal(sdk.previous.versionId, 'v1');
    // The same record reported by both sources is one record.
    const both = derive({
        active: V2, target: V2, adapter: CONCESSION,
        selection: selectionFor(V2, { reason: 'no_runtime_note', slotOwner: null, open: { v1: [{ ...open[0], recordId: 'r9' }] } }),
        snapshot: normalizedSnapshot({
            otherDeploymentWithdrawals: [{ deploymentId: V1.deploymentId, recordId: 'r9', noteId: 3, mode: 'mutual', phase: 'parked' }]
        })
    });
    assert.equal(both.previous.openWithdrawals, 1);

    // A retired deployment's records can never be finished by any bundle.
    const retired = mutated(activatedRegistry(), registry => {
        for (const network of ['mainnet', 'sepolia']) {
            registry.versions[0].networks[network].status = 'retired';
            registry.versions[0].networks[network].retiredAt = '2027-01-01T00:00:00Z';
            registry.versions[0].networks[network].tombstone = {
                deploymentId: V1.deploymentId, chainId: 1, vault: V1.vault
            };
        }
    });
    const table = resolvedTable(retired, 'mainnet');
    const ignored = deriveVersionState({
        table, active: table[0], target: table[0], adapter: CONCESSION,
        selection: selectionFor(table[0], { reason: 'no_runtime_note', slotOwner: null, open: { v1: open } }),
        snapshot: normalizedSnapshot({
            otherDeploymentWithdrawals: [{ deploymentId: V1.deploymentId, recordId: 'r9', noteId: 2, mode: 'escape', phase: 'pending' }],
            otherDeploymentCredits: [{ deploymentId: V1.deploymentId, recordId: 'c9', noteId: 2 }]
        }),
        intent: null, previewSelection: null, now: NOW_MS, busy: false,
        admissionClosed: false, buildClosed: false, configBlock: false, unreachable: false
    });
    assert.equal(ignored.gate.canStart, true);
    assert.equal(ignored.previous, null);
    assert.equal(ignored.phase, 'current');
});

test('gate: a deployment this build has no row for blocks and cannot be named', () => {
    const state = derive({
        active: V2, target: V2, adapter: CONCESSION,
        selection: selectionFor(V2, { reason: 'no_runtime_note', slotOwner: null }),
        snapshot: normalizedSnapshot({
            otherDeploymentWithdrawals: [{ deploymentId: 'who-knows', recordId: 'r1', noteId: 1, mode: 'mutual', phase: 'parked' }]
        })
    });
    assert.equal(state.gate.code, 'previous_withdrawal_open');
    assert.equal(state.previous, null);
    assert.equal(state.phase, 'current');
});

test('gate: an operator notice relaxes exactly the matching pending escape, while unexpired', () => {
    const noticeTable = resolvedTable(mutated(activatedRegistry(), registry => {
        registry.versions[0].networks.mainnet.notices = [stuckEscapeNotice({ noteId: 7, expiresAt: '2027-01-01T00:00:00Z' })];
    }), 'mainnet');
    const [v1, v2] = noticeTable;
    const record = (overrides = {}) => ({ recordId: 'r1', noteId: 7, mode: 'escape', phase: 'pending', expiryTs: null, ...overrides });
    const gateFor = (records, now = NOW_MS) => deriveVersionState({
        table: noticeTable, active: v2, target: v2, adapter: CONCESSION,
        selection: selectionFor(v2, { reason: 'no_runtime_note', slotOwner: null, open: { v1: records } }),
        snapshot: normalizedSnapshot(), intent: null, previewSelection: null, now, busy: false,
        admissionClosed: false, buildClosed: false, configBlock: false, unreachable: false
    });
    assert.equal(gateFor([record()]).gate.canStart, true);
    assert.equal(gateFor([record()]).previous, null);
    // A different note, a mutual close, another phase: still blocked.
    assert.equal(gateFor([record({ noteId: 8 })]).gate.code, 'previous_withdrawal_open');
    assert.equal(gateFor([record({ mode: 'mutual' })]).gate.code, 'previous_withdrawal_open');
    assert.equal(gateFor([record({ phase: 'parked' })]).gate.code, 'previous_withdrawal_open');
    // The notice relaxes its record only; a second open record still blocks.
    const mixed = gateFor([record(), record({ recordId: 'r2', noteId: 9 })]);
    assert.equal(mixed.gate.code, 'previous_withdrawal_open');
    assert.equal(mixed.previous.openWithdrawals, 1);
    // Expired notice: blocked again. No clock: nothing is relaxed.
    assert.equal(gateFor([record()], Date.parse('2027-01-02T00:00:00Z')).gate.code, 'previous_withdrawal_open');
    assert.equal(deriveVersionState({
        table: noticeTable, active: v2, target: v2, adapter: CONCESSION,
        selection: selectionFor(v2, { reason: 'no_runtime_note', slotOwner: null, open: { v1: [record()] } }),
        snapshot: normalizedSnapshot(), intent: null, previewSelection: null, now: undefined, busy: false,
        admissionClosed: false, buildClosed: false, configBlock: false, unreachable: false
    }).gate.code, 'previous_withdrawal_open');
    assert.ok(v1.notices.length === 1);
});

// The operator text that took effect (VersionState.notices).
function noticeTable(notices, registryEdit = () => {}) {
    return resolvedTable(mutated(activatedRegistry(), registry => {
        registry.versions[0].networks.mainnet.notices = notices;
        registryEdit(registry);
    }), 'mainnet');
}

function onTargetWith(table, records, overrides = {}) {
    const target = table.find(version => version.status === 'active');
    return deriveVersionState({
        table, active: target, target, adapter: CONCESSION,
        selection: selectionFor(target, { reason: 'no_runtime_note', slotOwner: null, open: { v1: records } }),
        snapshot: normalizedSnapshot(), intent: null, previewSelection: null, now: NOW_MS, busy: false,
        admissionClosed: false, buildClosed: false, configBlock: false, unreachable: false,
        ...overrides
    });
}

const stuckRecord = (overrides = {}) => ({
    recordId: 'r1', noteId: 7, mode: 'escape', phase: 'pending', expiryTs: null, ...overrides
});

test('notices: the text of a notice that relaxed the gate is exposed, bounded and not escaped', () => {
    const text = 'Escape for note 7 is waiting on its <destination> & \u0000will\n finish\u2028soon.';
    const table = noticeTable([stuckEscapeNotice({ noteId: 7, text })]);
    const state = onTargetWith(table, [stuckRecord()]);
    assert.equal(state.gate.canStart, true, 'the notice relaxed the gate');
    assert.deepEqual(state.notices, [{
        versionId: 'v1', text: 'Escape for note 7 is waiting on its <destination> & will finish soon.', noteId: 7
    }]);
    // Plain data: it survives JSON and is stable across derivations.
    assert.deepEqual(JSON.parse(JSON.stringify(state.notices)), state.notices);
    assert.deepEqual(onTargetWith(table, [stuckRecord()]).notices, state.notices);
    // Bounded to 280 UTF-16 units however long the registry's text is.
    const long = noticeTable([stuckEscapeNotice({ noteId: 7, text: `${'x'.repeat(279)} tail that is cut` })]);
    const bounded = onTargetWith(long, [stuckRecord()]).notices[0].text;
    assert.equal(bounded.length, 280);
    assert.ok(bounded.endsWith('\u2026'));
});

test('notices: only a notice that matched a held record is exposed', () => {
    const table = noticeTable([stuckEscapeNotice({ noteId: 7, expiresAt: '2027-01-01T00:00:00Z' })]);
    // Another note, a mutual close, another phase: no relaxation, no text.
    for (const record of [stuckRecord({ noteId: 8 }), stuckRecord({ mode: 'mutual' }), stuckRecord({ phase: 'parked' })]) {
        const state = onTargetWith(table, [record]);
        assert.equal(state.gate.code, 'previous_withdrawal_open');
        assert.deepEqual(state.notices, []);
    }
    // Nothing held, or nothing open: the registry's notices are not shown.
    assert.deepEqual(onTargetWith(table, []).notices, []);
    // Expired, or no clock: the gate is closed again and so is the text.
    assert.deepEqual(onTargetWith(table, [stuckRecord()], { now: Date.parse('2027-01-02T00:00:00Z') }).notices, []);
    assert.deepEqual(onTargetWith(table, [stuckRecord()], { now: undefined }).notices, []);
    // The same record on a version with no notice.
    const none = noticeTable([]);
    assert.deepEqual(onTargetWith(none, [stuckRecord()]).notices, []);
    // The loaded version's own records are not other-version business.
    const own = deriveVersionState({
        table, active: table[0], target: table[1], adapter: LEGACY,
        selection: selectionFor(table[0], { open: { v1: [stuckRecord()] } }),
        snapshot: normalizedSnapshot(), intent: null, previewSelection: null, now: NOW_MS, busy: false,
        admissionClosed: false, buildClosed: false, configBlock: false, unreachable: false
    });
    assert.deepEqual(own.notices, []);
});

test('notices: a record the notice covers is reported once, from either source, beside one that it does not', () => {
    const table = noticeTable([stuckEscapeNotice({ noteId: 7 })]);
    // The holdings fact and the SDK's own list both name the same record.
    const both = onTargetWith(table, [stuckRecord()], {
        snapshot: normalizedSnapshot({
            otherDeploymentWithdrawals: [{ deploymentId: table[0].deploymentId, recordId: 'r1', noteId: 7, mode: 'escape', phase: 'pending' }]
        })
    });
    assert.equal(both.notices.length, 1);
    // A second record of the same note and notice is still one line of text.
    const twice = onTargetWith(table, [stuckRecord(), stuckRecord({ recordId: 'r1b' })]);
    assert.equal(twice.notices.length, 1);
    // An uncovered record still blocks; the covered one is still explained.
    const mixed = onTargetWith(table, [stuckRecord(), stuckRecord({ recordId: 'r2', noteId: 9 })]);
    assert.equal(mixed.gate.code, 'previous_withdrawal_open');
    assert.equal(mixed.notices.length, 1);
});

test('notices: several versions are ordered by ordinal and each names its own version', () => {
    const table = resolvedTable(mutated(threeVersionRegistry(), registry => {
        registry.versions[0].networks.mainnet.notices = [stuckEscapeNotice({ noteId: 7, text: 'About version one.' })];
        registry.versions[1].networks.mainnet.notices = [stuckEscapeNotice({ noteId: 9, text: 'About version two.' })];
    }), 'mainnet');
    const [, , v3] = table;
    const state = deriveVersionState({
        table, active: v3, target: v3, adapter: CONCESSION,
        // Listed in the opposite order on purpose.
        selection: selectionFor(v3, {
            reason: 'no_runtime_note', slotOwner: null,
            open: { v2: [stuckRecord({ recordId: 'b', noteId: 9 })], v1: [stuckRecord({ recordId: 'a', noteId: 7 })] }
        }),
        snapshot: normalizedSnapshot(), intent: null, previewSelection: null, now: NOW_MS, busy: false,
        admissionClosed: false, buildClosed: false, configBlock: false, unreachable: false
    });
    assert.equal(state.gate.canStart, true);
    assert.deepEqual(state.notices, [
        { versionId: 'v1', text: 'About version one.', noteId: 7 },
        { versionId: 'v2', text: 'About version two.', noteId: 9 }
    ]);
});

test('notices: two notes with the same words are two notices, each with its own reference', () => {
    const table = noticeTable([
        stuckEscapeNotice({ noteId: 7, text: 'Same words.' }),
        stuckEscapeNotice({ noteId: 9, text: 'Same words.' })
    ]);
    const state = onTargetWith(table, [stuckRecord(), stuckRecord({ recordId: 'r2', noteId: 9 })]);
    assert.deepEqual(state.notices, [
        { versionId: 'v1', text: 'Same words.', noteId: 7 },
        { versionId: 'v1', text: 'Same words.', noteId: 9 }
    ]);
    // Two records of one note are still one notice.
    assert.equal(onTargetWith(table, [stuckRecord(), stuckRecord({ recordId: 'r1b' })]).notices.length, 1);
});

test('notices: the fail-closed state has none', () => {
    const state = deriveVersionState({ table: TABLE, active: null, selection: null });
    assert.deepEqual(state.notices, []);
    assert.equal(state.gate.code, 'version_unavailable');
    // Every additive balance fact is empty, not missing.
    assert.equal(state.exit, null);
    assert.equal(state.abandon, null);
    assert.deepEqual(state.payouts, { credited: 0, alerts: 0 });
    assert.deepEqual(state.setAside, { near: 0, earliestMustInitiateByMs: null, device: 0 });
});

test('gate: a started deposit stays resumable, an unsent plan is not', () => {
    const started = derive({ snapshot: normalizedSnapshot({ hasPendingDeposit: true }) });
    assert.equal(started.gate.canResume, true);
    assert.equal(started.gate.canStart, false);
    assert.equal(started.upgrade.blockedBy, 'pending_deposit');
    assert.equal(started.unsent, false);
    const unsent = derive({ snapshot: normalizedSnapshot({ hasPendingDeposit: true, hasUnsentPrepared: true }) });
    assert.equal(unsent.gate.canResume, false);
    assert.equal(unsent.unsent, true);
    assert.equal(unsent.upgrade.blockedBy, 'unsent_deposit');
    assert.equal(unsent.upgrade.stage, 'blocked');
    // On the live version a plan in progress is a normal deposit, not "unsent".
    const live = derive({
        active: V2, target: V2, adapter: CONCESSION, selection: selectionFor(V2),
        snapshot: normalizedSnapshot({ hasPendingDeposit: true, hasUnsentPrepared: true })
    });
    assert.equal(live.unsent, false);
});

test('an unsent draft pinning a closed version is found from the holdings facts', () => {
    for (const slotKind of ['draft_only', 'unsent_prepared']) {
        const state = derive({ selection: selectionFor(V1, { slotKind }) });
        assert.equal(state.unsent, true, slotKind);
        assert.equal(state.gate.canResume, false);
    }
    // A draft in somebody else's slot is not this version's problem.
    const other = derive({
        selection: selectionFor(V2, { slotKind: 'draft_only', slotOwner: 'v2' }),
        snapshot: normalizedSnapshot()
    });
    assert.equal(other.unsent, false);
    // After the user clears it and the watcher re-reads, the flag goes.
    const cleared = derive({
        selection: selectionFor(V1, { slotKind: 'draft_only' }),
        previewSelection: selectionFor(V1, { slotKind: 'note' })
    });
    assert.equal(cleared.unsent, false);
});

test('a preview made without the probe\'s slot kind does not erase a boot-time draft', () => {
    // chooseZkapiVersion reports the slot kind it is handed, and 'other' for an
    // owned slot otherwise. A watcher that forgets to pass the probe's kind
    // must not take "cancel unfinished deposit" away from someone still pinned.
    const holdings = [{ deploymentId: V1.deploymentId, runtime: true, withdrawals: [], credits: [] }];
    const boot = chooseZkapiVersion({ table: TABLE, holdings, slotKind: 'draft_only' });
    const unclassified = chooseZkapiVersion({ table: TABLE, holdings });
    assert.equal(boot.slotKind, 'draft_only');
    assert.equal(unclassified.slotKind, 'other');
    assert.equal(unclassified.slotOwner, 'v1');

    const withoutPreview = derive({ selection: boot });
    assert.equal(withoutPreview.unsent, true);
    assert.equal(withoutPreview.upgrade.blockedBy, 'unsent_deposit');
    const withPreview = derive({ selection: boot, previewSelection: unclassified });
    assert.equal(withPreview.unsent, true);
    assert.equal(withPreview.upgrade.blockedBy, 'unsent_deposit');
    assert.equal(withPreview.upgrade.stage, 'blocked');
    // The kind passed through is the same answer.
    assert.equal(derive({
        selection: boot,
        previewSelection: chooseZkapiVersion({ table: TABLE, holdings, slotKind: 'draft_only' })
    }).unsent, true);

    // A preview that DOES classify the slot differently is a real change.
    for (const slotKind of ['note', 'pending_deposit', 'empty']) {
        const changed = chooseZkapiVersion({ table: TABLE, holdings, slotKind });
        assert.equal(derive({ selection: boot, previewSelection: changed }).unsent, false, slotKind);
    }
    // An empty slot (no owner) is reported as empty by the chooser and clears it.
    const emptied = chooseZkapiVersion({ table: TABLE, holdings: [] });
    assert.equal(emptied.slotKind, 'empty');
    assert.equal(derive({ selection: boot, previewSelection: emptied }).unsent, false);
    // Another owner of the slot is not this version's draft, whatever the kind.
    const moved = chooseZkapiVersion({
        table: TABLE, holdings: [{ deploymentId: V2.deploymentId, runtime: true, withdrawals: [], credits: [] }]
    });
    assert.equal(moved.slotOwner, 'v2');
    assert.equal(derive({ selection: boot, previewSelection: moved }).unsent, false);
});

test('config and build latches close deposits but never chat or exits', () => {
    for (const [flag, code] of [['configBlock', 'config_mismatch'], ['buildClosed', 'stale_build']]) {
        const state = derive({
            active: V2, target: V2, adapter: CONCESSION, selection: selectionFor(V2),
            snapshot: noteSnapshot(NOW_S + 20 * DAY, { hasPendingDeposit: true }),
            [flag]: true
        });
        assert.equal(state.gate.canStart, false);
        assert.equal(state.gate.code, code);
        // A started deposit and the holding are untouched.
        assert.equal(state.gate.canResume, true);
        assert.equal(state.holding, 'current');
    }
});

// ---------------------------------------------------------------------------
// Previous version
// ---------------------------------------------------------------------------

test('previous.canOpen follows the loader: only with an empty slot and not busy', () => {
    const open = [{ recordId: 'r1', noteId: 3, mode: 'escape', phase: 'pending', expiryTs: null }];
    const base = {
        active: V2, target: V2, adapter: CONCESSION,
        selection: selectionFor(V2, { reason: 'no_runtime_note', slotOwner: null, slotKind: 'empty', open: { v1: open } })
    };
    assert.equal(derive(base).previous.canOpen, true);
    assert.equal(derive({ ...base, busy: true }).previous.canOpen, false);
    // A note of the target in the slot: the previous build cannot load.
    const withNote = derive({
        ...base,
        selection: selectionFor(V2, { reason: 'runtime_holds_note', slotOwner: 'v2', open: { v1: open } }),
        snapshot: noteSnapshot(NOW_S + 20 * DAY)
    });
    assert.equal(withNote.previous.canOpen, false);
    assert.equal(withNote.previous.openWithdrawals, 1);
    assert.equal(withNote.gate.code, 'previous_withdrawal_open');
    // A deposit in progress holds the slot too.
    const pending = derive({ ...base, snapshot: normalizedSnapshot({ hasPendingDeposit: true }) });
    assert.equal(pending.previous.canOpen, false);
});

test('rollback: v1 active again, v2 exit-only gets the successor copy', () => {
    const table = resolvedTable(rollbackRegistry(), 'mainnet');
    const [v1, v2] = table;
    assert.equal(v1.status, 'active');
    assert.equal(v2.status, 'exit-only');
    const state = deriveVersionState({
        table, active: v2, target: v1, adapter: CONCESSION, selection: selectionFor(v2),
        snapshot: noteSnapshot(NOW_S + 20 * DAY), intent: null, previewSelection: null, now: NOW_MS, busy: false,
        admissionClosed: false, buildClosed: false, configBlock: false, unreachable: false
    });
    assert.deepEqual(state.gate.successor, { id: 'v1', label: 'Version 1' });
    assert.equal(state.holding, 'previous');
    assert.equal(state.upgrade.available, true);
    assert.deepEqual(state.target, { id: 'v1', label: 'Version 1' });
});

test('three versions: a v1 holder is offered the current target, never an intermediate one', () => {
    const table = resolvedTable(threeVersionRegistry(), 'mainnet');
    assert.deepEqual(table.map(version => `${version.id}:${version.status}`), ['v1:exit-only', 'v2:exit-only', 'v3:active']);
    const v1 = table[0];
    const v3 = table[2];
    const state = deriveVersionState({
        table, active: v1, target: v3, adapter: LEGACY, selection: selectionFor(v1),
        snapshot: noteSnapshot(NOW_S + 20 * DAY), intent: null, previewSelection: null, now: NOW_MS, busy: false,
        admissionClosed: false, buildClosed: false, configBlock: false, unreachable: false
    });
    assert.deepEqual(state.target, { id: 'v3', label: 'Version 3' });
    assert.deepEqual(state.gate.successor, { id: 'v3', label: 'Version 3' });
    assert.equal(state.show, true);
    assert.equal(state.upgrade.available, true);
    // The same holder on v3's open withdrawal of v2 names v2 as previous.
    const v2Open = deriveVersionState({
        table, active: v3, target: v3, adapter: CONCESSION,
        selection: selectionFor(v3, {
            reason: 'no_runtime_note', slotOwner: null,
            open: { v2: [{ recordId: 'r', noteId: 1, mode: 'escape', phase: 'pending', expiryTs: null }] }
        }),
        snapshot: normalizedSnapshot(), intent: null, previewSelection: null, now: NOW_MS, busy: false,
        admissionClosed: false, buildClosed: false, configBlock: false, unreachable: false
    });
    assert.equal(v2Open.previous.versionId, 'v2');
    assert.equal(v2Open.phase, 'finish-previous-withdrawal');
});

// ---------------------------------------------------------------------------
// Robustness
// ---------------------------------------------------------------------------

test('unusable input yields a closed, hidden state and never throws', () => {
    for (const input of [undefined, null, {}, { active: null }, { active: V1 }, { active: V1, selection: 'x' },
        { active: { id: '' }, selection: {} }, { active: { id: 'v1', status: 'weird' }, selection: {} }]) {
        const state = deriveVersionState(input);
        assert.equal(state.show, false);
        assert.equal(state.gate.canStart, false);
        assert.equal(state.gate.code, 'version_unavailable');
        assert.equal(state.upgrade.canStart, false);
        assert.equal(state.phase, 'current');
    }
});

test('garbage in the optional fields degrades to "nothing to report"', () => {
    const state = deriveVersionState({
        table: [V1, V2, null, 'x', 7],
        active: V1,
        target: V2,
        selection: selectionFor(V1, { open: 'no', credits: 12 }),
        snapshot: {
            hasNote: 'yes', expiryTs: 'soon', deadlines: [null, { source: 'slot', expiryTs: -5 }, 'x'],
            otherDeploymentWithdrawals: [null, 4, 'x'], otherDeploymentCredits: 'none', service: 'down'
        },
        intent: 'upgrade',
        previewSelection: 'later',
        now: 'yesterday',
        busy: 'maybe',
        adapter: 'legacy'
    });
    assert.equal(state.phase, 'current');
    assert.equal(state.holding, 'none');
    assert.equal(state.upgrade.available, false);
    assert.equal(state.reload.canReload, true);
    assert.equal(state.reminderTier, null);
    // `busy` and the flags must be exactly true to count.
    assert.equal(state.gate.code, 'deposits_closed');
});

test('deriving never mutates its input', () => {
    const input = {
        table: TABLE,
        active: V1,
        target: V2,
        selection: selectionFor(V1, { open: { v2: [{ recordId: 'r', noteId: 1, mode: 'escape', phase: 'pending', expiryTs: 5 }] } }),
        snapshot: noteSnapshot(NOW_S + 5 * DAY, {
            hasOpenWithdrawal: true,
            deadlines: [{ source: 'slot', expiryTs: NOW_S + 5 * DAY }, { source: 'set-aside', expiryTs: NOW_S + 4 * DAY }],
            otherDeploymentWithdrawals: [{ deploymentId: V2.deploymentId, recordId: 'x', noteId: 2, mode: 'mutual', phase: 'parked' }]
        }),
        intent: { v: 1, network: 'mainnet', from: 'v1', to: 'v2', stage: 'withdrawing', since: 1 },
        previewSelection: selectionFor(V2, { reason: 'runtime_holds_note' }),
        now: NOW_MS, busy: false, admissionClosed: false, buildClosed: false, configBlock: false, unreachable: false,
        adapter: LEGACY
    };
    const before = deepClone({ ...input, adapter: null });
    const freeze = value => {
        if (value && typeof value === 'object' && !Object.isFrozen(value)) {
            Object.freeze(value);
            for (const key of Object.keys(value)) freeze(value[key]);
        }
        return value;
    };
    freeze(input.table);
    for (const key of ['selection', 'snapshot', 'intent', 'previewSelection']) freeze(input[key]);
    const first = deriveVersionState(input);
    const second = deriveVersionState({ ...input, now: NOW_MS + 1000 });
    assert.deepEqual(deepClone({ ...input, adapter: null }), before);
    assert.ok(first && second);
    // Timers: the same facts at later instants only move time-derived fields.
    const later = deriveVersionState({ ...input, now: NOW_MS + 60 * 60 * 1000 });
    assert.equal(later.gate.code, first.gate.code);
    assert.equal(later.closeByTs, first.closeByTs);
});

test('the module is pure: no clock, storage, network or DOM', () => {
    const source = fs.readFileSync(new URL('../../chat/zkapi/versioning/versionState.mjs', import.meta.url), 'utf8');
    for (const forbidden of ['Date.now', 'new Date', 'localStorage', 'sessionStorage', 'indexedDB', 'fetch(',
        'document.', 'window.', 'globalThis', 'XMLHttpRequest', 'navigator', 'setTimeout', 'setInterval']) {
        assert.equal(source.includes(forbidden), false, `versionState.mjs must not use ${forbidden}`);
    }
    // Imports: only the pure sibling modules (the flow, and the operator-text
    // bound that the copy module owns).
    const imports = [...source.matchAll(/^import .* from '([^']+)';/gm)].map(match => match[1]);
    assert.deepEqual(imports, ['./copy.mjs', './upgradeFlow.mjs']);
});

test('a missing clock fails toward silence, not toward an alarm', () => {
    const state = derive({ snapshot: noteSnapshot(NOW_S + 1), now: null });
    assert.equal(state.phase, 'upgrade-available');
    assert.equal(state.reminderTier, null);
    assert.equal(state.upgrade.blockedBy, null);
});
