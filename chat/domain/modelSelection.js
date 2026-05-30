export const DEFAULT_MODEL_NAME_ALIASES = new Map([
    ['OpenAI: GPT-5.3 Chat', 'OpenAI: GPT-5.3 Instant'],
    ['GPT-5.3 Chat', 'OpenAI: GPT-5.3 Instant'],
    ['OpenAI: GPT-5.2 Chat', 'OpenAI: GPT-5.2 Instant'],
    ['GPT-5.2 Chat', 'OpenAI: GPT-5.2 Instant'],
    ['OpenAI: GPT-5.1 Chat', 'OpenAI: GPT-5.1 Instant'],
    ['GPT-5.1 Chat', 'OpenAI: GPT-5.1 Instant'],
    ['OpenAI: GPT-5 Chat', 'OpenAI: GPT-5 Instant'],
    ['GPT-5 Chat', 'OpenAI: GPT-5 Instant']
]);

export function filterDisabledModels(models, disabledIds = []) {
    if (!Array.isArray(models) || models.length === 0) {
        return [];
    }

    const disabledSet = disabledIds instanceof Set
        ? disabledIds
        : new Set(disabledIds || []);
    if (disabledSet.size === 0) {
        return [...models];
    }

    return models.filter(model => model && !disabledSet.has(model.id));
}

export function getFallbackModelEntry(models, defaultModelId, preferredModelIds = []) {
    if (!Array.isArray(models) || models.length === 0) {
        return null;
    }

    const preferredIds = [];
    const seen = new Set();

    for (const modelId of [...(preferredModelIds || []), defaultModelId]) {
        if (typeof modelId !== 'string') continue;
        const normalizedId = modelId.trim();
        if (!normalizedId || seen.has(normalizedId)) continue;
        seen.add(normalizedId);
        preferredIds.push(normalizedId);
    }

    for (const modelId of preferredIds) {
        const model = models.find(entry => entry?.id === modelId);
        if (model) {
            return model;
        }
    }

    return models[0] || null;
}

export function normalizeModelName(modelIdOrName, options = {}) {
    if (!modelIdOrName) {
        return modelIdOrName;
    }

    const {
        aliases = DEFAULT_MODEL_NAME_ALIASES,
        getStandardizedModelDisplayName = () => null,
        getDisplayName = (modelId) => modelId
    } = options;

    const standardized = getStandardizedModelDisplayName(modelIdOrName);
    if (standardized) {
        return standardized;
    }

    if (modelIdOrName.includes('/')) {
        const displayName = getDisplayName(modelIdOrName, modelIdOrName);
        const standardizedDisplayName = getStandardizedModelDisplayName(displayName);
        return standardizedDisplayName || displayName;
    }

    if (aliases.has(modelIdOrName)) {
        return aliases.get(modelIdOrName);
    }

    return modelIdOrName;
}

export function upgradeDefaultModelPreference(normalizedModelName, previousDefaultModelName, defaultModelName) {
    if (!normalizedModelName) return normalizedModelName;
    const previousDefaultNames = Array.isArray(previousDefaultModelName)
        ? previousDefaultModelName
        : [previousDefaultModelName];
    if (previousDefaultNames.includes(normalizedModelName)) {
        return defaultModelName;
    }
    return normalizedModelName;
}

export function resolveDefaultModelPreferenceUpdate(options = {}) {
    const {
        storedModelPreference = null,
        pendingModelName = null,
        hasCurrentSession = false,
        normalizeModelName = (modelName) => modelName,
        upgradeDefaultModelPreference = (modelName) => modelName
    } = options;

    const normalizedStoredModelPreference = normalizeModelName(storedModelPreference);
    const upgradedStoredModelPreference = upgradeDefaultModelPreference(normalizedStoredModelPreference);
    const shouldSaveStoredPreference = !!upgradedStoredModelPreference &&
        upgradedStoredModelPreference !== storedModelPreference;

    let nextPendingModelName = pendingModelName;
    let pendingChanged = false;

    if (!hasCurrentSession && upgradedStoredModelPreference) {
        const normalizedPendingModelName = normalizeModelName(pendingModelName);
        const pendingTracksStoredDefault = !normalizedPendingModelName ||
            normalizedPendingModelName === normalizedStoredModelPreference ||
            normalizedPendingModelName === storedModelPreference;

        if (pendingTracksStoredDefault && normalizedPendingModelName !== upgradedStoredModelPreference) {
            nextPendingModelName = upgradedStoredModelPreference;
            pendingChanged = true;
        }
    }

    return {
        normalizedStoredModelPreference,
        upgradedStoredModelPreference,
        shouldSaveStoredPreference,
        nextPendingModelName,
        pendingChanged,
        changed: shouldSaveStoredPreference || pendingChanged
    };
}
