/**
 * Model Configuration Service
 * Centralized config for model picker - pinned models, blocked models, and defaults.
 * Stored in IndexedDB for persistence and accessible to Electron wrapper.
 */

// Default configuration - edit these arrays to customize
const DEFAULT_CONFIG = {
    pinnedModels: [
        'openai/gpt-5.2-chat',
        'openai/gpt-5.2',
        'anthropic/claude-sonnet-4.5',
        'anthropic/claude-opus-4.5',
        'google/gemini-3-pro-preview',
        'google/gemini-3-pro-image-preview',
        'google/gemini-2.5-flash-image-preview',
    ],
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
 * Load model config from database, falling back to defaults.
 * @returns {Promise<Object>} Config object with pinnedModels, blockedModels, defaultModelName
 */
export async function loadModelConfig() {
    // Check if chatDB is available and initialized
    if (typeof chatDB === 'undefined' || !chatDB.db) {
        return { ...DEFAULT_CONFIG };
    }
    try {
        const saved = await chatDB.getSetting(CONFIG_KEY);
        if (saved) {
            // Merge with defaults to ensure all keys exist
            return { ...DEFAULT_CONFIG, ...saved };
        }
    } catch (e) {
        console.warn('Failed to load model config:', e);
    }
    return { ...DEFAULT_CONFIG };
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
    return { ...DEFAULT_CONFIG };
}

