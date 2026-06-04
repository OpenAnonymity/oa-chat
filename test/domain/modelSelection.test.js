import test from 'node:test';
import assert from 'node:assert/strict';
import {
    filterDisabledModels,
    getFallbackModelEntry,
    getConfiguredSecondaryModelNameForModels,
    getDefaultSecondaryModelNameForModels,
    normalizeModelName,
    resolveDefaultModelPreferenceUpdate,
    resolvePrimaryModelNameForModels,
    resolveSynthesisModelNameForModels,
    upgradeDefaultModelPreference,
    resolveSecondaryModelNameForModels
} from '../../chat/domain/modelSelection.js';

test('filterDisabledModels returns a copy and removes disabled ids', () => {
    const models = [
        { id: 'openai/a', name: 'A' },
        { id: 'openai/b', name: 'B' }
    ];

    assert.notEqual(filterDisabledModels(models), models);
    assert.deepEqual(filterDisabledModels(models, new Set(['openai/b'])), [
        { id: 'openai/a', name: 'A' }
    ]);
});

test('getFallbackModelEntry prefers pinned order before default id and first available model', () => {
    const models = [
        { id: 'openai/a', name: 'A' },
        { id: 'openai/b', name: 'B' }
    ];

    assert.deepEqual(
        getFallbackModelEntry(models, 'openai/a', ['missing', 'openai/b']),
        { id: 'openai/b', name: 'B' }
    );
    assert.deepEqual(getFallbackModelEntry(models, 'openai/b'), { id: 'openai/b', name: 'B' });
    assert.deepEqual(getFallbackModelEntry(models, 'missing'), { id: 'openai/a', name: 'A' });
    assert.equal(getFallbackModelEntry([], 'openai/a'), null);
});

test('normalizeModelName standardizes known names before aliases', () => {
    assert.equal(
        normalizeModelName('Raw Model', {
            getStandardizedModelDisplayName: (value) => value === 'Raw Model' ? 'Standard Model' : null
        }),
        'Standard Model'
    );
});

test('normalizeModelName maps legacy aliases', () => {
    assert.equal(normalizeModelName('GPT-5.3 Chat'), 'OpenAI: GPT-5.3 Instant');
    assert.equal(normalizeModelName('GPT-5.2 Chat'), 'OpenAI: GPT-5.2 Instant');
    assert.equal(normalizeModelName('Custom Model'), 'Custom Model');
});

test('normalizeModelName resolves ids through display-name provider and standardizer', () => {
    assert.equal(
        normalizeModelName('openai/gpt-x', {
            getDisplayName: () => 'Provider Raw Name',
            getStandardizedModelDisplayName: (value) => value === 'Provider Raw Name' ? 'Provider Standard Name' : null
        }),
        'Provider Standard Name'
    );
});

test('upgradeDefaultModelPreference upgrades configured previous defaults', () => {
    assert.equal(
        upgradeDefaultModelPreference(
            'OpenAI: GPT-5.2 Instant',
            ['OpenAI: GPT-5.2 Instant', 'OpenAI: GPT-5.1 Instant'],
            'OpenAI: GPT-5.3 Instant'
        ),
        'OpenAI: GPT-5.3 Instant'
    );
    assert.equal(
        upgradeDefaultModelPreference(
            'OpenAI: GPT-5.1 Instant',
            ['OpenAI: GPT-5.2 Instant', 'OpenAI: GPT-5.1 Instant'],
            'OpenAI: GPT-5.3 Instant'
        ),
        'OpenAI: GPT-5.3 Instant'
    );
    assert.equal(
        upgradeDefaultModelPreference('Anthropic: Claude', 'OpenAI: GPT-5.2 Instant', 'OpenAI: GPT-5.3 Instant'),
        'Anthropic: Claude'
    );
});

test('resolveDefaultModelPreferenceUpdate promotes pending old default after config refresh', () => {
    const update = resolveDefaultModelPreferenceUpdate({
        storedModelPreference: 'OpenAI: GPT-5.2 Instant',
        pendingModelName: 'OpenAI: GPT-5.2 Instant',
        hasCurrentSession: false,
        upgradeDefaultModelPreference: (modelName) => modelName === 'OpenAI: GPT-5.2 Instant'
            ? 'OpenAI: GPT-5.3 Instant'
            : modelName
    });

    assert.equal(update.shouldSaveStoredPreference, true);
    assert.equal(update.pendingChanged, true);
    assert.equal(update.nextPendingModelName, 'OpenAI: GPT-5.3 Instant');
    assert.equal(update.changed, true);
});

test('resolveDefaultModelPreferenceUpdate preserves active sessions and custom pending models', () => {
    const upgradeDefaultModelPreference = (modelName) => modelName === 'OpenAI: GPT-5.2 Instant'
        ? 'OpenAI: GPT-5.3 Instant'
        : modelName;

    assert.equal(
        resolveDefaultModelPreferenceUpdate({
            storedModelPreference: 'OpenAI: GPT-5.2 Instant',
            pendingModelName: 'OpenAI: GPT-5.2 Instant',
            hasCurrentSession: true,
            upgradeDefaultModelPreference
        }).pendingChanged,
        false
    );

    assert.equal(
        resolveDefaultModelPreferenceUpdate({
            storedModelPreference: 'OpenAI: GPT-5.2 Instant',
            pendingModelName: 'Anthropic: Claude',
            hasCurrentSession: false,
            upgradeDefaultModelPreference
        }).nextPendingModelName,
        'Anthropic: Claude'
    );
});

const models = [
    { id: 'openai/gpt', name: 'OpenAI: GPT', provider: 'OpenAI' },
    { id: 'anthropic/claude', name: 'Anthropic: Claude', provider: 'Anthropic' },
    { id: 'google/gemini', name: 'Google: Gemini', provider: 'Google' }
];

function normalizeCouncilModelName(modelName) {
    const aliases = {
        'openai/gpt': 'OpenAI: GPT',
        'anthropic/claude': 'Anthropic: Claude',
        'google/gemini': 'Google: Gemini'
    };
    return aliases[modelName] || modelName;
}

test('resolveSecondaryModelNameForModels maps configured model ids to display names', () => {
    assert.equal(
        resolveSecondaryModelNameForModels({
            models,
            primaryModelName: 'OpenAI: GPT',
            preferredModelName: 'anthropic/claude',
            normalizeModelName: normalizeCouncilModelName
        }),
        'Anthropic: Claude'
    );
});

test('resolveSecondaryModelNameForModels defaults to Gemini 3.5 Flash when available', () => {
    const fallbackModels = [
        { id: 'openai/gpt-oss-120b', name: 'OpenAI: GPT OSS 120B', provider: 'OpenAI' },
        { id: 'google/gemini-3.5-flash', name: 'Google: Gemini 3.5 Flash', provider: 'Google' },
        { id: 'anthropic/claude', name: 'Anthropic: Claude', provider: 'Anthropic' }
    ];

    assert.equal(
        resolveSecondaryModelNameForModels({
            models: fallbackModels,
            primaryModelName: 'OpenAI: GPT',
            preferredModelName: '',
            normalizeModelName: normalizeCouncilModelName
        }),
        'Google: Gemini 3.5 Flash'
    );
    assert.equal(
        getDefaultSecondaryModelNameForModels({
            models: fallbackModels,
            primaryModelName: 'OpenAI: GPT',
            normalizeModelName: normalizeCouncilModelName
        }),
        'Google: Gemini 3.5 Flash'
    );
    assert.equal(
        resolveSecondaryModelNameForModels({
            models: [
                { id: 'openai/gpt-oss-120b', name: 'OpenAI: GPT OSS 120B', provider: 'OpenAI' },
                { id: 'google/gemini-3-5-flash', name: 'Google: Gemini 3-5 Flash', provider: 'Google' }
            ],
            primaryModelName: 'OpenAI: GPT',
            preferredModelName: '',
            normalizeModelName: normalizeCouncilModelName
        }),
        'Google: Gemini 3-5 Flash'
    );
});

test('resolveSecondaryModelNameForModels falls back when Gemini 3.5 Flash is primary', () => {
    const fallbackModels = [
        { id: 'openai/gpt-oss-120b', name: 'OpenAI: GPT OSS 120B', provider: 'OpenAI' },
        { id: 'google/gemini-3.5-flash', name: 'Google: Gemini 3.5 Flash', provider: 'Google' }
    ];

    assert.equal(
        resolveSecondaryModelNameForModels({
            models: fallbackModels,
            primaryModelName: 'Google: Gemini 3.5 Flash',
            preferredModelName: '',
            normalizeModelName: normalizeCouncilModelName
        }),
        'OpenAI: GPT OSS 120B'
    );
});

test('resolveSecondaryModelNameForModels does not prefer Gemini 3.5 Flash variants', () => {
    const fallbackModels = [
        { id: 'openai/gpt-oss-120b', name: 'OpenAI: GPT OSS 120B', provider: 'OpenAI' },
        { id: 'google/gemini-3.5-flash-lite', name: 'Google: Gemini 3.5 Flash Lite', provider: 'Google' },
        { id: 'google/gemini-3.5-flash-preview', name: 'Google: Gemini 3.5 Flash Preview', provider: 'Google' }
    ];

    assert.equal(
        resolveSecondaryModelNameForModels({
            models: fallbackModels,
            primaryModelName: 'OpenAI: GPT',
            preferredModelName: '',
            normalizeModelName: normalizeCouncilModelName
        }),
        'OpenAI: GPT OSS 120B'
    );
});

test('getConfiguredSecondaryModelNameForModels skips primary model ids before selecting secondary', () => {
    assert.equal(
        getConfiguredSecondaryModelNameForModels({
            models,
            councilMembers: ['openai/gpt', 'anthropic/claude'],
            primaryModelName: 'OpenAI: GPT',
            normalizeModelName: normalizeCouncilModelName
        }),
        'anthropic/claude'
    );
});

test('getConfiguredSecondaryModelNameForModels skips stale configured members when models are loaded', () => {
    assert.equal(
        getConfiguredSecondaryModelNameForModels({
            models,
            councilMembers: ['Missing Model', 'anthropic/claude'],
            primaryModelName: 'OpenAI: GPT',
            normalizeModelName: normalizeCouncilModelName
        }),
        'anthropic/claude'
    );
});

test('resolvePrimaryModelNameForModels falls back when configured primary is stale', () => {
    assert.equal(
        resolvePrimaryModelNameForModels({
            models,
            preferredModelName: 'Missing Model',
            fallbackModelName: 'OpenAI: GPT',
            normalizeModelName: normalizeCouncilModelName
        }),
        'OpenAI: GPT'
    );
});

test('resolveSynthesisModelNameForModels maps ids and falls back to primary model', () => {
    assert.equal(
        resolveSynthesisModelNameForModels({
            models,
            preferredModelName: 'google/gemini',
            fallbackModelName: 'OpenAI: GPT',
            normalizeModelName: normalizeCouncilModelName
        }),
        'Google: Gemini'
    );

    assert.equal(
        resolveSynthesisModelNameForModels({
            models,
            preferredModelName: 'Missing Model',
            fallbackModelName: 'OpenAI: GPT',
            normalizeModelName: normalizeCouncilModelName
        }),
        'OpenAI: GPT'
    );
});
