import test from 'node:test';
import assert from 'node:assert/strict';
import {
    getProviderAsset,
    resolveProvider,
    resolveProviderFromModelId,
    resolveProviderFromModelReference,
    normalizeOpenRouterModelProviders
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

test('model references resolve only documented provider identities', () => {
    assert.deepEqual(resolveProviderFromModelReference('future-lab/llama-model'), {
        slug: 'future-lab',
        displayName: 'Future Lab'
    });
    assert.equal(resolveProviderFromModelReference('Anthropic: Claude Sonnet').displayName, 'Anthropic');
    assert.deepEqual(resolveProviderFromModelReference('llama-model'), {
        slug: null,
        displayName: 'Unknown'
    });
});

test('cached OpenRouter provider metadata is recomputed without mutation', () => {
    const cached = [
        { id: 'x-ai/grok-4', name: 'Grok 4', provider: 'X-ai', pricing: { prompt: '1' } },
        { id: 'z-ai/glm-5', name: 'GLM 5', provider: 'Z-ai' },
        { id: 'moonshotai/kimi', name: 'Kimi', provider: 'Moonshotai' },
        { id: 'amazon/nova', name: 'Nova', provider: 'Amazon' },
        { id: 'bytedance-seed/seed', name: 'Seed', provider: 'Bytedance-seed' }
    ];

    const normalized = normalizeOpenRouterModelProviders(cached);

    assert.deepEqual(normalized.map(model => model.provider), [
        'xAI', 'Z.ai', 'Moonshot AI', 'AWS', 'ByteDance'
    ]);
    assert.deepEqual(normalized[0].pricing, { prompt: '1' });
    assert.notStrictEqual(normalized[0], cached[0]);
    assert.equal(cached[0].provider, 'X-ai');
});

test('provider assets resolve only for registered provider identities', () => {
    const known = resolveProviderFromModelId('meta-llama/llama-4');
    assert.equal(getProviderAsset(known.displayName), 'img/meta.svg');

    const collidingUnknown = resolveProviderFromModelId('meta/model');
    assert.deepEqual(collidingUnknown, {
        slug: 'meta',
        displayName: 'Meta (meta)'
    });
    assert.equal(getProviderAsset(collidingUnknown.displayName), null);

    const ordinaryUnknown = resolveProviderFromModelId('future-lab/model');
    assert.equal(getProviderAsset(ordinaryUnknown.displayName), null);

    const malformed = resolveProviderFromModelId('~/broken');
    assert.equal(getProviderAsset(malformed.displayName), null);
});
