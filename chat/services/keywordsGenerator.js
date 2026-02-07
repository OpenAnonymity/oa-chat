/**
 * KeywordsGenerator - Generates summary and keywords for chat sessions.
 *
 * Uses the session's own OA API key to generate a concise summary and relevant keywords
 * for the conversation. This happens before the key expires, so no additional information
 * is leaked. The generated data is persisted locally for retrieval and filtering.
 *
 * Triggered automatically:
 * - After the last turn in a conversation (when user receives assistant response)
 * - Only if session doesn't already have keywords/summary
 * - Uses the session's existing API key (no new key needed)
 *
 * Generated data:
 * - summary: Concise 1-2 sentence summary of the conversation (replaces title)
 * - keywords: Array of exactly 3 relevant keywords for retrieval and grouping
 */
import inferenceService from './inference/inferenceService.js';
import { chatDB } from '../db.js';

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
    }

    /**
     * Initialize the generator.
     */
    async init() {
        this.initialized = true;
        console.log('[KeywordsGenerator] Initialized');
    }

    /**
     * Check if a session needs keywords generation.
     * @param {Object} session - Session object
     * @returns {boolean} True if needs generation
     */
    needsGeneration(session) {
        if (!session) return false;
        
        // Skip if already has both summary and keywords
        if (session.summary && session.keywords && session.keywords.length > 0) {
            return false;
        }

        // Skip if generation is already in progress
        if (this.generationInProgress.has(session.id)) {
            return false;
        }

        // Skip if session has no messages (empty chat)
        // This will be checked when actually generating

        return true;
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

        // Check if generation is needed
        if (!this.needsGeneration(session)) {
            console.log('[KeywordsGenerator] Session already has keywords:', sessionId);
            return { summary: session.summary, keywords: session.keywords };
        }

        // Mark as in progress
        this.generationInProgress.add(sessionId);

        try {
            // Get messages for the session
            const messages = await chatDB.getSessionMessages(sessionId);
            if (!messages || messages.length === 0) {
                console.log('[KeywordsGenerator] No messages in session:', sessionId);
                return null;
            }

            // Filter out local-only messages
            const filteredMessages = messages.filter(msg => !msg.isLocalOnly);
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
            await chatDB.saveSession(session);

            // Update in-memory session in app state if app reference provided
            if (app && app.state && app.state.sessionsById) {
                const inMemorySession = app.state.sessionsById.get(sessionId);
                if (inMemorySession) {
                    inMemorySession.summary = summary;
                    inMemorySession.keywords = keywords;
                    inMemorySession.keywordsGeneratedAt = Date.now();
                }
            }

            console.log('[KeywordsGenerator] Generated keywords:', { summary, keywords });

            return { summary, keywords };

        } catch (error) {
            console.error('[KeywordsGenerator] Error generating keywords:', error);
            return null;
        } finally {
            // Mark as complete
            this.generationInProgress.delete(sessionId);
        }
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
            inProgress: Array.from(this.generationInProgress)
        };
    }
}

// Export singleton instance
const keywordsGenerator = new KeywordsGenerator();
export default keywordsGenerator;
