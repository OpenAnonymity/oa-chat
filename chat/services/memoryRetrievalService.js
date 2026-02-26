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
            const sessionResults = await embedder.searchSessionsWithTagBoost(userQuery, 5);
            
            onProgress?.('Building tiered memory context...');
            
            // Transform session results to memory format
            const memories = this.transformSessionsToMemories(sessionResults);
            onProgress?.('Memory retrieval complete!');
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
            const sessionMemory = typeof result.sessionMemory === 'string' ? result.sessionMemory.trim() : '';
            const conversationText = typeof result.conversationText === 'string' ? result.conversationText.trim() : '';
            const summary = typeof result.summary === 'string' ? result.summary.trim() : '';
            const domain = typeof (result.domain || result.category) === 'string'
                ? (result.domain || result.category).trim().toLowerCase()
                : null;
            const folder = typeof result.folder === 'string' ? result.folder.trim().toLowerCase() : null;
            const tags = Array.isArray(result.keywords)
                ? result.keywords
                    .filter(tag => typeof tag === 'string' && tag.trim().length > 0)
                    .map(tag => tag.trim().toLowerCase())
                : [];
            const matchedCategory = Array.isArray(result.matchedSessionCategories) && result.matchedSessionCategories.length > 0;
            const score = Number.isFinite(result.score) ? result.score : 0;

            const tierA = sessionMemory || summary || this.summarizeConversation(conversationText, 320);
            const tierBParts = [
                tierA,
                domain ? `Domain: ${domain}` : null,
                folder ? `Folder: ${folder}` : null,
                tags.length > 0 ? `Tags: ${tags.join(', ')}` : null,
                summary ? `Title: ${summary}` : null
            ].filter(Boolean);
            const tierB = tierBParts.join('\n');
            const tierCSnippet = conversationText.length > 1800
                ? `${conversationText.substring(0, 1800)}...`
                : conversationText;
            const tierC = tierCSnippet || tierB;

            let selectedTier = 'A';
            if (score >= 0.72 || matchedCategory) selectedTier = 'B';
            if (idx === 0 && score >= 0.82) selectedTier = 'C';
            console.log('[Memory Retrieval] Tier selection:', {
                sessionId: result.sessionId,
                domain,
                folder,
                score,
                selectedTier,
                matchedDomains: result.matchedSessionCategories || [],
                matchedFolders: result.matchedSessionFolders || [],
                matchedTags: result.matchedSessionTags || []
            });

            const payloadByTier = { A: tierA, B: tierB, C: tierC };
            const payloadContent = payloadByTier[selectedTier] || tierA;
            const displayText = payloadContent.length > 300 ? `${payloadContent.substring(0, 300)}...` : payloadContent;
            
            const memory = {
                title: result.summary || result.title || 'Untitled Session',
                summary: sessionMemory || this.summarizeConversation(conversationText, 200),
                content: displayText,
                displayContent: displayText,
                fullContent: payloadContent,
                contentTier: selectedTier,
                tierPayloads: payloadByTier,
                sessionId: result.sessionId,
                keywords: tags,
                domain,
                folder,
                category: domain,
                relevantTags: result.matchedSessionTags || [],
                retrievedTags: result.matchedTags || [],
                relevantDomains: result.matchedSessionCategories || [],
                retrievedDomains: result.matchedCategories || [],
                relevantFolders: result.matchedSessionFolders || [],
                retrievedFolders: result.matchedFolders || [],
                primaryRelevantTag: result.primaryMatchedTag || null,
                primaryRelevantDomain: result.primaryMatchedCategory || null,
                primaryRelevantFolder: result.primaryMatchedFolder || null,
                score: score,
                embeddingScore: Number.isFinite(result.embeddingScore) ? result.embeddingScore : null,
                categoryScore: Number.isFinite(result.categoryScore) ? result.categoryScore : null,
                folderScore: Number.isFinite(result.folderScore) ? result.folderScore : null,
                tagScore: Number.isFinite(result.tagScore) ? result.tagScore : null,
                matchType: result.matchType || null,
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
