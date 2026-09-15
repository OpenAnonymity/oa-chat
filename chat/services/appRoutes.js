import { SHARE_BASE_URL } from '../config.js';

let appRouteRoot = '/';

export function normalizeAppRouteRoot(value = '/') {
    const normalized = String(value || '/').trim();
    const pathSegments = normalized.split('/').filter(Boolean);
    if (!normalized.startsWith('/') || normalized.startsWith('//') || normalized.includes('\\') ||
        normalized.includes('?') || normalized.includes('#') ||
        pathSegments.some(segment => segment === '.' || segment === '..')) {
        throw new Error('routeRoot must be an absolute path without a query or fragment');
    }
    return normalized.endsWith('/') ? normalized : `${normalized}/`;
}

export function configureAppRouteRoot(value = '/') {
    appRouteRoot = normalizeAppRouteRoot(value);
    return appRouteRoot;
}

export function getAppRouteRoot() {
    return appRouteRoot;
}

export function getShareBaseUrl() {
    // Keep readers on the deployment that stored the share (staging, production,
    // or a mounted composition). Cross-origin links can point at another backend.
    if (typeof window === 'undefined') return SHARE_BASE_URL;
    try {
        const origin = new URL(window.location.origin);
        // Native app:// and opaque file origins are not public reader URLs.
        if (origin.protocol !== 'https:' && origin.protocol !== 'http:') return SHARE_BASE_URL;
        return new URL(appRouteRoot, origin).toString();
    } catch {
        return SHARE_BASE_URL;
    }
}
