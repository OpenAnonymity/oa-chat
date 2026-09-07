import openRouterBackend from './backends/openRouterBackend.js';
import enclaveStationBackend from './backends/enclaveStationBackend.js';
import providerDirectBackend from './backends/providerDirectBackend.js';
import transportHints from './transportHints.js';
import { getDefaultModelConfig } from '../modelConfig.js';

const builtinBackends = [
    openRouterBackend,
    enclaveStationBackend,
    providerDirectBackend
];

export function createInferenceService(options = {}) {
    const configuredBackends = options.backends || builtinBackends;
    const backends = new Map(configuredBackends.map(backend => [backend.id, backend]));
    let defaultBackendId = options.defaultBackendId || configuredBackends[0]?.id;
    const legacyBackendId = options.legacyBackendId || defaultBackendId;
    if (!defaultBackendId || !backends.has(defaultBackendId)) {
        throw new Error('A registered default inference backend is required.');
    }
    if (backends.size !== configuredBackends.length) {
        throw new Error('Inference backend IDs must be unique.');
    }
    if (!backends.has(legacyBackendId)) throw new Error('A registered legacy inference backend is required.');

    function getBackend(backendId) {
        const selectedId = backendId || defaultBackendId;
        if (!backends.has(selectedId)) throw new Error(`Unknown inference backend: ${selectedId}`);
        return backends.get(selectedId);
    }

    function getLegacyBackendId(session) {
        const resolvedId = options.resolveLegacyBackendId?.(session) || legacyBackendId;
        getBackend(resolvedId);
        return resolvedId;
    }

    function ensureSessionBackend(session) {
        if (!session) return defaultBackendId;
        if (!session.inferenceBackend) {
            session.inferenceBackend = getLegacyBackendId(session);
        }
        getBackend(session.inferenceBackend);
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
        const backendId = session ? ensureSessionBackend(session) : defaultBackendId;
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
            title: 'oa-chat',
            subtitle: 'by [The Open Anonymity Project](https://openanonymity.ai/)',
            content: ``.trim()
        };
    }

    function getBackendDefaultModelConfig(backend) {
        if (typeof options.resolveDefaultModelConfig === 'function') {
            return options.resolveDefaultModelConfig(backend);
        }
        if (backend?.id === openRouterBackend.id) {
            return getDefaultModelConfig();
        }

        return {
            defaultModelId: backend?.defaultModelId || '',
            defaultModelName: backend?.defaultModelName || ''
        };
}

const inferenceService = {
    getBackend,
    getBackendForSession,
    getBackends: () => [...backends.values()],
    ensureSessionBackend,
    getLegacyBackendId,
    hasBackend: backendId => backends.has(backendId),
    getDefaultBackendId() {
        return defaultBackendId;
    },
    setDefaultBackendId(backendId) {
        if (!backends.has(backendId)) throw new Error(`Unknown inference backend: ${backendId}`);
        defaultBackendId = backendId;
        registerBackendTransportHints(getBackend(backendId));
        return backendId;
    },
    getDefaultModelId(session) {
        const backend = getBackendForSession(session);
        const defaults = getBackendDefaultModelConfig(backend);
        return defaults.defaultModelId || backend.defaultModelId;
    },
    getDefaultModelName(session) {
        const backend = getBackendForSession(session);
        const defaults = getBackendDefaultModelConfig(backend);
        return defaults.defaultModelName || backend.defaultModelName;
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
    getCachedModels(session) {
        const backend = getBackendForSession(session);
        return typeof backend.getCachedModels === 'function'
            ? backend.getCachedModels()
            : [];
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
    async generateSessionTitle(session, prompt, options = {}) {
        const backend = getBackendForSession(session);
        if (typeof backend.generateSessionTitle !== 'function') return '';
        const token = backend.getAccessToken(session);
        if (!token) return '';
        return backend.generateSessionTitle(prompt, token, options);
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
    sanitizePersistedAccess(session) {
        const backend = getBackendForSession(session);
        return typeof backend.sanitizePersistedAccess === 'function'
            ? backend.sanitizePersistedAccess(session)
            : false;
    },
    isAccessExpired(session) {
        return getBackendForSession(session).isAccessExpired(session);
    },
    async requestAccess(session, options = {}) {
        const backend = getBackendForSession(session);
        return backend.requestAccess({ ...options, session });
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
    streamCompletion(messages, modelId, session, onChunk, onTokenUpdate, files, searchEnabled, abortController, onStreamOpen, onReasoningChunk, reasoningEnabled, reasoningEffort, onAccessProgress) {
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
            onStreamOpen,
            onReasoningChunk,
            reasoningEnabled,
            reasoningEffort,
            onAccessProgress
        );
    },
    isTransportAccessReady(session) {
        const backend = getBackendForSession(session);
        if (typeof backend.isTransportAccessReady === 'function') return backend.isTransportAccessReady(session);
        return Boolean(backend.getAccessToken(session)) && !backend.isAccessExpired(session);
    },
    async sendCompletionStrict(messages, modelId, session, options = {}) {
        const backend = getBackendForSession(session);
        if (typeof backend.sendCompletionStrict !== 'function') {
            throw new Error(`Backend does not support strict completions: ${backend.id}`);
        }
        const token = backend.getAccessToken(session);
        return backend.sendCompletionStrict(messages, modelId, token, options);
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
    legacySharedApiKeyToSharedAccess(sharedApiKey, backendId = legacyBackendId) {
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
return inferenceService;
}

const inferenceService = createInferenceService();

if (typeof window !== 'undefined') {
    window.inferenceService = inferenceService;
}

export default inferenceService;
