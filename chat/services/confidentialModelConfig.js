export const DEFAULT_MEMORY_AGENT_MODEL = 'gemma4-31b';
export const DEFAULT_SCRUBBER_MODEL = 'gpt-oss-120b';

export const ALLOWED_CONFIDENTIAL_MODELS = new Set([
    DEFAULT_MEMORY_AGENT_MODEL,
    DEFAULT_SCRUBBER_MODEL,
    'gpt-oss-safeguard-120b',
    'llama3-3-70b',
    'gemma4-31b'
]);

export const SLOW_CONFIDENTIAL_MODELS = new Set([
    'kimi-k2-5'
]);

export function isAllowedConfidentialModel(modelId) {
    return ALLOWED_CONFIDENTIAL_MODELS.has(String(modelId || '').trim());
}

export function isSlowConfidentialModel(modelId) {
    return SLOW_CONFIDENTIAL_MODELS.has(String(modelId || '').trim());
}
