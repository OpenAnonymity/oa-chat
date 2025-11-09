/**
 * Provider Icons Module
 * Supports both inline SVG and image URLs for provider icons
 *
 * To add a new icon:
 * 1. Option A - Use an image URL (recommended):
 *    'ProviderName': { type: 'url', url: 'https://example.com/icon.png' }
 *
 * 2. Option B - Use inline SVG:
 *    'ProviderName': { type: 'svg', data: '<path d="..."/>' }
 *
 * 3. Option C - Download and use local file:
 *    'ProviderName': { type: 'url', url: '/path/to/icon.png' }
 */

// Icon configuration - easy to add new providers!
const PROVIDER_ICONS = {
    'OpenAI': {
        type: 'url',
        url: 'img/chatgpt.svg'
    },

    'Anthropic': {
        type: 'url',
        url: 'img/claude.svg'
    },

    'Google': {
        type: 'url',
        url: 'img/gemini.svg'
    },

    'Meta': {
        type: 'url',
        url: 'img/meta.svg'
    },

    'Mistral': {
        type: 'url',
        url: 'img/mistral.svg'
    },

    'DeepSeek': {
        type: 'url',
        url: 'img/deepseek.svg'
    },

    'Qwen': {
        type: 'url',
        url: 'img/qwen.svg'
    },

    'Cohere': {
        type: 'url',
        url: 'https://cohere.com/favicon.ico'
    },

    'Perplexity': {
        type: 'url',
        url: 'img/perplexity.png'
    },

    'OpenRouter': {
        type: 'url',
        url: 'https://openrouter.ai/favicon.ico'
    },

    'Nvidia': {
        type: 'url',
        url: 'img/nvidia.svg'
    }

    // Or use local files (download icons to img/ folder):
    // 'ProviderName': {
    //     type: 'url',
    //     url: 'img/provider-icon.png'
    // }
};

/**
 * Gets an icon for a provider
 * @param {string} provider - Provider name (e.g., "OpenAI", "Anthropic")
 * @param {string} classes - Optional CSS classes for the icon
 * @returns {Object} Object with html (icon HTML) and hasIcon (boolean)
 */
export function getProviderIcon(provider, classes = 'w-3.5 h-3.5') {
    const iconConfig = PROVIDER_ICONS[provider];

    if (!iconConfig) {
        // Fallback: return a generic icon with the first letter
        const initial = provider ? provider.charAt(0) : 'A';
        return {
            html: `<span class="text-[10px] font-semibold">${initial}</span>`,
            hasIcon: false
        };
    }

    // Handle SVG type
    if (iconConfig.type === 'svg') {
        return {
            html: `<svg class="${classes}" viewBox="0 0 24 24" fill="currentColor">
                ${iconConfig.data}
            </svg>`,
            hasIcon: true
        };
    }

    // Handle URL type (image)
    // Note: Don't invert - logos should remain as-is
    // Background color is handled by the parent container
    if (iconConfig.type === 'url') {
        return {
            html: `<img src="${iconConfig.url}" class="${classes}" alt="${provider}" />`,
            hasIcon: true
        };
    }

    // Fallback
    const initial = provider ? provider.charAt(0) : 'A';
    return {
        html: `<span class="text-[10px] font-semibold">${initial}</span>`,
        hasIcon: false
    };
}

