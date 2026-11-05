import test, { describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
    applyZeroDataRetention,
    parseZdrEndpoints,
    providerSlugForEndpoint,
    zeroDataRetention,
    ZeroDataRetentionState,
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
    test('a retaining or unknown region vetoes its provider in either row order', () => {
        for (const policy of [true, undefined, 'false']) {
            const entries = [
                { model_id: 'test/model', tag: 'example/clean', safety_retention: false },
                { model_id: 'test/model', tag: 'example/other', safety_retention: policy },
                { model_id: 'test/model', tag: 'separate/clean', safety_retention: false }
            ];
            for (const rows of [entries, [...entries].reverse()]) {
                assert.deepEqual(parseZdrEndpoints(rows).get('test/model'), ['separate/clean']);
            }
        }
    });

    test('conflicting duplicate policies and explicit non-ZDR endpoints fail closed', () => {
        for (const entry of [
            { tag: 'example/clean', safety_retention: true },
            { tag: 'example/other', safety_retention: false, zdr: false }
        ]) {
            assert.equal(parseZdrEndpoints([
                { model_id: 'test/model', tag: 'example/clean', safety_retention: false },
                { model_id: 'test/model', ...entry }
            ]).has('test/model'), false);
        }
    });

    test('keeps full endpoint slugs that state no safety retention', () => {
        const catalog = parseZdrEndpoints(LIST);
        assert.deepEqual(catalog.get('anthropic/claude-sonnet-5.5'), ['amazon-bedrock/us-east-1', 'amazon-bedrock/us-west-2', 'google-vertex']);
        assert.deepEqual(catalog.get('openai/gpt-6.1-sol'), ['azure']);
        assert.equal(catalog.has('google/gemini-3.5-pro'), false, 'safety retention endpoints are excluded');
        assert.equal(catalog.has('deepseek/deepseek-v4.1-flash'), false, 'a missing safety_retention field is treated as retention');
    });

    test('accepts a bare array and rejects an unknown shape', () => {
        assert.equal(parseZdrEndpoints(LIST.data).size, 2);
        assert.throws(() => parseZdrEndpoints({ endpoints: 'nope' }), /Invalid zero data retention/);
    });

    test('routing requires a full slug and never guesses from a display name', () => {
        assert.equal(providerSlugForEndpoint({ tag: 'Amazon-Bedrock/eu' }), 'amazon-bedrock/eu');
        assert.equal(providerSlugForEndpoint({ provider_name: 'Azure' }), '');
        assert.equal(providerSlugForEndpoint({}), '');
    });
});

describe('applyZeroDataRetention', () => {
    const catalog = parseZdrEndpoints(LIST);

    test('a provider allowlist narrows to its safe endpoints, without allowing sibling regions', () => {
        const body = { model: 'anthropic/claude-sonnet-5.5', provider: { only: ['Amazon-Bedrock'] } };
        const restricted = applyZeroDataRetention(body, { enabled: true, catalog });
        assert.deepEqual(restricted.provider.only, ['amazon-bedrock/us-east-1', 'amazon-bedrock/us-west-2']);
        assert.deepEqual(applyZeroDataRetention({ ...body, provider: { only: ['amazon-bedrock/us-east-1'] } },
            { enabled: true, catalog }).provider.only, ['amazon-bedrock/us-east-1']);
        assert.throws(() => applyZeroDataRetention({ ...body, provider: { only: [] } },
            { enabled: true, catalog }), ZdrUnavailableError);
    });

    test('model ZDR keeps search and PDF plugins as requested', () => {
        const body = { model: 'openai/gpt-6.1-sol:online', plugins: [{ id: 'file-parser', pdf: { engine: 'mistral-ocr' } }] };
        const restricted = applyZeroDataRetention(body, { enabled: true, catalog });
        assert.equal(restricted.model, body.model);
        assert.deepEqual(restricted.plugins, body.plugins);
        assert.deepEqual(restricted.provider.only, ['azure']);
    });

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
            sort: 'throughput', zdr: true, data_collection: 'deny', only: ['amazon-bedrock/us-east-1', 'amazon-bedrock/us-west-2', 'google-vertex']
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

describe('saved preferences', () => {
    test('a reload restores both on and off without asking again', async () => {
        let saved;
        const store = { getSetting: async () => saved, saveSetting: async (_key, value) => { saved = value; } };
        for (const choice of [true, false]) {
            const original = new ZeroDataRetentionState();
            original.configure({ settingsStore: store, fetchJson: async () => LIST });
            await original.setEnabled(choice);
            const reloaded = new ZeroDataRetentionState();
            reloaded.configure({ settingsStore: store, fetchJson: async () => LIST });
            await reloaded.ensureReady();
            assert.equal(reloaded.isEnabled(), choice);
        }
    });

    test('delayed restoration blocks synchronous preparation and waits for preflight', async () => {
        let finish;
        const state = new ZeroDataRetentionState();
        state.configure({ settingsStore: { getSetting: () => new Promise(resolve => { finish = resolve; }) }, fetchJson: async () => LIST });
        let completed = false;
        const check = state.checkModel('openai/gpt-6.1-sol').then(error => { completed = true; return error; });
        await Promise.resolve();
        assert.equal(completed, false);
        assert.throws(() => state.applyToBody({ model: 'openai/gpt-6.1-sol' }), error => error.reason === 'settings');
        finish(true);
        assert.equal(await check, null);
        assert.equal(state.applyToBody({ model: 'openai/gpt-6.1-sol' }).provider.zdr, true);
    });

    test('read failure or malformed saved data blocks sends until an explicit choice', async () => {
        for (const getSetting of [async () => { throw new Error('storage failed'); }, async () => 'true']) {
            const state = new ZeroDataRetentionState();
            state.configure({ settingsStore: { getSetting, saveSetting: async () => {} } });
            await assert.rejects(state.ensureReady(), error => error.reason === 'settings');
            assert.equal((await state.checkModel('test/model')).reason, 'settings');
            assert.throws(() => state.applyToBody({ model: 'test/model' }), ZdrUnavailableError);
            await state.setEnabled(false);
            assert.equal(await state.checkModel('test/model'), null);
        }
    });

    test('a late restore cannot replace a newer toggle choice', async () => {
        let finish;
        const state = new ZeroDataRetentionState();
        state.configure({ settingsStore: { getSetting: () => new Promise(resolve => { finish = resolve; }), saveSetting: async () => {} }, fetchJson: async () => LIST });
        const restore = state.restore();
        await state.setEnabled(true);
        finish(false);
        await restore;
        assert.equal(state.isEnabled(), true);
        await state.ensureReady();
    });

    test('writes are serialized and persistence failures are reported', async () => {
        const writes = [];
        let finish;
        const state = new ZeroDataRetentionState();
        state.configure({ settingsStore: { saveSetting: async (_key, value) => {
            writes.push(value);
            if (value) await new Promise(resolve => { finish = resolve; });
        } } });
        const first = state.setEnabled(true);
        const second = state.setEnabled(false);
        await Promise.resolve();
        await Promise.resolve();
        assert.deepEqual(writes, [true]);
        finish();
        await Promise.all([first, second]);
        assert.deepEqual(writes, [true, false]);
        state.configure({ settingsStore: { saveSetting: async () => { throw new Error('disk full'); } } });
        await assert.rejects(state.setEnabled(true), error => error.reason === 'settings-save');
        assert.equal(state.isEnabled(), true, 'the current tab keeps enforcing the chosen policy');
    });
});

describe('request layer', () => {
    let restoreTestGlobals;
    beforeEach(async () => {
        restoreTestGlobals = installBrowser();
        zeroDataRetention.configure({ settingsStore: { saveSetting: async () => {}, getSetting: async () => undefined },
            fetchJson: async () => LIST });
        await zeroDataRetention.restore();
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

    test('a request waits for the saved on preference before acquiring access or sending', async () => {
        let finish;
        let acquired = 0;
        zeroDataRetention.configure({ settingsStore: {
            getSetting: () => new Promise(resolve => { finish = resolve; }), saveSetting: async () => {}
        } });
        const transport = recordingTransport();
        const api = new OpenRouterAPI({
            networkTransport: transport,
            acquireRequestAccess: async () => { acquired += 1; return { baseUrl: 'https://openrouter.ai/api/v1', headers: {} }; }
        });
        const pending = api.sendCompletionStrict([{ role: 'user', content: 'test' }], 'openai/gpt-6.1-sol', 'key');
        await Promise.resolve();
        assert.equal(acquired, 0);
        assert.equal(transport.calls.length, 0);
        finish(true);
        await pending;
        assert.equal(acquired, 1);
        assert.deepEqual(transport.calls[0].body.provider.only, ['azure']);
    });

    test('a saved-setting read failure refuses request access and transport', async () => {
        zeroDataRetention.configure({ settingsStore: {
            getSetting: async () => { throw new Error('storage failed'); }, saveSetting: async () => {}
        } });
        const transport = recordingTransport();
        const api = new OpenRouterAPI({
            networkTransport: transport,
            acquireRequestAccess: async () => { assert.fail('must not acquire access'); }
        });
        await assert.rejects(api.sendCompletionStrict([], 'openai/gpt-6.1-sol', 'key'), error => error.reason === 'settings');
        assert.equal(transport.calls.length, 0);
    });

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
        assert.deepEqual(transport.calls[0].body.provider.only, ['amazon-bedrock/us-east-1', 'amazon-bedrock/us-west-2', 'google-vertex']);
        assert.equal(transport.calls[0].body.provider.zdr, true);
    });

    test('a model without eligible providers is never sent', async () => {
        await zeroDataRetention.setEnabled(true);
        let acquired = 0;
        const transport = recordingTransport();
        const api = new OpenRouterAPI({
            networkTransport: transport,
            acquireRequestAccess: async () => { acquired += 1; return { baseUrl: 'https://openrouter.ai/api/v1', headers: {} }; }
        });
        await assert.rejects(api.sendCompletionStrict([{ role: 'user', content: 'idea' }], 'google/gemini-3.5-pro', 'key'),
            ZdrUnavailableError);
        assert.equal(transport.calls.length, 0);
        assert.equal(acquired, 0, 'refuse before paid request access');
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
