import { discardResponseBody, readInferenceErrorBody } from './reliability.js';
import { bearerToken, getFreshKeyReadiness, markInferenceKeyAccepted, readinessClock } from './keyReadiness.js';

// Only rejected HTTP requests are retried here. A successful response body is
// never read or replayed, so partial generations cannot be duplicated.
export function getCreditLimitSource(data) {
    return data?.error?.metadata?.limit_source || null;
}

// Since October 2026 OpenRouter reports a spent per-key limit as HTTP 403
// with "Key limit exceeded (total limit). Manage it using https://openrouter.ai/..."
// and no metadata, where it used to send 402 with limit_source
// "openrouter_key_limit". Only the message identifies it.
const KEY_LIMIT_EXCEEDED = /\bkey limit exceeded\b/i;

export function isKeyLimitExceededMessage(message) {
    return typeof message === 'string' && KEY_LIMIT_EXCEEDED.test(message);
}

export function isKeyLimitExceededResponse(status, data, message = null) {
    if (status !== 402 && status !== 403) return false;
    if (getCreditLimitSource(data) === 'openrouter_key_limit') return true;
    return [data?.error?.message, data?.message, message]
        .some(text => isKeyLimitExceededMessage(text));
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
    if (source === 'openrouter_key_limit' || isKeyLimitExceededMessage(data?.error?.message)) return 'INFERENCE_KEY_CREDITS';
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

// A user reported that an inference HTTP 401 cleared after pressing Retry a
// few times; whether OpenRouter rejects valid keys transiently is unverified.
// Resend the identical request (same credential, body and request access
// scope) after these pauses. No new access is requested here.
export const INFERENCE_AUTH_RETRY_DELAYS_MS = Object.freeze([1000, 2000, 4000]);
// A key this tab just received and verified may also be rejected for about
// half a minute before the provider accepts it. Inside its absolute readiness
// window (keyReadiness.js) the same request keeps being resent: 1, 2, 4 s, then
// every 5 s, never past the window, the key's expiry or this many requests.
export const FRESH_KEY_AUTH_RETRY_DELAYS_MS = Object.freeze([1000, 2000, 4000]);
export const FRESH_KEY_AUTH_RETRY_INTERVAL_MS = 5000;
export const FRESH_KEY_MAX_AUTH_ATTEMPTS = 16;
const authRetryCounts = new WeakMap();

const defaultAuthClock = Object.freeze({
    ...readinessClock,
    sleep: (ms, signal) => waitForRetry(ms, signal)
});

// Whether a send `delay` ms from now still falls inside a call's window
// snapshot: before its fixed monotonic deadline and the key's expiry.
function insideWindow(readinessWindow, clock, delay = 0) {
    if (clock.now() + delay >= readinessWindow.deadline) return false;
    return !(Number.isFinite(readinessWindow.expiresAtMs) && clock.wallNow() + delay >= readinessWindow.expiresAtMs);
}

// The pause before the next same-request resend, given `resends` already made,
// or null when the budget is spent. A call that started inside a key's window
// keeps that window's fixed deadline and expiry until it ends (another
// caller's acceptance only closes the window for later calls), and never
// falls back to the short policy.
function nextAuthRetryDelay(resends, clock, shortDelays, readinessWindow) {
    if (!readinessWindow) return resends < shortDelays.length ? shortDelays[resends] : null;
    if (resends + 1 >= FRESH_KEY_MAX_AUTH_ATTEMPTS) return null;
    const delay = resends < FRESH_KEY_AUTH_RETRY_DELAYS_MS.length
        ? FRESH_KEY_AUTH_RETRY_DELAYS_MS[resends] : FRESH_KEY_AUTH_RETRY_INTERVAL_MS;
    return insideWindow(readinessWindow, clock, delay) ? delay : null;
}

/** Whether this final 401 went through the same-request resend policy. */
export function isInferenceAuthRetryResponse(response) {
    return Boolean(response && typeof response === 'object' && authRetryCounts.has(response));
}

/** Same-request 401 retries already spent before this final response. */
export function getInferenceAuthRetryCount(response) {
    return isInferenceAuthRetryResponse(response) ? authRetryCounts.get(response) : 0;
}

export async function fetchWithOpenRouterCreditRecovery(fetchRequest, url, init, config = {}) {
    const { authRetryDelaysMs: requestedDelays, authClock: requestedClock, ...transportConfig } = config;
    const authRetryDelaysMs = Array.isArray(requestedDelays) ? requestedDelays : INFERENCE_AUTH_RETRY_DELAYS_MS;
    const authClock = { ...defaultAuthClock, ...(requestedClock || {}) };
    // Other providers can reuse the API adapter without inheriting this policy.
    if (url !== 'https://openrouter.ai/api/v1/chat/completions') {
        return fetchRequest(url, init, transportConfig);
    }
    let request = init;
    let reducedOutput = false;
    let settlementRetries = 0;
    let authRetries = 0;
    let lastRejected = null;
    const key = bearerToken(init?.headers);
    // Decided once, at the first send: a snapshot of the fresh key's window
    // (fixed deadline and expiry), or null for the short policy.
    const readinessWindow = getFreshKeyReadiness(key, authClock);
    for (;;) {
        abortIfNeeded(config.signal);
        // A pause can overrun (throttled timers, a suspended device): recheck
        // the window and the key's expiry immediately before every resend.
        if (lastRejected && readinessWindow && !insideWindow(readinessWindow, authClock)) {
            authRetryCounts.set(lastRejected, authRetries - 1);
            return lastRejected;
        }
        const response = await fetchRequest(url, request, transportConfig);
        if (response.status === 401) {
            // A rejected request produced no output, so a resend cannot
            // duplicate any. The per-call count is never refilled; a fresh
            // key's window is absolute and shared by every call using it.
            const delay = nextAuthRetryDelay(authRetries, authClock, authRetryDelaysMs, readinessWindow);
            if (delay != null) {
                authRetries += 1;
                // Status and attempt only: never the key, body or provider text.
                console.warn(`Inference request rejected (HTTP 401); resending the same request (attempt ${authRetries + 1}).`);
                discardResponseBody(response.body);
                lastRejected = response;
                await authClock.sleep(delay, config.signal);
                continue;
            }
            authRetryCounts.set(response, authRetries);
            return response;
        }
        lastRejected = null;
        // A success or a billing answer (which needs a known key) closes the
        // key's readiness window. Other statuses may come from an edge first.
        if (response.ok || response.status === 402) markInferenceKeyAccepted(key);
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
