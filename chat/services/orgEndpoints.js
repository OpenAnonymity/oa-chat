import {
    ORG_API_BASE,
    ORG_AUTH_ORIGIN,
    resolveOrgApiBase
} from '../config.js';

export function resolveOrgEndpoints({
    hostname = '',
    origin = '',
    localProxyEnabled = false
} = {}) {
    const apiBase = resolveOrgApiBase({ hostname, origin }, { localProxyEnabled });
    return {
        apiBase,
        authOrigin: ['localhost', '127.0.0.1', '[::1]', '::1'].includes(hostname)
            ? 'http://localhost:8005'
            : apiBase
    };
}

export { ORG_API_BASE, ORG_AUTH_ORIGIN };
