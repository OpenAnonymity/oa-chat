import { createOpenAICompatibleBackend } from './httpOpenAIBackend.js';

const vllmBackend = createOpenAICompatibleBackend({
    id: 'vllm',
    label: 'vLLM',
    baseUrl: 'http://localhost:8000',
    defaultModelId: 'local-model',
    defaultModelName: 'vLLM model',
    providerLabel: 'vLLM',
    modelsEndpoint: '/v1/models',
    chatEndpoint: '/v1/chat/completions'
});

export default vllmBackend;
