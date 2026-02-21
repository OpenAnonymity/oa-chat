import openRouterAPI from '../../../api.js';
import ticketClient from '../../ticketClient.js';
import networkProxy from '../../networkProxy.js';
import stationVerifier from '../../verifier.js';

const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
const OPENROUTER_MODELS_URL = `${OPENROUTER_BASE_URL}/models`;
const OPENROUTER_CHAT_COMPLETIONS_URL = `${OPENROUTER_BASE_URL}/chat/completions`;

function generateEphemeralKeyId() {
    const bytes = new Uint8Array(5); // 5 bytes = 10 hex chars
    crypto.getRandomValues(bytes);
    return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

const openRouterBackend = {
    id: 'openrouter',
    label: 'OpenRouter',
    accessLabel: 'API key',
    accessShortLabel: 'API',
    accessType: 'api-key',
    baseUrl: OPENROUTER_BASE_URL,
    defaultModelId: 'openai/gpt-5.2-chat',
    defaultModelName: 'OpenAI: GPT-5.2 Instant',
    tls: {
        captureHosts: ['openrouter.ai'],
        verifyUrl: OPENROUTER_MODELS_URL,
        displayName: 'OpenRouter'
    },
    fetchModels: () => openRouterAPI.fetchModels(),
    getDisplayName: (modelId, fallback) => openRouterAPI.getDisplayName(modelId, fallback),
    sendCompletion: (messages, modelId, token) => openRouterAPI.sendCompletion(messages, modelId, token),
    streamCompletion: (messages, modelId, token, onChunk, onTokenUpdate, files, searchEnabled, abortController, onReasoningChunk, reasoningEnabled) =>
        openRouterAPI.streamCompletion(
            messages,
            modelId,
            token,
            onChunk,
            onTokenUpdate,
            files,
            searchEnabled,
            abortController,
            onReasoningChunk,
            reasoningEnabled
        ),
    getAccessInfo(session) {
        if (!session) return null;
        return {
            token: session.apiKey || null,
            info: session.apiKeyInfo || null,
            expiresAt: session.expiresAt ||
                session.apiKeyInfo?.expiresAt ||
                session.apiKeyInfo?.expires_at ||
                null
        };
    },
    getAccessToken(session) {
        return session?.apiKey || null;
    },
    setAccessInfo(session, accessInfo) {
        if (!session || !accessInfo) return;
        session.apiKey = accessInfo.key || accessInfo.token || null;
        session.apiKeyInfo = accessInfo;
        session.expiresAt = accessInfo.expiresAt || accessInfo.expires_at || null;

        // Accumulate ephemeral key mappings (ephemeralKeyId -> underlying key info)
        if (session.apiKey) {
            if (!session.ephemeralKeyMappings) {
                session.ephemeralKeyMappings = {};
            }

            // Check if this underlying key already has a mapping
            const existingId = Object.keys(session.ephemeralKeyMappings).find(
                id => session.ephemeralKeyMappings[id].underlyingKeyId === session.apiKey
            );

            if (existingId) {
                // Reuse existing ephemeral ID for this underlying key
                session.currentEphemeralKeyId = existingId;
            } else {
                // Generate new ephemeral ID for new underlying key
                const newEphemeralId = generateEphemeralKeyId();
                session.ephemeralKeyMappings[newEphemeralId] = {
                    underlyingKeyId: session.apiKey,
                    backendId: openRouterBackend.id,
                    createdAt: Date.now()
                };
                session.currentEphemeralKeyId = newEphemeralId;
            }
        }
    },
    clearAccessInfo(session) {
        if (!session) return;
        session.apiKey = null;
        session.apiKeyInfo = null;
        session.expiresAt = null;
        // Keep ephemeralKeyMappings for history, just clear current pointer
        session.currentEphemeralKeyId = null;
    },
    isAccessExpired(session) {
        if (!session?.apiKey) return true;
        if (!session.expiresAt) return true;
        return new Date(session.expiresAt) <= new Date();
    },
    async requestAccess({ ticketsRequired }) {
        return ticketClient.requestApiKey(ticketsRequired || 1);
    },
    verification: {
        supports: true,
        init: () => stationVerifier.init(),
        startBroadcastCheck: (getCurrentSession) => stationVerifier.startBroadcastCheck(getCurrentSession),
        setBannedWarningCallback: (callback) => stationVerifier.setBannedWarningCallback(callback),
        submitAccess: (accessInfo) => stationVerifier.submitKey(accessInfo),
        setCurrentAccess: (accessInfo, session) => {
            if (accessInfo?.stationId) {
                stationVerifier.setCurrentStation(accessInfo.stationId, session);
            }
        },
        getAccessId: (accessInfo) => accessInfo?.stationId || null,
        getAccessState: (accessId) => stationVerifier.getStationState(accessId),
        isAccessBanned: (accessId) => stationVerifier.isStationBanned(accessId),
        getLastBroadcastData: () => stationVerifier.getLastBroadcastData()
    },
    buildSharedAccessPayload(accessInfo) {
        if (!accessInfo) return null;
        return {
            backendId: 'openrouter',
            token: accessInfo.key || accessInfo.token || null,
            expiresAt: accessInfo.expiresAt || accessInfo.expires_at || null,
            expiresAtUnix: accessInfo.expiresAtUnix || accessInfo.expires_at_unix || null,
            stationId: accessInfo.stationId || accessInfo.station_id || accessInfo.station_name || null,
            recentlyAttested: accessInfo.recentlyAttested || accessInfo.station_recently_attested || false,
            stationSignature: accessInfo.stationSignature || accessInfo.station_signature || null,
            orgSignature: accessInfo.orgSignature || accessInfo.org_signature || null,
            usage: accessInfo.usage || null
        };
    },
    buildLegacySharedApiKey(sharedAccess) {
        if (!sharedAccess) return null;
        return {
            key: sharedAccess.token,
            stationId: sharedAccess.stationId,
            recentlyAttested: sharedAccess.recentlyAttested || false,
            expiresAt: sharedAccess.expiresAt,
            expiresAtUnix: sharedAccess.expiresAtUnix,
            stationSignature: sharedAccess.stationSignature,
            orgSignature: sharedAccess.orgSignature,
            usage: sharedAccess.usage || null
        };
    },
    legacySharedApiKeyToSharedAccess(sharedApiKey) {
        if (!sharedApiKey?.key) return null;
        return {
            backendId: 'openrouter',
            token: sharedApiKey.key,
            expiresAt: sharedApiKey.expiresAt || null,
            expiresAtUnix: sharedApiKey.expiresAtUnix || null,
            stationId: sharedApiKey.stationId || null,
            recentlyAttested: sharedApiKey.recentlyAttested || false,
            stationSignature: sharedApiKey.stationSignature || null,
            orgSignature: sharedApiKey.orgSignature || null,
            usage: sharedApiKey.usage || null
        };
    },
    validateSharedAccess(sharedAccess) {
        const missing = [];
        if (!sharedAccess?.stationSignature) missing.push('stationSignature');
        if (!sharedAccess?.orgSignature) missing.push('orgSignature');
        if (!sharedAccess?.expiresAtUnix) missing.push('expiresAtUnix');
        if (missing.length > 0) {
            return { ok: false, missing };
        }
        return { ok: true };
    },
    sharedAccessToSessionAccess(sharedAccess) {
        if (!sharedAccess?.token) return null;
        return {
            token: sharedAccess.token,
            expiresAt: sharedAccess.expiresAt || null,
            info: {
                stationId: sharedAccess.stationId,
                station_name: sharedAccess.stationId,
                recentlyAttested: sharedAccess.recentlyAttested || false,
                usage: sharedAccess.usage || null,
                isShared: true,
                key: sharedAccess.token,
                expiresAtUnix: sharedAccess.expiresAtUnix,
                stationSignature: sharedAccess.stationSignature,
                orgSignature: sharedAccess.orgSignature
            }
        };
    },
    maskAccessToken(token) {
        if (!token) return '';
        return `${token.slice(0, 15)}...${token.slice(-4)}`;
    },
    buildCurlCommand(token, modelId) {
        return `curl ${OPENROUTER_CHAT_COMPLETIONS_URL} \\\n  -H "Content-Type: application/json" \\\n  -H "Authorization: Bearer ${token}" \\\n  -d '{"model":"${modelId}","messages":[{"role":"user","content":"Hi"}]}' \\\n  | grep -o '"content":"[^"]*"' | head -1`;
    },
    async testAccessToken(token, modelId) {
        return networkProxy.fetch(OPENROUTER_CHAT_COMPLETIONS_URL, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                model: modelId,
                messages: [{ role: 'user', content: 'Hi' }]
            })
        });
    }
};

export default openRouterBackend;
