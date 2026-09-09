export const PAYMENT_MODES = Object.freeze({ tickets: 'openrouter', zkapi: 'zkapi' });
export const PAYMENT_MODE_PREFERENCE = 'oa-payment-mode';

/** Payment chooses access issuance; OA remains the owner of every transcript. */
export function createPaymentModeRuntimeCore({ zkRuntime, inferenceService, acquireVerifiedAccess,
    modelConfiguration, preferenceStorage = null, initialMode = 'tickets' }) {
    let context = null;
    let switching = false;
    let selectionGeneration = 0;
    const modeFor = session => session
        ? (session.inferenceBackend || inferenceService.getLegacyBackendId?.(session)) === 'zkapi' ? 'zkapi' : 'tickets'
        : inferenceService.getDefaultBackendId() === 'zkapi' ? 'zkapi' : 'tickets';
    inferenceService.setDefaultBackendId(PAYMENT_MODES[initialMode] || PAYMENT_MODES.tickets);

    const runtime = {
        ...zkRuntime,
        inferenceService,
        modelConfiguration,
        // Mount the complete OA experience once; availability follows the
        // owning chat instead of disabling ticket features for the whole app.
        features: { ...zkRuntime.features, accounts: true, tickets: true, memory: true, scrubber: true, council: true },
        supportsFeature: (feature, session) => !['memory', 'scrubber', 'council'].includes(feature)
            || modeFor(session) === 'tickets',
        getFeatureUnavailableReason(feature, session) {
            if (runtime.supportsFeature(feature, session)) return '';
            if (feature === 'council') return 'Parallel needs separate model keys. Switch to Tickets to use it.';
            const label = feature === 'scrubber' ? 'Privacy Scrubber' : 'Memory';
            return `${label} uses a separate Tinfoil key paid with tickets. Switch to Tickets to use it.`;
        },
        usesTicketAccess: session => modeFor(session) === 'tickets',
        getMode: (session = context?.getCurrentSession()) => modeFor(session),
        isSwitching: () => switching,
        isModeLocked: () => switching || Boolean(context?.isSessionBusy()),
        attach(value) {
            context = value;
            return zkRuntime.attach({ ...value,
                // A later private-key retry may still name this conversation
                // after it has moved to Tickets. Never cancel its new work.
                cancelSessionWork: sessionId => modeFor(value.getSession(sessionId)) === 'zkapi'
                    ? value.cancelSessionWork(sessionId) : undefined
            });
        },
        async changeMode(mode) {
            if (!Object.hasOwn(PAYMENT_MODES, mode)) throw new Error('Choose Tickets or zkAPI.');
            if (!context) throw new Error('Chat is still loading. Please try again.');
            if (runtime.isModeLocked()) throw new Error('Finish or stop the current response before switching payment methods.');
            const owner = context;
            const session = context.getCurrentSession();
            const generation = ++selectionGeneration;
            switching = true;
            context.refreshPresentation();
            try {
                await context.changeSessionBackend(PAYMENT_MODES[mode]);
                inferenceService.setDefaultBackendId(PAYMENT_MODES[mode]);
                try { preferenceStorage?.setItem(PAYMENT_MODE_PREFERENCE, mode); } catch { /* Session choice is still durable. */ }
            } finally {
                switching = false;
                context.refreshPresentation();
            }
            if (mode === 'zkapi') {
                // Wallet restoration can outlive this selection. Reuse send
                // preflight without opening a dialog over another chat/mode.
                const shouldOpenFunding = () => context === owner
                    && selectionGeneration === generation
                    && context.getCurrentSession() === session
                    && !context.isSessionBusy()
                    && runtime.getMode() === 'zkapi';
                try {
                    await zkRuntime.checkCanSend({ shouldOpenFunding });
                } catch {
                    if (shouldOpenFunding()) context.showToast?.(
                        'zkAPI selected, but your private balance could not be checked. Reload to retry.', 'error');
                }
            }
        },
        beforeBackendChange({ session, previousBackendId }) {
            if (previousBackendId === 'zkapi') {
                // Register the private-access barrier synchronously, but let
                // Tickets proceed independently of wallet/network settlement.
                void zkRuntime.retireSessionAccess(session.id).catch(() => {});
                // Keep recovery intent through reload and a switch back. This
                // marker never contains a credential or blocks ticket access.
                session.zkapiSettleBeforeAccess = true;
            }
            // An OA key and a zkAPI session binding are different credentials.
            // Never carry either into the other backend's issuance request.
            delete session.zkapiSessionId;
        },
        acquireAccess(options) {
            return modeFor(options.session) === 'tickets'
                ? acquireVerifiedAccess(options)
                : inferenceService.requestAccess(options.session, { signal: options.signal });
        },
        checkCanSend(options = {}) {
            return modeFor(context?.getSession(options.sessionId)) === 'tickets'
                ? true : zkRuntime.checkCanSend(options);
        },
        prepareTurn(options) {
            if (modeFor(context?.getSession(options.sessionId)) === 'zkapi') return zkRuntime.prepareTurn(options);
        },
        onNewChat({ sessionId }) {
            if (modeFor(context?.getSession(sessionId)) === 'zkapi') zkRuntime.onNewChat({ sessionId });
        },
        shouldCancelOnNewChat: ({ session }) => session?.inferenceBackend === 'zkapi',
        recordUsage(options) {
            if (modeFor(context?.getSession(options.sessionId)) === 'zkapi') return zkRuntime.recordUsage(options);
        }
    };
    return runtime;
}
