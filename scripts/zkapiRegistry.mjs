// Build-time view of the zkAPI version registry (deployments/zkapi/registry.json).
//
// Two halves, deliberately kept apart:
//
//   planFromRegistry   PURE. Static JSON, the registry model and adapters only:
//                      no file system, no esbuild, no SDK, no import.meta.resolve.
//                      The Vercel route generator is bundled by esbuild and run in
//                      a directory without node_modules, and it uses this half
//                      (test/architecture/zkapiBuild.test.js and
//                      zkapiVersionedBuild.test.js enforce that).
//   verifyPlanOnDisk   ASYNC. Reads the installed SDK packages, package.json and
//                      the lock file and refuses anything that is not exactly what
//                      the registry pins. Used only by scripts/build.mjs and
//                      buildZkapiAssets, before any output is touched.
//
// Registry rules (lifecycle, uniqueness, activation gates) live in
// chat/zkapi/versioning/registryModel.mjs and are not repeated here. One rule
// is not a registry rule and is held here, because it needs what the build
// knows and the model does not: a live row of a protocol family that lists a
// behavior with a half only the SDK can provide must apply a reviewed patch
// that covers it (recoveryCoverageGaps below). The plan refuses the shipped
// registry without it, and the registry CLI check applies the same function.
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import registryData from '../deployments/zkapi/registry.json' with { type: 'json' };
import mainnetProfile from '../deployments/zkapi/mainnet.json' with { type: 'json' };
import sepoliaProfile from '../deployments/zkapi/sepolia.json' with { type: 'json' };
import { DEVELOPMENT_SETUP_ID, proofSetupKind } from '../chat/zkapi/versioning/adapters/concessionV1.mjs';
import { getAdapter } from '../chat/zkapi/versioning/adapters/index.mjs';
import { WIRED } from '../chat/zkapi/versioning/wiring.mjs';
import {
    REGISTRY_NETWORKS,
    RegistryError,
    depositTarget,
    emittedConfig,
    liveVersions,
    resolveRuntimeTable,
    serializeConfig,
    validateRegistry,
    walletDatabaseName
} from '../chat/zkapi/versioning/registryModel.mjs';
import { PATCH_COVERAGE, zkapiSdkPatchProvenance } from './patch-zkapi-sdk.mjs';

/** The reviewed registry and the v1 profile files it names (static JSON). */
export const REGISTRY = registryData;
export const PROFILE_FILES = Object.freeze({
    'mainnet.json': mainnetProfile,
    'sepolia.json': sepoliaProfile
});

/** The package name the application source imports; the first version's alias. */
export const CANONICAL_SDK_ALIAS = '@openanonymity/zkapi-browser-sdk';

/** The SDK's built-in wallet database. No registry-driven build may open it. */
export const SDK_DEFAULT_DATABASE = 'zkapi-browser-wallet-v1';

// Names the SDK store shares between its generations and the host never
// renames: the cross-tab lock and the change channel (docs: one wallet slot,
// serialized by one lock). Mirrors WALLET_LOCK_NAME of
// chat/zkapi/versioning/walletHoldings.mjs; the build asserts both literals in
// every live store, and a versioned-build test pins the mirror.
export const WALLET_LOCK_NAME = 'zkapi-wallet:active-runtime';
export const WALLET_CHANNEL_NAME = 'zkapi-wallet:active-runtime';

const sha256 = value => createHash('sha256').update(value).digest('hex');
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);

// ---------------------------------------------------------------------------
// Recovery patch coverage
// ---------------------------------------------------------------------------

/**
 * Protocol wiring that is only complete with the SDK's cooperation. The host
 * half is checked by the tests; the SDK half is a recovery patch applied to the
 * SDK a live row ships, which PATCH_COVERAGE (scripts/patch-zkapi-sdk.mjs)
 * says by name.
 */
export const SDK_HALF_WIRING = Object.freeze(['withdrawal-operation-recheck']);

/**
 * The reviewed recovery patches by name, as `{ revision, covers }`: the one SDK
 * revision a patch is bound to (patchSdkVersion refuses it for any other) and
 * the wiring behaviors it provides the SDK half of.
 */
export function reviewedRecoveryPatches() {
    return Object.fromEntries(Object.entries(PATCH_COVERAGE).map(([name, covers]) => [name, {
        revision: zkapiSdkPatchProvenance(name).revision,
        covers: [...covers]
    }]));
}

/**
 * The live rows of `registry` (active or exit-only on any network) whose
 * adapter lists a name of SDK_HALF_WIRING and whose `sdk.patches` names no
 * patch of `reviewed` that covers it for the row's own SDK revision. Pure: the
 * registry is expected to have passed validateRegistry, `adapters` resolves a
 * row's adapter id and `reviewed` is what reviewedRecoveryPatches returns.
 *
 * A gap is `{ versionId, adapter, name, networks, patches, otherRevision }`;
 * `otherRevision` lists the named patches that cover the behavior, but for a
 * different SDK revision than the row pins.
 */
export function recoveryCoverageGaps(registry, {
    adapters = getAdapter, reviewed = reviewedRecoveryPatches(), networks = REGISTRY_NETWORKS
} = {}) {
    const liveOn = new Map();
    for (const network of networks) {
        for (const row of liveVersions(registry, network)) liveOn.set(row, [...(liveOn.get(row) || []), network]);
    }
    // Anything that is not a plain name-to-patch object covers nothing.
    const table = isRecord(reviewed) ? reviewed : {};
    const gaps = [];
    for (const [row, rowNetworks] of liveOn) {
        const adapter = adapters(row.adapter);
        const listed = Array.isArray(adapter?.requiredWiring) ? adapter.requiredWiring : [];
        const patches = Array.isArray(row.sdk?.patches) ? row.sdk.patches : [];
        for (const name of SDK_HALF_WIRING) {
            if (!listed.includes(name)) continue;
            const providing = patches.filter(patch => Object.hasOwn(table, patch)
                && isRecord(table[patch]) && Array.isArray(table[patch].covers)
                && table[patch].covers.includes(name));
            const covered = providing.some(patch => typeof row.sdk?.revision === 'string'
                && table[patch].revision === row.sdk.revision);
            if (covered) continue;
            gaps.push({
                versionId: row.id,
                adapter: adapter.id,
                name,
                networks: rowNetworks,
                patches: [...patches],
                otherRevision: providing
            });
        }
    }
    return gaps;
}

/** Throws a RegistryError (code `recovery_patch_coverage`) for the first gap. */
export function assertRecoveryCoverage(registry, options) {
    const [gap] = recoveryCoverageGaps(registry, options);
    if (!gap) return;
    let applied = 'names no patch';
    if (gap.otherRevision.length) {
        applied = `names ${gap.patches.join(', ')}, but ${gap.otherRevision.join(', ')} covers it only for another SDK revision`;
    } else if (gap.patches.length) {
        applied = `names ${gap.patches.join(', ')}, none of which covers it`;
    }
    throw new RegistryError('recovery_patch_coverage',
        `${gap.versionId} is live on ${gap.networks.join(' and ')} and its ${gap.adapter} protocol lists ${gap.name}, `
        + `which is only complete when the SDK itself refuses a replaced withdrawal, but its sdk.patches ${applied}. `
        + 'Register a reviewed recovery patch for this SDK revision that covers it (PATCH_COVERAGE in '
        + 'scripts/patch-zkapi-sdk.mjs; an entry with no files is enough for a revision that provides it itself, '
        + 'and a not_required verdict alone is not coverage) and list it in sdk.patches, or keep the version pending.');
}

// ---------------------------------------------------------------------------
// Proof setup limitation
// ---------------------------------------------------------------------------
//
// The host accepts the single-party development setup on every network (the
// accepted-setup note of adapters/concessionV1.mjs). Accepting it is not hiding
// it: everything below only reports the setup a live version is built on.

/**
 * The proof setup a reviewed profile pins: `{ setupId, kind }` with kind
 * 'ceremony', 'development' or null. Both are null for a profile that names
 * none (the legacy family's). Pure.
 */
export function profileProofSetup(profile) {
    const pinned = profile?.trusted_deployment?.setup_id;
    const setupId = typeof pinned === 'string' ? pinned : null;
    return { setupId, kind: proofSetupKind(setupId) };
}

/**
 * The warning a live version on the development setup gets, in the words the
 * build prints and the registry check repeats. One string per version and
 * network, naming both and the consequence.
 */
export function developmentSetupWarning({ versionId, network }) {
    return `WARNING: zkAPI ${versionId} on ${network} is built on the single-party development proof setup `
        + `(${DEVELOPMENT_SETUP_ID}). Whoever generated its keys can forge proofs and take every deposit in this vault, `
        + `and a vault deployed on these keys cannot be switched to mpc-1 later (that is a new vault and a user `
        + 'migration). Accepted by owner decision; see docs/ZKAPI_VERSIONING.md.';
}

/**
 * The live versions of `network` in a plan that are built on the development
 * setup, as `{ versionId, network }` in ordinal order. Empty for sdk-default
 * and for a plan without one. Pure.
 */
export function developmentSetupVersions(plan) {
    if (!plan || plan.mode === 'sdk-default' || !Array.isArray(plan.versions)) return [];
    return plan.versions
        .filter(version => profileProofSetup(version.profile).kind === 'development')
        .map(version => ({ versionId: version.id, network: plan.network }));
}

/**
 * The live rows of a registry (active or exit-only, on any network) whose
 * reviewed profile pins the development setup, as `{ versionId, network }`.
 * What the registry check reports without forming a plan. `profiles` names the
 * profile files a row refers to; an inline `config` is read from the row.
 */
export function developmentSetupRows(registry, { profiles = PROFILE_FILES, networks = REGISTRY_NETWORKS } = {}) {
    const found = [];
    for (const network of networks) {
        for (const row of liveVersions(registry, network)) {
            const entry = row.networks?.[network];
            const profile = isRecord(entry?.config) ? entry.config : profiles?.[entry?.profile];
            if (profileProofSetup(profile).kind === 'development') found.push({ versionId: row.id, network });
        }
    }
    return found;
}

// The words that say whose rule the SDK's refusal is and what can be done about
// it. A vault already deployed on dev keys cannot be moved to mpc-1 by choosing
// another bundle, so that way out is named for what it costs.
function developmentSetupRefusalText(error) {
    return `this host accepts the single-party development proof setup (${DEVELOPMENT_SETUP_ID}) on every network, `
        + 'but the SDK package\'s own build refuses it for mainnet '
        + `(development_setup_on_mainnet: ${error.message}). The host does not bypass or patch that check. Relax it `
        + 'in the SDK upstream and pin that revision; pinning an SDK bundle built for the mpc-1 setup instead means a '
        + 'new vault and a user migration (a further version of the registry), because a vault deployed on dev keys '
        + 'cannot be switched to mpc-1.';
}

/**
 * Wrap an SDK build refusal for the person reading the build output. The SDK
 * package's own build (not this host) refuses a development bundle for
 * mainnet, code development_setup_on_mainnet. The host accepts that setup, so
 * the bare refusal would read as the host's rule; say whose rule it is and what
 * can be done. Every other failure keeps its message and code, prefixed by
 * `where`. The SDK's check itself is never bypassed or reimplemented here.
 */
export function sdkRefusalError(error, where) {
    if (error?.code === 'development_setup_on_mainnet') {
        const failure = new Error(`[build] ${where}: ${developmentSetupRefusalText(error)}`, { cause: error });
        failure.code = error.code;
        return failure;
    }
    const failure = new Error(`[build] ${where}: ${error?.message}`, { cause: error });
    if (error?.code) failure.code = error.code;
    return failure;
}

/**
 * Ask the installed SDK package of each development-setup row (the rows
 * developmentSetupRows returns) whether its own build would refuse that row's
 * profile as a development setup on mainnet, the one refusal the build meets
 * after the host has accepted the profile. The SDK's exported check is the
 * oracle, called exactly as verifyPlanOnDisk calls it; nothing is reimplemented.
 *
 * Best effort and read-only: a package that is not installed, that exports no
 * check, or that refuses for any other reason says nothing here (the build
 * verifies all of those). Resolves with `{ versionId, network, message }` for
 * each row the SDK refuses, `message` a warning in the host's words that says
 * the build of that network stops there. `packageRoot` is where the SDK
 * packages are resolved from.
 */
export async function sdkDevelopmentSetupRefusals(registry, rows, { profiles = PROFILE_FILES, packageRoot } = {}) {
    if (typeof packageRoot !== 'string' || !packageRoot) throw new TypeError('[build] A packageRoot is required.');
    const refused = [];
    for (const { versionId, network } of rows) {
        const row = registry.versions.find(candidate => candidate.id === versionId);
        const entry = row?.networks?.[network];
        const profile = isRecord(entry?.config) ? entry.config : profiles?.[entry?.profile];
        try {
            const pkg = resolveSdkPackage(row.sdk.alias, packageRoot);
            const buildFile = resolveSdkEntry(pkg, 'build');
            if (!buildFile) continue;
            const sdkBuild = await import(pathToFileURL(buildFile).href);
            if (typeof sdkBuild.assertDeployableProfile !== 'function') continue;
            const assets = await readJson(path.join(pkg.root, 'sdk/assets/manifest.json'), `${row.sdk.alias} asset manifest`);
            sdkBuild.assertDeployableProfile(profile, assets, network, assets.files);
        } catch (error) {
            if (error?.code === 'development_setup_on_mainnet') {
                refused.push({
                    versionId,
                    network,
                    message: `WARNING: zkAPI ${versionId} on ${network}: ${developmentSetupRefusalText(error)} `
                        + 'A build of this registry for that network stops at that refusal.'
                });
            }
        }
    }
    return refused;
}

// ---------------------------------------------------------------------------
// Pure plan
// ---------------------------------------------------------------------------

/**
 * The build plan for `network`.
 *
 *   deployment ''   -> mode 'sdk-default': no registry, no versioning, the SDK's
 *                      own defaults (OA_ZKAPI_DEPLOYMENT unset).
 *   deployment L    -> L must equal registry.lineage. The registry is validated
 *                      (every rule, both networks) and every live version of the
 *                      network is planned, ordinal ascending. mode is 'single' for
 *                      one live version and 'multi' for more.
 *
 * `registry`, `profiles` and `wired` exist so tests can plan fixture registries;
 * the production callers never pass them. Nothing here is mutated or shared:
 * configs are deep copies.
 *
 * `recoveryPatches` (reviewedRecoveryPatches()) holds a registry to the
 * recovery patch coverage rule: the SDK half of a behavior its protocol
 * requires must be provided by a reviewed patch (assertRecoveryCoverage). It
 * defaults to the reviewed patches for the shipped registry, so nothing that
 * is built, and no deploy configuration, is produced for a live row whose SDK
 * half is missing; a fixture registry is held to it only when a test passes
 * them, because its rows carry no patches.
 */
export function planFromRegistry({
    network, deployment = '', registry = REGISTRY, profiles = PROFILE_FILES, wired = WIRED,
    recoveryPatches = registry === REGISTRY ? reviewedRecoveryPatches() : null
} = {}) {
    if (!REGISTRY_NETWORKS.includes(network)) {
        throw new Error('[build] An explicit zkAPI network is required.');
    }
    if (!deployment) {
        return {
            network, lineage: null, mode: 'sdk-default',
            walletDatabase: '', walletDatabaseVersion: null,
            versions: [], retired: [], depositTarget: null, registrySha256: null, table: []
        };
    }
    if (!isRecord(registry) || deployment !== registry.lineage) {
        throw new Error(`[build] OA_ZKAPI_DEPLOYMENT must be ${registry?.lineage}, or unset for SDK defaults.`);
    }
    try {
        validateRegistry(registry, { profiles, adapters: getAdapter, wired, lineage: deployment });
        if (recoveryPatches) assertRecoveryCoverage(registry, { reviewed: recoveryPatches });
    } catch (error) {
        const failure = new Error(`[build] The zkAPI version registry is invalid (${error?.code || 'error'}): ${error?.message}`);
        failure.code = error?.code;
        failure.cause = error;
        throw failure;
    }

    const rows = liveVersions(registry, network);
    if (!rows.length) throw new Error(`[build] No zkAPI version is live on ${network}.`);
    const table = resolveRuntimeTable(registry, network, { profiles, sha256 });
    const versions = rows.map(row => {
        const entry = row.networks[network];
        const profile = isRecord(entry.config) ? entry.config : profiles[entry.profile];
        // What the browser receives. `deposits: "closed"` is appended only for
        // an SDK that honors it, so the legacy configuration stays byte-for-byte.
        const config = emittedConfig(profile, { honorsDepositsFlag: row.sdk.honorsDepositsFlag, status: entry.status });
        const resolved = table.find(candidate => candidate.id === row.id);
        const configSha256 = sha256(serializeConfig(config));
        if (resolved?.configSha256 !== configSha256) {
            throw new Error(`[build] The embedded configuration hash of ${row.id} disagrees with the emitted configuration.`);
        }
        return {
            id: row.id,
            row: structuredClone(row),
            ordinal: row.ordinal,
            status: entry.status,
            adapter: row.adapter,
            sdk: structuredClone(row.sdk),
            publicPath: row.publicPath,
            proxyPath: row.proxyPath,
            // The reviewed profile, which adapter rules validate, and the
            // configuration actually written (they differ only by `deposits`).
            profile: structuredClone(profile),
            profileFile: typeof entry.profile === 'string' ? entry.profile : null,
            config: structuredClone(config),
            configSha256
        };
    });
    const target = depositTarget(registry, network);
    return {
        network,
        lineage: registry.lineage,
        mode: versions.length > 1 ? 'multi' : 'single',
        walletDatabase: walletDatabaseName(registry, network),
        walletDatabaseVersion: registry.walletDatabaseVersion,
        versions,
        retired: table.filter(version => version.status === 'retired')
            .map(({ id, deploymentId, chainId, vault }) => ({ id, deploymentId, chainId, vault })),
        depositTarget: target ? target.id : null,
        registrySha256: sha256(serializeConfig(registry)),
        table
    };
}

/**
 * The version table the app embeds as __OA_ZKAPI_VERSIONS__: live versions
 * ordinal ascending, then retired tombstones, never pending. Empty in
 * sdk-default mode. A deep copy: callers may not alias the plan.
 */
export function runtimeVersionTable(plan) {
    return structuredClone(plan?.table || []);
}

// ---------------------------------------------------------------------------
// SDK package access (async, filesystem)
// ---------------------------------------------------------------------------

/**
 * Locate an installed SDK package under `packageRoot` the way Node would
 * (hoisting included). Throws loudly: a live version with no package must fail
 * the build, never ship a build that looks fine.
 */
export function resolveSdkPackage(alias, packageRoot) {
    const require = createRequire(path.join(packageRoot, 'package.json'));
    let packageJson;
    try {
        packageJson = require.resolve(`${alias}/package.json`);
    } catch (cause) {
        throw new Error(`[build] The zkAPI SDK package ${alias} is not installed. Run npm install.`, { cause });
    }
    return { alias, require, root: path.dirname(packageJson) };
}

/**
 * Absolute file behind `<alias>/<subpath>` ('' is the package root export), or
 * null when the package does not export that subpath. Any other failure throws.
 */
export function resolveSdkEntry(pkg, subpath) {
    const specifier = subpath ? `${pkg.alias}/${subpath}` : pkg.alias;
    try {
        return pkg.require.resolve(specifier);
    } catch (error) {
        if (error?.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED') return null;
        throw new Error(`[build] Could not resolve ${specifier}.`, { cause: error });
    }
}

// ---------------------------------------------------------------------------
// Wallet store declarations
// ---------------------------------------------------------------------------

const STORE_DECLARATIONS = Object.freeze({
    database: { pattern: /^const DB_NAME = '([^'\n]*)';[ \t]*$/gm, label: 'database name' },
    version: { pattern: /^const DB_VERSION = (\d+);[ \t]*$/gm, label: 'database version' },
    lock: { pattern: /^[ \t]*const lockName = '([^'\n]*)';[ \t]*$/gm, label: 'lock name' },
    channel: { pattern: /new BroadcastChannel\('([^'\n]*)'\)/g, label: 'channel name' }
});

/**
 * Read the four wallet-store declarations the shared slot depends on and
 * require each to occur exactly once. Returns
 * `{database, version, lock, channel}` as written in the source.
 */
export function readWalletStoreDeclarations(source) {
    const found = {};
    for (const [key, { pattern, label }] of Object.entries(STORE_DECLARATIONS)) {
        const matches = [...source.matchAll(pattern)];
        if (matches.length !== 1) {
            throw new Error(`[build] The wallet store must declare its ${label} exactly once (found ${matches.length}). Review the wallet storage namespace for this SDK source.`);
        }
        found[key] = key === 'version' ? Number(matches[0][1]) : matches[0][1];
    }
    return found;
}

/**
 * Assert the shared-slot invariants of a store source: the database version
 * the registry pins ("never bump"), and the unrenamed cross-tab lock and
 * channel. A mismatch means this SDK would no longer share one wallet slot
 * with its siblings.
 */
export function assertWalletStoreInvariants(source, { databaseVersion, where = 'The wallet store' }) {
    const declared = readWalletStoreDeclarations(source);
    if (declared.version !== databaseVersion) {
        throw new Error(`[build] ${where} declares database version ${declared.version}, not ${databaseVersion}. Never bump the shared wallet database version.`);
    }
    if (declared.lock !== WALLET_LOCK_NAME) {
        throw new Error(`[build] ${where} uses a different cross-tab lock name. Review the wallet storage namespace for this SDK source.`);
    }
    if (declared.channel !== WALLET_CHANNEL_NAME) {
        throw new Error(`[build] ${where} uses a different change channel name. Review the wallet storage namespace for this SDK source.`);
    }
    return declared;
}

// ---------------------------------------------------------------------------
// On-disk verification
// ---------------------------------------------------------------------------

async function readJson(file, label) {
    let text;
    try {
        text = await fs.readFile(file, 'utf8');
    } catch (cause) {
        throw new Error(`[build] Could not read ${label}.`, { cause });
    }
    try {
        return JSON.parse(text);
    } catch (cause) {
        throw new Error(`[build] ${label} is not valid JSON.`, { cause });
    }
}

const isPlaceholderProfile = config => config?.deployment_status === 'not_deployed'
    || config?.trusted_deployment?.deployment_status === 'not_deployed';

// Receipts of completed verifications. A receipt is an opaque frozen object the
// caller can only obtain from verifyPlanOnDisk; what it vouches for lives here,
// by identity, never in the object, so it cannot be forged or edited.
const receipts = new WeakMap();

const planFingerprint = plan => sha256(JSON.stringify(plan));

/**
 * Refuse a plan whose installed state differs from what the registry pins.
 * Fails loudly for every live version; pending versions are not in the plan, so
 * an uninstalled alias of a dormant version is never required.
 *
 * Resolves with a receipt for this plan and these roots (null in sdk-default
 * mode, where there is nothing to verify). Passing that receipt back as
 * `verified`, for an unchanged plan and the same roots, returns it without
 * reading the disk again: the build verifies once before it cleans dist/ and
 * buildZkapiAssets would otherwise repeat every read. A receipt for a different
 * plan (or one whose content changed since), different roots, or anything that
 * is not a receipt is ignored, and the full verification runs.
 *
 * Per live version:
 *   - the alias resolves under packageRoot (hoisting honored);
 *   - package.json `dependencies[alias]` equals the registry source;
 *   - the lock entry node_modules/<alias> resolves to #<revision>;
 *   - the SDK package's own profile for the network is not a placeholder (its
 *     ./build validates that profile before writing and cannot take a host one);
 *   - the wallet store's SHA-256 equals the registry pin, and its database
 *     version, lock and channel literals are the shared ones;
 *   - the reviewed profile passes its adapter against the package's asset
 *     manifest digests, circuit and proof setup;
 *   - when the SDK exports assertDeployableProfile from ./build, it accepts the
 *     reviewed profile (setup, circuit, concession exit, key hashes). Its
 *     refusal of a development bundle for mainnet is reported with the host's
 *     wording (sdkRefusalError), keeping its code.
 * The emitted proving-key bytes are checked again after emission
 * (scripts/zkapiBuild.mjs), which is the check that matters for the bytes served.
 */
export async function verifyPlanOnDisk(plan, { repoRoot, packageRoot, lockPath, verified } = {}) {
    if (!plan || plan.mode === 'sdk-default') return null;
    if (typeof repoRoot !== 'string' || !repoRoot) throw new TypeError('[build] verifyPlanOnDisk needs a repoRoot.');
    const scope = JSON.stringify({
        plan: planFingerprint(plan),
        repoRoot: path.resolve(repoRoot),
        resolutionRoot: path.resolve(packageRoot || repoRoot),
        lockPath: path.resolve(lockPath || path.join(repoRoot, 'package-lock.json'))
    });
    if (verified !== null && typeof verified === 'object' && receipts.get(verified) === scope) return verified;
    const resolutionRoot = packageRoot || repoRoot;
    const manifest = await readJson(path.join(repoRoot, 'package.json'), 'package.json');
    const lock = await readJson(lockPath || path.join(repoRoot, 'package-lock.json'), 'package-lock.json');

    for (const version of plan.versions) {
        const { alias, source, revision, storeSha256 } = version.sdk;
        const where = `zkAPI ${version.id} (${alias})`;
        const pkg = resolveSdkPackage(alias, resolutionRoot);

        if (manifest.dependencies?.[alias] !== source) {
            throw new Error(`[build] ${where}: package.json must pin ${alias} to ${source}.`);
        }
        const dependency = lock.packages?.[`node_modules/${alias}`];
        const locked = dependency?.resolved?.match(/#([0-9a-f]{40})$/)?.[1];
        if (!locked) {
            throw new Error(`[build] ${where}: the SDK dependency must resolve to an immutable Git commit in package-lock.json.`);
        }
        if (locked !== revision) {
            throw new Error(`[build] ${where}: package-lock.json resolves ${alias} to ${locked}, not ${revision}.`);
        }

        const packageProfile = await readJson(path.join(pkg.root, 'sdk/assets/config', `${plan.network}.json`),
            `${alias} ${plan.network} profile`);
        if (isPlaceholderProfile(packageProfile)) {
            throw new Error(`[build] ${where}: the SDK ships a not_deployed ${plan.network} profile, which its asset build refuses. Pin a revision with a deployed profile.`);
        }

        const storeFile = resolveSdkEntry(pkg, 'store');
        if (!storeFile) throw new Error(`[build] ${where}: the SDK exports no ./store.`);
        const storeSource = await fs.readFile(storeFile, 'utf8');
        if (sha256(storeSource) !== storeSha256) {
            throw new Error(`[build] ${where}: review the wallet storage namespace for this SDK source (store hash differs from the registry pin).`);
        }
        assertWalletStoreInvariants(storeSource, { databaseVersion: plan.walletDatabaseVersion, where });

        const assets = await readJson(path.join(pkg.root, 'sdk/assets/manifest.json'), `${alias} asset manifest`);
        const files = {};
        for (const [relative, key] of [['proofs/request.pk', 'assets/proofs/request.pk'],
            ['proofs/withdrawal.pk', 'assets/proofs/withdrawal.pk'], ['proofs/request.vk', 'assets/proofs/request.vk']]) {
            if (isRecord(assets.files) && typeof assets.files[key] === 'string') files[relative] = assets.files[key];
        }
        try {
            // The key is always present, even for a bundle whose manifest has
            // no setup (the legacy SDK): an adapter that checks the bundle's
            // setup must see a missing one, and one that does not ignores it.
            getAdapter(version.adapter).validateProfile(version.profile, {
                network: plan.network,
                circuitId: assets.circuitId,
                setupId: assets.setupId,
                files,
                proxyPath: version.proxyPath,
                strict: true
            });
        } catch (error) {
            throw new Error(`[build] ${where}: ${error?.message}`, { cause: error });
        }

        const buildFile = resolveSdkEntry(pkg, 'build');
        if (!buildFile) throw new Error(`[build] ${where}: the SDK exports no ./build.`);
        // Importing the SDK's build module only defines functions (node
        // built-ins, no side effects); it is the same module buildBrowserSdkAssets
        // runs from.
        const sdkBuild = await import(pathToFileURL(buildFile).href);
        if (typeof sdkBuild.assertDeployableProfile === 'function') {
            try {
                sdkBuild.assertDeployableProfile(version.profile, assets, plan.network, assets.files);
            } catch (error) {
                throw sdkRefusalError(error, where);
            }
        }
    }
    const receipt = Object.freeze({});
    receipts.set(receipt, scope);
    return receipt;
}
