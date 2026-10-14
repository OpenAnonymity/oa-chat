import { init, captureException, globalHandlersIntegration } from '@sentry/browser';
import { privacyOptions } from './privacy.mjs';
import { REQUEST_FAILURE_EVENT, parseRequestFailureType } from '../../chat/services/requestDiagnostics.js';

// Built as a self-hosted script before application modules. No CDN or global API.
try {
    init({
        ...privacyOptions({ ...__OA_SENTRY_CONFIG__, origin: location.origin }),
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
} catch {
    // Reporting must never prevent chat from starting.
}
