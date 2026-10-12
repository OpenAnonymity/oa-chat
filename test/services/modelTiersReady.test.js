import test from 'node:test';
import assert from 'node:assert/strict';

test('send preview never queues behind a background price refresh, but spending does', async t => {
    const saved = { fetch: globalThis.fetch, localStorage: globalThis.localStorage };
    globalThis.localStorage = { getItem: () => null, setItem() {} };
    let finishRefresh;
    let requests = 0;
    globalThis.fetch = async () => {
        if (++requests === 1) return Response.json({ 'model-one': 1 });
        return new Promise(resolve => { finishRefresh = resolve; });
    };
    t.after(() => Object.assign(globalThis, saved));
    const tiers = await import('../../chat/services/modelTiers.js?preview-background-race');
    await tiers.ensureModelTiersReady();
    const refreshing = tiers.initModelTiers({ forceRefresh: true });
    let previewReady = false;
    let spendingReady = false;
    const preview = tiers.ensureModelTiersPreviewReady()
        .then(() => { previewReady = true; });
    const spending = tiers.getAccessTicketCost('model-one').then(price => {
        spendingReady = true;
        return price;
    });
    try {
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(previewReady, true, 'accepting a send must not wait for the background refresh');
        assert.equal(spendingReady, false, 'redemption must still await authoritative pricing');
        assert.equal(tiers.getTicketCost('model-one'), 1);
    } finally {
        finishRefresh(Response.json({ 'model-one': 3 }));
        await Promise.all([refreshing, preview]);
        assert.equal(await spending, 3);
    }
    assert.equal(requests, 2);
});

test('preview uses only a map validated in this page and never authorizes spending after failure', async t => {
    const saved = { fetch: globalThis.fetch, localStorage: globalThis.localStorage };
    const now = Date.now;
    let clock = 1000, fail = true, requests = 0;
    Date.now = () => clock;
    globalThis.localStorage = { getItem: () => JSON.stringify({ data: { 'model-one': 1 } }), setItem() {} };
    globalThis.fetch = async () => {
        requests++;
        return fail ? new Response('{}', { status: 400 }) : Response.json({ 'model-one': 3 });
    };
    t.after(() => { Object.assign(globalThis, saved); Date.now = now; });
    const tiers = await import('../../chat/services/modelTiers.js?preview-validated-only');
    await assert.rejects(tiers.ensureModelTiersPreviewReady(), { code: 'MODEL_TIER_CONFIG_UNAVAILABLE' });
    fail = false;
    await tiers.ensureModelTiersPreviewReady();
    fail = true;
    await assert.rejects(tiers.getAccessTicketCost('model-one'), { code: 'MODEL_TIER_CONFIG_UNAVAILABLE' });
    clock += 600001;
    const beforePreview = requests;
    await tiers.ensureModelTiersPreviewReady();
    assert.equal(requests, beforePreview, 'expired preview does not fetch on the click path');
    assert.equal(tiers.getTicketCost('model-one'), 3);
    await assert.rejects(tiers.getAccessTicketCost('model-one'), { code: 'MODEL_TIER_CONFIG_UNAVAILABLE' });
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(tiers.ensureModelTiersPreviewReady({ signal: controller.signal }), { name: 'AbortError' });
});


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

test('redemption refreshes while courtesy preflight reuses the live map, and failed refreshes fail closed', async () => {
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
        assert.equal(requests, 1);
        // Accepting the prompt uses the loaded map; spending always refreshes.
        price = 9;
        await tiers.ensureModelTiersReady();
        assert.equal(requests, 1);
        assert.deepEqual(await Promise.all([
            tiers.getAccessTicketCost('openai/gpt-6.1-sol'),
            tiers.getAccessTicketCost('openai/gpt-6.1-sol:online')
        ]), [9, 9]);
        assert.equal(requests, 2);
        // The org rejected the count: the retry refreshes, and concurrent refreshes share one load.
        assert.deepEqual(await Promise.all([
            tiers.getAccessTicketCost('openai/gpt-6.1-sol', { forceRefresh: true }),
            tiers.getAccessTicketCost('openai/gpt-6.1-sol:online', { forceRefresh: true })
        ]), [9, 9]);
        assert.equal(requests, 3);
        fail = true;
        await assert.rejects(tiers.getAccessTicketCost('openai/gpt-6.1-sol', { forceRefresh: true }),
            { code: 'MODEL_TIER_CONFIG_UNAVAILABLE' });
        // A failed refresh never authorizes the previous map either.
        await assert.rejects(tiers.getAccessTicketCost('openai/gpt-6.1-sol'),
            { code: 'MODEL_TIER_CONFIG_UNAVAILABLE' });
        fail = false;
        price = 3;
        assert.equal(await tiers.getAccessTicketCost('openai/gpt-6.1-sol', { forceRefresh: true }), 3);
        assert.equal(await tiers.getAccessTicketCost('openai/gpt-6.1-sol'), 3);
        await assert.rejects(tiers.getAccessTicketCost('missing-model'), { code: 'MODEL_TIER_UNAVAILABLE' });
        const controller = new AbortController();
        controller.abort();
        const beforeAbort = requests;
        await assert.rejects(tiers.getAccessTicketCost('openai/gpt-6.1-sol', { signal: controller.signal, forceRefresh: true }),
            { name: 'AbortError' });
        assert.equal(requests, beforeAbort);
    } finally {
        if (previousFetch === undefined) delete globalThis.fetch;
        else globalThis.fetch = previousFetch;
        if (previousLocalStorage === undefined) delete globalThis.localStorage;
        else globalThis.localStorage = previousLocalStorage;
    }
});

test('foreground and ten-minute refreshes update badges without polling hidden tabs', async () => {
    const keys = ['fetch', 'localStorage', 'document', 'setInterval', 'clearInterval'];
    const saved = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    const now = Date.now;
    let clock = 1000, requests = 0, price = 5, onVisibility, onTimer, updates = 0;
    Date.now = () => clock;
    Object.assign(globalThis, {
        localStorage: { getItem: () => null, setItem() {} },
        document: { visibilityState: 'visible',
            addEventListener: (_event, callback) => { onVisibility = callback; },
            removeEventListener: (_event, callback) => { assert.equal(callback, onVisibility); onVisibility = null; } },
        setInterval: (callback, delay) => { assert.equal(delay, 600000); onTimer = callback; return 123; },
        clearInterval: id => { assert.equal(id, 123); onTimer = null; },
        fetch: async () => { requests++; return new Response(JSON.stringify({ 'model-a': price })); }
    });
    let stop;
    try {
        const tiers = await import('../../chat/services/modelTiers.js?badge-refresh-test');
        tiers.onModelTiersUpdate(() => updates++);
        stop = tiers.startModelTierRefresh();
        assert.equal(tiers.startModelTierRefresh(), stop);
        await tiers.ensureModelTiersReady();
        assert.equal(tiers.getTicketCost('model-a'), 5);
        price = 9;
        document.visibilityState = 'hidden';
        onVisibility(); onTimer();
        assert.equal(requests, 1);
        document.visibilityState = 'visible';
        onVisibility();
        await tiers.ensureModelTiersReady();
        assert.equal(tiers.getTicketCost('model-a'), 9);
        assert.equal(updates, 2);
        // Fetch completion can lag the timer; each visible ten-minute tick refreshes.
        price = 3; clock += 599999;
        onTimer();
        await tiers.ensureModelTiersReady();
        assert.equal(tiers.getTicketCost('model-a'), 3);
        assert.equal(updates, 3);
        assert.equal(requests, 3);
    } finally {
        stop?.();
        Date.now = now;
        for (const [key, descriptor] of saved) {
            if (descriptor) Object.defineProperty(globalThis, key, descriptor);
            else delete globalThis[key];
        }
    }
});
