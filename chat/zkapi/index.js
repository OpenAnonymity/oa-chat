import { configureBrowserSdk } from '@openanonymity/zkapi-browser-sdk';
import networkProxy from '../services/networkProxy.js';
import { createPaymentModeRuntime } from './services/paymentModeRuntime.js';
import { createPaymentModeUi } from './ui/createPaymentModeUi.js';
import { requestTestnetPassword } from './components/TestnetPasswordDialog.mjs';
import stationVerifier, { StationVerifier } from '../services/verifier.js';
import { VERIFIER_URL, ZKAPI_VERIFIER_URL } from '../config.js';
import { createProviderKeyVerifier, assertPrivateLeaseVerification } from './services/providerVerification.mjs';

// Never send a Mainnet lease to the staging ticket verifier. A separate
// instance keeps broadcasts, bans and cache entries within the trusted origin.
const providerVerifier = ZKAPI_VERIFIER_URL === VERIFIER_URL ? stationVerifier
    : new StationVerifier({ verifierUrl: ZKAPI_VERIFIER_URL, trustedStations: [] });
let providerVerifierStarted = false;

/** Optional OA payment integration. Import only when private payments are
 * enabled. The SDK receives OA’s privacy-preserving transport before any wallet
 * initialization; its private storage stays separate from the shared chat DB. */
export function createZkapiPaymentIntegration({ configUrl, workerUrl, mode = 'browser', transport } = {}) {
    if (providerVerifier !== stationVerifier && !providerVerifierStarted) {
        providerVerifierStarted = true;
        void providerVerifier.init();
        providerVerifier.startBroadcastCheck(() => null, { immediate: false });
    }
    configureBrowserSdk({
        configUrl,
        workerUrl,
        mode,
        requestTestnetPassword,
        verifyProviderKey: createProviderKeyVerifier(providerVerifier),
        assertProviderKey: lease => assertPrivateLeaseVerification(lease, providerVerifier),
        transport: transport || ((url, init, options) => networkProxy.fetch(url, init, options))
    });
    const runtime = createPaymentModeRuntime();
    const ui = createPaymentModeUi(runtime);
    return { runtime, ui };
}

export default createZkapiPaymentIntegration;
