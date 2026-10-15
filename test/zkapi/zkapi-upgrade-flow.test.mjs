import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { getAdapter } from '../../chat/zkapi/versioning/adapters/index.mjs';
import {
    clearUpgradeIntent,
    readUpgradeIntent,
    writeUpgradeIntent
} from '../../chat/zkapi/versioning/switchProtocol.mjs';
import {
    UPGRADE_STEPS, deriveUpgradeStage, intentProvesWithdrawal, upgradeStepStates
} from '../../chat/zkapi/versioning/upgradeFlow.mjs';
import { deriveVersionState } from '../../chat/zkapi/versioning/versionState.mjs';
import {
    NOW_MS,
    activatedRegistry,
    normalizedSnapshot,
    resolvedTable
} from './_registryFixtures.mjs';

const DAY = 86_400;
const NOW_S = Math.floor(NOW_MS / 1000);
const TABLE = resolvedTable(activatedRegistry(), 'mainnet');
const [V1, V2] = TABLE;

const INTENT = (stage = 'withdrawing', overrides = {}) => ({
    v: 1, network: 'mainnet', from: 'v1', to: 'v2', stage, since: NOW_MS - 60_000, ...overrides
});

// A VersionState without its `upgrade` field, as the flow receives it. The
// defaults are a holder of a legacy balance on the closed version.
function partial(overrides = {}) {
    return {
        show: true,
        current: { id: 'v1', label: 'Version 1', status: 'exit-only' },
        target: { id: 'v2', label: 'Version 2' },
        holding: 'previous',
        depositsOpen: false,
        gate: { canStart: false, canResume: false, code: 'deposits_closed', successor: { id: 'v2', label: 'Version 2' } },
        phase: 'upgrade-available',
        closeByTs: null,
        expiryTs: null,
        deadlineSource: 'slot',
        reminderTier: null,
        reload: { required: false, canReload: true, reason: null, targetId: null },
        previous: null,
        unsent: false,
        service: null,
        ...overrides
    };
}

// The same, as the loaded deposit target after the reload.
const onTarget = (overrides = {}) => partial({
    current: { id: 'v2', label: 'Version 2', status: 'active' },
    holding: 'none',
    depositsOpen: true,
    phase: 'current',
    gate: { canStart: true, canResume: false, code: null, successor: null },
    ...overrides
});

const stage = (versionState, rest = {}) => deriveUpgradeStage({
    versionState, intent: null, viewOpen: false, withdrawalPhase: null, ...rest
});

// ---------------------------------------------------------------------------
// The stage table
// ---------------------------------------------------------------------------

test('idle: a legacy balance and no intent', () => {
    assert.equal(stage(partial()), 'idle');
    assert.equal(stage(partial(), { intent: null, viewOpen: false }), 'idle');
});

test('review: only while the upgrade view is open and there is a balance to move', () => {
    assert.equal(stage(partial(), { viewOpen: true }), 'review');
    assert.equal(stage(partial({ holding: 'none', phase: 'current' }), { viewOpen: true }), 'idle');
});

test('withdrawing and confirming come from the SDK withdrawal phase', () => {
    const moving = partial({ phase: 'withdrawing' });
    assert.equal(stage(moving), 'withdrawing');
    for (const phase of ['reserving', 'prepared', 'awaiting_wallet', 'submitted', 'pending', 'ambiguous',
        'dropped_or_pending', 'late_submitted', 'retry_exact']) {
        assert.equal(stage(moving, { withdrawalPhase: phase }), 'withdrawing', phase);
    }
    for (const phase of ['closed_unconfirmed', 'submitted_unconfirmed', 'challenged_unconfirmed', 'finalizing']) {
        assert.equal(stage(moving, { withdrawalPhase: phase }), 'confirming', phase);
    }
    // An unknown phase keeps the full withdrawal journey in front of the user.
    assert.equal(stage(moving, { withdrawalPhase: 'something_new' }), 'withdrawing');
    // The SDK's phase alone is evidence, even if the normalized snapshot lags.
    assert.equal(stage(partial(), { withdrawalPhase: 'closed_unconfirmed' }), 'confirming');
    // Records that hold a balance or are finished are not a withdrawal in motion.
    for (const phase of ['closed', 'parked', 'restored']) {
        assert.equal(stage(partial(), { withdrawalPhase: phase }), 'idle', phase);
    }
});

test('ready_to_switch: nothing held or open here and a fresh load picks the target', () => {
    const ready = partial({
        holding: 'none',
        phase: 'reload-required',
        reload: { required: true, canReload: true, reason: 'upgrade_withdrawn', targetId: 'v2' }
    });
    assert.equal(stage(ready), 'ready_to_switch');
    // Reload to a version that is not the target is not this step.
    assert.notEqual(stage(partial({ ...ready, reload: { ...ready.reload, targetId: 'v9' } })), 'ready_to_switch');
    // Still holding something: not ready.
    assert.notEqual(stage(partial({ ...ready, holding: 'previous' })), 'ready_to_switch');
    // `busy` only disables the button; it does not change the step.
    assert.equal(stage(partial({ ...ready, reload: { ...ready.reload, canReload: false } })), 'ready_to_switch');
});

test('blocked: expired, unsent plan, started deposit, set-aside note', () => {
    assert.equal(stage(partial({ phase: 'expired' })), 'blocked');
    assert.equal(stage(partial({ unsent: true })), 'blocked');
    assert.equal(stage(partial({ gate: { canStart: false, canResume: true, code: 'deposits_closed', successor: null } })), 'blocked');
    assert.equal(stage(partial({ phase: 'finish-previous-withdrawal' })), 'blocked');
    // A withdrawal already in motion is progress, not a block.
    assert.equal(stage(partial({ phase: 'withdrawing', unsent: true })), 'withdrawing');
});

test('deposit: on the target after a withdrawal, until the note is there', () => {
    const intent = INTENT('withdrawn');
    assert.equal(stage(onTarget(), { intent }), 'deposit');
    // A deposit already begun keeps the step too.
    assert.equal(stage(onTarget(), { intent: INTENT('depositing') }), 'deposit');
    // A started deposit keeps the step even while new ones are closed.
    assert.equal(stage(onTarget({ gate: { canStart: false, canResume: true, code: 'stale_build', successor: null } }), { intent }), 'deposit');
    // Nothing can be deposited and nothing was started: blocked, not a dead end.
    assert.equal(stage(onTarget({ gate: { canStart: false, canResume: false, code: 'previous_withdrawal_open', successor: null } }), { intent }), 'blocked');
});

test('deposit never narrates a withdrawal that only started', () => {
    // "Your balance is withdrawn" needs an intent that says it finished. A
    // bare `withdrawing` one proves only that an upgrade was begun: the note
    // may since have expired, been claimed and archived, which lands here just
    // as empty and is a forfeit, not a withdrawal.
    assert.equal(stage(onTarget(), { intent: INTENT('withdrawing') }), 'idle');
    // Not blocked either: there is no upgrade step to be stuck on.
    assert.equal(stage(onTarget({
        gate: { canStart: false, canResume: false, code: 'stale_build', successor: null }
    }), { intent: INTENT('withdrawing') }), 'idle');
    // The same facts with the later stages are the deposit step.
    for (const intentStage of ['withdrawn', 'depositing']) {
        assert.equal(stage(onTarget(), { intent: INTENT(intentStage) }), 'deposit', intentStage);
    }
});

test('done: the note is in the target; never from a balance alone', () => {
    assert.equal(stage(onTarget({ holding: 'current' }), { intent: INTENT('withdrawn') }), 'done');
    // Any intent toward this version completes on the note, so the facade can
    // clear a stale one at the first deposit.
    assert.equal(stage(onTarget({ holding: 'current' }), { intent: INTENT('withdrawing') }), 'done');
    // No intent on this browser: an existing balance is just a balance.
    assert.equal(stage(onTarget({ holding: 'current' })), 'idle');
    // An intent toward another version says nothing about this one.
    assert.equal(stage(onTarget({ holding: 'current' }), { intent: INTENT('withdrawn', { to: 'v3' }) }), 'idle');
});

test('a withdrawal in motion on the target is not part of the upgrade', () => {
    assert.equal(stage(onTarget({ holding: 'current', phase: 'withdrawing' }), { intent: INTENT('withdrawn') }), 'idle');
});

test('an intent that does not name two different versions and a known stage is ignored', () => {
    const bad = [
        null, undefined, 'withdrawn', 7, [],
        { ...INTENT('withdrawn'), from: 'v2' },
        { ...INTENT('withdrawn'), to: '' },
        { ...INTENT('withdrawn'), from: undefined },
        { ...INTENT('withdrawn'), stage: 'done' },
        { ...INTENT('withdrawn'), stage: undefined }
    ];
    for (const intent of bad) {
        assert.equal(stage(onTarget({ holding: 'current' }), { intent }), 'idle', JSON.stringify(intent));
    }
});

test('no version context, one version, or nowhere to go is idle', () => {
    assert.equal(deriveUpgradeStage(), 'idle');
    assert.equal(deriveUpgradeStage(null), 'idle');
    assert.equal(deriveUpgradeStage({}), 'idle');
    assert.equal(stage(partial({ show: false })), 'idle');
    assert.equal(stage(partial({ target: null })), 'idle');
    assert.equal(stage(partial({ current: null })), 'idle');
    assert.equal(stage(null), 'idle');
});

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

test('the three steps are fixed and frozen', () => {
    assert.deepEqual(UPGRADE_STEPS.map(step => step.id), ['withdraw', 'reload', 'deposit']);
    assert.ok(Object.isFrozen(UPGRADE_STEPS));
    assert.ok(UPGRADE_STEPS.every(step => Object.isFrozen(step) && typeof step.label === 'string' && step.label));
    assert.throws(() => { UPGRADE_STEPS.push({ id: 'x', label: 'x' }); }, TypeError);
});

test('step progress follows the stage', () => {
    const states = value => upgradeStepStates(value).map(step => step.state).join(',');
    assert.equal(states('idle'), 'upcoming,upcoming,upcoming');
    assert.equal(states('blocked'), 'upcoming,upcoming,upcoming');
    assert.equal(states('review'), 'current,upcoming,upcoming');
    assert.equal(states('withdrawing'), 'current,upcoming,upcoming');
    assert.equal(states('confirming'), 'current,upcoming,upcoming');
    assert.equal(states('ready_to_switch'), 'done,current,upcoming');
    assert.equal(states('deposit'), 'done,done,current');
    assert.equal(states('done'), 'done,done,done');
    assert.equal(states('nonsense'), 'upcoming,upcoming,upcoming');
    assert.deepEqual(upgradeStepStates('review').map(step => step.id), ['withdraw', 'reload', 'deposit']);
});

// ---------------------------------------------------------------------------
// Through deriveVersionState
// ---------------------------------------------------------------------------

function selectionFor(version, overrides = {}) {
    return {
        version, reason: 'runtime_holds_note', slotOwner: version.id, open: {}, credits: {},
        foreignDeploymentId: null, depositBlock: null, draftDiscarded: false, slotKind: 'note', ...overrides
    };
}

function derive(overrides = {}) {
    const active = overrides.active || V1;
    return deriveVersionState({
        table: TABLE,
        active,
        target: V2,
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
    });
}

const note = (extra = {}) => normalizedSnapshot({
    hasNote: true,
    expiryTs: NOW_S + 10 * DAY,
    deadlines: [{ source: 'slot', expiryTs: NOW_S + 10 * DAY }],
    ...extra
});

test('the whole journey as facts change: no state is remembered, only the intent', () => {
    // 1. A legacy balance.
    assert.equal(derive({ snapshot: note() }).upgrade.stage, 'idle');
    // 2. The upgrade withdrawal is prepared.
    const withdrawing = derive({ snapshot: note({ hasPreparedWithdrawal: true }), intent: INTENT('withdrawing') });
    assert.equal(withdrawing.upgrade.stage, 'withdrawing');
    assert.equal(withdrawing.phase, 'withdrawing');
    // 3. The record is on chain; the slot is empty, a record is still open.
    const confirming = derive({
        snapshot: normalizedSnapshot({ hasOpenWithdrawal: true }),
        intent: INTENT('withdrawing'),
        previewSelection: selectionFor(V2, { reason: 'no_runtime_note', slotOwner: null, slotKind: 'empty', open: { v1: [{ recordId: 'r', noteId: 1, mode: 'mutual', phase: 'closed_unconfirmed', expiryTs: null }] } })
    });
    assert.equal(confirming.reload.required, false);
    assert.equal(confirming.upgrade.stage, 'withdrawing');
    // The facade asks again with the SDK's phase and gets the finer answer.
    assert.equal(deriveUpgradeStage({
        versionState: withoutUpgrade(confirming), intent: INTENT('withdrawing'), viewOpen: true, withdrawalPhase: 'closed_unconfirmed'
    }), 'confirming');
    // 4. Everything is finished: reload to the target. The facade promotes
    // the intent to `withdrawn` when it observes the withdrawal's verified
    // closure; that, not an empty wallet, is what the words rely on.
    const emptyPreview = selectionFor(V2, { reason: 'no_runtime_note', slotOwner: null, slotKind: 'empty' });
    const ready = derive({ snapshot: normalizedSnapshot(), intent: INTENT('withdrawn'), previewSelection: emptyPreview });
    assert.equal(ready.upgrade.stage, 'ready_to_switch');
    assert.equal(ready.reload.reason, 'upgrade_withdrawn');
    // The bare intent gets the same step and the neutral reason.
    const unproven = derive({ snapshot: normalizedSnapshot(), intent: INTENT('withdrawing'), previewSelection: emptyPreview });
    assert.equal(unproven.upgrade.stage, 'ready_to_switch');
    assert.equal(unproven.reload.reason, 'previous_withdrawal_finished');
    // 5. After the reload, on the target, nothing deposited yet.
    const deposit = derive({
        active: V2,
        selection: selectionFor(V2, { reason: 'no_runtime_note', slotOwner: null, slotKind: 'empty' }),
        snapshot: normalizedSnapshot(),
        intent: INTENT('withdrawn')
    });
    assert.equal(deposit.upgrade.stage, 'deposit');
    assert.equal(deposit.holding, 'none');
    assert.equal(deposit.gate.canStart, true);
    // 6. The note is there.
    const done = derive({
        active: V2,
        selection: selectionFor(V2),
        snapshot: note(),
        intent: INTENT('depositing')
    });
    assert.equal(done.upgrade.stage, 'done');
    assert.equal(done.upgrade.available, false);
});

test('only a withdrawn or depositing intent proves the withdrawal', () => {
    assert.equal(intentProvesWithdrawal(INTENT('withdrawn')), true);
    assert.equal(intentProvesWithdrawal(INTENT('depositing')), true);
    assert.equal(intentProvesWithdrawal(INTENT('withdrawing')), false, 'only says the review step was opened');
    for (const bad of [null, undefined, 'withdrawn', 7, [], {}, { stage: 'done' }, { stage: 'WITHDRAWN' }]) {
        assert.equal(intentProvesWithdrawal(bad), false, JSON.stringify(bad));
    }
});

test('the optional view and withdrawal phase inputs refine the stage', () => {
    const base = { snapshot: note() };
    assert.equal(derive(base).upgrade.stage, 'idle');
    assert.equal(derive({ ...base, viewOpen: true }).upgrade.stage, 'review');
    // Opening the view while a withdrawal is moving does not change its step.
    assert.equal(derive({ snapshot: note({ hasOpenWithdrawal: true }), viewOpen: true }).upgrade.stage, 'withdrawing');
    assert.equal(derive({
        snapshot: note({ hasOpenWithdrawal: true }), withdrawalPhase: 'closed_unconfirmed'
    }).upgrade.stage, 'confirming');
    assert.equal(derive({
        snapshot: note({ hasOpenWithdrawal: true }), withdrawalPhase: 'submitted'
    }).upgrade.stage, 'withdrawing');
    // Neither input is trusted beyond its type.
    assert.equal(derive({ ...base, viewOpen: 'yes', withdrawalPhase: 7 }).upgrade.stage, 'idle');
});

function withoutUpgrade(state) {
    const { upgrade, ...rest } = state;
    return rest;
}

test('the target build with the previous withdrawal still open is blocked, not "deposit"', () => {
    const state = derive({
        active: V2,
        selection: selectionFor(V2, {
            reason: 'no_runtime_note', slotOwner: null, slotKind: 'empty',
            open: { v1: [{ recordId: 'r', noteId: 1, mode: 'escape', phase: 'pending', expiryTs: null }] }
        }),
        snapshot: normalizedSnapshot(),
        intent: INTENT('withdrawn')
    });
    assert.equal(state.gate.code, 'previous_withdrawal_open');
    assert.equal(state.upgrade.stage, 'blocked');
    assert.equal(state.phase, 'finish-previous-withdrawal');
});

test('a forfeited balance on the target is not told it was withdrawn', () => {
    // The upgrade was started (intent `withdrawing`), the note then expired and
    // was claimed and archived: the next load picks the target with an empty
    // slot, exactly as after a real withdrawal.
    const forfeited = derive({
        active: V2,
        selection: selectionFor(V2, { reason: 'no_runtime_note', slotOwner: null, slotKind: 'empty' }),
        snapshot: normalizedSnapshot(),
        intent: INTENT('withdrawing')
    });
    assert.equal(forfeited.upgrade.stage, 'idle');
    assert.equal(forfeited.gate.canStart, true);
    assert.equal(forfeited.holding, 'none');
    // The ordinary deposit flow is untouched, and a first deposit completes.
    const deposited = derive({
        active: V2,
        selection: selectionFor(V2),
        snapshot: note(),
        intent: INTENT('withdrawing')
    });
    assert.equal(deposited.upgrade.stage, 'done');
});

test('an unsent plan on the closed version blocks the guided upgrade with the right reason', () => {
    const state = derive({ snapshot: note({ hasPendingDeposit: true, hasUnsentPrepared: true }) });
    assert.equal(state.unsent, true);
    assert.equal(state.upgrade.stage, 'blocked');
    assert.equal(state.upgrade.blockedBy, 'unsent_deposit');
    assert.equal(state.upgrade.canStart, false);
});

test('an expired balance is blocked and keeps the existing expired state', () => {
    const state = derive({ snapshot: note({ expiryTs: NOW_S - 1, deadlines: [{ source: 'slot', expiryTs: NOW_S - 1 }] }) });
    assert.equal(state.phase, 'expired');
    assert.equal(state.upgrade.stage, 'blocked');
    assert.equal(state.upgrade.blockedBy, 'expired');
});

test('a settling chat holds the start without changing the step', () => {
    const idle = derive({ snapshot: note(), busy: true });
    assert.equal(idle.upgrade.stage, 'idle');
    assert.equal(idle.upgrade.blockedBy, 'in_flight');
    assert.equal(idle.upgrade.canStart, false);
    assert.equal(idle.reload.canReload, false);
});

// ---------------------------------------------------------------------------
// Intent storage
// ---------------------------------------------------------------------------

function memoryStorage(initial = {}) {
    const data = { ...initial };
    return {
        data,
        getItem: key => (key in data ? data[key] : null),
        setItem: (key, value) => { data[key] = String(value); },
        removeItem: key => { delete data[key]; }
    };
}

const throwingStorage = () => ({
    getItem() { throw new Error('storage disabled'); },
    setItem() { throw new Error('storage disabled'); },
    removeItem() { throw new Error('storage disabled'); }
});

test('without storage the stage falls back to the facts and nothing throws', () => {
    const storage = throwingStorage();
    assert.equal(readUpgradeIntent({ network: 'mainnet', storage, now: NOW_MS }), null);
    assert.equal(writeUpgradeIntent(INTENT('withdrawing'), { storage }), false);
    assert.doesNotThrow(() => clearUpgradeIntent({ storage }));
    // The upgrade still works: the facts say withdrawing and then ready.
    const intent = readUpgradeIntent({ network: 'mainnet', storage, now: NOW_MS });
    const during = derive({ snapshot: note({ hasPreparedWithdrawal: true }), intent });
    assert.equal(during.upgrade.stage, 'withdrawing');
    const after = derive({
        snapshot: normalizedSnapshot(),
        intent,
        previewSelection: selectionFor(V2, { reason: 'no_runtime_note', slotOwner: null, slotKind: 'empty' })
    });
    assert.equal(after.upgrade.stage, 'ready_to_switch');
    assert.equal(after.reload.reason, 'previous_withdrawal_finished');
    // On the target there is no way to know it was an upgrade: the ordinary
    // deposit flow takes over, which is correct and loses nothing.
    const target = derive({ active: V2, selection: selectionFor(V2, { reason: 'no_runtime_note', slotOwner: null }), intent });
    assert.equal(target.upgrade.stage, 'idle');
    assert.equal(target.gate.canStart, true);
});

test('a persisted intent round trips and expires like the storage layer says', () => {
    const storage = memoryStorage();
    assert.equal(writeUpgradeIntent(INTENT('withdrawn', { since: NOW_MS }), { storage }), true);
    const intent = readUpgradeIntent({ network: 'mainnet', storage, now: NOW_MS + 1000 });
    assert.deepEqual(intent, INTENT('withdrawn', { since: NOW_MS }));
    assert.equal(derive({
        active: V2, selection: selectionFor(V2, { reason: 'no_runtime_note', slotOwner: null }), intent
    }).upgrade.stage, 'deposit');
    // Another network's intent is invisible; an old one is gone.
    assert.equal(readUpgradeIntent({ network: 'sepolia', storage, now: NOW_MS + 1000 }), null);
    assert.equal(readUpgradeIntent({ network: 'mainnet', storage, now: NOW_MS + 46 * DAY * 1000 }), null);
    clearUpgradeIntent({ storage });
    assert.equal(readUpgradeIntent({ network: 'mainnet', storage, now: NOW_MS + 1000 }), null);
});

// ---------------------------------------------------------------------------
// Rendering and timers cause no work
// ---------------------------------------------------------------------------

test('rendering and clock ticks only compute: inputs are untouched and results are fresh objects', () => {
    const snapshot = note({ hasOpenWithdrawal: true });
    const freeze = value => {
        if (value && typeof value === 'object' && !Object.isFrozen(value)) {
            Object.freeze(value);
            for (const key of Object.keys(value)) freeze(value[key]);
        }
        return value;
    };
    freeze(snapshot);
    const intent = freeze(INTENT('withdrawing'));
    const outputs = [];
    for (let tick = 0; tick < 50; tick += 1) {
        // A tick every second, then a jump past close-by and past expiry.
        outputs.push(derive({ snapshot, intent, now: NOW_MS + tick * 1000 }));
    }
    outputs.push(derive({ snapshot, intent, now: NOW_MS + 8 * DAY * 1000 }));
    outputs.push(derive({ snapshot, intent, now: NOW_MS + 11 * DAY * 1000 }));
    assert.equal(outputs[0].phase, 'withdrawing');
    assert.equal(outputs.at(-1).phase, 'withdrawing');
    // Every output is its own object: mutating one cannot reach another call.
    outputs[0].gate.canStart = true;
    outputs[0].upgrade.stage = 'done';
    assert.equal(outputs[1].gate.canStart, false);
    assert.equal(derive({ snapshot, intent }).upgrade.stage, 'withdrawing');
});

test('the flow and state modules take plain data only: no SDK, storage, network or clock', () => {
    for (const file of ['upgradeFlow.mjs', 'versionState.mjs']) {
        const source = fs.readFileSync(new URL(`../../chat/zkapi/versioning/${file}`, import.meta.url), 'utf8');
        assert.equal(/zkapi-browser-sdk/.test(source), false, file);
        for (const forbidden of ['Date.now', 'localStorage', 'sessionStorage', 'indexedDB', 'fetch(', 'document.',
            'window.', 'location.', 'navigator', 'setTimeout', 'setInterval', 'postMessage', 'BroadcastChannel']) {
            assert.equal(source.includes(forbidden), false, `${file} must not use ${forbidden}`);
        }
    }
});
