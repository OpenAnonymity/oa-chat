// What a failed inference request was, in a few fixed words. Shared by the
// resend rule, the error line and diagnostics; never the provider's text.

export const HTTP_STATUS_NAMES = Object.freeze({
    400: 'Bad request.',
    401: 'Unauthorized.',
    402: 'Payment required.',
    403: 'Forbidden.',
    404: 'Not found.',
    408: 'Request timeout.',
    413: 'Request too large.',
    429: 'Too many requests.',
    500: 'Internal server error.',
    502: 'Bad gateway.',
    503: 'Service unavailable.',
    504: 'Gateway timeout.'
});

const asStatus = value => {
    const n = typeof value === 'string' && /^\d{3}$/.test(value.trim()) ? Number(value) : value;
    return Number.isInteger(n) && n >= 100 && n <= 599 ? n : null;
};

/** The HTTP status the request failed with (not a code inside a 200 stream). */
export function httpStatusOf(error) {
    return asStatus(error?.status) ?? asStatus(error?.response?.status);
}

/**
 * The status a provider reported inside an HTTP 200 stream (OpenRouter's
 * `{"error":{"code":504}}` event), or null. A code the diagnostics layer
 * already rewrote (`PROVIDER_CODE_504`) reads the same.
 */
export function providerStatusOf(error) {
    if (error?.providerReported !== true) return null;
    const direct = asStatus(error.code);
    if (direct) return direct;
    const match = /^PROVIDER_CODE_(\d{3})$/.exec(String(error.code || ''));
    return match ? Number(match[1]) : null;
}

const TRANSIENT_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

/** Busy, rate-limited or unavailable: by HTTP status or the provider's code. */
export function isTransientStatusFailure(error) {
    const status = httpStatusOf(error) ?? providerStatusOf(error);
    return TRANSIENT_STATUSES.has(status);
}

/** A fetch that never reached a server. */
export function isNetworkFailure(error) {
    return error?.isNetworkError === true || error?.code === 'NETWORK_ERROR'
        || (error?.name === 'TypeError' && /fetch|network/i.test(String(error?.message || '')));
}

/**
 * The error line's text, for failures with a status to name. The reply
 * shows it after "Error:", the same words a Parallel lane uses
 * ("Gateway timeout (provider 504).").
 */
export function describeInferenceFailure(error) {
    const status = httpStatusOf(error) ?? providerStatusOf(error);
    if (status === 429) return 'The model is temporarily busy. Please try again.';
    return describeStatus(error);
}

function describeStatus(error) {
    const http = httpStatusOf(error);
    if (http && HTTP_STATUS_NAMES[http]) return `${HTTP_STATUS_NAMES[http].replace(/\.$/, '')} (HTTP ${http}).`;
    const provider = providerStatusOf(error);
    if (provider) {
        const name = HTTP_STATUS_NAMES[provider] || 'The provider reported an error.';
        return `${name.replace(/\.$/, '')} (provider ${provider}).`;
    }
    if (error?.providerReported === true) return 'The provider stopped the reply with an error.';
    return null;
}

/**
 * The reply's text for a busy or unavailable provider, once its resends are
 * spent, or null for any other failure (whose own message is kept: a 400's
 * "maximum context length" must still reach the person). Below a partial
 * answer the line is stored bare and rendered as "Error: …"; with nothing
 * shown it is the reply itself, so it carries the label.
 */
export function transientFailureReply(error, { hadPartial = false } = {}) {
    // The connection closed under the request: the relay or a transport
    // aborting it, or the browser's own "network error" mid-stream.
    if (error?.isTransportAbort === true || isNetworkFailure(error)) {
        return hadPartial ? 'The connection closed before the reply finished.'
            : '**Error:** The connection closed before the model replied.';
    }
    if (!isTransientStatusFailure(error) && error?.providerReported !== true) return null;
    const line = describeInferenceFailure(error);
    if (!line) return null;
    return hadPartial ? line : `**Error:** ${line}`;
}

/** Retry-After as milliseconds (seconds or an HTTP date), or null. */
export function parseRetryAfterMs(value, now = Date.now()) {
    if (value === null || value === undefined || value === '') return null;
    const text = String(value).trim();
    if (/^\d+(?:\.\d+)?$/.test(text)) return Math.round(Number(text) * 1000);
    const at = Date.parse(text);
    return Number.isFinite(at) ? Math.max(0, at - now) : null;
}

const headerOf = (headers, name) => {
    try { return headers?.get?.(name) ?? null; } catch { return null; }
};

/**
 * From a failed response's headers and OpenRouter's error object: the wait
 * the provider asked for, its X-RateLimit figures, and the upstream provider
 * named in `error.metadata.provider_name`. Fields absent when not sent.
 */
export function rateLimitDetails(headers, providerError) {
    const details = {};
    const retryAfterMs = parseRetryAfterMs(headerOf(headers, 'retry-after'));
    if (retryAfterMs !== null) details.retryAfterMs = retryAfterMs;
    const limit = headerOf(headers, 'x-ratelimit-limit');
    const remaining = headerOf(headers, 'x-ratelimit-remaining');
    const reset = headerOf(headers, 'x-ratelimit-reset');
    if (limit !== null || remaining !== null || reset !== null) {
        details.rateLimit = { limit, remaining, reset };
        // X-RateLimit-Reset is epoch milliseconds on OpenRouter.
        const resetAt = Number(reset);
        if (details.retryAfterMs === undefined && remaining !== null && Number(remaining) === 0 && Number.isFinite(resetAt) && resetAt > 1e12) {
            details.retryAfterMs = Math.max(0, resetAt - Date.now());
        }
    }
    const provider = providerError?.metadata?.provider_name;
    if (typeof provider === 'string' && provider.trim()) details.upstreamProvider = provider.trim().slice(0, 60);
    return details;
}
