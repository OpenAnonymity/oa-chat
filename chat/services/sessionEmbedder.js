/**
 * SessionEmbedder - Tracks session inactivity and embeds chat history to vector store.
 *
 * Uses a background timer to check for sessions that have been inactive for 5+ minutes
 * and have new content since their last embedding. Sessions are re-embedded as users
 * continue chatting, keeping the vector store up to date.
 *
 * On startup, performs a backfill to embed any sessions that are missing embeddings
 * or have stale embeddings (updatedAt > lastEmbeddedAt).
 *
 * Timestamps (stored in session object in IndexedDB):
 * - session.updatedAt: When the session was last modified (messages added, etc.)
 * - session.lastEmbeddedAt: When we last embedded this session
 *
 * Re-embedding triggers when:
 * - (now - updatedAt) > INACTIVITY_TIMEOUT_MS  (session has been idle for 5 min)
 * - updatedAt > lastEmbeddedAt  (new content since last embedding)
 */
import { createEmbeddingSource } from '../embeddings/index.js';
import { createVectorStore, encodeVectorId } from '../vector/index.js';
import { chatDB } from '../db.js';

const INACTIVITY_TIMEOUT_MS = 30 * 1000; // 30 seconds for testing (change to 5 * 60 * 1000 for production)
const CHECK_INTERVAL_MS = 30 * 1000; // Check every 30 seconds
const MAX_CONTENT_LENGTH = 8000; // Truncate very long conversations
const BACKFILL_DELAY_MS = 500; // Delay between backfill embeddings to avoid overwhelming the system

class SessionEmbedder {
    constructor() {
        this.embedder = null;
        this.store = null;
        this.initialized = false;
        this.initPromise = null;
        this.checkInterval = null;
        this.activeSessionIds = new Set(); // Sessions that have had activity this browser session
        this.backfillQueue = []; // Queue of session IDs to backfill
        this.isBackfilling = false; // Whether backfill is in progress
        this._searchTimings = []; // Profiling data for searchSessions
        this._embedTimings = []; // Profiling data for embedSession
    }

    /**
     * Initialize the embedding source and vector store.
     * Called once during app startup.
     */
    async init() {
        if (this.initPromise) return this.initPromise;

        this.initPromise = this._doInit();
        return this.initPromise;
    }

    async _doInit() {
        try {
            // Initialize embedding source using WebLLM backend
            this.embedder = createEmbeddingSource({
                backend: 'local',
                model: 'snowflake-arctic-embed-m-q0f32-MLC-b32',
                backendId: 'webllm'
            });

            // Initialize vector store (uses Orama in browser, persists to IndexedDB)
            this.store = await createVectorStore({
                name: 'chat-history',
                dimension: 768,
                metric: 'cosine',
                backend: 'auto'
            });

            this.initialized = true;

            // Start background timer to check for inactive sessions
            this.startBackgroundCheck();

            // Start backfill of existing sessions (non-blocking)
            this.scheduleBackfill();

            console.log('[SessionEmbedder] Initialized successfully');
        } catch (error) {
            console.warn('[SessionEmbedder] Initialization failed:', error);
            this.initialized = false;
        }
    }

    /**
     * Schedule the backfill process to run when the browser is idle.
     * This ensures we don't block the UI during startup.
     */
    scheduleBackfill() {
        if (typeof requestIdleCallback === 'function') {
            requestIdleCallback(() => this.startBackfill(), { timeout: 5000 });
        } else {
            // Fallback for Safari and older browsers
            setTimeout(() => this.startBackfill(), 2000);
        }
    }

    /**
     * Start the backfill process to embed all sessions that need it.
     * Scans all sessions and queues those with missing or stale embeddings.
     */
    async startBackfill() {
        if (!this.initialized || this.isBackfilling) {
            return;
        }

        try {
            console.log('[SessionEmbedder] Starting backfill scan...');

            // Get all sessions from the database
            const allSessions = await chatDB.getAllSessions();
            if (!allSessions || allSessions.length === 0) {
                console.log('[SessionEmbedder] No sessions to backfill');
                return;
            }

            // Filter sessions that need embedding:
            // - No lastEmbeddedAt (never embedded)
            // - OR updatedAt > lastEmbeddedAt (has new content)
            const sessionsNeedingEmbedding = allSessions.filter(session => {
                const updatedAt = session.updatedAt || session.createdAt || 0;
                const lastEmbeddedAt = session.lastEmbeddedAt || 0;
                return lastEmbeddedAt === 0 || updatedAt > lastEmbeddedAt;
            });

            if (sessionsNeedingEmbedding.length === 0) {
                console.log('[SessionEmbedder] All sessions already embedded');
                return;
            }

            // Sort by updatedAt descending (most recently updated first)
            sessionsNeedingEmbedding.sort((a, b) => {
                const aTime = a.updatedAt || a.createdAt || 0;
                const bTime = b.updatedAt || b.createdAt || 0;
                return bTime - aTime;
            });

            // Queue session IDs for backfill
            this.backfillQueue = sessionsNeedingEmbedding.map(s => s.id);
            console.log(`[SessionEmbedder] Queued ${this.backfillQueue.length} sessions for backfill`);

            // Start processing the queue
            this.processBackfillQueue();

        } catch (error) {
            console.warn('[SessionEmbedder] Backfill scan failed:', error);
        }
    }

    /**
     * Process the backfill queue one session at a time.
     * Uses requestIdleCallback to avoid blocking the UI.
     */
    async processBackfillQueue() {
        if (this.backfillQueue.length === 0) {
            this.isBackfilling = false;
            console.log('[SessionEmbedder] Backfill complete');
            return;
        }

        this.isBackfilling = true;

        // Get the next session ID from the queue
        const sessionId = this.backfillQueue.shift();

        try {
            // Check if session still needs embedding (might have been embedded by active session logic)
            const session = await chatDB.getSession(sessionId);
            if (session) {
                const updatedAt = session.updatedAt || session.createdAt || 0;
                const lastEmbeddedAt = session.lastEmbeddedAt || 0;

                if (lastEmbeddedAt === 0 || updatedAt > lastEmbeddedAt) {
                    await this.embedSession(sessionId);
                }
            }
        } catch (error) {
            console.warn(`[SessionEmbedder] Backfill failed for session ${sessionId}:`, error);
        }

        // Schedule next backfill item with a delay to avoid overwhelming the system
        if (this.backfillQueue.length > 0) {
            if (typeof requestIdleCallback === 'function') {
                // Use requestIdleCallback with a minimum delay
                setTimeout(() => {
                    requestIdleCallback(() => this.processBackfillQueue(), { timeout: 10000 });
                }, BACKFILL_DELAY_MS);
            } else {
                // Fallback: simple timeout
                setTimeout(() => this.processBackfillQueue(), BACKFILL_DELAY_MS);
            }
        } else {
            this.isBackfilling = false;
            console.log('[SessionEmbedder] Backfill complete');
        }
    }

    /**
     * Get the current backfill status.
     * @returns {Object} Backfill status including queue length
     */
    getBackfillStatus() {
        return {
            isBackfilling: this.isBackfilling,
            queueLength: this.backfillQueue.length
        };
    }

    /**
     * Start the background timer that checks for inactive sessions to embed.
     */
    startBackgroundCheck() {
        if (this.checkInterval) {
            clearInterval(this.checkInterval);
        }

        this.checkInterval = setInterval(() => {
            this.checkAndEmbedInactiveSessions();
        }, CHECK_INTERVAL_MS);

        // Also run immediately on start
        this.checkAndEmbedInactiveSessions();
    }

    /**
     * Stop the background timer.
     */
    stopBackgroundCheck() {
        if (this.checkInterval) {
            clearInterval(this.checkInterval);
            this.checkInterval = null;
        }
    }

    /**
     * Record activity for a session. Call this when:
     * - User sends a message
     * - Assistant finishes responding
     * - User switches to a session
     *
     * This adds the session to the active set so we track it for embedding.
     *
     * @param {string} sessionId - The session that had activity
     */
    recordActivity(sessionId) {
        if (!sessionId) return;

        // Add to active sessions set (we'll check these for embedding)
        this.activeSessionIds.add(sessionId);
    }

    /**
     * Check all active sessions and embed any that have been inactive
     * for 5+ minutes and have new content.
     */
    async checkAndEmbedInactiveSessions() {
        if (!this.initialized || this.activeSessionIds.size === 0) {
            return;
        }

        const now = Date.now();

        for (const sessionId of this.activeSessionIds) {
            try {
                const session = await chatDB.getSession(sessionId);
                if (!session) {
                    // Session was deleted, remove from tracking
                    this.activeSessionIds.delete(sessionId);
                    continue;
                }

                const updatedAt = session.updatedAt || session.createdAt || 0;
                const lastEmbeddedAt = session.lastEmbeddedAt || 0;
                const timeSinceUpdate = now - updatedAt;

                // Check if session has been inactive for 5+ minutes
                // AND has new content since last embedding
                if (timeSinceUpdate >= INACTIVITY_TIMEOUT_MS && updatedAt > lastEmbeddedAt) {
                    await this.embedSession(sessionId);
                }
            } catch (error) {
                console.warn(`[SessionEmbedder] Error checking session ${sessionId}:`, error);
            }
        }
    }

    /**
     * Embed a session's chat history and store in the vector store.
     * Updates session.lastEmbeddedAt after successful embedding.
     *
     * @param {string} sessionId - The session to embed
     */
    async embedSession(sessionId) {
        if (!sessionId) return;

        if (!this.initialized || !this.embedder || !this.store) {
            console.debug('[SessionEmbedder] Not initialized, skipping embed');
            return;
        }

        try {
            // Get session info
            const session = await chatDB.getSession(sessionId);
            if (!session) {
                console.debug(`[SessionEmbedder] Session ${sessionId} not found`);
                return;
            }

            // Get all messages for this session
            const messages = await chatDB.getSessionMessages(sessionId);
            if (!messages || messages.length === 0) {
                console.debug(`[SessionEmbedder] No messages in session ${sessionId}`);
                return;
            }

            // Build text representation of the conversation
            let conversationText = '';
            // if (session.title && session.title !== 'New Chat') {
            //     conversationText = `Topic: ${session.title}\n\n`;
            // }

            conversationText += messages
                .filter(m => m.content && m.content.trim())
                .map(m => {
                    const role = m.role === 'user' ? 'User' : 'Assistant';
                    return `${role}: ${m.content.trim()}`;
                })
                .join('\n\n');

            // Skip if no meaningful content
            if (!conversationText.trim() || conversationText.length < 20) {
                console.debug(`[SessionEmbedder] Session ${sessionId} has insufficient content`);
                return;
            }

            // Truncate if too long
            if (conversationText.length > MAX_CONTENT_LENGTH) {
                conversationText = conversationText.substring(0, MAX_CONTENT_LENGTH) + '...';
            }

            // Generate embedding
            console.debug(`[SessionEmbedder] Generating embedding for session ${sessionId}...`);
            const te0 = performance.now();
            const embedding = await this.embedder.embedText(conversationText);
            const te1 = performance.now();

            // Store in vector store
            const vectorId = encodeVectorId({
                namespace: 'chat',
                type: 'session',
                entityId: sessionId
            });

            await this.store.upsert([{
                id: vectorId,
                vector: embedding,
                metadata: {
                    sessionId,
                    title: session.title || 'Untitled',
                    summary: session.summary || null,
                    keywords: session.keywords || [],
                    conversationText: conversationText,
                    messageCount: messages.length,
                    model: session.model || null,
                    embeddedAt: Date.now(),
                    createdAt: session.createdAt || null,
                    updatedAt: session.updatedAt || null
                }
            }]);
            const te2 = performance.now();

            // Update session with lastEmbeddedAt timestamp (persisted to IndexedDB)
            session.lastEmbeddedAt = Date.now();
            await chatDB.saveSession(session);
            const te3 = performance.now();

            const embedMs = te1 - te0;
            const upsertMs = te2 - te1;
            const saveMs = te3 - te2;
            this._embedTimings.push({ embedMs, upsertMs, saveMs, contentLength: conversationText.length, messageCount: messages.length, ts: Date.now() });
            console.log(`[SessionEmbedder] Embedded session "${session.title || sessionId}" (${messages.length} messages) — embed: ${embedMs.toFixed(2)}ms, upsert: ${upsertMs.toFixed(2)}ms, save: ${saveMs.toFixed(2)}ms`);

        } catch (error) {
            console.warn(`[SessionEmbedder] Failed to embed session ${sessionId}:`, error);
        }
    }

    /**
     * Force embed a session immediately, regardless of inactivity timeout.
     * Useful for embedding before page unload.
     *
     * @param {string} sessionId - The session to embed
     */
    async forceEmbedSession(sessionId) {
        if (!sessionId) return;

        try {
            const session = await chatDB.getSession(sessionId);
            if (!session) return;

            const updatedAt = session.updatedAt || session.createdAt || 0;
            const lastEmbeddedAt = session.lastEmbeddedAt || 0;

            // Only embed if there's new content
            if (updatedAt > lastEmbeddedAt) {
                await this.embedSession(sessionId);
            }
        } catch (error) {
            console.warn(`[SessionEmbedder] Force embed failed for ${sessionId}:`, error);
        }
    }

    /**
     * Search for similar sessions based on a query.
     *
     * @param {string} query - The search query
     * @param {number} k - Number of results to return (default: 5)
     * @param {Object} options - Search options (e.g., filter)
     * @returns {Promise<Array>} Search results with session metadata
     */
    async searchSessions(query, k = 5, options = {}) {
        if (!query || !query.trim()) {
            return [];
        }

        if (!this.initialized || !this.embedder || !this.store) {
            console.debug('[SessionEmbedder] Not initialized, cannot search');
            return [];
        }

        try {
            // Generate embedding for query
            const t0 = performance.now();
            const queryEmbedding = await this.embedder.embedText(query);
            const t1 = performance.now();

            // Search vector store
            const results = await this.store.search(queryEmbedding, k, options);
            const t2 = performance.now();

            const embedMs = t1 - t0;
            const retrievalMs = t2 - t1;
            this._searchTimings.push({ embedMs, retrievalMs, ts: Date.now() });
            console.log(`[SessionEmbedder] searchSessions timing — embed query: ${embedMs.toFixed(2)}ms, retrieval: ${retrievalMs.toFixed(2)}ms, total: ${(embedMs + retrievalMs).toFixed(2)}ms`);

            return results.map(r => ({
                sessionId: r.metadata?.sessionId,
                title: r.metadata?.title,
                summary: r.metadata?.summary,
                keywords: r.metadata?.keywords || [],
                conversationText: r.metadata?.conversationText,
                messageCount: r.metadata?.messageCount,
                model: r.metadata?.model,
                embeddedAt: r.metadata?.embeddedAt,
                updatedAt: r.metadata?.updatedAt,
                score: r.score
            }));
        } catch (error) {
            console.warn('[SessionEmbedder] Search failed:', error);
            return [];
        }
    }

    /**
     * Get aggregate profiling stats for searchSessions calls.
     * Call from console: sessionEmbedder.getSearchProfile()
     */
    getSearchProfile() {
        const t = this._searchTimings;
        if (t.length === 0) return { calls: 0, message: 'No search calls recorded yet.' };

        const percentile = (arr, p) => {
            const sorted = [...arr].sort((a, b) => a - b);
            const i = Math.ceil((p / 100) * sorted.length) - 1;
            return sorted[Math.max(0, i)];
        };

        const summarize = (values) => ({
            min: Math.min(...values).toFixed(2),
            max: Math.max(...values).toFixed(2),
            avg: (values.reduce((a, b) => a + b, 0) / values.length).toFixed(2),
            p50: percentile(values, 50).toFixed(2),
            p95: percentile(values, 95).toFixed(2),
        });

        const embeds = t.map(e => e.embedMs);
        const retrievals = t.map(e => e.retrievalMs);
        const totals = t.map(e => e.embedMs + e.retrievalMs);

        const profile = {
            calls: t.length,
            embedQuery: summarize(embeds),
            retrieval: summarize(retrievals),
            total: summarize(totals),
        };

        console.table({ embedQuery: profile.embedQuery, retrieval: profile.retrieval, total: profile.total });
        return profile;
    }

    /**
     * Get aggregate profiling stats for embedSession calls.
     * Call from console: sessionEmbedder.getEmbedProfile()
     */
    getEmbedProfile() {
        const t = this._embedTimings;
        if (t.length === 0) return { calls: 0, message: 'No embed calls recorded yet.' };

        const percentile = (arr, p) => {
            const sorted = [...arr].sort((a, b) => a - b);
            const i = Math.ceil((p / 100) * sorted.length) - 1;
            return sorted[Math.max(0, i)];
        };

        const summarize = (values) => ({
            min: Math.min(...values).toFixed(2),
            max: Math.max(...values).toFixed(2),
            avg: (values.reduce((a, b) => a + b, 0) / values.length).toFixed(2),
            p50: percentile(values, 50).toFixed(2),
            p95: percentile(values, 95).toFixed(2),
        });

        const embeds = t.map(e => e.embedMs);
        const upserts = t.map(e => e.upsertMs);
        const saves = t.map(e => e.saveMs);
        const totals = t.map(e => e.embedMs + e.upsertMs + e.saveMs);
        const contentLengths = t.map(e => e.contentLength);
        const messageCounts = t.map(e => e.messageCount);

        const profile = {
            calls: t.length,
            embed: summarize(embeds),
            upsert: summarize(upserts),
            dbSave: summarize(saves),
            total: summarize(totals),
            contentLength: summarize(contentLengths),
            messageCount: summarize(messageCounts),
        };

        console.table({ embed: profile.embed, upsert: profile.upsert, dbSave: profile.dbSave, total: profile.total });
        console.table({ contentLength: profile.contentLength, messageCount: profile.messageCount });
        return profile;
    }

    /**
     * Get statistics about the embedded sessions.
     *
     * @returns {Promise<Object>} Stats including count and storage info
     */
    async getStats() {
        if (!this.initialized || !this.store) {
            return { initialized: false, count: 0 };
        }

        try {
            const count = await this.store.count();
            const stats = await this.store.stats();
            return {
                initialized: true,
                count,
                activeSessionsTracked: this.activeSessionIds.size,
                backfillStatus: this.getBackfillStatus(),
                ...stats
            };
        } catch (error) {
            console.warn('[SessionEmbedder] Failed to get stats:', error);
            return { initialized: true, count: 0, error: error.message };
        }
    }

    /**
     * Remove a session's embedding from the vector store.
     * Call this when a session is deleted.
     *
     * @param {string} sessionId - The session ID to remove
     * @returns {Promise<boolean>} True if removed, false if not found or error
     */
    async removeSessionEmbedding(sessionId) {
        if (!sessionId) return false;

        if (!this.initialized || !this.store) {
            console.debug('[SessionEmbedder] Not initialized, cannot remove embedding');
            return false;
        }

        try {
            // Generate the same vector ID used when upserting
            const vectorId = encodeVectorId({
                namespace: 'chat',
                type: 'session',
                entityId: sessionId
            });

            const removed = await this.store.remove(vectorId);

            // Also remove from active sessions tracking
            this.activeSessionIds.delete(sessionId);

            // Remove from backfill queue if present
            const queueIndex = this.backfillQueue.indexOf(sessionId);
            if (queueIndex !== -1) {
                this.backfillQueue.splice(queueIndex, 1);
            }

            if (removed > 0) {
                console.log(`[SessionEmbedder] Removed embedding for session ${sessionId}`);
                return true;
            } else {
                console.debug(`[SessionEmbedder] No embedding found for session ${sessionId}`);
                return false;
            }
        } catch (error) {
            console.warn(`[SessionEmbedder] Failed to remove embedding for session ${sessionId}:`, error);
            return false;
        }
    }

    /**
     * Clear all embedded sessions from the vector store.
     */
    async clear() {
        if (!this.initialized || !this.store) {
            return;
        }

        try {
            await this.store.clear();
            this.activeSessionIds.clear();
            this.backfillQueue = [];
            this.isBackfilling = false;
            console.log('[SessionEmbedder] Cleared all embeddings');
        } catch (error) {
            console.warn('[SessionEmbedder] Failed to clear:', error);
        }
    }

    /**
     * Clean up resources when the app is closing.
     */
    async destroy() {
        this.stopBackgroundCheck();
        this.backfillQueue = [];
        this.isBackfilling = false;

        if (this.store) {
            await this.store.close();
        }

        this.initialized = false;
    }
}

// Export singleton instance
const sessionEmbedder = new SessionEmbedder();
export default sessionEmbedder;

// Also export class for testing
export { SessionEmbedder };
