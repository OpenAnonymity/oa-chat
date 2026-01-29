import { normalizeResponsesRequest, normalizeEmbeddingRequest } from './responseUtils.js';
import webllmBackend from './backends/webllmBackend.js';
import ollamaBackend from './backends/ollamaBackend.js';
import vllmBackend from './backends/vllmBackend.js';

const backends = new Map([
    [webllmBackend.id, webllmBackend],
    [ollamaBackend.id, ollamaBackend],
    [vllmBackend.id, vllmBackend]
]);
const statusTarget = new EventTarget();

function emitStatus(payload) {
    statusTarget.dispatchEvent(new CustomEvent('status', { detail: payload }));
}

function resolveBackendOrThrow(backendId) {
    if (!backendId) {
        return webllmBackend;
    }
    if (backends.has(backendId)) {
        return backends.get(backendId);
    }
    throw new Error(`Unknown local inference backend: ${backendId}`);
}

function wrapBackendStatus(backend, event) {
    return {
        timestamp: Date.now(),
        backendId: backend.id,
        backendLabel: backend.label,
        ...event
    };
}

const localInferenceService = {
    registerBackend(backend) {
        if (!backend || !backend.id) {
            throw new Error('Local inference backend must include an id.');
        }
        backends.set(backend.id, backend);
    },
    getBackend(backendId) {
        if (!backendId) {
            return webllmBackend;
        }
        return backends.get(backendId) || null;
    },
    getBackends() {
        return Array.from(backends.values());
    },
    configureWebLLM(options = {}) {
        return webllmBackend.configure(options);
    },
    configureBackend(backendId, options = {}) {
        const backend = resolveBackendOrThrow(backendId);
        if (typeof backend.configure === 'function') {
            return backend.configure(options);
        }
        return null;
    },
    onStatus(callback) {
        if (typeof callback !== 'function') return () => {};
        const handler = (event) => callback(event.detail);
        statusTarget.addEventListener('status', handler);
        return () => statusTarget.removeEventListener('status', handler);
    },
    async fetchModels(backendId) {
        const backend = resolveBackendOrThrow(backendId);
        return backend.fetchModels();
    },
    async prepareModel(backendId, modelId, options = {}) {
        const backend = resolveBackendOrThrow(backendId);
        if (typeof backend.prepareModel !== 'function') {
            return null;
        }
        const emit = (event) => emitStatus(wrapBackendStatus(backend, event));
        return backend.prepareModel(modelId, { ...options, emitStatus: emit });
    },
    async createResponse(request, options = {}) {
        const normalized = normalizeResponsesRequest(request);
        if (!normalized.model) {
            throw new Error('Responses request is missing a model id.');
        }
        const backend = resolveBackendOrThrow(options.backendId || normalized.backend_id || normalized.backendId);

        const emit = (event) => emitStatus(wrapBackendStatus(backend, event));
        return backend.createResponse(normalized, { ...options, emitStatus: emit });
    },
    async streamResponse(request, options = {}) {
        const normalized = normalizeResponsesRequest(request);
        if (!normalized.model) {
            throw new Error('Responses request is missing a model id.');
        }
        const backend = resolveBackendOrThrow(options.backendId || normalized.backend_id || normalized.backendId);

        const emit = (event) => emitStatus(wrapBackendStatus(backend, event));
        return backend.streamResponse(normalized, { ...options, emitStatus: emit });
    },
    async createEmbedding(request, options = {}) {
        const normalized = normalizeEmbeddingRequest(request);
        if (!normalized.model) {
            throw new Error('Embedding request is missing a model id.');
        }
        const backend = resolveBackendOrThrow(options.backendId || normalized.backend_id || normalized.backendId);
        if (typeof backend.createEmbedding !== 'function') {
            throw new Error('Embedding is not supported for this backend.');
        }
        const emit = (event) => emitStatus(wrapBackendStatus(backend, event));
        return backend.createEmbedding(normalized, { ...options, emitStatus: emit });
    },
    async clearModelCache(backendId, modelId) {
        const backend = resolveBackendOrThrow(backendId);
        if (typeof backend.clearModelCache !== 'function') {
            throw new Error('Model cache clearing is not supported for this backend.');
        }
        return backend.clearModelCache(modelId);
    },
    async clearAllModelCache(backendId) {
        const backend = resolveBackendOrThrow(backendId);
        if (typeof backend.clearAllModelCache !== 'function') {
            throw new Error('Global cache clearing is not supported for this backend.');
        }
        return backend.clearAllModelCache();
    }
};

export default localInferenceService;
