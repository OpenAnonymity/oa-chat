// FIXTURE NOTE: verbatim copy of the real SDK sdk/build.mjs (0.2.0, 82c8504). The fixture ships
// the same asset layout (assets/, wasm/, services/zkapiWasmWorker.js), so the real build
// contract (result shape, key order, error codes) is exercised unchanged on tiny files.
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const sdkRoot = path.dirname(fileURLToPath(import.meta.url));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

/** The proof statement this SDK revision supports. */
export const REQUIRED_CIRCUIT_ID = 'zkapi-v2-concession-v1';
/** sdk/assets/manifest.json schema: circuitId, setupId, sourceRevision, files. */
export const ASSET_MANIFEST_SCHEMA = 2;
/** Setups a bundle can be built for (scripts/build-browser-client.sh --setup). */
export const BUNDLE_SETUP_IDS = Object.freeze(['dev', 'mpc-1']);
/** The only setup a mainnet profile may use. */
export const PRODUCTION_SETUP_ID = 'mpc-1';
/**
 * The new build is served under its own path, next to the legacy
 * zkapi-v2-note-bound-v1 build at /zkapi/: proving keys are fetched with
 * cache 'force-cache', so new keys need new URLs (design §10.3, §10.5).
 */
export const DEFAULT_PUBLIC_PATH = '/zkapi/v2c/';
/** Every artifact sdk/assets/manifest.json hashes, relative to sdk/. */
export const ASSET_MANIFEST_FILES = Object.freeze([
    'wasm/zkapi_browser.js',
    'wasm/zkapi_browser_bg.wasm',
    'wasm/zkapi_browser.d.ts',
    'wasm/zkapi_browser_bg.wasm.d.ts',
    'assets/proofs/request.pk',
    'assets/proofs/withdrawal.pk',
    'assets/proofs/request.vk',
    'assets/config/sepolia.json',
    'assets/config/mainnet.json'
]);
export const NETWORKS = Object.freeze(['sepolia', 'mainnet']);

function codedError(code, message) {
    return Object.assign(new Error(message), { code });
}

/**
 * Instantiate the shipped WebAssembly and read the circuit and setup it was
 * built for. Call only after its bytes are verified.
 */
export async function readBundleIdentity(root = sdkRoot) {
    const glue = await import(pathToFileURL(path.join(root, 'wasm/zkapi_browser.js')).href);
    glue.initSync({ module: await fs.readFile(path.join(root, 'wasm/zkapi_browser_bg.wasm')) });
    return { circuitId: glue.browser_circuit_id(), setupId: glue.browser_setup_id() };
}

/** Read and verify the package's public artifacts without building protocol source. */
export async function verifyBrowserSdkAssets() {
    const manifest = JSON.parse(await fs.readFile(path.join(sdkRoot, 'assets/manifest.json'), 'utf8'));
    if (manifest.schema !== ASSET_MANIFEST_SCHEMA || manifest.circuitId !== REQUIRED_CIRCUIT_ID) {
        throw codedError('incompatible_proof_circuit', 'Incompatible SDK circuit artifacts.');
    }
    if (!BUNDLE_SETUP_IDS.includes(manifest.setupId)) {
        throw codedError('setup_mismatch', `Unknown SDK proof setup ${JSON.stringify(manifest.setupId)}.`);
    }
    const listed = Object.keys(manifest.files || {}).sort();
    if (JSON.stringify(listed) !== JSON.stringify([...ASSET_MANIFEST_FILES].sort())) {
        throw new Error('The SDK asset manifest does not list exactly the shipped artifacts.');
    }
    for (const [relative, expected] of Object.entries(manifest.files)) {
        const resolved = path.resolve(sdkRoot, relative);
        if (!resolved.startsWith(`${sdkRoot}${path.sep}`)) throw new Error('Invalid SDK asset path.');
        if (digest(await fs.readFile(resolved)) !== expected) {
            throw new Error(`zkAPI SDK asset integrity check failed: ${relative}.`);
        }
    }
    const bundle = await readBundleIdentity();
    if (bundle.circuitId !== manifest.circuitId || bundle.setupId !== manifest.setupId) {
        throw codedError('setup_mismatch', `The SDK WebAssembly is built for ${bundle.circuitId}/${bundle.setupId}, `
            + `but the asset manifest names ${manifest.circuitId}/${manifest.setupId}.`);
    }
    return manifest;
}

/**
 * Refuse a profile this bundle must not be built for: a placeholder
 * (`deployment_status: "not_deployed"`) or a status other than "deployed",
 * another circuit or setup, a mainnet
 * profile on a development setup, a vault without the concession exit, or
 * keys other than the shipped ones.
 */
export function assertDeployableProfile(config, manifest, network, hashes) {
    const trusted = config?.trusted_deployment;
    if (!trusted || typeof trusted !== 'object') {
        throw new Error(`The ${network} profile has no trusted_deployment pins.`);
    }
    if (trusted.deployment_status === 'not_deployed' || config.deployment_status === 'not_deployed') {
        throw codedError('deployment_not_deployed',
            `The ${network} profile is a placeholder: no ${manifest.circuitId} vault is deployed on ${network}.`);
    }
    // A deployed profile names no status, or "deployed" as the finalized
    // manifest, serverd and clientd do.
    if (trusted.deployment_status != null && trusted.deployment_status !== 'deployed') {
        throw new Error(`The ${network} profile has an unknown deployment_status.`);
    }
    if (trusted.circuit_id !== manifest.circuitId) {
        throw codedError('incompatible_proof_circuit',
            `The ${network} profile pins circuit ${trusted.circuit_id}, not ${manifest.circuitId}.`);
    }
    if (trusted.setup_id !== manifest.setupId) {
        throw codedError('setup_mismatch',
            `The ${network} profile pins setup ${trusted.setup_id}; this bundle is built for ${manifest.setupId}.`);
    }
    if (Number(trusted.chain_id) === 1 && manifest.setupId !== PRODUCTION_SETUP_ID) {
        throw codedError('development_setup_on_mainnet',
            `A mainnet profile needs the ${PRODUCTION_SETUP_ID} setup, not ${manifest.setupId}.`);
    }
    if (trusted.exit_concession !== 1) {
        throw codedError('exit_concession_required',
            `The ${network} profile does not pin a vault with exit_concession 1.`);
    }
    for (const [field, file] of [
        ['request_proving_key_sha256', 'assets/proofs/request.pk'],
        ['withdrawal_proving_key_sha256', 'assets/proofs/withdrawal.pk'],
        ['request_verifying_key_sha256', 'assets/proofs/request.vk']
    ]) {
        if (String(trusted[field] || '').toLowerCase() !== hashes[file]) {
            throw new Error(`${file} does not match the ${network} deployment pin ${field}.`);
        }
    }
}

/**
 * Publish one deployment's immutable proof assets beneath the host's app route.
 * The host supplies its esbuild `build` function; esbuild is not a runtime SDK
 * dependency. No network, private credentials, or Rust are required.
 */
export async function buildBrowserSdkAssets({ outDir, network = 'sepolia', publicPath = DEFAULT_PUBLIC_PATH, build } = {}) {
    if (!NETWORKS.includes(network)) throw new Error('Network must be sepolia or mainnet.');
    if (!outDir || typeof build !== 'function') throw new TypeError('outDir and an esbuild build function are required.');
    if (!/^\/(?!\/)[^?#]*\/$/.test(publicPath) || publicPath.split('/').includes('..')) {
        throw new TypeError('publicPath must be an absolute same-origin directory path ending with /.');
    }
    const directory = path.resolve(outDir);
    if (directory === path.parse(directory).root || directory === sdkRoot || sdkRoot.startsWith(`${directory}${path.sep}`)
        || directory.startsWith(`${sdkRoot}${path.sep}`)) {
        throw new Error('SDK build output must not overwrite its package source.');
    }
    const provenance = await verifyBrowserSdkAssets();
    const config = JSON.parse(await fs.readFile(path.join(sdkRoot, `assets/config/${network}.json`), 'utf8'));
    assertDeployableProfile(config, provenance, network, provenance.files);
    const files = {};
    const write = async (relative, bytes) => {
        const destination = path.join(directory, relative);
        await fs.mkdir(path.dirname(destination), { recursive: true });
        await fs.writeFile(destination, bytes);
        files[relative] = digest(bytes);
    };
    for (const file of ['request.pk', 'withdrawal.pk', 'request.vk']) {
        await write(`proofs/${file}`, await fs.readFile(path.join(sdkRoot, `assets/proofs/${file}`)));
    }
    await write('wasm/zkapi_browser_bg.wasm', await fs.readFile(path.join(sdkRoot, 'wasm/zkapi_browser_bg.wasm')));
    await write('browser-config.json', `${JSON.stringify(config, null, 2)}\n`);
    const workerFile = path.join(directory, 'assets/zkapiWasmWorker.js');
    await build({
        entryPoints: [path.join(sdkRoot, 'services/zkapiWasmWorker.js')], outfile: workerFile,
        bundle: true, format: 'esm', platform: 'browser', target: ['es2020'], minify: true, logLevel: 'warning'
    });
    files['assets/zkapiWasmWorker.js'] = digest(await fs.readFile(workerFile));
    const manifest = {
        schema: ASSET_MANIFEST_SCHEMA, network, circuitId: provenance.circuitId, setupId: provenance.setupId,
        sourceRevision: provenance.sourceRevision, publicPath, files: { ...files }
    };
    await write('sdk-assets.json', `${JSON.stringify(manifest, null, 2)}\n`);
    return {
        directory, config, manifest, files,
        configUrl: `${publicPath}browser-config.json`, workerUrl: `${publicPath}assets/zkapiWasmWorker.js`
    };
}
