// Sponsored withdrawals, the data half: what a reviewed profile may say about
// them and where this app routes them.
//
// A sponsored (gasless) withdrawal pays its network fee out of its payout
// through an ERC-4337 operation (docs/ZKAPI_VERSIONING.md, the section on
// sponsored withdrawals). The profile of a deployment that supports it pins a
// `gasless` object: the EntryPoint, the withdrawal paymaster, its account
// factory, the transit account's creation code, the paymaster's policy and
// the operator's bundler URL.
//
// Pure and SDK-free by rule (it runs in the build scripts, before any SDK
// build is chosen, and in the facade): no Node built-ins, fetch, storage or
// clock.
//
// The bundler is never called from the page. Like the operator's service
// (`proxyPath`), it is reached through a route of the app's own host, which
// forwards to the bundler URL the reviewed profile pins:
//
//   <proxyPath>_bundler   ->   gasless.bundler_url
//
// The route is derived from the version's proxy path, so a version that has
// one has this one, and it sits under it: a rewrite of the generated Vercel
// configuration listed BEFORE the version's own proxy rewrite, which would
// otherwise swallow it and send it to the operator's service.

/** The last segment of a version's bundler route (after its proxy path). */
export const BUNDLER_ROUTE_SEGMENT = '_bundler';

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const WORD = /^0x[0-9a-fA-F]{64}$/;
const HEX = /^0x(?:[0-9a-fA-F]{2})+$/;
const DECIMAL = /^[0-9]{1,78}$/;
const MAX_CREATION_CODE_HEX_CHARACTERS = 2 + 2 * 24_576;

const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * The route of a version's bundler: its proxy path plus the bundler segment.
 * null for anything that is not an absolute directory path.
 */
export function bundlerRoutePath(proxyPath) {
    if (typeof proxyPath !== 'string' || !/^\/[A-Za-z0-9._~\-/]*\/$/.test(proxyPath) || proxyPath.includes('//')
        || proxyPath.split('/').includes('..')) return null;
    return `${proxyPath}${BUNDLER_ROUTE_SEGMENT}`;
}

/** The route as an absolute URL under `origin` (the page's own). null when either is unusable. */
export function bundlerRouteUrl(origin, proxyPath) {
    const route = bundlerRoutePath(proxyPath);
    if (!route || typeof origin !== 'string') return null;
    try {
        const url = new URL(origin);
        if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) return null;
        const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
        if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) return null;
        return `${url.origin}${route}`;
    } catch {
        return null;
    }
}

/**
 * The bundler URL a profile pins, or null: an absolute HTTPS URL without
 * credentials, query or fragment (the operator's endpoint; the app's route
 * forwards to it). Used by the route generator.
 */
export function pinnedBundlerUrl(gasless) {
    if (!isRecord(gasless) || typeof gasless.bundler_url !== 'string') return null;
    try {
        const url = new URL(gasless.bundler_url);
        if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) return null;
        return url.href;
    } catch {
        return null;
    }
}

function amount(value) {
    return (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)
        || (typeof value === 'string' && DECIMAL.test(value));
}

/**
 * Why a `gasless` object of a reviewed profile cannot be used, or null when it
 * is absent (`null`/undefined: a profile that offers no sponsored
 * withdrawals), a placeholder, or complete. The host reads only what it
 * needs to judge an operation and to route it; the SDK reads the same object
 * for itself and refuses a profile it cannot use. A pinned object that is
 * incomplete is a mistake in the review, found here at build time.
 */
export function sponsoredProfileProblem(gasless) {
    if (gasless === null || gasless === undefined) return null;
    if (!isRecord(gasless)) return 'The profile\'s gasless pins must be an object or null.';
    if (gasless.deployment_status === 'not_deployed') return null;
    if (gasless.deployment_status != null && gasless.deployment_status !== 'deployed') {
        return 'The profile\'s gasless pins have an unknown deployment_status.';
    }
    for (const field of ['entry_point_address', 'sender_creator_address', 'withdrawal_paymaster_address',
        'withdrawal_account_factory_address']) {
        if (typeof gasless[field] !== 'string' || !ADDRESS.test(gasless[field])) {
            return `The profile's gasless ${field} must be an address.`;
        }
    }
    for (const field of ['entry_point_runtime_codehash', 'sender_creator_runtime_codehash',
        'withdrawal_paymaster_runtime_codehash', 'withdrawal_account_factory_runtime_codehash',
        'account_creation_code_keccak256']) {
        if (typeof gasless[field] !== 'string' || !WORD.test(gasless[field])) {
            return `The profile's gasless ${field} must be a 32-byte hash.`;
        }
    }
    const code = gasless.account_creation_code;
    if (typeof code !== 'string' || !HEX.test(code) || code.length > MAX_CREATION_CODE_HEX_CHARACTERS) {
        return 'The profile\'s gasless account_creation_code must be hex bytes.';
    }
    if (pinnedBundlerUrl(gasless) === null) {
        return 'The profile\'s gasless bundler_url must be a credential-free HTTPS URL (the app routes to it).';
    }
    if (!isRecord(gasless.policy) || !amount(gasless.policy.max_sponsored_cost_wei) || !amount(gasless.policy.flat_fee_wei)) {
        return 'The profile\'s gasless policy must carry max_sponsored_cost_wei and flat_fee_wei.';
    }
    if (!isRecord(gasless.fee_ceilings) || !amount(gasless.fee_ceilings.max_fee_wei)
        || !amount(gasless.fee_ceilings.priority_fee_wei)) {
        return 'The profile\'s gasless fee_ceilings must carry max_fee_wei and priority_fee_wei.';
    }
    if (!isRecord(gasless.gas_policy)) return 'The profile\'s gasless gas_policy must be an object.';
    return null;
}

/** Whether a reviewed profile pins sponsored withdrawals completely. */
export function profilePinsSponsored(trusted) {
    const gasless = trusted?.gasless;
    if (!isRecord(gasless) || trusted?.deployment_status === 'not_deployed'
        || gasless.deployment_status === 'not_deployed') return false;
    return sponsoredProfileProblem(gasless) === null;
}

// ---------------------------------------------------------------------------
// What the host's own signer says when it will not send an operation
// ---------------------------------------------------------------------------
//
// services/sponsoredOperation.mjs judges an operation and refuses with these
// words, and the SDK wraps a refusal of its transport in a sentence of its own
// ("The bundler refused ..."). The error copy recognizes the host's words
// inside that wrapper and shows only them, so they live here, where both can
// reach them without loading the signer.

export const SPONSORED_REFUSAL_MESSAGE = 'This sponsored operation was not authorized by the selected withdrawal, so it was not sent.';
export const SPONSORED_FEE_REFUSAL = 'This operation’s fee is above the fee that was shown, so it was not sent.';
export const SPONSORED_COST_REFUSAL = 'This operation would reserve more for its network fee than the service allows, so it was not sent.';
export const SPONSORED_COST_SHOWN_REFUSAL = 'This operation would reserve more for its network fee than was shown, so it was not sent.';
export const SPONSORED_CONCESSION_REFUSAL = 'This emergency exit would give up more of your balance than you were shown, so nothing was sent. '
    + 'Start the withdrawal again from the beginning to see what it gives up.';
export const SPONSORED_NOT_CONFIRMED_REFUSAL = 'A saved sponsored operation is sent only when you continue the withdrawal.';

/** Every sentence the signer may refuse with, for the error copy to recognize. */
export const SPONSORED_HOST_REFUSALS = Object.freeze([
    SPONSORED_FEE_REFUSAL, SPONSORED_COST_REFUSAL, SPONSORED_COST_SHOWN_REFUSAL, SPONSORED_CONCESSION_REFUSAL,
    SPONSORED_NOT_CONFIRMED_REFUSAL, SPONSORED_REFUSAL_MESSAGE
]);
