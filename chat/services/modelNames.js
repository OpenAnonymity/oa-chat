/**
 * Model Name Standardization Service
 *
 * Centralizes model-name cleanup and canonical display-name rules so UI labels
 * are consistent across:
 * - model catalog rendering
 * - optimistic streaming headers
 * - final persisted stream metadata
 *
 * Public API:
 * - standardizeModelDisplayName(modelReference, { displayNameOverrides })
 *   Returns a canonical display name when a rule matches, otherwise null.
 * - resolveModelDisplayName({ modelId, fallbackDisplayName, displayNameOverrides })
 *   Resolves the final display label to show in UI with safe fallback behavior.
 */

const GPT_CHAT_MODEL_ID_PATTERN = /^gpt-([a-z0-9.-]+)-chat(?:-\d{8})?$/i;
const GPT_CHAT_DISPLAY_NAME_PATTERN = /^(?:openai:\s*)?gpt[-\s]?([a-z0-9.-]+)\s+chat(?:\s+\d{8})?$/i;
const TRAILING_MODEL_DATE_DISPLAY_PATTERN = /\s+\(?(?:19|20)\d{6}\)?$/;
const TRAILING_MODEL_DATE_ID_PATTERN = /-(?:19|20)\d{6}$/;

function isNonEmptyString(value) {
    return typeof value === 'string' && value.trim().length > 0;
}

function isDisplayName(value) {
    return isNonEmptyString(value) && !value.includes('/');
}

function toModelIdWithoutRouting(modelReference) {
    if (!isNonEmptyString(modelReference)) return null;
    return modelReference.trim().split(':')[0];
}

function extractModelSlug(modelReference) {
    const baseModelId = toModelIdWithoutRouting(modelReference);
    if (!baseModelId) return null;
    const slashIndex = baseModelId.lastIndexOf('/');
    return slashIndex === -1 ? baseModelId : baseModelId.slice(slashIndex + 1);
}

function formatOpenAiInstantDisplayName(variant) {
    return `OpenAI: GPT-${variant} Instant`;
}

function stripTrailingModelDateDisplaySuffix(modelReference) {
    if (!isNonEmptyString(modelReference)) return modelReference;
    return modelReference.replace(TRAILING_MODEL_DATE_DISPLAY_PATTERN, '').trim();
}

function stripTrailingModelDateIdSuffix(modelReference) {
    if (!isNonEmptyString(modelReference)) return modelReference;

    const baseModelId = toModelIdWithoutRouting(modelReference);
    if (!baseModelId) return modelReference;

    const slashIndex = baseModelId.lastIndexOf('/');
    const prefix = slashIndex === -1 ? '' : `${baseModelId.slice(0, slashIndex + 1)}`;
    const modelSlug = slashIndex === -1 ? baseModelId : baseModelId.slice(slashIndex + 1);
    const strippedSlug = modelSlug.replace(TRAILING_MODEL_DATE_ID_PATTERN, '');

    if (strippedSlug === modelSlug) {
        return modelReference;
    }

    return `${prefix}${strippedSlug}`;
}

function tryDirectStandardization(modelReference, displayNameOverrides) {
    const baseModelId = toModelIdWithoutRouting(modelReference);
    if (baseModelId && isNonEmptyString(displayNameOverrides[baseModelId])) {
        return displayNameOverrides[baseModelId];
    }

    const modelSlug = extractModelSlug(modelReference);
    if (modelSlug) {
        const gptChatIdMatch = modelSlug.match(GPT_CHAT_MODEL_ID_PATTERN);
        if (gptChatIdMatch) {
            return formatOpenAiInstantDisplayName(gptChatIdMatch[1]);
        }
    }

    const gptChatDisplayMatch = modelReference.match(GPT_CHAT_DISPLAY_NAME_PATTERN);
    if (gptChatDisplayMatch) {
        return formatOpenAiInstantDisplayName(gptChatDisplayMatch[1]);
    }

    return null;
}

function getNextSimplifiedCandidate(modelReference) {
    const strippedId = stripTrailingModelDateIdSuffix(modelReference);
    if (strippedId !== modelReference) {
        return { candidate: strippedId, kind: 'id' };
    }

    if (!modelReference.includes('/')) {
        const strippedDisplay = stripTrailingModelDateDisplaySuffix(modelReference);
        if (strippedDisplay !== modelReference) {
            return { candidate: strippedDisplay, kind: 'display' };
        }
    }

    return null;
}

/**
 * Return a canonical display name when a known normalization rule applies.
 *
 * @param {string} modelReference
 * @param {{ displayNameOverrides?: Record<string, string> }} [options]
 * @returns {string|null}
 */
export function standardizeModelDisplayName(modelReference, options = {}) {
    if (!isNonEmptyString(modelReference)) return null;

    const displayNameOverrides = options.displayNameOverrides || {};
    let candidate = modelReference.trim();
    const visited = new Set();
    let simplifiedDisplayCandidate = null;

    while (candidate && !visited.has(candidate)) {
        visited.add(candidate);

        const directMatch = tryDirectStandardization(candidate, displayNameOverrides);
        if (directMatch) {
            return directMatch;
        }

        const next = getNextSimplifiedCandidate(candidate);
        if (!next) {
            break;
        }

        if (next.kind === 'display') {
            simplifiedDisplayCandidate = next.candidate;
        }

        candidate = next.candidate;
    }

    // For provider display labels that only need date stripping, return the
    // simplified display value even without a named override.
    return simplifiedDisplayCandidate;
}

/**
 * Resolve the final model display name for UI rendering.
 *
 * Behavior:
 * - Prefer standardizing `modelId` if that yields a display label.
 * - Otherwise try standardizing `fallbackDisplayName`.
 * - Then use explicit overrides by exact model ID.
 * - Finally return fallback as-is.
 *
 * @param {Object} params
 * @param {string} params.modelId
 * @param {string} params.fallbackDisplayName
 * @param {Record<string, string>} [params.displayNameOverrides]
 * @returns {string}
 */
export function resolveModelDisplayName({
    modelId,
    fallbackDisplayName,
    displayNameOverrides = {}
}) {
    const standardizedFromId = standardizeModelDisplayName(modelId, { displayNameOverrides });
    if (isDisplayName(standardizedFromId)) {
        return standardizedFromId;
    }

    const standardizedFromFallback = standardizeModelDisplayName(fallbackDisplayName, { displayNameOverrides });
    if (isDisplayName(standardizedFromFallback)) {
        return standardizedFromFallback;
    }

    if (isNonEmptyString(modelId) && isNonEmptyString(displayNameOverrides[modelId])) {
        return displayNameOverrides[modelId];
    }

    return fallbackDisplayName || modelId || '';
}
