/**
 * Memory Retrieval Service
 * Handles interaction with the local memory server to retrieve and generate
 * responses using the event store with LLM.
 */

class MemoryRetrievalService {
    constructor() {
        this.serverUrl = 'http://localhost:5555';
        this.isProcessing = false;
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
     * Retrieve memory based on user query and generate LLM response
     * @param {string} userQuery - The user's query
     * @param {Function} onProgress - Progress callback
     * @returns {Promise<Object>} - { success, response, context }
     */
    async retrieveMemory(userQuery, onProgress = null) {
        if (this.isProcessing) {
            throw new Error('Memory retrieval is already in progress');
        }

        this.isProcessing = true;

        try {
            // Check if server is available
            onProgress?.('Checking memory server...');
            const available = await this.isServerAvailable();
            
            if (!available) {
                throw new Error(
                    'Memory server is not running. ' +
                    'Please start it with: python OA_memory/scripts/server.py'
                );
            }

            // Request memory retrieval and LLM response
            onProgress?.('Retrieving relevant memories...');
            
            console.log('[Memory Retrieval] Calling /retrieve-memory endpoint with query:', userQuery);
            const response = await fetch(`${this.serverUrl}/retrieve-memory`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ query: userQuery }),
                signal: AbortSignal.timeout(60000) // 60 second timeout
            });

            if (!response.ok) {
                const errorData = await response.json();
                throw new Error(errorData.error || `Server returned ${response.status}`);
            }

            const result = await response.json();
            console.log('[Memory Retrieval] Raw result:', result);
            console.log('[Memory Retrieval] Result keys:', Object.keys(result));
            
            onProgress?.('Memory retrieval complete!');
            
            // Backend is NOT returning the context field currently
            // It only returns: { success, message, response }
            // We need to update the backend to return the formatted events
            // For now, show an informative message
            if (!result.context) {
                console.warn('[Memory Retrieval] Backend did not return context field. Backend needs to be updated to include retrieved events.');
                console.warn('[Memory Retrieval] Expected: { success, response, context: "<formatted events>" }');
                console.warn('[Memory Retrieval] Got:', result);
                
                // Create a synthetic context with no memories so UI doesn't break
                result.context = {
                    formatted: '',
                    memories: []
                };
            } else {
                // Parse the retrieved events and transform to expected format
                // Backend should return: { success, response, context: "<formatted string>" }
                const formattedText = typeof result.context === 'string' 
                    ? result.context 
                    : result.context.formatted;
                
                if (formattedText) {
                    console.log('[Memory Retrieval] Parsing formatted text, length:', formattedText.length);
                    const memories = this.parseFormattedEvents(formattedText);
                    console.log('[Memory Retrieval] Parsed memories:', memories.length, memories);
                    
                    // Store memories in the expected structure
                    result.context = {
                        formatted: formattedText,
                        memories: memories
                    };
                }
            }
            
            return result;
        } catch (error) {
            console.error('Memory retrieval failed:', error);
            throw error;
        } finally {
            this.isProcessing = false;
        }
    }

    /**
     * Parse formatted events text from backend into structured memory objects
     * @param {string} formattedText - The formatted events text from backend
     * @returns {Array} - Array of memory objects with title, content, sessionId
     */
    parseFormattedEvents(formattedText) {
        if (!formattedText) return [];
        
        const memories = [];
        // Split by event markers (### Event N)
        const eventMatches = formattedText.split(/### Event \d+ \(sim=[\d.]+\)/);
        
        for (let i = 1; i < eventMatches.length; i++) {
            const eventText = eventMatches[i].trim();
            if (!eventText) continue;
            
            // Extract title (line after "Title:")
            const titleMatch = eventText.match(/Title:\s*(.+?)$/m);
            const title = titleMatch ? titleMatch[1].trim() : 'Untitled';
            
            // Extract summary (content between "Summary:" and "Snippet:")
            const summaryMatch = eventText.match(/Summary:\s*([\s\S]+?)(?=Snippet:|$)/);
            const summary = summaryMatch ? summaryMatch[1].trim() : '';
            
            // Extract snippet for session context
            const snippetMatch = eventText.match(/Snippet:\s*([\s\S]+)$/);
            const snippet = snippetMatch ? snippetMatch[1].trim() : '';
            
            // Try to extract session ID from title or generate a placeholder
            // In the future, backend should include explicit session_id field
            const sessionId = `event-${i}`; // Placeholder for now
            
            memories.push({
                title,
                summary: summary.substring(0, 500), // Truncate for UI
                content: snippet.substring(0, 300), // Truncate snippet
                sessionId,
                timestamp: Date.now()
            });
        }
        
        return memories;
    }

    /**
     * Handle @memory mention
     * This is called when the user types @memory in the chat
     */
    async handleMemoryMention(userQuery, app) {
        console.log('Memory mention triggered with query:', userQuery);
        
        // Show processing toast
        const dismissToast = app.showLoadingToast?.('Retrieving memories...');
        
        try {
            const result = await this.retrieveMemory(userQuery, (progress) => {
                console.log('Progress:', progress);
                dismissToast?.();
                app.showLoadingToast?.(progress);
            });

            dismissToast?.();
            
            if (result.success && result.response) {
                // Insert the LLM response into the chat input
                const input = document.getElementById('message-input');
                if (input) {
                    input.value = result.response;
                    input.style.height = '24px';
                    input.style.height = Math.min(input.scrollHeight, 384) + 'px';
                    input.focus();
                    input.dispatchEvent(new Event('input', { bubbles: true }));
                }
                
                app.showToast?.(
                    '✓ Memory retrieved and generated response',
                    'success'
                );
            } else {
                app.showToast?.(
                    result.message || 'No memories found',
                    'info'
                );
            }
        } catch (error) {
            dismissToast?.();
            app.showToast?.(
                error.message || 'Failed to retrieve memory',
                'error'
            );
        }
    }
}

// Export singleton instance
export const memoryRetrievalService = new MemoryRetrievalService();
