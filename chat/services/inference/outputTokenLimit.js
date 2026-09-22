export const MAX_OUTPUT_TOKENS = 30000;

// Apply the product ceiling without raising a smaller helper, model or budget
// limit. This is generation only; input context does not consume this allowance.
export function applyOutputTokenLimit(body, model = null, callerLimit = MAX_OUTPUT_TOKENS) {
    const limits = [
        MAX_OUTPUT_TOKENS,
        callerLimit,
        body.max_tokens,
        body.max_completion_tokens,
        model?.top_provider?.max_completion_tokens
    ].filter(value => Number.isInteger(value) && value > 0);
    const limit = Math.min(...limits);
    if (body.max_completion_tokens !== undefined && body.max_tokens === undefined) {
        return { ...body, max_completion_tokens: limit };
    }
    return {
        ...body,
        max_tokens: limit,
        ...(body.max_completion_tokens !== undefined ? { max_completion_tokens: limit } : {})
    };
}
