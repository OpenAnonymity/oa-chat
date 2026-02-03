/**
 * Memory Enrichment Service
 * Detects @memory mentions in user messages and enriches them with retrieved memory context
 * before sending to the API.
 */

class MemoryEnrichmentService {
    constructor() {
        this.serverUrl = 'http://localhost:5555';
    }

    /**
     * Check if a message contains @memory mention
     * @param {string} message - The message text
     * @returns {Object|null} - { hasMemory, query } or null
     */
    parseMemoryMention(message) {
        const memoryRegex = /@memory\s+(.+?)(?=\s*$)/i;
        const match = message.match(memoryRegex);
        
        if (!match) {
            return null;
        }

        return {
            hasMemory: true,
            query: match[1].trim(),
            mentionPrefix: '@memory '  // Just the prefix to remove
        };
    }

    /**
     * Check if the memory server is running
     * @returns {Promise<boolean>}
     */
    async isServerAvailable() {
        try {
            const response = await fetch(`${this.serverUrl}/health`, {
                method: 'GET',
                signal: AbortSignal.timeout(2000)
            });
            return response.ok;
        } catch (error) {
            console.warn('Memory server not available:', error.message);
            return false;
        }
    }

    /**
     * Retrieve context for a memory query
     * @param {string} query - The memory query
     * @returns {Promise<string|null>} - The context block or null if not available
     */
    async retrieveContext(query) {
        try {
            console.log('[Memory Enrichment] Retrieving context for query:', query);
            const response = await fetch(`${this.serverUrl}/retrieve-context`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ query: query }),
                signal: AbortSignal.timeout(60000) // 60 second timeout
            });

            if (!response.ok) {
                const errorData = await response.json();
                console.warn('[Memory Enrichment] Context retrieval failed:', errorData.error);
                return null;
            }

            const result = await response.json();
            console.log('[Memory Enrichment] Retrieved context with', result.retrieved_count, 'events');
            return result.context;
        } catch (error) {
            console.error('[Memory Enrichment] Error retrieving context:', error);
            return null;
        }
    }

    /**
     * Enrich a message with memory context if it contains @memory mention
     * Returns display and API versions separately
     * @param {string} originalMessage - The original message text
     * @returns {Promise<Object>} - { displayMessage, apiMessage, hasMemory }
     */
    async enrichMessage(originalMessage) {
        // Check for @memory mention
        const memoryInfo = this.parseMemoryMention(originalMessage);
        
        if (!memoryInfo) {
            console.log('[Memory Enrichment] No @memory mention found in message');
            return {
                displayMessage: originalMessage,
                apiMessage: originalMessage,
                hasMemory: false
            };
        }

        console.log('[Memory Enrichment] Found @memory mention with query:', memoryInfo.query);

        // Check if server is available
        const serverAvailable = await this.isServerAvailable();
        if (!serverAvailable) {
            console.warn('[Memory Enrichment] Server not available, returning original message');
            return {
                displayMessage: originalMessage,
                apiMessage: originalMessage,
                hasMemory: false
            };
        }

        // Retrieve context
        const context = await this.retrieveContext(memoryInfo.query);
        
        if (!context) {
            console.warn('[Memory Enrichment] No context retrieved, returning original message');
            return {
                displayMessage: originalMessage,
                apiMessage: originalMessage,
                hasMemory: false
            };
        }

        // Remove @memory prefix from the message to get the clean query
        const cleanMessage = originalMessage.replace(memoryInfo.mentionPrefix, '').trim();

        // Log the context to console for debugging
        console.log('[Memory Enrichment] Retrieved context:');
        console.log(context);

        // Build the enriched message for API (with context)
        const apiMessage = `${cleanMessage}

---
**Memory Context:**
${context}`;

        console.log('[Memory Enrichment] Message enriched with context for API');

        return {
            displayMessage: cleanMessage,  // What the user sees in chat
            apiMessage: apiMessage,        // What gets sent to the API
            hasMemory: true
        };
    }
}

// Export singleton instance
export const memoryEnrichmentService = new MemoryEnrichmentService();
