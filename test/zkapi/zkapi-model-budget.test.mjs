import assert from 'node:assert/strict';
import test from 'node:test';

globalThis.localStorage = { getItem: () => null, setItem() {} };
const { getTicketCost, ensureModelTiersReady } = await import('../../chat/publicModelTierApi.js');
const { getModelBudget, spendingLimitUsdForTicketCost, formatModelBudgetUsd } =
    await import('../../chat/zkapi/services/zkapiModelBudget.mjs');

test('reviewed OA ticket envelopes become bounded dollars, not a linear ticket charge', () => {
    for (const [tickets, dollars] of [[1, 1], [2, 1], [3, 2], [5, 3], [8, 2], [25, 4.5], [100, 6]]) {
        assert.equal(spendingLimitUsdForTicketCost(tickets), dollars);
    }
    for (const invalid of [0, -1, 1.5, 4, 10, 1000, '3', null, undefined, NaN, Infinity, true, 'constructor']) {
        assert.throws(() => spendingLimitUsdForTicketCost(invalid), error => error.code === 'unsupported_model_budget');
    }
    assert.equal(formatModelBudgetUsd(4.5), '$4.50');
    assert.equal(formatModelBudgetUsd(0), null);
});

test('model budgets use the same exact variant, Auto Router and reasoning rules as Tickets', async t => {
    const map = {
        'openrouter/auto': 3,
        'openai/gpt-6-astra': 25,
        'openai/gpt-6-astra:batch': 1,
        'openai/gpt-6-astra-pro': 100,
        'anthropic/claude-opus-5': 5,
        'openai/gpt-5.6-terra': 2,
        'future/unsupported-tier': 4
    };
    const requests = [];
    t.mock.method(globalThis, 'fetch', async (url, options) => {
        requests.push({ url, options });
        return new Response(JSON.stringify(map), { status: 200 });
    });
    await ensureModelTiersReady();
    assert.equal(requests.length, 1);
    assert.equal(requests[0].options.credentials, 'omit');
    for (const reasoning of [false, true]) {
        for (const [id, tickets] of Object.entries(map)) {
            if (tickets === 4) continue;
            const actual = getModelBudget(id, reasoning);
            assert.equal(actual.ticketCost, getTicketCost(id, reasoning));
            assert.equal(actual.spendingLimitUsd, spendingLimitUsdForTicketCost(tickets));
        }
        assert.equal(getModelBudget('openai/gpt-6-astra:online', reasoning).spendingLimitUsd, 4.5);
        assert.equal(getModelBudget('openai/gpt-6-astra:batch:online', reasoning).spendingLimitUsd, 1);
        assert.throws(() => getModelBudget('future/unsupported-tier', reasoning),
            error => error.code === 'unsupported_model_budget');
    }
    for (const id of [null, 'future/ordinary', 'future/mini', 'future/opus', 'future/reasoner', 'openai/o3-unknown']) {
        for (const reasoning of [false, true]) {
            const actual = getModelBudget(id, reasoning);
            assert.equal(actual.ticketCost, getTicketCost(id, reasoning));
            assert.equal(actual.spendingLimitUsd, spendingLimitUsdForTicketCost(getTicketCost(id, reasoning)));
        }
    }
});
