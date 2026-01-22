/**
 * Model Configuration Service
 * Centralized config for model picker - pinned models, blocked models, and defaults.
 * Pinned models are fetched from org API with localStorage caching.
 * Blocked models and other config stored in IndexedDB for persistence.
 */

import { ORG_API_BASE } from '../config.js';
import { chatDB } from '../db.js';

// Cache key for pinned models
const PINNED_CACHE_KEY = 'oa-pinned-models-cache';

// Event target for notifying listeners of updates
const eventTarget = new EventTarget();

// Pinned models list (populated from API)
let pinnedModels = [];

// Fallback pinned models (used when API is unavailable or returns empty)
const FALLBACK_PINNED_MODELS = [
    'openai/gpt-5.2-chat',
    'openai/gpt-5.2',
    'anthropic/claude-sonnet-4.5',
    'anthropic/claude-opus-4.5',
    'google/gemini-3-pro-preview',
    'google/gemini-3-pro-image-preview',
    'google/gemini-2.5-flash-image-preview',
];

// Default configuration
const DEFAULT_CONFIG = {
    blockedModels: [
        'openai/o4-mini-deep-research',
        'openai/o3-deep-research',
        'alibaba/tongyi-deepresearch-30b-a3b',
        'perplexity/sonar-deep-research',
    ],
    defaultModelId: 'openai/gpt-5.2-chat',      // API model identifier
    defaultModelName: 'OpenAI: GPT-5.2 Instant', // Display name in UI
    // Custom display name overrides (model ID -> display name)
    displayNameOverrides: {
        'openai/gpt-5.2-chat': 'OpenAI: GPT-5.2 Instant',
        'openai/gpt-5.1-chat': 'OpenAI: GPT-5.1 Instant',
        'openai/gpt-5-chat': 'OpenAI: GPT-5 Instant',
        'openai/gpt-5.2': 'OpenAI: GPT-5.2 Thinking',
        'openai/gpt-5.1': 'OpenAI: GPT-5.1 Thinking',
        'openai/gpt-5': 'OpenAI: GPT-5 Thinking',
    },
};

const CONFIG_KEY = 'modelPickerConfig';

/**
 * Load cached pinned models from localStorage.
 */
function loadPinnedCache() {
    try {
        const cache = localStorage.getItem(PINNED_CACHE_KEY);
        if (cache) {
            const parsed = JSON.parse(cache);
            if (parsed.pinned_models && Array.isArray(parsed.pinned_models)) {
                pinnedModels = parsed.pinned_models;
            }
        }
    } catch (e) {
        console.warn('Failed to load pinned models cache:', e);
    }
}

/**
 * Fetch pinned models from API.
 * @returns {Promise<Object|null>} Pinned models response or null on error
 */
async function fetchPinnedModels() {
    try {
        const response = await fetch(`${ORG_API_BASE}/chat/pinned-models`, { credentials: 'omit' });
        if (!response.ok) return null;
        return await response.json();
    } catch (e) {
        console.warn('Failed to fetch pinned models:', e);
        return null;
    }
}

/**
 * Initialize pinned models.
 * Loads from cache immediately, then fetches fresh data in background.
 * Call this early in app init (non-blocking).
 */
export async function initPinnedModels() {
    // Load cached data first (synchronous, fast)
    loadPinnedCache();

    // Fetch fresh data in background
    const data = await fetchPinnedModels();

    if (data && data.pinned_models) {
        pinnedModels = data.pinned_models;
        localStorage.setItem(PINNED_CACHE_KEY, JSON.stringify(data));
        eventTarget.dispatchEvent(new CustomEvent('update'));
    }
}

/**
 * Add listener for pinned models updates.
 * @param {Function} callback - Called when pinned models update
 * @returns {Function} Cleanup function to remove listener
 */
export function onPinnedModelsUpdate(callback) {
    eventTarget.addEventListener('update', callback);
    return () => eventTarget.removeEventListener('update', callback);
}

/**
 * Get pinned models with fallback.
 * Uses API data if available, otherwise falls back to hardcoded defaults.
 * @returns {string[]} Array of pinned model IDs
 */
export function getPinnedModels() {
    return pinnedModels.length > 0 ? pinnedModels : FALLBACK_PINNED_MODELS;
}

/**
 * Load model config from database, falling back to defaults.
 * @returns {Promise<Object>} Config object with pinnedModels, blockedModels, defaultModelName
 */
export async function loadModelConfig() {
    const baseConfig = { ...DEFAULT_CONFIG, pinnedModels: getPinnedModels() };

    // Check if chatDB is available and initialized
    if (typeof chatDB === 'undefined' || !chatDB.db) {
        return baseConfig;
    }
    try {
        const saved = await chatDB.getSetting(CONFIG_KEY);
        if (saved) {
            // Merge with defaults to ensure all keys exist
            // Note: pinnedModels from API takes precedence
            return { ...baseConfig, ...saved, pinnedModels: getPinnedModels() };
        }
    } catch (e) {
        console.warn('Failed to load model config:', e);
    }
    return baseConfig;
}

/**
 * Save model config to database.
 * @param {Object} config - Config object (partial or full)
 * @returns {Promise<void>}
 */
export async function saveModelConfig(config) {
    const current = await loadModelConfig();
    const merged = { ...current, ...config };
    await chatDB.saveSetting(CONFIG_KEY, merged);
}

/**
 * Get the default config (without database lookup).
 * Useful for initial render before async load completes.
 * @returns {Object}
 */
export function getDefaultModelConfig() {
    return { ...DEFAULT_CONFIG, pinnedModels: getPinnedModels() };
}

// Load cache on module init (synchronous)
loadPinnedCache();
