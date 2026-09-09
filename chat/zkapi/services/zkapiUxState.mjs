export const ZKAPI_UX_PROPOSALS = Object.freeze([
    'quiet',
    'guided',
    'activity',
    'receipt',
    'relay',
    'ambient',
    'capsule'
]);

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
        deposit: ['Adding funds', 'Follow the current step in MetaMask.'],
        withdraw: ['Returning your balance', 'Preparing the withdrawal and its private proof.'],
        escape: ['Starting account recovery', 'Preparing the escape-hatch transaction.'],
        'escape-finalize': ['Finishing account recovery', 'Returning the balance to MetaMask.'],
        'withdraw-sync': ['Checking withdrawal', 'Reading the latest on-chain status.'],
        token: ['Updating MetaMask', 'Follow the current step in MetaMask.'],
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
            detail: 'You can keep typing. Sending will wait until its balance update is complete.',
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
            detail: transition.message || 'Unable to finish the previous chat. Try sending again to retry.',
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
        case 'token':
            return {
                steps: [
                    { id: 'wallet', label: 'Connect wallet' },
                    { id: 'confirm', label: 'Confirm in MetaMask' },
                    { id: 'ready', label: 'Token ready' }
                ],
                activeIndex: at(/available/i, /visible/i, /now/i) ? 2 : at(/connect/i) ? 0 : 1
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
    } else if (primary.phase === 'withdrawal') {
        steps = [
            { id: 'prepare', label: 'Withdrawal prepared' },
            { id: 'confirm', label: 'Finish in MetaMask' },
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

export function deriveZkapiUxState({ snapshot = {}, transition = null, sessionId = null, now = Date.now() } = {}) {
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
            detail: 'The transaction is on its way. Check its status before using this balance.',
            compact: 'Withdrawal submitted'
        }
        : withdrawalPhase === 'dropped_or_pending'
            ? {
                title: 'Withdrawal receipt not found',
                detail: preparedWithdrawal?.replacement_available
                    ? 'Check again, or safely resubmit the exact withdrawal with its original nonce.'
                    : 'Check or cancel the pending transaction in MetaMask, then check again.',
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
                title: 'Waiting for MetaMask',
                detail: 'Confirm the wallet prompt, or recover it from Withdraw if it was closed.',
                compact: 'Waiting for MetaMask'
            }
            : withdrawalPhase === 'ambiguous'
                ? {
                    title: 'Withdrawal status unknown',
                    detail: 'Check the vault before explicitly retrying the transaction.',
                    compact: 'Check withdrawal'
                }
            : {
                title: 'Withdrawal ready to finish',
                detail: 'No transaction is moving. Finish withdrawing or set this balance aside.',
                compact: 'Withdrawal ready'
            };
    const depositCopy = pendingDeposit?.phase === 'submitted'
        ? {
            title: 'Deposit submitted',
            detail: 'The private note is saved. Check the chain to finish restoring it.',
            compact: 'Deposit submitted'
        }
        : pendingDeposit?.phase === 'awaiting_wallet'
            ? {
                title: 'Waiting for MetaMask',
                detail: 'Confirm the deposit, or recover the prompt from Private balance if it was closed.',
                compact: 'Waiting for MetaMask'
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
    // Once the previous chat has finished, the next real access phase is the
    // useful thing to show. A stale "ready" handoff must not hide proof or key
    // creation work that has already started for the new conversation.
    let primary = currentActivity && transition?.phase === 'ready'
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
    } else if (!primary && depositCopy) {
        primary = {
            phase: 'deposit-recovery',
            tone: 'waiting',
            ...depositCopy,
            busy: false,
            blocksSend: true
        };
    } else if (!primary && snapshot.lastError) {
        primary = {
            phase: 'error',
            tone: 'error',
            title: 'Private balance unavailable',
            detail: snapshot.lastError.shortMessage || snapshot.lastError.message || String(snapshot.lastError),
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
                : 'Use MetaMask once, then OA Chat handles private access automatically.',
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
    }

    // Concurrent private-payment work is routed to the surface where it is
    // actionable. A queued send owns the composer, while a MetaMask operation
    // owns the balance control; the activity panel can still show all work.
    const composerPrimary = transition?.phase === 'waiting'
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
    // The System Panel only needs an extra card while the previous chat is
    // closing. Keep the full states above for badges, pending responses and
    // recovery, including when wallet activity runs alongside settlement.
    const closingState = ['settling', 'waiting'].includes(transition?.phase)
        ? transitionState
        : settlementActivityState;
    const closingPrimary = closingState ? {
        ...closingState,
        phase: 'closing',
        title: 'Closing previous chat',
        compact: 'Closing previous chat'
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
        activities,
        runningActivities: running,
        currentActivity,
        recentError,
        note,
        showComposer,
        journey: buildJourney(composerPrimary, transition, composerPrimary.activity || currentActivity),
        transition,
        sessionId
    };
}
