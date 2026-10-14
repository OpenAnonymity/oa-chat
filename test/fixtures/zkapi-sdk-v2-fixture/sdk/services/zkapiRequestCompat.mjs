// FIXTURE NOTE: verbatim copy of the real SDK sdk/services/zkapiRequestCompat.mjs (0.2.0, 82c8504).
// Reviewed public spending buckets, never the user's exact private balance.
// Host applications map their model tiers to these protocol-supported caps.
export const CHAT_SPENDING_TIER_USD = Object.freeze([1, 2, 3, 4.5, 6]);

// A high, deliberately conservative frontier-model price. It keeps OpenRouter
// from preflighting a model's entire context against the child key without
// recreating the former small fixed token quota.
export const CONSERVATIVE_COMPLETION_PRICE_USD_PER_TOKEN = 0.00005;
export const CHAT_OUTPUT_BUDGET_FRACTION = 0.9;
export const MAX_COMPATIBILITY_OUTPUT_TOKENS = 128_000;

function positiveNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : null;
}

export function ensureDirectCompletionLimit(body, { spendingLimitUsd, model } = {}) {
    const normalized = { ...(body || {}) };
    if (Object.hasOwn(normalized, 'max_tokens')
        || Object.hasOwn(normalized, 'max_completion_tokens')) {
        return normalized;
    }
    if (Object.hasOwn(normalized, 'max_output_tokens')) {
        normalized.max_tokens = normalized.max_output_tokens;
        delete normalized.max_output_tokens;
        return normalized;
    }

    const budget = positiveNumber(spendingLimitUsd);
    if (!budget) return normalized;

    const advertisedCompletionPrice = positiveNumber(model?.pricing?.completion);
    const completionPrice = Math.max(
        advertisedCompletionPrice || 0,
        CONSERVATIVE_COMPLETION_PRICE_USD_PER_TOKEN
    );
    const advertisedMaximum = positiveNumber(model?.top_provider?.max_completion_tokens);
    const maximum = Math.min(
        advertisedMaximum || MAX_COMPATIBILITY_OUTPUT_TOKENS,
        MAX_COMPATIBILITY_OUTPUT_TOKENS
    );
    normalized.max_tokens = Math.max(1, Math.min(
        maximum,
        Math.floor((budget * CHAT_OUTPUT_BUDGET_FRACTION) / completionPrice)
    ));
    return normalized;
}
