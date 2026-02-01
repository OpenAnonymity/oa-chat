import localInferenceService from '../../local_inference/localInferenceService.js';
import { normalizeEmbeddingRequest } from '../../local_inference/responseUtils.js';

export function createLocalInferenceBackend(options = {}) {
    const config = {
        backendId: options.backendId || null,
        model: options.model || null
    };

    return {
        id: 'local',
        label: 'Local inference',
        configure(next = {}) {
            if (next.backendId) {
                config.backendId = next.backendId;
            }
            if (next.model) {
                config.model = next.model;
            }
        },
        async fetchModels() {
            return localInferenceService.fetchModels(config.backendId);
        },
        async prepareModel(modelId, options = {}) {
            const resolvedModel = modelId || config.model;
            if (!resolvedModel) {
                throw new Error('Model id is required to prepare local embeddings.');
            }
            return localInferenceService.prepareModel(config.backendId, resolvedModel, options);
        },
        async createEmbedding(request, options = {}) {
            const normalized = normalizeEmbeddingRequest(request);
            const resolvedModel = normalized.model || config.model;
            if (!resolvedModel) {
                throw new Error('Embedding request is missing a model id.');
            }
            const backendId = options.backendId || normalized.backend_id || normalized.backendId || config.backendId;
            const backendOptions = { ...options };
            if (backendId) {
                backendOptions.backendId = backendId;
            } else {
                delete backendOptions.backendId;
            }
            return localInferenceService.createEmbedding({
                ...normalized,
                model: resolvedModel
            }, backendOptions);
        }
    };
}

const localInferenceBackend = createLocalInferenceBackend();

export default localInferenceBackend;
