import { init, captureException, captureEvent, addBreadcrumb, globalHandlersIntegration } from '@sentry/browser';
import { privacyOptions, collectLiveTags } from './privacy.mjs';
import { REQUEST_FAILURE_EVENT, parseRequestFailureType } from '../../chat/services/requestDiagnostics.js';
import { DIAGNOSTIC_EVENT, BREADCRUMB_EVENT, isDiagnosticName } from '../../chat/services/diagnostics.js';

// Built as a self-hosted script before application modules. No CDN or global API.
// Everything arrives as DOM events from chat/services/diagnostics.js and
// requestDiagnostics.js and leaves through privacy.mjs, which rebuilds each
// event from the same finite vocabulary. See docs/SENTRY.md.
try {
    init({
        ...privacyOptions({ ...__OA_SENTRY_CONFIG__, origin: location.origin, liveTags: () => collectLiveTags(globalThis) }),
        integrations: [globalHandlersIntegration()]
    });
    const reported = new Set();
    window.addEventListener(REQUEST_FAILURE_EVENT, event => {
        try {
            const type = event.detail?.name;
            if (!parseRequestFailureType(type) || reported.has(type) || reported.size >= 20) return;
            reported.add(type);
            captureException(event.detail);
        } catch { /* Diagnostics must never block chat. */ }
    });
    // The trail: one line per step the client took, kept with the next report.
    window.addEventListener(BREADCRUMB_EVENT, event => {
        try {
            const crumb = event.detail;
            if (!crumb?.category || !crumb?.code) return;
            const data = {};
            if (crumb.status !== undefined) data.status = crumb.status;
            if (crumb.errorCode) data.error_code = crumb.errorCode;
            if (crumb.count) data.count = crumb.count;
            if (crumb.aborted) data.aborted = true;
            addBreadcrumb({ category: `oa.${crumb.category}`, message: crumb.code, level: 'info', data });
        } catch { /* Never block chat. */ }
    });
    // A catalogued incident with its fields; the sanitizer validates both again.
    window.addEventListener(DIAGNOSTIC_EVENT, event => {
        try {
            const { name, fields, repeats } = event.detail || {};
            if (!isDiagnosticName(name)) return;
            captureEvent({
                message: `OADiag_${name}`,
                level: 'warning',
                contexts: { oa: { ...(fields || {}), repeats: repeats || 0 } }
            });
        } catch { /* Never block chat. */ }
    });
} catch {
    // Reporting must never prevent chat from starting.
}
