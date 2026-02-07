/**
 * Memory Retrieval Service
 * Retrieves relevant sessions from the vector store using sessionEmbedder.
 * Sessions are embedded in the background as users chat, enabling semantic search.
 */

class MemoryRetrievalService {
    constructor() {
        this.isProcessing = false;
        this.sessionEmbedder = null;
    }

    /**
     * Lazy load sessionEmbedder
     */
    async getSessionEmbedder() {
        if (!this.sessionEmbedder) {
            const { default: sessionEmbedderModule } = await import('./sessionEmbedder.js');
            this.sessionEmbedder = sessionEmbedderModule;
        }
        return this.sessionEmbedder;
    }

    /**
     * Check if session embedder is initialized
     * @returns {Promise<boolean>}
     */
    async isEmbedderAvailable() {
        try {
            const embedder = await this.getSessionEmbedder();
            // Initialize embedder if not already done
            await embedder.init();
            return embedder.initialized;
        } catch (error) {
            console.warn('Session embedder not available:', error.message);
            return false;
        }
    }

    /**
     * Retrieve memory based on user query using vector search
     * @param {string} userQuery - The user's query
     * @param {Function} onProgress - Progress callback
     * @returns {Promise<Object>} - { success, memories, sessionResults }
     */
    async retrieveMemory(userQuery, onProgress = null) {
        if (this.isProcessing) {
            throw new Error('Memory retrieval is already in progress');
        }

        this.isProcessing = true;

        try {
            // Check if embedder is available
            onProgress?.('Initializing session search...');
            const available = await this.isEmbedderAvailable();
            
            if (!available) {
                throw new Error(
                    'Session embedder not initialized. ' +
                    'Sessions will be embedded in the background as you chat.'
                );
            }

            // Search for relevant sessions
            onProgress?.('Searching relevant sessions...');
            
            const embedder = await this.getSessionEmbedder();
            console.log('[Memory Retrieval] Searching sessions with query:', userQuery);
            const sessionResults = await embedder.searchSessions(userQuery, 5);
            console.log('[Memory Retrieval] Raw session results:', sessionResults);
            
            onProgress?.('Memory retrieval complete!');
            
            // Transform session results to memory format
            const memories = this.transformSessionsToMemories(sessionResults);
            console.log('[Memory Retrieval] Transformed to memories:', memories.length, memories);
            
            return {
                success: true,
                memories: memories,
                sessionResults: sessionResults,
                retrieved_count: memories.length
            };
        } catch (error) {
            console.error('Memory retrieval failed:', error);
            throw error;
        } finally {
            this.isProcessing = false;
        }
    }

    /**
     * Transform session search results into memory objects for display
     * @param {Array} sessionResults - Search results from sessionEmbedder.searchSessions
     * @returns {Array} - Array of memory objects with title, content, sessionId, keywords
     */
    transformSessionsToMemories(sessionResults) {
        if (!sessionResults || sessionResults.length === 0) return [];
        
        return sessionResults.map((result, idx) => {
            const fullText = result.conversationText || '';
            // Truncate for UI display (300 chars)
            const displayText = fullText.length > 300 ? fullText.substring(0, 300) + '...' : fullText;
            
            const memory = {
                title: result.summary || result.title || 'Untitled Session',
                summary: this.summarizeConversation(fullText, 200),
                content: displayText,
                displayContent: displayText,
                fullContent: fullText,  // Full text for API/message sending
                sessionId: result.sessionId,
                keywords: result.keywords || [],  // Include keywords for grouping
                score: result.score,
                messageCount: result.messageCount || 0,
                timestamp: result.embeddedAt || Date.now()
            };
            return memory;
        });
    }

    /**
     * Create a summary from conversation text
     * @param {string} text - The conversation text
     * @param {number} maxLength - Maximum length of summary
     * @returns {string} - Summary text
     */
    summarizeConversation(text, maxLength = 200) {
        if (!text) return '';
        
        // Take first few lines or truncate to maxLength
        const lines = text.split('\n').slice(0, 3);
        let summary = lines.join(' ');
        
        if (summary.length > maxLength) {
            summary = summary.substring(0, maxLength) + '...';
        }
        
        return summary;
    }

    /**
     * Handle @memory mention
     * This is called when the user types @memory in the chat
     */
    async handleMemoryMention(userQuery, app) {
        console.log('Memory mention triggered with query:', userQuery);
        
        // Show processing toast
        const dismissToast = app.showLoadingToast?.('Retrieving context...');
        
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
                    result.message || 'No context found',
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
