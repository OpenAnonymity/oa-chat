import assert from 'node:assert/strict';
import test from 'node:test';
import {
    BUNDLED_MODEL_CATALOG,
    buildUsageLedgerEntry,
    enrichConfiguredModels,
    estimateUsageCostUsd,
    summarizeUsageLedger,
    estimateTextTokens,
    mergeUsageLedgerEntries,
    recoverUsageLedgerFromMessages,
    upsertUsageLedgerEntry
} from '../../chat/zkapi/services/modelPricing.mjs';

const GPT_5_6_PRICING = BUNDLED_MODEL_CATALOG['openai/gpt-5.6-sol'].pricing;

test('provider-reported cost takes precedence, including an exact zero', () => {
    const usage = { promptTokens: 1_000, completionTokens: 500 };

    assert.equal(estimateUsageCostUsd({ ...usage, cost: 0.123 }, GPT_5_6_PRICING), 0.123);
    assert.equal(estimateUsageCostUsd({ ...usage, cost: 0 }, GPT_5_6_PRICING), 0);
    assert.equal(estimateUsageCostUsd({ ...usage, cost: '0' }, GPT_5_6_PRICING), 0);
});

test('missing and null provider cost fall back to token pricing', () => {
    const usage = { promptTokens: 1_000, completionTokens: 500 };
    const expected = 1_000 * 0.000002 + 500 * 0.00001;

    assert.equal(estimateUsageCostUsd(usage, GPT_5_6_PRICING), expected);
    assert.equal(estimateUsageCostUsd({ ...usage, cost: null }, GPT_5_6_PRICING), expected);
});

test('long-context pricing activates at the advertised prompt-token threshold', () => {
    const belowThreshold = estimateUsageCostUsd({
        promptTokens: 271_999,
        completionTokens: 1_000
    }, GPT_5_6_PRICING);
    const atThreshold = estimateUsageCostUsd({
        promptTokens: 272_000,
        completionTokens: 1_000
    }, GPT_5_6_PRICING);

    assert.equal(belowThreshold, 271_999 * 0.000002 + 1_000 * 0.00001);
    assert.equal(atThreshold, 272_000 * 0.000004 + 1_000 * 0.000015);
    assert.ok(atThreshold > belowThreshold);
});

test('catalog enrichment preserves the deployment allowlist and adds presentation metadata only', () => {
    const configured = [
        {
            id: 'openai/gpt-5.6-sol',
            owned_by: 'deployment-openai',
            tags: ['allowed', 'frontier']
        },
        {
            id: 'openai/gpt-4o-mini',
            owned_by: 'deployment-openai',
            tags: ['allowed', 'economy']
        }
    ];
    const live = [
        {
            id: 'openai/gpt-5.6-sol',
            name: 'Live GPT-5.6 Sol',
            owned_by: 'untrusted-live-owner',
            tags: ['untrusted-live-tag'],
            context_length: 999_999,
            pricing: { prompt: '0.000003', completion: '0.000011' }
        },
        {
            id: 'openai/gpt-5.6-sol:batch',
            name: 'Live GPT-5.6 Sol (batch)',
            pricing: { prompt: '0.0000015', completion: '0.0000055' }
        },
        {
            id: 'unlisted/provider-model',
            name: 'Must not become selectable',
            pricing: { prompt: '0', completion: '0' }
        }
    ];

    const enriched = enrichConfiguredModels(configured, live);

    assert.deepEqual(enriched.map(model => model.id), configured.map(model => model.id));
    assert.equal(enriched.some(model => model.id === 'unlisted/provider-model'), false);
    assert.equal(enriched[0].name, 'Live GPT-5.6 Sol');
    assert.equal(enriched[0].context_length, 999_999);
    assert.deepEqual(enriched[0].pricing, live[0].pricing);
    assert.equal(enriched[0].owned_by, 'deployment-openai');
    assert.deepEqual(enriched[0].tags, ['allowed', 'frontier']);
    assert.deepEqual(enriched[1].pricing, BUNDLED_MODEL_CATALOG['openai/gpt-4o-mini'].pricing);
});

test('usage ledger upserts by request id and sums only the latest entry', () => {
    const firstVersion = buildUsageLedgerEntry({
        id: 'response:a',
        usage: {
            model: 'openai/gpt-5.6-sol',
            promptTokens: 10,
            completionTokens: 5,
            totalTokens: 15,
            cost: 0.02
        },
        pricing: GPT_5_6_PRICING
    });
    const updatedVersion = buildUsageLedgerEntry({
        id: 'response:a',
        usage: {
            model: 'openai/gpt-5.6-sol',
            promptTokens: 20,
            completionTokens: 10,
            totalTokens: 30,
            cost: 0.03
        },
        pricing: GPT_5_6_PRICING
    });
    const secondRequest = buildUsageLedgerEntry({
        id: 'title:b',
        kind: 'title',
        usage: {
            model: 'openai/gpt-4o-mini',
            promptTokens: 40,
            completionTokens: 20,
            totalTokens: 60,
            cost: 0.04
        },
        pricing: BUNDLED_MODEL_CATALOG['openai/gpt-4o-mini'].pricing
    });

    let ledger = upsertUsageLedgerEntry([], firstVersion);
    ledger = upsertUsageLedgerEntry(ledger, updatedVersion);
    ledger = upsertUsageLedgerEntry(ledger, secondRequest);

    assert.equal(ledger.length, 2);
    assert.equal(ledger.find(entry => entry.id === 'response:a').promptTokens, 20);
    assert.deepEqual(summarizeUsageLedger(ledger), {
        promptTokens: 60,
        completionTokens: 30,
        totalTokens: 90,
        estimatedCostUsd: 0.07,
        requests: 2,
        hasEstimate: true,
        allProviderReported: true
    });
});

test('text-token estimates exclude base64 image and file payload bytes', () => {
    const base64 = `data:application/octet-stream;base64,${'A'.repeat(1_000_000)}`;
    const estimate = estimateTextTokens([{
        role: 'user',
        content: [
            { type: 'text', text: 'Describe these attachments.' },
            { type: 'image_url', image_url: { url: base64 } },
            { type: 'file', file: { filename: 'report.pdf', file_data: base64 } }
        ]
    }]);

    assert.ok(estimate > 1);
    assert.ok(estimate < 100, `base64 bytes leaked into the text estimate: ${estimate}`);
});

test('persisted assistant usage recovers after reload without replacing final ledger entries', () => {
    const final = buildUsageLedgerEntry({
        id: 'already-final',
        usage: { promptTokens: 10, completionTokens: 5, cost: 0.25 }
    });
    const recovered = recoverUsageLedgerFromMessages([final], [
        {
            id: 'already-final',
            role: 'assistant',
            promptTokens: 1,
            completionTokens: 1,
            estimatedCostUsd: 0.01,
            usageProviderReported: false,
            zkapiUsageRecorded: true
        },
        {
            id: 'crash-partial',
            role: 'assistant',
            promptTokens: 100,
            completionTokens: 20,
            totalTokens: 120,
            estimatedCostUsd: 0.0042,
            usageProviderReported: false,
            zkapiUsageRecorded: true,
            usagePricing: { prompt: '0.000002', completion: '0.00001' }
        },
        {
            id: 'untrusted-copy',
            role: 'assistant',
            promptTokens: 9_999,
            estimatedCostUsd: 99
        },
        { id: 'old-message', role: 'assistant', tokenCount: 99 }
    ]);

    assert.equal(recovered.length, 2);
    assert.equal(recovered[0].estimatedCostUsd, 0.25);
    assert.equal(recovered[1].id, 'crash-partial');
    assert.equal(recovered[1].estimatedCostUsd, 0.0042);
    assert.equal(recovered[1].providerReported, false);

    const liveReplacement = { ...recovered[1], completionTokens: 30, estimatedCostUsd: 0.005 };
    const merged = mergeUsageLedgerEntries(recovered, [liveReplacement]);
    assert.equal(merged.length, 2);
    assert.equal(merged.find(entry => entry.id === 'crash-partial').completionTokens, 30);
});
