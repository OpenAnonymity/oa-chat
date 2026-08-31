const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

export const DEFAULT_PRODUCTION_ORG_ORIGIN = 'https://org.openanonymity.ai';

export function normalizePublicOrigin(rawValue, variableName = 'OA_ORG_ORIGIN') {
    const value = String(rawValue ?? '').trim();
    if (!value) return null;

    let parsed;
    try {
        parsed = new URL(value);
    } catch {
        throw new Error(`[build] ${variableName} must be an absolute URL origin.`);
    }

    const isLoopback = LOOPBACK_HOSTNAMES.has(parsed.hostname.toLowerCase());
    if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && isLoopback)) {
        throw new Error(`[build] ${variableName} must use HTTPS (HTTP is allowed only for loopback).`);
    }
    if (parsed.username || parsed.password) {
        throw new Error(`[build] ${variableName} must not contain credentials.`);
    }
    if ((parsed.pathname && parsed.pathname !== '/') || parsed.search || parsed.hash) {
        throw new Error(`[build] ${variableName} must be an origin without a path, query, or fragment.`);
    }

    return parsed.origin;
}

export function resolveBuildOrgOrigin(environment = process.env) {
    return normalizePublicOrigin(environment?.OA_ORG_ORIGIN, 'OA_ORG_ORIGIN');
}
