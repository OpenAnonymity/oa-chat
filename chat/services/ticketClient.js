/**
 * Ticket Client
 * Handles inference ticket registration and API key provisioning via the org API.
 */

import privacyPassProvider from './privacyPass.js';
import networkLogger from './networkLogger.js';
import ticketStore from './ticketStore.js';
import { ORG_API_BASE } from '../config.js';
import { fetchRetryJson } from './fetchRetry.js';

class TicketClient {
    constructor() {
        console.log('🚀 Initializing TicketClient');
        this.ppExtension = privacyPassProvider;
        this.ticketStore = ticketStore;

        console.log(`📊 TicketClient ready with ${this.ticketStore.getCount()} tickets`);
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
        return this.ticketStore.getCount();
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

    async alphaRegister(invitationCode, progressCallback) {
        console.log('=== Starting alphaRegister ===');

        try {
            if (progressCallback) progressCallback('Validating invitation code...', 5);

            if (!invitationCode || invitationCode.length !== 24) {
                throw new Error('Invalid invitation code format (must be 24 characters)');
            }

            const suffix = invitationCode.slice(20, 24);
            const ticketCount = parseInt(suffix, 16);

            if (isNaN(ticketCount) || ticketCount === 0) {
                throw new Error('Invalid invitation code: unable to determine ticket count');
            }

            if (progressCallback) progressCallback('Initializing Privacy Pass...', 10);

            const hasProvider = await this.ppExtension.checkAvailability();

            if (!hasProvider) {
                throw new Error('Privacy Pass is not available. Please check your configuration.');
            }

            if (progressCallback) progressCallback('Getting issuer public key...', 20);

            let publicKey;
            try {
                const { data: keyData } = await fetchRetryJson(
                    `${ORG_API_BASE}/api/ticket/issue/public-key`,
                    {},
                    { context: 'Public key', maxAttempts: 3, timeoutMs: 10000 }
                );
                publicKey = keyData.public_key;

                if (!publicKey) {
                    throw new Error('Station did not return public key');
                }
            } catch (error) {
                throw new Error(`Failed to get public key: ${error.message}`);
            }

            if (progressCallback) progressCallback(`Blinding ${ticketCount} tickets...`, 25);

            const challenge = await this.ppExtension.createChallenge("oa-station", ["oa-station-api"]);

            const indexedBlindedRequests = [];
            const clientStates = [];

            for (let i = 0; i < ticketCount; i++) {
                const result = await this.ppExtension.createSingleTokenRequest(publicKey, challenge);
                const { blindedRequest, state } = result;
                indexedBlindedRequests.push([i, blindedRequest]);
                clientStates.push([i, state]);

                if (i > 0 && i % Math.max(1, Math.floor(ticketCount / 20)) === 0) {
                    const progressPct = 25 + Math.floor((i / ticketCount) * 20);
                    if (progressCallback) {
                        progressCallback(`Blinding tickets... (${i}/${ticketCount})`, progressPct);
                    }
                }
            }

            // Log blinded tickets creation
            networkLogger.logRequest({
                type: 'local',
                method: 'LOCAL',
                status: 200,
                action: 'tickets-blind',
                response: {
                    ticket_count: ticketCount,
                    blinded_requests_created: indexedBlindedRequests.length
                }
            });

            if (progressCallback) progressCallback('Sending blinded tickets to server for signing...', 50);

            const registerUrl = `${ORG_API_BASE}/api/alpha-register`;
            const registerBody = {
                credential: invitationCode,
                blinded_requests: indexedBlindedRequests
            };

            let signData;
            try {
                const { response: signResponse, data } = await fetchRetryJson(
                    registerUrl,
                    {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(registerBody)
                    },
                    {
                        context: 'Alpha register',
                        maxAttempts: 1,  // No retry - blinded tickets consumed on success
                        timeoutMs: Math.max(120000, ticketCount * 50)
                    }
                );

                signData = data;

                // Log the request
                networkLogger.logRequest({
                    type: 'ticket',
                    method: 'POST',
                    url: registerUrl,
                    status: signResponse.status,
                    request: {
                        headers: { 'Content-Type': 'application/json' },
                        body: { credential: '***', blinded_requests: `${indexedBlindedRequests.length} tickets` }
                    },
                    response: signData
                });

                if (!signResponse.ok) {
                    throw new Error(signData.detail || signData.error || signData.message || 'Server error during registration');
                }
            } catch (error) {
                // Log failed request
                networkLogger.logRequest({
                    type: 'ticket',
                    method: 'POST',
                    url: registerUrl,
                    status: 0,
                    request: {
                        headers: { 'Content-Type': 'application/json' },
                        body: { credential: '***', blinded_requests: `${indexedBlindedRequests.length} tickets` }
                    },
                    error: error.message
                });
                throw error;
            }

            if (progressCallback) progressCallback('Signed tickets received...', 70);

            const indexedSignedResponses = signData.signed_responses;

            if (!indexedSignedResponses || indexedSignedResponses.length === 0) {
                throw new Error('Station did not return signed responses');
            }

            // Log receipt of signed tickets
            networkLogger.logRequest({
                type: 'local',
                method: 'LOCAL',
                status: 200,
                action: 'tickets-signed',
                response: {
                    signed_tickets_received: indexedSignedResponses.length
                }
            });

            const responseMap = {};
            indexedSignedResponses.forEach(([idx, signedResp]) => {
                responseMap[idx] = signedResp;
            });

            if (progressCallback) progressCallback('Unblinding tickets...', 75);

            const tickets = [];
            const progressInterval = Math.max(1, Math.floor(clientStates.length / 10));

            for (let i = 0; i < clientStates.length; i++) {
                const [idx, state] = clientStates[i];

                if (!(idx in responseMap)) {
                    throw new Error(`Missing signed response for ticket index ${idx}`);
                }

                const signedResponse = responseMap[idx];
                const blindedRequest = indexedBlindedRequests[idx][1];

                const finalizedTicket = await this.ppExtension.finalizeToken(signedResponse, state);

                tickets.push({
                    blinded_request: blindedRequest,
                    signed_response: signedResponse,
                    finalized_ticket: finalizedTicket,
                    created_at: new Date().toISOString(),
                });

                if (i > 0 && i % progressInterval === 0) {
                    const progressPct = 75 + Math.floor((i / clientStates.length) * 15);
                    if (progressCallback) {
                        progressCallback(`Unblinding tickets... (${i}/${clientStates.length})`, progressPct);
                    }
                }
            }

            if (progressCallback) progressCallback('Saving tickets...', 90);

            // Log ticket unblinding completion
            networkLogger.logRequest({
                type: 'local',
                method: 'LOCAL',
                status: 200,
                action: 'tickets-unblind',
                response: {
                    tickets_finalized: tickets.length,
                    tickets_ready: tickets.length
                }
            });

            await this.ticketStore.addTickets(tickets);

            if (progressCallback) progressCallback('Registration complete!', 100);

            return {
                success: true,
                tickets_issued: tickets.length,
                credential: invitationCode,
                expires_at: signData.expires_at,
            };

        } catch (error) {
            console.error('Alpha register error:', error);
            throw error;
        }
    }

    /**
     * Request an API key by redeeming inference tickets.
     * @param {string} name - Key name for identification
     * @param {number} ticketCount - Number of tickets to use (default: 1)
     * @returns {Promise<Object>} API key data with verification signatures
     */
    async requestApiKey(name = 'OA-WebApp-Key', ticketCount = 1) {
        try {
            const { tickets, result } = await this.ticketStore.consumeTickets(
                ticketCount,
                async ({ tickets, totalCount, remainingCount }) => {
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
                        'Content-Type': 'application/json',
                        'Authorization': authHeader,
                    };
                    const requestBody = { name };

                    console.log(`🔑 Requesting API key from org (${tickets.length} ticket${tickets.length > 1 ? 's' : ''})...`);

                    let response;
                    let data;

                    try {
                        ({ response, data } = await fetchRetryJson(
                            requestKeyUrl,
                            {
                                method: 'POST',
                                headers: requestHeaders,
                                body: JSON.stringify(requestBody)
                            },
                            {
                                context: 'Org API key',
                                maxAttempts: 3,    // Retry transient failures (network/5xx/429)
                                timeoutMs: 30000   // 30s timeout - org has internal station timeout
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
                                body: requestBody
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
                            body: requestBody
                        },
                        response: data
                    });

                    if (!response.ok) {
                        const errorMessage = data.detail || data.error || data.message ||
                            (typeof data === 'string' ? data : null) ||
                            `Failed to provision API key (${response.status})`;

                        if (response.status === 401 || errorMessage.includes('double-spending')) {
                            const ticketError = new Error('One or more tickets were already used. Please try again.');
                            ticketError.code = 'TICKET_USED';
                            ticketError.consumeTickets = true;
                            throw ticketError;
                        }

                        throw new Error(errorMessage);
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
                stationSignature: data.station_signature,
                orgSignature: data.org_signature,
                ticketsUsed: tickets.map(t => ({
                    blindedRequest: t.blinded_request,
                    signedResponse: t.signed_response,
                    finalizedTicket: t.finalized_ticket,
                }))
            };
        } catch (error) {
            console.error('Request API key error:', error);
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
