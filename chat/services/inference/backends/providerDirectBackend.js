const providerDirectBackend = {
    id: 'provider-direct',
    label: 'Provider Direct',
    accessLabel: 'access token',
    accessShortLabel: 'Token',
    accessType: 'token',
    requestName: 'OA-WebApp-Token',
    defaultModelId: 'openai/gpt-5.2-chat',
    defaultModelName: 'OpenAI: GPT-5.2 Instant',
    tls: {
        captureHosts: [],
        verifyUrl: '',
        displayName: 'Provider Direct'
    },
    fetchModels() {
        throw new Error('Provider Direct backend not implemented: fetchModels');
    },
    getDisplayName(modelId, fallback) {
        return fallback || modelId;
    },
    sendCompletion() {
        throw new Error('Provider Direct backend not implemented: sendCompletion');
    },
    streamCompletion() {
        throw new Error('Provider Direct backend not implemented: streamCompletion');
    },
    getAccessInfo(session) {
        if (!session) return null;
        return {
            token: session.apiKey || null,
            info: session.apiKeyInfo || null,
            expiresAt: session.expiresAt || null
        };
    },
    getAccessToken(session) {
        return session?.apiKey || null;
    },
    setAccessInfo(session, accessInfo) {
        if (!session || !accessInfo) return;
        session.apiKey = accessInfo.key || accessInfo.token || null;
        session.apiKeyInfo = accessInfo;
        session.expiresAt = accessInfo.expiresAt || null;
    },
    clearAccessInfo(session) {
        if (!session) return;
        session.apiKey = null;
        session.apiKeyInfo = null;
        session.expiresAt = null;
    },
    isAccessExpired(session) {
        if (!session?.apiKey) return true;
        if (!session.expiresAt) return true;
        return new Date(session.expiresAt) <= new Date();
    },
    async requestAccess() {
        throw new Error('Provider Direct backend not implemented: requestAccess');
    },
    verification: {
        supports: false,
        init() {},
        startBroadcastCheck() {},
        setBannedWarningCallback() {},
        submitAccess() {
            throw new Error('Provider Direct backend does not support verification');
        },
        setCurrentAccess() {},
        getAccessId() {
            return null;
        },
        getAccessState() {
            return null;
        },
        isAccessBanned() {
            return false;
        },
        getLastBroadcastData() {
            return null;
        }
    },
    buildSharedAccessPayload() {
        return null;
    },
    buildLegacySharedApiKey() {
        return null;
    },
    sharedAccessToSessionAccess() {
        return null;
    },
    maskAccessToken(token) {
        if (!token) return '';
        return `${token.slice(0, 6)}...${token.slice(-4)}`;
    },
    buildCurlCommand() {
        return '';
    },
    testAccessToken() {
        return Promise.reject(new Error('Provider Direct backend not implemented: testAccessToken'));
    }
};

export default providerDirectBackend;
