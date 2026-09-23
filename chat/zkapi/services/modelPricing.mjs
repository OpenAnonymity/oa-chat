export const DEFAULT_MODEL_ID = 'openai/gpt-5.6-sol';
export const DEFAULT_MODEL_NAME = 'OpenAI: GPT-5.6 Sol';

// Bundled fallbacks keep pricing useful for the local-daemon build and during
// catalog outages. Hosted builds refresh these fields from OpenRouter's public
// model catalog through a same-origin Vercel rewrite.
export const BUNDLED_MODEL_CATALOG = Object.freeze({
    'openai/gpt-5.6-sol': Object.freeze({
        name: DEFAULT_MODEL_NAME,
        context_length: 1_050_000,
        pricing: Object.freeze({
            prompt: '0.000002',
            completion: '0.00001',
            web_search: '0.01',
            input_cache_read: '0.0000002',
            input_cache_write: '0.0000025',
            overrides: Object.freeze([Object.freeze({
                min_prompt_tokens: 272_000,
                prompt: '0.000004',
                completion: '0.000015',
                input_cache_read: '0.0000004',
                input_cache_write: '0.000005'
            })])
        })
    }),
    'openai/gpt-4o-mini': Object.freeze({
        name: 'OpenAI: GPT-4o Mini',
        context_length: 128_000,
        pricing: Object.freeze({
            prompt: '0.00000015',
            completion: '0.0000006',
            input_cache_read: '0.000000075'
        })
    }),
    'anthropic/claude-opus-5': Object.freeze({
        name: 'Anthropic: Claude Opus 5',
        context_length: 1_000_000,
        pricing: Object.freeze({
            prompt: '0.000005',
            completion: '0.000025',
            web_search: '0.01',
            input_cache_read: '0.0000005',
            input_cache_write: '0.00000625'
        })
    }),
    'google/gemini-3.1-pro-preview': Object.freeze({
        name: 'Google: Gemini 3.1 Pro Preview',
        context_length: 1_048_576,
        pricing: Object.freeze({
            prompt: '0.000002',
            completion: '0.000012',
            internal_reasoning: '0.000012',
            input_cache_read: '0.0000002',
            overrides: Object.freeze([Object.freeze({
                min_prompt_tokens: 200_000,
                prompt: '0.000004',
                completion: '0.000018',
                input_cache_read: '0.0000004'
            })])
        })
    }),
    'x-ai/grok-4.6': Object.freeze({
        name: 'xAI: Grok 4.6',
        context_length: 500_000,
        pricing: Object.freeze({
            prompt: '0.000002',
            completion: '0.000006',
            web_search: '0.005',
            input_cache_read: '0.0000005',
            overrides: Object.freeze([Object.freeze({
                min_prompt_tokens: 200_000,
                prompt: '0.000004',
                completion: '0.000012',
                input_cache_read: '0.000001'
            })])
        })
    }),
    'deepseek/deepseek-v4-pro-0813': Object.freeze({
        name: 'DeepSeek: DeepSeek V4 Pro 0813',
        context_length: 1_048_576,
        pricing: Object.freeze({
            prompt: '0.000001122',
            completion: '0.000003366',
            input_cache_read: '0.0000000374'
        })
    }),
    'qwen/qwen3.8-2.4t-a95b': Object.freeze({
        name: 'Qwen: Qwen3.8 2.4T A95B',
        context_length: 1_048_576,
        pricing: Object.freeze({
            prompt: '0.000002',
            completion: '0.000006',
            input_cache_read: '0.00000025'
        })
    }),
    'moonshotai/kimi-k3': Object.freeze({
        name: 'MoonshotAI: Kimi K3',
        context_length: 1_048_576,
        pricing: Object.freeze({
            prompt: '0.000003',
            completion: '0.000015',
            input_cache_read: '0.0000003'
        })
    }),
    'google/gemini-3.1-flash-lite-preview': Object.freeze({
        name: 'Google: Gemini 3.1 Flash Lite Preview',
        context_length: 1_048_576,
        pricing: Object.freeze({
            prompt: '0.00000025',
            completion: '0.0000015',
            internal_reasoning: '0.0000015',
            input_cache_read: '0.000000025'
        })
    })
});

function finiteNonNegative(value) {
    if (value === null || value === undefined || value === '' || typeof value === 'boolean') {
        return null;
    }
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? number : null;
}

export function baseModelId(modelId) {
    return String(modelId || '').split(':')[0];
}

export function enrichConfiguredModels(configuredModels, liveModels = []) {
    const liveByExactId = new Map(
        (Array.isArray(liveModels) ? liveModels : [])
            .filter(model => model && typeof model.id === 'string')
            .map(model => [String(model.id), model])
    );

    return (Array.isArray(configuredModels) ? configuredModels : []).map(entry => {
        const configured = typeof entry === 'string' ? { id: entry } : { ...(entry || {}) };
        const configuredId = String(configured.id || '');
        const id = baseModelId(configuredId);
        if (!id) return configured;
        const fallback = BUNDLED_MODEL_CATALOG[id] || {};
        // Prefer an exact catalog ID. OpenRouter also advertises variants such
        // as `:batch`; collapsing those IDs into the base model would display
        // the discounted batch price for ordinary interactive requests.
        const live = liveByExactId.get(configuredId) || liveByExactId.get(id) || {};
        return {
            ...fallback,
            ...configured,
            ...live,
            id: configured.id,
            // Deployment metadata is authoritative for authorization/tags;
            // catalog data is presentation-only.
            owned_by: configured.owned_by,
            tags: configured.tags,
            pricing: live.pricing || configured.pricing || fallback.pricing,
            context_length: live.context_length || configured.context_length || fallback.context_length,
            top_provider: live.top_provider || configured.top_provider || fallback.top_provider
        };
    });
}

export function pricingForPromptTokens(pricing, promptTokens = 0) {
    if (!pricing || typeof pricing !== 'object') return null;
    const candidates = Array.isArray(pricing.overrides)
        ? pricing.overrides
            .filter(override => finiteNonNegative(override?.min_prompt_tokens) !== null
                && Number(promptTokens) >= Number(override.min_prompt_tokens))
            .sort((a, b) => Number(a.min_prompt_tokens) - Number(b.min_prompt_tokens))
        : [];
    return candidates.length ? { ...pricing, ...candidates.at(-1) } : pricing;
}

export function estimateUsageCostUsd(usage = {}, pricing = null) {
    const reportedCost = finiteNonNegative(usage.cost);
    if (reportedCost !== null) return reportedCost;

    const promptTokens = finiteNonNegative(usage.promptTokens ?? usage.prompt_tokens) || 0;
    const completionTokens = finiteNonNegative(usage.completionTokens ?? usage.completion_tokens) || 0;
    const effectivePricing = pricingForPromptTokens(pricing, promptTokens);
    const promptRate = finiteNonNegative(effectivePricing?.prompt);
    const completionRate = finiteNonNegative(effectivePricing?.completion);
    if (promptRate === null && completionRate === null) return null;

    const requestCost = finiteNonNegative(effectivePricing?.request) || 0;
    return requestCost
        + promptTokens * (promptRate || 0)
        + completionTokens * (completionRate || 0);
}

export function formatPerMillionTokenRate(value) {
    const perToken = finiteNonNegative(value);
    if (perToken === null) return null;
    const perMillion = perToken * 1_000_000;
    const maximumFractionDigits = perMillion >= 100 ? 0 : perMillion >= 1 ? 2 : 4;
    return new Intl.NumberFormat(undefined, {
        style: 'currency',
        currency: 'USD',
        minimumFractionDigits: 0,
        maximumFractionDigits
    }).format(perMillion);
}

export function formatModelPricing(pricing) {
    const input = formatPerMillionTokenRate(pricing?.prompt);
    const output = formatPerMillionTokenRate(pricing?.completion);
    if (!input && !output) return null;
    const prefix = Array.isArray(pricing?.overrides) && pricing.overrides.length ? 'From ' : '';
    if (!input) return `${prefix}${output}/M output`;
    if (!output) return `${prefix}${input}/M input`;
    return `${prefix}${input}/M input · ${output}/M output`;
}

export function formatExactTokenPricing(pricing) {
    const input = finiteNonNegative(pricing?.prompt);
    const output = finiteNonNegative(pricing?.completion);
    if (input === null && output === null) return '';
    const exact = value => `$${value.toLocaleString('en-US', {
        minimumFractionDigits: 0,
        maximumFractionDigits: 12,
        useGrouping: false
    })}/token`;
    const pair = (prompt, completion) => {
        const inputLabel = finiteNonNegative(prompt);
        const outputLabel = finiteNonNegative(completion);
        if (inputLabel === null) return `Output ${exact(outputLabel)}`;
        if (outputLabel === null) return `Input ${exact(inputLabel)}`;
        return `Input ${exact(inputLabel)} · output ${exact(outputLabel)}`;
    };
    const tiers = [pair(input, output)];
    for (const override of Array.isArray(pricing?.overrides) ? pricing.overrides : []) {
        const threshold = finiteNonNegative(override?.min_prompt_tokens);
        if (threshold === null) continue;
        tiers.push(`Above ${formatUsageTokens(threshold)} input tokens: ${pair(
            override.prompt ?? pricing.prompt,
            override.completion ?? pricing.completion
        )}`);
    }
    return tiers.join(' · ');
}

export function formatUsageTokens(value) {
    const tokens = finiteNonNegative(value);
    if (tokens === null) return null;
    return new Intl.NumberFormat(undefined, {
        notation: tokens >= 10_000 ? 'compact' : 'standard',
        maximumFractionDigits: tokens >= 10_000 ? 1 : 0
    }).format(Math.round(tokens));
}

export function formatEstimatedCost(value) {
    const amount = finiteNonNegative(value);
    if (amount === null) return null;
    if (amount > 0 && amount < 0.0001) return '<$0.0001';
    const maximumFractionDigits = amount >= 1 ? 2 : amount >= 0.01 ? 4 : 6;
    return new Intl.NumberFormat(undefined, {
        style: 'currency',
        currency: 'USD',
        minimumFractionDigits: 2,
        maximumFractionDigits
    }).format(amount);
}

export function estimateTextTokens(messages) {
    if (!Array.isArray(messages)) return 0;
    const textLength = content => {
        if (typeof content === 'string') return content.length;
        if (!Array.isArray(content)) return 0;
        return content.reduce((total, part) => {
            if (typeof part === 'string') return total + part.length;
            if (!part || typeof part !== 'object') return total;
            // Multimodal payloads can contain megabytes of base64 data. Those
            // bytes are not text tokens and providers meter the media through
            // modality-specific accounting returned in final usage.
            if (part.type === 'image_url') return total;
            if (part.type === 'file') {
                return total + String(part.file?.filename || '').length;
            }
            const textual = typeof part.text === 'string'
                ? part.text
                : typeof part.content === 'string'
                    ? part.content
                    : '';
            return total + textual.length;
        }, 0);
    };
    const characters = messages.reduce((total, message) => {
        return total + textLength(message?.content) + String(message?.role || '').length + 4;
    }, 0);
    return Math.max(1, Math.ceil(characters / 4));
}

export function buildUsageLedgerEntry({ id, kind = 'response', usage = {}, pricing = null, model = null } = {}) {
    if (!id) return null;
    const promptTokens = finiteNonNegative(usage.promptTokens ?? usage.prompt_tokens) || 0;
    const completionTokens = finiteNonNegative(usage.completionTokens ?? usage.completion_tokens) || 0;
    const totalTokens = finiteNonNegative(usage.totalTokens ?? usage.total_tokens)
        ?? (promptTokens + completionTokens);
    const reportedCost = finiteNonNegative(usage.cost);
    const estimatedCostUsd = estimateUsageCostUsd({
        ...usage,
        promptTokens,
        completionTokens
    }, pricing);
    return {
        id: String(id),
        kind: String(kind || 'response'),
        model: baseModelId(usage.model || model),
        promptTokens,
        completionTokens,
        totalTokens,
        estimatedCostUsd,
        providerReported: reportedCost !== null,
        pricing: pricing || null,
        updatedAt: Date.now()
    };
}

export function upsertUsageLedgerEntry(entries, nextEntry) {
    const normalized = Array.isArray(entries) ? [...entries] : [];
    if (!nextEntry?.id) return normalized;
    const index = normalized.findIndex(entry => entry?.id === nextEntry.id);
    if (index >= 0) normalized[index] = nextEntry;
    else normalized.push(nextEntry);
    return normalized;
}

export function mergeUsageLedgerEntries(entries, updates) {
    return (Array.isArray(updates) ? updates : []).reduce(
        (ledger, entry) => upsertUsageLedgerEntry(ledger, entry),
        Array.isArray(entries) ? [...entries] : []
    );
}

export function recoverUsageLedgerFromMessages(entries, messages) {
    let recovered = Array.isArray(entries) ? [...entries] : [];
    const knownIds = new Set(recovered.map(entry => entry?.id).filter(Boolean));
    for (const message of Array.isArray(messages) ? messages : []) {
        if (message?.role !== 'assistant'
            || message.zkapiUsageRecorded !== true
            || !message.id
            || knownIds.has(String(message.id))) continue;
        const hasUsage = [
            message.promptTokens,
            message.completionTokens,
            message.totalTokens,
            message.estimatedCostUsd,
            message.usagePricing
        ].some(value => value !== null && value !== undefined);
        if (!hasUsage) continue;
        const savedEstimate = finiteNonNegative(message.estimatedCostUsd);
        const entry = buildUsageLedgerEntry({
            id: message.id,
            kind: 'response',
            model: message.model,
            pricing: message.usagePricing || null,
            usage: {
                promptTokens: message.promptTokens,
                completionTokens: message.completionTokens,
                totalTokens: message.totalTokens,
                cost: savedEstimate
            }
        });
        if (!entry) continue;
        entry.providerReported = Boolean(message.usageProviderReported);
        if (savedEstimate !== null) entry.estimatedCostUsd = savedEstimate;
        recovered.push(entry);
        knownIds.add(entry.id);
    }
    return recovered;
}

export function summarizeUsageLedger(entries) {
    return (Array.isArray(entries) ? entries : []).reduce((summary, entry) => {
        summary.promptTokens += finiteNonNegative(entry?.promptTokens) || 0;
        summary.completionTokens += finiteNonNegative(entry?.completionTokens) || 0;
        summary.totalTokens += finiteNonNegative(entry?.totalTokens) || 0;
        summary.estimatedCostUsd += finiteNonNegative(entry?.estimatedCostUsd) || 0;
        summary.requests += 1;
        summary.hasEstimate = summary.hasEstimate || finiteNonNegative(entry?.estimatedCostUsd) !== null;
        summary.allProviderReported = summary.allProviderReported && Boolean(entry?.providerReported);
        return summary;
    }, {
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        estimatedCostUsd: 0,
        requests: 0,
        hasEstimate: false,
        allProviderReported: true
    });
}
