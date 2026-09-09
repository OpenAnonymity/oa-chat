import zkapiClient from '@openanonymity/zkapi-browser-sdk/client';
import zkapiBackend from './inference/backends/zkapiBackend.js';
import { createInferenceService } from '../../publicInferenceApi.js';
import * as modelConfiguration from '../../services/modelConfig.js';
import { createZkapiChatRuntimeCore } from './zkapiChatRuntimeCore.mjs';
import { ensureModelTiersReady } from '../../publicModelTierApi.js';
import { getModelBudget } from './zkapiModelBudget.mjs';

/** Production defaults; the lifecycle core has no browser/wallet side effects. */
export function createZkapiChatRuntime(options = {}) {
    return createZkapiChatRuntimeCore({
        client: zkapiClient,
        backend: zkapiBackend,
        createInferenceService,
        modelConfiguration,
        resolveModelBudget: async (modelId, reasoningEnabled, signal) => {
            await ensureModelTiersReady({ signal });
            return getModelBudget(modelId, reasoningEnabled);
        },
        ...options
    });
}
