import { discardResponseBody, readInferenceErrorBody } from './reliability.js';

// Only rejected HTTP requests are retried here. A successful response body is
// never read or replayed, so partial generations cannot be duplicated.
export function getCreditLimitSource(data) {
    return data?.error?.metadata?.limit_source || null;
}

export function parseOutputAffordability(message) {
    const match = typeof message === 'string' && message.match(
        /requested up to ([\d,]+) tokens, but can only afford ([\d,]+)\b/i
    );
    if (!match) return null;
    const requested = Number(match[1].replaceAll(',', ''));
    const affordable = Number(match[2].replaceAll(',', ''));
    if (!Number.isSafeInteger(requested) || !Number.isSafeInteger(affordable) ||
        requested <= 0 || affordable < 0 || affordable >= requested) return null;
    return { requested, affordable };
}

export function getCreditErrorCode(data) {
    const source = getCreditLimitSource(data);
    if (source === 'openrouter_in_flight_budget') return 'INFERENCE_CREDIT_BUSY';
    if (parseOutputAffordability(data?.error?.message)?.affordable > 0) return 'INFERENCE_OUTPUT_BUDGET';
    if (source === 'openrouter_credits') return 'INFERENCE_PROVIDER_CREDITS';
    if (source === 'openrouter_key_limit') return 'INFERENCE_KEY_CREDITS';
    return 'INFERENCE_CREDIT_LIMIT';
}

function abortIfNeeded(signal) {
    if (signal?.aborted) throw new DOMException('Request aborted', 'AbortError');
}

function waitForRetry(ms, signal) {
    abortIfNeeded(signal);
    return new Promise((resolve, reject) => {
        const onAbort = () => {
            clearTimeout(timer);
            signal.removeEventListener('abort', onAbort);
            reject(new DOMException('Request aborted', 'AbortError'));
        };
        const timer = setTimeout(() => {
            signal?.removeEventListener('abort', onAbort);
            resolve();
        }, ms);
        signal?.addEventListener('abort', onAbort, { once: true });
    });
}

function retryDelay(response) {
    const header = response.headers?.get('Retry-After');
    if (!header) return 1000;
    const seconds = Number(header);
    const delay = Number.isFinite(seconds)
        ? seconds * 1000
        : Date.parse(header) - Date.now();
    return Number.isFinite(delay) ? Math.max(0, delay) : 1000;
}

export async function fetchWithOpenRouterCreditRecovery(fetchRequest, url, init, config = {}) {
    // Other providers can reuse the API adapter without inheriting this policy.
    if (url !== 'https://openrouter.ai/api/v1/chat/completions') {
        return fetchRequest(url, init, config);
    }
    let request = init;
    let reducedOutput = false;
    let settlementRetries = 0;
    for (;;) {
        abortIfNeeded(config.signal);
        const response = await fetchRequest(url, request, config);
        if (response.status !== 402) return response;
        let data;
        try {
            data = await readInferenceErrorBody(response.clone(), config.signal);
        } catch (error) {
            // The watchdog may stop a 402 before the final response reaches the
            // caller. Cancel the original too, so neither tee branch keeps reading.
            discardResponseBody(response.body);
            throw error;
        }
        const source = getCreditLimitSource(data);
        if (source === 'openrouter_in_flight_budget' && settlementRetries < 2) {
            const delay = retryDelay(response);
            // Never shorten a provider's requested wait. Long waits surface to
            // the caller instead of leaving the composer pending indefinitely.
            if (delay > 30000) return response;
            settlementRetries += 1;
            discardResponseBody(response.body);
            await waitForRetry(delay, config.signal);
            continue;
        }
        const budget = parseOutputAffordability(data?.error?.message);
        if (!reducedOutput && source !== 'openrouter_in_flight_budget' &&
            (!source || source === 'openrouter_key_limit' || source === 'openrouter_credits') &&
            budget?.affordable > 0) {
            const body = JSON.parse(request.body);
            const currentLimit = body.max_tokens ?? body.max_completion_tokens ?? budget.requested;
            // Keep headroom for concurrent helper calls and settlement. Respect
            // any smaller product-supplied cap, including reasoning budgets.
            const maxTokens = Math.floor(Math.min(budget.affordable * 0.9, currentLimit - 1));
            if (maxTokens < 1) return response;
            const field = body.max_completion_tokens !== undefined && body.max_tokens === undefined
                ? 'max_completion_tokens' : 'max_tokens';
            request = { ...request, body: JSON.stringify({ ...body, [field]: maxTokens }) };
            reducedOutput = true;
            discardResponseBody(response.body);
            continue;
        }
        return response;
    }
}
