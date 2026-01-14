const enclaveStationBackend = {
    id: 'enclave-station',
    label: 'Enclaved Station',
    accessLabel: 'session',
    accessShortLabel: 'Session',
    accessType: 'session',
    requestName: 'OA-WebApp-Session',
    defaultModelId: 'openai/gpt-5.2-chat',
    defaultModelName: 'OpenAI: GPT-5.2 Instant',
    tls: {
        captureHosts: [],
        verifyUrl: '',
        displayName: 'Enclaved Station'
    },
    fetchModels() {
        throw new Error('Enclaved Station backend not implemented: fetchModels');
    },
    getDisplayName(modelId, fallback) {
        return fallback || modelId;
    },
    sendCompletion() {
        throw new Error('Enclaved Station backend not implemented: sendCompletion');
    },
    streamCompletion() {
        throw new Error('Enclaved Station backend not implemented: streamCompletion');
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
        throw new Error('Enclaved Station backend not implemented: requestAccess');
    },
    verification: {
        supports: true,
        init() {},
        startBroadcastCheck() {},
        setBannedWarningCallback() {},
        submitAccess() {
            throw new Error('Enclaved Station backend not implemented: submitAccess');
        },
        setCurrentAccess() {},
        getAccessId(accessInfo) {
            return accessInfo?.stationId || null;
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
        return Promise.reject(new Error('Enclaved Station backend not implemented: testAccessToken'));
    }
};

export default enclaveStationBackend;
