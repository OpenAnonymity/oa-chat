import zkapiAPI from '../../../api.js';
import zkapiClient from '@openanonymity/zkapi-browser-sdk/client';
import { DEFAULT_MODEL_ID, DEFAULT_MODEL_NAME } from '../../modelPricing.mjs';

export function createZkapiBackend(api = zkapiAPI) {
    const zkapiBackend = {
        id: 'zkapi',
        label: 'Private inference',
        accessLabel: 'private session',
        accessShortLabel: 'session',
        accessType: 'zkapi-session',
        requiresTickets: false,
        // Reuse OA's proven exhausted-key recovery path. Clearing access marks the
        // current session lease for immediate settlement; requestAccess performs
        // that settlement before OA retries with a freshly issued child key.
        refreshOnCreditExhaustion: true,
        baseUrl: window.location.origin,
        defaultModelId: DEFAULT_MODEL_ID,
        defaultModelName: DEFAULT_MODEL_NAME,
        tls: null,

        getCachedModels: () => api.getCachedModels(),
        fetchModels: () => api.fetchModels(),
        getDisplayName: (modelId, fallback) => api.getDisplayName(modelId, fallback),
        sendCompletion: (messages, modelId, token) => api.sendCompletion(messages, modelId, token),
        sendCompletionStrict: (messages, modelId, token, options) => api.sendCompletionStrict(messages, modelId, token, options),
        generateSessionTitle: (prompt, token, options) => api.generateSessionTitle(prompt, token, options),
        streamCompletion: (
            messages,
            modelId,
            token,
            onChunk,
            onTokenUpdate,
            files,
            searchEnabled,
            abortController,
            onStreamOpen,
            onReasoningChunk,
            reasoningEnabled,
            reasoningEffort,
            onAccessProgress
        ) => api.streamCompletion(
            messages,
            modelId,
            token,
            onChunk,
            onTokenUpdate,
            files,
            searchEnabled,
            abortController,
            onStreamOpen,
            onReasoningChunk,
            reasoningEnabled,
            reasoningEffort,
            onAccessProgress
        ),

        getAccessInfo(session) {
            if (!session) return null;
            return {
                token: session.apiKey || null,
                info: session.apiKeyInfo || null,
                expiresAt: null
            };
        },

        getAccessToken(session) {
            return session?.apiKey || null;
        },

        // requestAccess installs only the opaque chat binding. The real bounded
        // OpenRouter key is obtained by api.js when the first request starts.
        isTransportAccessReady(session) {
            return zkapiClient.activeLease?.session_id === session?.id;
        },

        setAccessInfo(session, accessInfo) {
            if (!session) return;
            const token = accessInfo?.key || accessInfo?.token || session.id;
            session.zkapiSessionId = token;
            session.apiKey = token;
            session.apiKeyInfo = {
                ...(accessInfo || {}),
                key: token,
                backendId: zkapiBackend.id,
                sessionBound: true
            };
            session.expiresAt = null;
            session.currentEphemeralKeyId = token;
        },

        clearAccessInfo(session) {
            if (!session) return;
            if (zkapiClient.activeLease?.session_id === session.id) {
                session.zkapiSettleBeforeAccess = true;
            }
            session.apiKey = null;
            session.apiKeyInfo = null;
            session.expiresAt = null;
            session.currentEphemeralKeyId = null;
        },

        isAccessExpired(session) {
            return !this.getAccessToken(session);
        },

        async requestAccess({ session, signal } = {}) {
            if (signal?.aborted) {
                const error = new Error('Request aborted');
                error.name = 'AbortError';
                error.isCancelled = true;
                throw error;
            }
            if (!session?.id) throw new Error('No active chat is available.');
            if (session.zkapiSettleBeforeAccess) {
                await zkapiClient.settleActiveLease(undefined, { sessionId: session.id });
                delete session.zkapiSettleBeforeAccess;
            }
            const token = session.zkapiSessionId || session.apiKey || session.id;
            return {
                key: token,
                token,
                backendId: zkapiBackend.id,
                sessionBound: true
            };
        },

        verification: { supports: false },

        maskAccessToken(token) {
            if (!token) return '';
            return token.length > 16 ? `${token.slice(0, 8)}…${token.slice(-6)}` : token;
        },

        buildCurlCommand(token, modelId) {
            return `curl ${window.location.origin}/v1/chat/completions \\\n  -H "Content-Type: application/json" \\\n  -H "x-zkapi-session-id: ${token}" \\\n  -d '{"model":"${modelId}","messages":[{"role":"user","content":"Hi"}]}'`;
        },

        async testAccessToken(token, modelId) {
            return fetch('/v1/chat/completions', {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    'x-zkapi-session-id': token
                },
                body: JSON.stringify({
                    model: modelId,
                    messages: [{ role: 'user', content: 'Hi' }],
                    stream: false
                })
            });
        }
    };
    return zkapiBackend;
}

export default createZkapiBackend();
