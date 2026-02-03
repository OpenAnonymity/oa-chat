/**
 * Message Memory Context Manager
 * Handles storing and displaying memory context for messages
 * Enables hover preview and session highlighting
 */

export class MessageMemoryContext {
    constructor() {
        this.messageMemoryMap = new Map(); // messageId -> { memories: [], sessionIds: [] }
    }

    /**
     * Store memory context for a message
     * @param {string} messageId - Message ID
     * @param {Array} memories - Array of memory objects with title, content, etc.
     * @param {Array} sessionIds - Array of session IDs that were retrieved
     */
    setMessageContext(messageId, memories, sessionIds = []) {
        if (!messageId) return;
        
        this.messageMemoryMap.set(messageId, {
            memories: memories || [],
            sessionIds: sessionIds || [],
            timestamp: Date.now()
        });

        // Cleanup old entries (keep only last 100)
        if (this.messageMemoryMap.size > 100) {
            const entries = Array.from(this.messageMemoryMap.entries());
            entries.sort((a, b) => a[1].timestamp - b[1].timestamp);
            
            // Remove oldest 20 entries
            for (let i = 0; i < 20; i++) {
                this.messageMemoryMap.delete(entries[i][0]);
            }
        }
    }

    /**
     * Get memory context for a message
     * @param {string} messageId - Message ID
     * @returns {Object|null} - Memory context or null
     */
    getMessageContext(messageId) {
        return this.messageMemoryMap.get(messageId) || null;
    }

    /**
     * Clear memory context for a message
     * @param {string} messageId - Message ID
     */
    clearMessageContext(messageId) {
        this.messageMemoryMap.delete(messageId);
    }

    /**
     * Clear all memory contexts (when clearing chat history, etc.)
     */
    clearAll() {
        this.messageMemoryMap.clear();
    }
}

// Export singleton
export const messageMemoryContext = new MessageMemoryContext();

/**
 * Highlight retrieved session items in sidebar
 * @param {Array} sessionIds - Array of session IDs to highlight
 */
export function highlightMemoryRetrievedSessions(sessionIds = []) {
    // Remove previous highlights
    document.querySelectorAll('.memory-retrieved-session').forEach(el => {
        el.classList.remove('memory-retrieved-session');
    });

    if (!sessionIds || sessionIds.length === 0) return;

    // Add highlight class to matching sessions
    sessionIds.forEach(sessionId => {
        const sessionEl = document.querySelector(`[data-session-id="${sessionId}"]`);
        if (sessionEl) {
            sessionEl.classList.add('memory-retrieved-session');
        }
    });
}

/**
 * Remove session highlighting
 */
export function clearMemorySessionHighlights() {
    document.querySelectorAll('.memory-retrieved-session').forEach(el => {
        el.classList.remove('memory-retrieved-session');
    });
}
