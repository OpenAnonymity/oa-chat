/**
 * Model Tiers Service
 * Maps AI models to ticket costs for the inference ticket system.
 * Fetches tiers from org API with localStorage caching.
 *
 * TIER STRUCTURE:
 * - Tier 1 (1 ticket): Instant/small models - fast, affordable
 * - Tier 2 (2 tickets): Standard thinking models - reasoning enabled
 * - Tier 3 (3 tickets): Premium models - large/image generation
 * - Tier 4 (10 tickets): Pro models - highest capability
 */

import { ORG_API_BASE } from '../config.js';

// Ticket cost constants
export const TIER_INSTANT = 1;
export const TIER_THINKING = 2;
export const TIER_PREMIUM = 3;
export const TIER_PRO = 10;

// Cache key
const CACHE_KEY = 'oa-model-tickets-cache';

// Event target for notifying listeners of updates
const eventTarget = new EventTarget();

/**
 * Model-to-tier mappings (populated from API, with pattern-based fallbacks).
 * Key: model ID (e.g., "openai/gpt-5.2-chat")
 * Value: ticket cost
 */
let modelTickets = {};

/**
 * Patterns for detecting model characteristics when not explicitly tiered.
 * Used for fallback pricing of models not in modelTickets.
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
];

const PREMIUM_PATTERNS = [
    /opus/i,            // Anthropic Opus
    /image/i,           // Image generation models
];

/**
 * Load cached data from localStorage.
 */
function loadCache() {
    try {
        const cache = localStorage.getItem(CACHE_KEY);
        if (cache) {
            const parsed = JSON.parse(cache);
            if (parsed.data && typeof parsed.data === 'object') {
                modelTickets = parsed.data;
            }
        }
    } catch (e) {
        console.warn('Failed to load model tiers cache:', e);
    }
}

/**
 * Save data to localStorage cache.
 */
function saveCache(data) {
    try {
        localStorage.setItem(CACHE_KEY, JSON.stringify({
            data,
            timestamp: Date.now()
        }));
    } catch (e) {
        console.warn('Failed to save model tiers cache:', e);
    }
}

/**
 * Fetch model tickets from API.
 * @returns {Promise<Object|null>} Model tickets map or null on error
 */
async function fetchModelTickets() {
    try {
        const response = await fetch(`${ORG_API_BASE}/chat/model-tickets`, { credentials: 'omit' });
        if (!response.ok) return null;
        return await response.json();
    } catch (e) {
        console.warn('Failed to fetch model tickets:', e);
        return null;
    }
}

/**
 * Initialize model tiers service.
 * Loads from cache immediately, then fetches fresh data in background.
 * Call this early in app init (non-blocking).
 */
export async function initModelTiers() {
    // Load cached data first (synchronous, fast)
    loadCache();

    // Fetch fresh data in background
    const ticketsData = await fetchModelTickets();

    if (ticketsData && typeof ticketsData === 'object') {
        modelTickets = ticketsData;
        saveCache(ticketsData);
        eventTarget.dispatchEvent(new CustomEvent('update'));
    }
}

/**
 * Add listener for model tiers updates.
 * @param {Function} callback - Called when tiers update
 * @returns {Function} Cleanup function to remove listener
 */
export function onModelTiersUpdate(callback) {
    eventTarget.addEventListener('update', callback);
    return () => eventTarget.removeEventListener('update', callback);
}

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

    // Check API-provided tier mapping first
    if (baseModelId in modelTickets) {
        return modelTickets[baseModelId];
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

// Load cache on module init (synchronous)
loadCache();
