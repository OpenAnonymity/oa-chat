import test from 'node:test';
import assert from 'node:assert/strict';


test('ticket selection can wait for the live Auto Router price', async () => {
    const previousFetch = globalThis.fetch;
    const previousLocalStorage = globalThis.localStorage;
    const values = new Map();
    globalThis.localStorage = {
        getItem: key => values.get(key) ?? null,
        setItem: (key, value) => values.set(key, String(value))
    };
    globalThis.fetch = async () => new Response(
        JSON.stringify({ 'openrouter/auto': 4 }),
        { status: 200, headers: { 'content-type': 'application/json' } }
    );

    try {
        const modelTiers = await import('../../chat/services/modelTiers.js?ready-test');
        await modelTiers.ensureModelTiersReady();
        assert.equal(modelTiers.getTicketCost('openrouter/auto'), 4);
    } finally {
        if (previousFetch === undefined) delete globalThis.fetch;
        else globalThis.fetch = previousFetch;
        if (previousLocalStorage === undefined) delete globalThis.localStorage;
        else globalThis.localStorage = previousLocalStorage;
    }
});

test('a failed live pricing refresh remains retryable and never authorizes cached pricing', async () => {
    const previousFetch = globalThis.fetch;
    const previousLocalStorage = globalThis.localStorage;
    const values = new Map([
        ['oa-model-tickets-cache', JSON.stringify({
            data: { 'openrouter/auto': 1 },
            timestamp: Date.now()
        })]
    ]);
    let requestCount = 0;
    globalThis.localStorage = {
        getItem: key => values.get(key) ?? null,
        setItem: (key, value) => values.set(key, String(value))
    };
    globalThis.fetch = async () => {
        requestCount += 1;
        if (requestCount === 1) {
            return new Response('unavailable', { status: 400 });
        }
        return new Response(
            JSON.stringify({ 'openrouter/auto': 4 }),
            { status: 200, headers: { 'content-type': 'application/json' } }
        );
    };

    try {
        const modelTiers = await import('../../chat/services/modelTiers.js?ready-retry-test');
        await assert.rejects(
            () => modelTiers.ensureModelTiersReady(),
            error => error?.code === 'MODEL_TIER_CONFIG_UNAVAILABLE'
        );
        assert.equal(modelTiers.getTicketCost('openrouter/auto'), 1);

        await modelTiers.ensureModelTiersReady();
        assert.equal(requestCount, 2);
        assert.equal(modelTiers.getTicketCost('openrouter/auto'), 4);
    } finally {
        if (previousFetch === undefined) delete globalThis.fetch;
        else globalThis.fetch = previousFetch;
        if (previousLocalStorage === undefined) delete globalThis.localStorage;
        else globalThis.localStorage = previousLocalStorage;
    }
});

test('waiting for live pricing can be cancelled without waiting for the shared fetch', async () => {
    const previousFetch = globalThis.fetch;
    const previousLocalStorage = globalThis.localStorage;
    globalThis.localStorage = { getItem: () => null, setItem: () => {} };
    globalThis.fetch = (_url, init = {}) => new Promise((resolve, reject) => {
        const rejectAsAborted = () => {
            const error = new Error('aborted');
            error.name = 'AbortError';
            reject(error);
        };
        if (init.signal?.aborted) rejectAsAborted();
        else init.signal?.addEventListener('abort', rejectAsAborted, { once: true });
    });

    try {
        const modelTiers = await import('../../chat/services/modelTiers.js?ready-abort-test');
        const controller = new AbortController();
        const pending = modelTiers.ensureModelTiersReady({ signal: controller.signal });
        controller.abort();

        await assert.rejects(
            () => pending,
            error => error?.name === 'AbortError' && error?.isUserAbort === true
        );
    } finally {
        if (previousFetch === undefined) delete globalThis.fetch;
        else globalThis.fetch = previousFetch;
        if (previousLocalStorage === undefined) delete globalThis.localStorage;
        else globalThis.localStorage = previousLocalStorage;
    }
});

test('an open tab refreshes before redemption, shares in-flight loads, and fails closed', async () => {
    const previousFetch = globalThis.fetch;
    const previousLocalStorage = globalThis.localStorage;
    globalThis.localStorage = { getItem: () => null, setItem() {} };
    let price = 5;
    let fail = false;
    let requests = 0;
    globalThis.fetch = async (_url, init) => {
        requests++;
        assert.equal(init.credentials, 'omit');
        assert.equal(init.cache, 'no-store');
        return new Response(fail ? '{}' : JSON.stringify({ 'openai/gpt-6.1-sol': price }),
            { status: fail ? 400 : 200 });
    };
    try {
        const tiers = await import('../../chat/services/modelTiers.js?price-change-test');
        await tiers.ensureModelTiersReady();
        assert.equal(tiers.getTicketCost('openai/gpt-6.1-sol'), 5);
        price = 9;
        assert.deepEqual(await Promise.all([
            tiers.getAccessTicketCost('openai/gpt-6.1-sol'),
            tiers.getAccessTicketCost('openai/gpt-6.1-sol:online')
        ]), [9, 9]);
        assert.equal(requests, 2);
        fail = true;
        await assert.rejects(tiers.getAccessTicketCost('openai/gpt-6.1-sol'),
            { code: 'MODEL_TIER_CONFIG_UNAVAILABLE' });
        fail = false;
        price = 3;
        assert.equal(await tiers.getAccessTicketCost('openai/gpt-6.1-sol'), 3);
        await assert.rejects(tiers.getAccessTicketCost('missing-model'), { code: 'MODEL_TIER_UNAVAILABLE' });
        const controller = new AbortController();
        controller.abort();
        const beforeAbort = requests;
        await assert.rejects(tiers.getAccessTicketCost('openai/gpt-6.1-sol', { signal: controller.signal }),
            { name: 'AbortError' });
        assert.equal(requests, beforeAbort);
    } finally {
        if (previousFetch === undefined) delete globalThis.fetch;
        else globalThis.fetch = previousFetch;
        if (previousLocalStorage === undefined) delete globalThis.localStorage;
        else globalThis.localStorage = previousLocalStorage;
    }
});
