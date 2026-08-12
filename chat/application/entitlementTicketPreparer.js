import privacyPassProvider from '../services/privacyPass.js';
import ticketStore from '../services/ticketStore.js';
import entitlementClaimRecoveryStore from '../services/entitlementClaimRecoveryStore.js';

const CHUNK_SIZE = 10;
const NORMAL_TICKET_FIELDS = new Set([
    'blinded_request',
    'signed_response',
    'finalized_ticket',
    'created_at'
]);
const FORBIDDEN_METADATA = /account|stripe|subscription|entitlement|claim/i;
const CLAIM_RESPONSE_FIELDS = new Set(['signed_responses', 'tickets_issued', 'replayed']);
const CLAIM_CONTEXT_PATTERN = /^(?:subscription|topup:[0-9a-f]{64})$/;

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
    if (Object.hasOwn(data || {}, 'tickets_issued') && data.tickets_issued !== expectedCount) {
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

function yieldToBrowser() {
    return new Promise(resolve => setTimeout(resolve, 0));
}

function normalizeClaimContext(value, { allowMissing = false } = {}) {
    if ((value === undefined || value === null || value === '') && allowMissing) return null;
    const normalized = String(value || 'subscription');
    if (!CLAIM_CONTEXT_PATTERN.test(normalized)) {
        const error = new Error('Entitlement preparation received an invalid claim context.');
        error.code = 'ENTITLEMENT_INVALID_CLAIM_CONTEXT';
        throw error;
    }
    return normalized;
}

export class EntitlementTicketPreparer {
    constructor(options = {}) {
        this.pendingStore = options.pendingStore || entitlementClaimRecoveryStore;
        this.privacyPass = options.privacyPass || privacyPassProvider;
        this.ticketStore = options.ticketStore || ticketStore;
        this.lockManager = options.lockManager || globalThis.navigator?.locks || null;
    }

    async prepare(options = {}) {
        const {
            scope,
            ticketCount,
            fetchIssuerPublicKey,
            claimBlindedRequests,
            claimContext,
            signal,
            onProgress
        } = options;
        const requestedCount = ticketCount == null ? null : Number(ticketCount);
        if (!scope || (requestedCount !== null && (!Number.isInteger(requestedCount) || requestedCount < 1))) {
            throw new Error('Entitlement preparation requires a scope and, for a new claim, a positive integer ticket count.');
        }
        if (typeof fetchIssuerPublicKey !== 'function' || typeof claimBlindedRequests !== 'function') {
            throw new Error('Entitlement preparation requires issuer and claim operations.');
        }
        const requestedClaimContext = normalizeClaimContext(claimContext, {
            allowMissing: requestedCount === null
        });
        if (signal?.aborted) throw abortError();

        await this.ticketStore.init?.();
        const execute = () => this.runPreparation({
            scope,
            requestedCount,
            fetchIssuerPublicKey,
            claimBlindedRequests,
            requestedClaimContext,
            signal,
            onProgress
        });
        const lockName = `oa-entitlement-claim-v1:${await sha256(scope)}`;
        if (this.lockManager?.request) {
            return this.lockManager.request(lockName, { mode: 'exclusive', signal }, execute);
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
            fetchIssuerPublicKey,
            claimBlindedRequests,
            requestedClaimContext,
            signal,
            onProgress
        } = options;
        const assertActive = () => {
            if (signal?.aborted) throw abortError();
        };

        assertActive();
        let pending = await this.pendingStore.get(scope);
        // Once signatures have been issued, that saved batch is irreversible
        // and must be finalized before considering a newly advertised batch.
        const hasSignedRecovery = Array.isArray(pending?.signedResponses);
        const targetCount = hasSignedRecovery
            ? Number(pending?.targetCount)
            : (requestedCount ?? Number(pending?.targetCount));
        if (!Number.isInteger(targetCount) || targetCount < 1) {
            const error = new Error('No saved entitlement preparation exists for this scope.');
            error.code = 'ENTITLEMENT_RECOVERY_NOT_FOUND';
            throw error;
        }
        const savedClaimContext = pending
            ? normalizeClaimContext(pending.claimContext || 'subscription')
            : null;
        const activeClaimContext = savedClaimContext || requestedClaimContext || 'subscription';
        const updateProgress = (phase, completed) => onProgress?.({
            phase,
            completed,
            total: targetCount,
            accountScope: scope,
            source: activeClaimContext.startsWith('topup:') ? 'topup' : 'subscription'
        });
        if (!pending) {
            const publicKey = await fetchIssuerPublicKey(signal);
            assertActive();
            pending = await this.pendingStore.put({
                accountScope: scope,
                claimContext: activeClaimContext,
                issuerFingerprint: await sha256(publicKey),
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
            (!hasSignedRecovery && requestedClaimContext && activeClaimContext !== requestedClaimContext)) {
            throw new Error('Saved entitlement preparation does not match this account or allowance.');
        }

        if (!pending.signedResponses) {
            const currentPublicKey = await fetchIssuerPublicKey(signal);
            assertActive();
            if (await sha256(currentPublicKey) !== pending.issuerFingerprint) {
                throw new Error('The ticket issuer changed. The saved batch was not submitted.');
            }
            while (pending.generatedCount < targetCount) {
                assertActive();
                const end = Math.min(pending.generatedCount + CHUNK_SIZE, targetCount);
                for (let index = pending.generatedCount; index < end; index += 1) {
                    const created = await this.privacyPass.createSingleTokenRequest(currentPublicKey);
                    pending.requests.push({
                        index,
                        blindedRequest: created.blindedRequest,
                        serializedState: created.serializedState ||
                            this.privacyPass.serializeState(created.state, currentPublicKey)
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
                throw new Error('Ticket preparation was not saved completely.');
            }
            assertActive();
            updateProgress('claiming', 0);
            const claim = await claimBlindedRequests(
                roundTrip.requests.map(request => [request.index, request.blindedRequest]),
                { signal, claimContext: activeClaimContext }
            );
            assertActive();
            pending.signedResponses = normalizeClaimResponses(claim, targetCount);
            pending.phase = 'signed';
            pending = await this.pendingStore.put(pending);
        }

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
        const before = this.ticketStore.getCount();
        await this.ticketStore.addTickets(
            pending.finalizedTickets.map(validatePreparedTicket),
            { requireDurable: true }
        );
        const walletValues = new Set([
            ...this.ticketStore.getTickets(),
            ...(this.ticketStore.getArchiveTickets?.() || [])
        ].map(ticket => ticket.finalized_ticket));
        if (!pending.finalizedTickets.every(ticket => walletValues.has(ticket.finalized_ticket))) {
            throw new Error('Prepared tickets were not imported into the local wallet.');
        }

        const after = this.ticketStore.getCount();
        pending.phase = 'imported';
        pending.walletCountBefore = before;
        pending.walletCountAfter = after;
        await this.pendingStore.put(pending);
        await this.pendingStore.delete(scope);
        return { ticketsAdded: Math.max(0, after - before), totalActive: after };
    }
}

const defaultPreparer = new EntitlementTicketPreparer();

export function prepareEntitlementBatch(options) {
    return defaultPreparer.prepare(options);
}
