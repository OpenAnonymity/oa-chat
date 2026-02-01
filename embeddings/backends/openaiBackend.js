import { createOpenAICompatibleBackend } from '../../local_inference/backends/httpOpenAIBackend.js';

export function createOpenAIEmbeddingBackend(options = {}) {
    const backend = createOpenAICompatibleBackend({
        id: options.id || 'openai',
        label: options.label || 'OpenAI-compatible',
        baseUrl: options.baseUrl || '',
        defaultModelId: options.defaultModelId || 'default',
        defaultModelName: options.defaultModelName || 'OpenAI-compatible',
        providerLabel: options.providerLabel || 'OpenAI-compatible',
        modelsEndpoint: options.modelsEndpoint,
        chatEndpoint: options.chatEndpoint,
        embeddingsEndpoint: options.embeddingsEndpoint
    });

    if (options.apiKey || options.headers || options.baseUrl) {
        backend.configure({ apiKey: options.apiKey, headers: options.headers, baseUrl: options.baseUrl });
    }

    return {
        id: backend.id,
        label: options.label || backend.label,
        configure: backend.configure,
        fetchModels: backend.fetchModels,
        createEmbedding: backend.createEmbedding
    };
}

const openAIBackend = createOpenAIEmbeddingBackend();

export default openAIBackend;
