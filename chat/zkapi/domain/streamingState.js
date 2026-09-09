export function normalizePendingPhase(phase) {
    if (phase === 'settling-previous') return 'settling-previous';
    return phase === 'requesting-key' || phase === 'waiting'
        ? 'requesting-key'
        : 'waiting-response';
}

const ACCESS_STEPS = Object.freeze([
    Object.freeze({ id: 'activity', label: 'Check unfinished private activity' }),
    Object.freeze({ id: 'vault', label: 'Read latest private vault state' }),
    Object.freeze({ id: 'proof', label: 'Generate funding proof' }),
    Object.freeze({ id: 'key', label: 'Create temporary chat key' }),
    Object.freeze({ id: 'verify', label: 'Verify with Open Anonymity' })
]);

const RENEWAL_STEPS = Object.freeze([
    Object.freeze({ id: 'close', label: 'Close current temporary key' }),
    Object.freeze({ id: 'usage', label: 'Confirm its final usage' }),
    Object.freeze({ id: 'balance', label: 'Update private balance' }),
    ...ACCESS_STEPS
]);

const SETTLEMENT_STEPS = Object.freeze([
    Object.freeze({ id: 'close', label: 'Close previous chat key' }),
    Object.freeze({ id: 'usage', label: 'Confirm final usage' }),
    Object.freeze({ id: 'balance', label: 'Update private balance' })
]);

const RECOVERY_STEPS = Object.freeze([
    Object.freeze({ id: 'close', label: 'Finish unfinished key' }),
    Object.freeze({ id: 'usage', label: 'Confirm its usage' }),
    Object.freeze({ id: 'balance', label: 'Update private balance' })
]);

function stepsAt(steps, activeIndex, activeState = 'active') {
    return steps.map((step, index) => ({
        ...step,
        state: index < activeIndex
            ? 'complete'
            : index === activeIndex
                ? activeState
                : 'upcoming'
    }));
}

function completedSteps(steps) {
    return steps.map(step => ({ ...step, state: 'complete' }));
}

function retryCopy(message) {
    const value = String(message || '').trim();
    if (/^(?:OA is briefly limiting new temporary keys|The temporary-key service is briefly unavailable)\. Retrying in (?:a moment|\d+ (?:second|seconds|minute|minutes))…$/.test(value)) {
        return value;
    }
    return 'Waiting briefly before retrying temporary key creation…';
}

function terminalStep(progress, phaseSteps, stepCount, fallback = 0) {
    const fromPhase = phaseSteps[progress.failedPhase];
    const candidate = Number.isInteger(fromPhase)
        ? fromPhase
        : Number.isFinite(Number(progress.stepIndex))
            ? Number(progress.stepIndex)
            : fallback;
    return Math.min(Math.max(0, candidate), Math.max(0, stepCount - 1));
}

const ACCESS_PHASE_STEPS = Object.freeze({
    starting: 0,
    checking: 0,
    syncing: 1,
    proving: 2,
    requesting: 3,
    waiting: 3,
    verifying: 4,
    ready: ACCESS_STEPS.length
});

const RENEWAL_PHASE_STEPS = Object.freeze({
    starting: 0,
    settling: 0,
    usage: 1,
    applying: 2,
    checking: 3,
    syncing: 4,
    proving: 5,
    requesting: 6,
    waiting: 6,
    verifying: 7,
    ready: RENEWAL_STEPS.length
});

const SETTLEMENT_PHASE_STEPS = Object.freeze({
    settling: 0,
    usage: 1,
    applying: 2
});

function accessPresentation(progress = {}) {
    const phase = progress.phase || 'starting';
    const presentations = {
        starting: ['Preparing private access…', 0, 'active'],
        checking: ['Checking for unfinished private activity…', 0, 'active'],
        syncing: ['Reading the latest private vault state…', 1, 'active'],
        proving: ['Generating a zero-knowledge funding proof…', 2, 'active'],
        requesting: ['Creating a temporary key for this chat…', 3, 'active'],
        waiting: [retryCopy(progress.message), 3, 'waiting'],
        verifying: ['Verifying private access with Open Anonymity…', 4, 'active'],
        ready: ['Private access secured · sending your message…', ACCESS_STEPS.length, 'complete'],
        error: ['Could not secure private access', terminalStep(progress, ACCESS_PHASE_STEPS, ACCESS_STEPS.length), 'error'],
        canceled: ['Stopped before the model request was sent', terminalStep(progress, ACCESS_PHASE_STEPS, ACCESS_STEPS.length), 'canceled']
    };
    const [current, activeIndex, state] = presentations[phase] || presentations.starting;
    return {
        mode: 'security',
        kind: 'access',
        category: 'Private access',
        current,
        description: phase === 'ready'
            ? 'Private access secured. Sending your message.'
            : `Securing private access. ${current}`,
        progressPhase: phase,
        steps: activeIndex >= ACCESS_STEPS.length
            ? completedSteps(ACCESS_STEPS)
            : stepsAt(ACCESS_STEPS, activeIndex, state),
        note: phase === 'proving'
            ? 'The proof is generated on this device and shows the chat is funded without revealing your exact balance.'
            : 'A zero-knowledge proof is exchanged for a time-limited, spending-capped key used only by this chat.'
    };
}

function renewalPresentation(progress = {}) {
    const phase = progress.phase || 'starting';
    const presentations = {
        starting: ['Refreshing private access…', 0, 'active'],
        settling: ['Closing the current temporary key…', 0, 'active'],
        usage: ['Confirming the key’s final usage…', 1, 'active'],
        applying: ['Updating your private balance…', 2, 'active'],
        checking: ['Checking for unfinished private activity…', 3, 'active'],
        syncing: ['Reading the latest private vault state…', 4, 'active'],
        proving: ['Generating a fresh zero-knowledge funding proof…', 5, 'active'],
        requesting: ['Creating a fresh temporary key for this chat…', 6, 'active'],
        waiting: [retryCopy(progress.message), 6, 'waiting'],
        verifying: ['Verifying refreshed access with Open Anonymity…', 7, 'active'],
        ready: ['Private access refreshed · sending your message…', RENEWAL_STEPS.length, 'complete'],
        error: ['Could not refresh private access', terminalStep(progress, RENEWAL_PHASE_STEPS, RENEWAL_STEPS.length), 'error'],
        canceled: ['Private-access refresh stopped', terminalStep(progress, RENEWAL_PHASE_STEPS, RENEWAL_STEPS.length), 'canceled']
    };
    const [current, activeIndex, state] = presentations[phase] || presentations.starting;
    return {
        mode: 'security',
        kind: 'renewal',
        category: 'Refreshing private access',
        current,
        description: phase === 'ready'
            ? 'Private access refreshed. Sending your message.'
            : `Refreshing private access. ${current}`,
        progressPhase: phase,
        steps: activeIndex >= RENEWAL_STEPS.length
            ? completedSteps(RENEWAL_STEPS)
            : stepsAt(RENEWAL_STEPS, activeIndex, state),
        note: phase === 'proving'
            ? 'A fresh proof is generated on this device after the earlier key’s final usage is applied.'
            : 'The earlier spending-capped key is closed before this chat receives fresh private access.'
    };
}

function settlementPresentation(progress = {}, { recovery = false } = {}) {
    const phase = progress.phase || 'settling';
    const steps = recovery ? RECOVERY_STEPS : SETTLEMENT_STEPS;
    const presentations = {
        settling: [
            recovery ? 'Finishing an unfinished private key…' : 'Closing the previous chat key…',
            0,
            'active'
        ],
        usage: [
            recovery ? 'Confirming the unfinished key’s usage…' : 'Confirming the previous chat’s usage…',
            1,
            'active'
        ],
        applying: ['Updating your private balance…', 2, 'active'],
        complete: ['Previous chat finished · preparing fresh access…', steps.length, 'complete'],
        ready: ['Previous chat finished · preparing fresh access…', steps.length, 'complete'],
        requesting: [recovery ? 'Re-opening the unfinished key so it can close safely…' : 'Closing the previous chat key…', 0, 'waiting'],
        waiting: [recovery ? 'Waiting to finish the unfinished key…' : 'Waiting to close the previous chat key…', 0, 'waiting'],
        verifying: [recovery ? 'Verifying the unfinished key before closing it…' : 'Verifying the previous chat key…', 0, 'active'],
        error: [
            recovery ? 'The unfinished key needs attention' : 'The previous chat could not finish',
            terminalStep(progress, SETTLEMENT_PHASE_STEPS, steps.length),
            'error'
        ],
        canceled: ['Private-key settlement stopped', terminalStep(progress, SETTLEMENT_PHASE_STEPS, steps.length), 'canceled']
    };
    const [current, activeIndex, state] = presentations[phase] || presentations.settling;
    return {
        mode: 'security',
        kind: recovery ? 'recovery' : 'settlement',
        category: recovery ? 'Private access recovery' : 'Finishing previous chat',
        current,
        description: `${recovery ? 'Recovering private access' : 'Finishing the previous private chat'}. ${current}`,
        progressPhase: phase,
        steps: activeIndex >= steps.length
            ? completedSteps(steps)
            : stepsAt(steps, activeIndex, state),
        note: recovery
            ? 'The browser is safely reconciling an unfinished key before it creates new private access.'
            : 'Your message is accepted and will send automatically after the previous key closes and its usage is applied.'
    };
}

/**
 * Maps the coarse send lifecycle plus truthful zkAPI progress into UI copy.
 * Detailed proof/key phases deliberately stay separate from the coarse phase:
 * passing `proving` to normalizePendingPhase() would incorrectly mean Thinking.
 */
export function derivePendingIndicatorPresentation(phase, progress = null) {
    const normalizedPhase = normalizePendingPhase(phase);
    if (normalizedPhase === 'waiting-response') {
        return {
            mode: 'thinking',
            current: 'Thinking',
            description: 'Message sent. Waiting for the response.',
            progressPhase: 'waiting-response',
            steps: []
        };
    }

    const details = progress || {};
    if (details.kind === 'recovery') {
        return settlementPresentation(details, { recovery: true });
    }
    if (details.kind === 'renewal'
        || (details.kind === 'access' && ['settling', 'usage', 'applying'].includes(details.phase))) {
        return renewalPresentation(details);
    }
    if (normalizedPhase === 'settling-previous' || details.kind === 'settlement') {
        return settlementPresentation(details);
    }
    return accessPresentation(details);
}
