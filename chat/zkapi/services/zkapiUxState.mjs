import { copyTokens, versionCopyText } from '../versioning/copy.mjs';
import { zkapiErrorMessage } from './zkapiErrorCopy.mjs';

export const ZKAPI_UX_PROPOSALS = Object.freeze([
    'quiet',
    'guided',
    'activity',
    'receipt',
    'relay',
    'ambient',
    'capsule'
]);

// The words of a balance that is frozen by an exit lock (a released proof that
// can still land) and has no withdrawal of its own to finish. The sentence is
// the one the balance dialog's notice uses (versioning/copy.mjs); the title,
// the label of the glance surfaces and the three steps only name what it says.
//
// A frozen balance that another device or copy has since used is told the
// device sentence instead (versioning/copy.mjs, 'exit.device'): the frozen
// sentence ends "You can still withdraw", and a withdrawal from this browser
// would be rejected. Its steps promise no resume: the copy this browser holds
// is out of date, so waiting is not the way on; the copy that used the balance
// last is.
const FROZEN_WORDS = Object.freeze({
    title: 'Balance frozen',
    steps: Object.freeze([
        Object.freeze({ id: 'started', label: 'Withdrawal started' }),
        Object.freeze({ id: 'frozen', label: 'Balance frozen' }),
        Object.freeze({ id: 'resume', label: 'Chats resume' })
    ]),
    deviceNextStep: 'Use the newest copy'
});

const RUNNING_STATUSES = new Set(['running', 'waiting']);
const ACCESS_PHASES = new Set(['checking', 'syncing', 'proving', 'requesting', 'verifying']);

export function normalizeZkapiUxProposal(value) {
    return ZKAPI_UX_PROPOSALS.includes(value) ? value : 'quiet';
}

export function isRunningActivity(activity) {
    return RUNNING_STATUSES.has(activity?.status);
}

function latest(items, predicate = () => true) {
    for (let index = items.length - 1; index >= 0; index -= 1) {
        if (predicate(items[index])) return items[index];
    }
    return null;
}

function describeActivity(activity) {
    const fallback = {
        access: ['Starting private chat', 'Preparing private access for this conversation.'],
        settlement: ['Finishing previous chat', 'Closing its temporary key and updating your private balance.'],
        deposit: ['Adding funds', 'Follow the current step in your Ethereum wallet.'],
        withdraw: ['Returning your balance', 'Preparing the withdrawal and its private proof.'],
        escape: ['Starting account recovery', 'Preparing the escape-hatch transaction.'],
        'escape-finalize': ['Finishing account recovery', 'Returning the balance to your Ethereum wallet.'],
        'withdraw-sync': ['Checking withdrawal', 'Reading the latest on-chain status.'],
        token: ['Updating your Ethereum wallet', 'Follow the current step in your Ethereum wallet.'],
        refresh: ['Refreshing balance', 'Reading the latest private balance.']
    }[activity?.kind] || ['Working securely', 'Finishing a private payment step.'];

    return {
        title: activity?.title || fallback[0],
        detail: activity?.message || fallback[1]
    };
}

function settlementState(transition) {
    if (!transition) return null;
    const states = {
        settling: {
            phase: 'closing',
            tone: 'working',
            title: 'Finishing previous chat',
            detail: 'Updating what you spent in the previous chat. New messages can send when this finishes.',
            compact: 'Finishing previous chat',
            busy: true,
            blocksSend: false
        },
        waiting: {
            phase: 'queued',
            tone: 'working',
            title: 'Message queued',
            detail: 'It will send automatically as soon as the previous chat finishes closing.',
            compact: 'Message queued · finishing previous chat',
            busy: true,
            blocksSend: true
        },
        ready: {
            phase: 'ready',
            tone: 'success',
            title: 'Ready for a new chat',
            detail: 'Your previous chat is closed. A fresh private key will be created when you send.',
            compact: 'Previous chat finished',
            busy: false,
            blocksSend: false
        },
        error: {
            phase: 'error',
            tone: 'error',
            title: 'Previous chat needs attention',
            detail: transition.message || 'Unable to finish the previous chat. Your recovery record is saved. Retry when the temporary-key service is available.',
            compact: 'Previous chat needs attention',
            busy: false,
            blocksSend: true
        }
    };
    return states[transition.phase] || null;
}

function activityState(activity) {
    if (!activity) return null;
    const copy = describeActivity(activity);
    const failed = activity.status === 'error';
    const complete = activity.status === 'success';
    const canceled = activity.status === 'canceled';
    return {
        phase: failed ? 'error' : complete ? 'ready' : canceled ? 'canceled' : activity.phase || 'working',
        tone: failed ? 'error' : complete ? 'success' : canceled ? 'neutral' : 'working',
        title: failed ? `${copy.title} needs attention` : copy.title,
        detail: failed ? (activity.error || copy.detail) : copy.detail,
        compact: failed ? `${copy.title} failed` : copy.title,
        busy: isRunningActivity(activity),
        blocksSend: Boolean(activity.blocksSend && isRunningActivity(activity)),
        activity
    };
}

function operationJourney(activity) {
    if (!activity) return null;
    const message = String(activity.message || '');
    const at = (...patterns) => patterns.some(pattern => pattern.test(message));
    switch (activity.kind) {
        case 'deposit':
            return {
                steps: [
                    { id: 'wallet', label: 'Connect wallet' },
                    { id: 'confirm', label: 'Confirm deposit' },
                    { id: 'note', label: 'Save private note' }
                ],
                activeIndex: at(/saving/i, /private balance/i, /ready/i) ? 2 : at(/connect/i) ? 0 : 1
            };
        case 'withdraw':
        case 'escape':
            return {
                steps: [
                    { id: 'settle', label: 'Finish active chat' },
                    { id: 'proof', label: activity.kind === 'escape' ? 'Create escape proof' : 'Create close proof' },
                    { id: 'confirm', label: activity.kind === 'escape' ? 'Start safety window' : 'Return balance' }
                ],
                activeIndex: at(/settling/i, /active chat/i, /temporary key/i)
                    ? 0
                    : at(/proof/i, /clearance/i, /merkle/i)
                        ? 1
                        : 2
            };
        case 'escape-finalize':
            return {
                steps: [
                    { id: 'window', label: 'Safety window complete' },
                    { id: 'confirm', label: 'Confirm finalization' },
                    { id: 'return', label: 'Return balance' }
                ],
                activeIndex: at(/archived/i, /returned/i, /complete/i) ? 2 : 1
            };
        case 'refresh':
        case 'withdraw-sync':
            return {
                steps: [
                    { id: 'chain', label: 'Read chain' },
                    { id: 'sync', label: 'Sync private state' },
                    { id: 'ready', label: 'Up to date' }
                ],
                activeIndex: at(/complete/i, /refreshed/i, /active again/i) ? 2 : at(/sync/i) ? 1 : 0
            };
        default:
            return null;
    }
}

// The state of a frozen balance. It keeps the phase of a withdrawal so the
// surfaces that wait on one (the panel's status badge, the balance control, the
// composer's hold glyph) treat it as one; `frozen` is what tells the journey
// and a reader that nothing is prepared, and `deviceNotNewest` that the way on
// is not a wait.
function frozenState(words) {
    return {
        phase: 'withdrawal',
        tone: 'waiting',
        frozen: true,
        ...(words.deviceNotNewest === true ? { deviceNotNewest: true } : {}),
        title: words.title,
        detail: words.detail,
        compact: words.compact,
        busy: false,
        blocksSend: true
    };
}

// The words for a balance the version facade says is frozen, or null. Said
// only for a balance in the wallet with no withdrawal of its own in any form
// (the dialog's own rule): a prepared plan, a submitted transaction, a late
// attempt or a pending escape each have words that say what to do next, and a
// frozen notice would hide them. `version` is the facade's VersionState, which
// only a build with versions to tell apart has; anything else says nothing.
//
// A balance this browser can not withdraw (another device or copy used it
// since) is told that instead, as the dialog's banner does (its frozen notice
// steps aside for the device notice, VersionNotices `cannotWithdrawHere`): the
// frozen sentence ends "You can still withdraw", which would send the person
// to a withdrawal that is rejected. The lock still holds chats, so sending
// stays blocked.
function frozenCopy(version, { note, withdrawal, now }) {
    if (!note || withdrawal) return null;
    const exit = version !== null && typeof version === 'object' && !Array.isArray(version) ? version.exit : null;
    const frozen = exit !== null && typeof exit === 'object' && !Array.isArray(exit) ? exit.frozen : null;
    if (frozen === null || typeof frozen !== 'object' || Array.isArray(frozen)) return null;
    const tokens = copyTokens(version, { now });
    if (exit.deviceNotNewest === true) {
        const title = versionCopyText('exit.device.label', tokens);
        const detail = versionCopyText('exit.device', tokens);
        return title && detail ? { title, detail, compact: title, deviceNotNewest: true } : null;
    }
    const detail = versionCopyText('exit.frozen', tokens);
    return detail ? { title: FROZEN_WORDS.title, detail, compact: FROZEN_WORDS.title } : null;
}

// The words for the SDK's failure to start when the version facade says the
// wallet holds a balance this page therefore cannot read: the balance is saved,
// and the service of its version is not available. The SDK's own message names
// the operator's address and would stand in the chat bar and on the balance
// control. null for any other state, which keeps the SDK's message.
function heldWords(version) {
    const held = version !== null && typeof version === 'object' && !Array.isArray(version) ? version.held : null;
    if (held === null || typeof held !== 'object' || Array.isArray(held) || held.unreachable !== true) return null;
    return versionCopyText('held.summary') || null;
}

function buildJourney(primary, transition, activity) {
    const isHandoff = Boolean(transition) || activity?.kind === 'settlement';
    const needsFunding = ['unfunded', 'loading'].includes(primary.phase);
    const operation = operationJourney(activity);
    let steps = operation?.steps || (needsFunding
        ? [
            { id: 'fund', label: 'Add funds' },
            { id: 'balance', label: 'Verify balance' },
            { id: 'ready', label: 'Ready' }
        ]
        : isHandoff
        ? [
            { id: 'close', label: 'Finish previous chat' },
            { id: 'balance', label: 'Update balance' },
            { id: 'access', label: 'Start private chat' }
        ]
        : [
            { id: 'balance', label: 'Verify balance' },
            { id: 'access', label: 'Create private key' },
            { id: 'ready', label: 'Ready' }
        ]);

    let activeIndex = operation?.activeIndex ?? 0;
    if (operation) {
        // The operation supplies its own truthful phase mapping.
    } else if (primary.frozen === true && primary.deviceNotNewest === true) {
        // Nothing is prepared, nothing here can finish this balance and
        // nothing is promised to resume: it was used elsewhere, and the way on
        // is the copy that used it last.
        steps = [
            { id: 'used', label: primary.title },
            { id: 'newest', label: FROZEN_WORDS.deviceNextStep }
        ];
        activeIndex = 1;
    } else if (primary.frozen === true) {
        // Nothing is prepared and nothing is to finish: the withdrawal started,
        // the balance waits, and chats come back.
        steps = FROZEN_WORDS.steps.map(step => ({ ...step }));
        activeIndex = 1;
    } else if (primary.phase === 'withdrawal') {
        steps = [
            { id: 'prepare', label: 'Withdrawal prepared' },
            { id: 'confirm', label: 'Finish in your Ethereum wallet' },
            { id: 'sync', label: 'Update balance' }
        ];
        activeIndex = 1;
    } else if (primary.phase === 'escape-wait') {
        steps = [
            { id: 'start', label: 'Recovery started' },
            { id: 'window', label: 'Safety window' },
            { id: 'finalize', label: 'Finalize withdrawal' }
        ];
        activeIndex = 1;
    } else if (needsFunding) {
        activeIndex = 0;
    } else if (isHandoff) {
        if (transition?.phase === 'ready' || activity?.phase === 'applying') activeIndex = 1;
        if (activity?.kind === 'access' || ACCESS_PHASES.has(activity?.phase)) activeIndex = 2;
        if (primary.phase === 'ready' && activity?.kind === 'access') activeIndex = 2;
    } else {
        // A retry wait still belongs to temporary-key creation. Do not jump
        // back to the balance-verification step while OA is throttling keys.
        if (activity?.kind === 'access'
            && ['requesting', 'waiting', 'verifying'].includes(activity?.phase)) activeIndex = 1;
        if (primary.phase === 'ready') activeIndex = 2;
    }

    const activeState = primary.tone === 'error'
        ? 'error'
        : ['ready', 'chat-ready'].includes(primary.phase)
            ? 'complete'
            : 'active';
    return steps.map((step, index) => ({
        ...step,
        state: index < activeIndex
                ? 'complete'
                : index === activeIndex
                    ? activeState
                    : 'upcoming'
    }));
}

// `version` is the version facade's state (VersionState) on a build that has
// versions to tell apart, and null otherwise. It adds two things: a balance the
// facade says is frozen, with no withdrawal of its own, is said to be frozen,
// and a balance that is held but cannot be read (the SDK did not start) is
// said in plain words instead of in the SDK's error.
export function deriveZkapiUxState({ snapshot = {}, transition = null, sessionId = null, now = Date.now(), version = null } = {}) {
    const activities = Array.isArray(snapshot.activities) ? snapshot.activities : [];
    const running = activities.filter(isRunningActivity);
    const currentActivity = latest(running, activity => !activity.sessionId || !sessionId || activity.sessionId === sessionId)
        || latest(running);
    const matchingActivity = predicate => latest(running, activity => predicate(activity)
        && (!activity.sessionId || !sessionId || activity.sessionId === sessionId))
        || latest(running, predicate);
    const accessActivity = matchingActivity(activity => activity.kind === 'access');
    const settlementActivity = matchingActivity(activity => activity.kind === 'settlement');
    const walletActivity = matchingActivity(activity => !['access', 'settlement'].includes(activity.kind));
    const recentError = latest(activities, activity => activity.status === 'error'
        && now - Number(activity.finishedAt || activity.updatedAt || 0) < 120_000);
    const note = snapshot.wallet?.note || null;
    const pendingDeposit = snapshot.config?.pending_deposit || null;
    const withdrawal = snapshot.withdrawal;
    const preparedWithdrawal = snapshot.config?.prepared_withdrawal;
    const lateWithdrawal = (snapshot.config?.late_withdrawal_attempts || []).find(attempt =>
        Number(attempt.note_id) === Number(note?.note_id));
    const escapeWaiting = withdrawal?.phase === 'pending';
    const withdrawalBlocking = Boolean(preparedWithdrawal
        || lateWithdrawal
        || ['prepared', 'submitted', 'pending'].includes(withdrawal?.phase));
    const lateWithdrawalNeedsAttention = Boolean(lateWithdrawal?.error)
        || lateWithdrawal?.status === 'receipt_mismatch';
    const withdrawalPhase = lateWithdrawal
        ? 'late_submitted'
        : preparedWithdrawal?.phase || withdrawal?.phase;
    const withdrawalCopy = withdrawalPhase === 'submitted'
        ? {
            title: 'Withdrawal submitted',
            detail: 'Confirming on chain. This balance updates on its own.',
            compact: 'Withdrawal submitted'
        }
        : withdrawalPhase === 'dropped_or_pending'
            ? {
                title: 'Withdrawal receipt not found',
                detail: preparedWithdrawal?.replacement_available
                    ? 'Check again, or safely resubmit the exact withdrawal with its original nonce.'
                    : 'Check or cancel the pending transaction in your Ethereum wallet, then check again.',
                compact: 'Check withdrawal'
            }
        : withdrawalPhase === 'late_submitted'
            ? {
                title: lateWithdrawalNeedsAttention
                    ? 'Withdrawal needs attention'
                    : 'Checking submitted withdrawal',
                detail: lateWithdrawalNeedsAttention
                    ? lateWithdrawal.error || 'The saved transaction did not match this withdrawal. Open Payment history to recheck the vault.'
                    : 'A wallet window returned after this tab changed state. The message will stay paused until the chain check completes.',
                compact: lateWithdrawalNeedsAttention
                    ? 'Check withdrawal'
                    : 'Checking withdrawal'
            }
        : withdrawalPhase === 'awaiting_wallet'
            ? {
                title: 'Waiting for your Ethereum wallet',
                detail: 'Confirm the wallet prompt, or recover it from Withdraw if it was closed.',
                compact: 'Waiting for your Ethereum wallet'
            }
            : withdrawalPhase === 'ambiguous'
                ? {
                    title: 'Withdrawal status unknown',
                    detail: 'Check the vault before explicitly retrying the transaction.',
                    compact: 'Check withdrawal'
                }
            : {
                title: 'Withdrawal paused',
                detail: 'Nothing has been sent. Continue it from Withdraw, or set this balance aside.',
                compact: 'Withdrawal paused'
            };
    // Last in line behind every withdrawal in motion (the chains below ask for
    // those first), so a plan, a transaction or a pending escape keeps its words.
    const frozenWords = frozenCopy(version, { note, withdrawal, now });
    const depositCopy = pendingDeposit?.phase === 'submitted'
        ? {
            title: 'Deposit submitted',
            detail: 'The private note is saved. Check the chain to finish restoring it.',
            compact: 'Deposit submitted'
        }
        : pendingDeposit?.phase === 'awaiting_wallet'
            ? {
                title: 'Waiting for your Ethereum wallet',
                detail: 'Confirm the deposit, or recover the prompt from Private balance if it was closed.',
                compact: 'Waiting for your Ethereum wallet'
            }
            : pendingDeposit?.phase === 'ambiguous'
                ? {
                    title: 'Deposit status unknown',
                    detail: 'Check the vault before retrying the same deposit.',
                    compact: 'Check deposit'
                }
                : null;

    const currentActivityState = activityState(currentActivity);
    const accessActivityState = activityState(accessActivity);
    const settlementActivityState = activityState(settlementActivity);
    const walletActivityState = activityState(walletActivity);
    const transitionState = settlementState(transition);
    const settlementNeedsAttention = transition?.phase === 'error';
    // Once the previous chat has finished, the next real access phase is the
    // useful thing to show. A stale "ready" handoff must not hide proof or key
    // creation work that has already started for the new conversation.
    let primary = settlementNeedsAttention
        ? transitionState
        : currentActivity && transition?.phase === 'ready'
        ? currentActivityState
        : currentActivity?.kind === 'access' && isRunningActivity(currentActivity)
        ? currentActivityState
        : transitionState || currentActivityState;
    let withdrawalState = null;
    if (!primary && escapeWaiting) {
        withdrawalState = {
            phase: 'escape-wait',
            tone: 'waiting',
            title: 'Recovery window in progress',
            detail: 'Your balance is safe but paused until the escape hatch can be finalized.',
            compact: 'Recovery window in progress',
            busy: false,
            blocksSend: true
        };
        primary = withdrawalState;
    } else if (!primary && withdrawalBlocking) {
        withdrawalState = {
            phase: 'withdrawal',
            tone: 'waiting',
            ...withdrawalCopy,
            busy: false,
            blocksSend: true
        };
        primary = withdrawalState;
    } else if (!primary && frozenWords) {
        withdrawalState = frozenState(frozenWords);
        primary = withdrawalState;
    } else if (!primary && depositCopy) {
        primary = {
            phase: 'deposit-recovery',
            tone: 'waiting',
            ...depositCopy,
            busy: false,
            blocksSend: true
        };
    } else if (!primary && (snapshot.lastError || heldWords(version) !== null)) {
        // A held balance is said even when the client no longer holds the
        // error that stopped it (a refresh of a client that never started can
        // clear it): the balance is still there and still unreadable.
        primary = {
            phase: 'error',
            tone: 'error',
            title: 'Private balance unavailable',
            detail: heldWords(version) ?? zkapiErrorMessage(snapshot.lastError, String(snapshot.lastError)),
            compact: 'Private balance unavailable',
            busy: false,
            blocksSend: true
        };
    } else if (!primary && recentError) {
        primary = activityState(recentError);
    } else if (!primary && !note) {
        primary = {
            phase: snapshot.loading ? 'loading' : 'unfunded',
            tone: snapshot.loading ? 'working' : 'neutral',
            title: snapshot.loading ? 'Loading private balance' : 'Add funds to start chatting',
            detail: snapshot.loading
                ? 'Restoring the private note stored in this browser.'
                : 'Use your Ethereum wallet once, then OA Chat handles private access automatically.',
            compact: snapshot.loading ? 'Loading balance' : 'Add funds',
            busy: Boolean(snapshot.loading),
            blocksSend: !snapshot.loading
        };
    } else if (!primary) {
        const lease = snapshot.config?.active_lease;
        const ownsLease = lease && (!sessionId || lease.session_id === sessionId);
        primary = {
            phase: ownsLease ? 'chat-ready' : 'ready',
            tone: 'success',
            title: ownsLease ? 'Private chat ready' : 'Ready to chat',
            detail: ownsLease
                ? 'This conversation is using one temporary key for its messages and follow-ups.'
                : 'A temporary private key will be created when you send.',
            compact: ownsLease ? 'Private chat ready' : 'Ready',
            busy: false,
            blocksSend: false
        };
    }

    if (!withdrawalState && escapeWaiting) {
        withdrawalState = {
            phase: 'escape-wait',
            tone: 'waiting',
            title: 'Recovery window in progress',
            detail: 'Your balance is safe but paused until the escape hatch can be finalized.',
            compact: 'Recovery window in progress',
            busy: false,
            blocksSend: true
        };
    } else if (!withdrawalState && withdrawalBlocking) {
        withdrawalState = {
            phase: 'withdrawal',
            tone: 'waiting',
            ...withdrawalCopy,
            busy: false,
            blocksSend: true
        };
    } else if (!withdrawalState && frozenWords) {
        withdrawalState = frozenState(frozenWords);
    }

    // Concurrent private-payment work is routed to the surface where it is
    // actionable. A queued send owns the composer, while a MetaMask operation
    // owns the balance control; the activity panel can still show all work.
    // The SDK may still own a request after the user stops waiting. Keep the
    // terminal recovery state visible instead of reviving its old spinner.
    const composerPrimary = settlementNeedsAttention || transition?.phase === 'waiting'
        ? transitionState
        : accessActivityState
            || withdrawalState
            || transitionState
            || settlementActivityState
            || walletActivityState
            || primary;
    const liveTransitionState = transition?.phase === 'ready' && accessActivityState
        ? null
        : transitionState;
    const balancePrimary = walletActivityState
        || withdrawalState
        || liveTransitionState
        || settlementActivityState
        || accessActivityState
        || primary;
    const panelPrimary = walletActivityState
        || liveTransitionState
        || settlementActivityState
        || accessActivityState
        || withdrawalState
        || primary;
    // Retain the closure card on failure so recovery remains actionable.
    const closingState = ['settling', 'waiting', 'error'].includes(transition?.phase)
        ? transitionState
        : settlementActivityState;
    const closingPrimary = settlementNeedsAttention ? transitionState : closingState ? {
        ...closingState,
        phase: 'closing',
        title: 'Updating your balance',
        compact: 'Updating your balance'
    } : null;

    const showComposer = Boolean(
        transition
        || accessActivity
        || settlementActivity
        || composerPrimary.blocksSend
        || composerPrimary.tone === 'error'
    );

    return {
        proposal: normalizeZkapiUxProposal(snapshot.config?.ux_proposal),
        primary: panelPrimary,
        composerPrimary,
        balancePrimary,
        panelPrimary,
        closingPrimary,
        settlementAction: settlementNeedsAttention ? 'retry'
            : ['settling', 'waiting'].includes(transition?.phase) ? 'stop' : null,
        activities,
        runningActivities: running,
        currentActivity,
        recentError,
        note,
        showComposer,
        journey: buildJourney(composerPrimary, transition, settlementNeedsAttention ? null : composerPrimary.activity || currentActivity),
        transition,
        sessionId
    };
}
