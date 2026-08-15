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
        authOrigin: apiBase
    };
}

export { ORG_API_BASE, ORG_AUTH_ORIGIN };
