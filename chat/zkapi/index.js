import { configureBrowserSdk } from '@openanonymity/zkapi-browser-sdk';
import networkProxy from '../services/networkProxy.js';
import { createPaymentModeRuntime } from './services/paymentModeRuntime.js';
import { createPaymentModeUi } from './ui/createPaymentModeUi.js';
import { requestTestnetPassword } from './components/TestnetPasswordDialog.mjs';
import stationVerifier from '../services/verifier.js';
import { createProviderKeyVerifier, assertPrivateLeaseVerification } from './services/providerVerification.mjs';

/** Optional OA payment integration. Import only when private payments are
 * enabled. The SDK receives OA’s privacy-preserving transport before any wallet
 * initialization; its private storage stays separate from the shared chat DB. */
export function createZkapiPaymentIntegration({ configUrl, workerUrl, mode = 'browser', transport } = {}) {
    configureBrowserSdk({
        configUrl,
        workerUrl,
        mode,
        requestTestnetPassword,
        verifyProviderKey: createProviderKeyVerifier(stationVerifier),
        assertProviderKey: lease => assertPrivateLeaseVerification(lease, stationVerifier),
        transport: transport || ((url, init, options) => networkProxy.fetch(url, init, options))
    });
    const runtime = createPaymentModeRuntime();
    const ui = createPaymentModeUi(runtime);
    return { runtime, ui };
}

export default createZkapiPaymentIntegration;
