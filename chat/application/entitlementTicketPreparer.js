import privacyPassProvider from '../services/privacyPass.js';
import ticketStore from '../services/ticketStore.js';
import entitlementClaimRecoveryStore from '../services/entitlementClaimRecoveryStore.js';
import { requestQueuedLock } from './queuedLock.js';

const CHUNK_SIZE = 10;
const NORMAL_TICKET_FIELDS = new Set([
    'blinded_request',
    'signed_response',
    'finalized_ticket',
    'created_at'
]);
const FORBIDDEN_METADATA = /account|stripe|subscription|entitlement|claim/i;
const CLAIM_RESPONSE_FIELDS = new Set(['signed_responses', 'tickets_issued', 'replayed']);

function abortError(message = 'Aborted') {
    return new DOMException(message, 'AbortError');
}

async function sha256(value) {
    const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(value)));
    return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

export function normalizeClaimResponses(data, expectedCount) {
    if (data?.finalized_tickets || data?.finalized_ticket || data?.tickets) {
        const error = new Error('The entitlement server returned finalized ticket material.');
        error.code = 'ENTITLEMENT_SERVER_FINALIZED_TICKETS';
        throw error;
    }
    const unexpected = Object.keys(data || {}).filter(field => !CLAIM_RESPONSE_FIELDS.has(field));
    if (unexpected.length > 0) {
        const error = new Error('The entitlement server returned unexpected response metadata.');
        error.code = 'ENTITLEMENT_UNEXPECTED_RESPONSE_METADATA';
        throw error;
    }
    if (Object.hasOwn(data || {}, 'tickets_issued') && Number(data.tickets_issued) !== expectedCount) {
        const error = new Error('The entitlement server reported the wrong issued ticket count.');
        error.code = 'ENTITLEMENT_ISSUED_COUNT_MISMATCH';
        throw error;
    }
    if (Object.hasOwn(data || {}, 'replayed') && typeof data.replayed !== 'boolean') {
        const error = new Error('The entitlement server returned an invalid replay marker.');
        error.code = 'ENTITLEMENT_INVALID_REPLAY_MARKER';
        throw error;
    }
    const source = data?.signed_responses;
    if (!Array.isArray(source) || source.length !== expectedCount) {
        const error = new Error('The entitlement server returned an incomplete signature batch.');
        error.code = 'ENTITLEMENT_INCOMPLETE_RESPONSE';
        throw error;
    }
    const normalized = source.map(entry => {
        if (!Array.isArray(entry) || entry.length !== 2 || !Number.isInteger(entry[0]) || !entry[1]) {
            throw new Error('The entitlement server returned malformed signed responses.');
        }
        return [entry[0], String(entry[1])];
    }).sort((left, right) => left[0] - right[0]);
    if (normalized.some((entry, index) => entry[0] !== index)) {
        throw new Error('The entitlement server returned mismatched ticket indexes.');
    }
    return normalized;
}

export function validatePreparedTicket(ticket) {
    const fields = Object.keys(ticket || {});
    if (fields.length !== NORMAL_TICKET_FIELDS.size ||
        fields.some(field => !NORMAL_TICKET_FIELDS.has(field) || FORBIDDEN_METADATA.test(field)) ||
        !ticket.blinded_request || !ticket.signed_response || !ticket.finalized_ticket || !ticket.created_at) {
        throw new Error('A prepared ticket contained unexpected entitlement metadata.');
    }
    return ticket;
}

function normalizeIssuer(value) {
    if (!value || typeof value.publicKey !== 'string' || !value.publicKey ||
        typeof value.keyId !== 'string' || !/^[0-9a-f]{64}$/.test(value.keyId)) {
        throw new Error('The entitlement issuer returned an invalid public key response.');
    }
    return { publicKey: value.publicKey, keyId: value.keyId };
}

function yieldToBrowser() {
    return new Promise(resolve => setTimeout(resolve, 0));
}

export class EntitlementTicketPreparer {
    constructor(options = {}) {
        this.pendingStore = options.pendingStore || entitlementClaimRecoveryStore;
        this.privacyPass = options.privacyPass || privacyPassProvider;
        this.ticketStore = options.ticketStore || ticketStore;
        this.lockManager = options.lockManager || globalThis.navigator?.locks || null;
        this.pendingPublications = new WeakMap();
        this.publicationTasks = new WeakMap();
        this.publishedResults = new WeakSet();
        this.lockOptions = {
            timeoutMs: options.lockWaitTimeoutMs ?? 30_000,
            setTimeoutImpl: options.setTimeoutImpl,
            clearTimeoutImpl: options.clearTimeoutImpl
        };
    }

    async acquirePublicationOwnership(scope, signal) {
        if (!this.lockManager?.request) {
            const error = new Error('This browser cannot safely coordinate ticket publication across tabs.');
            error.code = 'ENTITLEMENT_BROWSER_LOCK_UNAVAILABLE';
            throw error;
        }
        const lockName = `oa-entitlement-publication-v1:${await sha256(scope)}`;
        let acquiredResolve;
        let acquiredReject;
        let releaseGate;
        let acquiredLock = false;
        let committing = false;
        let released = false;
        const acquired = new Promise((resolve, reject) => {
            acquiredResolve = resolve;
            acquiredReject = reject;
        });
        const gate = new Promise(resolve => { releaseGate = resolve; });
        const release = () => {
            if (released) return;
            released = true;
            signal?.removeEventListener?.('abort', handleAbort);
            releaseGate();
        };
        const handleAbort = () => {
            if (!committing) release();
        };
        signal?.addEventListener?.('abort', handleAbort, { once: true });
        const lockTask = requestQueuedLock(
            this.lockManager, lockName, signal,
            async () => {
                if (signal?.aborted) throw abortError();
                acquiredLock = true;
                acquiredResolve();
                await gate;
            }, this.lockOptions
        );
        void Promise.resolve(lockTask).catch(error => {
            if (!acquiredLock) {
                signal?.removeEventListener?.('abort', handleAbort);
                acquiredReject(error);
            }
        });
        await acquired;
        return {
            beginCommit() {
                if (released || signal?.aborted) throw abortError();
                committing = true;
                signal?.removeEventListener?.('abort', handleAbort);
            },
            release
        };
    }

    getPending(scope) {
        return this.pendingStore.get(scope).then(record => {
            if (!record) return null;
            return Object.freeze({
                source: record.source === 'topup' ? 'topup' : 'subscription',
                claimRef: record.source === 'topup' ? record.claimRef || null : null,
                issuerFingerprint: record.issuerFingerprint || null,
                phase: record.phase || null
            });
        });
    }

    async prepare(options = {}) {
        const {
            scope,
            ticketCount,
            source = 'subscription',
            claimRef = null,
            fetchIssuerPublicKey,
            claimBlindedRequests,
            signal,
            onProgress
        } = options;
        const requestedCount = ticketCount == null ? null : Number(ticketCount);
        if (!scope || (requestedCount !== null &&
            (!Number.isInteger(requestedCount) || requestedCount < 1 || requestedCount > 5000))) {
            throw new Error('Entitlement preparation requires a scope and a valid ticket count for a new claim.');
        }
        if (typeof fetchIssuerPublicKey !== 'function' || typeof claimBlindedRequests !== 'function') {
            throw new Error('Entitlement preparation requires issuer and claim operations.');
        }
        if (signal?.aborted) throw abortError();

        onProgress?.({ phase: 'waiting', reason: 'storage', completed: 0, total: requestedCount });
        await this.ticketStore.init?.();
        const execute = () => this.runPreparation({
            scope,
            requestedCount,
            source,
            claimRef,
            fetchIssuerPublicKey,
            claimBlindedRequests,
            signal,
            onProgress
        });
        const lockName = `oa-entitlement-claim-v2:${await sha256(scope)}`;
        if (this.lockManager?.request) {
            onProgress?.({ phase: 'waiting', reason: 'lock', completed: 0, total: requestedCount });
            return requestQueuedLock(this.lockManager, lockName, signal, execute, this.lockOptions);
        }
        if (typeof window !== 'undefined') {
            const error = new Error('This browser cannot safely coordinate ticket preparation across tabs.');
            error.code = 'ENTITLEMENT_BROWSER_LOCK_UNAVAILABLE';
            throw error;
        }
        return execute();
    }

    async runPreparation(options) {
        const {
            scope,
            requestedCount,
            source,
            claimRef,
            fetchIssuerPublicKey,
            claimBlindedRequests,
            signal,
            onProgress
        } = options;
        const assertActive = () => {
            if (signal?.aborted) throw abortError();
        };
        const discardRotatedPending = async () => {
            await this.pendingStore.delete(scope);
            const error = new Error('The monthly ticket issuer changed. The saved private batch was discarded.');
            error.code = 'ENTITLEMENT_ISSUER_ROTATED';
            throw error;
        };
        const fetchCurrentIssuer = async () => {
            const issuer = normalizeIssuer(await fetchIssuerPublicKey(signal));
            assertActive();
            return issuer;
        };
        const assertIssuerCurrent = async expectedKeyId => {
            const issuer = await fetchCurrentIssuer();
            if (expectedKeyId && expectedKeyId !== issuer.keyId) await discardRotatedPending();
            return issuer;
        };

        onProgress?.({ phase: 'waiting', reason: 'storage', completed: 0, total: requestedCount });
        let pending = await this.pendingStore.get(scope);
        const hasSignedRecovery = Array.isArray(pending?.signedResponses);
        const targetCount = hasSignedRecovery
            ? Number(pending.targetCount)
            : (requestedCount ?? Number(pending?.targetCount));
        if (!Number.isInteger(targetCount) || targetCount < 1 || targetCount > 5000) {
            const error = new Error('No saved entitlement preparation exists for this scope.');
            error.code = 'ENTITLEMENT_RECOVERY_NOT_FOUND';
            throw error;
        }
        const intendedSource = pending?.source || source || 'subscription';
        const intendedClaimRef = pending?.claimRef ?? claimRef ?? null;
        const updateProgress = (phase, completed) => {
            onProgress?.({
                phase,
                completed,
                total: targetCount,
                source: intendedSource
            });
        };

        onProgress?.({ phase: 'waiting', reason: 'issuer', completed: 0, total: targetCount });
        const currentIssuer = await fetchCurrentIssuer();
        if (pending) {
            const legacyFingerprint = await sha256(currentIssuer.publicKey);
            const expectedFingerprint = pending.issuerFingerprint;
            const fingerprintMatches = pending.issuerFingerprintVersion === 2
                ? expectedFingerprint === currentIssuer.keyId
                : expectedFingerprint === legacyFingerprint || expectedFingerprint === currentIssuer.keyId;
            if (!fingerprintMatches) await discardRotatedPending();
            if (pending.issuerFingerprintVersion !== 2 || pending.issuerFingerprint !== currentIssuer.keyId) {
                pending = await this.pendingStore.put({
                    ...pending,
                    issuerFingerprint: currentIssuer.keyId,
                    issuerFingerprintVersion: 2
                });
            }
        }
        if (!pending) {
            pending = await this.pendingStore.put({
                accountScope: scope,
                source: intendedSource,
                claimRef: intendedClaimRef,
                issuerFingerprint: currentIssuer.keyId,
                issuerFingerprintVersion: 2,
                targetCount,
                generatedCount: 0,
                requests: [],
                signedResponses: null,
                finalizedTickets: [],
                finalizedCount: 0,
                phase: 'generating',
                createdAt: new Date().toISOString()
            });
        }
        if (pending.targetCount !== targetCount || pending.accountScope !== scope ||
            (pending.source || 'subscription') !== intendedSource ||
            (intendedSource === 'topup' && pending.claimRef !== intendedClaimRef)) {
            throw new Error('Saved entitlement preparation does not match this account or allowance.');
        }

        if (!pending.signedResponses) {
            updateProgress('generating', pending.generatedCount);
            while (pending.generatedCount < targetCount) {
                assertActive();
                const end = Math.min(pending.generatedCount + CHUNK_SIZE, targetCount);
                for (let index = pending.generatedCount; index < end; index += 1) {
                    const created = await this.privacyPass.createSingleTokenRequest(currentIssuer.publicKey);
                    pending.requests.push({
                        index,
                        blindedRequest: created.blindedRequest,
                        serializedState: created.serializedState ||
                            this.privacyPass.serializeState(created.state, currentIssuer.publicKey)
                    });
                }
                pending.generatedCount = end;
                pending.phase = 'generating';
                pending = await this.pendingStore.put(pending);
                updateProgress('generating', end);
                await yieldToBrowser();
            }

            const roundTrip = await this.pendingStore.get(scope);
            if (!roundTrip || roundTrip.requests?.length !== targetCount ||
                roundTrip.requests.some((request, index) =>
                    request.index !== index || !request.blindedRequest || !request.serializedState)) {
                throw new Error('Entitlement preparation was not saved completely.');
            }
            assertActive();
            updateProgress('claiming', 0);
            let claim;
            try {
                claim = await claimBlindedRequests(
                    roundTrip.requests.map(request => [request.index, request.blindedRequest]),
                    {
                        signal,
                        expectedKeyId: pending.issuerFingerprint,
                        source: intendedSource,
                        claimRef: intendedClaimRef
                    }
                );
            } catch (error) {
                if (error?.code === 'BILLING_ISSUER_ROTATED' || error?.code === 'ENTITLEMENT_ISSUER_ROTATED') {
                    await discardRotatedPending();
                }
                throw error;
            }
            assertActive();
            pending.signedResponses = normalizeClaimResponses(claim, targetCount);
            pending.phase = 'signed';
            pending = await this.pendingStore.put(pending);
        }

        await assertIssuerCurrent(pending.issuerFingerprint);
        const signedMap = new Map(pending.signedResponses.map(entry => [entry[0], entry[1]]));
        while ((pending.finalizedCount || 0) < targetCount) {
            assertActive();
            const start = pending.finalizedCount || 0;
            const end = Math.min(start + CHUNK_SIZE, targetCount);
            for (let index = start; index < end; index += 1) {
                const request = pending.requests[index];
                const signedResponse = signedMap.get(index);
                const finalized = await this.privacyPass.finalizeToken(signedResponse, request.serializedState);
                pending.finalizedTickets[index] = validatePreparedTicket({
                    blinded_request: request.blindedRequest,
                    signed_response: signedResponse,
                    finalized_ticket: finalized,
                    created_at: new Date().toISOString()
                });
            }
            pending.finalizedCount = end;
            pending.phase = 'finalizing';
            pending = await this.pendingStore.put(pending);
            updateProgress('finalizing', end);
            await yieldToBrowser();
        }

        assertActive();
        await assertIssuerCurrent(pending.issuerFingerprint);
        if (!['ready-to-publish', 'imported', 'published'].includes(pending.phase)) {
            const before = this.ticketStore.getCount();
            const walletValues = new Set([
                ...this.ticketStore.getTickets(),
                ...(this.ticketStore.getArchiveTickets?.() || [])
            ].map(ticket => ticket.finalized_ticket));
            const stagedTicketsAdded = pending.finalizedTickets
                .map(validatePreparedTicket)
                .filter(ticket => !walletValues.has(ticket.finalized_ticket))
                .length;
            pending.phase = 'ready-to-publish';
            pending.walletCountBefore = before;
            pending.walletCountAfter = before + stagedTicketsAdded;
            pending.stagedTicketsAdded = stagedTicketsAdded;
            pending = await this.pendingStore.put(pending);
        }

        onProgress?.({ phase: 'waiting', reason: 'publication', completed: targetCount, total: targetCount });
        const ownership = await this.acquirePublicationOwnership(scope, signal);
        try {
            // Another tab may have completed publication while this tab waited
            // for the per-scope publication lock. Never replay its completion.
            pending = await this.pendingStore.get(scope);
            if (!pending) {
                ownership.release();
                return {
                    ticketsAdded: 0,
                    totalActive: this.ticketStore.getCount(),
                    source: intendedSource,
                    claimRef: intendedSource === 'topup' ? intendedClaimRef : null,
                    publicationObserved: true
                };
            }
            if (pending.accountScope !== scope ||
                !['ready-to-publish', 'imported', 'published'].includes(pending.phase)) {
                throw new Error('Saved entitlement publication does not match this account or batch.');
            }

            const walletValues = new Set([
                ...this.ticketStore.getTickets(),
                ...(this.ticketStore.getArchiveTickets?.() || [])
            ].map(ticket => ticket.finalized_ticket));
            const preparedTickets = pending.finalizedTickets.map(validatePreparedTicket);
            const missingTickets = preparedTickets.filter(
                ticket => !walletValues.has(ticket.finalized_ticket)
            );
            if (missingTickets.length === 0) {
                // A prior owner may have reached the live-wallet commit before
                // closing. A published checkpoint needs cleanup only. A
                // ready/imported checkpoint still owes its aggregate update,
                // which must use the same post-panel publication handshake.
                const stagedTicketsAdded = Math.max(
                    0,
                    Number(pending.stagedTicketsAdded || 0)
                );
                if (pending.phase !== 'published' && stagedTicketsAdded > 0) {
                    const result = {
                        ticketsAdded: stagedTicketsAdded,
                        totalActive: this.ticketStore.getCount(),
                        source: intendedSource,
                        claimRef: intendedSource === 'topup' ? intendedClaimRef : null,
                        ticketUpdateDeferred: true,
                        publicationOnly: true
                    };
                    this.pendingPublications.set(result, { scope, ownership });
                    return result;
                }
                await this.cleanupPublicationRecord(scope);
                ownership.release();
                return {
                    ticketsAdded: 0,
                    totalActive: this.ticketStore.getCount(),
                    source: intendedSource,
                    claimRef: intendedSource === 'topup' ? intendedClaimRef : null,
                    publicationObserved: true
                };
            }

            const result = {
                ticketsAdded: Math.max(0, Number(pending.stagedTicketsAdded || missingTickets.length)),
                totalActive: Math.max(0, this.ticketStore.getCount() + missingTickets.length),
                source: intendedSource,
                claimRef: intendedSource === 'topup' ? intendedClaimRef : null,
                ticketUpdateDeferred: true
            };
            this.pendingPublications.set(result, { scope, ownership });
            return result;
        } catch (error) {
            ownership.release();
            throw error;
        }
    }

    expectedAccountId(scope) {
        const value = String(scope || '');
        if (value.startsWith('account:') && value.length > 'account:'.length) {
            return value.slice('account:'.length);
        }
        if (value.startsWith('demo:') && value.length > 'demo:'.length) return null;
        throw new Error('Prepared ticket publication has an invalid account scope.');
    }

    async cleanupPublicationRecord(scope) {
        try {
            await this.pendingStore.delete(scope);
            return true;
        } catch (error) {
            // The live wallet commit is authoritative. Leaving an imported
            // recovery record is safe and lets a later startup retry cleanup.
            console.warn(
                '[Tickets] Prepared-ticket recovery cleanup paused:',
                String(error?.code || error?.name || 'UNKNOWN')
            );
            return false;
        }
    }

    async publishPreparedTicketUpdate(result) {
        if (!result || typeof result !== 'object' || result.ticketUpdateDeferred !== true) return false;
        if (this.publishedResults.has(result)) return false;
        const existingTask = this.publicationTasks.get(result);
        if (existingTask) return existingTask;
        const publication = this.pendingPublications.get(result);
        if (!publication?.scope) return false;
        publication.ownership?.beginCommit?.();

        const task = (async () => {
            const expectedAccountId = this.expectedAccountId(publication.scope);
            await this.ticketStore.assertAccountScope?.(expectedAccountId);
            const pending = await this.pendingStore.get(publication.scope);
            if (!pending || pending.accountScope !== publication.scope) {
                throw new Error('Prepared ticket publication could not restore its account scope.');
            }
            const preparedTickets = pending.finalizedTickets?.map(validatePreparedTicket) || [];
            if (preparedTickets.length !== pending.targetCount) {
                throw new Error('Prepared ticket publication is incomplete.');
            }

            const walletValues = new Set([
                ...this.ticketStore.getTickets(),
                ...(this.ticketStore.getArchiveTickets?.() || [])
            ].map(ticket => ticket.finalized_ticket));
            const missingTickets = preparedTickets.filter(
                ticket => !walletValues.has(ticket.finalized_ticket)
            );
            if (missingTickets.length > 0) {
                await this.ticketStore.addTickets(missingTickets, {
                    requireDurable: true,
                    emitUpdate: false,
                    skipBroadcast: true,
                    skipSync: true,
                    expectedAccountId
                });
                const confirmedWalletValues = new Set([
                    ...this.ticketStore.getTickets(),
                    ...(this.ticketStore.getArchiveTickets?.() || [])
                ].map(ticket => ticket.finalized_ticket));
                if (!preparedTickets.every(ticket => confirmedWalletValues.has(ticket.finalized_ticket))) {
                    throw new Error('Prepared tickets were not imported into the local wallet.');
                }
            }
            if (pending.phase !== 'imported' && pending.phase !== 'published') {
                pending.phase = 'imported';
                pending.walletCountAfter = this.ticketStore.getCount();
                try {
                    await this.pendingStore.put(pending);
                } catch (error) {
                    // The prepared tickets are already durable in the live
                    // wallet. Continue to the scoped aggregate update; the
                    // older staged checkpoint remains safe for later cleanup.
                    console.warn(
                        '[Tickets] Prepared-ticket checkpoint paused:',
                        String(error?.code || error?.name || 'UNKNOWN')
                    );
                }
            }

            // Account state can change while the durable wallet write and
            // recovery checkpoint are in flight. Re-check immediately before
            // any observable update leaves this tab.
            await this.ticketStore.assertAccountScope?.(expectedAccountId);
            this.ticketStore.publishUpdate({ expectedAccountId });
            pending.phase = 'published';
            try {
                await this.pendingStore.put(pending);
            } catch {
                // The aggregate update is already visible. Cleanup remains a
                // best-effort idempotent operation.
            }
            this.publishedResults.add(result);
            this.pendingPublications.delete(result);
            await this.cleanupPublicationRecord(publication.scope);
            return true;
        })();
        this.publicationTasks.set(result, task);
        try {
            return await task;
        } finally {
            this.publicationTasks.delete(result);
            publication.ownership?.release();
        }
    }

    releasePreparedTicketPublication(result) {
        const publication = result && typeof result === 'object'
            ? this.pendingPublications.get(result)
            : null;
        if (!publication) return false;
        if (this.publicationTasks.has(result)) return false;
        this.pendingPublications.delete(result);
        publication.ownership?.release();
        return true;
    }
}

const defaultPreparer = new EntitlementTicketPreparer();

export function prepareEntitlementBatch(options) {
    return defaultPreparer.prepare(options);
}

export function getPendingEntitlementClaim(scope) {
    return defaultPreparer.getPending(scope);
}

export function publishPreparedTicketUpdate(result) {
    return defaultPreparer.publishPreparedTicketUpdate(result);
}

export function releasePreparedTicketPublication(result) {
    return defaultPreparer.releasePreparedTicketPublication(result);
}
