/**
 * Model Tiers Service
 * Maps AI models to ticket costs for the inference ticket system.
 *
 * TIER STRUCTURE:
 * - Tier 1 (1 ticket): Instant/small models - fast, affordable
 * - Tier 2 (2 tickets): Standard thinking models - reasoning enabled
 * - Tier 3 (3 tickets): Premium models - large/image generation
 * - Tier 4 (10 tickets): Pro models - highest capability
 *
 * To update tiers, edit the TIERED_MODELS object below.
 */

// Ticket cost constants
export const TIER_INSTANT = 1;
export const TIER_THINKING = 2;
export const TIER_PREMIUM = 3;
export const TIER_PRO = 10;

/**
 * Explicit model-to-tier mappings.
 * Key: model ID (e.g., "openai/gpt-5.2-chat")
 * Value: ticket cost
 *
 * Models not in this list use pattern-based fallback logic.
 */
const TIERED_MODELS = {
    // ═══════════════════════════════════════════════════════════════════
    // TIER 1: Instant Models (1 ticket)
    // Fast, non-thinking models for quick responses
    // ═══════════════════════════════════════════════════════════════════

    // OpenAI Instant (non-thinking)
    'openai/gpt-5.2-chat': TIER_INSTANT,
    'openai/gpt-5.1-chat': TIER_INSTANT,
    'openai/gpt-5-chat': TIER_INSTANT,
    'openai/gpt-4.1': TIER_INSTANT,
    'openai/gpt-4.1-mini': TIER_INSTANT,
    'openai/gpt-4.1-nano': TIER_INSTANT,
    'openai/gpt-4o': TIER_INSTANT,
    'openai/gpt-4o-mini': TIER_INSTANT,
    'openai/chatgpt-4o-latest': TIER_INSTANT,

    // Anthropic Instant (non-thinking)
    'anthropic/claude-3.5-haiku': TIER_INSTANT,
    'anthropic/claude-3-haiku': TIER_INSTANT,

    // Google Flash models
    'google/gemini-2.5-flash-preview': TIER_INSTANT,
    'google/gemini-2.5-flash-preview-05-20': TIER_INSTANT,
    'google/gemini-2.0-flash-001': TIER_INSTANT,
    'google/gemini-2.0-flash-lite-001': TIER_INSTANT,
    'google/gemini-flash-1.5': TIER_INSTANT,
    'google/gemini-flash-1.5-8b': TIER_INSTANT,

    // Other instant models
    'deepseek/deepseek-chat': TIER_INSTANT,
    'meta-llama/llama-3.3-70b-instruct': TIER_INSTANT,
    'meta-llama/llama-3.1-405b-instruct': TIER_INSTANT,
    'mistralai/mistral-large-2411': TIER_INSTANT,
    'mistralai/mistral-medium-3': TIER_INSTANT,
    'mistralai/mistral-small-3.1-24b-instruct': TIER_INSTANT,
    'qwen/qwen-2.5-72b-instruct': TIER_INSTANT,
    'qwen/qwen-turbo': TIER_INSTANT,

    // ═══════════════════════════════════════════════════════════════════
    // TIER 2: Standard Thinking Models (2 tickets)
    // Reasoning-enabled models with extended thinking
    // ═══════════════════════════════════════════════════════════════════

    // OpenAI Thinking models
    'openai/gpt-5.2': TIER_THINKING,
    'openai/gpt-5.1': TIER_THINKING,
    'openai/gpt-5': TIER_THINKING,
    'openai/o4-mini': TIER_THINKING,
    'openai/o3-mini': TIER_THINKING,
    'openai/o1': TIER_THINKING,
    'openai/o1-mini': TIER_THINKING,
    'openai/o1-preview': TIER_THINKING,

    // Anthropic Sonnet (with thinking capability)
    'anthropic/claude-sonnet-4': TIER_THINKING,
    'anthropic/claude-sonnet-4.5': TIER_THINKING,
    'anthropic/claude-3.5-sonnet': TIER_THINKING,
    'anthropic/claude-3.7-sonnet': TIER_THINKING,

    // Google Pro models
    'google/gemini-3-pro-preview': TIER_THINKING,
    'google/gemini-2.5-pro': TIER_THINKING,
    'google/gemini-2.5-pro-preview': TIER_THINKING,
    'google/gemini-2.5-pro-preview-05-06': TIER_THINKING,
    'google/gemini-pro-1.5': TIER_THINKING,

    // Google Flash Thinking
    'google/gemini-2.0-flash-thinking-exp': TIER_THINKING,
    'google/gemini-2.5-flash-preview-thinking': TIER_THINKING,

    // DeepSeek Reasoner
    'deepseek/deepseek-r1': TIER_THINKING,
    'deepseek/deepseek-reasoner': TIER_THINKING,

    // Qwen thinking models
    'qwen/qwq-32b': TIER_THINKING,
    'qwen/qwq-32b-preview': TIER_THINKING,

    // ═══════════════════════════════════════════════════════════════════
    // TIER 3: Premium Models (3 tickets)
    // Large models, image generation, specialized capabilities
    // ═══════════════════════════════════════════════════════════════════

    // Anthropic Opus (flagship)
    'anthropic/claude-opus-4': TIER_PREMIUM,
    'anthropic/claude-opus-4.1': TIER_PREMIUM,
    'anthropic/claude-opus-4.5': TIER_PREMIUM,
    'anthropic/claude-3-opus': TIER_PREMIUM,

    // Image generation models
    'google/gemini-3-pro-image-preview': TIER_PREMIUM,
    'google/gemini-2.5-flash-image-preview': TIER_PREMIUM,

    // ═══════════════════════════════════════════════════════════════════
    // TIER 4: Pro Models (10 tickets)
    // Highest capability, most expensive
    // ═══════════════════════════════════════════════════════════════════

    'openai/gpt-5.2-pro': TIER_PRO,
    'openai/gpt-5.1-pro': TIER_PRO,
    'openai/gpt-5-pro': TIER_PRO,
    'openai/o3-pro': TIER_PRO,
    'openai/o1-pro': TIER_PRO,
};

/**
 * Patterns for detecting model characteristics when not explicitly tiered.
 * Used for fallback pricing of models not in TIERED_MODELS.
 */
const INSTANT_PATTERNS = [
    /-chat$/,           // OpenAI chat variants (gpt-X-chat)
    /haiku/i,           // Anthropic Haiku
    /flash/i,           // Google Flash
    /mini/i,            // Mini variants
    /nano/i,            // Nano variants
    /lite/i,            // Lite variants
    /small/i,           // Small variants
    /turbo/i,           // Turbo variants
    /instruct/i,        // Instruct-tuned models
];

const THINKING_PATTERNS = [
    /^openai\/o[134]/,  // OpenAI o-series (o1, o3, o4)
    /thinking/i,        // Explicit thinking models
    /reasoner/i,        // Reasoner models
    /qwq/i,             // Qwen QwQ
    /r1/i,              // DeepSeek R1
    /-pro/i,            // Models that have "-pro" in the ID
];

const PREMIUM_PATTERNS = [
    /opus/i,            // Anthropic Opus
    /image/i,           // Image generation models
];

// Pro tier uses explicit mappings only - no patterns
// (e.g., "Gemini 3 Pro" is a standard model, not a Pro tier model)

/**
 * Get the ticket cost for a model.
 *
 * @param {string} modelId - The model ID (e.g., "openai/gpt-5.2-chat")
 * @param {boolean} reasoningEnabled - Whether extended thinking is enabled
 * @returns {number} Number of tickets required
 */
export function getTicketCost(modelId, reasoningEnabled = false) {
    if (!modelId) return TIER_INSTANT;

    // Strip :online suffix for pricing (web search doesn't change tier)
    const baseModelId = modelId.replace(/:online$/, '');

    // Check explicit tier mapping first
    if (baseModelId in TIERED_MODELS) {
        return TIERED_MODELS[baseModelId];
    }

    // Fallback: pattern-based detection for untiered models
    // Note: Pro tier uses explicit mappings only (no pattern fallback)

    // Check Premium patterns
    if (PREMIUM_PATTERNS.some(p => p.test(baseModelId))) {
        return TIER_PREMIUM;
    }

    // Check Thinking patterns
    if (THINKING_PATTERNS.some(p => p.test(baseModelId))) {
        return TIER_THINKING;
    }

    // Check Instant patterns
    if (INSTANT_PATTERNS.some(p => p.test(baseModelId))) {
        return TIER_INSTANT;
    }

    // Default fallback: use reasoning state
    // If thinking/reasoning is enabled, charge tier 2; otherwise tier 1
    return reasoningEnabled ? TIER_THINKING : TIER_INSTANT;
}

/**
 * Get display label for a tier cost.
 *
 * @param {number} cost - Ticket cost
 * @returns {string} Human-readable label
 */
export function getTierLabel(cost) {
    switch (cost) {
        case TIER_INSTANT: return '1 ticket';
        case TIER_THINKING: return '2 tickets';
        case TIER_PREMIUM: return '3 tickets';
        case TIER_PRO: return '10 tickets';
        default: return `${cost} ticket${cost !== 1 ? 's' : ''}`;
    }
}

/**
 * Check if user has enough tickets for a model.
 *
 * @param {number} availableTickets - Number of unused tickets
 * @param {string} modelId - The model ID
 * @param {boolean} reasoningEnabled - Whether extended thinking is enabled
 * @returns {boolean} True if user has enough tickets
 */
export function hasEnoughTickets(availableTickets, modelId, reasoningEnabled = false) {
    return availableTickets >= getTicketCost(modelId, reasoningEnabled);
}

