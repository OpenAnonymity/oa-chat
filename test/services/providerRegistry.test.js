import test from 'node:test';
import assert from 'node:assert/strict';
import {
    resolveProvider,
    resolveProviderFromModelId
} from '../../chat/services/providerRegistry.js';

test('normalizes known OpenRouter author slugs', () => {
    assert.deepEqual(resolveProviderFromModelId('meta-llama/llama-4'), {
        slug: 'meta-llama',
        displayName: 'Meta'
    });
    assert.equal(resolveProviderFromModelId('openrouter/auto').displayName, 'OpenRouter');
    assert.equal(resolveProviderFromModelId('x-ai/grok-4').displayName, 'xAI');
});

test('latest aliases inherit the documented author provider', () => {
    assert.equal(
        resolveProviderFromModelId('~anthropic/claude-sonnet-latest').displayName,
        'Anthropic'
    );
});

test('unknown and malformed authors degrade to safe provider names', () => {
    assert.deepEqual(resolveProviderFromModelId('future-lab/model'), {
        slug: 'future-lab',
        displayName: 'Future Lab'
    });
    assert.deepEqual(resolveProviderFromModelId('~/broken'), {
        slug: null,
        displayName: 'Unknown'
    });
    assert.deepEqual(resolveProviderFromModelId('~Anthropic/claude-sonnet-latest'), {
        slug: null,
        displayName: 'Unknown'
    });
    assert.deepEqual(resolveProvider(''), {
        slug: null,
        displayName: 'Unknown'
    });
});
