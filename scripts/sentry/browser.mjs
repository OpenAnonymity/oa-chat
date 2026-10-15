import { init, captureException, captureEvent, globalHandlersIntegration } from '@sentry/browser';
import { privacyOptions, collectLiveTags } from './privacy.mjs';
import { REQUEST_FAILURE_EVENT, parseRequestFailureType } from '../../chat/services/requestDiagnostics.js';
import { DIAGNOSTIC_EVENT, isDiagnosticName, trailToBreadcrumbs } from '../../chat/services/diagnostics.js';

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
    // A catalogued incident with its fields; the sanitizer validates both again.
    window.addEventListener(DIAGNOSTIC_EVENT, event => {
        try {
            const { name, fields, repeats, trail } = event.detail || {};
            if (!isDiagnosticName(name)) return;
            captureEvent({
                message: `OADiag_${name}`,
                level: 'warning',
                breadcrumbs: trailToBreadcrumbs(trail),
                contexts: { oa: { ...(fields || {}), repeats: repeats || 0 } }
            });
        } catch { /* Never block chat. */ }
    });
} catch {
    // Reporting must never prevent chat from starting.
}
