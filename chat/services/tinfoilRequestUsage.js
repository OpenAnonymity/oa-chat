import { trackFeatureUsage } from './featureUsage.js';

// Wrap only the Tinfoil clients at construction, never global fetch. Arguments
// and results stay with the client; the optional host receives one fixed code.
const COMPLETION_METHODS = [
    'createResponse', 'streamResponse', 'createEmbedding',
    'createChatCompletion', 'streamChatCompletion'
];

export function withTinfoilRequestUsage(client) {
    const tracked = { ...client };
    for (const name of COMPLETION_METHODS) {
        const operation = client[name];
        if (typeof operation !== 'function') continue;
        tracked[name] = async (...args) => {
            const result = await operation.apply(client, args);
            // A resolved call is a client-observed completion, not a billing
            // receipt. Rejected/cancelled calls and internal failed retries do
            // not emit, even when the provider billed a partial response.
            trackFeatureUsage('tinfoil_request_completed');
            return result;
        };
    }
    return tracked;
}
