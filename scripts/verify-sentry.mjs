import { init, captureEvent, flush, makeFetchTransport } from '@sentry/browser';
import { resolveSentryConfig } from './sentryBuild.mjs';
import { privacyOptions } from './sentry/privacy.mjs';

const config = resolveSentryConfig();
if (!config) throw new Error('Set SENTRY_DSN before running this synthetic verification.');
const origin = 'https://sentry-setup.invalid';
const scriptPath = '/assets/sentry-setup-check.js';
let responseStatus;
init({
    ...privacyOptions({ ...config, environment: 'setup-verification', origin, scriptPaths: [scriptPath] }),
    transport: options => makeFetchTransport(options, async (url, request) => {
        const response = await fetch(url, request);
        responseStatus = response.status;
        return response;
    })
});
const eventId = captureEvent({
    exception: { values: [{
        type: 'Error', value: 'Synthetic setup check; no user data.',
        stacktrace: { frames: [{ filename: `${origin}${scriptPath}`, lineno: 1, colno: 1 }] }
    }] }
});
const completed = await flush(15000);
if (!completed || responseStatus !== 200) {
    throw new Error(`Sentry did not acknowledge the test event (HTTP ${responseStatus || 'unavailable'}).`);
}
console.log(`Sentry accepted synthetic event ${eventId} (HTTP 200), environment setup-verification.`);
console.log('Confirm this event in Sentry Issues; ingestion acceptance alone does not confirm issue visibility.');
