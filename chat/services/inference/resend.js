// Resend a request whose provider was briefly unavailable, before anything
// was shown. Same request/model/routing; ticket access is reused. zkAPI
// retains its existing session-lease expiry and settlement policy.
//
// OpenRouter answers 200 and opens the stream at once, so a provider that
// times out or is rate-limited reports it as an error event inside the
// stream ({"error":{"code":504}}), not as an HTTP status. Those are the
// failures people actually see; they are resent here like HTTP ones.
//
// Never resent: anything after text or reasoning appeared, a person's Stop,
// OA's own watchdog timeouts, and errors a resend would only repeat (bad
// request, key, credit, refusal). A slow failure is shown, not waited out.
import { httpStatusOf, providerStatusOf, isNetworkFailure } from '../../domain/inferenceFailure.js';

export const RESEND_POLICY = Object.freeze({
    maxResends: 1,                          // one retry, at most two requests
    waitsMs: Object.freeze([1000]),
    // A rate limit (429) waits longer by default, and never less than the
    // provider's Retry-After. Waits are stretched by up to `jitter` (never
    // shortened), so many tabs hit by the same limit do not return together.
    rateLimitWaitsMs: Object.freeze([2000]),
    jitter: 0.25,
    maxWaitMs: 6000,                        // includes jitter; longer hints end with a plain error
    budgetMs: 15000,                        // deadline for starting a retry, not finishing its answer
    windowMs: 15000                         // only when the failure came this soon
});

const HTTP_TRANSIENT = new Set([408, 429, 500, 502, 503, 504]);
const PROVIDER_TRANSIENT = new Set([429, 502, 503, 504]);

export function isStopError(error, signal = null) {
    // With the reply's own signal, only that signal decides: an AbortError
    // from the relay or a transport is a failure to resend, not a Stop.
    if (signal) return signal.aborted === true || error?.isCancelled === true || error?.isUserAbort === true;
    return error?.isCancelled === true || error?.name === 'AbortError' || error?.isUserAbort === true;
}

/** A failure that a second identical request a moment later can fix. */
export function isTransientInferenceError(error) {
    const provider = providerStatusOf(error);
    if (provider) return PROVIDER_TRANSIENT.has(provider);
    // The connection closed under the request (relay, transport); the
    // caller already ruled out the person's Stop.
    if (error?.isTransportAbort === true) return true;
    if (error?.providerReported === true || error?.isStreamError === true || error?.retryable === false) return false;
    const http = httpStatusOf(error);
    if (http) return HTTP_TRANSIENT.has(http);
    return isNetworkFailure(error);
}

const isRateLimit = error => (httpStatusOf(error) ?? providerStatusOf(error)) === 429;

/** The wait before resend number `resends + 1`, before jitter: never less than Retry-After. */
export function baseResendWait(error, resends, policy = RESEND_POLICY) {
    const schedule = isRateLimit(error) && policy.rateLimitWaitsMs ? policy.rateLimitWaitsMs : policy.waitsMs;
    const planned = schedule[Math.min(resends, schedule.length - 1)];
    const asked = Number(error?.retryAfterMs);
    return Number.isFinite(asked) && asked >= 0 ? Math.max(planned, asked) : planned;
}

/** Stretches a wait by 0..jitter of itself; `random` is injectable for tests. */
export function jitteredWait(ms, policy = RESEND_POLICY, random = Math.random) {
    const spread = Math.max(0, Number(policy.jitter) || 0);
    let r = 0;
    try { r = Math.min(Math.max(Number(random()) || 0, 0), 1); } catch { r = 0; }
    return Math.round(ms * (1 + spread * r));
}

/** 'resend', or why not: had_text | not_transient | limit_reached | too_slow | wait_too_long | stopped. */
export function resendDecision(error, { resends = 0, elapsedMs = 0, outputSeen = false, signal = null,
    policy = RESEND_POLICY } = {}) {
    if (isStopError(error, signal)) return 'stopped';
    if (outputSeen || error?.hasReceivedTokens === true) return 'had_text';
    if (!isTransientInferenceError(error)) return 'not_transient';
    if (resends >= policy.maxResends) return 'limit_reached';
    if (elapsedMs >= policy.windowMs) return 'too_slow';
    const waitMs = baseResendWait(error, resends, policy);
    if (Number.isFinite(policy.maxWaitMs) && waitMs > policy.maxWaitMs) return 'wait_too_long';
    if (Number.isFinite(policy.budgetMs) && elapsedMs + waitMs >= policy.budgetMs) return 'too_slow';
    return 'resend';
}

const monotonicNow = () => (globalThis.performance?.now ? globalThis.performance.now() : Date.now());

// The send loop recognises a person's Stop by `isCancelled`; a Stop during
// the wait must read the same as one during a request.
function stoppedError(signal) {
    const reason = signal?.reason;
    const error = reason && typeof reason === 'object' ? reason : new DOMException('Request stopped', 'AbortError');
    try { error.isCancelled = true; } catch { /* a frozen reason is still a stop */ }
    return error;
}

export function waitUnlessStopped(ms, signal) {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) {
            reject(stoppedError(signal));
            return;
        }
        const stop = () => {
            clearTimeout(timer);
            reject(stoppedError(signal));
        };
        const timer = setTimeout(() => {
            signal?.removeEventListener?.('abort', stop);
            resolve();
        }, ms);
        signal?.addEventListener?.('abort', stop, { once: true });
    });
}

const quietly = (fn, value) => {
    try { fn?.(value); } catch { /* reporting never changes the reply */ }
};

/**
 * Runs `attempt(resendIndex)` and resends it under RESEND_POLICY.
 * `outputSeen()` says whether the current attempt showed anything.
 * `onSettled({ outcome, attempts, reason, firstFailure, totalMs })` is called
 * once, only when the first attempt failed; it may not throw into the reply.
 * The error that ends the run carries `resendHandled = true`, so an outer
 * retry loop knows this request was already given its resends.
 */
export async function runWithResend(attempt, {
    signal = null, outputSeen = () => false, onSettled = null, onResend = null,
    policy = RESEND_POLICY, now = monotonicNow, wait = waitUnlessStopped, random = Math.random
} = {}) {
    const startedAt = now();
    let resends = 0;
    let firstFailure = null;
    for (;;) {
        try {
            const result = await attempt(resends);
            if (firstFailure) {
                quietly(onSettled, { outcome: 'answered', attempts: resends + 1, reason: 'recovered',
                    firstFailure, totalMs: now() - startedAt });
            }
            return result;
        } catch (error) {
            const elapsedMs = now() - startedAt;
            let seen = false;
            try { seen = Boolean(outputSeen()); } catch { seen = false; }
            // A Stop is not a failure: a reply stopped on its first request reports nothing.
            if (!firstFailure && !isStopError(error, signal)) {
                firstFailure = { error, afterMs: elapsedMs, hadText: seen || error?.hasReceivedTokens === true };
            }
            let decision = resendDecision(error, { resends, elapsedMs, outputSeen: seen, signal, policy });
            if (decision === 'resend') {
                const base = baseResendWait(error, resends, policy);
                // Jitter may use only the headroom left inside both caps.
                // resendDecision already verified that neither cap would
                // shorten the provider's requested minimum wait.
                const jittered = Math.min(jitteredWait(base, policy, random), policy.maxWaitMs ?? Infinity);
                // Do not spend the remaining budget waiting only to reject at
                // the deadline. If jitter would exhaust it, use the admissible
                // base wait instead; never shorten the provider's minimum.
                const delay = elapsedMs + jittered >= (policy.budgetMs ?? Infinity) ? base : jittered;
                quietly(onResend, { resends: resends + 1, error });
                try {
                    await wait(delay, signal);
                } catch (stopError) {
                    if (firstFailure) quietly(onSettled, { outcome: 'stopped', attempts: resends + 1, reason: 'stopped',
                        firstFailure, totalMs: now() - startedAt });
                    throw stopError;
                }
                // Suspended/background tabs can wake much later than planned.
                // Recheck cancellation and the budget before spending another
                // request, even if the timer's intended delay was admissible.
                if (isStopError(error, signal)) decision = 'stopped';
                else if (Number.isFinite(policy.budgetMs) && now() - startedAt >= policy.budgetMs) decision = 'too_slow';
                else {
                    resends += 1;
                    continue;
                }
            }
            try {
                error.resendHandled = true;
                // A Stop that lands while a failure is being judged is a Stop.
                if (decision === 'stopped') error.isCancelled = true;
            } catch { /* a frozen error still ends the run */ }
            if (firstFailure) quietly(onSettled, { outcome: decision === 'stopped' ? 'stopped' : 'failed', attempts: resends + 1,
                reason: decision, firstFailure, totalMs: now() - startedAt });
            throw error;
        }
    }
}
