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
// The only provider-visible request headers. Every protocol version's SDK
// builds its own set and they differ (`x-title` is `oa-chat` in one and `zkAPI`
// in another), which would let the inference provider split users by version.
const PROVIDER_TITLE = 'oa-chat';

/**
 * The provider-visible headers of an access, rebuilt from an allowlist so every
 * protocol version looks identical to the inference provider: `authorization`
 * (the access's own bearer credential), `content-type`, `http-referer` (this
 * page's origin) and a constant `x-title`. Anything else an SDK adds is dropped.
 *
 * A daemon-mode access is left alone: that request goes to the local daemon,
 * which needs its own session header, and never reaches the provider.
 *
 * @param {{mode?: string, apiKey?: string, headers?: object}} access
 * @param {{origin?: string}} [options] page origin (defaults to location.origin)
 * @returns {object} headers
 */
export function normalizeProviderHeaders(access, { origin } = {}) {
    const source = access && typeof access.headers === 'object' && access.headers !== null ? access.headers : {};
    if (access?.mode === 'daemon') return source;
    const lowered = new Map();
    for (const [name, value] of Object.entries(source)) lowered.set(name.toLowerCase(), value);
    const text = name => (typeof lowered.get(name) === 'string' && lowered.get(name) ? lowered.get(name) : null);
    const pageOrigin = origin ?? (typeof location !== 'undefined' ? location.origin : null);
    const headers = {};
    const authorization = text('authorization')
        || (typeof access?.apiKey === 'string' && access.apiKey ? `Bearer ${access.apiKey}` : null);
    if (authorization) headers.authorization = authorization;
    headers['content-type'] = text('content-type') || 'application/json';
    const referer = pageOrigin || text('http-referer');
    if (referer) headers['http-referer'] = referer;
    headers['x-title'] = PROVIDER_TITLE;
    return headers;
}

// The gateway answers a key request with 410 when this deployment stopped
// starting new chats (it is being retired): retrying cannot help. This reads
// the HTTP response (status 410 plus the `deployment_retiring` code or
// `retriable: false`) and raises the facade's admission-closed flag; the
// message rewrite in zkapiErrorCopy.mjs reads only the error code
// (isRetiringErrorCode).
function isAdmissionClosedResponse(error) {
    for (const candidate of [error, error?.cause]) {
        if (!candidate || typeof candidate !== 'object') continue;
        const status = Number(candidate.status ?? candidate.data?.status);
        if (status !== 410) continue;
        const code = candidate.code ?? candidate.data?.error?.code ?? candidate.data?.code;
        const retriable = candidate.data?.retriable ?? candidate.data?.error?.retriable;
        if (code === 'deployment_retiring' || retriable === false) return true;
    }
    return false;
}

// The versioning facade is attached to the SDK client by boot. Without it
// (single-version builds, tests) this does nothing.
function notifyVersioning(code) {
    zkapiClient.oaVersioning?.noteSignal?.(code);
}

// A refused key request is the one place a chat learns why it cannot start
// (the balance is too close to its expiry, the service is paused, an exit is
// in progress). The facade holds what the SDK said so the balance can show it
// as a notice, not only as this attempt's toast. A chat key is drawn from the
// balance in the wallet slot and from no other, which is what `slot` says: an
// error carries no balance of its own, and the facade holds a fact about the
// balance for only a minute when nobody says which one it was about.
// Presentation only: a build with no versions to tell apart is not told
// anything, and nothing the facade does can change what is thrown.
function notifyRefusal(error) {
    const facade = zkapiClient.oaVersioning;
    if (facade?.multiVersion === true) facade.noteRefusal?.(error, { slot: true });
}

export class ZkapiAPI extends OpenRouterAPI {
    constructor({
        modelCatalog = openRouterBackend, onAdmissionClosed = notifyVersioning, onAccessRefused = notifyRefusal
    } = {}) {
        super({
            networkTransport: networkProxy,
            acquireRequestAccess: async (sessionId, options) => {
                const { modelId, accessModelId, reasoningEnabled = true, ...accessOptions } = options;
                await modelTiers.ensureModelTiersReady({ signal: accessOptions.signal });
                const { spendingLimitUsd } = getModelBudget(accessModelId || modelId, reasoningEnabled);
                let access;
                try {
                    access = await zkapiClient.acquireInferenceAccess(sessionId, {
                        ...accessOptions,
                        spendingLimitUsd
                    });
                } catch (error) {
                    if (isAdmissionClosedResponse(error)) {
                        try { onAdmissionClosed?.('deployment_retiring'); } catch { /* presentation only */ }
                    }
                    try { onAccessRefused?.(error); } catch { /* presentation only */ }
                    throw error;
                }
                return {
                    ...access,
                    headers: normalizeProviderHeaders(access),
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
