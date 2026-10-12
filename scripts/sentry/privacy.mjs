const ERROR_TYPES = new Set(['Error', 'TypeError', 'ReferenceError', 'RangeError', 'SyntaxError', 'URIError', 'EvalError', 'AggregateError']);

// Reconstruct the event from a small allowlist. Error text can contain prompts,
// provider responses or credentials, so pattern-based redaction is insufficient.
export function sanitizeErrorEvent(event, { origin, scriptPaths, environment, release }) {
    if (event.type) return null;
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
        return [{
            type: ERROR_TYPES.has(exception.type) ? exception.type : 'Error',
            value: 'OA Chat runtime error (details withheld)',
            ...(typeof exception.mechanism?.handled === 'boolean'
                ? { mechanism: { type: 'generic', handled: exception.mechanism.handled } }
                : {}),
            stacktrace: { frames }
        }];
    });
    if (!values.length) return null;
    return {
        ...(typeof event.event_id === 'string' && /^[a-f0-9]{32}$/.test(event.event_id) ? { event_id: event.event_id } : {}),
        platform: 'javascript',
        level: 'error',
        environment,
        ...(release ? { release } : {}),
        exception: { values }
    };
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
        maxBreadcrumbs: 0,
        beforeBreadcrumb: () => null,
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
