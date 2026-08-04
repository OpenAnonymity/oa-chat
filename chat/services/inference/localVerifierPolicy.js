import { ORG_API_BASE } from '../../config.js';

const LOOPBACK_HOSTNAMES = new Set([
    'localhost',
    '127.0.0.1',
    '[::1]',
    '::1'
]);

function normalizeHostname(value) {
    return String(value || '').trim().toLowerCase();
}

export function isExplicitLoopbackHostname(hostname) {
    return LOOPBACK_HOSTNAMES.has(normalizeHostname(hostname));
}

export function isLocalVerifierBypassAllowed(options = {}) {
    const locationLike = options.locationLike ??
        (typeof window !== 'undefined' ? window.location : null);
    const orgApiBase = options.orgApiBase ?? ORG_API_BASE;

    if (!isExplicitLoopbackHostname(locationLike?.hostname)) return false;
    if (!['http:', 'https:'].includes(String(locationLike?.protocol || ''))) return false;

    try {
        const orgUrl = new URL(orgApiBase);
        return ['http:', 'https:'].includes(orgUrl.protocol) &&
            isExplicitLoopbackHostname(orgUrl.hostname);
    } catch {
        return false;
    }
}
