import { init, globalHandlersIntegration } from '@sentry/browser';
import { privacyOptions } from './privacy.mjs';

// Built as a self-hosted script before application modules. No CDN or global API.
try {
    init({
        ...privacyOptions({ ...__OA_SENTRY_CONFIG__, origin: location.origin }),
        integrations: [globalHandlersIntegration()]
    });
} catch {
    // Reporting must never prevent chat from starting.
}
