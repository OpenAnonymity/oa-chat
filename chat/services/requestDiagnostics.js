import { PROVIDER_ERROR_STATUSES, providerErrorDiagnosticCode } from '../domain/providerErrorDiagnostic.js';

export const REQUEST_FAILURE_EVENT = 'oa:request-failure';
const PHASES = new Set(['access', 'verification', 'completion']);
const HTTP_STATUSES = new Set([400, 401, 403, 408, 413, 422, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524, 525, 526]);
const REASONS = new Set(['timeout', 'network', 'other_4xx', 'other_5xx', 'unexpected', 'rejected', 'provider_error',
    ...PROVIDER_ERROR_STATUSES.map(status => `provider_code_${status}`),
    ...[...HTTP_STATUSES].map(status => `http_${status}`)]);

// Shared with Sentry's final allowlist; never use error text or request data.
export function parseRequestFailureType(type) {
    if (typeof type !== 'string') return null;
    const match = /^OARequest_(access|verification|completion)_(\w+)$/.exec(type);
    return match && REASONS.has(match[2]) ? { phase: match[1], reason: match[2] } : null;
}

export function createRequestFailureReporter(target) {
    const reported = new Set();
    return (phase, error, signal) => {
        try {
            const eventTarget = target ?? globalThis.window;
            if (!PHASES.has(phase) || !eventTarget?.dispatchEvent || signal?.aborted
                || error?.name === 'AbortError' || error?.isCancelled || error?.isUserAbort) return;
            const status = error?.status ?? error?.response?.status;
            // Insufficient credit is an expected recovery flow, not an outage.
            if (status === 402) return;
            const providerCode = providerErrorDiagnosticCode(error);
            const reason = HTTP_STATUSES.has(status) ? `http_${status}`
                : Number.isInteger(status) && status >= 400 && status < 500 ? 'other_4xx'
                    : Number.isInteger(status) && status >= 500 && status < 600 ? 'other_5xx'
                        : providerCode ? providerCode === 'PROVIDER_STREAM_ERROR' ? 'provider_error' : providerCode.toLowerCase()
                        : error?.name === 'TimeoutError' || error?.isBodyTimeout ? 'timeout'
                            : error?.isNetworkError === true || error?.code === 'NETWORK_ERROR' ? 'network'
                                : error?.code === 'VERIFICATION_REJECTED' ? 'rejected' : 'unexpected';
            const type = `OARequest_${phase}_${reason}`;
            // An incident signal, not a per-attempt timeline or request count.
            if (reported.has(type) || reported.size >= 20) return;
            reported.add(type);
            const diagnostic = new Error('Request failed (details withheld)');
            diagnostic.name = type;
            eventTarget.dispatchEvent(new CustomEvent(REQUEST_FAILURE_EVENT, { detail: diagnostic }));
        } catch {
            // Diagnostics cannot affect completion, cancellation, or recovery.
        }
    };
}

export const reportRequestFailure = createRequestFailureReporter();
