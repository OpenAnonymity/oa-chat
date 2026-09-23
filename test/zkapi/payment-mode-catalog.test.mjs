import assert from 'node:assert/strict';
import test from 'node:test';

// Import the actual composition with a small browser shell. Network and wallet
// boundaries are replaced below; catalog formatting, caching, configuration,
// backend selection, and presentation run through their production modules.
const values = new Map();
const storage = {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: key => values.delete(key),
    clear: () => values.clear()
};
globalThis.window = globalThis;
globalThis.location = { hostname: 'localhost', origin: 'http://localhost', href: 'http://localhost/funding/', search: '' };
globalThis.localStorage = storage;
globalThis.sessionStorage = storage;
globalThis.addEventListener = () => {};
globalThis.dispatchEvent = () => {};
globalThis.document = {
    querySelector: () => null,
    getElementById: () => null,
    addEventListener() {},
    documentElement: { dataset: {}, classList: { contains: () => false } },
    createElement() {
        let text = '';
        return {
            set textContent(value) { text = String(value ?? ''); },
            get textContent() { return text; },
            get innerHTML() { return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;'); }
        };
    }
};
const request = result => {
    const value = {};
    queueMicrotask(() => { value.result = result; value.onsuccess?.({ target: value }); });
    return value;
};
const settingsStore = { get: () => request(undefined), put: () => request(undefined), delete: () => request(undefined) };
globalThis.indexedDB = { open: () => request({ version: 4, close() {}, transaction: () => ({ objectStore: () => settingsStore }) }) };
globalThis.zkapiWallet = new Proxy({ ABI: [] }, {
    get: (target, key) => key in target ? target[key] : (() => null)
});

const { ZkapiAPI } = await import('../../chat/zkapi/api.js');
const { default: zkapiClient } = await import('@openanonymity/zkapi-browser-sdk/client');
const { createZkapiBackend } = await import('../../chat/zkapi/services/inference/backends/zkapiBackend.js');
const { createPaymentModeRuntime } = await import('../../chat/zkapi/services/paymentModeRuntime.js');
const { createPaymentModeUi } = await import('../../chat/zkapi/ui/createPaymentModeUi.js');
const { openRouterBackend, createInferenceService } = await import('../../chat/publicInferenceApi.js');
const { networkProxy, loadModelCatalog, saveModelCatalog } = await import('../../chat/publicRuntimeApi.js');
const { default: ticketApi } = await import('../../chat/api.js');
const { ChatApp } = await import('../../chat/app.js');
const { createZkapiChatRuntimeCore } = await import('../../chat/zkapi/services/zkapiChatRuntimeCore.mjs');

const CATALOG = [
    { id: 'openrouter/auto', name: 'Auto Router', pricing: { prompt: '0', completion: '0' }, context_length: 128000 },
    { id: 'openai/gpt-5.3', name: 'Provider GPT 5.3', pricing: { prompt: '0.000002', completion: '0.000008' }, context_length: 200000, top_provider: { max_completion_tokens: 32000 } },
    { id: 'openai/gpt-5.3:batch', name: 'Provider GPT 5.3 Batch', pricing: { prompt: '0.000001', completion: '0.000004' }, context_length: 100000, top_provider: { max_completion_tokens: 16000 } },
    { id: 'deepseek/catalog-only-model', name: 'Catalog Only Model', pricing: { prompt: '0.0000004', completion: '0.0000008' }, context_length: 64000 },
    ...Array.from({ length: 8 }, (_, index) => ({
        id: `qwen/catalog-model-${index}`, name: `Qwen Catalog Model ${index}`,
        pricing: { prompt: '0.0000001', completion: '0.0000002' }, context_length: 32000
    }))
];
const OLD_ZK_CATALOG = [{ id: 'openai/gpt-4o-mini', name: 'Old lone zkAPI model', provider: 'OpenAI' }];
const ticketSession = { id: 'historical-ticket-chat', inferenceBackend: 'openrouter' };
const privateSession = { id: 'historical-private-chat', inferenceBackend: 'zkapi' };

function forbidWalletCatalogAccess(t) {
    const initialization = t.mock.method(zkapiClient, 'init', () => { throw new Error('Catalog browsing must not initialize a wallet'); });
    const descriptor = Object.getOwnPropertyDescriptor(zkapiClient, 'config');
    Object.defineProperty(zkapiClient, 'config', { configurable: true, get() { throw new Error('Catalog browsing must not consult the deployment allowlist'); } });
    t.after(() => Object.defineProperty(zkapiClient, 'config', descriptor));
    return initialization;
}

test.beforeEach(() => storage.clear());

test('an injected catalog owns cached models, live models and display names without wallet access', async t => {
    const initialization = forbidWalletCatalogAccess(t);
    const source = {
        getCachedModels() { assert.equal(this, source); return CATALOG; },
        async fetchModels() { assert.equal(this, source); return CATALOG; },
        getDisplayName(modelId, fallback) { assert.equal(this, source); return `${fallback}: ${modelId}`; }
    };
    const api = new ZkapiAPI({ modelCatalog: source });
    const backend = createZkapiBackend(api);
    assert.equal(api.getCachedModels(), CATALOG);
    assert.equal(await api.fetchModels(), CATALOG);
    assert.equal(await backend.fetchModels(), CATALOG);
    assert.equal(backend.getCachedModels(), CATALOG);
    assert.equal(backend.getDisplayName('deepseek/catalog-only-model', 'Shared name'), 'Shared name: deepseek/catalog-only-model');
    assert.equal(initialization.mock.callCount(), 0);
});

test('both payment modes load the same full OA catalog and ignore a stale one-model zkAPI cache', async t => {
    saveModelCatalog('zkapi', OLD_ZK_CATALOG);
    const oldCache = loadModelCatalog('zkapi');
    const initialization = forbidWalletCatalogAccess(t);
    const transport = t.mock.method(networkProxy, 'fetchWithRetryJson', async url => {
        assert.equal(url, 'https://openrouter.ai/api/v1/models');
        return { response: { ok: true, status: 200 }, data: { data: CATALOG } };
    });
    const runtime = createPaymentModeRuntime();
    const tickets = await runtime.inferenceService.fetchModels(ticketSession);
    const privateModels = await runtime.inferenceService.fetchModels(privateSession);
    assert.deepEqual(privateModels, tickets);
    assert.equal(privateModels.length, CATALOG.length);
    assert.ok(privateModels.some(model => model.id === 'deepseek/catalog-only-model'));
    assert.ok(!privateModels.some(model => model.id === OLD_ZK_CATALOG[0].id));
    for (const session of [ticketSession, privateSession]) {
        assert.deepEqual(runtime.inferenceService.getCachedModels(session), JSON.parse(JSON.stringify(tickets)));
        for (const model of tickets) {
            assert.equal(runtime.inferenceService.getDisplayName(model.id, model.name, session), openRouterBackend.getDisplayName(model.id, model.name));
        }
    }
    assert.deepEqual(loadModelCatalog('zkapi'), oldCache, 'shared mode does not read or overwrite the legacy catalog');
    assert.equal(transport.mock.callCount(), 2);
    assert.equal(initialization.mock.callCount(), 0);
});

test('a fresh runtime preserves the entire shared cached catalog in zkAPI mode during a provider outage', async t => {
    saveModelCatalog('openrouter', ticketApi.formatModels(CATALOG));
    saveModelCatalog('zkapi', OLD_ZK_CATALOG);
    storage.setItem('oa-payment-mode', 'zkapi');
    const expected = openRouterBackend.getCachedModels();
    const initialization = forbidWalletCatalogAccess(t);
    t.mock.method(networkProxy, 'fetchWithRetryJson', async () => { throw new Error('Catalog offline'); });
    t.mock.method(console, 'error', () => {});
    t.mock.method(console, 'warn', () => {});
    const runtime = createPaymentModeRuntime();
    assert.equal(runtime.getMode(), 'zkapi');
    assert.deepEqual(runtime.inferenceService.getCachedModels(), expected);
    assert.deepEqual(await runtime.inferenceService.fetchModels(), expected);
    assert.deepEqual(await runtime.inferenceService.fetchModels(ticketSession), expected);
    assert.equal(expected.length, CATALOG.length);
    assert.equal(initialization.mock.callCount(), 0);
});

test('pinned, disabled and default models follow the same OA availability update in both modes', async t => {
    const payload = {
        pinned_models: ['deepseek/catalog-only-model', 'openai/gpt-5.3', 'openai/gpt-5.3:batch'],
        disabled_models: ['openrouter/auto', 'openai/gpt-5.3'],
        updated_at: 123456
    };
    const requests = t.mock.method(globalThis, 'fetch', async url => {
        assert.ok(String(url).endsWith('/chat/pinned-models'));
        return { ok: true, json: async () => payload };
    });
    const runtime = createPaymentModeRuntime();
    let updates = 0;
    const unsubscribe = runtime.modelConfiguration.onPinnedModelsUpdate(() => { updates += 1; });
    t.after(unsubscribe);
    await runtime.modelConfiguration.initPinnedModels();
    for (const session of [ticketSession, privateSession]) {
        assert.deepEqual(runtime.modelConfiguration.getPinnedModels(session), ['deepseek/catalog-only-model', 'openai/gpt-5.3:batch']);
        assert.deepEqual(runtime.modelConfiguration.getDisabledModels(session), payload.disabled_models);
        assert.equal(runtime.modelConfiguration.getDefaultModelConfig(session).defaultModelId, 'deepseek/catalog-only-model');
        assert.equal(runtime.inferenceService.getDefaultModelId(session), 'deepseek/catalog-only-model');
    }
    assert.equal(runtime.inferenceService.getDefaultModelName(privateSession), runtime.inferenceService.getDefaultModelName(ticketSession));
    assert.equal(requests.mock.callCount(), 1);
    assert.equal(updates, 1);
});

test('exact variant prices and output limits come from the shared catalog while only zkAPI displays token prices', () => {
    saveModelCatalog('openrouter', ticketApi.formatModels(CATALOG));
    saveModelCatalog('zkapi', OLD_ZK_CATALOG);
    const api = new ZkapiAPI({ modelCatalog: openRouterBackend });
    const base = api.getModelBudgetMetadata('openai/gpt-5.3');
    const variant = api.getModelBudgetMetadata('openai/gpt-5.3:batch');
    assert.deepEqual(base.pricing, CATALOG[1].pricing);
    assert.deepEqual(variant.pricing, CATALOG[2].pricing);
    assert.equal(base.top_provider.max_completion_tokens, 32000);
    assert.equal(variant.top_provider.max_completion_tokens, 16000);
    assert.equal(variant.context_length, 100000);
    assert.deepEqual(api.getModelBudgetMetadata('openai/gpt-5.3:nitro'), base);
    assert.equal(api.getModelBudgetMetadata('missing/unknown-model'), null);

    const runtime = createPaymentModeRuntime();
    const ui = createPaymentModeUi(runtime);
    assert.equal(ui.presentation.getModelPricing(variant), null);
    runtime.inferenceService.setDefaultBackendId('zkapi');
    assert.deepEqual(ui.presentation.getModelPricing(variant), {
        balanceBadgeLabel: '≥ $1',
        balanceBadgeTooltip: 'Requires a private balance of at least $1 for a new key. Only actual usage is deducted.',
        label: '$1/M input · $4/M output',
        description: 'Input $0.000001/token · output $0.000004/token'
    });
    runtime.inferenceService.setDefaultBackendId('openrouter');
    assert.equal(ui.presentation.getModelPricing(variant), null);
});

test('OA private access defaults to the same catalog as Tickets', () => {
    saveModelCatalog('openrouter', ticketApi.formatModels(CATALOG));
    saveModelCatalog('zkapi', OLD_ZK_CATALOG);
    const api = new ZkapiAPI();
    assert.deepEqual(createZkapiBackend(api).getCachedModels(), openRouterBackend.getCachedModels());
    assert.ok(api.getModelBudgetMetadata('openai/gpt-5.6-sol')?.pricing);
});

function usageHarness(t, api, initialSession) {
    const session = structuredClone(initialSession || {
        id: 'routed-private-chat', inferenceBackend: 'zkapi', apiKey: 'fixture-session-binding',
        model: 'Auto Router'
    });
    let savedSession = null;
    const runtime = createZkapiChatRuntimeCore({
        client: { init: async () => {}, subscribe: () => () => {} },
        backend: createZkapiBackend(api),
        createInferenceService,
        modelConfiguration: { getDefaultModelConfig: () => ({ defaultModelId: 'openrouter/auto' }) }
    });
    t.after(runtime.attach({
        getSession: id => id === session.id ? session : null,
        saveSession: async value => { savedSession = structuredClone(value); },
        refreshPresentation() {}
    }));
    // Bypass DOM construction, retaining the actual controller and backend
    // methods that receive SSE usage and persist the completed message estimate.
    const app = Object.assign(Object.create(ChatApp.prototype), {
        runtime,
        inferenceService: runtime.inferenceService,
        state: { models: api.getCachedModels(), modelsBackendId: 'zkapi', currentSessionId: session.id }
    });
    return { app, runtime, session, readSavedSession: () => structuredClone(savedSession) };
}

function stubRoutedStream(t, events) {
    t.mock.method(globalThis, 'fetch', async url => {
        assert.match(url, /\/chat\/model-tickets$/);
        return new Response(JSON.stringify({ 'openrouter/auto': 25 }), {
            headers: { 'content-type': 'application/json' }
        });
    });
    t.mock.method(zkapiClient, 'acquireInferenceAccess', async sessionId => {
        assert.equal(sessionId, 'fixture-session-binding');
        return { baseUrl: 'https://inference.example.test/v1', headers: {}, spendingLimitUsd: 1, release() {} };
    });
    t.mock.method(zkapiClient, 'refresh', async () => {});
    return t.mock.method(networkProxy, 'fetchWithRetry', async (url, options) => {
        assert.equal(url, 'https://inference.example.test/v1/chat/completions');
        assert.equal(JSON.parse(options.body).model, 'openrouter/auto');
        const encoder = new TextEncoder();
        return { ok: true, status: 200, body: new ReadableStream({
            start(controller) {
                for (const event of events) controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
                controller.enqueue(encoder.encode('data: [DONE]\n\n'));
                controller.close();
            }
        }) };
    });
}

function assertUsageCost(actual, expected) {
    if (expected === null || expected === 0) assert.equal(actual, expected);
    else assert.ok(typeof actual === 'number' && Math.abs(actual - expected) < 1e-12,
        `Expected a $${expected} estimate, received ${actual}`);
}

test('routed SSE prices survive controller finalization, ledger reload and message recovery', async t => {
    for (const scenario of [
        { name: 'catalog rate without provider cost', model: CATALOG[3].id, pricing: CATALOG[3].pricing, cost: 0.0008 },
        { name: 'null provider cost uses catalog rate', model: CATALOG[3].id, pricing: CATALOG[3].pricing, providerCost: null, cost: 0.0008 },
        { name: 'exact routed variant rate', model: CATALOG[2].id, pricing: CATALOG[2].pricing, cost: 0.003 },
        { name: 'provider charge overrides catalog rate', model: CATALOG[3].id, pricing: CATALOG[3].pricing, providerCost: 0.0123, cost: 0.0123 },
        { name: 'zero provider charge overrides catalog rate', model: CATALOG[3].id, pricing: CATALOG[3].pricing, providerCost: 0, cost: 0 },
        { name: 'unknown routed model has no router-price fallback', model: 'unknown/unlisted-response', pricing: null, cost: null }
    ]) await t.test(scenario.name, async t => {
        saveModelCatalog('openrouter', ticketApi.formatModels(CATALOG));
        const api = new ZkapiAPI({ modelCatalog: openRouterBackend });
        const h = usageHarness(t, api);
        const providerUsage = { prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1500 };
        if ('providerCost' in scenario) providerUsage.cost = scenario.providerCost;
        const transport = stubRoutedStream(t, [
            { model: scenario.model, choices: [{ delta: { role: 'assistant' } }] },
            { choices: [{ delta: { content: 'Routed answer' } }] },
            { choices: [], usage: providerUsage }
        ]);
        const message = { id: 'routed-response', role: 'assistant', model: 'Auto Router', content: '' };
        const result = await h.app.streamCompletionWithRuntime(
            [{ role: 'user', content: 'Route this request.' }], 'openrouter/auto', h.session,
            chunk => { message.content += chunk || ''; },
            usage => h.app.updateResponseModel(message, usage.model, 'openrouter/auto', 'Auto Router', h.session),
            [], false, new AbortController(), null, null, false, 'medium', message.id
        );
        assert.equal(result.model, scenario.model);
        assert.deepEqual(result.pricing, scenario.pricing);
        assert.notEqual(message.model, 'Auto Router');
        assert.equal(message.content, 'Routed answer');
        assert.equal(h.session.model, 'Auto Router');
        assertUsageCost(h.session.zkapiUsageLedger[0].estimatedCostUsd, scenario.cost);

        // This is the second upsert performed by the real Send finalization.
        // It must not replace the routed rate or double count the response.
        await h.app.recordRuntimeUsage(h.session, message, result);
        const savedMessage = structuredClone(message);
        assertUsageCost(savedMessage.estimatedCostUsd, scenario.cost);
        assert.deepEqual(savedMessage.usagePricing, scenario.pricing);
        assert.equal(savedMessage.usageProviderReported, typeof scenario.providerCost === 'number');
        assert.equal(h.session.zkapiUsageLedger.length, 1);
        assert.equal(transport.mock.callCount(), 1);

        for (const recoverFromMessage of [false, true]) {
            const savedSession = h.readSavedSession();
            if (recoverFromMessage) delete savedSession.zkapiUsageLedger;
            const reloaded = usageHarness(t, api, savedSession);
            await reloaded.runtime.restoreSession(reloaded.session, [savedMessage]);
            const ledger = reloaded.session.zkapiUsageLedger;
            assert.equal(ledger.length, 1);
            assertUsageCost(ledger[0].estimatedCostUsd, scenario.cost);
            assert.deepEqual(ledger[0].pricing, scenario.pricing);
            assert.equal(ledger[0].providerReported, typeof scenario.providerCost === 'number');
            const summary = reloaded.runtime.getSessionUsageSummary(reloaded.session);
            assert.equal(summary.promptTokens, 1000);
            assert.equal(summary.completionTokens, 500);
            assert.equal(summary.totalTokens, 1500);
            assert.equal(summary.requests, 1);
            assert.equal(summary.hasEstimate, scenario.cost !== null);
            assertUsageCost(summary.estimatedCostUsd, scenario.cost ?? 0);
        }
    });
});

test('late routed model metadata reprices the latest token snapshot before cancellation', async t => {
    for (const scenario of [
        { name: 'catalog estimate', model: CATALOG[3].id, pricing: CATALOG[3].pricing, cost: 0.0008 },
        { name: 'provider zero remains authoritative', model: CATALOG[3].id, pricing: CATALOG[3].pricing, providerCost: 0, cost: 0 },
        { name: 'unknown routed price remains unknown', model: 'unknown/late-response', pricing: null, cost: null }
    ]) await t.test(scenario.name, async t => {
        saveModelCatalog('openrouter', ticketApi.formatModels(CATALOG));
        const api = new ZkapiAPI({ modelCatalog: openRouterBackend });
        const h = usageHarness(t, api);
        const providerUsage = { prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1500 };
        if ('providerCost' in scenario) providerUsage.cost = scenario.providerCost;
        stubRoutedStream(t, [
            { choices: [{ delta: { content: 'Partial answer' } }] },
            { usage: providerUsage, choices: [] },
            { model: scenario.model, choices: [{ delta: { role: 'assistant' } }] }
        ]);
        t.mock.method(console, 'error', () => {});
        const controller = new AbortController();
        let modelUpdates = 0;
        await assert.rejects(h.app.streamCompletionWithRuntime(
            [{ role: 'user', content: 'Route this request.' }], 'openrouter/auto', h.session,
            () => {}, usage => {
                if (usage.modelOnly) {
                    modelUpdates += 1;
                    assert.equal(h.runtime.getSessionUsageSummary(h.session).totalTokens, 1500);
                    controller.abort();
                }
            }, [], false, controller, null, null, false, 'medium', 'interrupted-response'
        ), error => error.name === 'AbortError' && error.isCancelled);
        assert.equal(modelUpdates, 1);
        const reloaded = usageHarness(t, api, h.readSavedSession());
        assert.equal(reloaded.session.zkapiUsageLedger.length, 1);
        const [entry] = reloaded.session.zkapiUsageLedger;
        assert.equal(entry.model, scenario.model);
        assert.deepEqual(entry.pricing, scenario.pricing);
        assertUsageCost(entry.estimatedCostUsd, scenario.cost);
        assert.equal(entry.providerReported, typeof scenario.providerCost === 'number');
        assert.equal(entry.promptTokens, 1000);
        assert.equal(entry.completionTokens, 500);
        assert.equal(entry.totalTokens, 1500);
    });
});
