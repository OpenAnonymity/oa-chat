/**
 * Station API Client
 * Handles authentication and API key provisioning from the station backend
 */

import privacyPassProvider from './privacyPass.js';
import networkLogger from './networkLogger.js';
import networkProxy, { ProxyFallbackError } from './networkProxy.js';

const ORG_API_BASE = 'https://org.openanonymity.ai';

// Retry configuration - tuned for snappy UX
const RETRY_DEFAULTS = {
    maxAttempts: 2,       // Quick failover to next station
    baseDelayMs: 200,     // Short initial delay
    maxDelayMs: 1000,     // Cap delays at 1s
    timeoutMs: 2000       // 2s timeout - fail fast, try next
};

// HTTP status codes that should trigger retry
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

class StationClient {
    constructor() {
        console.log('🚀 Initializing StationClient');
        this.ppExtension = privacyPassProvider;
        this.tickets = this.loadTickets();
        this.currentTicketIndex = 0;
        this.tabId = this.generateTabId();
        
        console.log(`📊 StationClient ready with ${this.tickets.length} tickets (Tab ID: ${this.tabId})`);
        
        // Listen for cross-tab ticket changes via storage events
        window.addEventListener('storage', (event) => {
            if (event.key === 'inference_tickets' && event.newValue !== event.oldValue) {
                console.log('🔄 Detected ticket changes from another tab, reloading...');
                this.tickets = this.loadTickets();
                window.dispatchEvent(new CustomEvent('tickets-updated'));
            }
        });
    }

    generateTabId() {
        return `tab_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    }

    /**
     * Reusable fetch with retry, backoff, and safe JSON parsing.
     * @param {string} url - Request URL
     * @param {RequestInit} init - Fetch options
     * @param {object} opts - Retry options
     * @param {string} opts.context - Description for error messages
     * @param {number} opts.maxAttempts - Max retry attempts (default 3)
     * @param {number} opts.baseDelayMs - Initial backoff delay (default 500)
     * @param {number} opts.timeoutMs - Request timeout (default 30000)
     * @param {boolean} opts.parseJson - Whether to parse response as JSON (default true)
     * @returns {Promise<{response: Response, data: any}>}
     */
    async fetchWithRetry(url, init = {}, opts = {}) {
        const {
            context = 'API',
            maxAttempts = RETRY_DEFAULTS.maxAttempts,
            baseDelayMs = RETRY_DEFAULTS.baseDelayMs,
            timeoutMs = RETRY_DEFAULTS.timeoutMs,
            parseJson = true
        } = opts;

        let lastError = null;

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
                
                const response = await networkProxy.fetch(url, {
                    ...init,
                    signal: controller.signal
                });
                
                clearTimeout(timeoutId);

                // Parse JSON if requested
                if (parseJson) {
                    const { data, error } = await this.parseResponseBody(response, context);
                    if (error) {
                        // Non-JSON response - check if retryable
                        if (RETRYABLE_STATUS.has(response.status) && attempt < maxAttempts) {
                            lastError = error;
                            await this.backoff(attempt, baseDelayMs);
                            continue;
                        }
                        throw error;
                    }
                    return { response, data };
                }

                return { response, data: null };

            } catch (error) {
                // Handle proxy fallback - requires user confirmation
                if (error instanceof ProxyFallbackError || error?.requiresConfirmation) {
                    console.log(`🔒 ${context}: Proxy unavailable, requesting user confirmation for fallback`);
                    
                    // Show confirmation dialog
                    const confirmed = await window.showProxyFallbackConfirmation?.({ 
                        error: error.message, 
                        url: url 
                    });
                    
                    if (confirmed) {
                        // User confirmed - retry with direct fetch
                        console.log(`✅ ${context}: User confirmed fallback, using direct connection`);
                        const controller = new AbortController();
                        const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
                        
                        const response = await networkProxy.fetchWithFallback(url, {
                            ...init,
                            signal: controller.signal
                        });
                        
                        clearTimeout(timeoutId);
                        
                        if (parseJson) {
                            const { data, error: parseError } = await this.parseResponseBody(response, context);
                            if (parseError) throw parseError;
                            return { response, data };
                        }
                        return { response, data: null };
                    } else {
                        // User cancelled
                        throw new Error(`${context} cancelled: User declined to send without proxy`);
                    }
                }

                // Convert AbortError to user-friendly timeout message
                if (error.name === 'AbortError') {
                    lastError = new Error(`Request timed out. Please try again.`);
                } else {
                    lastError = error;
                }
                
                const isRetryable = this.isRetryableError(error);
                
                if (isRetryable && attempt < maxAttempts) {
                    console.warn(`⚠️ ${context} attempt ${attempt}/${maxAttempts} failed: ${error.message}. Retrying...`);
                    await this.backoff(attempt, baseDelayMs);
                    continue;
                }
                
                // Final attempt or non-retryable error
                throw lastError;
            }
        }

        throw lastError || new Error(`${context} failed after ${maxAttempts} attempts`);
    }

    /**
     * Determine if an error is transient and worth retrying.
     */
    isRetryableError(error) {
        if (error.name === 'AbortError') return true; // Timeout
        if (error.message?.includes('NetworkError')) return true;
        if (error.message?.includes('fetch')) return true;
        return false;
    }

    /**
     * Exponential backoff with jitter.
     */
    async backoff(attempt, baseDelayMs) {
        const delay = Math.min(
            baseDelayMs * Math.pow(2, attempt - 1) + Math.random() * 100,
            RETRY_DEFAULTS.maxDelayMs
        );
        await new Promise(r => setTimeout(r, delay));
    }

    loadTickets() {
        try {
            const stored = localStorage.getItem('inference_tickets');
            const tickets = stored ? JSON.parse(stored) : [];
            console.log(`📥 Loaded ${tickets.length} tickets from localStorage`);
            return tickets;
        } catch (error) {
            console.error('❌ Error loading tickets:', error);
            return [];
        }
    }

    saveTickets(tickets) {
        try {
            localStorage.setItem('inference_tickets', JSON.stringify(tickets));
            this.tickets = tickets;
            this.currentTicketIndex = 0;
            console.log(`💾 Saved ${tickets.length} tickets to localStorage`);

            // Notify app about ticket updates
            window.dispatchEvent(new CustomEvent('tickets-updated'));
        } catch (error) {
            console.error('❌ Error saving tickets:', error);
        }
    }

    getNextTicket() {
        if (!this.tickets || this.tickets.length === 0) {
            return null;
        }

        const RESERVATION_TIMEOUT_MS = 5000; // 5 seconds
        const now = Date.now();

        // Filter for tickets that are not used and either not reserved or reservation has expired
        const availableTickets = this.tickets.filter(t => {
            if (t.used) return false;
            
            // Check if ticket is reserved by another tab and reservation is still valid
            if (t.reserved && t.reserved_by !== this.tabId) {
                const reservedAt = new Date(t.reserved_at).getTime();
                const isExpired = (now - reservedAt) > RESERVATION_TIMEOUT_MS;
                
                if (!isExpired) {
                    return false; // Skip tickets reserved by other tabs
                }
                
                // Reservation expired, this ticket is available
                console.log(`⏰ Ticket reservation expired (reserved ${Math.floor((now - reservedAt) / 1000)}s ago)`);
            }
            
            return true;
        });

        if (availableTickets.length === 0) {
            console.log('❌ No available tickets (all used or reserved)');
            return null;
        }

        return availableTickets[0];
    }

    getTicketCount() {
        if (!this.tickets) return 0;
        return this.tickets.filter(t => !t.used).length;
    }

    clearTickets() {
        this.tickets = [];
        this.currentTicketIndex = 0;
        localStorage.removeItem('inference_tickets');
        console.log('🗑️  All tickets cleared');
        window.dispatchEvent(new CustomEvent('tickets-updated'));
    }

    reserveTicket(ticket) {
        if (!ticket) return false;

        // Re-read tickets from localStorage to ensure freshness
        const freshTickets = this.loadTickets();
        
        const ticketIndex = freshTickets.findIndex(
            t => t.finalized_ticket === ticket.finalized_ticket
        );

        if (ticketIndex === -1) {
            console.log('❌ Ticket not found in storage');
            return false;
        }

        const targetTicket = freshTickets[ticketIndex];

        // Check if ticket is already used or reserved by another tab
        if (targetTicket.used) {
            console.log('❌ Ticket already used');
            return false;
        }

        if (targetTicket.reserved && targetTicket.reserved_by !== this.tabId) {
            const reservedAt = new Date(targetTicket.reserved_at).getTime();
            const age = Date.now() - reservedAt;
            
            // Check if reservation is still valid (within 5 seconds)
            if (age < 5000) {
                console.log(`❌ Ticket reserved by another tab (${Math.floor(age / 1000)}s ago)`);
                return false;
            }
        }

        // Reserve the ticket atomically
        freshTickets[ticketIndex].reserved = true;
        freshTickets[ticketIndex].reserved_at = new Date().toISOString();
        freshTickets[ticketIndex].reserved_by = this.tabId;

        // Save to localStorage in a single atomic write
        try {
            localStorage.setItem('inference_tickets', JSON.stringify(freshTickets));
            this.tickets = freshTickets;
            console.log(`✅ Reserved ticket ${ticketIndex + 1}/${freshTickets.length} for this tab`);
            return true;
        } catch (error) {
            console.error('❌ Error reserving ticket:', error);
            return false;
        }
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
                const { data: keyData } = await this.fetchWithRetry(
                    `${ORG_API_BASE}/api/ticket/issue/public-key`,
                    {},
                    { context: 'Public key' }
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
                const { response: signResponse, data } = await this.fetchWithRetry(
                    registerUrl,
                    {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(registerBody)
                    },
                    { context: 'Alpha register', timeoutMs: Math.max(120000, ticketCount * 50) }
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
                    throw new Error(signData.detail || signData.message || 'Server error during registration');
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
                    used: false,
                    used_at: null,
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
                    tickets_ready: tickets.filter(t => !t.used).length
                }
            });

            // Load existing tickets and append new ones
            const existingTickets = this.loadTickets();
            const combinedTickets = [...existingTickets, ...tickets];
            this.saveTickets(combinedTickets);

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

    async requestApiKey(name = 'OA-WebApp-Key', retryCount = 0) {
        const MAX_RESERVE_RETRIES = 3;
        let ticket = null;

        try {
            // Get next available ticket
            ticket = this.getNextTicket();

            if (!ticket) {
                throw new Error('No inference tickets available. Please register with an invitation code first.');
            }

            // Try to reserve the ticket atomically
            const reserved = this.reserveTicket(ticket);

            if (!reserved) {
                // Ticket was taken by another tab, try with next ticket
                if (retryCount < MAX_RESERVE_RETRIES) {
                    console.log(`🔄 Ticket conflict detected, retrying with next ticket (attempt ${retryCount + 1}/${MAX_RESERVE_RETRIES})...`);
                    return await this.requestApiKey(name, retryCount + 1);
                } else {
                    throw new Error('Unable to reserve a ticket after multiple attempts. All tickets may be in use by other tabs.');
                }
            }

            // Log ticket selection as a local event
            networkLogger.logRequest({
                type: 'local',
                method: 'LOCAL',
                status: 200,
                action: 'ticket-select',
                response: {
                    ticket_index: this.tickets.findIndex(t => t.finalized_ticket === ticket.finalized_ticket) + 1,
                    total_tickets: this.tickets.length,
                    unused_tickets: this.tickets.filter(t => !t.used).length,
                    tab_id: this.tabId
                }
            });

            // Request API key directly from org
            const requestKeyUrl = `${ORG_API_BASE}/api/request_key`;
            const requestHeaders = {
                'Content-Type': 'application/json',
                'Authorization': `InferenceTicket token=${ticket.finalized_ticket}`,
            };
            const requestBody = { name };

            console.log('🔑 Requesting API key from org...');

            const { response, data } = await this.fetchWithRetry(
                requestKeyUrl,
                {
                    method: 'POST',
                    headers: requestHeaders,
                    body: JSON.stringify(requestBody)
                },
                { 
                    context: 'Org API key',
                    maxAttempts: 1,    // No retries - ticket would be consumed
                    timeoutMs: 30000   // 30s timeout - org has internal station timeout
                }
            );

            // Log request
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
                // Extract error message from various possible response formats
                const errorMessage = data.detail || data.error || data.message || 
                    (typeof data === 'string' ? data : null) ||
                    `Failed to provision API key (${response.status})`;
                
                if (response.status === 401 || errorMessage.includes('double-spending')) {
                    this.markTicketAsUsed(ticket);
                    const ticketError = new Error('This ticket was already used. Please try again with next ticket.');
                    ticketError.code = 'TICKET_USED';
                    throw ticketError;
                }
                // Release reservation - ticket wasn't consumed, can be reused
                this.releaseReservation(ticket);
                throw new Error(errorMessage);
            }

            this.markTicketAsUsed(ticket);

            // Return key data with signature fields for verification
            // Use expires_at_unix (Unix timestamp) for expiration checks and verification
            return {
                key: data.key,
                keyHash: data.key_hash,
                ticketsConsumed: data.tickets_consumed,
                creditLimit: data.credit_limit,
                durationMinutes: data.duration_minutes,
                expiresAt: data.expires_at_unix,  // Unix timestamp in seconds
                expiresAtIso: data.expires_at,    // ISO string for display
                stationId: data.station_id,
                stationUrl: data.station_url,
                stationSignature: data.station_signature,
                orgSignature: data.org_signature,
                ticketUsed: {
                    blindedRequest: ticket.blinded_request,
                    signedResponse: ticket.signed_response,
                    finalizedTicket: ticket.finalized_ticket,
                }
            };

        } catch (error) {
            console.error('Request API key error:', error);
            // Release reservation on error (unless ticket was consumed)
            if (ticket && error.code !== 'TICKET_USED') {
                this.releaseReservation(ticket);
            }
            throw error;
        }
    }

    async parseResponseBody(response, context) {
        const contentType = response.headers.get('content-type') || 'unknown';
        const rawText = await response.text();
        const trimmed = rawText.trim();
        const preview = trimmed.substring(0, 200) || '';
        const looksJson = contentType.includes('application/json') ||
            trimmed.startsWith('{') ||
            trimmed.startsWith('[');

        if (!looksJson) {
            const errorMessage = `${context} expected JSON but received ${contentType} (status ${response.status}). Body preview: ${preview || '[empty response]'}`;
            return {
                data: null,
                logPayload: {
                    contentType,
                    status: response.status,
                    preview: preview || '[empty response]'
                },
                error: new Error(errorMessage)
            };
        }

        try {
            const data = trimmed ? JSON.parse(rawText) : {};
            return {
                data,
                logPayload: data,
                error: null
            };
        } catch (err) {
            const errorMessage = `${context} returned invalid JSON (status ${response.status}): ${preview || '[empty response]'}`;
            return {
                data: null,
                logPayload: {
                    contentType,
                    status: response.status,
                    preview: preview || '[empty response]',
                    parseError: err.message
                },
                error: new Error(errorMessage)
            };
        }
    }

    markTicketAsUsed(ticket) {
        if (!ticket || !this.tickets) return;

        const ticketIndex = this.tickets.findIndex(
            t => t.finalized_ticket === ticket.finalized_ticket
        );

        if (ticketIndex !== -1) {
            this.tickets[ticketIndex].used = true;
            this.tickets[ticketIndex].used_at = new Date().toISOString();
            // Clear reservation when marking as used
            this.tickets[ticketIndex].reserved = false;
            this.tickets[ticketIndex].reserved_at = null;
            this.tickets[ticketIndex].reserved_by = null;

            this.saveTickets(this.tickets);

            console.log(`✅ Marked ticket ${ticketIndex + 1}/${this.tickets.length} as used`);
            console.log(`📊 Remaining tickets: ${this.tickets.filter(t => !t.used).length}`);

            window.dispatchEvent(new CustomEvent('tickets-updated'));
        }
    }

    releaseReservation(ticket) {
        if (!ticket || !this.tickets) return;

        const ticketIndex = this.tickets.findIndex(
            t => t.finalized_ticket === ticket.finalized_ticket
        );

        if (ticketIndex !== -1 && this.tickets[ticketIndex].reserved_by === this.tabId) {
            this.tickets[ticketIndex].reserved = false;
            this.tickets[ticketIndex].reserved_at = null;
            this.tickets[ticketIndex].reserved_by = null;
            this.saveTickets(this.tickets);
            console.log(`🔓 Released reservation for ticket ${ticketIndex + 1}`);
        }
    }
}

// Export singleton instance
const stationClient = new StationClient();

// Make available in console for debugging
if (typeof window !== 'undefined') {
    window.stationClient = stationClient;
}

export default stationClient;

