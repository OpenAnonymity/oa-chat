import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import freshMainnet from '../deployments/zkapi/fresh-20260928/mainnet.json' with { type: 'json' };
import freshSepolia from '../deployments/zkapi/fresh-20260928/sepolia.json' with { type: 'json' };
import { patchZkapiSdk, zkapiSdkPatchProvenance } from './patch-zkapi-sdk.mjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');

export function resolveZkapiDeployment(environment = process.env) {
    const value = environment.OA_ZKAPI_DEPLOYMENT || '';
    if (!['', 'fresh-20260928'].includes(value)) {
        throw new Error('[build] OA_ZKAPI_DEPLOYMENT must be fresh-20260928, or unset for SDK defaults.');
    }
    if (value && !['sepolia', 'mainnet'].includes(environment.OA_ZKAPI_NETWORK)) {
        throw new Error('[build] OA_ZKAPI_DEPLOYMENT requires an explicit OA_ZKAPI_NETWORK.');
    }
    return value;
}

export function resolveZkapiNetwork(environment = process.env) {
    const value = environment.OA_ZKAPI_NETWORK || '';
    if (!['', 'sepolia', 'mainnet'].includes(value)) {
        throw new Error('[build] OA_ZKAPI_NETWORK must be sepolia or mainnet, or unset for Tickets only.');
    }
    resolveZkapiDeployment(environment);
    return value;
}

function publicOrigin(value) {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password
        || url.pathname !== '/' || url.search || url.hash) {
        throw new Error('[build] Deployment pins must use credential-free HTTPS origins.');
    }
    return url.origin;
}

/** Validate a reviewed host deployment against this SDK's emitted proof assets. */
export function validateZkapiDeploymentPins(config, { network, circuitId, files }) {
    const pins = config?.trusted_deployment;
    if (!['mainnet', 'sepolia'].includes(network)
        || pins?.chain_id !== (network === 'mainnet' ? 1 : 11155111)) {
        throw new Error('[build] Deployment pins do not match the selected network.');
    }
    if (circuitId !== 'zkapi-v2-note-bound-v1' || pins.circuit_id !== circuitId) {
        throw new Error('[build] Deployment pins do not match the SDK proof circuit.');
    }
    for (const kind of ['request', 'withdrawal']) {
        const expected = pins[`${kind}_proving_key_sha256`];
        if (!/^[a-f0-9]{64}$/.test(expected || '') || expected !== files?.[`proofs/${kind}.pk`]) {
            throw new Error(`[build] ${kind} proving key does not match the selected deployment pins.`);
        }
    }
    const origin = publicOrigin(pins.protocol_server_url);
    if (publicOrigin(pins.indexer_url) !== origin
        || config.deployment_manifest_url !== `${origin}/config.json`
        || JSON.stringify(config.allowed_deployment_manifest_urls) !== JSON.stringify([config.deployment_manifest_url])
        || config.deployment_api_proxy_path !== '/zkapi-deployment/'
        || config.proving_keys_base_url !== './proofs/') {
        throw new Error('[build] Deployment manifest, proxy and proof routes must match the reviewed pins.');
    }
    if (typeof pins.deployment_id !== 'string' || !pins.deployment_id
        || !/^0x[0-9a-fA-F]{40}$/.test(pins.contract_address || '')
        || pins.billing_asset !== 'native_eth' || pins.billing_unit !== 'gwei'
        || pins.billing_token_address !== null || pins.native_asset_wei_per_unit !== '1000000000'
        || config.billing_token_symbol !== 'ETH' || config.billing_token_decimals !== 9
        || config.credits_per_usd !== null || config.require_oa_key_source !== true) {
        throw new Error('[build] Fresh deployment pins must identify a native ETH vault and verified OA keys.');
    }
    return config;
}

/** Only named, repository-reviewed deployments can replace the SDK defaults. */
export function readZkapiBuildConfig({ network, deployment = process.env.OA_ZKAPI_DEPLOYMENT || '' }) {
    if (!resolveZkapiNetwork({ OA_ZKAPI_NETWORK: network, OA_ZKAPI_DEPLOYMENT: deployment })) {
        throw new Error('[build] An explicit zkAPI network is required.');
    }
    if (deployment) {
        // Vercel evaluates a bundled config outside this package before its
        // SDK dependency is installed. Embed public pins; the asset build below
        // still verifies their circuit and hashes against emitted proof bytes.
        return structuredClone(network === 'mainnet' ? freshMainnet : freshSepolia);
    }
    const sdkRoot = path.dirname(fileURLToPath(import.meta.resolve('@openanonymity/zkapi-browser-sdk/package.json')));
    return JSON.parse(readFileSync(path.join(sdkRoot, 'sdk/assets/config', `${network}.json`), 'utf8'));
}

export function zkapiBuildPlugins(network) {
    if (network) return [{
        name: 'verify-zkapi-recovery-patch',
        async setup() { await patchZkapiSdk(); }
    }];
    return [{
        name: 'omit-disabled-zkapi',
        setup(build) {
            build.onResolve({ filter: /^\.\/zkapi\/index\.js$/ }, args => {
                if (!args.importer.endsWith(`${path.sep}chat${path.sep}startup.js`)) return null;
                return { path: 'disabled', namespace: 'oa-zkapi-disabled' };
            });
            build.onLoad({ filter: /.*/, namespace: 'oa-zkapi-disabled' }, () => ({
                contents: 'export function createZkapiPaymentIntegration() { throw new Error("zkAPI is not enabled in this build."); }',
                loader: 'js'
            }));
        }
    }];
}

export async function buildZkapiAssets({ network, outDir, repoRoot, build, deployment = process.env.OA_ZKAPI_DEPLOYMENT || '' }) {
    resolveZkapiNetwork({ OA_ZKAPI_NETWORK: network, OA_ZKAPI_DEPLOYMENT: deployment });
    const config = network ? readZkapiBuildConfig({ network, deployment }) : null;
    // The source adapter is bundled into the executable graph, never published
    // as a second unconfigured app beside it. Disabled builds ship no SDK assets.
    const destination = path.join(outDir, 'zkapi');
    await fs.rm(destination, { recursive: true, force: true });
    if (!network) return null;
    await patchZkapiSdk(repoRoot);
    const { buildBrowserSdkAssets } = await import('@openanonymity/zkapi-browser-sdk/build');
    const result = await buildBrowserSdkAssets({
        outDir: destination,
        network,
        build,
        publicPath: '/zkapi/'
    });
    if (deployment) {
        const proofFiles = Object.fromEntries(await Promise.all(['request', 'withdrawal'].map(async kind => {
            const relative = `proofs/${kind}.pk`;
            return [relative, digest(await fs.readFile(path.join(destination, relative)))];
        })));
        validateZkapiDeploymentPins(config, { network, circuitId: result.manifest.circuitId, files: proofFiles });
        const configBytes = `${JSON.stringify(config, null, 2)}\n`;
        await fs.writeFile(path.join(destination, 'browser-config.json'), configBytes);
        result.config = config;
        result.deployment = deployment;
        result.files['browser-config.json'] = digest(configBytes);
        result.manifest = { ...result.manifest, deployment, files: {
            ...result.manifest.files, 'browser-config.json': result.files['browser-config.json']
        } };
        const manifestBytes = `${JSON.stringify(result.manifest, null, 2)}\n`;
        await fs.writeFile(path.join(destination, 'sdk-assets.json'), manifestBytes);
        result.files['sdk-assets.json'] = digest(manifestBytes);
    }
    await fs.copyFile(path.join(repoRoot, 'chat/zkapi/zkapi.css'), path.join(destination, 'zkapi.css'));
    return result;
}

async function artifactFiles(root, directory = root) {
    const files = {};
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
        const absolute = path.join(directory, entry.name);
        // Static hosts omit hidden files and protect source maps. Keep the
        // deployment and its public integrity manifest identical.
        if (entry.name.startsWith('.') || entry.name.endsWith('.map')) {
            await fs.rm(absolute, { recursive: true, force: true });
            continue;
        }
        if (entry.isSymbolicLink()) throw new Error(`[build] Unexpected symlink in deployment: ${absolute}`);
        if (entry.isDirectory()) Object.assign(files, await artifactFiles(root, absolute));
        else if (entry.isFile()) {
            const relative = path.relative(root, absolute).split(path.sep).join('/');
            if (relative === 'build.json') continue;
            files[relative] = createHash('sha256').update(await fs.readFile(absolute)).digest('hex');
        }
    }
    return files;
}

export async function zkapiBuildProvenance({ network, repoRoot, outDir, sdkAssets }) {
    if (!network) return null;
    const lock = JSON.parse(await fs.readFile(path.join(repoRoot, 'package-lock.json'), 'utf8'));
    const dependency = lock.packages?.['node_modules/@openanonymity/zkapi-browser-sdk'];
    if (!dependency) throw new Error('[build] The zkAPI SDK must be pinned in package-lock.json.');
    const revision = dependency.resolved?.match(/#([0-9a-f]{40})$/)?.[1];
    if (!revision) throw new Error('[build] The zkAPI SDK dependency must resolve to an immutable Git commit.');
    const recoveryPatch = zkapiSdkPatchProvenance();
    if (revision !== recoveryPatch.revision) throw new Error('[build] Review the recovery patch for this SDK revision.');
    let oaRevision = process.env.VERCEL_GIT_COMMIT_SHA || null;
    if (!oaRevision) {
        try { oaRevision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
        catch { /* Source archives may supply their revision through Vercel. */ }
    }
    return {
        network,
        ...(sdkAssets?.deployment ? { deployment: sdkAssets.deployment } : {}),
        oaChatRevision: oaRevision,
        sdk: { version: dependency.version, revision, patches: [recoveryPatch], assets: sdkAssets?.manifest || null },
        files: await artifactFiles(outDir)
    };
}
