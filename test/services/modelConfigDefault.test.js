import test from 'node:test';
import assert from 'node:assert/strict';

function createMemoryStorage(initialValues = {}) {
    const values = new Map(Object.entries(initialValues));
    return {
        getItem(key) {
            return values.has(key) ? values.get(key) : null;
        },
        setItem(key, value) {
            values.set(key, String(value));
        }
    };
}

test('model config defaults to Auto Router', async () => {
    const originalLocalStorage = globalThis.localStorage;
    globalThis.localStorage = createMemoryStorage();

    try {
        const modelConfig = await import('../../chat/services/modelConfig.js');
        assert.equal(modelConfig.getDefaultModelId(), 'openrouter/auto');
        assert.equal(modelConfig.getDefaultModelName(), 'Auto Router');
        assert.equal(modelConfig.getPinnedModels()[0], 'openrouter/auto');
    } finally {
        if (originalLocalStorage === undefined) {
            delete globalThis.localStorage;
        } else {
            globalThis.localStorage = originalLocalStorage;
        }
    }
});

test('explicitly disabling Auto Router falls back to the first pinned model', async () => {
    const originalLocalStorage = globalThis.localStorage;
    globalThis.localStorage = createMemoryStorage({
        'oa-model-availability-cache': JSON.stringify({
            pinned_models: ['openai/gpt-5.3-chat'],
            disabled_models: ['openrouter/auto'],
            updated_at: 1
        })
    });

    try {
        const modelConfig = await import('../../chat/services/modelConfig.js?disabled-auto-router');
        assert.equal(modelConfig.getDefaultModelId(), 'openai/gpt-5.3-chat');
        assert.equal(modelConfig.getDefaultModelName(), 'OpenAI: GPT-5.3 Instant');
    } finally {
        if (originalLocalStorage === undefined) {
            delete globalThis.localStorage;
        } else {
            globalThis.localStorage = originalLocalStorage;
        }
    }
});
