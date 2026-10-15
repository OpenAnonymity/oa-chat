// The base URL a deployment's service answers at.
//
// A deployment pins `protocol_server_url` (and its indexer, which shares it).
// The SDK appends its own routes to that string (`/v2/billing/quote`,
// `/v2/openrouter/leases`, `/v1/tree/snapshot`, `/config.json`), so the pin is
// a base URL: an origin, or an origin plus a path prefix.
//
// Why a prefix is allowed. Two protocol generations answer on the same route
// names (`/v2/...`, `/config.json`), so an operator who runs both on one
// hostname has to tell them apart by something the browser can vary, and the
// only such thing is the URL path: the SDK's requests carry no custom header,
// and the host's static rewrite cannot add one. The older deployment keeps the
// root it was pinned at (a live pin cannot move), and the newer one is served
// under a prefix of the same hostname:
//
//   version 1   https://zkapi.example.com            (root)
//   version 2   https://zkapi.example.com/c          (prefix `/c`)
//
// The prefix is part of the pin and of the manifest the service publishes (the
// SDK requires the two to be equal), never something the host adds behind the
// SDK's back: a pin that named the bare origin while the rewrite sent traffic
// to a prefix would make the pinned URL a claim the service does not live at.
//
// Pure and SDK-free by rule: it runs in the build scripts and the registry
// model, before any SDK build is chosen. No Node built-ins, fetch, storage or
// clock.

/**
 * Names that cannot be the first segment of a prefix: they are routes of the
 * protocol itself (a prefix named like one would shadow the root deployment's
 * own API on the same hostname) or of this app's proxy.
 */
export const RESERVED_PREFIX_SEGMENTS = Object.freeze(['v1', 'v2', 'config.json', '_bundler']);

/** A prefix is at most this many plain segments and characters. */
export const MAX_PREFIX_SEGMENTS = 3;
export const MAX_PREFIX_LENGTH = 96;

const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,63}$/;

/**
 * The prefix of a URL pathname: '' for the root, '/a/b' for a plain path, or
 * null for anything else (empty segments, a trailing slash, dot segments,
 * percent escapes, a reserved first segment, too many or too long).
 */
export function pathPrefix(pathname) {
    if (pathname === '/') return '';
    if (typeof pathname !== 'string' || !pathname.startsWith('/') || pathname.endsWith('/')) return null;
    if (pathname.length > MAX_PREFIX_LENGTH) return null;
    const segments = pathname.slice(1).split('/');
    if (segments.length > MAX_PREFIX_SEGMENTS) return null;
    for (const segment of segments) {
        if (!SEGMENT.test(segment) || segment === '.' || segment === '..' || segment.endsWith('.')) return null;
    }
    if (RESERVED_PREFIX_SEGMENTS.includes(segments[0].toLowerCase())) return null;
    return pathname;
}

/**
 * Parse a service base URL: `{origin, prefix, base}` (`base` is the origin
 * plus the prefix, without a trailing slash, the form that is compared and
 * that the SDK appends its routes to) or null for anything that is not a
 * credential-free HTTPS URL with no query or fragment and a plain prefix.
 */
export function parseServiceBase(value) {
    let url;
    try {
        url = new URL(value);
    } catch {
        return null;
    }
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) return null;
    const prefix = pathPrefix(url.pathname);
    if (prefix === null) return null;
    // A prefixed pin is exact: the SDK appends its routes to the string it is
    // given, and a trailing slash would double up ("//v2/...").
    if (prefix !== '' && value !== `${url.origin}${prefix}`) return null;
    return { origin: url.origin, prefix, base: `${url.origin}${prefix}` };
}

/**
 * Whether two parsed bases cannot both be served: the same base, or two
 * non-empty prefixes of one hostname where one contains the other (a request
 * under the inner one would be the outer one's as well). A root and a prefix
 * of the same origin are distinct: the root's routes are fixed names, and the
 * prefix's first segment is never one of them.
 */
export function servicesOverlap(left, right) {
    if (!left || !right || left.origin !== right.origin) return false;
    if (left.prefix === right.prefix) return true;
    if (left.prefix === '' || right.prefix === '') return false;
    return `${left.prefix}/`.startsWith(`${right.prefix}/`) || `${right.prefix}/`.startsWith(`${left.prefix}/`);
}

/**
 * The proxy rewrite of a service under a version's `proxyPath`. The SDK sends
 * `<proxyPath><path of the target URL>`, so the rewrite carries the prefix on
 * both sides: only the service's own subtree is forwarded, and a version's
 * proxy path never reaches another deployment's routes on the same hostname.
 *
 *   proxyPath /zkapi-deployment-v2c/, base https://h/c
 *     /zkapi-deployment-v2c/c/:path*  ->  https://h/c/:path*
 *
 * null when `proxyPath` or `base` is unusable.
 */
export function proxyRewrite(proxyPath, base) {
    if (typeof proxyPath !== 'string' || !/^\/[A-Za-z0-9._~\-/]*\/$/.test(proxyPath) || proxyPath.includes('//')) return null;
    const parsed = typeof base === 'string' ? parseServiceBase(base) : base;
    if (!parsed) return null;
    const inside = parsed.prefix ? `${parsed.prefix.slice(1)}/` : '';
    return { source: `${proxyPath}${inside}:path*`, destination: `${parsed.origin}${parsed.prefix}/:path*` };
}
