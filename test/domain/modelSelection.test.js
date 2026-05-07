import test from 'node:test';
import assert from 'node:assert/strict';
import {
    filterDisabledModels,
    getFallbackModelEntry,
    normalizeModelName,
    upgradeDefaultModelPreference
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

test('getFallbackModelEntry prefers the default id and otherwise uses first available model', () => {
    const models = [
        { id: 'openai/a', name: 'A' },
        { id: 'openai/b', name: 'B' }
    ];

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

test('upgradeDefaultModelPreference only upgrades the previous default', () => {
    assert.equal(
        upgradeDefaultModelPreference('OpenAI: GPT-5.1 Instant', 'OpenAI: GPT-5.1 Instant', 'OpenAI: GPT-5.2 Instant'),
        'OpenAI: GPT-5.2 Instant'
    );
    assert.equal(
        upgradeDefaultModelPreference('Anthropic: Claude', 'OpenAI: GPT-5.1 Instant', 'OpenAI: GPT-5.2 Instant'),
        'Anthropic: Claude'
    );
});
