export function resolveProxyFetchTimeoutMs(resource, browserOrigin, demoTimeoutMs) {
    if (!Number.isFinite(demoTimeoutMs) || demoTimeoutMs <= 0 || !browserOrigin) {
        return null;
    }

    try {
        const rawUrl = typeof resource === 'string' ? resource : resource?.url;
        const requestUrl = new URL(rawUrl, browserOrigin);
        return requestUrl.origin === new URL(browserOrigin).origin ? demoTimeoutMs : null;
    } catch {
        return null;
    }
}

export async function guardProxyFetch(fetchOperation, options = {}) {
    const signal = options.signal || null;
    const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
        ? options.timeoutMs
        : null;

    if (signal?.aborted) {
        const error = new Error('Request aborted');
        error.name = 'AbortError';
        throw error;
    }
    if (!timeoutMs && !signal) {
        return fetchOperation();
    }

    let timeoutId = null;
    let abortHandler = null;
    const guard = new Promise((_, reject) => {
        if (timeoutMs) {
            timeoutId = setTimeout(() => {
                const error = new Error('Network proxy request timed out');
                error.code = 'PROXY_TIMEOUT';
                reject(error);
            }, timeoutMs);
        }
        if (signal) {
            abortHandler = () => {
                const error = new Error('Request aborted');
                error.name = 'AbortError';
                reject(error);
            };
            signal.addEventListener('abort', abortHandler, { once: true });
        }
    });

    try {
        return await Promise.race([fetchOperation(), guard]);
    } finally {
        if (timeoutId !== null) clearTimeout(timeoutId);
        if (signal && abortHandler) signal.removeEventListener('abort', abortHandler);
    }
}
