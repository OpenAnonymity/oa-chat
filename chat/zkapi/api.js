// Both payment methods use OA’s catalog and request/stream parser. The SDK
// supplies private access; only its credential issuance and billing differ.
import { OpenRouterAPI, openRouterBackend } from '../publicInferenceApi.js';
import * as modelTiers from '../services/modelTiers.js';
import networkProxy from '../services/networkProxy.js';
import zkapiClient from '@openanonymity/zkapi-browser-sdk/client';
import { ensureDirectCompletionLimit } from '@openanonymity/zkapi-browser-sdk/request-compat';
import { getModelBudget } from './services/zkapiModelBudget.mjs';
import {
    BUNDLED_MODEL_CATALOG,
    baseModelId,
    estimateTextTokens
} from './services/modelPricing.mjs';

const TITLE_SUMMARY_MODEL_ID = 'google/gemini-3.1-flash-lite-preview';

export class ZkapiAPI extends OpenRouterAPI {
    constructor({ modelCatalog = openRouterBackend } = {}) {
        super({
            networkTransport: networkProxy,
            acquireRequestAccess: async (sessionId, options) => {
                const { modelId, accessModelId, reasoningEnabled = true, ...accessOptions } = options;
                await modelTiers.ensureModelTiersReady({ signal: accessOptions.signal });
                const { spendingLimitUsd } = getModelBudget(accessModelId || modelId, reasoningEnabled);
                const access = await zkapiClient.acquireInferenceAccess(sessionId, {
                    ...accessOptions,
                    spendingLimitUsd
                });
                return {
                    ...access,
                    proxyConfig: access.mode === 'daemon' ? { bypassProxy: true } : undefined
                };
            },
            prepareRequestBody: (body, { access, model }) => ensureDirectCompletionLimit(body, {
                spendingLimitUsd: access.spendingLimitUsd,
                model
            }),
            estimatePromptTokens: estimateTextTokens,
            onRequestError: error => {
                if (error?.status === 402 && typeof window !== 'undefined') {
                    window.dispatchEvent(new CustomEvent('zkapi-payment-required', { detail: { error } }));
                }
            },
            onRequestFinished: () => { void zkapiClient.refresh({ quiet: true }).catch(() => {}); }
        });
        this.modelCatalog = modelCatalog || openRouterBackend;
    }

    getCachedModels() {
        return this.modelCatalog.getCachedModels();
    }

    getDisplayName(modelId, fallback) {
        return this.modelCatalog.getDisplayName(modelId, fallback);
    }

    fetchModels() {
        return this.modelCatalog.fetchModels();
    }

    getModelBudgetMetadata(modelId) {
        return this.getCachedModels().find(model => model.id === modelId)
            || super.getModelBudgetMetadata(modelId)
            || BUNDLED_MODEL_CATALOG[baseModelId(modelId)] || null;
    }

    generateSessionTitle(prompt, sessionId, options = {}) {
        return super.generateSessionTitle(prompt, sessionId, {
            ...options,
            modelId: options.modelId || TITLE_SUMMARY_MODEL_ID
        });
    }

    // Payment failures must surface; never substitute OA's offline demo response.
    async sendCompletion(messages, modelId, sessionId) {
        return (await this.sendCompletionStrict(messages, modelId, sessionId)).content;
    }
}

export default new ZkapiAPI();
