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

export function findModelByNameOrId(models = [], modelNameOrId = '', normalizeModelNameFn = null) {
    if (!modelNameOrId || !Array.isArray(models)) return null;
    const normalizedName = typeof normalizeModelNameFn === 'function'
        ? (normalizeModelNameFn(modelNameOrId) || modelNameOrId)
        : modelNameOrId;
    const lookupValues = [normalizedName, modelNameOrId]
        .map((value) => String(value || '').trim())
        .filter(Boolean);
    return models.find((model) => model?.name === normalizedName)
        || models.find((model) => model?.name === modelNameOrId)
        || models.find((model) => model?.id === modelNameOrId)
        || models.find((model) => model?.id === normalizedName)
        || models.find((model) => lookupValues.includes(String(model?.name || '').trim()))
        || models.find((model) => lookupValues.includes(String(model?.id || '').trim()))
        || null;
}

function modelName(model) {
    return String(model?.name || '').trim();
}

function normalizeCompactModelLabel(label = '') {
    return String(label || '')
        .replace(/\s+/g, ' ')
        .replace(/\s+-\s*$/g, '')
        .replace(/-\s*$/g, '')
        .replace(/\(\s*\)/g, '')
        .trim();
}

function removeProviderPrefix(modelName = '') {
    const originalName = String(modelName || '').trim();
    if (!originalName) return '';
    return originalName.includes(': ')
        ? originalName.split(': ').slice(1).join(': ')
        : originalName;
}

export function getProviderlessModelDisplayName(modelName = '') {
    return normalizeCompactModelLabel(removeProviderPrefix(modelName));
}

export function getComposerModelDisplayName(modelName = '') {
    return getProviderlessModelDisplayName(modelName);
}

export function getConfiguredSecondaryModelNameForModels({
    models = [],
    councilMembers = [],
    primaryModelName = '',
    normalizeModelName = null
} = {}) {
    const hasLoadedModels = Array.isArray(models) && models.length > 0;
    const validMembers = (Array.isArray(councilMembers) ? councilMembers : []).reduce((members, memberName) => {
        if (!memberName) return members;
        const modelEntry = findModelByNameOrId(models, memberName, normalizeModelName);
        if (hasLoadedModels && !modelEntry) return members;
        members.push(modelName(modelEntry) || String(memberName).trim());
        return members;
    }, []);

    if (validMembers.length >= 2) {
        return validMembers[1];
    }
    if (validMembers.length === 1 && String(validMembers[0]).trim() !== String(primaryModelName || '').trim()) {
        return validMembers[0];
    }
    return '';
}

function isPreferredSecondaryModel(model) {
    const id = String(model?.id || '').trim().toLowerCase();
    const name = String(model?.name || '').trim().toLowerCase();
    const provider = String(model?.provider || '').trim().toLowerCase();
    return id === 'google/gemini-3.5-flash'
        || id === 'google/gemini-3-5-flash'
        || (provider === 'google' && name === 'gemini 3.5 flash')
        || name === 'google: gemini 3.5 flash';
}

export function getDefaultSecondaryModelNameForModels({
    models = [],
    primaryModelName = '',
    normalizeModelName = null
} = {}) {
    const primaryEntry = findModelByNameOrId(models, primaryModelName, normalizeModelName);
    const availableModels = Array.isArray(models)
        ? models.filter((model) => model?.name)
        : [];
    if (availableModels.length === 0) {
        return '';
    }
    const nonPrimaryModels = availableModels.filter((model) => {
        if (primaryEntry?.id && model.id === primaryEntry.id) return false;
        return modelName(model) !== String(primaryModelName || '').trim();
    });

    const preferredModel = nonPrimaryModels.find((model) => {
        if (!isPreferredSecondaryModel(model)) return false;
        return !primaryEntry || model.id !== primaryEntry.id;
    });

    return modelName(preferredModel) || modelName(nonPrimaryModels[0]) || modelName(availableModels[0]) || '';
}

export function resolveSecondaryModelNameForModels({
    models = [],
    primaryModelName = '',
    preferredModelName = '',
    normalizeModelName = null
} = {}) {
    const availableModels = Array.isArray(models)
        ? models.filter((model) => model?.name)
        : [];
    const preferredMatch = preferredModelName
        ? findModelByNameOrId(availableModels, preferredModelName, normalizeModelName)
        : null;
    return modelName(preferredMatch) || getDefaultSecondaryModelNameForModels({
        models,
        primaryModelName,
        normalizeModelName
    });
}

export function resolvePrimaryModelNameForModels({
    models = [],
    preferredModelName = '',
    fallbackModelName = '',
    normalizeModelName = null
} = {}) {
    const availableModels = Array.isArray(models)
        ? models.filter((model) => model?.name)
        : [];
    if (availableModels.length === 0) {
        return preferredModelName || fallbackModelName || '';
    }

    const preferredMatch = preferredModelName
        ? findModelByNameOrId(availableModels, preferredModelName, normalizeModelName)
        : null;
    const fallbackMatch = fallbackModelName
        ? findModelByNameOrId(availableModels, fallbackModelName, normalizeModelName)
        : null;
    return modelName(preferredMatch) || modelName(fallbackMatch) || modelName(availableModels[0]) || '';
}

export function resolveSynthesisModelNameForModels({
    models = [],
    preferredModelName = '',
    fallbackModelName = '',
    normalizeModelName = null
} = {}) {
    const availableModels = Array.isArray(models)
        ? models.filter((model) => model?.name)
        : [];
    if (availableModels.length === 0) {
        return preferredModelName || fallbackModelName || '';
    }

    const preferredMatch = preferredModelName
        ? findModelByNameOrId(availableModels, preferredModelName, normalizeModelName)
        : null;
    const fallbackMatch = fallbackModelName
        ? findModelByNameOrId(availableModels, fallbackModelName, normalizeModelName)
        : null;
    return modelName(preferredMatch) || modelName(fallbackMatch) || modelName(availableModels[0]) || '';
}
