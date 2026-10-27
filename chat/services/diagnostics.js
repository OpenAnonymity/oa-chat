// Diagnostics: what the client tells an error reporter about itself, and
// nothing else. Application code calls reportDiagnostic / addBreadcrumb with
// names and fields drawn from the finite catalogue below; everything is
// validated here, again in scripts/sentry/privacy.mjs (which reconstructs
// each outgoing event from this same vocabulary) and reaches the reporter
// only as DOM events, so no module here depends on the SDK and an
// unconfigured build has nothing to send. Free text, URLs, identifiers,
// model names and anything from a prompt or a response are not in the
// vocabulary and cannot get in. See docs/SENTRY.md.

export const DIAGNOSTIC_EVENT = 'oa:diagnostic';
export const BREADCRUMB_EVENT = 'oa:breadcrumb';

// Integers are reported as the top of a coarse bucket, so a count never
// identifies a wallet or a conversation by its exact size.
const COUNT_BUCKETS = [0, 1, 2, 3, 5, 10, 20, 50, 100, 200, 500, 1000];
export function bucketCount(value) {
    const number = Number(value);
    if (!Number.isFinite(number) || number <= 0) return 0;
    for (const edge of COUNT_BUCKETS) if (number <= edge) return edge;
    return Infinity;
}

// Field kinds. An enum lists every value a field may carry.
const ENUM = values => Object.freeze({ kind: 'enum', values: Object.freeze([...values]) });
const COUNT = Object.freeze({ kind: 'count' });
const BOOL = Object.freeze({ kind: 'bool' });

const HTTP_STATUSES = [400, 401, 402, 403, 404, 408, 409, 413, 422, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524, 525, 526];
export const REQUEST_REASONS = Object.freeze(['timeout', 'network', 'other_4xx', 'other_5xx', 'unexpected', 'rejected',
    ...HTTP_STATUSES.map(status => `http_${status}`)]);

/**
 * Every reportable event, with every field it may carry. Add here first;
 * an event or field not listed is dropped, not sent.
 */
export const DIAGNOSTIC_CATALOG = Object.freeze({
    // Key acquisition set aside tickets the org had already seen.
    'access.sweep': { skipped: COUNT, recovered: BOOL, tier: COUNT },
    // A refusal did not shrink the wallet; the sweep stopped rather than loop.
    'access.sweep_stalled': { tier: COUNT },
    // The request watchdog gave up (connection never opened, silence, or no output).
    'stream.timeout': { stage: ENUM(['connection', 'idle', 'output']), seconds: COUNT },
    // A local store did not confirm a write; the app carried on without it.
    'storage.failed': {
        store: ENUM(['tickets', 'pending-turn', 'messages', 'sessions', 'settings']),
        op: ENUM(['read', 'write', 'upgrade'])
    },
    // Encrypted wallet sync did not complete.
    'sync.failed': { reason: ENUM(REQUEST_REASONS), stage: ENUM(['pull', 'push', 'merge', 'status']) },
    // A passkey unlock of the encryption keyring did not complete. `unavailable`
    // is the browser reporting that none of the account's passkeys exist in this
    // profile (NotFoundError); `cancelled` is the native sheet closed without a
    // credential, which on a phone with no synced passkey is the usual outcome.
    'unlock.failed': {
        outcome: ENUM(['unavailable', 'cancelled', 'no_prf', 'failed']),
        account: ENUM(['google', 'username']),
        prelaunch: BOOL
    }
});

/** The finite outcome an unlock error maps to; never its text. */
export function unlockFailureOutcome(error) {
    if (error?.code === 'ENCRYPTION_PASSKEY_NOT_AVAILABLE' || error?.name === 'PasskeyUnavailableError') return 'unavailable';
    if (error?.name === 'NotAllowedError' || error?.name === 'AbortError') return 'cancelled';
    if (/\bPRF\b/i.test(String(error?.message || ''))) return 'no_prf';
    return 'failed';
}

/** The finite reason an error maps to; never its text. */
export function requestFailureReason(error) {
    const status = error?.status ?? error?.response?.status;
    if (HTTP_STATUSES.includes(status)) return `http_${status}`;
    if (Number.isInteger(status) && status >= 400 && status < 500) return 'other_4xx';
    if (Number.isInteger(status) && status >= 500 && status < 600) return 'other_5xx';
    if (error?.name === 'TimeoutError' || error?.isBodyTimeout === true || error?.code === 'ETIMEDOUT') return 'timeout';
    // A fetch that never reached a server is a TypeError whose words say so;
    // they are read here to classify it and go no further.
    if (error?.isNetworkError === true || error?.code === 'NETWORK_ERROR'
        || (error?.name === 'TypeError' && /fetch|network/i.test(String(error?.message || '')))) return 'network';
    if (error?.code === 'VERIFICATION_REJECTED') return 'rejected';
    return 'unexpected';
}

const BREADCRUMB_CATEGORIES = Object.freeze(['access', 'verify', 'tickets', 'stream', 'sync', 'send', 'billing', 'local', 'pairing', 'other']);
// Phone pairing steps (docs/PHONE_PAIRING.md): the state names of the
// computer's session, nothing from the QR or the messages.
const PAIRING_CODES = ['showing', 'scanned', 'approving', 'done', 'expired', 'declined', 'failed'];
const BREADCRUMB_CODES = new Set([...PAIRING_CODES, 'request_confidential_key', 'request_key', 'submit_key', 'attestation', 'register', 'split', 'code_redeem', 'free_access', 'waitlist', 'legacy_transfer', 'request', 'auth', 'completion', 'models', 'ticket_select', 'ticket_select_split', 'tickets_blind', 'tickets_signed', 'tickets_unblind', 'prompt_edit', 'session_fork', 'access_discard', 'access_replace', 'started', 'opened', 'first_output', 'failed', 'timeout']);
// The org's structured error codes (oa-org auth/ticket_auth.py and the
// billing, account and sync routes). A code not listed here is not carried.
export const ORG_ERROR_CODES = Object.freeze([
    'TICKET_ALREADY_SPENT', 'TICKET_INVALID', 'TICKET_EXPIRED', 'TICKET_MALFORMED', 'NO_TICKETS_PROVIDED',
    'TICKET_KEY_INVALIDATED', 'TICKET_KEY_LEGACY', 'TIER_TICKETS_MISMATCH', 'KEY_LIMIT',
    'SERVICE_UNAVAILABLE', 'INTERNAL_ERROR', 'RATE_LIMITED', 'EMPTY_RESPONSE',
    'ACCOUNT_EXISTS', 'ACCOUNT_NOT_FOUND', 'CREDENTIAL_NOT_FOUND', 'INVALID_ACCOUNT_ID', 'INVALID_CHALLENGE',
    'INVALID_SIGNATURE', 'INVALID_TOKEN', 'MISSING_FIELD', 'BLOB_TOO_LARGE', 'BLOB_LIMIT_EXCEEDED', 'INVALID_BLOB_ID'
]);
const ORG_ERROR_CODE_SET = new Set(ORG_ERROR_CODES);

/** A validated breadcrumb or null. Shared with the Sentry sanitizer. */
export function normalizeBreadcrumb(input) {
    const category = input?.category;
    const code = input?.code;
    if (!BREADCRUMB_CATEGORIES.includes(category) || typeof code !== 'string' || !BREADCRUMB_CODES.has(code)) return null;
    const crumb = { category, code };
    const status = Number(input.status);
    if (Number.isInteger(status) && status >= 0 && status <= 999) crumb.status = status;
    if (ORG_ERROR_CODE_SET.has(input.errorCode)) crumb.errorCode = input.errorCode;
    const count = bucketCount(input.count);
    if (count > 0) crumb.count = count === Infinity ? 1000 : count;
    if (input.aborted === true) crumb.aborted = true;
    if (Number.isFinite(input.elapsedMs) && input.elapsedMs >= 0 && input.elapsedMs <= 3600000) {
        crumb.elapsedMs = Math.round(input.elapsedMs / 100) * 100;
    }
    return crumb;
}

/** Fields validated against the catalogue, or null when the name is unknown. */
export function normalizeDiagnostic(name, fields = {}) {
    const schema = DIAGNOSTIC_CATALOG[name];
    if (!schema) return null;
    const out = {};
    for (const [field, kind] of Object.entries(schema)) {
        const value = fields?.[field];
        if (value === undefined || value === null) continue;
        if (kind.kind === 'enum') {
            if (kind.values.includes(value)) out[field] = value;
        } else if (kind.kind === 'bool') {
            if (typeof value === 'boolean') out[field] = value;
        } else if (kind.kind === 'count') {
            const bucket = bucketCount(value);
            out[field] = bucket === Infinity ? 1000 : bucket;
        }
    }
    return out;
}

export function isDiagnosticName(name) {
    return typeof name === 'string' && Object.hasOwn(DIAGNOSTIC_CATALOG, name);
}

// Per page: an event is sent at most once a minute per name (later
// occurrences in that minute ride along as `repeats` on the next one), at
// most ten times per name and sixty in all. Counts are incidents seen by
// the reporter, not request volume.
const REPEAT_WINDOW_MS = 60_000;
const PER_NAME_CAP = 10;
const TOTAL_CAP = 60;

export function createDiagnosticsReporter({ target, now = Date.now } = {}) {
    const sentAt = new Map();
    const sentCount = new Map();
    const pending = new Map();
    let total = 0;
    const dispatch = (type, detail) => {
        const eventTarget = target ?? globalThis.window;
        if (typeof eventTarget?.dispatchEvent !== 'function' || typeof CustomEvent !== 'function') return false;
        eventTarget.dispatchEvent(new CustomEvent(type, { detail }));
        return true;
    };
    return {
        /** Sends a catalogued event; silently drops anything else. Never throws. */
        report(name, fields = {}, trail = []) {
            try {
                const normalized = normalizeDiagnostic(name, fields);
                if (!normalized) return false;
                const at = now();
                const last = sentAt.get(name);
                const count = sentCount.get(name) || 0;
                if (count >= PER_NAME_CAP || total >= TOTAL_CAP
                    || (Number.isFinite(last) && at - last < REPEAT_WINDOW_MS)) {
                    pending.set(name, (pending.get(name) || 0) + 1);
                    return false;
                }
                const repeats = pending.get(name) || 0;
                pending.delete(name);
                sentAt.set(name, at);
                sentCount.set(name, count + 1);
                total += 1;
                return dispatch(DIAGNOSTIC_EVENT, { name, fields: normalized, repeats: bucketCount(repeats) === Infinity ? 1000 : bucketCount(repeats), trail: normalizeTrail(trail) });
            } catch {
                return false; // Diagnostics can never affect the app.
            }
        },
        /** Records a step for the trail attached to later reports. Never throws. */
        breadcrumb(input) {
            try {
                const crumb = normalizeBreadcrumb(input);
                if (!crumb) return false;
                return dispatch(BREADCRUMB_EVENT, crumb);
            } catch {
                return false;
            }
        }
    };
}

const reporter = createDiagnosticsReporter();
export const reportDiagnostic = (name, fields, trail) => reporter.report(name, fields, trail);
export const addBreadcrumb = input => reporter.breadcrumb(input);

// --- Breadcrumbs from the Activity Timeline ---------------------------------
// The timeline already records every request the client makes; its entries
// are reduced here to a category, a step name, the HTTP status and the org's
// error code — never the host, the path's parameters, headers or bodies.
const PATH_STEPS = [
    [/\/api\/request_confidential_key$/, 'access', 'request_confidential_key'],
    [/\/api\/request_key$/, 'access', 'request_key'],
    [/\/submit_key$/, 'verify', 'submit_key'],
    [/\/attestation$/, 'verify', 'attestation'],
    [/\/api\/alpha-register$/, 'tickets', 'register'],
    [/\/api\/split_tickets$/, 'tickets', 'split'],
    [/\/api\/code-redeem$/, 'tickets', 'code_redeem'],
    [/\/chat\/free_access$/, 'tickets', 'free_access'],
    [/\/api\/waitlist\/join$/, 'tickets', 'waitlist'],
    [/\/api\/billing\/legacy-transfer$/, 'tickets', 'legacy_transfer'],
    [/\/api\/billing\//, 'billing', 'request'],
    [/\/auth\//, 'other', 'auth'],
    [/\/chat\/completions$/, 'stream', 'completion'],
    [/\/models$/, 'other', 'models']
];
const LOCAL_ACTIONS = new Set(['ticket-select', 'ticket-select-split', 'tickets-blind', 'tickets-signed', 'tickets-unblind',
    'prompt-edit', 'session-fork', 'access-discard', 'access-replace']);

export function breadcrumbFromLogEntry(entry) {
    if (!entry) return null;
    if (entry.type === 'local') {
        const action = String(entry.action || '');
        return LOCAL_ACTIONS.has(action) ? normalizeBreadcrumb({ category: 'local', code: action.replace(/-/g, '_') }) : null;
    }
    let pathname = '';
    try { pathname = new URL(String(entry.url || '')).pathname; } catch { pathname = ''; }
    const step = PATH_STEPS.find(([pattern]) => pattern.test(pathname));
    const [, category, code] = step || [null, entry.type === 'openrouter' ? 'stream' : 'other', 'request'];
    const detail = entry.response && typeof entry.response === 'object'
        ? (entry.response.detail && typeof entry.response.detail === 'object' ? entry.response.detail : entry.response) : null;
    return normalizeBreadcrumb({
        category, code,
        status: entry.status,
        errorCode: detail?.error_code,
        aborted: entry.isAborted === true
    });
}

// Each caller owns its request-local buffer. No current-chat lookup, shared SDK
// breadcrumbs, identifiers, or cross-request history participates in a report.
export function normalizeTrail(trail) {
    return (Array.isArray(trail) ? trail : []).slice(-40).map(normalizeBreadcrumb).filter(Boolean);
}

export function createDiagnosticTrail(category, { now = () => globalThis.performance?.now?.() ?? Date.now() } = {}) {
    const entries = [];
    let started;
    try { started = now(); } catch { started = 0; }
    return {
        add(code) {
            try {
                const crumb = normalizeBreadcrumb({ category, code, elapsedMs: Math.max(0, now() - started) });
                if (crumb) entries.push(crumb);
                if (entries.length > 40) entries.shift();
            } catch { /* Reporting must never affect a request. */ }
        },
        snapshot() { return entries.map(entry => ({ ...entry })); }
    };
}

export function trailToBreadcrumbs(trail) {
    return normalizeTrail(trail).map(({ category, code, elapsedMs, errorCode, ...data }) => ({
        category: `oa.${category}`, message: code, level: 'info',
        data: { ...data, ...(errorCode ? { error_code: errorCode } : {}), ...(elapsedMs !== undefined ? { elapsed_ms: elapsedMs } : {}) }
    }));
}
