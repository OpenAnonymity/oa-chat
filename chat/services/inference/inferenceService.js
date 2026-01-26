import openRouterBackend from './backends/openRouterBackend.js';
import enclaveStationBackend from './backends/enclaveStationBackend.js';
import providerDirectBackend from './backends/providerDirectBackend.js';
import transportHints from './transportHints.js';

const backends = new Map([
    [openRouterBackend.id, openRouterBackend],
    [enclaveStationBackend.id, enclaveStationBackend],
    [providerDirectBackend.id, providerDirectBackend]
]);

const DEFAULT_BACKEND_ID = openRouterBackend.id;

function getBackend(backendId) {
    if (backendId && backends.has(backendId)) {
        return backends.get(backendId);
    }
    return backends.get(DEFAULT_BACKEND_ID);
}

function ensureSessionBackend(session) {
    if (!session) return DEFAULT_BACKEND_ID;
    if (!session.inferenceBackend) {
        session.inferenceBackend = DEFAULT_BACKEND_ID;
    }
    return session.inferenceBackend;
}

function registerBackendTransportHints(backend) {
    if (!backend?.tls) return;
    transportHints.registerBackendHints(backend.id, {
        tlsCaptureHosts: backend.tls.captureHosts || [],
        tlsVerifyUrl: backend.tls.verifyUrl || '',
        tlsDisplayName: backend.tls.displayName || backend.label
    });
}

function getBackendForSession(session) {
    const backendId = session?.inferenceBackend;
    const backend = getBackend(backendId);
    registerBackendTransportHints(backend);
    return backend;
}

function syncTransportHints(session) {
    if (session) {
        getBackendForSession(session);
        return;
    }
    backends.forEach(backend => registerBackendTransportHints(backend));
}

function getWelcomeContent(backend = getBackend()) {
    const providerName = backend.label;
    const accessLabel = backend.accessLabel;
    return {
        title: '`oa-fastchat`',
        subtitle: 'A simple and extremely fast chat client by [The Open Anonymity Project](',
        content: ``.trim()
    };
}


const inferenceService = {
    getBackend,
    getBackendForSession,
    ensureSessionBackend,
    getDefaultBackendId() {
        return DEFAULT_BACKEND_ID;
    },
    getDefaultModelId(session) {
        return getBackendForSession(session).defaultModelId;
    },
    getDefaultModelName(session) {
        return getBackendForSession(session).defaultModelName;
    },
    getBackendLabel(session) {
        return getBackendForSession(session).label;
    },
    getAccessLabel(session) {
        return getBackendForSession(session).accessLabel;
    },
    getAccessShortLabel(session) {
        const backend = getBackendForSession(session);
        return backend.accessShortLabel || backend.accessLabel;
    },
    getTlsDisplayName(session) {
        const backend = getBackendForSession(session);
        return backend.tls?.displayName || backend.label;
    },
    fetchModels(session) {
        return getBackendForSession(session).fetchModels();
    },
    getDisplayName(modelId, fallback, session) {
        const backend = getBackendForSession(session);
        return backend.getDisplayName ? backend.getDisplayName(modelId, fallback) : fallback;
    },
    getAccessInfo(session) {
        return getBackendForSession(session).getAccessInfo(session);
    },
    getAccessToken(session) {
        return getBackendForSession(session).getAccessToken(session);
    },
    setAccessInfo(session, accessInfo) {
        return getBackendForSession(session).setAccessInfo(session, accessInfo);
    },
    clearAccessInfo(session) {
        return getBackendForSession(session).clearAccessInfo(session);
    },
    isAccessExpired(session) {
        return getBackendForSession(session).isAccessExpired(session);
    },
    async requestAccess(session, options = {}) {
        const backend = getBackendForSession(session);
        return backend.requestAccess(options);
    },
    async verifyAccess(session, accessInfo) {
        const backend = getBackendForSession(session);
        if (!backend.verification?.supports) return null;
        return backend.verification.submitAccess(accessInfo);
    },
    setCurrentAccess(session, accessInfo) {
        const backend = getBackendForSession(session);
        if (!backend.verification?.supports) return null;
        return backend.verification.setCurrentAccess(accessInfo, session);
    },
    getVerificationAdapter(session) {
        const backend = getBackendForSession(session);
        return backend.verification || null;
    },
    streamCompletion(messages, modelId, session, onChunk, onTokenUpdate, files, searchEnabled, abortController, onReasoningChunk, reasoningEnabled) {
        const backend = getBackendForSession(session);
        const token = backend.getAccessToken(session);
        return backend.streamCompletion(
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
        );
    },
    buildSharedAccessPayload(session) {
        const backend = getBackendForSession(session);
        const accessInfo = backend.getAccessInfo(session);
        if (!accessInfo?.token || !accessInfo?.info) return null;
        if (typeof backend.buildSharedAccessPayload === 'function') {
            const mergedInfo = {
                ...accessInfo.info,
                expiresAt: accessInfo.expiresAt || accessInfo.info?.expiresAt
            };
            return backend.buildSharedAccessPayload(mergedInfo);
        }
        return null;
    },
    buildLegacySharedApiKey(session, sharedAccess) {
        const backend = getBackendForSession(session);
        if (typeof backend.buildLegacySharedApiKey === 'function') {
            return backend.buildLegacySharedApiKey(sharedAccess);
        }
        return null;
    },
    legacySharedApiKeyToSharedAccess(sharedApiKey, backendId = DEFAULT_BACKEND_ID) {
        const backend = getBackend(backendId);
        if (typeof backend.legacySharedApiKeyToSharedAccess === 'function') {
            return backend.legacySharedApiKeyToSharedAccess(sharedApiKey);
        }
        return null;
    },
    validateSharedAccess(sharedAccess, backendId = sharedAccess?.backendId) {
        const backend = getBackend(backendId);
        if (typeof backend.validateSharedAccess === 'function') {
            return backend.validateSharedAccess(sharedAccess);
        }
        return { ok: true };
    },
    sharedAccessToSessionAccess(backendId, sharedAccess) {
        const backend = getBackend(backendId);
        if (typeof backend.sharedAccessToSessionAccess === 'function') {
            return backend.sharedAccessToSessionAccess(sharedAccess);
        }
        return null;
    },
    maskAccessToken(session, token) {
        const prefix = 'ek-oa-v1-';

        // Use current ephemeral key ID if available (with ek-oa-v1- prefix)
        if (session?.currentEphemeralKeyId && session?.ephemeralKeyMappings) {
            const id = session.currentEphemeralKeyId;
            return `${prefix}${id.slice(0, 6)}...${id.slice(-4)}`;
        }

        // Fallback to backend-specific masking (no prefix - not an ephemeral key)
        const backend = getBackendForSession(session);
        if (typeof backend.maskAccessToken === 'function') {
            return backend.maskAccessToken(token) || '';
        }
        if (token) {
            return `${token.slice(0, 6)}...${token.slice(-4)}`;
        }
        return '';
    },
    getUnderlyingKeyInfo(session) {
        const currentId = session?.currentEphemeralKeyId;
        const mappings = session?.ephemeralKeyMappings;
        if (!currentId || !mappings || !mappings[currentId]) return null;

        const mapping = mappings[currentId];
        const backend = getBackend(mapping.backendId);

        // Mask the underlying key using backend-specific masking
        let underlyingMask = null;
        if (typeof backend.maskAccessToken === 'function') {
            underlyingMask = backend.maskAccessToken(mapping.underlyingKeyId);
        } else if (mapping.underlyingKeyId) {
            underlyingMask = `${mapping.underlyingKeyId.slice(0, 6)}...${mapping.underlyingKeyId.slice(-4)}`;
        }

        return {
            backendId: mapping.backendId,
            backendLabel: backend?.label || 'Unknown',
            accessType: backend?.accessLabel || 'API key',
            underlyingMask: underlyingMask || ''
        };
    },
    buildCurlCommand(session, token, modelId) {
        const backend = getBackendForSession(session);
        if (typeof backend.buildCurlCommand === 'function') {
            return backend.buildCurlCommand(token, modelId);
        }
        return '';
    },
    testAccessToken(session, token, modelId) {
        const backend = getBackendForSession(session);
        if (typeof backend.testAccessToken === 'function') {
            return backend.testAccessToken(token, modelId);
        }
        return Promise.reject(new Error('Access test is not supported for this backend.'));
    },
    getWelcomeContent
};

syncTransportHints();

if (typeof window !== 'undefined') {
    window.inferenceService = inferenceService;
}

export default inferenceService;
