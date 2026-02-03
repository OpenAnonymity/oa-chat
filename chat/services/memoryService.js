/**
 * Memory Service
 * Handles communication with the local memory processing server
 * to create embeddings from chat history stored in IndexedDB.
 */

import { chatDB } from '../db.js';

class MemoryService {
    constructor() {
        this.serverUrl = 'http://localhost:5555';
        this.isProcessing = false;
    }

    /**
     * Check if the memory processing server is running
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
     * Get memory store status
     * @returns {Promise<Object>}
     */
    async getMemoryStatus() {
        try {
            const response = await fetch(`${this.serverUrl}/memory-status`, {
                method: 'GET',
                signal: AbortSignal.timeout(5000)
            });
            
            if (!response.ok) {
                throw new Error(`Server returned ${response.status}`);
            }
            
            return await response.json();
        } catch (error) {
            console.error('Failed to get memory status:', error);
            return { exists: false, error: error.message };
        }
    }

    /**
     * Export all chat history in the format expected by the preprocessing script
     * @returns {Promise<Object>} - Chat export data
     */
    async exportChatHistory() {
        try {
            // Get all sessions
            const sessions = await chatDB.getAllSessions();
            
            // Get all messages for each session
            const allMessages = [];
            for (const session of sessions) {
                const messages = await chatDB.getSessionMessages(session.id);
                allMessages.push(...messages);
            }

            // Format in the expected structure
            return {
                version: "1.0",
                exportDate: new Date().toISOString(),
                data: {
                    chats: {
                        sessions: sessions,
                        messages: allMessages
                    }
                }
            };
        } catch (error) {
            console.error('Failed to export chat history:', error);
            throw error;
        }
    }

    /**
     * Process chat history into memory store
     * @param {Function} onProgress - Progress callback
     * @returns {Promise<Object>} - Processing result
     */
    async processMemory(onProgress = null) {
        if (this.isProcessing) {
            throw new Error('Memory processing is already in progress');
        }

        console.log('[MEMORY SERVICE] ProcessMemory called - this exports IndexedDB');
        this.isProcessing = true;

        try {
            // Check if server is available
            onProgress?.('Checking memory server...');
            const available = await this.isServerAvailable();
            
            if (!available) {
                throw new Error(
                    'Memory processing server is not running. ' +
                    'Please start it with: python OA_memory/scripts/server.py'
                );
            }

            // Export chat history
            onProgress?.('Exporting chat history...');
            const chatData = await this.exportChatHistory();
            
            const sessionCount = chatData.data.chats.sessions.length;
            onProgress?.(`Processing ${sessionCount} chat sessions...`);

            // Send to server for processing
            const response = await fetch(`${this.serverUrl}/process-memory`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(chatData),
                signal: AbortSignal.timeout(300000) // 5 minute timeout
            });

            if (!response.ok) {
                const errorData = await response.json();
                throw new Error(errorData.error || `Server returned ${response.status}`);
            }

            const result = await response.json();
            onProgress?.('Memory processing complete!');
            
            return result;
        } catch (error) {
            console.error('Memory processing failed:', error);
            throw error;
        } finally {
            this.isProcessing = false;
        }
    }

}

// Export singleton instance
export const memoryService = new MemoryService();
