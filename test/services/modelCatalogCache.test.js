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
        version: 1,
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
