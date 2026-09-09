import { createInferenceService, openRouterBackend, acquireVerifiedAccess } from '../../publicInferenceApi.js';
import * as ticketModels from '../../services/modelConfig.js';
import { createZkapiChatRuntime } from './zkapiChatRuntime.js';
import { createZkapiBackend } from './inference/backends/zkapiBackend.js';
import { ZkapiAPI } from '../api.js';
import { createPaymentModeRuntimeCore, PAYMENT_MODE_PREFERENCE } from './paymentModeRuntimeCore.mjs';

export function createPaymentModeRuntime() {
    let storage = null;
    let initialMode = 'tickets';
    try {
        storage = window.localStorage;
        initialMode = storage.getItem(PAYMENT_MODE_PREFERENCE) === 'zkapi' ? 'zkapi' : 'tickets';
    } catch { /* Storage may be unavailable until OA reports its normal error. */ }
    // Payment selects credential issuance and price presentation, not models.
    // Reuse OA's live catalog and cache so switching never restores the legacy
    // zkAPI deployment's short catalog, including during a provider outage.
    const modelConfiguration = ticketModels;
    const zkapiBackend = createZkapiBackend(new ZkapiAPI({ modelCatalog: openRouterBackend }));
    const inferenceService = createInferenceService({
        backends: [openRouterBackend, zkapiBackend],
        defaultBackendId: initialMode === 'zkapi' ? 'zkapi' : 'openrouter',
        legacyBackendId: 'openrouter',
        resolveLegacyBackendId: session => session?.zkapiSessionId || session?.apiKeyInfo?.backendId === 'zkapi'
            ? 'zkapi' : 'openrouter',
        resolveDefaultModelConfig: () => modelConfiguration.getDefaultModelConfig()
    });
    return createPaymentModeRuntimeCore({ zkRuntime: createZkapiChatRuntime({ backend: zkapiBackend, modelConfiguration }), inferenceService,
        acquireVerifiedAccess, modelConfiguration, preferenceStorage: storage, initialMode });
}
