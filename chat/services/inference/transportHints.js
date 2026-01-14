const DEFAULT_HINTS = {
    tlsCaptureHosts: ['openrouter.ai'],
    tlsVerifyUrl: 'https://openrouter.ai/api/v1/models',
    tlsDisplayName: 'OpenRouter'
};

const hints = { ...DEFAULT_HINTS };

function setTransportHints(nextHints = {}) {
    if (!nextHints) return;
    if (Array.isArray(nextHints.tlsCaptureHosts)) {
        hints.tlsCaptureHosts = [...nextHints.tlsCaptureHosts];
    }
    if (typeof nextHints.tlsVerifyUrl === 'string') {
        hints.tlsVerifyUrl = nextHints.tlsVerifyUrl;
    }
    if (typeof nextHints.tlsDisplayName === 'string') {
        hints.tlsDisplayName = nextHints.tlsDisplayName;
    }
}

function getTransportHints() {
    return {
        tlsCaptureHosts: [...hints.tlsCaptureHosts],
        tlsVerifyUrl: hints.tlsVerifyUrl,
        tlsDisplayName: hints.tlsDisplayName
    };
}

function shouldCaptureTlsForUrl(url) {
    if (!url) return null;
    const hostMatch = hints.tlsCaptureHosts.find(host => url.includes(host));
    return hostMatch || null;
}

export { setTransportHints, getTransportHints, shouldCaptureTlsForUrl };

export default {
    setTransportHints,
    getTransportHints,
    shouldCaptureTlsForUrl
};
