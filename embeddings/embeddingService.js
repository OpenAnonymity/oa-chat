import { normalizeEmbeddingRequest } from '../local_inference/responseUtils.js';
import { createLocalInferenceBackend } from './backends/localInferenceBackend.js';
import { createOpenAIEmbeddingBackend } from './backends/openaiBackend.js';
import { normalizeEmbeddingResponse } from './utils.js';

const backendRegistry = new Map();

export function registerEmbeddingBackend(name, factory) {
    if (!name || typeof name !== 'string') {
        throw new Error('Embedding backend name must be a non-empty string.');
    }
    if (typeof factory !== 'function') {
        throw new Error('Embedding backend factory must be a function.');
    }
    backendRegistry.set(name.toLowerCase(), factory);
}

export function availableEmbeddingBackends() {
    return Array.from(backendRegistry.keys());
}

function resolveBackend(backend, options) {
    if (!backend || backend === 'auto') {
        return backendRegistry.get('local')(options);
    }

    if (typeof backend === 'string') {
        const factory = backendRegistry.get(backend.toLowerCase());
        if (!factory) {
            throw new Error(`Unknown embedding backend: ${backend}`);
        }
        return factory(options);
    }

    if (typeof backend === 'function') {
        const instance = backend(options);
        if (!instance) {
            throw new Error('Embedding backend factory returned no instance.');
        }
        return instance;
    }

    if (typeof backend === 'object') {
        if (backend.name && backend.options) {
            const name = String(backend.name).toLowerCase();
            const factory = backendRegistry.get(name);
            if (!factory) {
                throw new Error(`Unknown embedding backend: ${backend.name}`);
            }
            return factory({ ...options, ...backend.options });
        }

        if (typeof backend.createEmbedding === 'function') {
            return backend;
        }
    }

    throw new Error('Unsupported embedding backend configuration.');
}

export class EmbeddingSource {
    constructor(options = {}) {
        this.model = options.model || null;
        this.backendId = options.backendId || null;
        this.backendName = typeof options.backend === 'string' ? options.backend : 'custom';
        this.backend = resolveBackend(options.backend, options);

        if (this.backend?.configure && options.backendOptions) {
            this.backend.configure(options.backendOptions);
        }
    }

    async prepareModel(modelId, options = {}) {
        if (this.backend?.prepareModel) {
            return this.backend.prepareModel(modelId || this.model, options);
        }
        return null;
    }

    async createEmbedding(request, options = {}) {
        const normalized = normalizeEmbeddingRequest(request);
        const model = options.model || normalized.model || this.model;
        if (!model) {
            throw new Error('Embedding request is missing a model id.');
        }

        const { backendOptions, ...restOptions } = options;
        if (backendOptions && this.backend?.configure) {
            this.backend.configure(backendOptions);
        }

        const backendOptionsResolved = {
            ...restOptions,
            backendId: options.backendId || normalized.backend_id || normalized.backendId || this.backendId
        };

        const response = await this.backend.createEmbedding({
            ...normalized,
            model
        }, backendOptionsResolved);

        return normalizeEmbeddingResponse(response, { model });
    }

    async embedText(text, options = {}) {
        const response = await this.createEmbedding({
            model: options.model || this.model,
            input: text
        }, options);

        const embedding = response.embeddings?.[0] || null;
        if (!embedding) {
            throw new Error('Embedding response did not include any vectors.');
        }
        return embedding;
    }

    async embedTexts(texts, options = {}) {
        const response = await this.createEmbedding({
            model: options.model || this.model,
            input: texts
        }, options);
        return response.embeddings || [];
    }
}

export function createEmbeddingSource(options = {}) {
    return new EmbeddingSource(options);
}

registerEmbeddingBackend('local', (options) => createLocalInferenceBackend(options));
registerEmbeddingBackend('openai', (options) => createOpenAIEmbeddingBackend(options?.backendOptions || options || {}));
registerEmbeddingBackend('openai-compatible', (options) => createOpenAIEmbeddingBackend(options?.backendOptions || options || {}));

export { createOpenAIEmbeddingBackend };
