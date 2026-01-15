const DEFAULT_HINTS = {
    tlsCaptureHosts: [],
    tlsVerifyUrl: '',
    tlsDisplayName: 'Inference backend'
};

const captureHosts = new Set(DEFAULT_HINTS.tlsCaptureHosts);
const backendHints = new Map();

function normalizeHints(nextHints = {}) {
    const normalized = {
        tlsCaptureHosts: Array.isArray(nextHints.tlsCaptureHosts)
            ? nextHints.tlsCaptureHosts.filter(Boolean)
            : [],
        tlsVerifyUrl: typeof nextHints.tlsVerifyUrl === 'string' ? nextHints.tlsVerifyUrl : '',
        tlsDisplayName: typeof nextHints.tlsDisplayName === 'string'
            ? nextHints.tlsDisplayName
            : DEFAULT_HINTS.tlsDisplayName
    };
    return normalized;
}

function registerBackendHints(backendId, nextHints = {}) {
    if (!backendId) return;
    const normalized = normalizeHints(nextHints);
    normalized.tlsCaptureHosts.forEach(host => captureHosts.add(host));
    backendHints.set(backendId, normalized);
}

function getBackendHints(backendId) {
    if (backendId && backendHints.has(backendId)) {
        const stored = backendHints.get(backendId);
        return {
            tlsCaptureHosts: [...stored.tlsCaptureHosts],
            tlsVerifyUrl: stored.tlsVerifyUrl,
            tlsDisplayName: stored.tlsDisplayName
        };
    }
    return {
        tlsCaptureHosts: [...captureHosts],
        tlsVerifyUrl: DEFAULT_HINTS.tlsVerifyUrl,
        tlsDisplayName: DEFAULT_HINTS.tlsDisplayName
    };
}

function getTransportHints() {
    return {
        tlsCaptureHosts: [...captureHosts],
        tlsVerifyUrl: DEFAULT_HINTS.tlsVerifyUrl,
        tlsDisplayName: DEFAULT_HINTS.tlsDisplayName
    };
}

function shouldCaptureTlsForUrl(url) {
    if (!url) return null;
    for (const host of captureHosts) {
        if (url.includes(host)) {
            return host;
        }
    }
    return null;
}

export { registerBackendHints, getBackendHints, getTransportHints, shouldCaptureTlsForUrl };

export default {
    registerBackendHints,
    getBackendHints,
    getTransportHints,
    shouldCaptureTlsForUrl
};
