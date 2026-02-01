import { createOpenAICompatibleBackend } from './httpOpenAIBackend.js';

const tinfoilBackend = createOpenAICompatibleBackend({
    id: 'tinfoil',
    label: 'Tinfoil',
    baseUrl: 'https://inference.tinfoil.sh',
    defaultModelId: 'gpt-oss-120b',
    defaultModelName: 'gpt-oss-120b',
    providerLabel: 'Tinfoil',
    modelsEndpoint: '/v1/models',
    chatEndpoint: '/v1/chat/completions'
});

export default tinfoilBackend;
