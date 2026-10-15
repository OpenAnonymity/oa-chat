import { discardResponseBody, waitForSignal } from './inference/reliability.js';
/**
 * Fetch Retry Utility
 * Industry-standard retry mechanism with exponential backoff and jitter.
 * 
 * Features:
 * - Configurable retry count (default: 3 attempts)
 * - Exponential backoff with jitter (prevents thundering herd)
 * - Respects Retry-After header for 429 responses
 * - Configurable timeout per request
 * - Transport-agnostic: accepts any fetch function via config.fetchFn
 */

// HTTP status codes that are safe to retry (transient errors)
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

// HTTP status codes that should never be retried (permanent errors)
const NON_RETRYABLE_STATUS = new Set([400, 401, 402, 403, 404, 409, 413, 422]);

// Default configuration
const DEFAULT_CONFIG = {
    maxAttempts: 3,
    baseDelayMs: 300,
    maxDelayMs: 5000,
    timeoutMs: 30000
};

/**
 * Check if an error or response is retryable.
 * @param {Error|null} error - The error that occurred (if any)
 * @param {Response|null} response - The HTTP response (if any)
 * @returns {boolean} True if the request should be retried
 */
function isRetryable(error, response) {
    // Network-level failures (fetch itself failed)
    if (error) {
        if (error.isRequestTimeout || error.isUserAbort) return false;
        if (error.name === 'TypeError') return true;  // Network failure
        if (error.name === 'AbortError') return true; // Timeout (our timeout, not user abort)
        if (error.message?.includes('Failed to fetch')) return true;
        if (error.message?.includes('NetworkError')) return true;
        if (error.message?.includes('fetch')) return true;
    }

    // HTTP status codes
    if (response) {
        if (RETRYABLE_STATUS.has(response.status)) return true;
        if (NON_RETRYABLE_STATUS.has(response.status)) return false;
    }

    return false;
}

/**
 * Parse Retry-After header from response.
 * @param {Response} response - HTTP response
 * @returns {number|null} Delay in milliseconds, or null if not present
 */
function parseRetryAfter(response) {
    const header = response?.headers?.get('Retry-After');
    if (!header) return null;

    // Try parsing as seconds (most common)
    const seconds = parseInt(header, 10);
    if (!isNaN(seconds)) return seconds * 1000;

    // Try parsing as HTTP date
    const date = Date.parse(header);
    if (!isNaN(date)) {
        const delay = date - Date.now();
        return delay > 0 ? delay : null;
    }

    return null;
}

/**
 * Calculate delay for next retry attempt.
 * @param {number} attempt - Current attempt number (0-indexed)
 * @param {number} baseDelayMs - Base delay in milliseconds
 * @param {number} maxDelayMs - Maximum delay in milliseconds
 * @param {number|null} retryAfterMs - Retry-After header value (if any)
 * @returns {number} Delay in milliseconds
 */
function getDelay(attempt, baseDelayMs, maxDelayMs, retryAfterMs = null) {
    // Prefer Retry-After header if provided (for 429)
    if (retryAfterMs !== null) {
        return Math.min(retryAfterMs, maxDelayMs);
    }

    // Exponential backoff with jitter
    const exponential = baseDelayMs * Math.pow(2, attempt);
    const jitter = Math.random() * baseDelayMs;
    return Math.min(exponential + jitter, maxDelayMs);
}

/**
 * Sleep for a specified duration.
 * @param {number} ms - Duration in milliseconds
 * @returns {Promise<void>}
 */
async function sleep(ms, signal) {
    let timer;
    try {
        await waitForSignal(new Promise(resolve => { timer = setTimeout(resolve, ms); }), signal);
    } finally {
        clearTimeout(timer);
    }
}

function userAbortError() {
    return Object.assign(new Error('Request aborted'), { name: 'AbortError', isUserAbort: true });
}


/**
 * Fetch with automatic retry on transient failures.
 * 
 * @param {string|Request} url - URL or Request object
 * @param {RequestInit} [init={}] - Fetch options
 * @param {Object} [config={}] - Retry configuration
 * @param {number} [config.maxAttempts=3] - Maximum number of attempts
 * @param {number} [config.baseDelayMs=300] - Base delay between retries
 * @param {number} [config.maxDelayMs=5000] - Maximum delay between retries
 * @param {number} [config.timeoutMs=30000] - Timeout per request
 * @param {function} [config.fetchFn=fetch] - Fetch function to use (e.g., networkProxy.fetch.bind(networkProxy))
 * @param {Object} [config.fetchConfig={}] - Extra config to pass to fetchFn (3rd argument)
 * @param {AbortSignal} [config.signal] - External abort signal (user cancellation)
 * @param {string} [config.context='Request'] - Context for error messages
 * @param {function} [config.onRetry] - Callback called before each retry (attempt, error, response)
 * @returns {Promise<Response>} The HTTP response
 * @throws {Error} If all attempts fail or a non-retryable error occurs
 */
export async function fetchRetry(url, init = {}, config = {}) {
    const { response } = await fetchRetryWithDeadline(url, init, config, false);
    return response;
}

/**
 * Same loop as fetchRetry. With holdDeadline the per-attempt timeout keeps
 * running after the headers arrive, so the caller can read the body under the
 * same deadline; it must call release() when done. Without it the timeout is
 * cleared as soon as the response is returned, as before.
 * @returns {Promise<{response: Response, signal: AbortSignal|null, release: function}>}
 */
async function fetchRetryWithDeadline(url, init = {}, config = {}, holdDeadline = false) {
    const {
        maxAttempts = DEFAULT_CONFIG.maxAttempts,
        baseDelayMs = DEFAULT_CONFIG.baseDelayMs,
        maxDelayMs = DEFAULT_CONFIG.maxDelayMs,
        timeoutMs = DEFAULT_CONFIG.timeoutMs,
        fetchFn = fetch,
        fetchConfig = {},
        signal: configuredSignal,
        context = 'Request',
        onRetry
    } = config;

    const externalSignal = configuredSignal || init.signal;
    let lastError = null;
    let lastResponse = null;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        // Check if externally aborted before attempting
        if (externalSignal?.aborted) {
            const abortError = new Error('Request aborted');
            abortError.name = 'AbortError';
            abortError.isUserAbort = true;
            throw abortError;
        }

        let timeoutId = null;
        let handedOff = false;
        let unlink = () => {};
        const release = () => { clearTimeout(timeoutId); timeoutId = null; unlink(); };
        try {
            // Determine the signal to use
            let fetchSignal = externalSignal || null;

            // Only create timeout if timeoutMs is set (> 0)
            if (timeoutMs && timeoutMs > 0) {
                const timeoutController = new AbortController();
                timeoutId = setTimeout(() => timeoutController.abort(Object.assign(
                    new Error(`${context} timed out after ${timeoutMs}ms. Please try again.`),
                    { name: 'TimeoutError', isRequestTimeout: true }
                )), timeoutMs);

                // Combine external signal with timeout
                if (externalSignal) {
                    const linked = createLinkedSignal(externalSignal, timeoutController.signal);
                    fetchSignal = linked.signal;
                    unlink = linked.dispose;
                } else {
                    fetchSignal = timeoutController.signal;
                }
            }

            const fetchInit = {
                ...init,
                ...(fetchSignal && { signal: fetchSignal })
            };

            // Make the request using the provided fetch function
            const pendingResponse = Promise.resolve(fetchFn(url, fetchInit, fetchConfig));
            // A relay may ignore abort. Bound the caller's wait and dispose any
            // response that arrives after it stopped; never replay a timeout.
            pendingResponse.then(response => {
                if (fetchSignal?.aborted) discardResponseBody(response.body);
            }, () => {});
            const response = await waitForSignal(pendingResponse, fetchSignal);

            // Check if response indicates a retryable error
            if (RETRYABLE_STATUS.has(response.status)) {
                lastResponse = response;
                lastError = new Error(`${context} failed with status ${response.status}`);
                lastError.status = response.status;
                lastError.response = response;

                // Check if we should retry
                if (attempt < maxAttempts - 1) {
                    discardResponseBody(response.body);
                    const retryAfterMs = parseRetryAfter(response);
                    const delay = getDelay(attempt, baseDelayMs, maxDelayMs, retryAfterMs);

                    if (onRetry) {
                        onRetry(attempt + 1, lastError, response);
                    }

                    console.warn(`⚠️ ${context} attempt ${attempt + 1}/${maxAttempts} failed (${response.status}). Retrying in ${Math.round(delay)}ms...`);
                    await sleep(delay, externalSignal);
                    continue;
                }
            }

            // Non-retryable status or success - return response
            if (holdDeadline) {
                handedOff = true;
                return { response, signal: fetchSignal, release };
            }
            // Raw callers own body consumption and cancellation. On older
            // browsers without AbortSignal.any, keep the external link alive.
            unlink = () => {};
            return { response, signal: fetchSignal, release: () => {} };

        } catch (error) {
            // Check if this is a user-initiated abort
            if (externalSignal?.aborted) throw userAbortError();

            lastError = error;

            // Check if error is retryable
            if (isRetryable(error, null) && attempt < maxAttempts - 1) {
                const delay = getDelay(attempt, baseDelayMs, maxDelayMs);

                if (onRetry) {
                    onRetry(attempt + 1, error, null);
                }

                // Make timeout errors more user-friendly
                const errorMsg = error.name === 'AbortError'
                    ? 'Request timed out'
                    : error.message;

                console.warn(`⚠️ ${context} attempt ${attempt + 1}/${maxAttempts} failed: ${errorMsg}. Retrying in ${Math.round(delay)}ms...`);
                try { await sleep(delay, externalSignal); }
                catch { throw userAbortError(); }
                continue;
            }

            // Non-retryable error or final attempt
            throw error;
        } finally {
            if (!handedOff) release();
        }
    }

    // All attempts exhausted
    if (lastError) {
        lastError.message = `${context} failed after ${maxAttempts} attempts: ${lastError.message}`;
        throw lastError;
    }

    throw new Error(`${context} failed after ${maxAttempts} attempts`);
}

/**
 * Create an AbortSignal that aborts when either of two signals abort.
 * @param {AbortSignal} signal1 - First signal
 * @param {AbortSignal} signal2 - Second signal
 * @returns {AbortSignal} Combined signal
 */
function createLinkedSignal(signal1, signal2) {
    // Native composition keeps cancellation alive for raw streaming responses
    // without retaining one listener on the caller for every completed request.
    if (typeof AbortSignal.any === 'function') {
        return { signal: AbortSignal.any([signal1, signal2]), dispose() {} };
    }
    const controller = new AbortController();

    const abort1 = () => controller.abort(signal1.reason);
    const abort2 = () => controller.abort(signal2.reason);
    if (signal1.aborted) abort1();
    else if (signal2.aborted) abort2();
    else {
        signal1.addEventListener('abort', abort1, { once: true });
        signal2.addEventListener('abort', abort2, { once: true });
    }
    return {
        signal: controller.signal,
        dispose() {
            signal1.removeEventListener('abort', abort1);
            signal2.removeEventListener('abort', abort2);
        }
    };
}

/**
 * Fetch with retry and automatic JSON parsing.
 * Returns both the response and parsed data.
 * 
 * @param {string|Request} url - URL or Request object
 * @param {RequestInit} [init={}] - Fetch options
 * @param {Object} [config={}] - Retry configuration (see fetchRetry)
 * @returns {Promise<{response: Response, data: any}>} Response and parsed JSON data
 * @throws {Error} If request fails or JSON parsing fails
 */
export async function fetchRetryJson(url, init = {}, config = {}) {
    // The request deadline covers the body too: a server that sends headers
    // and then stalls must not hold the caller (and any lock it owns) forever.
    const { response, signal, release } = await fetchRetryWithDeadline(url, init, config, true);
    let text;
    try {
        text = await readBodyTextWithDeadline(response, signal, { ...config, signal: config.signal || init.signal });
    } finally {
        release();
    }

    // Try to parse JSON
    const contentType = response.headers.get('content-type') || '';

    let data = null;
    if (text && (contentType.includes('application/json') || text.trim().startsWith('{') || text.trim().startsWith('['))) {
        try {
            data = JSON.parse(text);
        } catch (e) {
            // If response is OK but JSON is invalid, still return the text
            if (response.ok) {
                console.warn(`${config.context || 'Request'}: Response OK but JSON parse failed`);
            }
        }
    }

    return { response, data, text };
}

function cancelResponseBody(response) {
    try {
        const cancelled = response?.body?.cancel?.();
        if (cancelled && typeof cancelled.catch === 'function') cancelled.catch(() => {});
    } catch {
        // A locked or already-consumed body cannot be cancelled; the read is
        // abandoned either way.
    }
}

function createBodyAbortError(config, signal) {
    const userAbort = !!config.signal?.aborted;
    const error = new Error(userAbort
        ? 'Request aborted'
        : `${config.context || 'Request'} response body timed out after ${config.timeoutMs ?? DEFAULT_CONFIG.timeoutMs}ms`);
    error.name = userAbort ? 'AbortError' : 'TimeoutError';
    error.isUserAbort = userAbort;
    error.isBodyTimeout = !userAbort;
    error.signal = signal;
    return error;
}

/**
 * Read a response body as text, giving up when the request signal aborts.
 * Native fetch rejects the read itself when its signal aborts; the race also
 * covers fetch-compatible transports (the relay) that ignore the signal once
 * headers have been delivered.
 */
export async function readBodyTextWithDeadline(response, signal, config = {}) {
    // Own the reader: response.text() locks the body, preventing body.cancel()
    // from releasing a stalled transport when the deadline expires.
    const reader = response.body?.getReader?.();
    let complete = false;
    try {
        if (signal?.aborted) throw createBodyAbortError(config, signal);
        if (!reader) return await waitForSignal(response.text(), signal);
        const decoder = new TextDecoder();
        let text = '';
        while (true) {
            const { done, value } = await waitForSignal(reader.read(), signal);
            if (done) { complete = true; return text + decoder.decode(); }
            text += decoder.decode(value, { stream: true });
        }
    } catch (error) {
        if (signal?.aborted) throw createBodyAbortError(config, signal);
        throw error;
    } finally {
        if (!complete) {
            if (reader) discardResponseBody(reader);
            else cancelResponseBody(response);
        }
        reader?.releaseLock();
    }
}

// Export default config for reference
export { DEFAULT_CONFIG, RETRYABLE_STATUS, NON_RETRYABLE_STATUS };

export default fetchRetry;
