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
            onProgress?.('Memory retrieval complete!');
            
            return result;
        } catch (error) {
            console.error('Memory retrieval failed:', error);
            throw error;
        } finally {
            this.isProcessing = false;
        }
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
