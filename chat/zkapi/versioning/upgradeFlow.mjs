// The guided upgrade, as a function of facts (docs/ZKAPI_VERSIONING.md,
// "Guided upgrade stages").
//
// There is no event log. The stage is derived on every call from what the SDK
// and the wallet database say right now, plus one persisted intent that only
// records "this browser started an upgrade from X to Y". A lost intent
// therefore never strands anyone: without it the stage falls back to `idle`
// and the ordinary banner and withdraw controls still work.
//
// Pure module: no DOM, storage, network, clock or SDK. Nothing here signs,
// broadcasts, deposits or reloads; the stage only tells the UI which step to
// narrate. Every step stays a user gesture.

/**
 * @typedef {'idle'|'review'|'withdrawing'|'confirming'|'ready_to_switch'|'deposit'|'done'|'blocked'} UpgradeStage
 */

// The three steps the upgrade view draws, in order. The ids are the
// `[data-upgrade-step]` hooks of the view.
export const UPGRADE_STEPS = Object.freeze([
    Object.freeze({ id: 'withdraw', label: 'Withdraw' }),
    Object.freeze({ id: 'reload', label: 'Reload' }),
    Object.freeze({ id: 'deposit', label: 'Deposit' })
]);

const INTENT_STAGES = new Set(['withdrawing', 'withdrawn', 'depositing']);

// Intent stages that say the withdrawal is over. Only these may put the
// "Your balance is withdrawn" step in front of someone on the target: a bare
// `withdrawing` intent proves a withdrawal was STARTED, and a balance that
// expired, was claimed and archived inside the intent's lifetime lands on the
// target just as empty. That person is forfeited, not withdrawn, and gets the
// ordinary deposit flow.
const WITHDRAWN_INTENT_STAGES = new Set(['withdrawn', 'depositing']);

// Withdrawal record phases in which the on-chain action has happened and the
// SDK is only waiting to see it confirmed (it re-reads every 15 s). Everything
// else that is open still has a step for the user or the wallet to take, so an
// unknown phase is shown as `withdrawing`, which keeps the full withdrawal
// journey (and its recovery buttons) in front of the user.
const CONFIRMING_PHASES = new Set([
    'closed_unconfirmed',
    'submitted_unconfirmed',
    'challenged_unconfirmed',
    'recovery_unconfirmed',
    'finalizing'
]);

// Phases of records that are not an upgrade withdrawal in motion: a closed
// record, and notes set aside or restored (those hold a balance, they do not
// move it).
const NOT_IN_FLIGHT_PHASES = new Set(['closed', 'parked', 'restored', 'canceled']);

const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * Whether an upgrade intent's stage is proof that the upgrade's withdrawal is
 * over (`withdrawn` or `depositing`). A bare `withdrawing` intent is not: it is
 * what merely opening the review step writes. The one definition the facade,
 * the reload reason and the wording share, so none of them can claim "your
 * balance is back" on weaker evidence than the others.
 *
 * @param {object|null|undefined} intent
 * @returns {boolean}
 */
export function intentProvesWithdrawal(intent) {
    return isRecord(intent) && WITHDRAWN_INTENT_STAGES.has(intent.stage);
}

// An intent is only honored when it names two different versions and a stage
// this module knows. The storage layer validates and expires it as well; this
// is the second line for an intent that reaches us some other way.
function usableIntent(intent) {
    if (!isRecord(intent)) return null;
    if (typeof intent.from !== 'string' || !intent.from) return null;
    if (typeof intent.to !== 'string' || !intent.to) return null;
    if (intent.from === intent.to) return null;
    if (!INTENT_STAGES.has(intent.stage)) return null;
    return intent;
}

/**
 * The stage of the guided upgrade.
 *
 * `versionState` is deriveVersionState's result before its `upgrade` field
 * exists (the stage is part of that field, so it cannot depend on it).
 * `viewOpen` is whether the upgrade view is on screen; it is the only input
 * that makes `review`. `withdrawalPhase` is the phase of the SDK's current
 * withdrawal record, or null; it separates `withdrawing` from `confirming`.
 *
 * Reading order, first match wins:
 *   a balance this page holds but cannot read (the SDK did not start)   idle
 *   on the deposit target
 *     no intent for this target, or a withdrawal here    idle
 *     note in the target                                 done
 *     intent still `withdrawing` (no proof it finished)  idle
 *     deposits blocked and nothing started               blocked
 *     otherwise                                          deposit
 *   on a version that no longer takes deposits
 *     nothing to move to                                 idle
 *     holdings empty and a fresh load picks the target   ready_to_switch
 *     a withdrawal is in flight                          withdrawing | confirming
 *     expired, unsent plan, started deposit, set-aside   blocked
 *     nothing held                                       idle
 *     upgrade view open                                  review
 *     otherwise                                          idle
 *
 * @param {{versionState: object, intent?: object|null, viewOpen?: boolean,
 *   withdrawalPhase?: string|null}} input
 * @returns {UpgradeStage}
 */
export function deriveUpgradeStage(input) {
    const options = isRecord(input) ? input : {};
    const state = isRecord(options.versionState) ? options.versionState : null;
    if (!state || state.show !== true) return 'idle';
    const current = isRecord(state.current) ? state.current : null;
    const target = isRecord(state.target) ? state.target : null;
    if (!current || typeof current.id !== 'string' || !current.id) return 'idle';
    // Nothing newer exists to move to (deposits unavailable, or this is the
    // only live version).
    if (!target) return 'idle';
    // The balance is held and cannot be read: there is no withdrawal to
    // narrate, none can start, and nothing about the balance (a note in the
    // target, an expired one) is known. The state says why
    // (`upgrade.blockedBy` is `service_unreachable`) and its own notice carries
    // the one action there is.
    if (isRecord(state.held) && state.held.unreachable === true) return 'idle';

    const intent = usableIntent(options.intent);
    const gate = isRecord(state.gate) ? state.gate : {};
    const holding = state.holding;

    if (target.id === current.id) {
        // On the deposit target. Only an upgrade this browser started toward
        // this exact version has a stage here.
        if (!intent || intent.to !== current.id) return 'idle';
        // A withdrawal in motion on the target is not a step of an upgrade
        // toward it, and its funds are not a deposited note.
        if (state.phase === 'withdrawing') return 'idle';
        // The note is in the target: the upgrade is complete. This keys off
        // holdings, never off a balance that merely exists. Any intent toward
        // this version qualifies (the sentence only says where the balance
        // is), so the facade clears even a stale `withdrawing` intent on the
        // first deposit instead of leaving it for its whole lifetime.
        if (holding === 'current') return 'done';
        if (!WITHDRAWN_INTENT_STAGES.has(intent.stage)) return 'idle';
        // Nothing can be deposited and nothing was started: say so instead of
        // offering a step that cannot work.
        if (gate.canStart !== true && gate.canResume !== true) return 'blocked';
        return 'deposit';
    }

    // On a version that no longer takes deposits.
    const reload = isRecord(state.reload) ? state.reload : {};
    if (reload.required === true && reload.targetId === target.id && holding === 'none') {
        return 'ready_to_switch';
    }

    const phase = typeof options.withdrawalPhase === 'string' && options.withdrawalPhase
        ? options.withdrawalPhase : null;
    const inFlight = state.phase === 'withdrawing' || (phase !== null && !NOT_IN_FLIGHT_PHASES.has(phase));
    if (inFlight) return phase !== null && CONFIRMING_PHASES.has(phase) ? 'confirming' : 'withdrawing';

    if (state.phase === 'expired' || state.unsent === true || gate.canResume === true
        || state.phase === 'finish-previous-withdrawal') {
        return 'blocked';
    }
    if (holding === 'none') return 'idle';
    return options.viewOpen === true ? 'review' : 'idle';
}

/**
 * The three steps with their progress, for the view's step list. `blocked`
 * has no honest current step, so every step stays upcoming.
 *
 * @param {UpgradeStage} stage
 * @returns {Array<{id: 'withdraw'|'reload'|'deposit', label: string, state: 'done'|'current'|'upcoming'}>}
 */
export function upgradeStepStates(stage) {
    // Index of the current step; steps before it are done. 3 means all done,
    // -1 means none has begun.
    const index = {
        idle: -1,
        blocked: -1,
        review: 0,
        withdrawing: 0,
        confirming: 0,
        ready_to_switch: 1,
        deposit: 2,
        done: 3
    }[stage];
    const position = index === undefined ? -1 : index;
    return UPGRADE_STEPS.map((step, stepIndex) => ({
        id: step.id,
        label: step.label,
        state: stepIndex < position ? 'done' : stepIndex === position ? 'current' : 'upcoming'
    }));
}
