import { ORG_API_BASE } from '../../config.js';

const LOOPBACK_HOSTNAMES = new Set([
    'localhost',
    '127.0.0.1',
    '[::1]',
    '::1'
]);
const buildAllowsDisposableDemoBypass = (
    typeof __OA_DEMO_VERIFIER_BYPASS__ !== 'undefined' &&
    __OA_DEMO_VERIFIER_BYPASS__ === true
);

function normalizeHostname(value) {
    return String(value || '').trim().toLowerCase();
}

export function isExplicitLoopbackHostname(hostname) {
    return LOOPBACK_HOSTNAMES.has(normalizeHostname(hostname));
}

function isOpenAnonymityHostname(hostname) {
    const normalized = normalizeHostname(hostname);
    return normalized === 'openanonymity.ai' ||
        normalized.endsWith('.openanonymity.ai');
}

export function getVerifierBypassDetail(options = {}) {
    const locationLike = options.locationLike ??
        (typeof window !== 'undefined' ? window.location : null);
    const orgApiBase = options.orgApiBase ?? ORG_API_BASE;
    const demoBypassEnabled = options.demoBypassEnabled ??
        buildAllowsDisposableDemoBypass;

    if (demoBypassEnabled === true) {
        try {
            const orgUrl = new URL(orgApiBase);
            const browserOrigin = String(locationLike?.origin || '');
            const browserHostname = normalizeHostname(locationLike?.hostname);
            if (
                locationLike?.protocol === 'https:' &&
                orgUrl.protocol === 'https:' &&
                orgUrl.origin === browserOrigin &&
                !isOpenAnonymityHostname(browserHostname)
            ) {
                return 'explicit_disposable_demo';
            }
        } catch {
            return null;
        }
        return null;
    }

    if (!isExplicitLoopbackHostname(locationLike?.hostname)) return null;
    if (!['http:', 'https:'].includes(String(locationLike?.protocol || ''))) return null;

    try {
        const orgUrl = new URL(orgApiBase);
        return ['http:', 'https:'].includes(orgUrl.protocol) &&
            isExplicitLoopbackHostname(orgUrl.hostname)
            ? 'explicit_loopback_development'
            : null;
    } catch {
        return null;
    }
}

export function isLocalVerifierBypassAllowed(options = {}) {
    return Boolean(getVerifierBypassDetail(options));
}
