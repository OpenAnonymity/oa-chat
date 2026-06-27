export function resolveMemoryFeatureState(options = {}) {
    const {
        savedMemoryFeatureEnabled,
        savedMemoryMode
    } = options;

    const memoryFeatureEnabled = savedMemoryFeatureEnabled !== false;
    const savedMemoryModeEnabled = savedMemoryMode === true;
    const memoryMode = memoryFeatureEnabled && savedMemoryModeEnabled;

    return {
        memoryFeatureEnabled,
        memoryMode,
        shouldPersistMemoryMode: savedMemoryModeEnabled && !memoryMode
    };
}

export function resolveMemoryFeatureToggle(options = {}) {
    const {
        currentMemoryMode,
        nextMemoryFeatureEnabled
    } = options;

    const memoryFeatureEnabled = nextMemoryFeatureEnabled === true;
    const currentMemoryModeEnabled = currentMemoryMode === true;
    const memoryMode = memoryFeatureEnabled && currentMemoryModeEnabled;

    return {
        memoryFeatureEnabled,
        memoryMode,
        shouldPersistMemoryMode: currentMemoryModeEnabled && !memoryMode
    };
}

export function resolveImportedMemoryPreferences(options = {}) {
    const {
        preferences = {},
        currentMemoryFeatureEnabled = true,
        currentMemoryMode = false
    } = options;

    const hasMemoryFeatureEnabled = Object.prototype.hasOwnProperty.call(preferences, 'memoryFeatureEnabled');
    const hasMemoryMode = Object.prototype.hasOwnProperty.call(preferences, 'memoryMode');
    const memoryFeatureEnabled = hasMemoryFeatureEnabled
        ? preferences.memoryFeatureEnabled !== false
        : currentMemoryFeatureEnabled !== false;
    const requestedMemoryMode = hasMemoryMode
        ? preferences.memoryMode === true
        : currentMemoryMode === true;
    const memoryMode = memoryFeatureEnabled && requestedMemoryMode;

    return {
        memoryFeatureEnabled,
        shouldApplyMemoryFeatureEnabled: hasMemoryFeatureEnabled,
        memoryMode,
        shouldApplyMemoryMode: hasMemoryMode || requestedMemoryMode !== memoryMode
    };
}
