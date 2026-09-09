import { createChatApp } from './app.js';

// Keep the synchronous createChatApp API available to existing compositions.
// This entry loads the optional payment adapter only in an enabled build.
export async function startChatApp(options = {}) {
    const network = typeof __OA_ZKAPI_NETWORK__ === 'string' ? __OA_ZKAPI_NETWORK__ : '';
    const { payments, ...chatOptions } = options;
    if (!network || payments === false || payments?.zkapi === false || chatOptions.runtime) {
        return createChatApp(chatOptions);
    }
    const { createZkapiPaymentIntegration } = await import('./zkapi/index.js');
    const assetBase = new URL('./zkapi/', document.baseURI);
    const integration = createZkapiPaymentIntegration({
        configUrl: new URL('browser-config.json', assetBase).href,
        workerUrl: new URL('assets/zkapiWasmWorker.js', assetBase).href,
        mode: 'browser'
    });
    return createChatApp({
        ...chatOptions,
        ...integration,
        // Private billing and chat do not need page-view analytics.
        analytics: false
    });
}
