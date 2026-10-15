import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { proofSetupKind } from '../chat/zkapi/versioning/adapters/concessionV1.mjs';
import noteBoundV1 from '../chat/zkapi/versioning/adapters/noteBoundV1.mjs';
import { getAdapter } from '../chat/zkapi/versioning/adapters/index.mjs';
import { serializeConfig } from '../chat/zkapi/versioning/registryModel.mjs';
import { patchSdkVersion, patchZkapiSdk, zkapiSdkPatchProvenance } from './patch-zkapi-sdk.mjs';
import { facadeRequired, zkapiFacadePlugin } from './zkapiFacadePlugin.mjs';
import {
    CANONICAL_SDK_ALIAS,
    REGISTRY,
    SDK_DEFAULT_DATABASE,
    assertWalletStoreInvariants,
    developmentSetupVersions,
    developmentSetupWarning,
    planFromRegistry,
    profileProofSetup,
    resolveSdkEntry,
    resolveSdkPackage,
    runtimeVersionTable,
    sdkRefusalError,
    verifyPlanOnDisk
} from './zkapiRegistry.mjs';

// The plan half lives in zkapiRegistry.mjs (pure, bundle-safe); re-exported so
// build callers have one entry point.
export {
    developmentSetupVersions, developmentSetupWarning, planFromRegistry, runtimeVersionTable, verifyPlanOnDisk
};

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const repositoryRoot = () => path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function resolveZkapiDeployment(environment = process.env) {
    const value = environment.OA_ZKAPI_DEPLOYMENT || '';
    if (value && value !== REGISTRY.lineage) {
        throw new Error(`[build] OA_ZKAPI_DEPLOYMENT must be ${REGISTRY.lineage}, or unset for SDK defaults.`);
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

/**
 * Validate a reviewed host deployment against this SDK's emitted proof assets.
 * This is the note-bound-v1 family's profile rule, the one a single-version
 * (legacy) build validates with; a later family validates through its own
 * adapter.
 */
export function validateZkapiDeploymentPins(config, { network, circuitId, files }) {
    return noteBoundV1.validateProfile(config, { network, circuitId, files: files ?? {} });
}

/**
 * Only named, repository-reviewed deployments can replace the SDK defaults.
 * With a deployment this is the lowest-ordinal live version's configuration
 * (version 1 while it is live), exactly the bytes the build writes.
 */
export function readZkapiBuildConfig({ network, deployment = process.env.OA_ZKAPI_DEPLOYMENT || '' }) {
    if (!resolveZkapiNetwork({ OA_ZKAPI_NETWORK: network, OA_ZKAPI_DEPLOYMENT: deployment })) {
        throw new Error('[build] An explicit zkAPI network is required.');
    }
    if (deployment) {
        // Vercel evaluates a bundled config outside this package before its
        // SDK dependency is installed. Embed public pins; the asset build below
        // still verifies their circuit and hashes against emitted proof bytes.
        return structuredClone(planFromRegistry({ network, deployment }).versions[0].config);
    }
    const sdkRoot = path.dirname(fileURLToPath(import.meta.resolve('@openanonymity/zkapi-browser-sdk/package.json')));
    return JSON.parse(readFileSync(path.join(sdkRoot, 'sdk/assets/config', `${network}.json`), 'utf8'));
}

/**
 * The wallet database a live version's store opens in this build and the
 * source hash its rewrite is gated on. Every version of a lineage shares one
 * database (the single wallet slot), so the name is the plan's; the hash is the
 * version's own store.
 */
function walletStorageFor(plan, versionId) {
    const version = plan?.versions?.find(entry => entry.id === versionId);
    if (!version) throw new Error(`[build] No live zkAPI version ${JSON.stringify(versionId)} in this plan.`);
    if (!plan.walletDatabase) throw new Error('[build] This plan has no wallet database.');
    return { database: plan.walletDatabase, sourceSha256: version.sdk.storeSha256 };
}

// ---------------------------------------------------------------------------
// Plugins
// ---------------------------------------------------------------------------

const STORE_DECLARATION = `const DB_NAME = '${SDK_DEFAULT_DATABASE}';`;

/**
 * Rewrite a wallet store source to open the lineage database. The source must
 * be exactly the reviewed bytes, and its shared-slot invariants (database
 * version, lock and channel names) must hold. Pure.
 */
export function renameWalletStore(source, { sourceSha256, database, databaseVersion }) {
    if (digest(source) !== sourceSha256 || source.split(STORE_DECLARATION).length !== 2) {
        throw new Error('[build] Review the wallet storage namespace for this SDK source.');
    }
    assertWalletStoreInvariants(source, { databaseVersion });
    return source.replace(STORE_DECLARATION, () => `const DB_NAME = ${JSON.stringify(database)};`);
}

function recoveryPatchPlugin({ plan, packageRoot }) {
    return {
        name: 'verify-zkapi-recovery-patch',
        async setup() {
            if (plan.mode === 'sdk-default') {
                await patchZkapiSdk(packageRoot);
                return;
            }
            for (const version of plan.versions) {
                await patchSdkVersion({
                    root: packageRoot, alias: version.sdk.alias, source: version.sdk.source, patches: version.sdk.patches
                });
            }
        }
    };
}

// The requested lineage uses one database for every version, without touching
// old notes or the separately vault-scoped funding signer. Transform only the
// exact reviewed SDK modules in the bundle, never the installed SDK. A store
// the registry has not reviewed is refused rather than silently opening the SDK
// default database, which holds retired notes and would hide the user's funds.
function walletNamespacePlugin({ plan, packageRoot }) {
    return {
        name: 'oa-zkapi-wallet-namespace',
        async setup(build) {
            const stores = new Map();
            for (const version of plan.versions) {
                const storeFile = resolveSdkEntry(resolveSdkPackage(version.sdk.alias, packageRoot), 'store');
                if (!storeFile) throw new Error(`[build] ${version.sdk.alias} exports no ./store.`);
                stores.set(await fs.realpath(storeFile), walletStorageFor(plan, version.id));
            }
            build.onLoad({ filter: /[\\/]browserWalletStore\.js$/ }, async args => {
                const storage = stores.get(args.path);
                if (!storage) {
                    throw new Error('[build] An unreviewed wallet store is in the bundle; it would open the default zkAPI database.');
                }
                return {
                    contents: renameWalletStore(await fs.readFile(args.path, 'utf8'), {
                        sourceSha256: storage.sourceSha256,
                        database: storage.database,
                        databaseVersion: plan.walletDatabaseVersion
                    }),
                    loader: 'js',
                    resolveDir: path.dirname(args.path)
                };
            });
        }
    };
}

// Ticket-only builds stay SDK-free: both the payment adapter and its boot entry
// resolve to inert stubs.
function omitDisabledZkapiPlugin() {
    const stubs = {
        index: 'export function createZkapiPaymentIntegration() { throw new Error("zkAPI is not enabled in this build."); }',
        boot: 'export async function bootZkapiPayments() { return { integration: null }; }'
    };
    return {
        name: 'omit-disabled-zkapi',
        setup(build) {
            build.onResolve({ filter: /^\.\/zkapi\/(index|boot)\.js$/ }, args => {
                if (!args.importer.endsWith(`${path.sep}chat${path.sep}startup.js`)) return null;
                return { path: /boot\.js$/.test(args.path) ? 'boot' : 'index', namespace: 'oa-zkapi-disabled' };
            });
            build.onLoad({ filter: /.*/, namespace: 'oa-zkapi-disabled' }, args => ({
                contents: stubs[args.path],
                loader: 'js'
            }));
        }
    };
}

/**
 * esbuild plugins for a build.
 *
 *   no network       ticket-only: the omit stubs.
 *   sdk-default      (network, no deployment) the recovery patch only; the SDK
 *                    keeps its own database and defaults.
 *   registry modes   the recovery patch lists, the hash-gated wallet namespace
 *                    rewrite, and, when more than one SDK (or a non-canonical
 *                    alias) is live, the version facades.
 *
 * options: { plan, packageRoot, facade: { importerRoot, variantsFile, esbuild,
 * guardedNames } }; the defaults are this repository, and tests inject fixtures.
 */
export function zkapiBuildPlugins(network, deployment = process.env.OA_ZKAPI_DEPLOYMENT || '', options = {}) {
    resolveZkapiNetwork({ OA_ZKAPI_NETWORK: network, OA_ZKAPI_DEPLOYMENT: deployment });
    if (!network) return [omitDisabledZkapiPlugin()];
    const plan = options.plan || planFromRegistry({ network, deployment });
    assertPlanMatches(plan, { network, deployment });
    const packageRoot = options.packageRoot || repositoryRoot();
    const plugins = [recoveryPatchPlugin({ plan, packageRoot })];
    if (plan.mode !== 'sdk-default') plugins.push(walletNamespacePlugin({ plan, packageRoot }));
    if (facadeRequired(plan)) {
        const importerRoot = options.facade?.importerRoot || path.join(repositoryRoot(), 'chat/zkapi');
        plugins.push(zkapiFacadePlugin({
            plan, packageRoot, importerRoot, variantsFile: options.facade?.variantsFile, esbuild: options.facade?.esbuild,
            ...(options.facade?.guardedNames ? { guardedNames: options.facade.guardedNames } : {})
        }));
    }
    return plugins;
}

// ---------------------------------------------------------------------------
// Asset emission
// ---------------------------------------------------------------------------

function assertPlanMatches(plan, { network, deployment }) {
    if (plan.network !== network || (plan.mode === 'sdk-default') !== !deployment
        || (deployment && plan.lineage !== deployment)) {
        throw new Error('[build] The supplied zkAPI plan does not match the selected network and deployment.');
    }
}

async function emitVersion({ plan, version, outDir, build, packageRoot }) {
    const pkg = resolveSdkPackage(version.sdk.alias, packageRoot);
    const buildFile = resolveSdkEntry(pkg, 'build');
    if (!buildFile) throw new Error(`[build] ${version.sdk.alias} exports no ./build.`);
    const { buildBrowserSdkAssets } = await import(pathToFileURL(buildFile).href);
    const directory = path.join(outDir, version.publicPath.slice(1));
    let result;
    try {
        result = await buildBrowserSdkAssets({
            outDir: directory,
            network: plan.network,
            build,
            publicPath: version.publicPath
        });
    } catch (error) {
        // An SDK revision before 4b955d9 refuses a development bundle for
        // mainnet itself; that is not this host's rule (the host accepts that
        // setup on every network), so say so. Any other failure is reported
        // as the SDK wrote it.
        if (error?.code === 'development_setup_on_mainnet') {
            throw sdkRefusalError(error, `zkAPI ${version.id} (${version.sdk.alias})`);
        }
        throw error;
    }
    // Hash the bytes now on disk, not the SDK's own record of them: the proving
    // keys must be exactly the reviewed pins before the reviewed configuration
    // replaces the SDK's.
    const pins = version.profile.trusted_deployment;
    const emitted = {};
    for (const relative of ['proofs/request.pk', 'proofs/withdrawal.pk',
        ...(typeof pins.request_verifying_key_sha256 === 'string' ? ['proofs/request.vk'] : [])]) {
        emitted[relative] = digest(await fs.readFile(path.join(directory, relative)));
    }
    // setupId is passed even when the manifest has none (the legacy SDK's):
    // the family's adapter owns the rule that the profile and the bundle name
    // the same proof setup, so it must see a missing one.
    getAdapter(version.adapter).validateProfile(version.profile, {
        network: plan.network,
        circuitId: result.manifest.circuitId,
        setupId: result.manifest.setupId,
        files: emitted,
        proxyPath: version.proxyPath,
        strict: true
    });
    const configBytes = serializeConfig(version.config);
    if (digest(configBytes) !== version.configSha256) {
        throw new Error('[build] The emitted configuration does not match its planned hash.');
    }
    await fs.writeFile(path.join(directory, 'browser-config.json'), configBytes);
    result.config = structuredClone(version.config);
    result.deployment = plan.lineage;
    result.files['browser-config.json'] = digest(configBytes);
    result.manifest = { ...result.manifest, deployment: plan.lineage, files: {
        ...result.manifest.files, 'browser-config.json': result.files['browser-config.json']
    } };
    const manifestBytes = `${JSON.stringify(result.manifest, null, 2)}\n`;
    await fs.writeFile(path.join(directory, 'sdk-assets.json'), manifestBytes);
    result.files['sdk-assets.json'] = digest(manifestBytes);
    return result;
}

/**
 * Emit every live version's SDK assets under outDir/<publicPath>, ordinal
 * ascending, after cleaning outDir/zkapi once. The returned object is the
 * lowest-ordinal version's result (what a single-version build always
 * returned) plus `versions: [{id, directory, config, manifest, files,
 * publicPath}]` for every emitted version. The shared stylesheet is written
 * once, at the end, by this orchestrator.
 *
 * Nothing is touched before the plan and the installed SDKs verify
 * (verifyPlanOnDisk): an unknown selector, a missing package or a lock that
 * disagrees with the registry fails with outDir untouched. A caller that has
 * just verified the same plan (scripts/build.mjs verifies before it cleans
 * dist/) passes the receipt as `verified` to skip the repeat; called without
 * one, or with a receipt for another plan or root, it verifies in full.
 *
 * A live version built on the single-party development proof setup is
 * accepted and reported: once, after verification and before anything is
 * emitted, `warn` (console.warn by default) gets one WARNING per such version
 * (developmentSetupWarning). Nothing is printed for a ceremony setup, for a
 * family with no setup id (version 1) or for a build that is not versioned.
 * The refusal of a development bundle for mainnet by an SDK revision before
 * 4b955d9 (development_setup_on_mainnet) is passed on with the host's
 * explanation (sdkRefusalError), from the on-disk verification or from
 * emission.
 */
export async function buildZkapiAssets({
    network, outDir, repoRoot, build, deployment = process.env.OA_ZKAPI_DEPLOYMENT || '', plan: suppliedPlan, packageRoot,
    verified, warn = console.warn
}) {
    resolveZkapiNetwork({ OA_ZKAPI_NETWORK: network, OA_ZKAPI_DEPLOYMENT: deployment });
    let plan = null;
    if (network) {
        plan = suppliedPlan || planFromRegistry({ network, deployment });
        assertPlanMatches(plan, { network, deployment });
        const root = repoRoot || repositoryRoot();
        // `verified` is the receipt verifyPlanOnDisk returned for this very
        // plan and these roots; anything else is verified again here.
        await verifyPlanOnDisk(plan, { repoRoot: root, packageRoot, verified });
        // One warning per live version on the development setup, once per
        // build and before anything is emitted. The setup is accepted; its
        // limitation is not left for the operator to remember.
        for (const entry of developmentSetupVersions(plan)) warn(`[build] ${developmentSetupWarning(entry)}`);
    }
    // The source adapter is bundled into the executable graph, never published
    // as a second unconfigured app beside it. Disabled builds ship no SDK assets.
    const destination = path.join(outDir, 'zkapi');
    await fs.rm(destination, { recursive: true, force: true });
    if (!network) return null;
    const root = repoRoot || repositoryRoot();
    const resolutionRoot = packageRoot || root;
    const stylesheet = path.join(root, 'chat/zkapi/zkapi.css');

    if (plan.mode === 'sdk-default') {
        await patchZkapiSdk(root);
        const { buildBrowserSdkAssets } = await import(pathToFileURL(
            resolveSdkEntry(resolveSdkPackage(CANONICAL_SDK_ALIAS, resolutionRoot), 'build')).href);
        const result = await buildBrowserSdkAssets({
            outDir: destination,
            network,
            build,
            publicPath: '/zkapi/'
        });
        await fs.copyFile(stylesheet, path.join(destination, 'zkapi.css'));
        return { ...result, versions: [] };
    }

    const emitted = [];
    for (const version of plan.versions) {
        await patchSdkVersion({
            root: resolutionRoot, alias: version.sdk.alias, source: version.sdk.source, patches: version.sdk.patches
        });
        emitted.push({ version, result: await emitVersion({ plan, version, outDir, build, packageRoot: resolutionRoot }) });
    }
    await fs.mkdir(destination, { recursive: true });
    await fs.copyFile(stylesheet, path.join(destination, 'zkapi.css'));
    return {
        ...emitted[0].result,
        versions: emitted.map(({ version, result }) => ({
            id: version.id,
            directory: result.directory,
            publicPath: version.publicPath,
            config: result.config,
            manifest: result.manifest,
            files: result.files
        }))
    };
}

// Which bundled modules carry the SDK default database name, for the failure
// message. `file` is the emitted chunk whose text contains it. Reads only on the
// failure path. A live store is judged as emitted (its one declaration is
// renamed), so the store the build rewrote correctly is never blamed; when
// nothing else in the chunk explains the name, the store itself is.
async function defaultDatabaseCulprits({ file, text, inputs, stores, plan, sdkRoots, cwd }) {
    const culprits = [];
    const heldStores = [];
    for (const entry of inputs) {
        if (entry.file !== file || !(entry.bytes > 0)) continue;
        let source;
        try {
            source = await fs.readFile(entry.resolved, 'utf8');
        } catch {
            // A generated (plugin namespace) module has no file to read.
            continue;
        }
        if (stores.has(entry.resolved)) {
            const holder = { ...entry, sdk: stores.get(entry.resolved) };
            const rewritten = source.replace(STORE_DECLARATION, '');
            if (rewritten.includes(SDK_DEFAULT_DATABASE) || !text.includes(plan.walletDatabase)) culprits.push(holder);
            else heldStores.push(holder);
        } else if (source.includes(SDK_DEFAULT_DATABASE)) {
            const root = sdkRoots.find(candidate => entry.resolved === candidate.root
                || entry.resolved.startsWith(`${candidate.root}${path.sep}`));
            culprits.push({ ...entry, sdk: root?.id || null });
        }
    }
    if (!culprits.length) culprits.push(...heldStores);
    return culprits.map(culprit => ({
        sdk: culprit.sdk,
        name: path.relative(cwd, culprit.resolved).split(path.sep).join('/')
    }));
}

/**
 * After the bundle is written: no emitted module may open the SDK default
 * database, and every live version's store must have been rewritten. Reads the
 * emitted files named by the esbuild metafile. A no-op in sdk-default mode.
 * In a faceted build it also requires every variant to be in the graph, so a
 * loader nobody imports cannot ship unbound facades.
 *
 * The default name may appear in no emitted chunk, wherever it comes from, and
 * the failure names the module that carries it: an SDK module is reported as
 * opening the default database, while application code that merely names it
 * (a registry helper that reached the browser graph) is reported as exactly
 * that. A name that tree-shaking removed is not emitted and fails nothing.
 */
export async function assertZkapiBundleEmission({ plan, metafile, cwd = process.cwd(), packageRoot = repositoryRoot() }) {
    if (!plan || plan.mode === 'sdk-default') return;
    // esbuild reports paths relative to its real working directory.
    cwd = await fs.realpath(cwd);
    const outputs = Object.entries(metafile.outputs).filter(([file]) => /\.js$/.test(file));
    const texts = new Map();
    for (const [file] of outputs) texts.set(file, await fs.readFile(path.resolve(cwd, file), 'utf8'));
    const inputs = [];
    for (const [file, info] of outputs) {
        for (const [input, detail] of Object.entries(info.inputs || {})) {
            inputs.push({ file, input, resolved: path.resolve(cwd, input), bytes: detail.bytesInOutput });
        }
    }
    const stores = new Map();
    const storeOf = new Map();
    const sdkRoots = [];
    for (const version of plan.versions) {
        const pkg = resolveSdkPackage(version.sdk.alias, packageRoot);
        const storeFile = resolveSdkEntry(pkg, 'store');
        if (!storeFile) throw new Error(`[build] ${version.sdk.alias} exports no ./store.`);
        const store = await fs.realpath(storeFile);
        sdkRoots.push({ id: version.id, root: await fs.realpath(pkg.root) });
        stores.set(store, version.id);
        storeOf.set(version.id, store);
    }
    for (const [file, text] of texts) {
        if (!text.includes(SDK_DEFAULT_DATABASE)) continue;
        const culprits = await defaultDatabaseCulprits({ file, text, inputs, stores, plan, sdkRoots, cwd });
        const list = names => names.map(culprit => culprit.name).join(', ');
        const fromSdk = culprits.filter(culprit => culprit.sdk);
        if (fromSdk.length) {
            throw new Error(`[build] ${file} would open the default zkAPI wallet database: ${list(fromSdk)} `
                + `(zkAPI ${[...new Set(fromSdk.map(culprit => culprit.sdk))].join(', ')} SDK) still carries its name.`);
        }
        if (culprits.length) {
            throw new Error(`[build] ${file} names the default zkAPI wallet database ("${SDK_DEFAULT_DATABASE}") in ${list(culprits)}. `
                + 'No SDK store keeps it, but a registry build must not carry that name in browser code: '
                + 'keep build-time registry helpers (walletDatabaseName, validateRegistry) out of the browser graph.');
        }
        throw new Error(`[build] ${file} would open the default zkAPI wallet database, or names it from a module this check could not identify.`);
    }
    for (const version of plan.versions) {
        const store = storeOf.get(version.id);
        const holders = inputs.filter(entry => entry.resolved === store && entry.bytes > 0);
        if (!holders.length) throw new Error(`[build] The ${version.id} wallet store is not part of the bundle.`);
        for (const holder of holders) {
            if (!texts.get(holder.file).includes(plan.walletDatabase)) {
                throw new Error(`[build] ${holder.file} holds the ${version.id} wallet store without the lineage database name.`);
            }
        }
    }
    if (facadeRequired(plan)) {
        for (const version of plan.versions) {
            if (!inputs.some(entry => entry.input === `oa-zkapi-variant:${version.id}`)) {
                throw new Error(`[build] The ${version.id} SDK variant is not part of the bundle. Import chat/zkapi/versioning/variants.js from the boot path.`);
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Provenance
// ---------------------------------------------------------------------------

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

function lockedDependency(lock, alias) {
    const dependency = lock.packages?.[`node_modules/${alias}`];
    if (!dependency) throw new Error('[build] The zkAPI SDK must be pinned in package-lock.json.');
    const revision = dependency.resolved?.match(/#([0-9a-f]{40})$/)?.[1];
    if (!revision) throw new Error('[build] The zkAPI SDK dependency must resolve to an immutable Git commit.');
    return { dependency, revision };
}

function patchRecords(names, revision) {
    return names.map(name => {
        const record = zkapiSdkPatchProvenance(name);
        if (revision !== record.revision) throw new Error('[build] Review the recovery patch for this SDK revision.');
        return record;
    });
}

/**
 * The `zkapi` object of build.json. Keeps the baseline fields (network,
 * deployment, walletStorage, oaChatRevision, sdk, files) describing the
 * lowest-ordinal live version, and adds registrySha256, depositTarget and
 * versions[] for registry builds. The lock lookup is per alias.
 *
 * Every versions[] entry ends with `setupId` (the proof setup id of the
 * version's keys, null for a family that names none) and `proofSetup`
 * ('ceremony', 'development' or null), so a deployment on the single-party
 * development setup is readable from the build record alone.
 */
export async function zkapiBuildProvenance({ network, repoRoot, outDir, sdkAssets, plan: suppliedPlan }) {
    if (!network) return null;
    const lock = JSON.parse(await fs.readFile(path.join(repoRoot, 'package-lock.json'), 'utf8'));
    const deployment = sdkAssets?.deployment || '';
    const plan = suppliedPlan || planFromRegistry({ network, deployment });
    let oaRevision = process.env.VERCEL_GIT_COMMIT_SHA || null;
    const resolveRevision = () => {
        if (oaRevision) return oaRevision;
        try { oaRevision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
        catch { /* Source archives may supply their revision through Vercel. */ }
        return oaRevision;
    };

    if (plan.mode === 'sdk-default') {
        const { dependency, revision } = lockedDependency(lock, CANONICAL_SDK_ALIAS);
        const recoveryPatch = patchRecords(['wallet-recovery-v1'], revision)[0];
        return {
            network,
            ...(sdkAssets?.deployment ? { deployment: sdkAssets.deployment } : {}),
            oaChatRevision: resolveRevision(),
            sdk: { version: dependency.version, revision, patches: [recoveryPatch], assets: sdkAssets?.manifest || null },
            files: await artifactFiles(outDir)
        };
    }

    const versions = plan.versions.map(version => {
        const { dependency, revision } = lockedDependency(lock, version.sdk.alias);
        if (revision !== version.sdk.revision) {
            throw new Error(`[build] Review the registry revision for ${version.sdk.alias}: the lock resolves ${revision}.`);
        }
        const emitted = sdkAssets?.versions?.find(entry => entry.id === version.id);
        // The proof setup the version's keys come from: the bundle's own
        // record when it was emitted, else the reviewed pin. A family with no
        // setup id (the legacy one) reports null for both fields.
        const bundleSetup = emitted?.manifest?.setupId;
        const setupId = typeof bundleSetup === 'string' ? bundleSetup : profileProofSetup(version.profile).setupId;
        return {
            id: version.id,
            status: version.status,
            adapter: version.adapter,
            circuitId: version.row.circuitId,
            deploymentId: version.config.trusted_deployment.deployment_id,
            configSha256: version.configSha256,
            sdk: {
                alias: version.sdk.alias,
                version: dependency.version,
                revision,
                patches: patchRecords(version.sdk.patches, revision),
                assets: emitted?.manifest || null
            },
            publicPath: version.publicPath,
            proxyPath: version.proxyPath,
            walletStorage: walletStorageFor(plan, version.id),
            setupId,
            proofSetup: proofSetupKind(setupId)
        };
    });
    const [baseline] = versions;
    return {
        network,
        deployment: plan.lineage,
        walletStorage: baseline.walletStorage,
        oaChatRevision: resolveRevision(),
        sdk: {
            version: baseline.sdk.version,
            revision: baseline.sdk.revision,
            patches: baseline.sdk.patches,
            assets: sdkAssets?.manifest || null
        },
        registrySha256: plan.registrySha256,
        depositTarget: plan.depositTarget,
        versions,
        files: await artifactFiles(outDir)
    };
}
