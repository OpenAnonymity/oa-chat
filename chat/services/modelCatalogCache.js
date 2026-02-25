/**
 * Model Catalog Cache
 *
 * Stores model catalogs per inference backend in a provider-agnostic format.
 * This cache is used as a fallback when a live model-list request fails.
 */

const CACHE_KEY = 'oa-model-catalog-cache-v1';
const CACHE_VERSION = 1;

function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isValidBackendId(backendId) {
    return typeof backendId === 'string' && backendId.trim().length > 0;
}

function sanitizeModel(model) {
    if (!isObject(model)) {
        return null;
    }

    const id = typeof model.id === 'string' ? model.id.trim() : '';
    if (!id) {
        return null;
    }

    const name = typeof model.name === 'string' && model.name.trim() ? model.name : id;
    const provider = typeof model.provider === 'string' && model.provider.trim()
        ? model.provider
        : 'Unknown';
    const category = typeof model.category === 'string' && model.category.trim()
        ? model.category
        : 'Other models';
    const categoryPriority = Number.isFinite(model.categoryPriority) ? model.categoryPriority : 5;

    const normalized = {
        id,
        name,
        category,
        categoryPriority,
        provider
    };

    if (Number.isFinite(model.context_length)) {
        normalized.context_length = model.context_length;
    }

    if (isObject(model.pricing)) {
        normalized.pricing = model.pricing;
    }

    return normalized;
}

function readCache() {
    try {
        const raw = localStorage.getItem(CACHE_KEY);
        if (!raw) {
            return { version: CACHE_VERSION, catalogs: {} };
        }

        const parsed = JSON.parse(raw);
        if (parsed?.version !== CACHE_VERSION || !isObject(parsed.catalogs)) {
            return { version: CACHE_VERSION, catalogs: {} };
        }

        return parsed;
    } catch (error) {
        console.warn('Failed to load model catalog cache:', error);
        return { version: CACHE_VERSION, catalogs: {} };
    }
}

function writeCache(cache) {
    try {
        localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
    } catch (error) {
        console.warn('Failed to save model catalog cache:', error);
    }
}

/**
 * Load cached models for a backend.
 * @param {string} backendId
 * @returns {Array|null}
 */
export function loadModelCatalog(backendId) {
    if (!isValidBackendId(backendId)) {
        return null;
    }

    const cache = readCache();
    const entry = cache.catalogs[backendId];
    if (!isObject(entry) || !Array.isArray(entry.models)) {
        return null;
    }

    const models = entry.models
        .map(sanitizeModel)
        .filter(Boolean);

    return models.length > 0 ? models : null;
}

/**
 * Save models for a backend.
 * @param {string} backendId
 * @param {Array} models
 * @returns {boolean} true when cache was updated
 */
export function saveModelCatalog(backendId, models) {
    if (!isValidBackendId(backendId) || !Array.isArray(models)) {
        return false;
    }

    const sanitizedModels = models
        .map(sanitizeModel)
        .filter(Boolean);

    if (sanitizedModels.length === 0) {
        return false;
    }

    const cache = readCache();
    cache.catalogs[backendId] = {
        backendId,
        updatedAt: Date.now(),
        models: sanitizedModels
    };
    writeCache(cache);
    return true;
}

