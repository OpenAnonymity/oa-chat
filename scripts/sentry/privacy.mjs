import { parseRequestFailureType } from '../../chat/services/requestDiagnostics.js';
import { isDiagnosticName, normalizeDiagnostic, normalizeBreadcrumb, bucketCount } from '../../chat/services/diagnostics.js';

const ERROR_TYPES = new Set(['Error', 'TypeError', 'ReferenceError', 'RangeError', 'SyntaxError', 'URIError', 'EvalError', 'AggregateError']);

// The few tags an event may carry, each with every value it may take.
// They answer "which build, which mode, was the page even visible", which is
// where most bug reports start; none of them narrows down a person.
export const TAGS = Object.freeze({
    'oa.mode': ['ticket', 'zkapi'],
    'oa.surface': ['web', 'desktop'],
    'oa.visibility': ['visible', 'hidden'],
    'oa.online': ['online', 'offline']
});
const DIAGNOSTIC_MESSAGE = /^OADiag_([a-z][a-z0-9_]*\.[a-z][a-z0-9_]*)$/;
const MAX_BREADCRUMBS = 40;

export function sanitizeTags(tags) {
    const out = {};
    for (const [key, values] of Object.entries(TAGS)) {
        const value = tags?.[key];
        if (values.includes(value)) out[key] = value;
    }
    return out;
}

/** The trail, rebuilt from the client's own vocabulary; nothing else survives. */
export function sanitizeBreadcrumbs(breadcrumbs) {
    return (Array.isArray(breadcrumbs) ? breadcrumbs : []).flatMap(crumb => {
        const category = typeof crumb?.category === 'string' && crumb.category.startsWith('oa.') ? crumb.category.slice(3) : null;
        const normalized = normalizeBreadcrumb({ category, code: crumb?.message, ...(crumb?.data && typeof crumb.data === 'object' ? {
            status: crumb.data.status, errorCode: crumb.data.error_code, count: crumb.data.count, aborted: crumb.data.aborted
        } : {}) });
        if (!normalized) return [];
        const { category: cat, code, ...data } = normalized;
        const out = { category: `oa.${cat}`, message: code, level: 'info', type: 'default' };
        if (Number.isFinite(crumb.timestamp) && crumb.timestamp > 0) out.timestamp = crumb.timestamp;
        const entries = Object.entries({ status: data.status, error_code: data.errorCode, count: data.count, aborted: data.aborted })
            .filter(([, value]) => value !== undefined);
        if (entries.length) out.data = Object.fromEntries(entries);
        return [out];
    }).slice(-MAX_BREADCRUMBS);
}

function common(event, { environment, release }) {
    return {
        ...(typeof event.event_id === 'string' && /^[a-f0-9]{32}$/.test(event.event_id) ? { event_id: event.event_id } : {}),
        platform: 'javascript',
        environment,
        ...(release ? { release } : {}),
        ...(Number.isFinite(event.timestamp) && event.timestamp > 0 ? { timestamp: event.timestamp } : {})
    };
}

// Reconstruct the event from a small allowlist. Error text can contain prompts,
// provider responses or credentials, so pattern-based redaction is insufficient.
export function sanitizeErrorEvent(event, { origin, scriptPaths, environment, release, liveTags = null }) {
    if (event.type) return null;
    const tags = sanitizeTags({ ...(typeof liveTags === 'function' ? liveTags() : null), ...(event.tags || {}) });
    const breadcrumbs = sanitizeBreadcrumbs(event.breadcrumbs);
    const trail = { ...(Object.keys(tags).length ? { tags } : {}), ...(breadcrumbs.length ? { breadcrumbs } : {}) };

    // A diagnostic: a catalogued name with catalogued fields, nothing free.
    const diagnostic = typeof event.message === 'string' ? DIAGNOSTIC_MESSAGE.exec(event.message) : null;
    if (diagnostic) {
        const name = diagnostic[1];
        if (!isDiagnosticName(name)) return null;
        const fields = normalizeDiagnostic(name, event.contexts?.oa) || {};
        const repeats = bucketCount(event.contexts?.oa?.repeats);
        return {
            ...common(event, { environment, release }),
            level: event.level === 'error' ? 'error' : 'warning',
            message: event.message,
            logger: 'oa.diagnostics',
            contexts: { oa: { ...fields, repeats: repeats === Infinity ? 1000 : repeats } },
            fingerprint: [event.message],
            ...trail
        };
    }

    const allowedPaths = new Set(scriptPaths);
    const values = (event.exception?.values || []).slice(-5).flatMap(exception => {
        const frames = (exception.stacktrace?.frames || []).flatMap(frame => {
            try {
                const url = new URL(frame.filename);
                if (url.origin !== origin || !allowedPaths.has(url.pathname)) return [];
                return [{
                    filename: `app://${url.pathname}`,
                    ...(Number.isSafeInteger(frame.lineno) && frame.lineno > 0 ? { lineno: frame.lineno } : {}),
                    ...(Number.isSafeInteger(frame.colno) && frame.colno > 0 ? { colno: frame.colno } : {}),
                    in_app: true
                }];
            } catch {
                return [];
            }
        }).slice(-30);
        if (!frames.length) return [];
        const failure = parseRequestFailureType(exception.type);
        return [{
            type: failure ? exception.type : ERROR_TYPES.has(exception.type) ? exception.type : 'Error',
            value: failure
                ? `OA Chat ${failure.phase} failed: ${failure.reason} (details withheld)`
                : 'OA Chat runtime error (details withheld)',
            ...(typeof exception.mechanism?.handled === 'boolean'
                ? { mechanism: { type: 'generic', handled: exception.mechanism.handled } }
                : {}),
            stacktrace: { frames }
        }];
    });
    if (!values.length) return null;
    const failureType = values.find(value => parseRequestFailureType(value.type))?.type;
    return {
        ...common(event, { environment, release }),
        level: 'error',
        exception: { values },
        ...(failureType ? { fingerprint: [failureType] } : {}),
        ...trail
    };
}

/** Tags read at send time from the page itself; each value is from TAGS. */
export function collectLiveTags({ document, navigator, window } = globalThis) {
    const tags = {};
    try {
        tags['oa.mode'] = document?.documentElement?.classList?.contains('zkapi-mode') ? 'zkapi' : 'ticket';
        tags['oa.surface'] = window?.oaDesktopReady === true ? 'desktop' : 'web';
        tags['oa.visibility'] = document?.visibilityState === 'hidden' ? 'hidden' : 'visible';
        tags['oa.online'] = navigator?.onLine === false ? 'offline' : 'online';
    } catch { /* A tag is never worth an error. */ }
    return tags;
}

export function privacyOptions(config) {
    return {
        dsn: config.dsn,
        environment: config.environment,
        release: config.release || undefined,
        defaultIntegrations: false,
        dataCollection: {
            userInfo: false, cookies: false, httpHeaders: false,
            httpBodies: [], urlQueryParams: false,
            graphQL: { document: false, variables: false },
            genAI: { inputs: false, outputs: false },
            databaseQueryData: false, queues: false,
            stackFrameVariables: false, frameContextLines: 0
        },
        sendClientReports: false,
        traceLifecycle: 'static',
        tracesSampleRate: 0,
        tracePropagationTargets: [],
        replaysSessionSampleRate: 0,
        replaysOnErrorSampleRate: 0,
        // Only the client's own trail (scripts/sentry/browser.mjs adds it
        // under oa.*); the SDK's own breadcrumbs (console, fetch, DOM
        // clicks) are never kept, and beforeSend rebuilds the trail anyway.
        maxBreadcrumbs: MAX_BREADCRUMBS,
        beforeBreadcrumb: crumb => (typeof crumb?.category === 'string' && crumb.category.startsWith('oa.') ? crumb : null),
        beforeSendLog: () => null,
        beforeSendMetric: () => null,
        beforeSendTransaction: () => null,
        transportOptions: { fetchOptions: { credentials: 'omit', referrerPolicy: 'no-referrer' } },
        beforeSend(event, hint) {
            if (hint) hint.attachments = [];
            return sanitizeErrorEvent(event, config);
        }
    };
}
