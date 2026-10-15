/* FIXTURE: stand-in for the wasm-bindgen glue sdk/wasm/zkapi_browser.js (zkapi 0.2.0, branch v0.2, 4b955d9).
 * Only the identity surface the SDK build and the worker read: initSync,
 * the default init, browser_circuit_id and browser_setup_id. The bundle's
 * setup is mpc-1 so one fixture can stand in for a deployed profile on both
 * networks (the real development bundle names setup "dev", which mainnet
 * refuses). */
let ready = false;

export function initSync(options) {
    const module = options && typeof options === 'object' && 'module' in options ? options.module : options;
    if (!module) throw new TypeError('initSync requires the wasm module bytes.');
    ready = true;
}

export default async function init() {
    ready = true;
}

function assertReady() {
    if (!ready) throw new Error('The fixture wasm module is not initialized.');
}

export function browser_circuit_id() {
    assertReady();
    return 'zkapi-v2-concession-v1';
}

export function browser_setup_id() {
    assertReady();
    return 'mpc-1';
}
