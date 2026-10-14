// Is this tab running the deployment the build was reviewed against?
//
// Two checks, both about identity rather than trust in the network:
//
//   verifyServedConfig   the version's browser-config.json, as the static host
//                        serves it right now, hashes to the digest the build
//                        embedded in the version table (`configSha256`, the
//                        sha256 of the exact bytes the build wrote). A static
//                        host that serves a different file than the one this
//                        bundle was built with (a partial deploy, a stale CDN
//                        entry, a tampered mirror) shows up here BEFORE the SDK
//                        pins anything to it.
//   assertServedIdentity after the SDK initialized, the deployment id and vault
//                        it ended up with are the version's own. This catches
//                        what a hash of the file cannot: the SDK reaching a
//                        different deployment than the one the page believes it
//                        is on.
//
// Fail-safe directions. A mismatch blocks NEW deposits only (the gate code is
// `config_mismatch`); chat, withdrawals and recovery are untouched. A fetch
// that fails or times out is `unverified`, not a block: the SDK fails by
// itself when its configuration is unreachable, and refusing deposits because
// of a flaky request would punish a working tab.
//
// SDK-free and DOM-light: everything environmental is injectable.
import { serializeConfig } from './registryModel.mjs';

const DEFAULT_TIMEOUT_MS = 2000;
const HEX_SHA256 = /^[0-9a-f]{64}$/;

function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function sha256Hex(bytes) {
    const subtle = globalThis.crypto?.subtle;
    if (!subtle || typeof subtle.digest !== 'function') throw new Error('SHA-256 is not available.');
    const digest = await subtle.digest('SHA-256', bytes);
    let hex = '';
    for (const byte of new Uint8Array(digest)) hex += byte.toString(16).padStart(2, '0');
    return hex;
}

function defaultBaseURI() {
    try {
        return globalThis.document?.baseURI || globalThis.location?.href || null;
    } catch {
        return null;
    }
}

// One deadline for the whole check, including a body read that never ends.
function deadlineAfter(timeoutMs, onTimeout) {
    let timer = null;
    const promise = new Promise((resolve, reject) => {
        timer = setTimeout(() => {
            try { onTimeout(); } catch { /* the rejection below is what matters */ }
            reject(new Error('The configuration check timed out.'));
        }, timeoutMs);
    });
    promise.catch(() => {});
    return { promise, cancel() { clearTimeout(timer); } };
}

/**
 * Compare the served `browser-config.json` of `version` with its embedded hash.
 *
 * The comparison is on the raw bytes first (the build writes and hashes
 * exactly those). Only if that differs is the file parsed and re-serialized
 * the way the build serializes it: a transparent re-encoding by an
 * intermediary (whitespace, line endings) is the same configuration and must
 * not close deposits, while any different CONTENT still does.
 *
 * @param {{assetBase: string|null, configSha256: string|null}} version
 * @param {{fetch?: Function, timeoutMs?: number, baseURI?: string,
 *   digest?: (bytes: Uint8Array) => Promise<string>}} [options]
 * @returns {Promise<'ok'|'mismatch'|'unverified'>} Never rejects.
 */
export async function verifyServedConfig(version, {
    fetch: fetchImpl = globalThis.fetch, timeoutMs = DEFAULT_TIMEOUT_MS,
    baseURI = defaultBaseURI(), digest = sha256Hex
} = {}) {
    if (!isRecord(version) || typeof version.assetBase !== 'string' || !version.assetBase
        || typeof version.configSha256 !== 'string' || !HEX_SHA256.test(version.configSha256)) {
        return 'unverified';
    }
    if (typeof fetchImpl !== 'function' || typeof baseURI !== 'string' || !baseURI) return 'unverified';
    const bound = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS;
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const deadline = deadlineAfter(bound, () => controller?.abort());
    try {
        const url = new URL(`${version.assetBase}browser-config.json`, baseURI).href;
        const check = (async () => {
            // The same file the SDK is about to load, never from the HTTP cache,
            // never with cookies.
            const response = await fetchImpl(url, {
                cache: 'no-store',
                credentials: 'omit',
                ...(controller ? { signal: controller.signal } : {})
            });
            if (!response || response.ok !== true) return 'unverified';
            const bytes = new Uint8Array(await response.arrayBuffer());
            if (await digest(bytes) === version.configSha256) return 'ok';
            let parsed;
            try {
                parsed = JSON.parse(new TextDecoder().decode(bytes));
            } catch {
                // Not JSON at all (a captive portal, an error page): this is
                // not "a different configuration", it is no configuration.
                return 'unverified';
            }
            if (!isRecord(parsed)) return 'unverified';
            const canonical = new TextEncoder().encode(serializeConfig(parsed));
            return await digest(canonical) === version.configSha256 ? 'ok' : 'mismatch';
        })();
        return await Promise.race([check, deadline.promise]);
    } catch {
        return 'unverified';
    } finally {
        deadline.cancel();
    }
}

/**
 * After the SDK's first successful init: the manifest and the funding vault it
 * ended up with must be the loaded version's own.
 *
 * A missing deployment id or vault counts as a mismatch: the caller invokes
 * this only after a successful init, when both exist, so their absence means
 * something other than the expected SDK is running.
 *
 * @param {{client: object, runtime: object, version: object}} options
 * @returns {'ok'|'mismatch'}
 */
export function assertServedIdentity({ client, runtime, version } = {}) {
    try {
        if (!isRecord(version) || typeof version.deploymentId !== 'string' || !version.deploymentId
            || typeof version.vault !== 'string' || !version.vault) {
            return 'mismatch';
        }
        const deploymentId = runtime?.manifest?.deployment_id;
        if (typeof deploymentId !== 'string' || deploymentId !== version.deploymentId) return 'mismatch';
        const funding = client?.config?.funding ?? runtime?.config?.funding;
        const vault = funding?.contract_address;
        if (typeof vault !== 'string' || vault.toLowerCase() !== version.vault.toLowerCase()) return 'mismatch';
        // Both numbers or nothing to compare: the vault and deployment id
        // already pin the chain; this only catches an inconsistent config.
        const raw = funding?.chain_id;
        const chainId = typeof raw === 'number' || (typeof raw === 'string' && raw.trim() !== '')
            ? Number(raw) : Number.NaN;
        if (Number.isFinite(chainId) && Number.isFinite(version.chainId) && chainId !== version.chainId) {
            return 'mismatch';
        }
        return 'ok';
    } catch {
        return 'mismatch';
    }
}
