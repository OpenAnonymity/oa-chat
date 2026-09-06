import test from 'node:test';
import assert from 'node:assert/strict';

const { loadModelCatalog, saveModelCatalog } = await import('../../chat/services/modelCatalogCache.js');

function installLocalStorage() {
    const store = new Map();
    globalThis.localStorage = {
        getItem: (key) => store.has(key) ? store.get(key) : null,
        setItem: (key, value) => store.set(key, String(value)),
        removeItem: (key) => store.delete(key),
        clear: () => store.clear()
    };
    return store;
}

test('model catalog cache trims display metadata on save and load', () => {
    installLocalStorage();

    const saved = saveModelCatalog('openrouter', [
        {
            id: ' baidu/ernie-4.5-vl-424b-a47b ',
            name: 'Baidu: ERNIE 4.5 VL 424B A47B ',
            provider: ' Baidu ',
            category: ' Other models ',
            categoryPriority: 5
        }
    ]);

    assert.equal(saved, true);
    assert.deepEqual(loadModelCatalog('openrouter'), [
        {
            id: 'baidu/ernie-4.5-vl-424b-a47b',
            name: 'Baidu: ERNIE 4.5 VL 424B A47B',
            provider: 'Baidu',
            category: 'Other models',
            categoryPriority: 5
        }
    ]);
});

test('model catalog cache trims stale cached display names on load', () => {
    const store = installLocalStorage();
    store.set('oa-model-catalog-cache-v1', JSON.stringify({
        version: 2,
        catalogs: {
            openrouter: {
                backendId: 'openrouter',
                updatedAt: 1,
                models: [
                    {
                        id: 'baidu/ernie-4.5-vl-424b-a47b',
                        name: 'Baidu: ERNIE 4.5 VL 424B A47B ',
                        provider: 'Baidu',
                        category: 'Other models',
                        categoryPriority: 5
                    }
                ]
            }
        }
    }));

    assert.equal(loadModelCatalog('openrouter')?.[0]?.name, 'Baidu: ERNIE 4.5 VL 424B A47B');
});

test('cache preserves provider output limits and pricing for budget-aware runtimes', () => {
    installLocalStorage();
    saveModelCatalog('test-runtime', [{
        id: 'provider/model',
        pricing: { prompt: '0.000002', completion: '0.00001' },
        top_provider: { max_completion_tokens: 128000 },
        context_length: 1000000
    }]);
    const [model] = loadModelCatalog('test-runtime');
    assert.equal(model.top_provider.max_completion_tokens, 128000);
    assert.equal(model.pricing.completion, '0.00001');
    assert.equal(model.context_length, 1000000);
});

test('catalogs cached before provider limits were retained are refreshed', () => {
    const store = installLocalStorage();
    store.set('oa-model-catalog-cache-v1', JSON.stringify({ version: 1, catalogs: { openrouter: { models: [{ id: 'old-model' }] } } }));
    assert.equal(loadModelCatalog('openrouter'), null);
});
