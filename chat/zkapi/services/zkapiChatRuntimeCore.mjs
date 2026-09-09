import {
    buildUsageLedgerEntry, mergeUsageLedgerEntries, recoverUsageLedgerFromMessages,
    summarizeUsageLedger, upsertUsageLedgerEntry
} from './modelPricing.mjs';

const RETIREMENT_TIMEOUT_MS = 45_000;

function abortError() {
    const error = new Error('Request canceled');
    error.name = 'AbortError';
    error.isCancelled = true;
    return error;
}

function waitFor(promise, signal) {
    if (!signal) return promise;
    if (signal.aborted) return Promise.reject(abortError());
    return new Promise((resolve, reject) => {
        const abort = () => reject(abortError());
        signal.addEventListener('abort', abort, { once: true });
        promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    });
}

/** OA owns the chat lifecycle; the SDK owns private keys, proofs and settlement. */
export function createZkapiChatRuntimeCore({ client, backend, createInferenceService, modelConfiguration, resolveModelBudget, retirementTimeoutMs = RETIREMENT_TIMEOUT_MS, retryDelay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)) } = {}) {
    if (!client || !backend || typeof createInferenceService !== 'function' || !modelConfiguration) {
        throw new Error('Private chat runtime dependencies are required.');
    }
    let context = null;
    let transition = null;
    let retirement = null;
    let disposed = false;
    const previews = new Map();
    const queuedSessions = new Map();
    const inferenceService = createInferenceService({
        backends: [backend],
        defaultBackendId: backend.id,
        resolveDefaultModelConfig: modelConfiguration.getDefaultModelConfig
    });

    function publish() {
        if (!disposed) context?.refreshPresentation();
    }

    function setTransition(value) {
        transition = value ? { ...value, updatedAt: Date.now() } : null;
        publish();
    }

    function logSettlement(action, message, sessionId) {
        try { context?.logLocalEvent?.(action, message, { sessionId }); }
        catch (_) { /* Presentation diagnostics must not stop settlement. */ }
    }

    function reportSnapshot(snapshot) {
        const activities = snapshot?.activities || [];
        const activity = activities.at(-1);
        for (const sessionId of queuedSessions.keys()) {
            const progress = activity?.kind === 'settlement'
                ? { ...activity, kind: 'settlement' }
                : { kind: 'settlement', phase: 'settling' };
            context?.setProgress(sessionId, progress);
        }
        publish();
    }

    function startRetirement(sessionId, { cancelWork = true, expectedOwner = false } = {}) {
        if (retirement) return retirement;
        const ownerId = expectedOwner ? sessionId : client.activeLease?.session_id || sessionId;
        if (!ownerId) return Promise.resolve();
        setTransition({ phase: 'settling', sessionId: ownerId,
            title: context?.getSession(ownerId)?.title || 'Previous chat',
            message: 'Closing the previous chat key in the background.' });
        logSettlement('lease-settlement-start', 'Closing the previous chat key in the background.', ownerId);
        // Assign the promise before any await; a rapid Send sees this barrier.
        const job = Promise.resolve().then(async () => {
            if (cancelWork) await context?.cancelSessionWork(ownerId);
            if (expectedOwner) {
                // Hydration and owner discovery belong inside the registered
                // barrier: a fast return to private mode must see them too.
                await client.init();
            }
            const deadline = Date.now() + retirementTimeoutMs;
            while (true) {
                if (expectedOwner) {
                    const owner = typeof client.getPendingLeaseOwner === 'function'
                        ? await client.getPendingLeaseOwner() : client.activeLease?.session_id;
                    if (owner !== ownerId) break;
                }
                if (!expectedOwner && client.activeLease && client.activeLease.session_id !== ownerId) break;
                try {
                    await client.settleActiveLease(undefined, expectedOwner ? { sessionId: ownerId } : {});
                    break;
                } catch (error) {
                    const retryable = ['lease_requests_in_flight', 'lease_pending', 'lease_settlement_pending'].includes(error?.code)
                        || /still (?:settling|being finalized)/i.test(error?.message || '');
                    const retryAfter = Number(error?.data?.retry_after_seconds ?? error?.data?.error?.retry_after_seconds);
                    const delay = Number.isFinite(retryAfter) && retryAfter >= 0
                        ? Math.max(250, Math.ceil(retryAfter * 1000)) : 1000;
                    if (!retryable || Date.now() + delay > deadline) throw error;
                    await retryDelay(delay);
                }
            }
            setTransition({ phase: 'ready', sessionId: ownerId, message: 'Previous chat settled.' });
            logSettlement('lease-settlement-complete', 'Previous chat key settled. Remaining balance is available.', ownerId);
        });
        retirement = job;
        job.then(() => {
            if (retirement === job) retirement = null;
        }, error => {
            if (retirement === job) retirement = null;
            setTransition({ phase: 'error', sessionId: ownerId, message: error?.message || 'Could not finish the previous chat.' });
            logSettlement('lease-settlement-error', 'Could not finish the previous chat. Retry to continue.', ownerId);
        });
        return job;
    }

    async function recordUsage({ sessionId, requestId, usage, pricing = null, kind = 'response', final = true }) {
        const session = context?.getSession(sessionId);
        const entry = buildUsageLedgerEntry({ id: requestId, kind, usage,
            pricing: structuredClone(pricing || usage?.pricing || null), model: usage?.model });
        if (!session || !entry) return null;
        let sessionPreviews = previews.get(sessionId);
        if (!sessionPreviews) previews.set(sessionId, sessionPreviews = new Map());
        if (final) {
            session.zkapiUsageLedger = upsertUsageLedgerEntry(session.zkapiUsageLedger, entry);
            sessionPreviews.delete(requestId);
            await context.saveSession(session);
        } else sessionPreviews.set(requestId, entry);
        if (!disposed) context?.refreshPresentation({ usageOnly: true });
        return {
            promptTokens: entry.promptTokens, completionTokens: entry.completionTokens,
            totalTokens: entry.totalTokens, estimatedCostUsd: entry.estimatedCostUsd,
            usageProviderReported: entry.providerReported, usagePricing: structuredClone(entry.pricing),
            zkapiUsageRecorded: true
        };
    }

    return {
        inferenceService,
        modelConfiguration,
        features: { accounts: false, tickets: false, memory: false, scrubber: false, council: false },
        reuseAccessOnFork: false,
        transformForkMessage(message) {
            // A fork retains the conversation, not historical charges. Its
            // first new request obtains access owned by the new session.
            const snapshot = structuredClone(message);
            for (const field of ['promptTokens', 'completionTokens', 'totalTokens',
                'estimatedCostUsd', 'usageProviderReported', 'usagePricing', 'zkapiUsageRecorded']) {
                delete snapshot[field];
            }
            return snapshot;
        },
        async acquireAccess(options) {
            return inferenceService.requestAccess(options.session, { signal: options.signal });
        },
        attach(value) {
            context = value;
            disposed = false;
            const unsubscribe = client.subscribe((snapshot, detail) => {
                if (detail?.reason !== 'clock') reportSnapshot(snapshot);
            });
            void client.init().then(publish, publish);
            return () => { disposed = true; unsubscribe(); };
        },
        async checkCanSend({ signal, sessionId, modelId, reasoningEnabled, shouldOpenFunding = () => true } = {}) {
            if (signal?.aborted) throw abortError();
            await client.init();
            if (signal?.aborted) throw abortError();
            const expired = Number(client.note?.expiry_ts) > 0
                && Number(client.note.expiry_ts) * 1000 <= Date.now();
            if (client.withdrawalBlocksChat || !client.hasNote || expired || client.noteExpiryClaim) {
                if (shouldOpenFunding()) context?.openFunding();
                return false;
            }
            if (modelId && resolveModelBudget) {
                const { spendingLimitUsd } = await resolveModelBudget(modelId, reasoningEnabled, signal);
                if (signal?.aborted) throw abortError();
                const lease = client.activeLease;
                const reusesKey = lease?.session_id === sessionId
                    && Number(lease.spending_limit_usd) === spendingLimitUsd
                    && Number(lease.expires_at) * 1000 > Date.now() + 90_000
                    && !lease.retiring && !lease.retired;
                // An existing matching key has already proved its cap. Its
                // remaining allowance is enforced upstream, not reproved here.
                if (!reusesKey && Number(client.note?.current_balance) / client.creditsPerUsd < spendingLimitUsd) {
                    context?.showToast?.(`This model requires $${spendingLimitUsd.toFixed(2)} in private balance for a new key. Choose a lower-cap model, or withdraw the remaining balance and fund a larger one.`, 'error', 9000);
                    return false;
                }
            }
            return true;
        },
        onNewChat({ sessionId }) {
            if (sessionId || client.activeLease) void startRetirement(sessionId).catch(() => {});
        },
        async prepareTurn({ sessionId, signal, onProgress }) {
            if (signal?.aborted) throw abortError();
            const activeOwner = client.activeLease?.session_id;
            if (!retirement && activeOwner && activeOwner !== sessionId) startRetirement(activeOwner);
            if (!retirement && context?.getSession(sessionId)?.zkapiSettleBeforeAccess) {
                startRetirement(sessionId, { cancelWork: false, expectedOwner: true });
            }
            if (transition?.phase === 'error' && !retirement) startRetirement(transition.sessionId, { cancelWork: transition.sessionId !== sessionId });
            if (!retirement) return;
            queuedSessions.set(sessionId, (queuedSessions.get(sessionId) || 0) + 1);
            onProgress?.({ kind: 'settlement', phase: 'settling' });
            publish();
            try { await waitFor(retirement, signal); }
            finally {
                const remaining = (queuedSessions.get(sessionId) || 1) - 1;
                if (remaining) queuedSessions.set(sessionId, remaining);
                else queuedSessions.delete(sessionId);
                publish();
            }
        },
        async beforeDelete({ sessionIds, all = false }) {
            // Clearing history also removes sessions not loaded in memory.
            const scopedIds = all ? null : sessionIds;
            const affects = sessionId => Boolean(sessionId)
                && (!scopedIds || scopedIds.includes(sessionId));
            const needsPrivateCheck = session => !session || session.inferenceBackend === 'zkapi'
                || Boolean(session?.zkapiSessionId || session?.zkapiSettleBeforeAccess)
                || session?.apiKeyInfo?.backendId === 'zkapi'
                || Boolean(session?.zkapiUsageLedger?.length);
            // Ticket deletion is local. Do not initialize or query a private
            // wallet for conversations that never owned private access. A
            // switched conversation retains its recovery marker/history.
            const affectsPrivateAccess = !scopedIds
                || affects(client.activeLease?.session_id)
                || Boolean(retirement && affects(transition?.sessionId))
                || scopedIds.some(id => needsPrivateCheck(context?.getSession(id)));
            if (!affectsPrivateAccess) return;

            // The wallet snapshot may already be clear while settlement is
            // still publishing its durable result. Keep its owner recoverable.
            if (retirement && affects(transition?.sessionId)) await retirement;
            const active = client.activeLease;
            if (active && affects(active.session_id)) {
                await startRetirement(active.session_id, { expectedOwner: true });
            }
            // The durable journal can outlive the visible key, including after
            // a reload into Tickets. Only its owner must wait; an unrelated
            // private chat must not stop deletion of another conversation.
            const pendingOwner = typeof client.getPendingLeaseOwner === 'function'
                ? await client.getPendingLeaseOwner() : client.activeLease?.session_id;
            if (pendingOwner && !affects(pendingOwner)) return;
            if (await client.hasPendingLease()) throw new Error('Private access is still finishing. Try again shortly.');
        },
        getTransition: () => transition,
        retireSessionAccess(sessionId) {
            return startRetirement(sessionId, { cancelWork: false, expectedOwner: true });
        },
        getSessionStatus(session) {
            if (queuedSessions.has(session?.id)) return { tone: 'waiting', label: 'Queued' };
            if (transition?.sessionId === session?.id && transition.phase === 'settling') return { tone: 'working', label: 'Finishing' };
            if (transition?.sessionId === session?.id && transition.phase === 'error') return { tone: 'error', label: 'Needs attention' };
            return null;
        },
        getSessionUsageSummary(sessionOrId) {
            const session = typeof sessionOrId === 'string' ? context?.getSession(sessionOrId) : sessionOrId;
            return summarizeUsageLedger(mergeUsageLedgerEntries(session?.zkapiUsageLedger || [],
                [...(previews.get(session?.id)?.values() || [])]));
        },
        recordUsage,
        discardUsagePreview({ sessionId, requestId }) {
            const sessionPreviews = previews.get(sessionId);
            if (!sessionPreviews?.delete(requestId)) return;
            if (!sessionPreviews.size) previews.delete(sessionId);
            if (!disposed) context?.refreshPresentation({ usageOnly: true });
        },
        async restoreSession(session, messages) {
            if (!session) return;
            // A late history read must never recreate a concurrently deleted
            // chat, or overwrite the newer live session object with its copy.
            session = context?.getSession(session.id);
            if (!session) return;
            const previous = session.zkapiUsageLedger || [];
            const recovered = recoverUsageLedgerFromMessages(previous, messages);
            if (recovered.length !== previous.length) {
                session.zkapiUsageLedger = recovered;
                await context?.saveSession(session);
                if (!disposed) context?.refreshPresentation({ usageOnly: true });
            }
        }
    };
}
