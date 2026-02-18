/**
 * SessionEmbedder - Embeds chat history to vector store using a single deduplicated queue.
 *
 * All session IDs that need embedding flow through `this.queue`. Sources:
 * - `recordActivity(sessionId)` — called after an LLM response completes
 * - `startBackfill()` — scans all sessions at startup for missing/stale embeddings
 * - `enqueueImportedSessions(ids)` — called after chat history import
 *
 * `processQueue()` is the unified processor. It runs at most once at a time
 * (guarded by `this.processing`) and is triggered immediately by enqueue
 * operations as well as by the periodic background timer.
 *
 * Timestamps (stored in session object in IndexedDB):
 * - session.updatedAt: When the session was last modified (messages added, etc.)
 * - session.lastEmbeddedAt: When we last embedded this session
 *
 * Re-embedding triggers when updatedAt > lastEmbeddedAt.
 */
import { createEmbeddingSource } from '../embeddings/index.js';
import { createVectorStore, encodeVectorId } from '../vector/index.js';
import { chatDB } from '../db.js';
import { localInferenceService } from '../../local_inference/index.js';
import ticketClient from './ticketClient.js';
import { TINFOIL_API_KEY } from './config.env.js';

const CHECK_INTERVAL_MS = 30 * 1000; // Check every 30 seconds
const MAX_CONTENT_LENGTH = 8000; // Truncate very long conversations
const BACKFILL_DELAY_MS = 500; // Delay between queue embeddings to avoid overwhelming the system

const TINFOIL_BASE_URL = 'https://inference.tinfoil.sh';
const TINFOIL_BACKEND_ID = 'tinfoil';
const TINFOIL_MODEL = 'llama3-3-70b';
const TINFOIL_KEY_TICKETS_REQUIRED = 2;

const TAG_MATCH_PROMPT = `Given a user query and a list of existing tags from past conversations, return only the tags that are semantically relevant to the query. A tag is relevant if a conversation about that topic could plausibly contain useful context for answering the query.

Return valid JSON only — an array of matching tag strings. If no tags match, return an empty array [].

User query: `;

class SessionEmbedder {
    constructor() {
        this.embedder = null;
        this.store = null;
        this.initialized = false;
        this.initPromise = null;
        this.checkInterval = null;
        this.queue = []; // Deduplicated session ID strings
        this.processing = false; // Lock to prevent concurrent processQueue runs
        this._searchTimings = []; // Profiling data for searchSessions
        this._embedTimings = []; // Profiling data for embedSession
        this._tinfoilKey = null; // Cached confidential key for LLM tag matching
        this._tinfoilKeyInfo = null; // Key metadata (expiry, etc.)
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

            // Start background timer to process queue periodically
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
     * Scan all sessions and enqueue those with missing or stale embeddings.
     */
    async startBackfill() {
        if (!this.initialized) {
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
                if (session.disableAutoEmbeddingKeywords) return false;
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

            // Enqueue session IDs and start processing
            const ids = sessionsNeedingEmbedding.map(s => s.id);
            this.enqueue(ids);
            console.log(`[SessionEmbedder] Queued ${ids.length} sessions for backfill`);

            this.processQueue();

        } catch (error) {
            console.warn('[SessionEmbedder] Backfill scan failed:', error);
        }
    }

    /**
     * Add session IDs to the queue, deduplicating against existing entries.
     *
     * @param {string|string[]} sessionIds - One or more session IDs to enqueue
     */
    enqueue(sessionIds) {
        const ids = Array.isArray(sessionIds) ? sessionIds : [sessionIds];
        const existing = new Set(this.queue);
        for (const id of ids) {
            if (id && !existing.has(id)) {
                this.queue.push(id);
                existing.add(id);
            }
        }
    }

    /**
     * Unified queue processor. Replaces both checkAndEmbedInactiveSessions
     * and processBackfillQueue.
     *
     * Always processes from the front of the queue. Uses indexOf to re-locate
     * items after each await, since external callers (e.g. removeSessionEmbedding)
     * may splice the queue during yields. On error, stops this cycle and retries
     * on the next timer tick.
     */
    async processQueue() {
        if (!this.initialized || this.processing) {
            return;
        }

        this.processing = true;

        try {
            while (this.queue.length > 0) {
                const sessionId = this.queue[0];

                try {
                    const session = await chatDB.getSession(sessionId);

                    // Re-locate after yield — queue may have shifted
                    const idx = this.queue.indexOf(sessionId);
                    if (idx === -1) continue; // Removed externally

                    if (!session) {
                        // Session deleted — remove from queue
                        this.queue.splice(idx, 1);
                        continue;
                    }

                    if (session.disableAutoEmbeddingKeywords) {
                        this.queue.splice(idx, 1);
                        continue;
                    }

                    const updatedAt = session.updatedAt || session.createdAt || 0;
                    const lastEmbeddedAt = session.lastEmbeddedAt || 0;

                    if (updatedAt <= lastEmbeddedAt) {
                        // Already current — remove from queue
                        this.queue.splice(idx, 1);
                        continue;
                    }

                    // Ready to embed — remove from queue and embed
                    this.queue.splice(idx, 1);
                    await this.embedSession(sessionId);

                    // Yield to browser before processing next item
                    if (this.queue.length > 0) {
                        await new Promise(resolve => {
                            if (typeof requestIdleCallback === 'function') {
                                setTimeout(() => {
                                    requestIdleCallback(resolve, { timeout: 10000 });
                                }, BACKFILL_DELAY_MS);
                            } else {
                                setTimeout(resolve, BACKFILL_DELAY_MS);
                            }
                        });
                    }
                } catch (error) {
                    // DB error — stop this cycle, retry on next timer tick
                    console.warn(`[SessionEmbedder] Error processing session ${sessionId}:`, error);
                    break;
                }
            }
        } finally {
            this.processing = false;
        }
    }

    /**
     * Public entry point for the import flow. Enqueues imported session IDs
     * and starts processing immediately.
     *
     * @param {string[]} sessionIds - Array of imported session IDs
     */
    enqueueImportedSessions(sessionIds) {
        if (!sessionIds || sessionIds.length === 0) return;

        this.enqueue(sessionIds);
        console.log(`[SessionEmbedder] Enqueued ${sessionIds.length} imported sessions`);
        this.processQueue();
    }

    /**
     * Get the current processing status.
     * @returns {Object} Status including queue length
     */
    getBackfillStatus() {
        return {
            isProcessing: this.processing,
            queueLength: this.queue.length
        };
    }

    /**
     * Start the background timer that periodically processes the queue.
     */
    startBackgroundCheck() {
        if (this.checkInterval) {
            clearInterval(this.checkInterval);
        }

        this.checkInterval = setInterval(() => {
            this.processQueue();
        }, CHECK_INTERVAL_MS);

        // Also run immediately on start
        this.processQueue();
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
     * Record activity for a session. Call this after an LLM response completes.
     * Enqueues the session and triggers immediate processing.
     *
     * @param {string} sessionId - The session that had activity
     */
    recordActivity(sessionId) {
        if (!sessionId) return;

        this.enqueue(sessionId);
        this.processQueue();
    }

    /**
     * Embed a session's chat history and store in the vector store.
     * Updates session.lastEmbeddedAt after successful embedding.
     *
     * @param {string} sessionId - The session to embed
     */
    async embedSession(sessionId) {
        if (!sessionId) return false;

        if (!this.initialized || !this.embedder || !this.store) {
            console.debug('[SessionEmbedder] Not initialized, skipping embed');
            return false;
        }

        try {
            // Wait for any in-flight keyword generation to complete before embedding.
            // Returns immediately if no generation is in progress.
            try {
                const { default: keywordsGenerator } = await import('./keywordsGenerator.js');
                await keywordsGenerator.waitForKeywords(sessionId);
            } catch (err) {
                // Non-fatal — proceed with whatever keywords exist
                console.debug(`[SessionEmbedder] waitForKeywords skipped for ${sessionId}:`, err);
            }

            // Get session info (re-read after keyword generation may have updated it)
            const session = await chatDB.getSession(sessionId);
            if (!session) {
                console.debug(`[SessionEmbedder] Session ${sessionId} not found`);
                return false;
            }

            // Get all messages for this session
            const messages = await chatDB.getSessionMessages(sessionId);
            if (!messages || messages.length === 0) {
                console.debug(`[SessionEmbedder] No messages in session ${sessionId}`);
                return false;
            }

            // Build text representation of the conversation
            let conversationText = '';

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
                return false;
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
                    conversationText: conversationText,
                    messageCount: messages.length,
                    model: session.model || null,
                    embeddedAt: Date.now(),
                    createdAt: session.createdAt || null,
                    updatedAt: session.updatedAt || null
                }
            }]);
            const te2 = performance.now();

            // Update only lastEmbeddedAt on the freshest session record to avoid
            // clobbering concurrently written fields (e.g. keywords/summary).
            const latestSession = await chatDB.getSession(sessionId);
            if (latestSession) {
                latestSession.lastEmbeddedAt = Date.now();
                await chatDB.saveSession(latestSession);
            }
            const te3 = performance.now();

            const embedMs = te1 - te0;
            const upsertMs = te2 - te1;
            const saveMs = te3 - te2;
            this._embedTimings.push({ embedMs, upsertMs, saveMs, contentLength: conversationText.length, messageCount: messages.length, ts: Date.now() });
            console.log(`[SessionEmbedder] Embedded session "${session.title || sessionId}" (${messages.length} messages) — embed: ${embedMs.toFixed(2)}ms, upsert: ${upsertMs.toFixed(2)}ms, save: ${saveMs.toFixed(2)}ms`);
            return true;

        } catch (error) {
            console.warn(`[SessionEmbedder] Failed to embed session ${sessionId}:`, error);
            return false;
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

            const sessionMap = await this._getSessionMapForResults(results);

            return results.map(r => ({
                sessionId: r.metadata?.sessionId,
                title: r.metadata?.title,
                summary: r.metadata?.summary,
                keywords: this._getKeywordsForResult(r, sessionMap),
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

    // ---- Tinfoil LLM key management (same pattern as keywordsGenerator) ----

    /**
     * Check if the cached Tinfoil confidential key is still valid.
     * @returns {boolean}
     */
    _isTinfoilKeyValid() {
        if (!this._tinfoilKey || !this._tinfoilKeyInfo) return false;
        const expiresAt = this._tinfoilKeyInfo.expiresAt
            || this._tinfoilKeyInfo.expires_at
            || this._tinfoilKeyInfo.expires_at_unix;
        if (!expiresAt) return false;
        const expiry = typeof expiresAt === 'number'
            ? new Date(expiresAt * 1000)
            : new Date(expiresAt);
        return expiry > new Date(Date.now() + 60000); // 1 min buffer
    }

    /**
     * Ensure a valid Tinfoil API key is available.
     * Checks for a static key from environment first, then falls back
     * to acquiring one via ticket redemption.
     * @returns {Promise<string|null>} The API key, or null if unavailable
     */
    async _ensureTinfoilKey() {
        // 1. Prefer static API key from environment
        const envKey = TINFOIL_API_KEY;
        if (envKey) {
            localInferenceService.configureBackend(TINFOIL_BACKEND_ID, {
                baseUrl: TINFOIL_BASE_URL,
                apiKey: envKey
            });
            return envKey;
        }

        // 2. Use cached confidential key if still valid
        if (this._isTinfoilKeyValid()) {
            return this._tinfoilKey;
        }

        // 3. Fall back to ticket-based key acquisition
        const ticketCount = ticketClient.getTicketCount();
        if (ticketCount < TINFOIL_KEY_TICKETS_REQUIRED) {
            console.log(`[SessionEmbedder] Not enough tickets for Tinfoil key (need ${TINFOIL_KEY_TICKETS_REQUIRED}, have ${ticketCount})`);
            return null;
        }

        try {
            const keyData = await ticketClient.requestConfidentialApiKey('search', TINFOIL_KEY_TICKETS_REQUIRED);
            this._tinfoilKey = keyData.key;
            this._tinfoilKeyInfo = keyData;

            localInferenceService.configureBackend(TINFOIL_BACKEND_ID, {
                baseUrl: TINFOIL_BASE_URL,
                apiKey: keyData.key
            });

            console.log('[SessionEmbedder] Acquired Tinfoil confidential key');
            return keyData.key;
        } catch (error) {
            console.warn('[SessionEmbedder] Failed to acquire Tinfoil key:', error);
            return null;
        }
    }

    /**
     * Extract output text from a Responses API response object.
     * @param {Object} response - localInferenceService response
     * @returns {string} The output text, or empty string
     */
    _extractOutputText(response) {
        if (!response) return '';
        if (typeof response.output_text === 'string') return response.output_text;
        const output = Array.isArray(response.output) ? response.output : [];
        for (const item of output) {
            const content = Array.isArray(item?.content) ? item.content : [];
            for (const part of content) {
                if (part?.type === 'output_text' && typeof part.text === 'string') {
                    return part.text;
                }
            }
        }
        return '';
    }

    /**
     * Use LLM to identify which existing tags are semantically relevant to the query.
     *
     * @param {string} query - The user's search query
     * @param {string[]} allTags - All distinct tags across sessions
     * @returns {Promise<string[]>} Array of matching tag strings
     */
    async _matchTagsWithLLM(query, allTags) {
        if (!allTags || allTags.length === 0) return [];

        const apiKey = await this._ensureTinfoilKey();
        if (!apiKey) {
            console.log('[SessionEmbedder] No Tinfoil key available for tag matching');
            return [];
        }

        const prompt = `${TAG_MATCH_PROMPT}"${query}"
Available tags: ${JSON.stringify(allTags)}`;

        const response = await localInferenceService.createResponse({
            model: TINFOIL_MODEL,
            input: [
                {
                    role: 'user',
                    content: [
                        {
                            type: 'input_text',
                            text: prompt
                        }
                    ]
                }
            ],
            max_output_tokens: 200,
            temperature: 0,
            stream: false
        }, { backendId: TINFOIL_BACKEND_ID });

        const responseText = this._extractOutputText(response);
        if (!responseText) {
            console.warn('[SessionEmbedder] Empty LLM tag-match response');
            return [];
        }

        // Parse JSON array
        try {
            const jsonMatch = responseText.match(/\[[\s\S]*\]/);
            const parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : JSON.parse(responseText);
            if (!Array.isArray(parsed)) return [];

            // Validate: only return tags that exist in allTags
            const tagSet = new Set(allTags);
            const matched = parsed
                .filter(t => typeof t === 'string')
                .map(t => t.trim().toLowerCase())
                .filter(t => tagSet.has(t));

            console.log(`[SessionEmbedder] LLM matched tags: ${JSON.stringify(matched)} (from ${allTags.length} candidates)`);
            return matched;
        } catch (parseError) {
            console.warn('[SessionEmbedder] Failed to parse LLM tag-match response:', parseError, responseText);
            return [];
        }
    }

    /**
     * Search sessions using LLM-based tag matching + embedding similarity.
     *
     * Three phases:
     * 1. Collect all distinct tags across sessions
     * 2. LLM tag match: call LLM to identify which tags are relevant to the query
     * 3. Embedding search with filter: search vector store filtered to sessions
     *    whose keywords overlap with the LLM-matched tags, ranked by similarity
     *
     * Falls back to pure embedding search if LLM tag matching fails or returns no matches.
     *
     * @param {string} query - The search query
     * @param {number} k - Number of results to return (default: 5)
     * @param {Object} options - Search options
     * @returns {Promise<Array>} Search results ranked by embedding similarity
     */
    async searchSessionsWithTagBoost(query, k = 5, options = {}) {
        if (!query || !query.trim()) {
            return [];
        }

        if (!this.initialized || !this.embedder || !this.store) {
            console.debug('[SessionEmbedder] Not initialized, cannot search');
            return [];
        }

        try {
            // Phase 1: Collect all distinct tags
            const allSessions = await chatDB.getAllSessions();
            const allTags = new Set();
            if (allSessions) {
                for (const session of allSessions) {
                    if (!Array.isArray(session.keywords)) continue;
                    for (const kw of session.keywords) {
                        const tag = typeof kw === 'string' ? kw.trim().toLowerCase() : '';
                        if (tag) allTags.add(tag);
                    }
                }
            }

            // Phase 2: LLM-based tag matching
            let matchedTags = [];
            if (allTags.size > 0) {
                try {
                    matchedTags = await this._matchTagsWithLLM(query, Array.from(allTags));
                } catch (error) {
                    console.warn('[SessionEmbedder] LLM tag matching failed:', error);
                    if (error.message?.includes('401') || error.message?.includes('403')) {
                        this._tinfoilKey = null;
                        this._tinfoilKeyInfo = null;
                    }
                }
            }

            // Phase 3: Embedding search with tag filter
            const t0 = performance.now();
            const queryEmbedding = await this.embedder.embedText(query);
            const t1 = performance.now();

            let embeddingResults;
            const matchedTagSet = new Set(matchedTags);

            if (matchedTagSet.size > 0) {
                // Filter vector search to sessions whose IndexedDB keywords overlap with matched tags
                const matchedSessionIds = new Set();
                if (allSessions) {
                    for (const session of allSessions) {
                        if (!session?.id || !Array.isArray(session.keywords)) continue;
                        const hasMatch = session.keywords.some(kw =>
                            matchedTagSet.has(typeof kw === 'string' ? kw.trim().toLowerCase() : '')
                        );
                        if (hasMatch) matchedSessionIds.add(session.id);
                    }
                }

                if (matchedSessionIds.size > 0) {
                    embeddingResults = await this.store.search(queryEmbedding, k, {
                        ...options,
                        filter: (metadata) => {
                            const sessionId = metadata?.sessionId;
                            return typeof sessionId === 'string' && matchedSessionIds.has(sessionId);
                        }
                    });
                } else {
                    // LLM matched tags but none map to sessions; fall back to pure embedding.
                    embeddingResults = await this.store.search(queryEmbedding, k, options);
                }
            } else {
                // Fallback: no tag matches — pure embedding search
                embeddingResults = await this.store.search(queryEmbedding, k, options);
            }

            const t2 = performance.now();
            const embedMs = t1 - t0;
            const retrievalMs = t2 - t1;
            this._searchTimings.push({ embedMs, retrievalMs, ts: Date.now() });

            const matchType = matchedTagSet.size > 0 ? 'tag+embedding' : 'embedding';
            console.log(`[SessionEmbedder] ${matchType} search — embed: ${embedMs.toFixed(2)}ms, retrieval: ${retrievalMs.toFixed(2)}ms, matched tags: ${JSON.stringify(matchedTags)}, results: ${embeddingResults.length}`);

            const sessionMap = await this._getSessionMapForResults(embeddingResults);

            return embeddingResults.map(r => {
                const keywords = this._getKeywordsForResult(r, sessionMap);
                const matchedSessionTags = matchedTags.filter(tag => keywords.includes(tag));
                return {
                    sessionId: r.metadata?.sessionId,
                    title: r.metadata?.title,
                    summary: r.metadata?.summary,
                    keywords,
                    matchedTags: matchedTags,
                    matchedSessionTags,
                    primaryMatchedTag: matchedSessionTags[0] || null,
                    conversationText: r.metadata?.conversationText,
                    messageCount: r.metadata?.messageCount,
                    model: r.metadata?.model,
                    embeddedAt: r.metadata?.embeddedAt,
                    updatedAt: r.metadata?.updatedAt,
                    score: r.score,
                    matchType
                };
            });

        } catch (error) {
            console.warn('[SessionEmbedder] Tag-boosted search failed, falling back to pure embedding:', error);
            return this.searchSessions(query, k, options);
        }
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
                queueLength: this.queue.length,
                isProcessing: this.processing,
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

            // Remove from queue if present
            const queueIndex = this.queue.indexOf(sessionId);
            if (queueIndex !== -1) {
                this.queue.splice(queueIndex, 1);
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
            this.queue = [];
            this.processing = false;
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
        this.queue = [];
        this.processing = false;

        if (this.store) {
            await this.store.close();
        }

        this.initialized = false;
    }

    /**
     * Build a map of sessionId -> session object for vector search results.
     * @param {Array} results
     * @returns {Promise<Map<string, Object|null>>}
     */
    async _getSessionMapForResults(results) {
        const ids = Array.from(new Set(
            (results || [])
                .map(r => r?.metadata?.sessionId)
                .filter(id => typeof id === 'string' && id.length > 0)
        ));

        if (ids.length === 0) {
            return new Map();
        }

        const entries = await Promise.all(ids.map(async (id) => {
            try {
                return [id, await chatDB.getSession(id)];
            } catch (error) {
                return [id, null];
            }
        }));

        return new Map(entries);
    }

    /**
     * Read keywords from IndexedDB session record, not vector metadata.
     * @param {Object} result
     * @param {Map<string, Object|null>} sessionMap
     * @returns {Array<string>}
     */
    _getKeywordsForResult(result, sessionMap) {
        const sessionId = result?.metadata?.sessionId;
        const session = typeof sessionId === 'string' ? sessionMap.get(sessionId) : null;
        return Array.isArray(session?.keywords) ? session.keywords : [];
    }
}

// Export singleton instance
const sessionEmbedder = new SessionEmbedder();
window.sessionEmbedder = sessionEmbedder; // Expose for console profiling
export default sessionEmbedder;

// Also export class for testing
export { SessionEmbedder };
