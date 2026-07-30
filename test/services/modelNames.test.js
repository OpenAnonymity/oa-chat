import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveModelDisplayName } from '../../chat/services/modelNames.js';

test('adds the Anthropic prefix when the catalog omits it', () => {
    assert.equal(resolveModelDisplayName({
        modelId: 'anthropic/claude-opus-5',
        fallbackDisplayName: 'Claude Opus 5',
        providerDisplayName: 'Anthropic'
    }), 'Anthropic: Claude Opus 5');
});

test('preserves Anthropic names that already include the prefix', () => {
    assert.equal(resolveModelDisplayName({
        modelId: 'anthropic/claude-sonnet-5',
        fallbackDisplayName: 'Anthropic: Claude Sonnet 5',
        providerDisplayName: 'Anthropic'
    }), 'Anthropic: Claude Sonnet 5');
});

test('does not add an Anthropic prefix to other providers', () => {
    assert.equal(resolveModelDisplayName({
        modelId: 'x-ai/grok-5',
        fallbackDisplayName: 'xAI: Grok Latest',
        providerDisplayName: 'xAI'
    }), 'xAI: Grok Latest');
});
