// FIXTURE: stand-in for sdk/services/zkapiWasmWorker.js (zkapi 0.2.0, 82c8504).
// Same entry contract (the SDK build bundles this file into
// assets/zkapiWasmWorker.js, and it loads the wasm module relative to its own
// URL) and the same message envelope, with a single operation.
import init, { browser_circuit_id, browser_setup_id } from '../wasm/zkapi_browser.js';

export const WORKER_CIRCUIT_ID = 'zkapi-v2-concession-v1';
const KNOWN_SETUP_IDS = ['dev', 'mpc-1'];

let initialized = null;

async function ensureInitialized() {
    if (!initialized) {
        initialized = init({ module_or_path: new URL('../wasm/zkapi_browser_bg.wasm', import.meta.url) }).then(result => {
            if (browser_circuit_id() !== WORKER_CIRCUIT_ID) {
                throw new Error('The loaded proof WASM uses an incompatible circuit revision.');
            }
            if (!KNOWN_SETUP_IDS.includes(browser_setup_id())) {
                throw new Error('The loaded proof WASM is built for an unknown proof setup.');
            }
            return result;
        });
        initialized.catch(() => { initialized = null; });
    }
    return initialized;
}

async function execute(operation) {
    await ensureInitialized();
    switch (operation) {
        case 'identity':
            return { circuitId: browser_circuit_id(), setupId: browser_setup_id() };
        default:
            throw new Error(`Unknown zkAPI worker operation: ${operation}`);
    }
}

if (typeof self !== 'undefined' && typeof self.addEventListener === 'function') {
    self.addEventListener('message', async (event) => {
        const { id, operation } = event.data || {};
        try {
            self.postMessage({ id, result: await execute(operation) });
        } catch (error) {
            self.postMessage({
                id,
                error: error instanceof Error ? error.message : String(error)
            });
        }
    });
}
