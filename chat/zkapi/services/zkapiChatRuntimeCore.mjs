import { explainZkapiError, zkapiErrorMessage } from './zkapiErrorCopy.mjs';
import { copyTokens, versionCopyText } from '../versioning/copy.mjs';
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
    const cancellation = () => signal.reason?.name !== 'AbortError' && signal.reason
        ? signal.reason : abortError();
    if (signal.aborted) return Promise.reject(cancellation());
    return new Promise((resolve, reject) => {
        const abort = () => reject(cancellation());
        signal.addEventListener('abort', abort, { once: true });
        promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    });
}

/** OA owns the chat lifecycle; the SDK owns private keys, proofs and settlement. */
// `versioning` is the protocol-version facade (versioning/index.js) or null.
// Everything read from it fails open: a missing, throwing or malformed facade
// never stops a chat, so single-version builds and tests behave as before.
export function createZkapiChatRuntimeCore({ client, backend, createInferenceService, modelConfiguration, resolveModelBudget, settleAccess, versioning = null, initializeClient = () => client.init(), retirementTimeoutMs = RETIREMENT_TIMEOUT_MS, retryDelay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)) } = {}) {
    if (!client || !backend || typeof createInferenceService !== 'function' || !modelConfiguration) {
        throw new Error('Private chat runtime dependencies are required.');
    }
    let context = null;
    let transition = null;
    let retirement = null;
    let retirementController = null;
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

    // The SDK's failure to start is the SDK's own words, which can name the
    // operator's address. When the page holds a balance it cannot read because
    // of it, the version facade says so (isStartFailure) and the error is told
    // in plain words, the same sentence every other surface shows, before any
    // caller turns it into a toast. It is the error the SDK replays to every
    // later caller, so it is reworded once, in place. Every other failure, and
    // a build with no facade, keeps the SDK's words. Returns the same error.
    function plainStartFailure(error) {
        try {
            if (error && typeof error === 'object' && versioning?.isStartFailure?.(error) === true) {
                explainZkapiError(error, { facade: versioning });
            }
        } catch (_) { /* the error itself is what the caller handles */ }
        return error;
    }

    // The SDK's start, with its failure told by plainStartFailure.
    async function startClient() {
        try {
            return await initializeClient();
        } catch (error) {
            throw plainStartFailure(error);
        }
    }

    // May a NEW chat key start? Only a multi-version build whose loaded adapter
    // has a chat cutoff can say no (the last hours before a note expires). It
    // is asked only for a send that would open a key: a follow-up that reuses
    // the live key of its own session and cap opens none, so the cutoff has
    // nothing to protect there and the person is not told chats are paused
    // while theirs works.
    function newKeyAllowed() {
        try {
            const gate = versioning?.sendGate?.(Date.now());
            return !(gate && gate.canSend === false);
        } catch (_) {
            return true;
        }
    }

    // The toast for a model whose key needs more than the balance. With a
    // newer version to move to it says so; without one (every single-version
    // build) it is the plain advice returned at the end.
    function largerKeyMessage(spendingLimitUsd) {
        const amount = `$${spendingLimitUsd.toFixed(2)}`;
        try {
            const state = versioning?.state?.();
            const target = state?.show === true ? state.target : null;
            if (target && state.current && target.id !== state.current.id) {
                const tokens = { ...copyTokens(state, { table: versioning.table }), amount };
                const text = versionCopyText('send.largerKey', tokens);
                if (text) return text;
            }
        } catch (_) { /* fall through to the single-version text */ }
        return `This model requires ${amount} in private balance for a new key. Choose a lower-cap model, or withdraw the remaining balance and fund a larger one.`;
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

    function startRetirement(sessionId, { cancelWork = true, expectedOwner = false, deletionScope } = {}) {
        if (retirement) return retirement;
        let ownerId = expectedOwner ? sessionId : client.activeLease?.session_id || sessionId;
        if (!ownerId) return Promise.resolve();
        setTransition({ phase: 'settling', sessionId: ownerId,
            title: context?.getSession(ownerId)?.title || 'Previous chat',
            message: 'Closing the previous chat key in the background.' });
        logSettlement('lease-settlement-start', 'Closing the previous chat key in the background.', ownerId);
        const controller = new AbortController();
        retirementController = controller;
        const { signal } = controller;
        const checkCanceled = () => { if (signal.aborted) throw signal.reason; };
        const timer = setTimeout(() => controller.abort(new Error(
            'Private access could not finish in time. Your recovery record is saved. Retry when the temporary-key service is available.'
        )), retirementTimeoutMs);
        // Assign the promise before any await; a rapid Send sees this barrier.
        const job = Promise.resolve().then(async () => {
            checkCanceled();
            if (cancelWork) await context?.cancelSessionWork(ownerId);
            checkCanceled();
            if (expectedOwner || deletionScope !== undefined) {
                // Hydration and owner discovery belong inside the registered
                // barrier: a fast return to private mode must see them too.
                await startClient();
                checkCanceled();
            }
            if (deletionScope !== undefined) {
                const owner = typeof client.getPendingLeaseOwner === 'function'
                    ? await client.getPendingLeaseOwner() : client.activeLease?.session_id;
                checkCanceled();
                if (owner && deletionScope && !deletionScope.includes(owner)) return;
                if (!client.activeLease && !await client.hasPendingLease()) return;
                checkCanceled();
                if (owner) {
                    ownerId = owner;
                    setTransition({ ...transition, sessionId: ownerId });
                }
            }
            const deadline = Date.now() + retirementTimeoutMs;
            while (true) {
                checkCanceled();
                if (expectedOwner) {
                    const owner = typeof client.getPendingLeaseOwner === 'function'
                        ? await client.getPendingLeaseOwner() : client.activeLease?.session_id;
                    checkCanceled();
                    // Failed issuance has a journal but no lease owner yet.
                    // It still needs reconciliation before scoped retirement.
                    if (owner && owner !== ownerId) break;
                }
                if (!expectedOwner && client.activeLease && client.activeLease.session_id !== ownerId) break;
                try {
                    if (settleAccess) {
                        await settleAccess(undefined, { sessionId: ownerId, signal, expectedOwner });
                    } else {
                        await client.settleActiveLease(undefined, expectedOwner ? { sessionId: ownerId } : {});
                    }
                    break;
                } catch (error) {
                    checkCanceled();
                    const retryable = ['lease_requests_in_flight', 'lease_pending', 'lease_settlement_pending'].includes(error?.code)
                        || /still (?:settling|being finalized)/i.test(error?.message || '');
                    const retryAfter = Number(error?.data?.retry_after_seconds ?? error?.data?.error?.retry_after_seconds);
                    const delay = Number.isFinite(retryAfter) && retryAfter >= 0
                        ? Math.max(250, Math.ceil(retryAfter * 1000)) : 1000;
                    if (!retryable || Date.now() + delay > deadline) throw plainStartFailure(error);
                    await waitFor(retryDelay(delay), signal);
                }
            }
            if (deletionScope !== undefined && await client.hasPendingLease()) {
                checkCanceled();
                const owner = typeof client.getPendingLeaseOwner === 'function'
                    ? await client.getPendingLeaseOwner() : client.activeLease?.session_id;
                checkCanceled();
                if (!owner || !deletionScope || deletionScope.includes(owner)) {
                    throw new Error('Private access is still finishing. Try again shortly.');
                }
            }
        }).then(() => {
            setTransition({ phase: 'ready', sessionId: ownerId, message: 'Previous chat settled.' });
            logSettlement('lease-settlement-complete', 'Previous chat key settled. Remaining balance is available.', ownerId);
        });
        const waiting = waitFor(job, signal);
        retirement = waiting;
        waiting.catch(error => {
            setTransition({ phase: 'error', sessionId: ownerId, message: zkapiErrorMessage(error, 'Could not finish the previous chat.') });
            logSettlement('lease-settlement-error', 'Could not finish the previous chat. Retry to continue.', ownerId);
        });
        // Stop the UI wait, never forget an SDK mutation still holding the
        // wallet lock. Retry joins this attempt until its work actually exits.
        const release = () => {
            clearTimeout(timer);
            if (retirement === waiting) {
                retirement = null;
                retirementController = null;
            }
        };
        job.then(release, release);
        return waiting;
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
            // A reload that would interrupt a settling chat key is not offered
            // while one is closing (the facade's canReload).
            let unregisterBusy = () => {};
            try {
                unregisterBusy = versioning?.registerBusy?.(() => Boolean(retirement) || queuedSessions.size > 0)
                    || unregisterBusy;
            } catch (_) { /* presentation only */ }
            void initializeClient().then(publish, publish);
            return () => { disposed = true; unsubscribe(); unregisterBusy(); };
        },
        async checkCanSend({ signal, sessionId, modelId, reasoningEnabled, shouldOpenFunding = () => true } = {}) {
            if (signal?.aborted) throw abortError();
            await startClient();
            await client.ensureTestnetAccess?.({ signal, interactive: true });
            if (signal?.aborted) throw abortError();
            const expired = Number(client.note?.expiry_ts) > 0
                && Number(client.note.expiry_ts) * 1000 <= Date.now();
            if (client.withdrawalBlocksChat) {
                // Recovery is an explicit balance-panel action. Repeated send
                // attempts must not trap the person in the withdrawal dialog.
                if (shouldOpenFunding()) context?.showToast?.('This private balance is reserved for withdrawal. Open Balance details to review the fee and finish, or cancel if available.', 'info', 9000);
                return false;
            }
            if (!client.hasNote || expired || client.noteExpiryClaim) {
                if (shouldOpenFunding()) context?.openFunding();
                return false;
            }
            // Close to expiry a new key could leave a lease unsettled when the
            // note runs out. Existing keys, settlement and withdrawals are
            // unaffected; the person is told what to do instead. Only a send
            // that opens a key is refused, and the facade is asked once.
            let cutoffChecked = false;
            const refuseNewKey = () => {
                if (cutoffChecked) return false;
                cutoffChecked = true;
                if (newKeyAllowed()) return false;
                context?.showToast?.(versionCopyText('near_expiry'), 'error', 9000);
                return true;
            };
            // A live key of this session that is not closing or about to
            // lapse: what a follow-up reuses when its cap matches too. Read
            // when needed, so a key that closed while the budget was looked
            // up is not reused.
            const liveLease = () => {
                const lease = client.activeLease;
                return lease?.session_id === sessionId
                    && Number(lease.expires_at) * 1000 > Date.now() + 90_000
                    && !lease.retiring && !lease.retired ? lease : null;
            };
            // Nothing to reuse: this send opens a key whatever the model is,
            // so the cutoff applies before any budget is looked up.
            if (!liveLease() && refuseNewKey()) return false;
            if (modelId && resolveModelBudget) {
                const { spendingLimitUsd } = await resolveModelBudget(modelId, reasoningEnabled, signal);
                if (signal?.aborted) throw abortError();
                const lease = liveLease();
                const reusesKey = lease !== null && Number(lease.spending_limit_usd) === spendingLimitUsd;
                // Another cap (or a key that just closed) needs a new key, and
                // the cutoff applies to it.
                if (!reusesKey && refuseNewKey()) return false;
                // An existing matching key has already proved its cap. Its
                // remaining allowance is enforced upstream, not reproved here.
                if (!reusesKey && Number(client.note?.current_balance) / client.creditsPerUsd < spendingLimitUsd) {
                    context?.showToast?.(largerKeyMessage(spendingLimitUsd), 'error', 9000);
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
            const scopedIds = all || !sessionIds ? null : sessionIds;
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
            // The displayed owner can still be a deletion candidate while
            // durable owner discovery is waiting on the wallet lock. It is
            // never evidence that a different deletion target is safe.
            while (retirement) await retirement;
            // Owner discovery also takes the wallet lock. Include every read
            // and the final journal check in the cancellable deadline, even
            // when failed issuance never produced a visible active key.
            await startRetirement(scopedIds?.[0] || client.activeLease?.session_id || 'private-access-recovery', {
                cancelWork: false, expectedOwner: true, deletionScope: scopedIds
            });
        },
        getTransition: () => transition,
        stopSettlementWaiting() {
            retirementController?.abort(new Error(
                'Balance update paused. Choose Retry to finish updating your balance before sending a message.'
            ));
        },
        retrySettlement() {
            return startRetirement(transition?.sessionId || client.activeLease?.session_id);
        },
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
