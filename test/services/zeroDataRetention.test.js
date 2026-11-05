import test, { describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
    applyZeroDataRetention,
    parseZdrEndpoints,
    providerSlugForEndpoint,
    zeroDataRetention,
    ZdrUnavailableError
} from '../../chat/services/zeroDataRetention.js';

const browserKeys = ['window', 'location', 'localStorage', 'sessionStorage', 'document'];
function installBrowser() {
    const original = new Map(browserKeys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    const location = { hostname: 'localhost', origin: 'http://localhost', search: '', href: 'http://localhost/' };
    const window = { location, addEventListener() {}, removeEventListener() {} };
    const values = {
        window, location,
        localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
        sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
        document: {
            querySelector: () => null, getElementById: () => null, addEventListener() {},
            documentElement: { classList: { contains: () => false } }
        }
    };
    for (const [key, value] of Object.entries(values)) {
        Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    }
    return () => {
        for (const [key, descriptor] of original) {
            if (descriptor) Object.defineProperty(globalThis, key, descriptor);
            else delete globalThis[key];
        }
    };
}

const restoreImportGlobals = installBrowser();
const { OpenRouterAPI } = await import('../../chat/publicInferenceApi.js');
restoreImportGlobals();

const LIST = {
    data: [
        { model_id: 'anthropic/claude-sonnet-5.5', provider_name: 'Amazon Bedrock', tag: 'amazon-bedrock/us-east-1', safety_retention: false },
        { model_id: 'anthropic/claude-sonnet-5.5', provider_name: 'Amazon Bedrock', tag: 'amazon-bedrock/us-west-2', safety_retention: false },
        { model_id: 'anthropic/claude-sonnet-5.5', provider_name: 'Google Vertex', tag: 'google-vertex', safety_retention: false },
        { model_id: 'anthropic/claude-sonnet-5.5', provider_name: 'Anthropic', tag: 'anthropic', safety_retention: true },
        { model_id: 'google/gemini-3.5-pro', provider_name: 'Google AI Studio', tag: 'google-ai-studio', safety_retention: true },
        { model_id: 'deepseek/deepseek-v4.1-flash', provider_name: 'DeepInfra', tag: 'deepinfra/fp8' },
        { model_id: 'openai/gpt-6.1-sol', provider_name: 'Azure', tag: 'azure', safety_retention: false }
    ]
};

describe('parseZdrEndpoints', () => {
    test('keeps only endpoints that state no safety retention, one slug per provider', () => {
        const catalog = parseZdrEndpoints(LIST);
        assert.deepEqual(catalog.get('anthropic/claude-sonnet-5.5'), ['amazon-bedrock', 'google-vertex']);
        assert.deepEqual(catalog.get('openai/gpt-6.1-sol'), ['azure']);
        assert.equal(catalog.has('google/gemini-3.5-pro'), false, 'safety retention endpoints are excluded');
        assert.equal(catalog.has('deepseek/deepseek-v4.1-flash'), false, 'a missing safety_retention field is treated as retention');
    });

    test('accepts a bare array and rejects an unknown shape', () => {
        assert.equal(parseZdrEndpoints(LIST.data).size, 2);
        assert.throws(() => parseZdrEndpoints({ endpoints: 'nope' }), /Invalid zero data retention/);
    });

    test('provider slug comes from the tag, then the display name', () => {
        assert.equal(providerSlugForEndpoint({ tag: 'Amazon-Bedrock/eu' }), 'amazon-bedrock');
        assert.equal(providerSlugForEndpoint({ provider_name: 'Azure' }), 'Azure');
        assert.equal(providerSlugForEndpoint({}), '');
    });
});

describe('applyZeroDataRetention', () => {
    const catalog = parseZdrEndpoints(LIST);

    test('leaves the body unchanged while switched off', () => {
        const body = { model: 'google/gemini-3.5-pro', messages: [] };
        assert.equal(applyZeroDataRetention(body, { enabled: false, catalog: null }), body);
    });

    test('pins the request to eligible providers and keeps other provider preferences', () => {
        const body = applyZeroDataRetention({
            model: 'anthropic/claude-sonnet-5.5:online',
            messages: [],
            models: ['google/gemini-3.5-pro'],
            provider: { sort: 'throughput' }
        }, { enabled: true, catalog });
        assert.deepEqual(body.provider, {
            sort: 'throughput', zdr: true, data_collection: 'deny', only: ['amazon-bedrock', 'google-vertex']
        });
        assert.equal('models' in body, false, 'unchecked fallback models are removed');
    });

    test('narrows an existing provider allowlist and is idempotent', () => {
        const once = applyZeroDataRetention({ model: 'anthropic/claude-sonnet-5.5', provider: { only: ['Google-Vertex', 'anthropic'] } },
            { enabled: true, catalog });
        assert.deepEqual(once.provider.only, ['google-vertex']);
        assert.deepEqual(applyZeroDataRetention(once, { enabled: true, catalog }).provider, once.provider);
    });

    test('fails closed without a list, for a model without providers, and for an empty intersection', () => {
        assert.throws(() => applyZeroDataRetention({ model: 'openai/gpt-6.1-sol' }, { enabled: true, catalog: null }),
            error => error instanceof ZdrUnavailableError && error.reason === 'catalog');
        assert.throws(() => applyZeroDataRetention({ model: 'google/gemini-3.5-pro' }, { enabled: true, catalog }),
            error => error instanceof ZdrUnavailableError && error.reason === 'model');
        assert.throws(() => applyZeroDataRetention({ model: 'openai/gpt-6.1-sol', provider: { only: ['openai'] } },
            { enabled: true, catalog }), ZdrUnavailableError);
    });
});

describe('request layer', () => {
    let restoreTestGlobals;
    beforeEach(async () => {
        restoreTestGlobals = installBrowser();
        zeroDataRetention.configure({ settingsStore: { saveSetting: async () => {}, getSetting: async () => undefined },
            fetchJson: async () => LIST });
        await zeroDataRetention.ensureCatalog({ force: true });
    });
    afterEach(async () => {
        await zeroDataRetention.setEnabled(false);
        restoreTestGlobals();
    });

    function recordingTransport() {
        const calls = [];
        return {
            calls,
            fetchWithRetryJson: async (url, init) => {
                calls.push({ url, body: JSON.parse(init.body) });
                return { response: { ok: true, status: 200 }, data: { choices: [{ message: { content: 'Title' } }] } };
            }
        };
    }

    test('every OpenRouter body carries the restriction after product adapters run', async () => {
        await zeroDataRetention.setEnabled(true);
        const transport = recordingTransport();
        const api = new OpenRouterAPI({
            networkTransport: transport,
            acquireRequestAccess: async () => ({ baseUrl: 'https://openrouter.ai/api/v1', headers: {} }),
            // A composed adapter that tries to drop provider preferences.
            prepareRequestBody: body => ({ ...body, provider: undefined })
        });
        await api.sendCompletionStrict([{ role: 'user', content: 'idea' }], 'anthropic/claude-sonnet-5.5', 'key');
        assert.deepEqual(transport.calls[0].body.provider.only, ['amazon-bedrock', 'google-vertex']);
        assert.equal(transport.calls[0].body.provider.zdr, true);
    });

    test('a model without eligible providers is never sent', async () => {
        await zeroDataRetention.setEnabled(true);
        const transport = recordingTransport();
        const api = new OpenRouterAPI({
            networkTransport: transport,
            acquireRequestAccess: async () => ({ baseUrl: 'https://openrouter.ai/api/v1', headers: {} })
        });
        await assert.rejects(api.sendCompletionStrict([{ role: 'user', content: 'idea' }], 'google/gemini-3.5-pro', 'key'),
            ZdrUnavailableError);
        assert.equal(transport.calls.length, 0);
    });

    test('title generation is skipped, without acquiring access, when its model has no ZDR provider', async () => {
        await zeroDataRetention.setEnabled(true);
        let acquired = 0;
        const transport = recordingTransport();
        const api = new OpenRouterAPI({
            networkTransport: transport,
            acquireRequestAccess: async () => { acquired += 1; return { baseUrl: 'https://openrouter.ai/api/v1', headers: {} }; }
        });
        assert.equal(await api.generateSessionTitle('my research idea', 'key'), '');
        assert.equal(acquired, 0);
        assert.equal(transport.calls.length, 0);
    });

    test('requests are unchanged while switched off', async () => {
        const transport = recordingTransport();
        const api = new OpenRouterAPI({
            networkTransport: transport,
            acquireRequestAccess: async () => ({ baseUrl: 'https://openrouter.ai/api/v1', headers: {} })
        });
        await api.sendCompletionStrict([{ role: 'user', content: 'hi' }], 'google/gemini-3.5-pro', 'key');
        assert.equal(transport.calls[0].body.provider, undefined);
    });

    test('checkModel blocks before sending and ignores non-OpenRouter backends', async () => {
        await zeroDataRetention.setEnabled(true);
        assert.equal(await zeroDataRetention.checkModel('openai/gpt-6.1-sol'), null);
        assert.ok(await zeroDataRetention.checkModel('google/gemini-3.5-pro') instanceof ZdrUnavailableError);
        assert.equal(await zeroDataRetention.checkModel('google/gemini-3.5-pro', 'local-ollama'), null);
    });
});
