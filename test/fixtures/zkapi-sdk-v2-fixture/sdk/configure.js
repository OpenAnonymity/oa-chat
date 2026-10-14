// FIXTURE NOTE: verbatim copy of the real SDK sdk/configure.js (zkapi 0.2.0, 82c8504).
// The host depends on its behavior (throws after init, rejects unknown options,
// browser mode only), so it is the real code, not a stub.
// Host integration is explicit: importing the SDK does not create a worker,
// connect a wallet, fetch configuration, or enable an application proxy.
// provingKeysBaseUrlOverride lets exits fetch the withdrawal key from another
// origin (design §6.4 E7) when the host is gone or hostile; the build-pinned
// SHA-256 still applies.
let options = Object.freeze({ transport: null, configUrl: null, workerUrl: null, mode: 'browser', requestTestnetPassword: null,
    provingKeysBaseUrlOverride: null });
let initializing = false;

function absoluteUrl(value, label) {
    if (value == null) return null;
    const base = globalThis.location?.href;
    const url = new URL(String(value), base);
    if (!['https:', 'http:', 'file:'].includes(url.protocol)) {
        throw new TypeError(`${label} must be an HTTP(S) or local file URL.`);
    }
    if (url.username || url.password) throw new TypeError(`${label} must not include credentials.`);
    return url.href;
}

/** Configure the page's single wallet before calling client.init(). */
export function configureBrowserSdk(next = {}) {
    if (initializing) throw new Error('Configure the zkAPI browser SDK before initializing its wallet.');
    if (!next || typeof next !== 'object' || Array.isArray(next)) {
        throw new TypeError('zkAPI browser SDK configuration must be an object.');
    }
    const unknown = Object.keys(next).filter(key => !['transport', 'configUrl', 'workerUrl', 'mode', 'requestTestnetPassword',
        'provingKeysBaseUrlOverride'].includes(key));
    if (unknown.length) throw new TypeError(`Unknown zkAPI browser SDK option: ${unknown.join(', ')}.`);
    const merged = { ...options, ...next };
    if (merged.transport !== null && typeof merged.transport !== 'function') {
        throw new TypeError('zkAPI transport must be a fetch-compatible function.');
    }
    if (merged.requestTestnetPassword !== null && typeof merged.requestTestnetPassword !== 'function') {
        throw new TypeError('requestTestnetPassword must be a password-dialog function.');
    }
    if (merged.mode !== 'browser') {
        throw new TypeError('Only browser mode is supported; local daemon and automatic probing modes have been removed.');
    }
    merged.configUrl = absoluteUrl(merged.configUrl, 'configUrl');
    merged.workerUrl = absoluteUrl(merged.workerUrl, 'workerUrl');
    merged.provingKeysBaseUrlOverride = absoluteUrl(merged.provingKeysBaseUrlOverride, 'provingKeysBaseUrlOverride');
    if (merged.provingKeysBaseUrlOverride && !merged.provingKeysBaseUrlOverride.endsWith('/')) {
        throw new TypeError('provingKeysBaseUrlOverride must end with a slash.');
    }
    options = Object.freeze(merged);
    return options;
}

export function browserSdkOptions() { return options; }
export function beginBrowserSdkInitialization() { initializing = true; }

// Preserve the host's opt-in proxy policy without importing its implementation.
// Protocol requests must remain unlinked from the host application's account
// cookies, including when its same-origin route or optional privacy proxy is used.
export function browserSdkTransport(url, init = {}, hints = {}) {
    const privateInit = { ...init, credentials: 'omit' };
    if (options.transport) return options.transport(url, privateInit, hints);
    return globalThis.fetch(url, privateInit);
}
