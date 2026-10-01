/**
 * Ticket Client -- inference ticket lifecycle and ephemeral API key requests.
 *
 * Unlinkability model (for auditors):
 *
 * This module talks to the org API for ticket issuance and ephemeral API key requests.
 * The org does NOT need to be trusted for unlinkability:
 *
 * 1. All blinding/unblinding runs client-side (privacyPass.js). The org
 *    only ever sees blinded requests at issuance and finalized (unblinded)
 *    tickets at redemption -- these are cryptographically unlinkable.
 *
 * 2. Even a fully malicious org cannot link issuance to redemption, cannot see
 *    inference prompts/responses, and cannot deanonymize users. Its worst case
 *    is denial of service, not privacy breach.
 *
 * 3. The org being closed-source does not affect unlinkability -- the
 *    security-critical crypto runs client-side via @cloudflare/privacypass-ts
 *    (Apache-2.0, auditable pure JS, no WASM).
 *
 * 4. Defense-in-depth: even if blind signature unlinkability were somehow
 *    weakened through side channels (timing, IP), no OA system sees prompts or
 *    responses (sent directly from browser to provider), so inference remains
 *    unlinkable regardless.
 *
 * See docs/PRIVACY_MODEL.md, docs/UNLINKABILITY_PROOF.md, and
 * https://openanonymity.ai/blog/unlinkable-inference/
 */

import privacyPassProvider from './privacyPass.js';
import networkLogger from './networkLogger.js';
import networkProxy from './networkProxy.js';
import ticketStore from './ticketStore.js';
import ticketCodeRecoveryStore from './ticketCodeRecoveryStore.js';
import { chatDB } from '../db.js';
import syncService from './encryptedSyncService.js';
import accountService from './accountService.js';
import { TicketCodeRedeemer } from '../application/ticketCodeRedeemer.js';
import { LegacyTicketTransfer } from '../application/legacyTicketTransfer.js';
import sessionService from './sessionService.js';
import { ORG_API_BASE } from './orgEndpoints.js';
import {
    getStructuredTicketError,
    normalizeTicketKeyId
} from '../domain/ticketKeys.js';

const LEGACY_TRANSFER_PATH = '/api/billing/legacy-transfer';
const LEGACY_TRANSFER_WAIT_MS = 20000;

class TicketClient {
    constructor() {
        console.log('🚀 Initializing TicketClient');
        this.ppExtension = privacyPassProvider;
        this.ticketStore = ticketStore;
        console.log('📊 TicketClient ready');
    }

    getNextTicket() {
        return this.ticketStore.peekTicket();
    }

    /**
     * Get multiple available tickets for multi-ticket requests.
     * @param {number} count - Number of tickets to retrieve
     * @returns {Array} Array of available tickets (may be fewer than requested)
     */
    getNextTickets(count = 1) {
        return this.ticketStore.peekTickets(count);
    }

    getTickets() {
        return this.ticketStore.getTickets();
    }

    getTicketCount() {
        // Previous-version tickets that cannot move are kept but never usable.
        return this.ticketStore.getCount() - (this.ticketStore.getStrandedCount?.() || 0);
    }

    /**
     * The count to show. While previous-version tickets are being moved, the
     * old ones leave the wallet before their replacements are signed; the
     * count shown holds at its value from the start of the move so it never
     * dips to zero (or doubles) on the way. Spending logic keeps using
     * getTicketCount().
     */
    getVisibleTicketCount() {
        const count = this.getTicketCount();
        return this.legacyMove?.accountId === this.getLegacyDisplayAccountId()
            ? Math.max(count, this.legacyMove.baseline) : count;
    }

    /** Previous-version tickets kept in the wallet that could not be moved. */
    getStrandedTicketCount() {
        return this.ticketStore.getStrandedCount?.() || 0;
    }

    /** Previous-version tickets waiting to move, or being moved right now. */
    getMovingTicketCount() {
        if (this.legacyMove?.accountId === this.getLegacyDisplayAccountId()) return this.legacyMove.tickets;
        return this.ticketStore.getHeldCount?.() || 0;
    }

    getArchivedTicketCount() {
        return this.ticketStore.getArchiveCount();
    }

    clearTickets() {
        console.log('🗑️  All tickets cleared');
        return this.ticketStore.clearTickets();
    }

    async importTickets(payload) {
        return this.ticketStore.importTickets(payload);
    }

    createTicketRedemptionError(data, status, fallbackMessage) {
        const parsed = getStructuredTicketError(data, fallbackMessage);
        const messageLower = String(parsed.message || '').toLowerCase();

        if (parsed.code === 'TICKET_KEY_INVALIDATED') {
            const error = new Error('The org rotated its ticket signing key. Tickets from the old key were invalidated.');
            error.code = 'TICKET_KEY_INVALIDATED';
            error.status = status;
            error.invalidatedKeyId = parsed.invalidatedKeyId;
            error.serverMessage = parsed.message;
            return error;
        }

        if (parsed.code === 'TICKET_KEY_LEGACY') {
            // Previous-org tickets: nothing was spent and they must be kept.
            const error = new Error('Your tickets from the previous version are being moved. Please try again in a moment.');
            error.code = 'TICKET_KEY_LEGACY';
            error.status = status;
            error.legacyKeyId = normalizeTicketKeyId(parsed.detail?.legacy_key_id);
            error.serverMessage = parsed.message;
            return error;
        }

        if (parsed.code === 'TICKET_ALREADY_SPENT' ||
            (!parsed.code && status === 401 && (
                messageLower.includes('double') ||
                messageLower.includes('spent') ||
                messageLower.includes('used')
            ))) {
            const error = new Error('One or more tickets were already used. Please try again.');
            error.code = 'TICKET_USED';
            error.status = status;
            error.consumeTickets = true;
            return error;
        }

        const error = new Error(parsed.message || fallbackMessage);
        error.code = parsed.code || undefined;
        error.status = status;
        error.data = data;
        return error;
    }

    notifyTicketKeyInvalidation(error) {
        if (error?.code !== 'TICKET_KEY_INVALIDATED' || error.invalidationNotified) return;
        error.invalidationNotified = true;
        if (typeof window === 'undefined') return;

        window.dispatchEvent(new CustomEvent('ticket-key-invalidated', {
            detail: {
                keyId: error.invalidatedKeyId || null,
                removedCount: Number(error.invalidatedTicketsRemoved || 0),
                remainingCount: Number(error.remainingTickets || this.getTicketCount())
            }
        }));
    }

    getRetryAfterSeconds(response, data) {
        const bodySeconds = Number.parseInt(data?.retry_after_seconds, 10);
        if (Number.isFinite(bodySeconds) && bodySeconds > 0) {
            return bodySeconds;
        }

        const retryAfterHeader = response?.headers?.get?.('Retry-After');
        if (!retryAfterHeader) return null;

        const retryAfterSeconds = Number.parseInt(retryAfterHeader, 10);
        if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0) {
            return retryAfterSeconds;
        }

        const retryAfterDate = Date.parse(retryAfterHeader);
        if (Number.isFinite(retryAfterDate)) {
            const ms = retryAfterDate - Date.now();
            if (ms > 0) {
                return Math.ceil(ms / 1000);
            }
        }

        return null;
    }

    createFreeAccessError(message, options = {}) {
        const error = new Error(message);
        if (options.code) error.code = options.code;
        if (Number.isFinite(options.status)) error.status = options.status;
        if (Number.isFinite(options.retryAfterSeconds) && options.retryAfterSeconds > 0) {
            error.retryAfterSeconds = options.retryAfterSeconds;
        }
        return error;
    }

    createWaitlistError(message, options = {}) {
        const error = new Error(message);
        if (options.code) error.code = options.code;
        if (Number.isFinite(options.status)) error.status = options.status;
        if (Number.isFinite(options.retryAfterSeconds) && options.retryAfterSeconds > 0) {
            error.retryAfterSeconds = options.retryAfterSeconds;
        }
        return error;
    }

    isValidEmailInput(value) {
        const trimmed = (value || '').trim();
        if (!trimmed || trimmed.length > 254) return false;
        return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed);
    }

    getQueryParams() {
        if (typeof window === 'undefined') return {};
        const params = new URLSearchParams(window.location.search);
        const result = {};
        params.forEach((value, key) => {
            if (value !== '') result[key] = value;
        });
        return result;
    }

    cleanPayload(payload) {
        return Object.fromEntries(
            Object.entries(payload).filter(([, value]) => value !== undefined && value !== null && value !== '')
        );
    }

    getWaitlistAccessToken() {
        if (typeof window === 'undefined') return null;
        return typeof window.OA_ACCESS_TOKEN === 'string' && window.OA_ACCESS_TOKEN.trim()
            ? window.OA_ACCESS_TOKEN.trim()
            : null;
    }

    async joinWaitlist(options = {}) {
        const email = (options.email || '').trim();
        if (!this.isValidEmailInput(email)) {
            throw this.createWaitlistError('Please enter a valid email address.', {
                code: 'WAITLIST_INVALID_EMAIL'
            });
        }

        const queryParams = this.getQueryParams();
        const utmKeys = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'];
        const queryUtm = utmKeys.reduce((acc, key) => {
            const value = queryParams[key];
            if (value) acc[key] = value;
            return acc;
        }, {});

        const referralFromQuery =
            queryParams.referral_code ||
            queryParams.ref ||
            queryParams.referral ||
            null;

        const payload = this.cleanPayload({
            email,
            name: (options.name || '').trim(),
            affiliation: (options.affiliation || '').trim(),
            source: (options.source || queryParams.source || 'beta').trim(),
            referral_code: (options.referralCode || referralFromQuery || '').trim(),
            ...queryUtm
        });

        const waitlistUrl = `${ORG_API_BASE}/api/waitlist/join`;
        const accessToken = this.getWaitlistAccessToken();
        const requestHeaders = {
            'Content-Type': 'application/json',
            ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {})
        };

        let response;
        let data;
        let text;

        try {
            ({ response, data, text } = await networkProxy.fetchWithRetryJson(
                waitlistUrl,
                {
                    method: 'POST',
                    headers: requestHeaders,
                    body: JSON.stringify(payload)
                },
                {
                    context: 'Waitlist join',
                    maxAttempts: 1,
                    timeoutMs: 15000,
                    proxyConfig: { bypassProxy: true }
                }
            ));
        } catch (error) {
            networkLogger.logRequest({
                type: 'ticket',
                method: 'POST',
                url: waitlistUrl,
                status: 0,
                request: {
                    headers: networkLogger.sanitizeHeaders(requestHeaders),
                    body: {
                        email: '***',
                        source: payload.source || null,
                        has_referral: !!payload.referral_code,
                        has_name: !!payload.name,
                        has_affiliation: !!payload.affiliation
                    }
                },
                error: error.message
            });

            throw this.createWaitlistError('Unable to submit right now. Please try again.', {
                code: 'WAITLIST_SUBMIT_FAILED'
            });
        }

        networkLogger.logRequest({
            type: 'ticket',
            method: 'POST',
            url: waitlistUrl,
            status: response.status,
            request: {
                headers: networkLogger.sanitizeHeaders(requestHeaders),
                body: {
                    email: '***',
                    source: payload.source || null,
                    has_referral: !!payload.referral_code,
                    has_name: !!payload.name,
                    has_affiliation: !!payload.affiliation
                }
            },
            response: data
        });

        if (response.ok) {
            return {
                message: data?.message || "Thanks for joining! We'll be in touch soon.",
                waitlistEntryId: data?.waitlist_entry_id || data?.entry_id || null,
                waitlistStatus: data?.status || null
            };
        }

        if (response.status === 429) {
            const retryAfterSeconds = this.getRetryAfterSeconds(response, data);
            throw this.createWaitlistError(
                'You are submitting too quickly. Please try again in a moment.',
                {
                    code: 'WAITLIST_RATE_LIMITED',
                    status: response.status,
                    retryAfterSeconds
                }
            );
        }

        if (response.status === 422) {
            throw this.createWaitlistError(
                'Please enter a valid email address.',
                {
                    code: 'WAITLIST_INVALID_PAYLOAD',
                    status: response.status
                }
            );
        }

        throw this.createWaitlistError(
            data?.message || data?.error || data?.detail || text || 'Something went wrong. Please try again.',
            {
                code: data?.code || 'WAITLIST_SUBMIT_FAILED',
                status: response.status
            }
        );
    }

    async isFreeAccessAvailable() {
        const availabilityUrl = `${ORG_API_BASE}/chat/free_access/availability`;
        const requestHeaders = { 'Accept': 'application/json' };

        try {
            const { response, data } = await networkProxy.fetchWithRetryJson(
                availabilityUrl,
                {
                    method: 'GET',
                    headers: requestHeaders
                },
                {
                    context: 'Free access availability',
                    maxAttempts: 1,
                    timeoutMs: 10000,
                    proxyConfig: { bypassProxy: true }
                }
            );

            networkLogger.logRequest({
                type: 'ticket',
                method: 'GET',
                url: availabilityUrl,
                status: response.status,
                request: {
                    headers: networkLogger.sanitizeHeaders(requestHeaders)
                },
                response: data
            });

            if (!response.ok) {
                return {
                    available: false,
                    reasonCode: data?.reason_code || data?.code || `HTTP_${response.status}`,
                    retryAfterSeconds: this.getRetryAfterSeconds(response, data),
                    issuanceEnabled: typeof data?.issuance_enabled === 'boolean' ? data.issuance_enabled : null
                };
            }

            return {
                available: data?.available === true,
                reasonCode: data?.reason_code || (data?.available === true ? 'OK' : 'UNAVAILABLE'),
                retryAfterSeconds: this.getRetryAfterSeconds(response, data),
                issuanceEnabled: typeof data?.issuance_enabled === 'boolean' ? data.issuance_enabled : null
            };
        } catch (error) {
            networkLogger.logRequest({
                type: 'ticket',
                method: 'GET',
                url: availabilityUrl,
                status: 0,
                request: {
                    headers: networkLogger.sanitizeHeaders(requestHeaders)
                },
                error: error.message
            });

            console.warn('Free access availability check failed:', error);
            return {
                available: false,
                reasonCode: 'UNAVAILABLE',
                retryAfterSeconds: null,
                issuanceEnabled: null
            };
        }
    }

    // Unlinkability: the org learns the email here. It will know email -> credential
    // -> N blinded tickets. However, blind signatures still prevent the org from
    // linking specific redeemed finalized tickets back to this email, because blinded
    // requests are cryptographically unlinkable to finalized tickets.
    async requestFreeAccess(email, { cfTurnstileResponse } = {}) {
        const freeAccessUrl = `${ORG_API_BASE}/chat/free_access`;
        const requestHeaders = { 'Content-Type': 'application/json' };
        const requestBody = { email };
        if (cfTurnstileResponse) {
            requestBody.cf_turnstile_response = cfTurnstileResponse;
        }

        let response;
        let data;
        let text;

        try {
            ({ response, data, text } = await networkProxy.fetchWithRetryJson(
                freeAccessUrl,
                {
                    method: 'POST',
                    headers: requestHeaders,
                    body: JSON.stringify(requestBody)
                },
                {
                    context: 'Free access request',
                    maxAttempts: 1,
                    timeoutMs: 15000,
                    proxyConfig: { bypassProxy: true }
                }
            ));
        } catch (error) {
            networkLogger.logRequest({
                type: 'ticket',
                method: 'POST',
                url: freeAccessUrl,
                status: 0,
                request: {
                    headers: networkLogger.sanitizeHeaders(requestHeaders),
                    body: { email: '***' }
                },
                error: error.message
            });
            throw this.createFreeAccessError('Failed to request free access. Please try again.', {
                code: 'FREE_ACCESS_REQUEST_FAILED'
            });
        }

        networkLogger.logRequest({
            type: 'ticket',
            method: 'POST',
            url: freeAccessUrl,
            status: response.status,
            request: {
                headers: networkLogger.sanitizeHeaders(requestHeaders),
                body: { email: '***' }
            },
            response: data
        });

        if (response.status === 200) {
            const accessCode = typeof data?.access_code === 'string'
                ? data.access_code.trim()
                : null;
            return {
                accessCode: accessCode || null,
                ticketsGranted: Number.isFinite(data?.tickets_granted) ? data.tickets_granted : 0,
                waitlistEntryId: data?.waitlist_entry_id || null,
                waitlistStatus: data?.waitlist_status || null,
                waitlistOnly: data?.waitlist_only === true,
                message: data?.message || null
            };
        }

        if (response.status === 409) {
            throw this.createFreeAccessError(
                data?.error || 'Email is already used.',
                {
                    code: data?.code || 'FREE_ACCESS_EMAIL_USED',
                    status: response.status
                }
            );
        }

        if (response.status === 429) {
            const retryAfterSeconds = this.getRetryAfterSeconds(response, data);
            const retryLabel = Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
                ? ` Please retry in about ${retryAfterSeconds} seconds.`
                : '';
            throw this.createFreeAccessError(
                `${data?.error || 'Free access is limited right now.'}${retryLabel}`,
                {
                    code: data?.code || 'FREE_ACCESS_LIMITED',
                    status: response.status,
                    retryAfterSeconds
                }
            );
        }

        if (response.status === 422) {
            throw this.createFreeAccessError(
                'Please enter a valid email address.',
                {
                    code: 'FREE_ACCESS_INVALID_PAYLOAD',
                    status: response.status
                }
            );
        }

        throw this.createFreeAccessError(
            data?.detail || data?.error || data?.message || text || `Free access request failed (${response.status})`,
            {
                code: data?.code || 'FREE_ACCESS_REQUEST_FAILED',
                status: response.status
            }
        );
    }

    async getReadyWalletScope() {
        const account = accountService.getState();
        if (!account.isReady || (account.accountId && (
            !account.sessionVerified || account.status !== 'unlocked' ||
            !account.accountScopeReady || !account.ticketSyncReady
        ))) throw new Error('Wait for your ticket wallet to finish opening, then retry redemption.');
        return syncService.assertAccountDataAccess();
    }

    getCodeRedeemer() {
        if (!this.codeRedeemer) {
            this.codeRedeemer = new TicketCodeRedeemer({
                pendingStore: ticketCodeRecoveryStore,
                privacyPass: this.ppExtension,
                ticketStore: this.ticketStore,
                getAccountScope: () => this.getReadyWalletScope(),
                fetchIssuer: async () => {
                    const { data } = await networkProxy.fetchWithRetryJson(
                        `${ORG_API_BASE}/api/ticket/issue/public-key`,
                        { cache: 'no-store', credentials: 'omit' },
                        { context: 'Public key', maxAttempts: 3, timeoutMs: 10000 }
                    );
                    if (!data?.public_key) throw new Error('Station did not return public key');
                    return data;
                },
                submit: async (body, count) => {
                    const { response, data } = await networkProxy.fetchWithRetryJson(
                        `${ORG_API_BASE}/api/alpha-register`,
                        { method: 'POST', credentials: 'omit', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
                        { context: 'Alpha register', maxAttempts: 3, timeoutMs: Math.max(120000, count * 50) }
                    );
                    if (!response.ok) {
                        const parsed = getStructuredTicketError(data, 'Unable to redeem this ticket code.');
                        const error = new Error(parsed.message);
                        error.code = parsed.code;
                        error.status = response.status;
                        throw error;
                    }
                    return data;
                }
            });
        }
        return this.codeRedeemer;
    }

    async fetchLegacyTransferInfo() {
        const url = `${ORG_API_BASE}${LEGACY_TRANSFER_PATH}`;
        const { response, data } = await networkProxy.fetchWithRetryJson(
            url,
            { cache: 'no-store', credentials: 'omit', headers: { Accept: 'application/json' } },
            { context: 'Ticket move status', maxAttempts: 2, timeoutMs: 10000 }
        );
        // An org without the transfer answers 404: nothing to move.
        if (response.status === 404) return { enabled: false };
        if (!response.ok) throw new Error(`Ticket move status unavailable (${response.status})`);
        return data;
    }

    /**
     * Learn the previous org's key before anyone signs in, so previous-version
     * tickets are held from spending and counted as moving from the first
     * screen after sign-up. Only a wallet that already holds tickets asks.
     */
    async primeLegacyTransfer() {
        if (this.legacyTransferPrimed) return;
        this.legacyTransferPrimed = true;
        try {
            await this.ticketStore.init?.();
            if (!this.ticketStore.getCount()) {
                // Nothing to hold yet. On the first load after a previous-
                // version account is released, the wallet opens only after
                // this runs; the watcher asks again when tickets appear.
                this.legacyTransferPrimed = false;
                return;
            }
            const info = await this.fetchLegacyTransferInfo();
            const keyId = normalizeTicketKeyId(info?.key_id);
            if (info?.enabled === true && keyId && !this.legacyTransferRun) {
                this.ticketStore.setHeldKeyIds([keyId]);
                this.ticketStore.emitUpdate?.();
            }
        } catch (error) {
            // The move itself fetches the same status again after sign-in.
            this.legacyTransferPrimed = false;
            console.warn('Ticket move status could not be read yet:', error);
        }
    }

    getLegacyDisplayAccountId() {
        const account = accountService.getState();
        return account.sessionVerified && account.accountScopeReady &&
            account.accountId === syncService.getLocalAccountScope() ? account.accountId : null;
    }

    hideLegacyMoveToastOnAccountChange() {
        if (this.legacyMove && !this.legacyMove.toastHidden &&
            this.legacyMove.accountId !== this.getLegacyDisplayAccountId()) {
            this.legacyMove.toastHidden = true;
            if (typeof window !== 'undefined') {
                window.dispatchEvent(new CustomEvent('legacy-tickets-move-settled', { detail: { moved: 0 } }));
            }
        }
    }

    handleLegacyMoveStart(tickets, accountId = this.getLegacyDisplayAccountId()) {
        const count = Math.max(0, Number(tickets) || 0);
        if (!count || !accountId || accountId !== this.getLegacyDisplayAccountId()) return;
        this.legacyMove = { accountId, tickets: count, baseline: this.getTicketCount() };
        if (typeof window !== 'undefined') {
            window.dispatchEvent(new CustomEvent('legacy-tickets-moving', { detail: { tickets: count } }));
        }
        this.ticketStore.emitUpdate?.();
    }

    getLegacyTransfer() {
        if (!this.legacyTransfer) {
            const url = `${ORG_API_BASE}${LEGACY_TRANSFER_PATH}`;
            this.legacyTransfer = new LegacyTicketTransfer({
                fetchInfo: () => this.fetchLegacyTransferInfo(),
                onStart: ({ tickets, accountId }) => this.handleLegacyMoveStart(tickets, accountId),
                // Signed-in request: it needs the account session, so it goes
                // through the session transport, not the relay.
                submit: async (tickets, { expectedAccountId }) => {
                    const response = await sessionService.fetch(url, {
                        method: 'POST',
                        credentials: 'include',
                        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
                        body: JSON.stringify({ tickets, expected_account_id: expectedAccountId })
                    });
                    let data = null;
                    try { data = await response.json(); } catch { data = null; }
                    if (!response.ok) {
                        const parsed = getStructuredTicketError(data, `Ticket move failed (${response.status})`);
                        const error = new Error(parsed.message);
                        error.code = parsed.code || undefined;
                        error.status = response.status;
                        // How many more the allowance takes (LEGACY_TRANSFER_LIMIT).
                        const remaining = Number(data?.detail?.remaining);
                        if (Number.isFinite(remaining)) error.remaining = remaining;
                        throw error;
                    }
                    return data;
                },
                listTickets: () => this.ticketStore.getTickets(),
                removeTickets: (tickets, options) => this.ticketStore.removeTickets(tickets, options),
                // A login parks this browser's wallet when the account already
                // had one; old tickets in it move to that account too.
                listParkedTickets: () => syncService.readUnclaimedTickets(),
                removeParkedTickets: (tickets, options) => syncService.removeUnclaimedTickets(tickets, options),
                holdKeyIds: keyIds => this.ticketStore.setHeldKeyIds(keyIds),
                pendingStore: ticketCodeRecoveryStore,
                // Serialized by the origin-wide legacy-transfer lock. Do not
                // scope this key: the next account must see unfinished work.
                attemptStore: {
                    get: () => chatDB.getSetting('legacy-transfer-pending-attempt'),
                    put: value => chatDB.updateSettings([{ key: 'legacy-transfer-pending-attempt', value }]),
                    clear: () => chatDB.updateSettings([], ['legacy-transfer-pending-attempt'])
                },
                getAccountScope: () => this.getReadyWalletScope(),
                redeemPending: options => this.getCodeRedeemer().run(null, undefined, options)
            });
        }
        return this.legacyTransfer;
    }

    /**
     * Move tickets from the previous production org into this wallet. Runs
     * once at a time; callers share the in-flight run.
     */
    runLegacyTransfer() {
        if (!this.legacyTransferRun) {
            const accountId = this.getLegacyDisplayAccountId();
            this.unannouncedLegacyMoves ||= new Map();
            this.legacyTransferRun = (async () => {
                let result = null;
                try {
                    result = await this.getLegacyTransfer().run({ expectedAccountId: accountId });
                    return result;
                } finally {
                    // A run that only redeems a move's saved code (the move
                    // itself settled earlier) has nothing to settle again.
                    const ownsDisplay = accountId && this.getLegacyDisplayAccountId() === accountId;
                    const move = this.legacyMove?.accountId === accountId ? this.legacyMove : null;
                    const wasMoving = Boolean(move) && !move.awaitingRedeem;
                    // The old tickets have left the wallet and their code is
                    // saved, but the new ones are not issued yet (the redeem
                    // failed and is retried). They are still moving: keep the
                    // count where it was rather than drop it to zero and show
                    // "Get tickets" to someone who has tickets on the way.
                    const awaitingRedeem = Boolean(result?.redeemError) &&
                        (Number(result?.moved) > 0 || Boolean(move?.awaitingRedeem));
                    if (move) this.legacyMove = awaitingRedeem
                        ? { ...move, awaitingRedeem: true } : null;
                    this.legacyTransferRun = null;
                    this.ticketStore.emitUpdate?.();
                    // A move counts as done once its new tickets are in the
                    // wallet. When the redeem fails, the saved code is redeemed
                    // by a later run, which then announces the earlier count.
                    // Tickets that cannot move stay held, apart from the
                    // count; a closed window releases everything instead.
                    if (ownsDisplay && result && result.status !== 'signed-out') {
                        this.ticketStore.setStrandedTickets?.(result.stranded || []);
                    }
                    const stranded = this.ticketStore.getStrandedCount?.() || 0;
                    let moved = 0;
                    if (result?.redeemError) {
                        this.unannouncedLegacyMoves.set(accountId, (this.unannouncedLegacyMoves.get(accountId) || 0) + (Number(result.moved) || 0));
                    } else if (result) {
                        moved = Number(result.moved) || 0;
                        if (result.redeemed && this.unannouncedLegacyMoves.has(accountId)) {
                            moved += this.unannouncedLegacyMoves.get(accountId);
                            this.unannouncedLegacyMoves.delete(accountId);
                        }
                    }
                    if (typeof window !== 'undefined') {
                        if (wasMoving) {
                            window.dispatchEvent(new CustomEvent('legacy-tickets-move-settled', { detail: { moved: ownsDisplay ? moved : 0 } }));
                        }
                        if (ownsDisplay && moved > 0) {
                            window.dispatchEvent(new CustomEvent('legacy-tickets-moved', { detail: stranded ? { moved, stranded } : { moved } }));
                        } else if (ownsDisplay && stranded > 0 && result) {
                            window.dispatchEvent(new CustomEvent('legacy-tickets-stranded', { detail: { stranded } }));
                        }
                    }
                }
            })();
            this.ticketStore.emitUpdate?.();
        }
        return this.legacyTransferRun;
    }

    isLegacyTransferRunning() {
        return Boolean(this.legacyTransferRun);
    }

    /** Wait (bounded) for a running move so a send sees the moved tickets. */
    async awaitLegacyTransfer(timeoutMs = LEGACY_TRANSFER_WAIT_MS) {
        const run = this.legacyTransferRun;
        if (!run) return;
        let timer = null;
        try {
            await Promise.race([
                run.catch(() => {}),
                new Promise(resolve => { timer = setTimeout(resolve, timeoutMs); })
            ]);
        } finally {
            clearTimeout(timer);
        }
    }

    getHeldTicketCount() {
        return this.ticketStore.getHeldCount?.() || 0;
    }

    /**
     * Start moving previous-org tickets automatically once a signed-in
     * wallet is open. Retries a failed move a few times with backoff; a
     * later sign-in (or a TICKET_KEY_LEGACY answer) tries again.
     */
    startLegacyTransferWatcher() {
        if (this.legacyTransferWatcher) return;
        void this.primeLegacyTransfer();
        if (typeof window !== 'undefined') {
            window.addEventListener('tickets-updated', () => {
                if (!this.legacyTransferPrimed) void this.primeLegacyTransfer();
            });
        }
        const attempts = new Map();
        const check = () => {
            this.hideLegacyMoveToastOnAccountChange();
            const account = accountService.getState();
            if (!account?.accountId || account.sessionVerified !== true ||
                account.status !== 'unlocked' || account.accountScopeReady !== true ||
                account.ticketSyncReady !== true) return;
            const state = attempts.get(account.accountId) || { done: false, tries: 0, timer: null };
            attempts.set(account.accountId, state);
            if (state.done || state.timer || this.legacyTransferRun) return;
            this.runLegacyTransfer().then(result => {
                if (result?.redeemError) throw result.redeemError;
                if (result?.recoveryPending) throw new Error('Saved ticket restoration is still pending.');
                if (result?.status !== 'signed-out') state.done = true;
            }).catch(error => {
                state.tries += 1;
                console.warn('Moving tickets from the previous version will be retried:', error);
                if (state.tries < 4) {
                    state.timer = setTimeout(() => {
                        state.timer = null;
                        check();
                    }, Math.min(10 * 60 * 1000, 30000 * 2 ** (state.tries - 1)));
                }
            });
        };
        this.legacyTransferWatcher = accountService.subscribe(check);
        check();
    }

    handleLegacyTicketError(error) {
        if (error?.code !== 'TICKET_KEY_LEGACY') return;
        if (error.legacyKeyId) this.ticketStore.setHeldKeyIds([error.legacyKeyId]);
        this.runLegacyTransfer().catch(transferError => {
            console.warn('Moving tickets from the previous version will be retried:', transferError);
        });
    }

    alphaRegister(invitationCode, progressCallback) {
        return this.getCodeRedeemer().run(invitationCode, progressCallback);
    }

    getPendingCodeRedemption() {
        return this.getCodeRedeemer().getPending();
    }

    resumeCodeRedemption(progressCallback) {
        return this.getCodeRedeemer().run(null, progressCallback);
    }

    /**
     * Split inference tickets into a ticket code.
     * @param {number} ticketCount - Number of tickets to split (default: 1)
     * @returns {Promise<{code: string, ticketsConsumed: number, expiresAt: string|number|null}>}
     */
    async splitTickets(ticketCount = 1) {
        try {
            const parsedCount = Number.parseInt(ticketCount, 10);
            if (!Number.isFinite(parsedCount) || parsedCount <= 0) {
                throw new Error('Ticket count must be greater than zero.');
            }
            if (parsedCount > 50) {
                throw new Error('You can split at most 50 tickets at a time.');
            }

            const { tickets, result } = await this.ticketStore.consumeTickets(
                parsedCount,
                async ({ tickets, totalCount, remainingCount }) => {
                    const startIndex = Math.max(1, totalCount - tickets.length + 1);
                    networkLogger.logRequest({
                        type: 'local',
                        method: 'LOCAL',
                        status: 200,
                        action: 'ticket-select-split',
                        response: {
                            tickets_selected: tickets.length,
                            total_tickets: totalCount,
                            unused_tickets: remainingCount,
                            ticket_index: startIndex,
                            selection_order: 'tail'
                        }
                    });

                    const tokenValues = tickets.map(t => t.finalized_ticket).join(',');
                    const authHeader = tickets.length === 1
                        ? `InferenceTicket token=${tokenValues}`
                        : `InferenceTicket tokens=${tokenValues}`;

                    const splitUrl = `${ORG_API_BASE}/api/split_tickets`;
                    const requestHeaders = {
                        'Content-Type': 'application/json',
                        'Authorization': authHeader,
                    };
                    const requestBody = { count: tickets.length };

                    let response;
                    let data;
                    let text;
                    try {
                        ({ response, data, text } = await networkProxy.fetchWithRetryJson(
                            splitUrl,
                            {
                                method: 'POST',
                                headers: requestHeaders,
                                body: JSON.stringify(requestBody)
                            },
                            {
                                context: 'Ticket split',
                                maxAttempts: 3,
                                timeoutMs: 30000
                            }
                        ));
                    } catch (error) {
                        networkLogger.logRequest({
                            type: 'ticket',
                            method: 'POST',
                            url: splitUrl,
                            status: 0,
                            request: {
                                headers: networkLogger.sanitizeHeaders(requestHeaders),
                                body: requestBody
                            },
                            error: error.message
                        });
                        throw error;
                    }

                    networkLogger.logRequest({
                        type: 'ticket',
                        method: 'POST',
                        url: splitUrl,
                        status: response.status,
                        request: {
                            headers: networkLogger.sanitizeHeaders(requestHeaders),
                            body: requestBody
                        },
                        response: data
                    });

                    if (!response.ok) {
                        throw this.createTicketRedemptionError(
                            data || text,
                            response.status,
                            `Failed to split tickets (${response.status})`
                        );
                    }

                    const code = data?.code || data?.invitation_code || data?.credential;
                    const normalizedCode = typeof code === 'string' ? code.trim() : '';
                    if (!normalizedCode || normalizedCode.length !== 24) {
                        const codeError = new Error('Invalid ticket code returned by server.');
                        throw codeError;
                    }

                    return { response, data, code: normalizedCode };
                },
                { order: 'tail' }
            );

            const { data, code } = result;

            const ticketsConsumed = Number.isFinite(data?.tickets_consumed)
                ? data.tickets_consumed
                : tickets.length;
            if (!Number.isFinite(ticketsConsumed) || ticketsConsumed <= 0) {
                throw new Error('Ticket code was not issued because no valid tickets were found.');
            }

            return {
                code,
                ticketsConsumed,
                ticketsInvalid: data?.tickets_invalid ?? 0,
                expiresAt: data?.expires_at || data?.expires_at_unix || null
            };
        } catch (error) {
            this.notifyTicketKeyInvalidation(error);
            this.handleLegacyTicketError(error);
            console.error('Ticket split error:', error);
            throw error;
        }
    }

    /**
     * Request an API key by redeeming inference tickets.
     *
     * Unlinkability: the org/station receives finalized tickets and returns an API key.
     * The finalized ticket is the output of blind signature unblinding -- it is
     * cryptographically unlinkable to the blind-signing event. No party except the
     * user has ever seen this finalized ticket before this request. Even though this
     * request routes through the org API, the finalized tickets presented here are
     * seen by the org for the first time and are cryptographically unlinkable to the
     * blinded requests from the earlier alphaRegister call. The org therefore cannot
     * correlate "I signed blind request B" to "ticket T was redeemed for key K."
     * The issued API key carries no user identity.
     *
     * @param {number} ticketCount - Number of tickets to use (default: 1)
     * @param {Object} options - Optional request controls
     * @param {AbortSignal} options.signal - Cancels the key request before completion
     * @returns {Promise<Object>} API key data with verification signatures
     */
    async requestApiKey(ticketCount = 1, options = {}) {
        try {
            const { signal = null } = options;
            if (signal?.aborted) {
                const error = new Error('Request aborted');
                error.name = 'AbortError';
                error.isCancelled = true;
                throw error;
            }

            const { tickets, result } = await this.ticketStore.consumeTickets(
                ticketCount,
                async ({ tickets, totalCount, remainingCount }) => {
                    if (signal?.aborted) {
                        const error = new Error('Request aborted');
                        error.name = 'AbortError';
                        error.isCancelled = true;
                        throw error;
                    }

                    networkLogger.logRequest({
                        type: 'local',
                        method: 'LOCAL',
                        status: 200,
                        action: 'ticket-select',
                        response: {
                            tickets_selected: tickets.length,
                            total_tickets: totalCount,
                            unused_tickets: remainingCount,
                            ticket_index: Math.max(1, totalCount - remainingCount - tickets.length + 1)
                        }
                    });

                    const tokenValues = tickets.map(t => t.finalized_ticket).join(',');
                    const authHeader = tickets.length === 1
                        ? `InferenceTicket token=${tokenValues}`
                        : `InferenceTicket tokens=${tokenValues}`;

                    const requestKeyUrl = `${ORG_API_BASE}/api/request_key`;
                    const requestHeaders = {
                        'Authorization': authHeader,
                    };

                    console.log(`🔑 Requesting API key from org (${tickets.length} ticket${tickets.length > 1 ? 's' : ''})...`);

                    let response;
                    let data;

                    try {
                        ({ response, data } = await networkProxy.fetchWithRetryJson(
                            requestKeyUrl,
                            {
                                method: 'POST',
                                headers: requestHeaders,
                            },
                            {
                                context: 'Org API key',
                                maxAttempts: 3,    // Retry transient failures (network/5xx/429)
                                timeoutMs: 30000,  // 30s timeout - org has internal station timeout
                                signal
                            }
                        ));
                    } catch (error) {
                        networkLogger.logRequest({
                            type: 'api-key',
                            method: 'POST',
                            url: requestKeyUrl,
                            status: 0,
                            request: {
                                headers: networkLogger.sanitizeHeaders(requestHeaders),
                            },
                            error: error.message
                        });
                        if (error?.isBodyTimeout) {
                            // The org answered but never finished the reply. It may
                            // or may not have redeemed the ticket; a retry finds out
                            // (an already-spent ticket is skipped automatically).
                            const timeout = new Error('The key request timed out before the org finished replying. Please try again.');
                            timeout.name = 'TimeoutError';
                            timeout.code = 'KEY_REQUEST_TIMEOUT';
                            timeout.retryable = true;
                            timeout.cause = error;
                            throw timeout;
                        }
                        throw error;
                    }

                    networkLogger.logRequest({
                        type: 'api-key',
                        method: 'POST',
                        url: requestKeyUrl,
                        status: response.status,
                        request: {
                            headers: networkLogger.sanitizeHeaders(requestHeaders),
                        },
                        response: data
                    });

                    if (!response.ok) {
                        throw this.createTicketRedemptionError(
                            data,
                            response.status,
                            `Failed to request API key (${response.status})`
                        );
                    }

                    const missingFields = [];
                    if (!data?.key) missingFields.push('key');
                    if (!data?.station_id) missingFields.push('station_id');
                    if (!data?.station_signature) missingFields.push('station_signature');
                    if (!data?.org_signature) missingFields.push('org_signature');
                    if (!data?.expires_at_unix) missingFields.push('expires_at_unix');

                    if (missingFields.length > 0) {
                        const responseMessage = `${data?.detail || data?.error || data?.message || ''}`;
                        const responseMessageLower = responseMessage.toLowerCase();
                        if (responseMessageLower.includes('double') ||
                            responseMessageLower.includes('spent') ||
                            responseMessageLower.includes('used')) {
                            const ticketError = new Error('One or more tickets were already used. Please try again.');
                            ticketError.code = 'TICKET_USED';
                            ticketError.consumeTickets = true;
                            throw ticketError;
                        }

                        throw new Error(responseMessage || `Invalid key response from server (missing ${missingFields.join(', ')})`);
                    }

                    return { response, data };
                }
            );

            const { data } = result;

            return {
                key: data.key,
                keyHash: data.key_hash,
                ticketsConsumed: data.tickets_consumed || tickets.length,
                creditLimit: data.credit_limit,
                durationMinutes: data.duration_minutes,
                expiresAt: data.expires_at,
                expiresAtUnix: data.expires_at_unix,
                stationId: data.station_id,
                stationUrl: data.station_url,
                recentlyAttested: data.station_recently_attested || false,
                stationSignature: data.station_signature,
                orgSignature: data.org_signature,
                ticketsUsed: tickets.map(t => ({
                    blindedRequest: t.blinded_request,
                    signedResponse: t.signed_response,
                    finalizedTicket: t.finalized_ticket,
                }))
            };
        } catch (error) {
            this.notifyTicketKeyInvalidation(error);
            this.handleLegacyTicketError(error);
            console.error('Request API key error:', error);
            throw error;
        }
    }

    /**
     * Request a confidential API key by redeeming inference tickets.
     * @param {number} ticketCount - Number of tickets to use (default: 1)
     * @param {Object} options - Optional request controls
     * @param {AbortSignal} options.signal - Cancels the confidential key request before completion
     * @returns {Promise<Object>} API key data
     */
    async requestConfidentialApiKey(ticketCount = 1, options = {}) {
        try {
            const { signal = null } = options;
            if (signal?.aborted) {
                const error = new Error('Request aborted');
                error.name = 'AbortError';
                error.isCancelled = true;
                throw error;
            }

            const { tickets, result } = await this.ticketStore.consumeTickets(
                ticketCount,
                async ({ tickets, totalCount, remainingCount }) => {
                    if (signal?.aborted) {
                        const error = new Error('Request aborted');
                        error.name = 'AbortError';
                        error.isCancelled = true;
                        throw error;
                    }

                    networkLogger.logRequest({
                        type: 'local',
                        method: 'LOCAL',
                        status: 200,
                        action: 'ticket-select',
                        response: {
                            tickets_selected: tickets.length,
                            total_tickets: totalCount,
                            unused_tickets: remainingCount,
                            ticket_index: Math.max(1, totalCount - remainingCount - tickets.length + 1)
                        }
                    });

                    const tokenValues = tickets.map(t => t.finalized_ticket).join(',');
                    const authHeader = tickets.length === 1
                        ? `InferenceTicket token=${tokenValues}`
                        : `InferenceTicket tokens=${tokenValues}`;

                    const requestKeyUrl = `${ORG_API_BASE}/api/request_confidential_key`;
                    const requestHeaders = {
                        'Authorization': authHeader,
                    };

                    console.log(`🔐 Requesting confidential API key (${tickets.length} ticket${tickets.length > 1 ? 's' : ''})...`);

                    let response;
                    let data;

                    try {
                        ({ response, data } = await networkProxy.fetchWithRetryJson(
                            requestKeyUrl,
                            {
                                method: 'POST',
                                headers: requestHeaders,
                            },
                            {
                                context: 'Org confidential API key',
                                maxAttempts: 3,
                                timeoutMs: 30000,
                                signal
                            }
                        ));
                    } catch (error) {
                        networkLogger.logRequest({
                            type: 'api-key',
                            method: 'POST',
                            url: requestKeyUrl,
                            status: 0,
                            request: {
                                headers: networkLogger.sanitizeHeaders(requestHeaders),
                            },
                            error: error.message
                        });
                        throw error;
                    }

                    networkLogger.logRequest({
                        type: 'api-key',
                        method: 'POST',
                        url: requestKeyUrl,
                        status: response.status,
                        request: {
                            headers: networkLogger.sanitizeHeaders(requestHeaders),
                        },
                        response: data
                    });

                    if (!response.ok) {
                        throw this.createTicketRedemptionError(
                            data,
                            response.status,
                            `Failed to request confidential API key (${response.status})`
                        );
                    }

                    const missingFields = [];
                    if (!data?.key) missingFields.push('key');
                    if (missingFields.length > 0) {
                        throw new Error(`Confidential key response missing: ${missingFields.join(', ')}`);
                    }

                    return data;
                }
            );

            if (!result) {
                throw new Error('Failed to request confidential API key.');
            }

            return result;
        } catch (error) {
            this.notifyTicketKeyInvalidation(error);
            this.handleLegacyTicketError(error);
            console.error('Request confidential API key error:', error);
            throw error;
        }
    }

}

// Export singleton instance
const ticketClient = new TicketClient();

// Make available in console for debugging
if (typeof window !== 'undefined') {
    window.ticketClient = ticketClient;
    window.stationClient = ticketClient;
}

export default ticketClient;
