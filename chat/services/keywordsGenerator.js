/**
 * KeywordsGenerator - Generates summary and keywords for chat sessions.
 *
 * Uses the session's own OA API key to generate a concise summary and relevant keywords
 * for the conversation. This happens before the key expires, so no additional information
 * is leaked. The generated data is persisted locally for retrieval and filtering.
 *
 * Triggered automatically:
 * - After the last turn in a conversation (when user receives assistant response)
 * - After imports, forks, share imports, and regenerateResponse via the queue
 * - Only if session doesn't already have keywords/summary
 * - Uses the session's existing API key (no new key needed)
 * - Falls back to Tinfoil for keyless sessions (imports, expired keys)
 *
 * Generated data:
 * - summary: Concise 1-2 sentence summary of the conversation (replaces title)
 * - keywords: Array of exactly 3 relevant keywords for retrieval and grouping
 */
import inferenceService from './inference/inferenceService.js';
import { chatDB } from '../db.js';
import { localInferenceService } from '../../local_inference/index.js';
import ticketClient from './ticketClient.js';

const KEY_EXPIRY_THRESHOLD_MS = 2 * 60 * 1000; // Regenerate if key expires in less than 2 minutes
const TINFOIL_BASE_URL = 'https://inference.tinfoil.sh';
const TINFOIL_BACKEND_ID = 'tinfoil';
const TINFOIL_MODEL = 'llama3-3-70b';
const TINFOIL_KEY_TICKETS_REQUIRED = 2;
const KEYWORD_CHECK_INTERVAL_MS = 30 * 1000;
const KEYWORD_DELAY_MS = 500; // Delay between keyword generations

const KEYWORDS_GENERATION_PROMPT = `Analyze this conversation and generate:
1. A concise title about the main topic (max 50 chars, descriptive and specific - NOT meta descriptions like "Chat about X" or "Discussion on Y")
2. Exactly 3 broad, generic keywords for retrieval (high-level topics, not specific technical terms)

Format your response as JSON:
{
  "summary": "Main topic here",
  "keywords": ["keyword1", "keyword2", "keyword3"]
}

Good title examples: "Python API Integration", "React State Management", "Database Schema Design"
Bad title examples: "Chat about Python", "Discussion on React", "Conversation about databases"

Examples of good generic keywords: "programming", "data analysis", "web development", "debugging", "design", "business", "learning"
Examples of bad (too specific) keywords: "react-hooks", "tensorflow-2.0", "mongodb-atlas"

Conversation:`;

class KeywordsGenerator {
    constructor() {
        this.initialized = false;
        this.generationInProgress = new Set(); // Track sessions being processed
        this.queue = [];
        this.processing = false;
        this.checkInterval = null;
        this._tinfoilKey = null; // Cached confidential key
        this._tinfoilKeyInfo = null; // Key metadata (expiry, etc.)
    }

    /**
     * Initialize the generator.
     */
    async init() {
        this.initialized = true;
        this.startBackgroundCheck();
        this.scheduleBackfill();
        console.log('[KeywordsGenerator] Initialized');
    }

    /**
     * Schedule the backfill process to run when the browser is idle.
     */
    scheduleBackfill() {
        if (typeof requestIdleCallback === 'function') {
            requestIdleCallback(() => this.startBackfill(), { timeout: 10000 });
        } else {
            setTimeout(() => this.startBackfill(), 5000);
        }
    }

    /**
     * Scan all sessions and enqueue those missing keywords/summary.
     */
    async startBackfill() {
        try {
            const allSessions = await chatDB.getAllSessions();
            if (!allSessions || allSessions.length === 0) return;

            const needsKeywords = allSessions.filter(s =>
                !s.summary || !s.keywords || s.keywords.length === 0
            );

            if (needsKeywords.length === 0) {
                console.log('[KeywordsGenerator] All sessions already have keywords');
                return;
            }

            // Sort by updatedAt descending (most recently updated first)
            needsKeywords.sort((a, b) => {
                const aTime = a.updatedAt || a.createdAt || 0;
                const bTime = b.updatedAt || b.createdAt || 0;
                return bTime - aTime;
            });

            const ids = needsKeywords.map(s => s.id);
            this.enqueue(ids);
            console.log(`[KeywordsGenerator] Queued ${ids.length} sessions for keyword backfill`);
        } catch (error) {
            console.warn('[KeywordsGenerator] Backfill scan failed:', error);
        }
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
        }, KEYWORD_CHECK_INTERVAL_MS);
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
        this.processQueue();
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
        console.log(`[KeywordsGenerator] Enqueued ${sessionIds.length} imported sessions`);
    }

    /**
     * Unified queue processor. Tries OA-key generation first, falls back to
     * Tinfoil for keyless sessions.
     */
    async processQueue() {
        if (this.processing) return;

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

                    // Already has keywords — skip
                    if (session.summary && session.keywords && session.keywords.length > 0) {
                        this.queue.splice(idx, 1);
                        continue;
                    }

                    // Try OA key first
                    if (!inferenceService.isAccessExpired(session)) {
                        const token = inferenceService.getAccessToken(session);
                        if (token) {
                            const result = await this.generateForSession(sessionId);
                            const idx2 = this.queue.indexOf(sessionId);
                            if (idx2 !== -1) this.queue.splice(idx2, 1);
                            if (result) {
                                if (this.queue.length > 0) {
                                    await this._yieldDelay();
                                }
                                continue;
                            }
                        }
                    }

                    // Tinfoil fallback
                    const result = await this.generateWithTinfoil(sessionId);
                    const idx2 = this.queue.indexOf(sessionId);
                    if (idx2 !== -1) this.queue.splice(idx2, 1);

                    if (result) {
                        if (this.queue.length > 0) {
                            await this._yieldDelay();
                        }
                        continue;
                    }
                } catch (error) {
                    // Error — stop this cycle, retry on next timer tick
                    console.warn(`[KeywordsGenerator] Error processing session ${sessionId}:`, error);
                    break;
                }
            }
        } finally {
            this.processing = false;
        }
    }

    /**
     * Yield to the browser and delay between queue items.
     * @returns {Promise<void>}
     */
    _yieldDelay() {
        return new Promise(resolve => {
            if (typeof requestIdleCallback === 'function') {
                setTimeout(() => {
                    requestIdleCallback(resolve, { timeout: 10000 });
                }, KEYWORD_DELAY_MS);
            } else {
                setTimeout(resolve, KEYWORD_DELAY_MS);
            }
        });
    }

    /**
     * Check if a session needs keywords generation.
     * @param {Object} session - Session object
     * @param {number} currentMessageCount - Current number of messages in session
     * @returns {boolean} True if needs generation
     */
    needsGeneration(session, currentMessageCount = 0) {
        if (!session) return false;

        // Skip if generation is already in progress
        if (this.generationInProgress.has(session.id)) {
            return false;
        }

        // Skip if session has no messages (empty chat)
        // This will be checked when actually generating

        // Generate if session has never had keywords generated
        if (!session.summary || !session.keywords || session.keywords.length === 0) {
            return true;
        }

        // Check if API key is expiring soon (within 2 minutes)
        if (session.expiresAt) {
            const timeUntilExpiry = new Date(session.expiresAt) - Date.now();
            if (timeUntilExpiry > 0 && timeUntilExpiry <= KEY_EXPIRY_THRESHOLD_MS) {
                console.log(`[KeywordsGenerator] Regenerating keywords - key expires in ${Math.floor(timeUntilExpiry / 1000)}s`);
                return true;
            }
        }

        // Regenerate if conversation has grown significantly (10+ new messages)
        const messageCountAtGeneration = session.messageCountAtGeneration || 0;
        const newMessagesSinceGeneration = currentMessageCount - messageCountAtGeneration;
        if (newMessagesSinceGeneration >= 10) {
            console.log(`[KeywordsGenerator] Regenerating keywords - ${newMessagesSinceGeneration} new messages since last generation`);
            return true;
        }

        return false;
    }

    /**
     * Generate keywords and summary for a session.
     * Uses the session's own API key to make the LLM call.
     *
     * @param {string} sessionId - Session ID to generate keywords for
     * @param {Object} app - Optional reference to main app for in-memory state updates
     * @returns {Promise<Object|null>} Generated data { summary, keywords } or null on error
     */
    async generateForSession(sessionId, app = null) {
        if (!this.initialized) {
            await this.init();
        }

        // Get session from database
        const session = await chatDB.getSession(sessionId);
        if (!session) {
            console.warn('[KeywordsGenerator] Session not found:', sessionId);
            return null;
        }

        // Get messages to check count and validity
        const messages = await chatDB.getSessionMessages(sessionId);
        if (!messages || messages.length === 0) {
            console.log('[KeywordsGenerator] No messages in session:', sessionId);
            return null;
        }

        // Check if session API key is still valid
        if (inferenceService.isAccessExpired(session)) {
            console.log('[KeywordsGenerator] Session API key expired, skipping generation:', sessionId);
            return null;
        }

        // Check if generation is needed (pass message count for regeneration logic)
        const filteredMessages = messages.filter(msg => !msg.isLocalOnly);
        if (!this.needsGeneration(session, filteredMessages.length)) {
            console.log('[KeywordsGenerator] Session already has up-to-date keywords:', sessionId);
            return { summary: session.summary, keywords: session.keywords };
        }

        // Mark as in progress
        this.generationInProgress.add(sessionId);

        try {
            // filteredMessages already computed above
            if (filteredMessages.length === 0) {
                console.log('[KeywordsGenerator] No non-local messages in session:', sessionId);
                return null;
            }

            // Build conversation text (limit to last 10 messages to keep it concise)
            const recentMessages = filteredMessages.slice(-10);
            const conversationText = recentMessages
                .map(msg => {
                    const role = msg.role === 'user' ? 'User' : 'Assistant';
                    // Truncate very long messages
                    const content = msg.content.length > 500
                        ? msg.content.substring(0, 500) + '...'
                        : msg.content;
                    return `${role}: ${content}`;
                })
                .join('\n\n');

            // Check if session has valid API access
            if (inferenceService.isAccessExpired(session)) {
                console.warn('[KeywordsGenerator] Session API key expired:', sessionId);
                return null;
            }

            const token = inferenceService.getAccessToken(session);
            if (!token) {
                console.warn('[KeywordsGenerator] No API key for session:', sessionId);
                return null;
            }

            // Get model for generation (use a fast, cheap model)
            const modelId = this.getGenerationModel(session);

            // Build messages for generation
            const generationMessages = [
                {
                    role: 'user',
                    content: `${KEYWORDS_GENERATION_PROMPT}\n\n${conversationText}`
                }
            ];

            console.log('[KeywordsGenerator] Generating keywords for session:', sessionId);

            // Make the LLM call using the session's inference backend
            const backend = inferenceService.getBackendForSession(session);
            let fullResponse = '';

            // Use streaming to get the response
            await backend.streamCompletion(
                generationMessages,
                modelId,
                token,
                (chunk) => {
                    if (chunk) {
                        fullResponse += chunk;
                    }
                },
                null, // onTokenUpdate
                null, // files
                false, // searchEnabled
                null, // abortController
                null, // onReasoningChunk
                false // reasoningEnabled
            );

            return this._parseAndSave(fullResponse, session, filteredMessages.length, app);

        } catch (error) {
            console.error('[KeywordsGenerator] Error generating keywords:', error);
            return null;
        } finally {
            // Mark as complete
            this.generationInProgress.delete(sessionId);
        }
    }

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
     * Ensure a valid Tinfoil confidential key is available.
     * Acquires a new one via ticket redemption if needed.
     * @returns {Promise<string|null>} The API key, or null if unavailable
     */
    async _ensureTinfoilKey() {
        if (this._isTinfoilKeyValid()) {
            return this._tinfoilKey;
        }

        // Check ticket availability
        const ticketCount = ticketClient.getTicketCount();
        if (ticketCount < TINFOIL_KEY_TICKETS_REQUIRED) {
            console.log(`[KeywordsGenerator] Not enough tickets for Tinfoil key (need ${TINFOIL_KEY_TICKETS_REQUIRED}, have ${ticketCount})`);
            return null;
        }

        try {
            const keyData = await ticketClient.requestConfidentialApiKey('keywords', TINFOIL_KEY_TICKETS_REQUIRED);
            this._tinfoilKey = keyData.key;
            this._tinfoilKeyInfo = keyData;

            localInferenceService.configureBackend(TINFOIL_BACKEND_ID, {
                baseUrl: TINFOIL_BASE_URL,
                apiKey: keyData.key
            });

            console.log('[KeywordsGenerator] Acquired Tinfoil confidential key');
            return keyData.key;
        } catch (error) {
            console.warn('[KeywordsGenerator] Failed to acquire Tinfoil key:', error);
            return null;
        }
    }

    /**
     * Generate keywords and summary for a session using Tinfoil fallback.
     * Used for keyless sessions (imports, expired keys).
     *
     * @param {string} sessionId - Session ID to generate keywords for
     * @returns {Promise<Object|null>} Generated data { summary, keywords } or null on error
     */
    async generateWithTinfoil(sessionId) {
        // Get session from database
        const session = await chatDB.getSession(sessionId);
        if (!session) {
            console.warn('[KeywordsGenerator] Session not found:', sessionId);
            return null;
        }

        // Get messages
        const messages = await chatDB.getSessionMessages(sessionId);
        if (!messages || messages.length === 0) {
            console.log('[KeywordsGenerator] No messages in session:', sessionId);
            return null;
        }

        const filteredMessages = messages.filter(msg => !msg.isLocalOnly);
        if (filteredMessages.length === 0) {
            console.log('[KeywordsGenerator] No non-local messages in session:', sessionId);
            return null;
        }

        // Skip if already has keywords
        if (session.summary && session.keywords && session.keywords.length > 0) {
            return { summary: session.summary, keywords: session.keywords };
        }

        // Ensure we have a valid Tinfoil key
        const apiKey = await this._ensureTinfoilKey();
        if (!apiKey) {
            return null;
        }

        // Guard against concurrent generation
        if (this.generationInProgress.has(sessionId)) {
            return null;
        }
        this.generationInProgress.add(sessionId);

        try {
            // Build conversation text (same as generateForSession)
            const recentMessages = filteredMessages.slice(-10);
            const conversationText = recentMessages
                .map(msg => {
                    const role = msg.role === 'user' ? 'User' : 'Assistant';
                    const content = msg.content.length > 500
                        ? msg.content.substring(0, 500) + '...'
                        : msg.content;
                    return `${role}: ${content}`;
                })
                .join('\n\n');

            console.log('[KeywordsGenerator] Generating keywords via Tinfoil for session:', sessionId);

            const response = await localInferenceService.createResponse({
                model: TINFOIL_MODEL,
                input: [
                    {
                        role: 'user',
                        content: [
                            {
                                type: 'input_text',
                                text: `${KEYWORDS_GENERATION_PROMPT}\n\n${conversationText}`
                            }
                        ]
                    }
                ],
                max_output_tokens: 150,
                temperature: 0,
                stream: false
            }, { backendId: TINFOIL_BACKEND_ID });

            // Extract text from response (same structure as scrubber)
            const fullResponse = this._extractOutputText(response);
            if (!fullResponse) {
                console.warn('[KeywordsGenerator] Empty Tinfoil response for session:', sessionId);
                return null;
            }

            return this._parseAndSave(fullResponse, session, filteredMessages.length);

        } catch (error) {
            console.error('[KeywordsGenerator] Tinfoil generation error:', error);
            // Invalidate key on auth errors so next attempt re-acquires
            if (error.message?.includes('401') || error.message?.includes('403')) {
                this._tinfoilKey = null;
                this._tinfoilKeyInfo = null;
            }
            return null;
        } finally {
            this.generationInProgress.delete(sessionId);
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
     * Parse an LLM response and save keywords/summary to the session.
     * Shared by generateForSession and generateWithWebLLM.
     *
     * @param {string} fullResponse - Raw LLM response text
     * @param {Object} session - Session object (will be mutated and saved)
     * @param {number} messageCount - Number of non-local messages at generation time
     * @param {Object} app - Optional app reference for in-memory state updates
     * @returns {Object|null} { summary, keywords } or null on error
     */
    _parseAndSave(fullResponse, session, messageCount, app = null) {
        // Parse the JSON response
        let parsedData = null;
        try {
            // Try to extract JSON from the response (in case model adds extra text)
            const jsonMatch = fullResponse.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
                parsedData = JSON.parse(jsonMatch[0]);
            } else {
                parsedData = JSON.parse(fullResponse);
            }
        } catch (parseError) {
            console.error('[KeywordsGenerator] Failed to parse JSON response:', parseError);
            console.log('[KeywordsGenerator] Raw response:', fullResponse);

            // Fallback: try to extract manually
            parsedData = this.fallbackParse(fullResponse);
        }

        if (!parsedData || !parsedData.summary || !parsedData.keywords) {
            console.warn('[KeywordsGenerator] Invalid response format:', parsedData);
            return null;
        }

        // Validate and clean keywords
        const keywords = Array.isArray(parsedData.keywords)
            ? parsedData.keywords
                .filter(k => typeof k === 'string' && k.trim().length > 0)
                .map(k => k.trim().toLowerCase())
                .slice(0, 3) // Exactly 3 keywords
            : [];

        const summary = typeof parsedData.summary === 'string'
            ? parsedData.summary.trim().substring(0, 50) // Max 50 chars for title
            : null;

        if (!summary || keywords.length === 0) {
            console.warn('[KeywordsGenerator] Invalid parsed data:', { summary, keywords });
            return null;
        }

        // Save to session in database
        session.summary = summary;
        session.keywords = keywords;
        session.keywordsGeneratedAt = Date.now();
        session.messageCountAtGeneration = messageCount;
        chatDB.saveSession(session);

        // Update in-memory session in app state if app reference provided
        if (app && app.state && app.state.sessionsById) {
            const inMemorySession = app.state.sessionsById.get(session.id);
            if (inMemorySession) {
                inMemorySession.summary = summary;
                inMemorySession.keywords = keywords;
                inMemorySession.keywordsGeneratedAt = Date.now();
                inMemorySession.messageCountAtGeneration = messageCount;
            }
        }

        console.log('[KeywordsGenerator] Generated keywords:', { summary, keywords });

        return { summary, keywords };
    }

    /**
     * Fallback parser for when JSON parsing fails.
     * Tries to extract summary and keywords from free-form text.
     * @param {string} text - Response text
     * @returns {Object|null} Parsed data or null
     */
    fallbackParse(text) {
        try {
            const summaryMatch = text.match(/summary["\s:]+([^"\n]+)/i);
            const keywordsMatch = text.match(/keywords["\s:]+\[([^\]]+)\]/i);

            if (!summaryMatch || !keywordsMatch) {
                return null;
            }

            const summary = summaryMatch[1].trim().replace(/[",]/g, '');
            const keywordsStr = keywordsMatch[1];
            const keywords = keywordsStr
                .split(',')
                .map(k => k.trim().replace(/["\[\]]/g, ''))
                .filter(k => k.length > 0);

            return { summary, keywords };
        } catch (error) {
            console.error('[KeywordsGenerator] Fallback parse failed:', error);
            return null;
        }
    }

    /**
     * Get the model to use for keywords generation.
     * Uses a fast, cheap model to minimize cost.
     * @param {Object} session - Session object
     * @returns {string} Model ID
     */
    getGenerationModel(session) {
        // Use the session's current model or default to a fast model
        // In production, you might want to use a specific fast/cheap model
        const backend = inferenceService.getBackendForSession(session);

        // Prefer fast models for keyword generation
        const fastModels = [
            'openai/gpt-5.2-chat',
            'openai/gpt-5.1-chat',
            'openai/gpt-5-chat',
            'anthropic/claude-3-haiku',
            'google/gemini-flash-1.5'
        ];

        // Use the first available fast model, fallback to session's model
        // In real implementation, you'd check which models are available
        return fastModels[0]; // Default to GPT-5.2 Instant
    }

    /**
     * Trigger keywords generation for a session after message completion.
     * This is the main entry point called from the app after streaming finishes.
     * Also enqueues the session as a safety net for WebLLM fallback.
     *
     * @param {string} sessionId - Session ID
     * @param {Object} app - Reference to the main app instance for UI updates
     * @returns {Promise<void>}
     */
    async triggerGeneration(sessionId, app = null) {
        if (!sessionId) return;

        try {
            // Run generation in background (non-blocking)
            this.generateForSession(sessionId, app).then(result => {
                // If generation succeeded and app reference provided, update UI
                if (result && app && typeof app.renderSessions === 'function') {
                    app.renderSessions();
                }
            }).catch(error => {
                console.warn('[KeywordsGenerator] Background generation failed:', error);
            });

            // Also enqueue as safety net — if OA key fails, the queue
            // will catch it on the next cycle via WebLLM
            this.enqueue(sessionId);
        } catch (error) {
            console.error('[KeywordsGenerator] Error triggering generation:', error);
        }
    }

    /**
     * Get the current generation status.
     * @returns {Object} Status object
     */
    getStatus() {
        return {
            initialized: this.initialized,
            inProgress: Array.from(this.generationInProgress),
            queueLength: this.queue.length,
            processing: this.processing
        };
    }
}

// Export singleton instance
const keywordsGenerator = new KeywordsGenerator();
export default keywordsGenerator;
