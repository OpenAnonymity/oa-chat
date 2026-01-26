/**
 * Fetch Retry Utility
 * Industry-standard retry mechanism with exponential backoff and jitter.
 * 
 * Features:
 * - Configurable retry count (default: 3 attempts)
 * - Exponential backoff with jitter (prevents thundering herd)
 * - Respects Retry-After header for 429 responses
 * - Configurable timeout per request
 * - Works with both native fetch and networkProxy.fetch
 */

// Lazy-load networkProxy to avoid circular dependency:
// preferencesStore → syncService → fetchRetry → networkProxy → preferencesStore
let _networkProxy = null;
async function getNetworkProxy() {
    if (!_networkProxy) {
        const module = await import('./networkProxy.js');
        _networkProxy = module.default;
    }
    return _networkProxy;
}

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
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
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
 * @param {boolean} [config.useProxy=true] - Use networkProxy.fetch instead of native fetch
 * @param {Object} [config.proxyConfig={}] - Config to pass to networkProxy.fetch
 * @param {AbortSignal} [config.signal] - External abort signal (user cancellation)
 * @param {string} [config.context='Request'] - Context for error messages
 * @param {function} [config.onRetry] - Callback called before each retry (attempt, error, response)
 * @returns {Promise<Response>} The HTTP response
 * @throws {Error} If all attempts fail or a non-retryable error occurs
 */
export async function fetchRetry(url, init = {}, config = {}) {
    const {
        maxAttempts = DEFAULT_CONFIG.maxAttempts,
        baseDelayMs = DEFAULT_CONFIG.baseDelayMs,
        maxDelayMs = DEFAULT_CONFIG.maxDelayMs,
        timeoutMs = DEFAULT_CONFIG.timeoutMs,
        useProxy = true,
        proxyConfig = {},
        signal: externalSignal,
        context = 'Request',
        onRetry
    } = config;

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
        try {
            // Determine the signal to use
            let fetchSignal = externalSignal || null;

            // Only create timeout if timeoutMs is set (> 0)
            if (timeoutMs && timeoutMs > 0) {
                const timeoutController = new AbortController();
                timeoutId = setTimeout(() => timeoutController.abort(), timeoutMs);

                // Combine external signal with timeout
                fetchSignal = externalSignal
                    ? createLinkedSignal(externalSignal, timeoutController.signal)
                    : timeoutController.signal;
            }

            const fetchInit = {
                ...init,
                ...(fetchSignal && { signal: fetchSignal })
            };

            // Make the request (lazy-load networkProxy to avoid circular dependency)
            let fetchFn = fetch;
            if (useProxy) {
                const proxy = await getNetworkProxy();
                fetchFn = proxy.fetch.bind(proxy);
            }
            const response = await fetchFn(url, fetchInit, proxyConfig);

            // Check if response indicates a retryable error
            if (RETRYABLE_STATUS.has(response.status)) {
                lastResponse = response;
                lastError = new Error(`${context} failed with status ${response.status}`);
                lastError.status = response.status;
                lastError.response = response;

                // Check if we should retry
                if (attempt < maxAttempts - 1) {
                    const retryAfterMs = parseRetryAfter(response);
                    const delay = getDelay(attempt, baseDelayMs, maxDelayMs, retryAfterMs);

                    if (onRetry) {
                        onRetry(attempt + 1, lastError, response);
                    }

                    console.warn(`⚠️ ${context} attempt ${attempt + 1}/${maxAttempts} failed (${response.status}). Retrying in ${Math.round(delay)}ms...`);
                    await sleep(delay);
                    continue;
                }
            }

            // Non-retryable status or success - return response
            return response;

        } catch (error) {
            // Check if this is a user-initiated abort
            if (error.name === 'AbortError' && externalSignal?.aborted) {
                error.isUserAbort = true;
                throw error;
            }

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
                await sleep(delay);
                continue;
            }

            // Non-retryable error or final attempt
            throw error;
        } finally {
            if (timeoutId !== null) {
                clearTimeout(timeoutId);
            }
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
    const controller = new AbortController();

    const abort = () => controller.abort();

    if (signal1.aborted || signal2.aborted) {
        controller.abort();
    } else {
        signal1.addEventListener('abort', abort, { once: true });
        signal2.addEventListener('abort', abort, { once: true });
    }

    return controller.signal;
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
    const response = await fetchRetry(url, init, config);

    // Try to parse JSON
    const contentType = response.headers.get('content-type') || '';
    const text = await response.text();

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

// Export default config for reference
export { DEFAULT_CONFIG, RETRYABLE_STATUS, NON_RETRYABLE_STATUS };

export default fetchRetry;
