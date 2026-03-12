import { createOpenAICompatibleBackend } from './httpOpenAIBackend.js';

const tinfoilBackend = createOpenAICompatibleBackend({
    id: 'tinfoil',
    label: 'Confidential Model (TEE)',
    baseUrl: 'https://inference.tinfoil.sh',
    defaultModelId: 'gpt-oss-120b',
    defaultModelName: 'gpt-oss-120b',
    providerLabel: 'Confidential Model (TEE)',
    modelsEndpoint: '/v1/models',
    chatEndpoint: '/v1/chat/completions'
});

export default tinfoilBackend;
