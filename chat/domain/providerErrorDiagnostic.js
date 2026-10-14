// Diagnostic-only: these provider SSE codes do not change HTTP status, credit
// recovery or retry policy. Never retain the provider's free-form error body.
export const PROVIDER_ERROR_STATUSES = Object.freeze([
    400, 401, 402, 403, 404, 408, 413, 422, 429,
    500, 502, 503, 504, 520, 521, 522, 523, 524, 525, 526
]);
const statuses = new Set(PROVIDER_ERROR_STATUSES);

export function providerErrorDiagnosticCode(error) {
    if (error?.providerReported !== true && error?.code !== 'INFERENCE_PROVIDER_ERROR') return '';
    return Number.isInteger(error.code) && statuses.has(error.code)
        ? `PROVIDER_CODE_${error.code}` : 'PROVIDER_STREAM_ERROR';
}

export function parseProviderErrorDiagnostic(code) {
    if (code === 'PROVIDER_STREAM_ERROR') return { status: null };
    const match = /^PROVIDER_CODE_(\d{3})$/.exec(code || '');
    const status = match ? Number(match[1]) : null;
    return statuses.has(status) ? { status } : null;
}
