import { createChatApp } from './app.js';

// Said when the payment boot itself could not even be loaded, so there is no
// boot-provided message to show.
const BOOT_LOAD_FAILED_MESSAGE = 'zkAPI could not start in this tab. Reload to try again.';

// Keep the synchronous createChatApp API available to existing compositions.
// This entry loads the optional payment adapter only in an enabled build.
export async function startChatApp(options = {}) {
    const network = typeof __OA_ZKAPI_NETWORK__ === 'string' ? __OA_ZKAPI_NETWORK__ : '';
    const { payments, ...chatOptions } = options;
    if (!network || payments === false || payments?.zkapi === false || chatOptions.runtime) {
        return createChatApp(chatOptions);
    }
    // Private payments are optional for the app to run. The boot chunk failing
    // to load (a dropped connection, a stale deploy) must degrade to the same
    // ticket-only start as any other payment failure, never a blank page.
    let booted;
    try {
        const { bootZkapiPayments } = await import('./zkapi/boot.js');
        // Boot is called without arguments on purpose. Its test seams (version
        // table, database, importers, timers) must never be reachable from
        // startChatApp's public options.
        booted = await bootZkapiPayments();
    } catch {
        booted = { integration: null, unavailable: { code: 'boot_failed', message: BOOT_LOAD_FAILED_MESSAGE } };
    }
    const { integration, unavailable } = booted || {};
    if (!integration) {
        // Private payments could not start (boot never throws). The app still
        // runs on tickets; say so once, after the app exists.
        const app = createChatApp({ ...chatOptions, analytics: false });
        if (unavailable) {
            const message = unavailable.message || BOOT_LOAD_FAILED_MESSAGE;
            void Promise.resolve(app.ready)
                .then(() => app.showToast?.(message, 'error', 9000))
                .catch(() => {});
        }
        return app;
    }
    return createChatApp({
        ...chatOptions,
        ...integration,
        // Private billing and chat do not need page-view analytics.
        analytics: false
    });
}
