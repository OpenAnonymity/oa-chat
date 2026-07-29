const LOCAL_ORG_HOSTS = new Set(['localhost', '127.0.0.1']);
const PRODUCTION_ORG_ORIGIN = 'https://org.openanonymity.ai';
const LOCAL_AUTH_ORIGIN = 'http://localhost:8005';

export function resolveOrgEndpoints({
    hostname = '',
    origin = '',
    localProxyEnabled = false
} = {}) {
    if (localProxyEnabled && LOCAL_ORG_HOSTS.has(hostname)) {
        return {
            apiBase: origin,
            authOrigin: LOCAL_AUTH_ORIGIN
        };
    }
    return {
        apiBase: PRODUCTION_ORG_ORIGIN,
        authOrigin: PRODUCTION_ORG_ORIGIN
    };
}

const currentEndpoints = resolveOrgEndpoints({
    hostname: typeof window === 'undefined' ? '' : window.location.hostname,
    origin: typeof window === 'undefined' ? '' : window.location.origin,
    localProxyEnabled: globalThis.__OA_LOCAL_ORG_PROXY__ === true
});

export const ORG_API_BASE = currentEndpoints.apiBase;
export const ORG_AUTH_ORIGIN = currentEndpoints.authOrigin;
