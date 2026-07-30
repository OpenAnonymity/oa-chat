import test from 'node:test';
import assert from 'node:assert/strict';
import { saveModelCatalog } from '../../chat/services/modelCatalogCache.js';

function createMemoryStorage() {
    const values = new Map();
    return {
        getItem(key) {
            return values.has(key) ? values.get(key) : null;
        },
        setItem(key, value) {
            values.set(key, String(value));
        }
    };
}

test('OpenRouter exposes cached provider metadata before a network refresh', async () => {
    const originalLocalStorage = globalThis.localStorage;
    const originalWindow = globalThis.window;
    globalThis.localStorage = createMemoryStorage();
    globalThis.window = {
        location: { hostname: 'localhost' }
    };

    try {
        const { default: openRouterAPI } = await import('../../chat/api.js');
        saveModelCatalog('openrouter', [{
            id: 'openrouter/auto',
            name: 'Auto Router',
            provider: 'Unknown',
            category: 'Other models',
            categoryPriority: 5
        }, {
            id: 'anthropic/claude-opus-5',
            name: 'Claude Opus 5',
            provider: 'Anthropic',
            category: 'Flagship models',
            categoryPriority: 1
        }]);

        assert.equal(typeof openRouterAPI.getCachedModels, 'function');
        assert.deepEqual(openRouterAPI.getCachedModels(), [{
            id: 'openrouter/auto',
            name: 'Auto Router',
            provider: 'OpenRouter',
            category: 'Other models',
            categoryPriority: 5
        }, {
            id: 'anthropic/claude-opus-5',
            name: 'Anthropic: Claude Opus 5',
            provider: 'Anthropic',
            category: 'Flagship models',
            categoryPriority: 1
        }]);
    } finally {
        if (originalLocalStorage === undefined) {
            delete globalThis.localStorage;
        } else {
            globalThis.localStorage = originalLocalStorage;
        }
        if (originalWindow === undefined) {
            delete globalThis.window;
        } else {
            globalThis.window = originalWindow;
        }
    }
});
