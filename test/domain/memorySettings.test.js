import test from 'node:test';
import assert from 'node:assert/strict';

let memorySettings;
try {
    memorySettings = await import('../../chat/domain/memorySettings.js');
} catch {
    memorySettings = {};
}

function getResolveMemoryFeatureState() {
    assert.equal(typeof memorySettings.resolveMemoryFeatureState, 'function');
    return memorySettings.resolveMemoryFeatureState;
}

function getResolveMemoryFeatureToggle() {
    assert.equal(typeof memorySettings.resolveMemoryFeatureToggle, 'function');
    return memorySettings.resolveMemoryFeatureToggle;
}

function getResolveImportedMemoryPreferences() {
    assert.equal(typeof memorySettings.resolveImportedMemoryPreferences, 'function');
    return memorySettings.resolveImportedMemoryPreferences;
}

test('an explicit saved memory opt-in preserves saved memory mode', () => {
    const resolveMemoryFeatureState = getResolveMemoryFeatureState();

    assert.deepEqual(resolveMemoryFeatureState({
        savedMemoryFeatureEnabled: true,
        savedMemoryMode: true
    }), {
        memoryFeatureEnabled: true,
        memoryMode: true,
        shouldPersistMemoryMode: false
    });
});

test('disabled memory feature forces chat mode and asks to persist the reset', () => {
    const resolveMemoryFeatureState = getResolveMemoryFeatureState();

    assert.deepEqual(resolveMemoryFeatureState({
        savedMemoryFeatureEnabled: false,
        savedMemoryMode: true
    }), {
        memoryFeatureEnabled: false,
        memoryMode: false,
        shouldPersistMemoryMode: true
    });
});

test('turning memory feature off clears active memory mode without restoring it on re-enable', () => {
    const resolveMemoryFeatureToggle = getResolveMemoryFeatureToggle();

    assert.deepEqual(resolveMemoryFeatureToggle({
        currentMemoryMode: true,
        nextMemoryFeatureEnabled: false
    }), {
        memoryFeatureEnabled: false,
        memoryMode: false,
        shouldPersistMemoryMode: true
    });

    assert.deepEqual(resolveMemoryFeatureToggle({
        currentMemoryMode: false,
        nextMemoryFeatureEnabled: true
    }), {
        memoryFeatureEnabled: true,
        memoryMode: false,
        shouldPersistMemoryMode: false
    });
});

test('import clamps memory mode against existing disabled memory feature', () => {
    const resolveImportedMemoryPreferences = getResolveImportedMemoryPreferences();

    assert.deepEqual(resolveImportedMemoryPreferences({
        preferences: { memoryMode: true },
        currentMemoryFeatureEnabled: false,
        currentMemoryMode: false
    }), {
        memoryFeatureEnabled: false,
        shouldApplyMemoryFeatureEnabled: false,
        memoryMode: false,
        shouldApplyMemoryMode: true
    });
});

test('importing disabled memory feature persists a memory mode reset even when backup omits mode', () => {
    const resolveImportedMemoryPreferences = getResolveImportedMemoryPreferences();

    assert.deepEqual(resolveImportedMemoryPreferences({
        preferences: { memoryFeatureEnabled: false },
        currentMemoryFeatureEnabled: true,
        currentMemoryMode: true
    }), {
        memoryFeatureEnabled: false,
        shouldApplyMemoryFeatureEnabled: true,
        memoryMode: false,
        shouldApplyMemoryMode: true
    });
});


test('memory defaults off for a new profile and clamps a legacy mode-only setting', () => {
    const resolve = getResolveMemoryFeatureState();
    assert.deepEqual(resolve(), { memoryFeatureEnabled: false, memoryMode: false, shouldPersistMemoryMode: false });
    assert.deepEqual(resolve({ savedMemoryMode: true }), { memoryFeatureEnabled: false, memoryMode: false, shouldPersistMemoryMode: true });
});

test('import without a feature opt-in keeps a fresh profile off', () => {
    const resolve = getResolveImportedMemoryPreferences();
    assert.deepEqual(resolve({ preferences: { memoryMode: true } }), {
        memoryFeatureEnabled: false, shouldApplyMemoryFeatureEnabled: false,
        memoryMode: false, shouldApplyMemoryMode: true
    });
    assert.equal(resolve({ preferences: {}, currentMemoryFeatureEnabled: true }).memoryFeatureEnabled, true);
    assert.equal(resolve({ preferences: { memoryFeatureEnabled: true } }).memoryFeatureEnabled, true);
});
