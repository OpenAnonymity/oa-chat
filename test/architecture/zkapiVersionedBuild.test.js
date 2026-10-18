import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

// The suite bundles architecture tests, so build scripts and fixtures are
// loaded from their source locations (their package and path resolution is
// part of what is under test), exactly as zkapiBuild.test.js does.
const root = process.cwd();
const projectRequire = createRequire(path.join(root, 'package.json'));
const esbuild = projectRequire('esbuild');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const load = relative => import(pathToFileURL(path.join(root, relative)).href);

const LEGACY_ALIAS = '@openanonymity/zkapi-browser-sdk';
const FIXTURE_ALIAS = 'zkapi-sdk-v2c';
const DEPLOYMENT = 'fresh-20260930';
const FIXTURE_SDK = path.join(root, 'test/fixtures/zkapi-sdk-v2-fixture');
const DEFAULT_DATABASE = 'zkapi-browser-wallet-v1';
const NETWORKS = ['mainnet', 'sepolia'];

let helperModules = null;
function helpers() {
    helperModules ??= (async () => ({
        build: await load('scripts/zkapiBuild.mjs'),
        registry: await load('scripts/zkapiRegistry.mjs'),
        facade: await load('scripts/zkapiFacadePlugin.mjs'),
        generator: await load('scripts/generate-zkapi-vercel-config.mjs'),
        patch: await load('scripts/patch-zkapi-sdk.mjs'),
        model: await load('chat/zkapi/versioning/registryModel.mjs'),
        fixtures: await load('test/zkapi/_registryFixtures.mjs')
    }))();
    return helperModules;
}

const legacySdkRoot = () => path.dirname(projectRequire.resolve(`${LEGACY_ALIAS}/package.json`));

// ---------------------------------------------------------------------------
// A throwaway project: package.json, lock, node_modules with the REAL legacy
// SDK (symlinked: read-only, hash-gated, already patched) and a copy of the
// fixture SDK under the v2 alias, plus a tiny chat/zkapi importer tree.
// ---------------------------------------------------------------------------

const ENTRY_SOURCE = `
import zkapiClient, { ZkapiClient } from '@openanonymity/zkapi-browser-sdk/client';
import walletRuntime from '@openanonymity/zkapi-browser-sdk/runtime';
import * as store from '@openanonymity/zkapi-browser-sdk/store';
import * as requestArchive from '@openanonymity/zkapi-browser-sdk/request-archive';
import { SESSION_HEADER } from '@openanonymity/zkapi-browser-sdk';
import { loadVariant } from './versioning/variants.js';

export async function run(id) {
    const before = {
        client: typeof zkapiClient, runtime: typeof walletRuntime, store: typeof store.readBrowserWallet
    };
    await loadVariant(id);
    const wallet = await store.readBrowserWallet();
    const { walletErrorMessage } = await import('@openanonymity/zkapi-browser-sdk/wallet-error');
    // Application code imported AFTER the variant is bound, from another chunk:
    // the boot order the real app uses.
    const late = await import('./late.js');
    return {
        late: late.describe(),
        before,
        singleton: zkapiClient === globalThis.zkapiClient,
        instance: zkapiClient instanceof ZkapiClient,
        sessionHeader: typeof SESSION_HEADER,
        requestArchive: Object.entries(requestArchive).some(([name, value]) => name !== '__oaBind' && value !== undefined),
        walletEmpty: wallet.state === null || wallet.state === undefined,
        runtimeKind: typeof walletRuntime.reload,
        dynamicImport: typeof walletErrorMessage
    };
}

export async function conflict() {
    await loadVariant('v1');
    const codes = {};
    for (const id of ['v2', 'nope', 7]) {
        try { await loadVariant(id); codes[String(id)] = 'resolved'; } catch (error) { codes[String(id)] = error.code; }
    }
    await loadVariant('v1');
    return codes;
}
`;

const RUNNER_SOURCE = `
import { pathToFileURL } from 'node:url';
const [bundle, call, id] = process.argv.slice(2);
const opened = [];
const noop = { close() {}, transaction() {
    const transaction = {};
    const complete = value => {
        const operation = {};
        queueMicrotask(() => {
            operation.result = value;
            operation.onsuccess?.();
            setTimeout(() => transaction.oncomplete?.(), 0);
        });
        return operation;
    };
    transaction.objectStore = () => ({ get: () => complete(undefined), getAll: () => complete([]), put: key => complete(key) });
    return transaction;
} };
globalThis.indexedDB = { open(name, version) {
    opened.push([name, version]);
    const request = {};
    queueMicrotask(() => { request.result = noop; request.onsuccess?.(); });
    return request;
} };
const module = await import(pathToFileURL(bundle).href);
const outcome = await module[call](id);
console.log(JSON.stringify({ outcome, opened }));
`;

const LATE_SOURCE = `
import zkapiClient from '@openanonymity/zkapi-browser-sdk/client';
import * as store from '@openanonymity/zkapi-browser-sdk/store';

export function describe() {
    return {
        client: typeof zkapiClient,
        singleton: zkapiClient === globalThis.zkapiClient,
        store: typeof store.readBrowserWallet
    };
}
`;

const VARIANTS_STUB = `export async function loadVariant() {
    throw Object.assign(new Error('No zkAPI variants in this build.'), { code: 'no_variants' });
}
`;

// The shared entry reads the legacy-only SESSION_HEADER on purpose: it is what
// shows a union facade bound `undefined` under the other SDK. The name parity
// check is told that is intended, exactly as chat/zkapi would have to.
const ENTRY_GUARDED_NAMES = Object.freeze([{
    subpath: '', name: 'SESSION_HEADER', reason: 'the test entry asserts a union-only name is undefined under the other SDK'
}]);

async function makeProject(t, {
    kind: registryKind = 'activated', mutateRegistry, mutateFixture, mutateInstalled, mutatePackage, mutateLock,
    withFixturePackage = true
} = {}) {
    const { fixtures, registry: registryModule } = await helpers();
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'oa-versioned-build-'));
    t.after(() => fs.rm(temp, { recursive: true, force: true }));
    await fs.mkdir(path.join(temp, 'node_modules/@openanonymity'), { recursive: true });
    await fs.symlink(legacySdkRoot(), path.join(temp, 'node_modules', LEGACY_ALIAS), 'dir');
    const fixtureRoot = path.join(temp, 'node_modules', FIXTURE_ALIAS);
    if (withFixturePackage) {
        await fs.cp(FIXTURE_SDK, fixtureRoot, { recursive: true });
        if (mutateFixture) await mutateFixture(fixtureRoot);
    }

    const registry = {
        activated: fixtures.activatedRegistry,
        rollback: fixtures.rollbackRegistry,
        dormant: fixtures.validRegistry
    }[registryKind]();
    const v2 = registry.versions.find(row => row.id === 'v2');
    if (withFixturePackage) {
        const store = await fs.readFile(path.join(fixtureRoot, 'sdk/services/browserWalletStore.js'));
        v2.sdk.storeSha256 = digest(store);
        for (const network of NETWORKS) {
            const entry = v2.networks[network];
            if (entry.status === 'pending') continue;
            // Exactly what an activation PR does: the finalized profile the SDK ships.
            entry.config = JSON.parse(await fs.readFile(path.join(fixtureRoot, `sdk/assets/config/${network}.json`), 'utf8'));
        }
    }
    if (mutateRegistry) mutateRegistry(registry);
    // Changes to the installed package that the registry must not see.
    if (withFixturePackage && mutateInstalled) await mutateInstalled(fixtureRoot);

    const dependencies = { [LEGACY_ALIAS]: registry.versions[0].sdk.source };
    const packages = { [`node_modules/${LEGACY_ALIAS}`]: {
        version: '0.2.0', resolved: `git+ssh://git@github.com/OpenAnonymity/zkapi.git#${registry.versions[0].sdk.revision}`
    } };
    if (registryKind !== 'dormant') {
        dependencies[FIXTURE_ALIAS] = v2.sdk.source;
        packages[`node_modules/${FIXTURE_ALIAS}`] = {
            version: '0.2.0', resolved: `git+ssh://git@github.com/OpenAnonymity/zkapi.git#${v2.sdk.revision}`
        };
    }
    const manifest = { name: 'versioned-build-fixture', private: true, dependencies };
    const lock = { lockfileVersion: 3, packages };
    mutatePackage?.(manifest);
    mutateLock?.(lock);
    // ESM, so a bundle written under the project runs as a module.
    manifest.type = 'module';
    await fs.writeFile(path.join(temp, 'package.json'), JSON.stringify(manifest, null, 2));
    await fs.writeFile(path.join(temp, 'package-lock.json'), JSON.stringify(lock, null, 2));

    const importerRoot = path.join(temp, 'chat/zkapi');
    const variantsFile = path.join(importerRoot, 'versioning/variants.js');
    await fs.mkdir(path.dirname(variantsFile), { recursive: true });
    await fs.writeFile(variantsFile, VARIANTS_STUB);
    await fs.writeFile(path.join(importerRoot, 'entry.js'), ENTRY_SOURCE);
    await fs.writeFile(path.join(importerRoot, 'late.js'), LATE_SOURCE);
    await fs.writeFile(path.join(importerRoot, 'zkapi.css'), '.zkapi-fixture { color: inherit; }\n');
    await fs.writeFile(path.join(temp, 'runner.mjs'), RUNNER_SOURCE);

    const project = {
        temp, registry, importerRoot, variantsFile, fixtureRoot, entry: path.join(importerRoot, 'entry.js'),
        profiles: registryModule.PROFILE_FILES,
        plan(network, overrides = {}) {
            return registryModule.planFromRegistry({
                network, deployment: DEPLOYMENT, registry: project.registry, profiles: registryModule.PROFILE_FILES,
                wired: fixtures.ALL_WIRED, ...overrides
            });
        }
    };
    return project;
}

async function bundleApp(project, plan, { entry = project.entry, outdir = path.join(project.temp, 'bundle'), absWorkingDir = project.temp,
    importerRoot = project.importerRoot, variantsFile = project.variantsFile, guardedNames = ENTRY_GUARDED_NAMES } = {}) {
    const { build } = await helpers();
    const table = build.runtimeVersionTable(plan);
    const result = await esbuild.build({
        entryPoints: { app: entry },
        absWorkingDir,
        plugins: build.zkapiBuildPlugins(plan.network, DEPLOYMENT, {
            plan, packageRoot: project.temp, facade: { importerRoot, variantsFile, guardedNames }
        }),
        bundle: true, splitting: true, format: 'esm', outdir, entryNames: '[name]', chunkNames: 'chunk-[hash]',
        target: ['es2020'], minify: true, metafile: true, logLevel: 'silent',
        loader: { '.png': 'file', '.jpg': 'file', '.svg': 'file', '.woff': 'file', '.woff2': 'file' },
        define: {
            __OA_ZKAPI_NETWORK__: JSON.stringify(plan.network),
            __OA_ZKAPI_VERSIONS__: JSON.stringify(table),
            __OA_ZKAPI_WALLET_DB__: JSON.stringify(plan.walletDatabase)
        }
    });
    return { result, outdir, table };
}

function runBundle(project, bundleFile, call, id) {
    const stdout = execFileSync(process.execPath, [path.join(project.temp, 'runner.mjs'), bundleFile, call, id ?? ''],
        { encoding: 'utf8', cwd: project.temp });
    return JSON.parse(stdout.trim().split('\n').pop());
}

const sha256OfFile = async file => digest(await fs.readFile(file));

async function filesUnder(directory, base = directory, found = {}) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
        const absolute = path.join(directory, entry.name);
        if (entry.isDirectory()) await filesUnder(absolute, base, found);
        else found[path.relative(base, absolute).split(path.sep).join('/')] = await sha256OfFile(absolute);
    }
    return found;
}

// ---------------------------------------------------------------------------
// sdk-default and dormant single mode: today's build
// ---------------------------------------------------------------------------

test('sdk-default mode has no registry, versioning or database rename', async () => {
    const { registry: registryModule, build } = await helpers();
    for (const network of NETWORKS) {
        const plan = registryModule.planFromRegistry({ network });
        assert.equal(plan.mode, 'sdk-default');
        assert.deepEqual(plan.versions, []);
        assert.deepEqual(build.runtimeVersionTable(plan), []);
        assert.equal(plan.walletDatabase, '');
        assert.equal(plan.depositTarget, null);
        assert.deepEqual(build.zkapiBuildPlugins(network, '').map(plugin => plugin.name), ['verify-zkapi-recovery-patch']);
    }
    // The bundled store keeps the SDK default database name and nothing throws.
    const store = path.join(legacySdkRoot(), 'sdk/services/browserWalletStore.js');
    const bundled = await esbuild.build({
        entryPoints: [store], bundle: true, write: false, platform: 'node', format: 'esm', logLevel: 'silent',
        plugins: build.zkapiBuildPlugins('mainnet', '')
    });
    const text = Buffer.from(bundled.outputFiles[0].contents).toString('utf8');
    assert.ok(text.includes(`'${DEFAULT_DATABASE}'`) || text.includes(`"${DEFAULT_DATABASE}"`));
});

test('dormant registry: single mode emits exactly the legacy assets, bytes and rewrites', async t => {
    const { registry: registryModule, build, facade, generator } = await helpers();
    const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'oa-dormant-single-'));
    t.after(() => fs.rm(temporary, { recursive: true, force: true }));
    const emittedBuild = projectRequire('esbuild').build;
    // Sepolia has version 2 active (the activation change); only networks that
    // still carry version 1 alone are dormant.
    for (const network of NETWORKS.filter(name => name !== 'sepolia')) {
        const plan = registryModule.planFromRegistry({ network, deployment: DEPLOYMENT });
        assert.equal(plan.mode, 'single');
        assert.deepEqual(plan.versions.map(version => version.id), ['v1']);
        assert.equal(plan.depositTarget, 'v1');
        assert.equal(plan.walletDatabase, `zkapi-browser-wallet-${DEPLOYMENT}-${network}-v1`);
        // A single live version projects a one-row table, never pending rows.
        const table = build.runtimeVersionTable(plan);
        assert.deepEqual(table.map(version => version.id), ['v1']);
        assert.equal(table[0].assetBase, 'zkapi/');
        assert.equal(table[0].depositsOpen, true);
        assert.equal(facade.facadeRequired(plan), false);
        assert.deepEqual(build.zkapiBuildPlugins(network, DEPLOYMENT).map(plugin => plugin.name),
            ['verify-zkapi-recovery-patch', 'oa-zkapi-wallet-namespace']);

        const outDir = path.join(temporary, network);
        const result = await build.buildZkapiAssets({ network, deployment: DEPLOYMENT, repoRoot: root, outDir, build: emittedBuild });
        assert.equal(result.directory, path.join(outDir, 'zkapi'));
        assert.deepEqual(result.versions.map(version => version.id), ['v1']);
        assert.equal(result.versions[0].publicPath, '/zkapi/');
        // The emitted tree is exactly the legacy one: nothing under v2c.
        assert.deepEqual(Object.keys(await filesUnder(result.directory)).sort(), [
            'assets/zkapiWasmWorker.js', 'browser-config.json', 'proofs/request.pk', 'proofs/withdrawal.pk',
            'sdk-assets.json', 'wasm/zkapi_browser_bg.wasm', 'zkapi.css'
        ]);
        // The configuration is the reviewed file, byte for byte, and its hash is
        // the one embedded in the version table.
        const reviewed = await fs.readFile(path.join(root, `deployments/zkapi/${network}.json`));
        assert.deepEqual(await fs.readFile(path.join(result.directory, 'browser-config.json')), reviewed);
        assert.equal(table[0].configSha256, digest(reviewed));
        assert.equal(plan.versions[0].configSha256, digest(reviewed));
        // Rewrites: one route, version 1's, to its reviewed protocol origin.
        const origin = JSON.parse(reviewed).trusted_deployment.protocol_server_url;
        assert.deepEqual(generator.zkapiProxyRewrites(plan), [{ source: '/zkapi-deployment/:path*', destination: `${origin}/:path*` }]);
        const routing = generator.buildZkapiVercelConfig({ orgOrigin: 'https://org-staging.openanonymity.ai', network, deployment: DEPLOYMENT });
        assert.deepEqual(routing.rewrites[0], { source: '/zkapi-deployment/:path*', destination: `${origin}/:path*` });
        assert.equal(routing.rewrites.filter(rewrite => rewrite.source.startsWith('/zkapi-deployment')).length, 1);
    }
    // The activated network: three versions, deposits to version 3, version 1
    // at the root of its hostname and version 2 under its own /v0.2 subtree.
    const activated = registryModule.planFromRegistry({ network: 'sepolia', deployment: DEPLOYMENT });
    assert.equal(activated.mode, 'multi');
    assert.deepEqual(activated.versions.map(version => version.id), ['v1', 'v2', 'v3']);
    assert.equal(activated.depositTarget, 'v3');
    const root1 = new URL(activated.versions[0].config.trusted_deployment.protocol_server_url).origin;
    assert.deepEqual(generator.zkapiProxyRewrites(activated), [
        { source: '/zkapi-deployment/:path*', destination: `${root1}/:path*` },
        { source: '/zkapi-deployment-v2c/v0.2/:path*', destination: `${root1}/v0.2/:path*` },
        { source: '/zkapi-deployment-v3/v0.3/:path*', destination: `${root1}/v0.3/:path*` }
    ]);
});

// One hostname for two deployments: the newer version is pinned under a plain
// path prefix of the older one's hostname (versioning/serviceBase.mjs). The
// plan, the registry rules and the generated routes must agree: the older
// version keeps its root rewrite, the newer one's rewrite forwards only its own
// subtree, and no rewrite of either reaches the other's routes.
test('a second version served under a prefix of the first one\'s hostname is planned and routed to its own subtree', async t => {
    const { generator, registry: registryModule } = await helpers();
    const project = await makeProject(t, {
        mutateRegistry(registry) {
            for (const network of NETWORKS) {
                const origin = registryModule.PROFILE_FILES[`${network}.json`].trusted_deployment.protocol_server_url;
                const base = `${origin}/c`;
                const config = registry.versions[1].networks[network].config;
                config.trusted_deployment.protocol_server_url = base;
                config.trusted_deployment.indexer_url = base;
                config.deployment_manifest_url = `${base}/config.json`;
                config.allowed_deployment_manifest_urls = [`${base}/config.json`];
            }
        }
    });
    for (const network of NETWORKS) {
        const plan = project.plan(network);
        assert.deepEqual(plan.versions.map(version => version.id), ['v1', 'v2']);
        const origin = plan.versions[0].config.trusted_deployment.protocol_server_url;
        assert.equal(plan.versions[1].config.trusted_deployment.protocol_server_url, `${origin}/c`);
        assert.deepEqual(generator.zkapiProxyRewrites(plan), [
            { source: '/zkapi-deployment/:path*', destination: `${origin}/:path*` },
            { source: '/zkapi-deployment-v2c/c/:path*', destination: `${origin}/c/:path*` }
        ]);
        const routing = generator.buildZkapiVercelConfig({ orgOrigin: 'https://org-staging.openanonymity.ai', network, deployment: DEPLOYMENT });
        // The shipped registry's own v2 is pending on mainnet (nothing of this
        // variant leaks into it) and routed under /v0.2 on Sepolia.
        assert.equal(routing.rewrites.filter(rewrite => rewrite.source.startsWith('/zkapi-deployment-v2c')).length,
            network === 'sepolia' ? 1 : 0);
        if (network === 'sepolia') assert.ok(routing.rewrites.some(rewrite => rewrite.source === '/zkapi-deployment-v2c/v0.2/:path*'));
    }
});

// "Dormant means identical": a build that is not versioning-active must ship
// the legacy tree it always shipped. Every file under dist/zkapi/ except the
// stylesheet (which carries host UI and changes with it) is compared with what
// the legacy SDK's own builder emits (the pre-registry sdk-default build), so
// nothing the registry, the adapters or a future feature does can leak a byte
// into a v1 deployment unnoticed. The legacy SDK files are the oracle, not a
// pinned digest, so an esbuild bump (which changes the bundled worker in both)
// does not fail it.
test('a dormant single-version build emits the legacy tree, byte for byte, except zkapi.css', async t => {
    const { build } = await helpers();
    const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'oa-dormant-tree-'));
    t.after(() => fs.rm(temporary, { recursive: true, force: true }));
    const emittedBuild = projectRequire('esbuild').build;
    const sdk = legacySdkRoot();
    for (const network of NETWORKS.filter(name => name !== 'sepolia')) {
        const registered = await build.buildZkapiAssets({
            network, deployment: DEPLOYMENT, repoRoot: root, outDir: path.join(temporary, `${network}-registry`), build: emittedBuild
        });
        const legacy = await build.buildZkapiAssets({
            network, deployment: '', repoRoot: root, outDir: path.join(temporary, `${network}-legacy`), build: emittedBuild
        });
        const mine = await filesUnder(registered.directory);
        const theirs = await filesUnder(legacy.directory);
        // Same set of files, and nothing under a versioned path.
        assert.deepEqual(Object.keys(mine).sort(), Object.keys(theirs).sort());
        assert.ok(Object.keys(mine).every(file => !file.startsWith('v2c/') && !file.includes('/v2c/')), 'no v2 asset tree');

        // The artifacts are the SDK package's own bytes, not a rebuild.
        const bytesOf = async relative => digest(await fs.readFile(path.join(sdk, relative)));
        assert.equal(mine['proofs/request.pk'], await bytesOf('sdk/assets/proofs/request.pk'));
        assert.equal(mine['proofs/withdrawal.pk'], await bytesOf('sdk/assets/proofs/withdrawal.pk'));
        assert.equal(mine['wasm/zkapi_browser_bg.wasm'], await bytesOf('sdk/wasm/zkapi_browser_bg.wasm'));
        // Everything that does not depend on the host configuration is the
        // same file the legacy builder wrote.
        for (const file of Object.keys(mine)) {
            if (['zkapi.css', 'browser-config.json', 'sdk-assets.json'].includes(file)) continue;
            assert.equal(mine[file], theirs[file], file);
        }
        // The configuration is the reviewed file, and the asset record is the
        // legacy one with only the lineage and the configuration digest added.
        const reviewed = await fs.readFile(path.join(root, `deployments/zkapi/${network}.json`));
        assert.equal(mine['browser-config.json'], digest(reviewed));
        const recorded = JSON.parse(await fs.readFile(path.join(registered.directory, 'sdk-assets.json'), 'utf8'));
        const baseline = JSON.parse(await fs.readFile(path.join(legacy.directory, 'sdk-assets.json'), 'utf8'));
        assert.deepEqual(recorded, {
            ...baseline, files: { ...baseline.files, 'browser-config.json': digest(reviewed) }, deployment: DEPLOYMENT
        });
        for (const [file, expected] of Object.entries(recorded.files)) {
            if (file !== 'sdk-assets.json') assert.equal(mine[file], expected, `sdk-assets.json records ${file}`);
        }
    }
});

test('the env contract is unchanged and names the registry lineage', async () => {
    const { build, registry: registryModule } = await helpers();
    assert.equal(registryModule.REGISTRY.lineage, DEPLOYMENT);
    assert.equal(build.resolveZkapiNetwork({ OA_ZKAPI_NETWORK: 'mainnet', OA_ZKAPI_DEPLOYMENT: DEPLOYMENT }), 'mainnet');
    assert.throws(() => build.resolveZkapiNetwork({ OA_ZKAPI_NETWORK: 'mainnet', OA_ZKAPI_DEPLOYMENT: 'fresh-20260928' }),
        /OA_ZKAPI_DEPLOYMENT must be fresh-20260930/);
    assert.throws(() => build.resolveZkapiNetwork({ OA_ZKAPI_DEPLOYMENT: DEPLOYMENT }), /requires an explicit OA_ZKAPI_NETWORK/);
    assert.throws(() => registryModule.planFromRegistry({ network: 'mainnet', deployment: 'v2' }), /OA_ZKAPI_DEPLOYMENT/);
    assert.throws(() => registryModule.planFromRegistry({ network: '', deployment: DEPLOYMENT }), /explicit zkAPI network/);
    assert.throws(() => registryModule.planFromRegistry({ network: 'goerli', deployment: DEPLOYMENT }), /explicit zkAPI network/);
    // A selector is never read from the registry file's own contents.
    const plan = registryModule.planFromRegistry({ network: 'sepolia', deployment: DEPLOYMENT });
    assert.equal(plan.lineage, DEPLOYMENT);
    // A plan for one selection cannot be used for another.
    assert.throws(() => build.zkapiBuildPlugins('mainnet', DEPLOYMENT, { plan }), /does not match the selected network/);
    assert.throws(() => build.zkapiBuildPlugins('sepolia', '', { plan }), /does not match the selected network/);
    await assert.rejects(build.buildZkapiAssets({ network: 'mainnet', deployment: DEPLOYMENT, repoRoot: root,
        outDir: path.join(os.tmpdir(), 'oa-never-written'), build() { throw new Error('must not build'); }, plan }),
    /does not match the selected network/);
});

test('planFromRegistry is pure, deterministic and does not alias its inputs', async () => {
    const { registry: registryModule } = await helpers();
    const before = JSON.stringify(registryModule.REGISTRY);
    const first = registryModule.planFromRegistry({ network: 'mainnet', deployment: DEPLOYMENT });
    const second = registryModule.planFromRegistry({ network: 'mainnet', deployment: DEPLOYMENT });
    assert.deepEqual(first, second);
    first.versions[0].config.trusted_deployment.chain_id = 5;
    first.table[0].label = 'changed';
    assert.equal(JSON.stringify(registryModule.REGISTRY), before);
    assert.equal(registryModule.PROFILE_FILES['mainnet.json'].trusted_deployment.chain_id, 1);
    assert.equal(registryModule.runtimeVersionTable(second)[0].label, 'Version 1');
    const copy = registryModule.runtimeVersionTable(second);
    copy[0].label = 'mutated';
    assert.equal(second.table[0].label, 'Version 1');
});

// ---------------------------------------------------------------------------
// Fixture-SDK multi-version build
// ---------------------------------------------------------------------------

test('multi mode emits both versions side by side with per-version configuration and provenance', async t => {
    const { build, generator, model } = await helpers();
    const project = await makeProject(t);
    for (const network of NETWORKS) {
        const plan = project.plan(network);
        assert.equal(plan.mode, 'multi');
        assert.deepEqual(plan.versions.map(version => `${version.id}:${version.status}`), ['v1:exit-only', 'v2:active']);
        assert.equal(plan.depositTarget, 'v2');
        assert.equal(plan.walletDatabase, `zkapi-browser-wallet-${DEPLOYMENT}-${network}-v1`);
        await build.verifyPlanOnDisk(plan, { repoRoot: project.temp, packageRoot: project.temp });

        const outDir = path.join(project.temp, 'out', network);
        // A stale file of an earlier build under zkapi/ must be cleaned once, up front.
        await fs.mkdir(path.join(outDir, 'zkapi'), { recursive: true });
        await fs.writeFile(path.join(outDir, 'zkapi/stale.txt'), 'old');
        const result = await build.buildZkapiAssets({
            network, deployment: DEPLOYMENT, repoRoot: project.temp, outDir, build: esbuild.build, plan, packageRoot: project.temp
        });
        await assert.rejects(fs.stat(path.join(outDir, 'zkapi/stale.txt')), { code: 'ENOENT' });
        assert.deepEqual(result.versions.map(version => [version.id, version.publicPath]), [['v1', '/zkapi/'], ['v2', '/zkapi/v2c/']]);
        assert.equal(result.directory, path.join(outDir, 'zkapi'));
        assert.deepEqual(result.versions[0].config, plan.versions[0].config);

        const table = build.runtimeVersionTable(plan);
        for (const [index, version] of plan.versions.entries()) {
            const directory = path.join(outDir, version.publicPath.slice(1));
            const bytes = await fs.readFile(path.join(directory, 'browser-config.json'));
            // The embedded hash is the hash of what the browser fetches.
            assert.equal(digest(bytes), version.configSha256);
            assert.equal(table[index].configSha256, version.configSha256);
            assert.equal(table[index].assetBase, version.publicPath.slice(1));
            assert.equal(bytes.toString('utf8'), model.serializeConfig(version.config));
            const manifest = JSON.parse(await fs.readFile(path.join(directory, 'sdk-assets.json'), 'utf8'));
            assert.equal(manifest.deployment, DEPLOYMENT);
            for (const [relative, hash] of Object.entries(manifest.files)) {
                assert.equal(await sha256OfFile(path.join(directory, relative)), hash, `${version.id}/${relative}`);
            }
            assert.deepEqual(manifest, result.versions[index].manifest);
        }
        // Proof assets of the second version are its own, under its own path.
        assert.deepEqual(Object.keys(await filesUnder(path.join(outDir, 'zkapi/v2c'))).sort(), [
            'assets/zkapiWasmWorker.js', 'browser-config.json', 'proofs/request.pk', 'proofs/request.vk',
            'proofs/withdrawal.pk', 'sdk-assets.json', 'wasm/zkapi_browser_bg.wasm'
        ]);
        // The shared stylesheet is written once, by the orchestrator, beside version 1.
        const everything = Object.keys(await filesUnder(path.join(outDir, 'zkapi')));
        assert.deepEqual(everything.filter(file => file.endsWith('zkapi.css')), ['zkapi.css']);
        assert.equal((await fs.readFile(path.join(outDir, 'zkapi/zkapi.css'), 'utf8')), '.zkapi-fixture { color: inherit; }\n');

        // Rewrites: one per live version, version 1 first, siblings not nested.
        const rewrites = generator.zkapiProxyRewrites(plan);
        assert.deepEqual(rewrites.map(rewrite => rewrite.source), ['/zkapi-deployment/:path*', '/zkapi-deployment-v2c/:path*']);
        assert.equal(rewrites[0].destination, `${plan.versions[0].config.trusted_deployment.protocol_server_url}/:path*`);
        assert.equal(rewrites[1].destination, `${plan.versions[1].config.trusted_deployment.protocol_server_url}/:path*`);

        // Provenance: baseline fields describe version 1, versions[] lists both.
        const provenance = await build.zkapiBuildProvenance({
            network, repoRoot: project.temp, outDir, sdkAssets: result, plan
        });
        assert.equal(provenance.deployment, DEPLOYMENT);
        assert.equal(provenance.sdk.revision, plan.versions[0].sdk.revision);
        assert.equal(provenance.sdk.patches[0].name, 'wallet-recovery-v1');
        assert.equal(provenance.depositTarget, 'v2');
        assert.equal(provenance.registrySha256, plan.registrySha256);
        assert.equal(provenance.walletStorage.database, plan.walletDatabase);
        assert.deepEqual(provenance.versions.map(version => [version.id, version.status, version.adapter, version.publicPath, version.proxyPath]), [
            ['v1', 'exit-only', 'note-bound-v1', '/zkapi/', '/zkapi-deployment/'],
            ['v2', 'active', 'concession-v1', '/zkapi/v2c/', '/zkapi-deployment-v2c/']
        ]);
        const [first, second] = provenance.versions;
        assert.equal(first.circuitId, 'zkapi-v2-note-bound-v1');
        assert.equal(second.circuitId, 'zkapi-v2-concession-v1');
        assert.equal(second.deploymentId, plan.versions[1].config.trusted_deployment.deployment_id);
        assert.equal(second.configSha256, plan.versions[1].configSha256);
        assert.equal(second.sdk.alias, FIXTURE_ALIAS);
        assert.deepEqual(second.sdk.patches, []);
        assert.deepEqual(second.sdk.assets, result.versions[1].manifest);
        assert.equal(second.walletStorage.database, plan.walletDatabase);
        assert.equal(second.walletStorage.sourceSha256, plan.versions[1].sdk.storeSha256);
        // Both stores are gated on their own source hash, one shared database.
        assert.notEqual(first.walletStorage.sourceSha256, second.walletStorage.sourceSha256);
        assert.equal(first.walletStorage.database, second.walletStorage.database);
        for (const file of ['zkapi/v2c/browser-config.json', 'zkapi/v2c/sdk-assets.json', 'zkapi/sdk-assets.json', 'zkapi/zkapi.css']) {
            assert.equal(provenance.files[file], await sha256OfFile(path.join(outDir, file)), file);
        }
    }
});

test('an exit-only version whose SDK honors the deposits flag is emitted closed, hash included', async t => {
    const { build, model } = await helpers();
    const project = await makeProject(t, { kind: 'rollback' });
    const plan = project.plan('sepolia');
    assert.deepEqual(plan.versions.map(version => `${version.id}:${version.status}`), ['v1:active', 'v2:exit-only']);
    assert.equal(plan.depositTarget, 'v1');
    const [v1, v2] = plan.versions;
    // Reviewed pins stay free of `deposits`; the emitted copy appends it last.
    assert.equal(v2.profile.trusted_deployment.deposits, undefined);
    assert.equal(v2.config.trusted_deployment.deposits, 'closed');
    assert.equal(v1.config.trusted_deployment.deposits, undefined);
    assert.notEqual(v2.configSha256, digest(model.serializeConfig(v2.profile)));
    const outDir = path.join(project.temp, 'out');
    const result = await build.buildZkapiAssets({
        network: 'sepolia', deployment: DEPLOYMENT, repoRoot: project.temp, outDir, build: esbuild.build, plan, packageRoot: project.temp
    });
    const written = JSON.parse(await fs.readFile(path.join(outDir, 'zkapi/v2c/browser-config.json'), 'utf8'));
    assert.equal(written.trusted_deployment.deposits, 'closed');
    assert.equal(digest(await fs.readFile(path.join(outDir, 'zkapi/v2c/browser-config.json'))), v2.configSha256);
    assert.equal(build.runtimeVersionTable(plan)[1].configSha256, v2.configSha256);
    assert.equal(result.versions[1].files['browser-config.json'], v2.configSha256);
});

test('facade bundle binds exactly one SDK per page and renames every store to the lineage database', async t => {
    const { build } = await helpers();
    const project = await makeProject(t);
    const plan = project.plan('mainnet');
    const { result, outdir } = await bundleApp(project, plan);
    await build.assertZkapiBundleEmission({ plan, metafile: result.metafile, cwd: project.temp, packageRoot: project.temp });

    const outputs = Object.keys(result.metafile.outputs);
    const inputs = new Set(Object.values(result.metafile.outputs).flatMap(output => Object.keys(output.inputs)));
    assert.ok([...inputs].some(input => input.startsWith('oa-zkapi-facade:')), 'facade modules are bundled');
    assert.ok(inputs.has('oa-zkapi-variant:v1') && inputs.has('oa-zkapi-variant:v2'));
    // Separate chunks: no output holds both stores.
    const legacyStore = await fs.realpath(path.join(legacySdkRoot(), 'sdk/services/browserWalletStore.js'));
    const fixtureStore = await fs.realpath(path.join(project.fixtureRoot, 'sdk/services/browserWalletStore.js'));
    const holders = new Map();
    const base = await fs.realpath(project.temp);
    for (const [output, info] of Object.entries(result.metafile.outputs)) {
        for (const input of Object.keys(info.inputs)) {
            const resolved = path.resolve(base, input);
            if (resolved === legacyStore) holders.set('legacy', output);
            if (resolved === fixtureStore) holders.set('fixture', output);
        }
    }
    assert.equal(holders.size, 2);
    assert.notEqual(holders.get('legacy'), holders.get('fixture'));
    // No emitted file may carry the SDK default database name.
    for (const output of outputs.filter(file => file.endsWith('.js'))) {
        const text = await fs.readFile(path.resolve(base, output), 'utf8');
        assert.equal(text.includes(DEFAULT_DATABASE), false, output);
    }
    assert.ok((await fs.readFile(path.resolve(base, holders.get('legacy')), 'utf8')).includes(plan.walletDatabase));
    assert.ok((await fs.readFile(path.resolve(base, holders.get('fixture')), 'utf8')).includes(plan.walletDatabase));

    // build.mjs runs terser over every emitted chunk afterwards; live bindings
    // across chunks must survive it too.
    const { minify } = projectRequire('terser');
    for (const output of outputs.filter(file => file.endsWith('.js'))) {
        const file = path.resolve(base, output);
        const minified = await minify(await fs.readFile(file, 'utf8'), {
            module: true, compress: true, mangle: true, format: { comments: false }
        });
        await fs.writeFile(file, minified.code, 'utf8');
    }

    const bundleFile = path.join(outdir, 'app.js');
    const legacy = runBundle(project, bundleFile, 'run', 'v1');
    assert.deepEqual(legacy.opened, [[plan.walletDatabase, 3]]);
    assert.deepEqual(legacy.outcome.before, { client: 'undefined', runtime: 'undefined', store: 'undefined' });
    assert.equal(legacy.outcome.singleton, true);
    assert.equal(legacy.outcome.instance, true);
    assert.equal(legacy.outcome.sessionHeader, 'string');     // only the legacy root exports it
    assert.equal(legacy.outcome.requestArchive, false);      // subpath exists only in the new SDK
    assert.equal(legacy.outcome.walletEmpty, true);
    assert.equal(legacy.outcome.runtimeKind, 'function');
    assert.equal(legacy.outcome.dynamicImport, 'function');
    assert.deepEqual(legacy.outcome.late, { client: 'object', singleton: true, store: 'function' });

    const successor = runBundle(project, bundleFile, 'run', 'v2');
    assert.deepEqual(successor.opened, [[plan.walletDatabase, 3]]);
    assert.equal(successor.outcome.singleton, true);
    assert.equal(successor.outcome.instance, true);
    assert.equal(successor.outcome.sessionHeader, 'undefined');
    assert.equal(successor.outcome.requestArchive, true);
    assert.equal(successor.outcome.walletEmpty, true);
    assert.equal(successor.outcome.dynamicImport, 'function');
    assert.deepEqual(successor.outcome.late, { client: 'object', singleton: true, store: 'function' });

    // One SDK per page: a second, different variant is refused, an unknown or
    // malformed id is refused, and re-requesting the loaded one is a no-op.
    const { outcome } = runBundle(project, bundleFile, 'conflict');
    assert.deepEqual(outcome, { v2: 'variant_conflict', nope: 'unknown_variant', 7: 'unknown_variant' });
});

test('a build with only a non-canonical live alias (version 1 retired) is faceted too', async t => {
    const { build, facade, registry: registryModule } = await helpers();
    const project = await makeProject(t, { mutateRegistry: registry => {
        const [v1] = registry.versions;
        for (const network of NETWORKS) {
            const pins = registryModule.PROFILE_FILES[`${network}.json`].trusted_deployment;
            v1.networks[network] = {
                status: 'retired', activatedAt: v1.networks[network].activatedAt, retiredAt: '2027-02-01T00:00:00Z',
                tombstone: { deploymentId: pins.deployment_id, chainId: pins.chain_id, vault: pins.contract_address }
            };
        }
    } });
    const plan = project.plan('mainnet');
    assert.equal(plan.mode, 'single');
    assert.deepEqual(plan.versions.map(version => version.id), ['v2']);
    assert.deepEqual(plan.retired.map(entry => entry.id), ['v1']);
    assert.equal(facade.facadeRequired(plan), true);
    assert.deepEqual(build.zkapiBuildPlugins('mainnet', DEPLOYMENT, { plan, packageRoot: project.temp })
        .map(plugin => plugin.name), ['verify-zkapi-recovery-patch', 'oa-zkapi-wallet-namespace', 'oa-zkapi-versions']);
    // Live rows first, the tombstone after; it has no assets and no config hash.
    const table = build.runtimeVersionTable(plan);
    assert.deepEqual(table.map(version => [version.id, version.status, version.assetBase]),
        [['v2', 'active', 'zkapi/v2c/'], ['v1', 'retired', null]]);
    assert.equal(table[1].configSha256, null);
    await build.verifyPlanOnDisk(plan, { repoRoot: project.temp, packageRoot: project.temp });

    // Application code may only name exports a live SDK provides: the legacy
    // root's SESSION_HEADER is gone with it, so the shared entry no longer
    // builds, and the allowlist cannot excuse a name no live SDK exports.
    await assert.rejects(bundleApp(project, plan),
        /SESSION_HEADER of @openanonymity\/zkapi-browser-sdk is not exported by zkapi-sdk-v2c \(v2\)/);
    await fs.rm(project.entry);
    const entry = path.join(project.importerRoot, 'successor-entry.js');
    await fs.writeFile(entry, `
import zkapiClient from '${LEGACY_ALIAS}/client';
import * as store from '${LEGACY_ALIAS}/store';
import { loadVariant } from './versioning/variants.js';

export async function run(id) {
    await loadVariant(id);
    const wallet = await store.readBrowserWallet();
    return { singleton: zkapiClient === globalThis.zkapiClient, walletEmpty: !wallet.state };
}

export async function probe(id) {
    try { await loadVariant(id); return 'loaded'; } catch (error) { return error.code; }
}
`);
    const { result, outdir } = await bundleApp(project, plan, { entry, guardedNames: [] });
    await build.assertZkapiBundleEmission({ plan, metafile: result.metafile, cwd: project.temp, packageRoot: project.temp });
    const legacyStore = await fs.realpath(path.join(legacySdkRoot(), 'sdk/services/browserWalletStore.js'));
    const base = await fs.realpath(project.temp);
    for (const info of Object.values(result.metafile.outputs)) {
        for (const input of Object.keys(info.inputs)) assert.notEqual(path.resolve(base, input), legacyStore);
    }
    const bundleFile = path.join(outdir, 'app.js');
    const loaded = runBundle(project, bundleFile, 'run', 'v2');
    assert.deepEqual(loaded.opened, [[plan.walletDatabase, 3]]);
    assert.deepEqual(loaded.outcome, { singleton: true, walletEmpty: true });
    // The retired version is not a variant: nothing of it is in the bundle.
    assert.equal(runBundle(project, bundleFile, 'probe', 'v1').outcome, 'unknown_variant');
});

test('the real chat/zkapi import graph resolves through the facades against the legacy and a successor SDK', async t => {
    const { build, facade } = await helpers();
    const project = await makeProject(t);
    const importerRoot = path.join(root, 'chat/zkapi');
    // Every subpath the application source imports is exported by some live SDK
    // and is a browser module.
    const { subpaths } = await facade.scanSdkImports(esbuild, importerRoot);
    assert.ok(subpaths.includes('client') && subpaths.includes('runtime') && subpaths.includes('store'));
    assert.equal(subpaths.includes('build'), false);
    // The allowlist for guarded union-only names is empty today, and the
    // application imports no name that is missing from a live SDK: the bundle
    // below only builds because of that (name parity runs in the plugin).
    assert.deepEqual(facade.GUARDED_UNION_ONLY_NAMES, []);
    const scanned = await facade.scanSdkImports(esbuild, importerRoot);
    assert.ok(scanned.names.get('client')?.has('default'));
    assert.ok(scanned.names.get('store')?.has('withBrowserWalletLock'));
    const entry = path.join(project.temp, 'real-entry.js');
    const realVariants = path.join(importerRoot, 'versioning/variants.js');
    const variantsFile = await fs.stat(realVariants).then(() => realVariants, () => project.variantsFile);
    // loadVariant must be used, or the loader (and every variant) is tree-shaken.
    await fs.writeFile(entry, `import ${JSON.stringify(path.join(importerRoot, 'index.js'))};\n`
        + `export { loadVariant } from ${JSON.stringify(variantsFile)};\n`);
    const plan = project.plan('sepolia');
    // guardedNames: null leaves the plugin on its own default, the constant.
    const { result } = await bundleApp(project, plan, {
        entry, absWorkingDir: root, importerRoot, variantsFile, guardedNames: null
    });
    await build.assertZkapiBundleEmission({ plan, metafile: result.metafile, cwd: root, packageRoot: project.temp });
    // Not a vacuous pass: the application's own modules really went through.
    const inputs = new Set(Object.values(result.metafile.outputs).flatMap(output => Object.keys(output.inputs)));
    assert.ok([...inputs].filter(input => input.startsWith('chat/zkapi/')).length >= 10);
    for (const subpath of subpaths) {
        assert.ok(inputs.has(`oa-zkapi-facade:${subpath || '@root'}`), `facade for ${subpath || 'the package root'}`);
    }
    // Nothing of either SDK is reachable except through its variant chunk: an
    // output holding SDK modules also holds that SDK's generated variant.
    for (const info of Object.values(result.metafile.outputs)) {
        const names = Object.keys(info.inputs);
        const legacyHere = names.some(input => /node_modules[\\/]@openanonymity[\\/]zkapi-browser-sdk[\\/]/.test(input));
        const fixtureHere = names.some(input => /node_modules[\\/]zkapi-sdk-v2c[\\/]/.test(input));
        assert.equal(legacyHere && fixtureHere, false, 'both SDKs in one chunk');
        if (legacyHere) assert.ok(names.includes('oa-zkapi-variant:v1'));
        if (fixtureHere) assert.ok(names.includes('oa-zkapi-variant:v2'));
    }
});

test('facade and variant sources are generated from export unions with live bindings', async () => {
    const { facade } = await helpers();
    const source = facade.renderFacadeModule({ names: ['ZkapiClient', 'default', 'extra'] });
    const module = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
    assert.equal(module.default, undefined);
    class Client {}
    const live = { default: 'singleton', ZkapiClient: Client };
    module.__oaBind(live);
    assert.equal(module.default, 'singleton');
    assert.equal(module.ZkapiClient, Client);
    assert.equal(module.extra, undefined);                  // present in another SDK only
    module.__oaBind(undefined);
    assert.equal(module.default, undefined);
    assert.throws(() => facade.renderFacadeModule({ names: ['__oaBind'] }), /reserved/);
    assert.throws(() => facade.renderFacadeModule({ names: ['not valid'] }), /cannot bind/);
    const variant = facade.renderVariantModule({ modules: [{ subpath: '', file: '/x/index.js' }, { subpath: 'client', file: '/x/client.js' }] });
    assert.match(variant, /"@root": m0,/);
    assert.match(variant, /"client": m1/);
    const loader = facade.renderVariantsModule({ subpaths: ['', 'client'], variantIds: ['v1', 'v2'] });
    assert.match(loader, /import\("oa-zkapi-variant:v1"\)/);
    assert.match(loader, /import\("oa-zkapi-variant:v2"\)/);
    assert.match(loader, /variant_conflict/);
    assert.equal(facade.facadeRequired({ mode: 'sdk-default', versions: [] }), false);
});

test('facade refuses SDK imports from outside chat/zkapi and direct imports of a live alias', async t => {
    const { build, facade } = await helpers();
    const project = await makeProject(t);
    const plan = project.plan('mainnet');
    const outside = path.join(project.temp, 'outside.js');
    await fs.writeFile(outside, `import zkapiClient from '${LEGACY_ALIAS}/client';\nexport default zkapiClient;\n`);
    await assert.rejects(bundleApp(project, plan, { entry: outside }), /imports the zkAPI SDK/);

    const direct = path.join(project.importerRoot, 'direct.js');
    await fs.writeFile(direct, `import { readBrowserWallet } from '${FIXTURE_ALIAS}/store';\nexport { readBrowserWallet };\n`);
    await assert.rejects(bundleApp(project, plan, { entry: direct }), /version facade/);
    await fs.rm(direct);

    // A build-time subpath is never a browser module.
    const forbidden = path.join(project.importerRoot, 'forbidden.js');
    await fs.writeFile(forbidden, `import * as sdkBuild from '${LEGACY_ALIAS}/build';\nexport { sdkBuild };\n`);
    await assert.rejects(bundleApp(project, plan, { entry: project.entry }), /not a browser module/);
    await fs.rm(forbidden);
    assert.equal(typeof build.zkapiBuildPlugins, 'function');
    assert.equal(typeof facade.zkapiFacadePlugin, 'function');
});

// ---------------------------------------------------------------------------
// Import scan and name parity
// ---------------------------------------------------------------------------

test('only real import specifiers count: a comment or string mentioning an SDK subpath adds nothing and fails nothing', async t => {
    const { facade } = await helpers();
    const project = await makeProject(t);
    const plan = project.plan('mainnet');
    const before = (await facade.scanSdkImports(esbuild, project.importerRoot)).subpaths;
    assert.deepEqual(before, ['', 'client', 'request-archive', 'runtime', 'store', 'wallet-error']);

    // Every one of these would have been a facade request (and `build` and
    // `package.json` a build failure) under a scan of the raw text.
    await fs.writeFile(path.join(project.importerRoot, 'mentions.js'), [
        `// Never import '${LEGACY_ALIAS}/build' or \`${LEGACY_ALIAS}/package.json\` from chat code.`,
        `/* import { x } from '${LEGACY_ALIAS}/nope'; */`,
        `export const note = "see import('${LEGACY_ALIAS}/build') in the SDK notes";`,
        `export const link = 'https://example.test/${LEGACY_ALIAS}/build'; // '${LEGACY_ALIAS}/build'`,
        `export const template = \`from "${LEGACY_ALIAS}/build"\`;`,
        ''
    ].join('\n'));
    assert.deepEqual((await facade.scanSdkImports(esbuild, project.importerRoot)).subpaths, before);
    const { result } = await bundleApp(project, plan);
    const inputs = new Set(Object.values(result.metafile.outputs).flatMap(output => Object.keys(output.inputs)));
    for (const subpath of ['build', 'package.json', 'nope']) assert.equal(inputs.has(`oa-zkapi-facade:${subpath}`), false, subpath);

    // A REAL import is still refused when no live SDK exports it (the scan is
    // not the only guard: the bundle resolves every specifier against it too).
    const real = path.join(project.importerRoot, 'real-import.js');
    await fs.writeFile(real, `import '${LEGACY_ALIAS}/does-not-exist';\n`);
    await assert.rejects(bundleApp(project, plan), /No live zkAPI SDK exports @openanonymity\/zkapi-browser-sdk\/does-not-exist/);
    await fs.writeFile(real, `export default () => import('${LEGACY_ALIAS}/build');\n`);
    await assert.rejects(bundleApp(project, plan), /@openanonymity\/zkapi-browser-sdk\/build is not a browser module/);
});

test('the import scan reads names from imports, re-exports and namespace members, and files by importer', async t => {
    const { facade } = await helpers();
    const project = await makeProject(t);
    await fs.rm(project.entry);
    await fs.rm(path.join(project.importerRoot, 'late.js'));
    await fs.mkdir(path.join(project.importerRoot, 'components'));
    await fs.writeFile(path.join(project.importerRoot, 'components/view.js'), [
        `// import { commented } from '${LEGACY_ALIAS}/wallet';`,
        `import zkapiClient, { alpha, beta as gamma } from '${LEGACY_ALIAS}/client';`,
        `import * as wallet from '${LEGACY_ALIAS}/wallet';`,
        `export { delta } from '${LEGACY_ALIAS}/runtime';`,
        `export const use = () => [zkapiClient, alpha, gamma, wallet.encodeDeposit, wallet['formatTokenAmount']];`,
        `export const lazy = () => import('${LEGACY_ALIAS}/gas');`,
        ''
    ].join('\n'));
    await fs.writeFile(path.join(project.importerRoot, 'other.mjs'), `import { alpha } from '${LEGACY_ALIAS}/client';\nexport { alpha };\n`);
    const scan = await facade.scanSdkImports(esbuild, project.importerRoot);
    assert.deepEqual(scan.subpaths, ['client', 'gas', 'runtime', 'wallet']);
    const entries = Object.fromEntries([...scan.names].map(([subpath, names]) => [subpath, Object.fromEntries(names)]));
    assert.deepEqual(entries, {
        client: { alpha: ['components/view.js', 'other.mjs'], beta: ['components/view.js'], default: ['components/view.js'] },
        runtime: { delta: ['components/view.js'] },
        wallet: { encodeDeposit: ['components/view.js'], formatTokenAmount: ['components/view.js'] }
    });

    // A file that does not parse fails the scan; it never yields a partial list.
    await fs.writeFile(path.join(project.importerRoot, 'broken.js'), 'export const = ;\n');
    await assert.rejects(facade.scanSdkImports(esbuild, project.importerRoot), /Could not scan the zkAPI SDK imports/);
    await assert.rejects(facade.scanSdkImports(null, project.importerRoot), TypeError);
});

test('name parity is computed per SDK from the import scan and the export lists', async () => {
    const { facade } = await helpers();
    const variants = [
        { id: 'v1', alias: 'legacy-sdk', modules: [{ subpath: '', file: '/l/root' }, { subpath: 'wallet', file: '/l/wallet' }, { subpath: 'client', file: '/l/client' }] },
        { id: 'v2', alias: 'successor-sdk', modules: [{ subpath: 'wallet', file: '/s/wallet' }, { subpath: 'client', file: '/s/client' }, { subpath: 'archive', file: '/s/archive' }] }
    ];
    const exportsByFile = new Map([
        ['/l/root', ['SESSION_HEADER']], ['/l/wallet', ['parseTokenAmount', 'shared']], ['/l/client', ['default']],
        ['/s/wallet', ['shared']], ['/s/client', ['default']], ['/s/archive', ['ARCHIVE_SCHEMA']]
    ]);
    const imported = new Map([
        ['', new Map([['SESSION_HEADER', ['a.js']]])],
        ['archive', new Map([['ARCHIVE_SCHEMA', ['c.js']]])],
        ['client', new Map([['default', ['a.js', 'b.js']]])],
        ['wallet', new Map([['parseTokenAmount', ['b.js']], ['shared', ['b.js']]])]
    ]);
    const found = facade.findUnionOnlyImports({ imported, variants, exportsByFile, guarded: [] });
    assert.deepEqual(found.stale, []);
    assert.deepEqual(found.unavailable.map(entry => [entry.subpath, entry.name, entry.files,
        entry.missing.map(missing => [missing.id, missing.alias, missing.moduleMissing])]), [
        ['', 'SESSION_HEADER', ['a.js'], [['v2', 'successor-sdk', true]]],
        ['archive', 'ARCHIVE_SCHEMA', ['c.js'], [['v1', 'legacy-sdk', true]]],
        ['wallet', 'parseTokenAmount', ['b.js'], [['v2', 'successor-sdk', false]]]
    ]);
    assert.throws(() => facade.assertSdkNameParity({ imported, variants, exportsByFile, guarded: [] }), error => {
        // Each line names the name, the subpath and the SDK that lacks it.
        assert.match(error.message, /parseTokenAmount of @openanonymity\/zkapi-browser-sdk\/wallet is not exported by successor-sdk \(v2\); imported by b\.js/);
        assert.match(error.message, /SESSION_HEADER of @openanonymity\/zkapi-browser-sdk is not exported by successor-sdk \(v2\), which has no such subpath/);
        assert.match(error.message, /ARCHIVE_SCHEMA of @openanonymity\/zkapi-browser-sdk\/archive is not exported by legacy-sdk \(v1\)/);
        assert.doesNotMatch(error.message, /shared|the default export/);
        return true;
    });

    // The allowlist excuses union-only names, each with a reason.
    const reviewed = found.unavailable.map(({ subpath, name }) => ({ subpath, name, reason: 'guarded at its use' }));
    assert.deepEqual(facade.findUnionOnlyImports({ imported, variants, exportsByFile, guarded: reviewed }),
        { unavailable: [], stale: [] });
    facade.assertSdkNameParity({ imported, variants, exportsByFile, guarded: reviewed });

    // An entry that nothing imports, or that every live SDK exports, is stale.
    const idle = [{ subpath: 'wallet', name: 'shared', reason: 'was union-only once' },
        { subpath: 'wallet', name: 'gone', reason: 'no longer imported' }];
    assert.deepEqual(facade.findUnionOnlyImports({ imported, variants, exportsByFile, guarded: [...reviewed, ...idle] }).stale, idle);
    assert.throws(() => facade.assertSdkNameParity({ imported, variants, exportsByFile, guarded: [...reviewed, ...idle] }),
        /not union-only any more[\s\S]*shared of @openanonymity\/zkapi-browser-sdk\/wallet[\s\S]*gone of /);

    // A name no live SDK exports is undefined everywhere: never excused.
    const nowhere = facade.findUnionOnlyImports({
        imported: new Map([['wallet', new Map([['missingEverywhere', ['d.js']]])]]),
        variants, exportsByFile, guarded: [{ subpath: 'wallet', name: 'missingEverywhere', reason: 'x' }]
    });
    assert.deepEqual(nowhere.unavailable.map(entry => entry.name), ['missingEverywhere']);
    // With a single live SDK nothing is union-only, so nothing can be excused.
    const alone = facade.findUnionOnlyImports({
        imported: new Map([['wallet', new Map([['parseTokenAmount', ['d.js']]])]]),
        variants: [variants[1]], exportsByFile, guarded: [{ subpath: 'wallet', name: 'parseTokenAmount', reason: 'x' }]
    });
    assert.deepEqual(alone.unavailable.map(entry => entry.name), ['parseTokenAmount']);

    // Malformed entries are refused outright.
    for (const bad of [[{ subpath: 'wallet', name: 'x' }], [{ subpath: 'wallet', name: 'x', reason: '  ' }],
        [{ name: 'x', reason: 'r' }], [null], 'parseTokenAmount']) {
        assert.throws(() => facade.findUnionOnlyImports({ imported, variants, exportsByFile, guarded: bad }), /guarded/i);
    }
    assert.deepEqual(facade.GUARDED_UNION_ONLY_NAMES, []);
    assert.ok(Object.isFrozen(facade.GUARDED_UNION_ONLY_NAMES));
});

test('a name only some live SDKs export fails the multi build, naming it, its subpath and the SDK', async t => {
    const { build } = await helpers();
    const project = await makeProject(t);
    const plan = project.plan('mainnet');
    // The legacy wallet module exports parseTokenAmount; the successor's does
    // not (the helper moved host-side to chat/zkapi/services/tokenAmount.mjs).
    const amounts = path.join(project.importerRoot, 'amounts.js');
    await fs.writeFile(amounts, `import { parseTokenAmount } from '${LEGACY_ALIAS}/wallet';\nexport const parse = parseTokenAmount;\n`);
    await assert.rejects(bundleApp(project, plan), error => {
        assert.match(error.message, /parseTokenAmount of @openanonymity\/zkapi-browser-sdk\/wallet is not exported by zkapi-sdk-v2c \(v2\); imported by amounts\.js/);
        assert.doesNotMatch(error.message, /not exported by @openanonymity\/zkapi-browser-sdk \(v1\)/);
        return true;
    });
    // A namespace member counts exactly like a named import.
    await fs.writeFile(amounts, `import * as wallet from '${LEGACY_ALIAS}/wallet';\nexport const parse = (value) => wallet.parseTokenAmount(value);\n`);
    await assert.rejects(bundleApp(project, plan),
        /parseTokenAmount of @openanonymity\/zkapi-browser-sdk\/wallet is not exported by zkapi-sdk-v2c \(v2\)/);
    // Both SDKs export it: nothing to report.
    await fs.writeFile(amounts, `import { encodeDeposit } from '${LEGACY_ALIAS}/wallet';\nexport const encode = encodeDeposit;\n`);
    await bundleApp(project, plan);

    // A guarded use is allowed once it is listed with its reason, and only
    // while it stays union-only.
    await fs.writeFile(amounts, [
        `import { parseTokenAmount } from '${LEGACY_ALIAS}/wallet';`,
        'export const parse = typeof parseTokenAmount === "function" ? parseTokenAmount : String;', ''
    ].join('\n'));
    const guarded = [...ENTRY_GUARDED_NAMES, { subpath: 'wallet', name: 'parseTokenAmount', reason: 'guarded with a typeof check' }];
    const { result } = await bundleApp(project, plan, { guardedNames: guarded });
    await build.assertZkapiBundleEmission({ plan, metafile: result.metafile, cwd: project.temp, packageRoot: project.temp });
    await assert.rejects(bundleApp(project, plan, { guardedNames: [...guarded,
        { subpath: 'wallet', name: 'formatTokenAmount', reason: 'nothing imports this any more' }] }),
    /not union-only any more[\s\S]*formatTokenAmount/);
    await assert.rejects(bundleApp(project, plan, { guardedNames: [...ENTRY_GUARDED_NAMES,
        { subpath: 'wallet', name: 'parseTokenAmount' }] }), /needs a subpath, a name and a reason/);

    // A subpath only one SDK ships: its names are missing from the other.
    await fs.writeFile(amounts, `import { REQUEST_ARCHIVE_SCHEMA } from '${LEGACY_ALIAS}/request-archive';\nexport const schema = REQUEST_ARCHIVE_SCHEMA;\n`);
    await assert.rejects(bundleApp(project, plan), error => {
        assert.match(error.message, new RegExp(`REQUEST_ARCHIVE_SCHEMA of ${LEGACY_ALIAS}/request-archive is not exported by ${LEGACY_ALIAS} \\(v1\\), which has no such subpath`));
        return true;
    });
});

// ---------------------------------------------------------------------------
// Wallet database namespace
// ---------------------------------------------------------------------------

test('an unreviewed or altered wallet store fails the bundle instead of opening the default database', async t => {
    const { build } = await helpers();
    const project = await makeProject(t);
    const plan = project.plan('mainnet');

    // A copy of the legacy store outside the reviewed package paths.
    const stray = path.join(project.temp, 'stray');
    await fs.mkdir(stray);
    const strayStore = path.join(stray, 'browserWalletStore.js');
    await fs.copyFile(path.join(legacySdkRoot(), 'sdk/services/browserWalletStore.js'), strayStore);
    const options = { plan, packageRoot: project.temp };
    await assert.rejects(esbuild.build({
        entryPoints: [strayStore], bundle: true, write: false, platform: 'node', format: 'esm', logLevel: 'silent',
        plugins: build.zkapiBuildPlugins('mainnet', DEPLOYMENT, options)
    }), /unreviewed wallet store/);

    // A reviewed path whose bytes differ from the pinned hash.
    const wrongHash = project.plan('mainnet', { registry: (() => {
        const registry = structuredClone(project.registry);
        registry.versions[1].sdk.storeSha256 = 'f'.repeat(64);
        return registry;
    })() });
    await assert.rejects(esbuild.build({
        entryPoints: [path.join(project.fixtureRoot, 'sdk/services/browserWalletStore.js')],
        bundle: true, write: false, platform: 'node', format: 'esm', logLevel: 'silent',
        plugins: build.zkapiBuildPlugins('mainnet', DEPLOYMENT, { plan: wrongHash, packageRoot: project.temp })
    }), /wallet storage namespace/);

    // Pure rename helper: exactly one declaration, shared-slot literals asserted.
    const source = await fs.readFile(path.join(legacySdkRoot(), 'sdk/services/browserWalletStore.js'), 'utf8');
    const reviewed = { sourceSha256: digest(source), database: plan.walletDatabase, databaseVersion: 3 };
    const renamed = build.renameWalletStore(source, reviewed);
    assert.ok(renamed.includes(`const DB_NAME = ${JSON.stringify(plan.walletDatabase)};`));
    assert.equal(renamed.includes(`'${DEFAULT_DATABASE}'`), false);
    assert.throws(() => build.renameWalletStore(source, { ...reviewed, databaseVersion: 4 }), /database version 3, not 4/);
    assert.throws(() => build.renameWalletStore(`${source}\n`, reviewed), /wallet storage namespace/);
    const altered = source.replace("'zkapi-wallet:active-runtime'", "'zkapi-wallet:other-lock'");
    assert.throws(() => build.renameWalletStore(altered, { ...reviewed, sourceSha256: digest(altered) }), /lock name/);
    const channel = source.replace("new BroadcastChannel('zkapi-wallet:active-runtime')", "new BroadcastChannel('zkapi-wallet:other')");
    assert.throws(() => build.renameWalletStore(channel, { ...reviewed, sourceSha256: digest(channel) }), /channel name/);
    const bumped = source.replace('const DB_VERSION = 3;', 'const DB_VERSION = 4;');
    assert.throws(() => build.renameWalletStore(bumped, { ...reviewed, sourceSha256: digest(bumped) }), /database version 4, not 3/);
    const doubled = `${source}\nconst DB_VERSION = 3;\n`;
    assert.throws(() => build.renameWalletStore(doubled, { ...reviewed, sourceSha256: digest(doubled) }), /exactly once/);
});

test('both reviewed stores declare the shared database, version, lock and channel', async t => {
    const { registry: registryModule } = await helpers();
    const project = await makeProject(t);
    for (const store of [path.join(legacySdkRoot(), 'sdk/services/browserWalletStore.js'),
        path.join(project.fixtureRoot, 'sdk/services/browserWalletStore.js')]) {
        const declared = registryModule.readWalletStoreDeclarations(await fs.readFile(store, 'utf8'));
        assert.deepEqual(declared, {
            database: DEFAULT_DATABASE, version: 3,
            lock: 'zkapi-wallet:active-runtime', channel: 'zkapi-wallet:active-runtime'
        });
    }
    assert.equal(registryModule.WALLET_LOCK_NAME, 'zkapi-wallet:active-runtime');
    // The build's mirror of the runtime constant must not drift from the probe's.
    const holdings = await fs.stat(path.join(root, 'chat/zkapi/versioning/walletHoldings.mjs')).then(() => true, () => false);
    if (holdings) {
        const module = await load('chat/zkapi/versioning/walletHoldings.mjs');
        assert.equal(module.WALLET_LOCK_NAME, registryModule.WALLET_LOCK_NAME);
    }
});

test('assertZkapiBundleEmission rejects the default database name and a missing store', async t => {
    const { build } = await helpers();
    const project = await makeProject(t);
    const plan = project.plan('mainnet');
    const directory = path.join(project.temp, 'emission');
    await fs.mkdir(directory);
    await fs.writeFile(path.join(directory, 'leak.js'), `open("${DEFAULT_DATABASE}");`);
    await assert.rejects(build.assertZkapiBundleEmission({
        plan, cwd: project.temp, packageRoot: project.temp,
        metafile: { outputs: { 'emission/leak.js': { inputs: {} } } }
    }), /default zkAPI wallet database/);
    await fs.writeFile(path.join(directory, 'clean.js'), 'export {};');
    await assert.rejects(build.assertZkapiBundleEmission({
        plan, cwd: project.temp, packageRoot: project.temp,
        metafile: { outputs: { 'emission/clean.js': { inputs: {} } } }
    }), /wallet store is not part of the bundle/);
    // sdk-default is exempt, as is a ticket-only build.
    await build.assertZkapiBundleEmission({ plan: null, metafile: { outputs: {} } });
    await build.assertZkapiBundleEmission({ plan: { mode: 'sdk-default' }, metafile: { outputs: {} } });
});

test('the default database name is traced to the module that carries it, and a tree-shaken mention fails nothing', async t => {
    const { build } = await helpers();
    const project = await makeProject(t);
    const plan = project.plan('mainnet');
    const emission = { plan, cwd: project.temp, packageRoot: project.temp };
    const entry = path.join(project.importerRoot, 'host-entry.js');

    // Application code that names the SDK default database, but whose mention
    // is tree-shaken (never used): nothing is emitted, nothing fails.
    const mention = path.join(project.importerRoot, 'legacy-name.js');
    await fs.writeFile(mention, `export const safe = 1;\nexport const unusedLegacy = '${DEFAULT_DATABASE}';\n`);
    await fs.writeFile(entry, "import { loadVariant } from './versioning/variants.js';\nimport { safe } from './legacy-name.js';\nexport { loadVariant, safe };\n");
    const shaken = await bundleApp(project, plan, { entry });
    await build.assertZkapiBundleEmission({ ...emission, metafile: shaken.result.metafile });

    // The same mention actually reaching the bundle still fails closed, but the
    // failure is about that file: no SDK store is blamed for application code.
    await fs.writeFile(entry, "import { loadVariant } from './versioning/variants.js';\nimport { unusedLegacy } from './legacy-name.js';\nexport { loadVariant, unusedLegacy };\n");
    const reached = await bundleApp(project, plan, { entry });
    await assert.rejects(build.assertZkapiBundleEmission({ ...emission, metafile: reached.result.metafile }), error => {
        assert.match(error.message, /names the default zkAPI wallet database \("zkapi-browser-wallet-v1"\) in chat\/zkapi\/legacy-name\.js/);
        assert.doesNotMatch(error.message, /would open|browserWalletStore|zkAPI v\d SDK/);
        return true;
    });

    // An SDK module that is not the store and carries the name is an SDK
    // module opening the default database, named as such.
    const stray = await makeProject(t, { mutateFixture: async directory => {
        await fs.appendFile(path.join(directory, 'sdk/services/zkapiGas.mjs'), `\nexport const LEGACY_DATABASE = '${DEFAULT_DATABASE}';\n`);
    } });
    await fs.writeFile(path.join(stray.importerRoot, 'gas-user.js'),
        `import { bufferedGasLimit } from '${LEGACY_ALIAS}/gas';\nexport { bufferedGasLimit };\n`);
    const strayPlan = stray.plan('mainnet');
    const bundled = await bundleApp(stray, strayPlan);
    await assert.rejects(build.assertZkapiBundleEmission({
        plan: strayPlan, metafile: bundled.result.metafile, cwd: stray.temp, packageRoot: stray.temp
    }), error => {
        assert.match(error.message, /would open the default zkAPI wallet database: node_modules\/zkapi-sdk-v2c\/sdk\/services\/zkapiGas\.mjs \(zkAPI v2 SDK\)/);
        return true;
    });
});

test('a rewritten store sharing a chunk with host code is not blamed; an unrewritten store is', async t => {
    const { build } = await helpers();
    const project = await makeProject(t);
    const plan = project.plan('mainnet');
    const base = await fs.realpath(project.temp);
    const store = await fs.realpath(path.join(legacySdkRoot(), 'sdk/services/browserWalletStore.js'));
    const relative = file => path.relative(base, file);
    const directory = path.join(project.temp, 'emission');
    await fs.mkdir(path.join(directory, 'host'), { recursive: true });
    await fs.writeFile(path.join(directory, 'host/names.js'), `export const OLD = '${DEFAULT_DATABASE}';\n`);
    const emissionFor = async (name, text) => {
        await fs.writeFile(path.join(directory, name), text);
        return `emission/${name}`;
    };
    const holdsFixtureStore = {
        [relative(await fs.realpath(path.join(project.fixtureRoot, 'sdk/services/browserWalletStore.js')))]: { bytesInOutput: 90 }
    };

    // The store was rewritten (the chunk carries the lineage name); the name
    // comes from the host module beside it.
    const shared = await emissionFor('shared.js', `open("${plan.walletDatabase}");var OLD="${DEFAULT_DATABASE}";`);
    await assert.rejects(build.assertZkapiBundleEmission({ plan, cwd: project.temp, packageRoot: project.temp, metafile: { outputs: {
        [shared]: { inputs: { ...holdsFixtureStore, [relative(store)]: { bytesInOutput: 120 }, 'emission/host/names.js': { bytesInOutput: 40 } } }
    } } }), error => {
        assert.match(error.message, /names the default zkAPI wallet database .* in emission\/host\/names\.js\./);
        assert.doesNotMatch(error.message, /browserWalletStore|SDK\)/);
        return true;
    });

    // The store kept its default declaration: the SDK store is named.
    const unrewritten = await emissionFor('unrewritten.js', `const DB_NAME="${DEFAULT_DATABASE}";`);
    await assert.rejects(build.assertZkapiBundleEmission({ plan, cwd: project.temp, packageRoot: project.temp, metafile: { outputs: {
        [unrewritten]: { inputs: { [relative(store)]: { bytesInOutput: 120 } } }
    } } }), /would open the default zkAPI wallet database: .*browserWalletStore\.js \(zkAPI v1 SDK\) still carries its name/);
});

// ---------------------------------------------------------------------------
// Failure cases
// ---------------------------------------------------------------------------

test('a live version with a missing package fails loudly and leaves the output untouched', async t => {
    const { build } = await helpers();
    const project = await makeProject(t);
    const plan = project.plan('mainnet');
    await fs.rm(project.fixtureRoot, { recursive: true, force: true });
    await assert.rejects(build.verifyPlanOnDisk(plan, { repoRoot: project.temp, packageRoot: project.temp }),
        /zkapi-sdk-v2c is not installed/);
    const outDir = path.join(project.temp, 'untouched');
    await fs.mkdir(path.join(outDir, 'zkapi'), { recursive: true });
    await fs.writeFile(path.join(outDir, 'zkapi/sentinel.txt'), 'last good build');
    await assert.rejects(build.buildZkapiAssets({
        network: 'mainnet', deployment: DEPLOYMENT, repoRoot: project.temp, outDir, build: esbuild.build, plan, packageRoot: project.temp
    }), /zkapi-sdk-v2c is not installed/);
    assert.equal(await fs.readFile(path.join(outDir, 'zkapi/sentinel.txt'), 'utf8'), 'last good build');
});

test('a pending version needs no package, dependency or lock entry', async t => {
    const { build, facade } = await helpers();
    const project = await makeProject(t, { kind: 'dormant', withFixturePackage: false });
    await assert.rejects(fs.stat(path.join(project.temp, 'node_modules', FIXTURE_ALIAS)), { code: 'ENOENT' });
    for (const network of NETWORKS) {
        const plan = project.plan(network);
        assert.equal(plan.mode, 'single');
        assert.deepEqual(plan.versions.map(version => version.id), ['v1']);
        await build.verifyPlanOnDisk(plan, { repoRoot: project.temp, packageRoot: project.temp });
        assert.equal(facade.facadeRequired(plan), false);
    }
    const outDir = path.join(project.temp, 'out');
    const result = await build.buildZkapiAssets({
        network: 'sepolia', deployment: DEPLOYMENT, repoRoot: project.temp, outDir, build: esbuild.build,
        plan: project.plan('sepolia'), packageRoot: project.temp
    });
    assert.deepEqual(result.versions.map(version => version.id), ['v1']);
    await assert.rejects(fs.stat(path.join(outDir, 'zkapi/v2c')), { code: 'ENOENT' });
    const provenance = await build.zkapiBuildProvenance({
        network: 'sepolia', repoRoot: project.temp, outDir, sdkAssets: result, plan: project.plan('sepolia')
    });
    assert.deepEqual(provenance.versions.map(version => version.id), ['v1']);
    assert.equal(provenance.depositTarget, 'v1');
});

test('on-disk verification refuses a package that is not exactly what the registry pins', async t => {
    const { build } = await helpers();
    const refused = async (options, pattern, network = 'mainnet') => {
        const project = await makeProject(t, options);
        await assert.rejects(build.verifyPlanOnDisk(project.plan(network), { repoRoot: project.temp, packageRoot: project.temp }), pattern);
    };

    await refused({ mutatePackage: manifest => { manifest.dependencies[FIXTURE_ALIAS] = 'github:other/zkapi#main'; } },
        /package\.json must pin zkapi-sdk-v2c/);
    await refused({ mutateLock: lock => { lock.packages[`node_modules/${FIXTURE_ALIAS}`].resolved = 'git+ssh://x/zkapi.git#main'; } },
        /immutable Git commit/);
    await refused({ mutateLock: lock => {
        lock.packages[`node_modules/${FIXTURE_ALIAS}`].resolved = `git+ssh://x/zkapi.git#${'1'.repeat(40)}`;
    } }, /package-lock\.json resolves zkapi-sdk-v2c/);
    await refused({ mutateLock: lock => { delete lock.packages[`node_modules/${FIXTURE_ALIAS}`]; } }, /immutable Git commit/);
    await refused({ mutateRegistry: registry => { registry.versions[1].sdk.storeSha256 = 'a'.repeat(64); } },
        /wallet storage namespace/);

    // A store that matches its pin but changed a shared-slot literal.
    const mutateStore = (from, to) => async directory => {
        const file = path.join(directory, 'sdk/services/browserWalletStore.js');
        await fs.writeFile(file, (await fs.readFile(file, 'utf8')).replace(from, to));
    };
    await refused({ mutateFixture: mutateStore('const DB_VERSION = 3;', 'const DB_VERSION = 4;') }, /database version 4, not 3/);
    await refused({ mutateFixture: mutateStore("'zkapi-wallet:active-runtime';", "'zkapi-wallet:another';") }, /lock name/);
    await refused({ mutateFixture: mutateStore("new BroadcastChannel('zkapi-wallet:active-runtime')",
        "new BroadcastChannel('zkapi-wallet:another')") }, /channel name/);

    // The SDK itself ships a placeholder profile: its own ./build would refuse it.
    await refused({ mutateInstalled: async directory => {
        const file = path.join(directory, 'sdk/assets/config/mainnet.json');
        const config = JSON.parse(await fs.readFile(file, 'utf8'));
        config.trusted_deployment.deployment_status = 'not_deployed';
        await fs.writeFile(file, JSON.stringify(config, null, 2));
    } }, /not_deployed/);

    // A reviewed profile whose proving key hash is not the shipped key.
    await refused({ mutateRegistry: registry => {
        registry.versions[1].networks.mainnet.config.trusted_deployment.request_proving_key_sha256 = 'c'.repeat(64);
    } }, /request proving key/);

});

// ---------------------------------------------------------------------------
// Proof setups
// ---------------------------------------------------------------------------
//
// The host accepts the ceremony setup (mpc-1) and the single-party development
// setup (dev) by one rule on both networks, and reports the second one: a
// warning per live version in the build and `proofSetup` in the provenance.
// The SDK package's own build accepts a development bundle for mainnet since
// 4b955d9 (branch v0.2 of the local zkapi repository), and the fixture SDK
// follows it. The 82c8504 snapshot refused one (code
// development_setup_on_mainnet); a revision before 4b955d9 can still be pinned
// by mistake, so that refusal is kept covered through an explicit variant of
// the fixture, passed on with the host's explanation of whose rule it is.

// Turns the temporary copy of the fixture SDK into a development bundle: the
// WebAssembly glue reports the dev setup, both package profiles pin it, and the
// package's own refresh script recomputes the manifest the way the SDK's asset
// sync does. Only the temporary copy is touched, never the hash-pinned fixture.
async function makeDevelopmentBundle(directory) {
    const glue = path.join(directory, 'sdk/wasm/zkapi_browser.js');
    const source = await fs.readFile(glue, 'utf8');
    assert.ok(source.includes("return 'mpc-1';"), 'the fixture glue reports the ceremony setup');
    await fs.writeFile(glue, source.replace("return 'mpc-1';", "return 'dev';"));
    for (const network of NETWORKS) {
        const file = path.join(directory, `sdk/assets/config/${network}.json`);
        const config = JSON.parse(await fs.readFile(file, 'utf8'));
        config.trusted_deployment.setup_id = 'dev';
        await fs.writeFile(file, `${JSON.stringify(config, null, 2)}\n`);
    }
    execFileSync(process.execPath, [path.join(directory, 'refresh-assets.mjs')], { encoding: 'utf8', cwd: directory });
    const manifest = JSON.parse(await fs.readFile(path.join(directory, 'sdk/assets/manifest.json'), 'utf8'));
    assert.equal(manifest.setupId, 'dev');
}

// The same, for an installed package that does not export
// assertDeployableProfile: the on-disk verification has nothing of the SDK's to
// ask, so the SDK's own build refusal is only met when the assets are emitted.
async function makeDevelopmentBundleWithoutExportedCheck(directory) {
    await makePreRelaxationDevelopmentBundle(directory);
    const file = path.join(directory, 'sdk/build.mjs');
    const source = await fs.readFile(file, 'utf8');
    assert.ok(source.includes('export function assertDeployableProfile('));
    await fs.writeFile(file, source.replace('export function assertDeployableProfile(', 'function assertDeployableProfile('));
}

// The 82c8504 clause of assertDeployableProfile, put back into the temporary
// copy of the fixture build (never the pinned fixture): a development bundle is
// refused for chain 1 with code development_setup_on_mainnet.
async function insertPreRelaxationMainnetRefusal(directory) {
    const file = path.join(directory, 'sdk/build.mjs');
    const source = await fs.readFile(file, 'utf8');
    const anchor = '    if (trusted.exit_concession !== 1) {';
    assert.equal(source.split(anchor).length, 2, 'the fixture build checks the concession exit once');
    const clause = [
        '    if (Number(trusted.chain_id) === 1 && manifest.setupId !== \'mpc-1\') {',
        '        throw codedError(\'development_setup_on_mainnet\',',
        '            `A mainnet profile needs the mpc-1 setup, not ${manifest.setupId}.`);',
        '    }',
        ''
    ].join('\n');
    await fs.writeFile(file, source.replace(anchor, `${clause}${anchor}`));
}

async function makePreRelaxationDevelopmentBundle(directory) {
    await makeDevelopmentBundle(directory);
    await insertPreRelaxationMainnetRefusal(directory);
}

const developmentOptions = { mutateFixture: makeDevelopmentBundle };
const preRelaxationOptions = { mutateFixture: makePreRelaxationDevelopmentBundle };

test('both proof setups pass the same rules on both networks; any other setup, or a mismatch, is refused', async t => {
    const { build } = await helpers();
    const verified = project => network =>
        build.verifyPlanOnDisk(project.plan(network), { repoRoot: project.temp, packageRoot: project.temp });

    // mpc-1 bundle and profile: both networks plan and verify.
    const ceremony = await makeProject(t);
    for (const network of NETWORKS) {
        const plan = ceremony.plan(network);
        assert.equal(plan.versions[1].profile.trusted_deployment.setup_id, 'mpc-1');
        await verified(ceremony)(network);
    }

    // dev bundle and profile: both networks plan (the profile rules do not
    // know a network) and verify; the SDK accepts a dev bundle for chain 1
    // too. A revision before 4b955d9 refuses mainnet; that is its own test.
    const development = await makeProject(t, developmentOptions);
    for (const network of NETWORKS) {
        assert.equal(development.plan(network).versions[1].profile.trusted_deployment.setup_id, 'dev');
        await verified(development)(network);
    }

    // The two refusals of a pairing that disagrees, on both networks: the
    // profile pins one setup and the installed bundle was built for the other.
    // The asset manifest's file hashes do not cover `setupId`, so an SDK bump
    // that swaps the bundle is exactly this; it is refused before any output.
    for (const network of NETWORKS) {
        const profileDevBundleCeremony = await makeProject(t, { mutateRegistry: registry => {
            registry.versions[1].networks[network].config.trusted_deployment.setup_id = 'dev';
        } });
        await assert.rejects(verified(profileDevBundleCeremony)(network), error => {
            assert.match(error.message, /SDK bundle is built for the mpc-1 proof setup, but the profile pins the dev proof setup/);
            return true;
        });

        const profileCeremonyBundleDev = await makeProject(t, { ...developmentOptions, mutateRegistry: registry => {
            registry.versions[1].networks[network].config.trusted_deployment.setup_id = 'mpc-1';
        } });
        await assert.rejects(verified(profileCeremonyBundleDev)(network), error => {
            assert.match(error.message, /SDK bundle is built for the dev proof setup, but the profile pins the mpc-1 proof setup/);
            return true;
        });
    }

    // A bundle manifest naming another setup, or none at all (the key is
    // always passed: a missing value is never "not asked"), is refused.
    for (const [label, edit] of [
        ['another', manifest => { manifest.setupId = 'rehearsal'; }],
        ['none', manifest => { delete manifest.setupId; }]
    ]) {
        const project = await makeProject(t, { mutateInstalled: async directory => {
            const file = path.join(directory, 'sdk/assets/manifest.json');
            const manifest = JSON.parse(await fs.readFile(file, 'utf8'));
            edit(manifest);
            await fs.writeFile(file, JSON.stringify(manifest, null, 2));
        } });
        for (const network of NETWORKS) {
            await assert.rejects(verified(project)(network), /SDK bundle must be built for an accepted proof setup \(mpc-1 or dev\)/, label);
        }
    }

    // A profile that pins any other setup never forms a plan, whatever the
    // bundle is, on either network.
    for (const network of NETWORKS) {
        for (const setup of ['rehearsal', 'mpc-2', '']) {
            const project = await makeProject(t, { mutateRegistry: registry => {
                registry.versions[1].networks[network].config.trusted_deployment.setup_id = setup;
            } });
            assert.throws(() => project.plan(network), error => error.code === 'profile'
                && /must pin an accepted proof setup \(mpc-1 or dev\)/.test(error.message), `${network} ${setup}`);
        }
    }

    // The retired per-entry switch is an unknown field on any entry, so a
    // stale registry cannot quietly keep it.
    for (const network of NETWORKS) {
        for (const value of [true, false]) {
            const project = await makeProject(t, { mutateRegistry: registry => {
                registry.versions[1].networks[network].allowDevSetup = value;
            } });
            assert.throws(() => project.plan(network), error => error.code === 'schema'
                && /unknown field "allowDevSetup"/.test(error.message));
        }
    }
});

test('a live version on the development setup is warned about once per build; mpc-1 and dormant builds are not', async t => {
    const { build, registry: registryModule, fixtures } = await helpers();
    const emit = async (project, network, label) => {
        const warnings = [];
        const outDir = path.join(project.temp, 'out', label);
        const result = await build.buildZkapiAssets({
            network, deployment: DEPLOYMENT, repoRoot: project.temp, outDir, build: esbuild.build, plan: project.plan(network),
            packageRoot: project.temp, warn: message => warnings.push(message)
        });
        return { warnings, result, outDir };
    };

    const development = await makeProject(t, developmentOptions);
    const sepolia = await emit(development, 'sepolia', 'development-sepolia');
    assert.deepEqual(sepolia.result.versions.map(version => version.id), ['v1', 'v2']);
    assert.equal(sepolia.warnings.length, 1, sepolia.warnings.join('\n'));
    const [warning] = sepolia.warnings;
    // It names the version, the network and the consequence, and says who
    // decided: nothing in it reads as a refusal.
    assert.match(warning, /^\[build\] WARNING: zkAPI v2 on sepolia is built on the single-party development proof setup \(dev\)\./);
    assert.match(warning, /Whoever generated its keys can forge proofs and take every deposit in this vault/);
    assert.match(warning, /cannot be switched to mpc-1 later/);
    assert.match(warning, /Accepted by owner decision; see docs\/ZKAPI_VERSIONING\.md\./);
    assert.doesNotMatch(warning, /\b(refus|reject|fail)/i);

    // Mainnet is the same bundle and the SDK builds it (4b955d9): the same one
    // warning, naming mainnet, and the emitted profile is the chain 1 one.
    const mainnet = await emit(development, 'mainnet', 'development-mainnet');
    assert.deepEqual(mainnet.result.versions.map(version => version.id), ['v1', 'v2']);
    assert.equal(mainnet.warnings.length, 1, mainnet.warnings.join('\n'));
    assert.match(mainnet.warnings[0], /^\[build\] WARNING: zkAPI v2 on mainnet is built on the single-party development proof setup \(dev\)\./);
    assert.doesNotMatch(mainnet.warnings[0], /\b(refus|reject|fail)/i);
    assert.equal(mainnet.result.versions[1].config.trusted_deployment.chain_id, 1);
    assert.equal(mainnet.result.versions[1].manifest.setupId, 'dev');

    // A ceremony bundle gives none, on either network.
    const ceremony = await makeProject(t);
    for (const network of NETWORKS) {
        assert.deepEqual((await emit(ceremony, network, `ceremony-${network}`)).warnings, [], network);
    }

    // Nor does the shipped registry where it is dormant (mainnet: version 1
    // names no setup); its activated Sepolia row is on the development setup
    // by the owner's decision and warns exactly once.
    const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'oa-dormant-warning-'));
    t.after(() => fs.rm(temporary, { recursive: true, force: true }));
    for (const network of NETWORKS) {
        const warnings = [];
        await build.buildZkapiAssets({
            network, deployment: DEPLOYMENT, repoRoot: root, outDir: path.join(temporary, network), build: esbuild.build,
            warn: message => warnings.push(message)
        });
        if (network === 'sepolia') {
            assert.equal(warnings.length, 2, warnings.join('\n'));
            assert.match(warnings[1], /WARNING: zkAPI v3 on sepolia/);
            assert.match(warnings[0], /^\[build\] WARNING: zkAPI v2 on sepolia is built on the single-party development proof setup \(dev\)\./);
        } else {
            assert.deepEqual(warnings, [], network);
        }
    }

    // The default sink is console.warn: the build prints it without a caller
    // having to pass anything.
    const printed = [];
    t.mock.method(console, 'warn', (...args) => { printed.push(args.join(' ')); });
    await build.buildZkapiAssets({
        network: 'sepolia', deployment: DEPLOYMENT, repoRoot: development.temp, outDir: path.join(development.temp, 'out', 'console'),
        build: esbuild.build, plan: development.plan('sepolia'), packageRoot: development.temp
    });
    assert.equal(printed.length, 1, printed.join('\n'));
    assert.match(printed[0], /WARNING: zkAPI v2 on sepolia/);

    // The plan reports a development version on mainnet like on Sepolia: the
    // host's rule has no network in it.
    for (const network of NETWORKS) {
        assert.deepEqual(build.developmentSetupVersions(development.plan(network)), [{ versionId: 'v2', network }], network);
        assert.deepEqual(build.developmentSetupVersions(ceremony.plan(network)), [], network);
    }

    // An exit-only version is live and still on its keys: its warning is
    // printed by the build as well, and a plan reports it.
    const exitOnly = await makeProject(t, { kind: 'rollback', ...developmentOptions });
    const exitOnlyPlan = exitOnly.plan('sepolia');
    assert.deepEqual(exitOnlyPlan.versions.map(version => `${version.id}:${version.status}`), ['v1:active', 'v2:exit-only']);
    assert.deepEqual(build.developmentSetupVersions(exitOnlyPlan), [{ versionId: 'v2', network: 'sepolia' }]);
    assert.deepEqual(build.developmentSetupVersions(exitOnly.plan('mainnet')), [{ versionId: 'v2', network: 'mainnet' }]);
    const exitOnlyBuild = await emit(exitOnly, 'sepolia', 'exit-only-sepolia');
    assert.equal(exitOnlyBuild.warnings.length, 1, exitOnlyBuild.warnings.join('\n'));
    assert.match(exitOnlyBuild.warnings[0], /^\[build\] WARNING: zkAPI v2 on sepolia is built on the single-party development proof setup/);

    // The selection is per live version and network, from the plan and from
    // the registry alone: one network on dev, the other on mpc-1; a row that is
    // only pending is not live and says nothing.
    const mixed = fixtures.mutated(fixtures.activatedRegistry(), registry => {
        registry.versions[1].networks.sepolia.config.trusted_deployment.setup_id = 'dev';
    });
    const plan = network => registryModule.planFromRegistry({
        network, deployment: DEPLOYMENT, registry: mixed, profiles: registryModule.PROFILE_FILES, wired: fixtures.ALL_WIRED
    });
    assert.deepEqual(build.developmentSetupVersions(plan('sepolia')), [{ versionId: 'v2', network: 'sepolia' }]);
    assert.deepEqual(build.developmentSetupVersions(plan('mainnet')), []);
    assert.deepEqual(registryModule.developmentSetupRows(mixed), [{ versionId: 'v2', network: 'sepolia' }]);
    assert.deepEqual(registryModule.developmentSetupRows(fixtures.validRegistry()), []);
    assert.deepEqual(registryModule.developmentSetupRows(fixtures.activatedRegistry()), []);
    assert.deepEqual(build.developmentSetupVersions(null), []);
    assert.deepEqual(build.developmentSetupVersions(registryModule.planFromRegistry({ network: 'mainnet' })), []);
    // An exit-only version is live and is still reported.
    const rolledBack = fixtures.mutated(fixtures.rollbackRegistry(), registry => {
        registry.versions[1].networks.mainnet.config.trusted_deployment.setup_id = 'dev';
    });
    assert.deepEqual(registryModule.developmentSetupRows(rolledBack), [{ versionId: 'v2', network: 'mainnet' }]);
});

test('the build provenance names the proof setup of every version, additively', async t => {
    const { build } = await helpers();
    const existingKeys = ['id', 'status', 'adapter', 'circuitId', 'deploymentId', 'configSha256', 'sdk', 'publicPath',
        'proxyPath', 'walletStorage'];
    const provenanceOf = async (project, network, { withAssets = true } = {}) => {
        const plan = project.plan(network);
        const outDir = path.join(project.temp, 'out', `${network}-${withAssets}`);
        const result = await build.buildZkapiAssets({
            network, deployment: DEPLOYMENT, repoRoot: project.temp, outDir, build: esbuild.build, plan,
            packageRoot: project.temp, warn() {}
        });
        return build.zkapiBuildProvenance({
            network, repoRoot: project.temp, outDir, sdkAssets: withAssets ? result : undefined, plan
        });
    };

    const ceremony = await makeProject(t);
    const development = await makeProject(t, developmentOptions);
    for (const network of NETWORKS) {
        for (const [project, setupId, proofSetup] of [[ceremony, 'mpc-1', 'ceremony'], [development, 'dev', 'development']]) {
            // From what was emitted, and from the reviewed pin alone.
            for (const withAssets of [true, false]) {
                const provenance = await provenanceOf(project, network, { withAssets });
                const [first, second] = provenance.versions;
                // The legacy family names no setup: null, not a made-up id.
                assert.equal(first.setupId, null);
                assert.equal(first.proofSetup, null);
                assert.equal(second.setupId, setupId);
                assert.equal(second.proofSetup, proofSetup);
                // Additive: the existing keys come first, unchanged and in
                // their order, then the two new ones.
                for (const entry of provenance.versions) {
                    assert.deepEqual(Object.keys(entry), [...existingKeys, 'setupId', 'proofSetup']);
                }
            }
        }
    }
});

test('a revision before 4b955d9 refuses mainnet on a development bundle, passed on with the host\'s explanation', async t => {
    const { build } = await helpers();
    const SDK_MESSAGE = 'A mainnet profile needs the mpc-1 setup, not dev.';
    const explained = error => {
        assert.equal(error.code, 'development_setup_on_mainnet');
        // The host's words say whose rule this is and what can be done about it...
        assert.match(error.message, /this host accepts the single-party development proof setup \(dev\) on every network/);
        assert.match(error.message, /this SDK revision's own build refuses it for mainnet/);
        assert.match(error.message, /does not bypass or patch that check/);
        // It says that upstream already dropped the rule and where, so the way
        // out is a newer pin and not a request to the SDK's authors.
        assert.match(error.message, /Upstream dropped that rule in ethereum\/zkapi \(branch v0\.2, commit 4b955d9, sdk\/build\.mjs\): pin a revision that includes it/);
        // A vault already on dev keys cannot take the mpc-1 bundle in place:
        // that way out is named for what it costs, not offered as a swap.
        assert.match(error.message, /pinning an SDK bundle built for the mpc-1 setup instead means a new vault and a user migration/);
        assert.match(error.message, /a vault deployed on dev keys cannot be switched to mpc-1/);
        // ...and the SDK's own refusal stays reachable, unchanged.
        assert.equal(error.cause.code, 'development_setup_on_mainnet');
        assert.equal(error.cause.message, SDK_MESSAGE);
        assert.ok(error.message.includes(SDK_MESSAGE));
        return true;
    };

    // The on-disk verification asks the SDK's exported check first.
    const checked = await makeProject(t, preRelaxationOptions);
    const plan = checked.plan('mainnet');
    await assert.rejects(build.verifyPlanOnDisk(plan, { repoRoot: checked.temp, packageRoot: checked.temp }), error => {
        assert.match(error.message, /^\[build\] zkAPI v2 \(zkapi-sdk-v2c\): /);
        return explained(error);
    });
    // A full asset build stops there too: nothing is touched and nothing is
    // printed (the warning is for a build that goes on).
    const warnings = [];
    const outDir = path.join(checked.temp, 'untouched');
    await fs.mkdir(path.join(outDir, 'zkapi'), { recursive: true });
    await fs.writeFile(path.join(outDir, 'zkapi/sentinel.txt'), 'last good build');
    await assert.rejects(build.buildZkapiAssets({
        network: 'mainnet', deployment: DEPLOYMENT, repoRoot: checked.temp, outDir, build: esbuild.build, plan,
        packageRoot: checked.temp, warn: message => warnings.push(message)
    }), explained);
    assert.equal(await fs.readFile(path.join(outDir, 'zkapi/sentinel.txt'), 'utf8'), 'last good build');
    assert.deepEqual(warnings, []);

    // A package with no exported check is only refused by its build, at
    // emission; the same words come out of that path. The refusal is the
    // SDK's: the host emitted version 1 and then let the SDK's build decide.
    const unexported = await makeProject(t, { mutateFixture: makeDevelopmentBundleWithoutExportedCheck });
    const emitPlan = unexported.plan('mainnet');
    await build.verifyPlanOnDisk(emitPlan, { repoRoot: unexported.temp, packageRoot: unexported.temp });
    const emitDirectory = path.join(unexported.temp, 'emit');
    await assert.rejects(build.buildZkapiAssets({
        network: 'mainnet', deployment: DEPLOYMENT, repoRoot: unexported.temp, outDir: emitDirectory, build: esbuild.build,
        plan: emitPlan, packageRoot: unexported.temp, warn() {}
    }), error => {
        assert.match(error.message, /^\[build\] zkAPI v2 \(zkapi-sdk-v2c\): /);
        return explained(error);
    });
    await assert.rejects(fs.stat(path.join(emitDirectory, 'zkapi/v2c')), { code: 'ENOENT' });

    // The same bundle on Sepolia is accepted by the same build: the rule that
    // differs is the SDK's, for chain 1, not the host's.
    const sepolia = unexported.plan('sepolia');
    const built = await build.buildZkapiAssets({
        network: 'sepolia', deployment: DEPLOYMENT, repoRoot: unexported.temp, outDir: path.join(unexported.temp, 'sepolia'),
        build: esbuild.build, plan: sepolia, packageRoot: unexported.temp, warn() {}
    });
    assert.equal(built.versions[1].manifest.setupId, 'dev');
    assert.equal(built.versions[1].config.trusted_deployment.setup_id, 'dev');
});

// Both callers must pass the bundle's setup: a caller that left the key out
// would silently switch the bundle rule off (a missing key is "not asked").
// verifyPlanOnDisk reads it from the installed manifest (covered above); the
// emission step reads it from what the SDK's own build reports, which the
// SDK's build is the only party able to change, so it is exercised here with a
// build whose report names another accepted setup, an unknown one, and none.
test('the emission step passes the setup the SDK build reports, whatever it is', async t => {
    const { build } = await helpers();
    const reported = async (setupId, pattern) => {
        const project = await makeProject(t, { mutateFixture: async directory => {
            const file = path.join(directory, 'sdk/build.mjs');
            const source = await fs.readFile(file, 'utf8');
            assert.ok(source.includes('setupId: provenance.setupId,'));
            await fs.writeFile(file, source.replace('setupId: provenance.setupId,', `setupId: ${setupId},`));
        } });
        // The installed files are intact, so the on-disk verification passes
        // and only the emission step can see the (reported) setup.
        const plan = project.plan('mainnet');
        await build.verifyPlanOnDisk(plan, { repoRoot: project.temp, packageRoot: project.temp });
        const outDir = path.join(project.temp, 'out');
        await assert.rejects(build.buildZkapiAssets({
            network: 'mainnet', deployment: DEPLOYMENT, repoRoot: project.temp, outDir, build: esbuild.build, plan,
            packageRoot: project.temp, warn() {}
        }), pattern);
    };
    // An accepted setup that is not the profile's, an unknown one, and none.
    await reported("'dev'", /SDK bundle is built for the dev proof setup, but the profile pins the mpc-1 proof setup/);
    await reported("'rehearsal'", /SDK bundle must be built for an accepted proof setup \(mpc-1 or dev\)/);
    await reported('undefined', /SDK bundle must be built for an accepted proof setup \(mpc-1 or dev\)/);
});

test('the registry check reports a live development setup and still accepts it', async t => {
    const { fixtures } = await helpers();
    const cli = path.join(root, 'scripts/zkapi-registry-cli.mjs');
    const patch = (await load('patches/zkapi-browser-sdk-wallet-recovery.mjs')).default;
    // The activation with the reviewed recovery patch the SDK half needs, so
    // only the setup is under test.
    const reviewed = registry => fixtures.mutated(registry, copy => {
        const row = copy.versions[1];
        row.sdk.revision = patch.revision;
        row.sdk.source = `github:OpenAnonymity/zkapi#${patch.revision}`;
        row.sdk.patches = ['wallet-recovery-v1'];
        row.gate.recoveryReview = { revision: patch.revision, verdict: 'patched', patch: 'wallet-recovery-v1' };
    });
    const withPatch = (setup, networks = NETWORKS) => fixtures.mutated(reviewed(fixtures.activatedRegistry()), registry => {
        for (const network of networks) registry.versions[1].networks[network].config.trusted_deployment.setup_id = setup;
    });
    const repository = await fs.mkdtemp(path.join(os.tmpdir(), 'oa-registry-setup-'));
    t.after(() => fs.rm(repository, { recursive: true, force: true }));
    const git = (...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.test', ...args],
        { cwd: repository, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    git('init', '-q');
    const directory = path.join(repository, 'deployments/zkapi');
    await fs.mkdir(directory, { recursive: true });
    for (const [name, profile] of Object.entries(fixtures.fixtureProfiles())) {
        await fs.writeFile(path.join(directory, name), `${JSON.stringify(profile, null, 2)}\n`);
    }
    const file = path.join(directory, 'registry.json');
    const write = registry => fs.writeFile(file, `${JSON.stringify(registry, null, 2)}\n`);
    const check = ({ base = 'HEAD', extra = [] } = {}) => {
        const result = spawnSync(process.execPath, [cli, 'check', '--base', base, '--file', file, ...extra], { encoding: 'utf8' });
        return { code: result.status, out: result.stdout, err: result.stderr };
    };
    const warningsOf = result => result.err.trim().split('\n').filter(Boolean);

    // The first activation: the registry file does not exist at the base ref,
    // so there is nothing to compare. The setup is still reported, and the
    // check still succeeds.
    git('add', '.');
    git('commit', '-q', '-m', 'profiles only');
    await write(withPatch('dev'));
    const first = check();
    assert.equal(first.code, 0, first.err);
    assert.match(first.out, /does not exist at HEAD\. Nothing to compare\./);
    const firstLines = warningsOf(first);
    assert.equal(firstLines.length, 2, first.err);
    assert.match(firstLines[0], /^\[zkapi-registry\] WARNING: zkAPI v2 on mainnet is built on the single-party development proof setup \(dev\)\./);
    assert.match(firstLines[1], /^\[zkapi-registry\] WARNING: zkAPI v2 on sepolia is built on the single-party development proof setup \(dev\)\./);

    await write(fixtures.validRegistry());
    git('add', '.');
    git('commit', '-q', '-m', 'v2 pending');
    git('tag', 'pending');

    // A development profile on both networks: accepted, one warning each.
    await write(withPatch('dev'));
    const development = check();
    assert.equal(development.code, 0, development.err);
    assert.match(development.out, /valid forward move/);
    const lines = warningsOf(development);
    assert.equal(lines.length, 2, development.err);
    assert.match(lines[0], /^\[zkapi-registry\] WARNING: zkAPI v2 on mainnet is built on the single-party development proof setup \(dev\)\./);
    assert.match(lines[1], /^\[zkapi-registry\] WARNING: zkAPI v2 on sepolia is built on the single-party development proof setup \(dev\)\./);

    // One network on dev: one warning. The ceremony setup: none.
    await write(withPatch('dev', ['sepolia']));
    // (mainnet keeps the fixture's own mpc-1 profile)
    const single = check();
    assert.equal(single.code, 0, single.err);
    assert.equal(warningsOf(single).length, 1, single.err);
    assert.match(single.err, /zkAPI v2 on sepolia/);
    await write(withPatch('mpc-1'));
    const ceremony = check();
    assert.equal(ceremony.code, 0, ceremony.err);
    assert.equal(ceremony.err, '');
    // Anything else is still refused, with the accepted ids named.
    await write(withPatch('rehearsal'));
    const unknown = check();
    assert.equal(unknown.code, 1);
    assert.match(unknown.err, /must pin an accepted proof setup \(mpc-1 or dev\)/);

    // The vault of a live version cannot change its keys in place: a
    // development vault does not become an mpc-1 vault by editing its profile,
    // in either direction, and neither does any other proof pin. The same
    // deployment id and vault with other keys is a new version.
    await write(withPatch('dev'));
    git('add', '.');
    git('commit', '-q', '-m', 'v2 active on dev');
    await write(withPatch('mpc-1'));
    const flipped = check();
    assert.equal(flipped.code, 1, flipped.out);
    assert.match(flipped.err, /identity_changed/);
    assert.match(flipped.err, /v2 on mainnet changed its proof setup or key pins \(setup_id\)/);
    assert.match(flipped.err, /a different vault, which is a new version/);
    const overridden = check({ extra: ['--allow-identity-change'] });
    assert.equal(overridden.code, 0, overridden.err);
    await write(fixtures.mutated(withPatch('dev'), registry => {
        registry.versions[1].networks.sepolia.config.trusted_deployment.request_verifying_key_sha256 = 'e'.repeat(64);
    }));
    const rekeyed = check();
    assert.equal(rekeyed.code, 1, rekeyed.out);
    assert.match(rekeyed.err, /v2 on sepolia changed its proof setup or key pins \(request_verifying_key_sha256\)/);
    // The committed profile itself is a valid move from itself.
    await write(withPatch('dev'));
    assert.equal(check().code, 0);
    // The override is documented where an operator will look.
    const help = spawnSync(process.execPath, [cli, '--help'], { encoding: 'utf8' });
    assert.match(help.stdout, /proof setup or proof key pins/);
    assert.match(help.stdout, /--package-root/);

    // An SDK revision before 4b955d9 refuses a development bundle for mainnet.
    // When the version's package is installed, the check says so, so the
    // operator does not learn it from the build at deploy time. The exit code
    // stays what it was: the host accepts the setup.
    const mainnetRefusal = lines => lines.filter(line => /on mainnet: this host accepts/.test(line));

    // The SDK the fixture follows (4b955d9) accepts it: the two setup lines
    // and nothing about a refusal.
    const accepting = await makeProject(t, developmentOptions);
    await write(reviewed(accepting.registry));
    const accepted = check({ base: 'pending', extra: ['--package-root', accepting.temp] });
    assert.equal(accepted.code, 0, accepted.err);
    assert.match(accepted.out, /valid forward move/);
    const acceptedLines = warningsOf(accepted);
    assert.equal(acceptedLines.length, 2, accepted.err);
    assert.deepEqual(mainnetRefusal(acceptedLines), []);
    assert.doesNotMatch(accepted.err, /development_setup_on_mainnet|stops at that refusal/);

    const probed = await makeProject(t, preRelaxationOptions);
    await write(reviewed(probed.registry));
    const refused = check({ base: 'pending', extra: ['--package-root', probed.temp] });
    assert.equal(refused.code, 0, refused.err);
    assert.match(refused.out, /valid forward move/);
    const refusedLines = warningsOf(refused);
    assert.equal(refusedLines.length, 3, refused.err);
    assert.match(refusedLines[0], /WARNING: zkAPI v2 on mainnet is built on the single-party development proof setup/);
    assert.match(refusedLines[1], /WARNING: zkAPI v2 on sepolia is built on the single-party development proof setup/);
    assert.deepEqual(mainnetRefusal(refusedLines), [refusedLines[2]]);
    assert.match(refusedLines[2], /^\[zkapi-registry\] WARNING: zkAPI v2 on mainnet: this host accepts the single-party development proof setup \(dev\) on every network, but this SDK revision's own build refuses it for mainnet \(development_setup_on_mainnet: A mainnet profile needs the mpc-1 setup, not dev\.\)/);
    assert.match(refusedLines[2], /Upstream dropped that rule in ethereum\/zkapi \(branch v0\.2, commit 4b955d9, sdk\/build\.mjs\): pin a revision that includes it/);
    assert.match(refusedLines[2], /A build of this registry for that network stops at that refusal\./);
    // Sepolia is the same bundle and the SDK accepts it: no second line for it.
    assert.doesNotMatch(refusedLines[2], /sepolia/);

    // Without the package (this repository has no zkapi-sdk-v2c installed),
    // with a package that exports no check, and with a ceremony bundle, the
    // probe has nothing to add.
    const alone = check({ base: 'pending' });
    assert.equal(alone.code, 0, alone.err);
    assert.equal(warningsOf(alone).length, 2, alone.err);
    const unexported = await makeProject(t, { mutateFixture: makeDevelopmentBundleWithoutExportedCheck });
    await write(reviewed(unexported.registry));
    const unchecked = check({ base: 'pending', extra: ['--package-root', unexported.temp] });
    assert.equal(unchecked.code, 0, unchecked.err);
    assert.equal(warningsOf(unchecked).length, 2, unchecked.err);
    const ceremonyBundle = await makeProject(t);
    await write(reviewed(ceremonyBundle.registry));
    const none = check({ base: 'pending', extra: ['--package-root', ceremonyBundle.temp] });
    assert.equal(none.code, 0, none.err);
    assert.equal(none.err, '');
});

test('registry rules still gate every plan: activation without its wiring is not buildable', async t => {
    const { registry: registryModule, fixtures } = await helpers();
    const registry = fixtures.activatedRegistry();
    const { WIRED } = await load('chat/zkapi/versioning/wiring.mjs');
    const { requiredWiring } = (await load('chat/zkapi/versioning/adapters/concessionV1.mjs')).default;
    const plan = wired => registryModule.planFromRegistry({
        network: 'mainnet', deployment: DEPLOYMENT, registry, profiles: registryModule.PROFILE_FILES, wired
    });
    // Nothing wired, or all but one behavior wired, is refused by the plan.
    for (const wired of [new Set(), new Set(requiredWiring.slice(1))]) {
        assert.throws(() => plan(wired), error => /gate_wiring/.test(error.message) && error.code === 'gate_wiring');
    }
    // The checked-in set lists every behavior the family requires, and it is
    // the default of a plan that is not told otherwise.
    assert.ok(requiredWiring.every(name => WIRED.has(name)));
    assert.equal(plan(WIRED).mode, 'multi');
    assert.equal(registryModule.planFromRegistry({
        network: 'mainnet', deployment: DEPLOYMENT, registry, profiles: registryModule.PROFILE_FILES
    }).mode, 'multi');
    // The one rule that is not the validator's: a live row of a family that
    // lists a behavior with a half only the SDK can provide needs a reviewed
    // patch that covers it. A fixture row carries none, so a fixture plan is
    // held to it only when asked, and the shipped registry always is
    // (test/zkapi/zkapi-recovery-coverage.test.mjs plans a copy of it).
    assert.throws(() => registryModule.planFromRegistry({
        network: 'mainnet', deployment: DEPLOYMENT, registry, profiles: registryModule.PROFILE_FILES,
        recoveryPatches: registryModule.reviewedRecoveryPatches()
    }), error => error.code === 'recovery_patch_coverage' && /recovery_patch_coverage/.test(error.message));
    void t;
});

test('a verification receipt lets the same plan skip the repeat read, and nothing else does', async t => {
    const { build } = await helpers();
    const project = await makeProject(t);
    const plan = project.plan('mainnet');
    const roots = { repoRoot: project.temp, packageRoot: project.temp };
    const receipt = await build.verifyPlanOnDisk(plan, roots);
    assert.equal(typeof receipt, 'object');
    assert.ok(receipt !== null && Object.isFrozen(receipt));
    assert.equal(await build.verifyPlanOnDisk({ mode: 'sdk-default' }, roots), null);

    // Break something only verification reads: the lock's pin of the successor.
    const lockFile = path.join(project.temp, 'package-lock.json');
    const lock = JSON.parse(await fs.readFile(lockFile, 'utf8'));
    lock.packages[`node_modules/${FIXTURE_ALIAS}`].resolved = 'git+ssh://x/zkapi.git#main';
    await fs.writeFile(lockFile, JSON.stringify(lock, null, 2));
    const refused = /immutable Git commit/;

    // Verified in full without a receipt, so a standalone caller is not weakened.
    await assert.rejects(build.verifyPlanOnDisk(plan, roots), refused);
    // The receipt of this plan and these roots is honoured as is.
    assert.equal(await build.verifyPlanOnDisk(plan, { ...roots, verified: receipt }), receipt);
    // It vouches for nothing else: another plan, a plan edited since, other
    // roots, a lock path, an object that is not a receipt, or a forged one.
    await assert.rejects(build.verifyPlanOnDisk(project.plan('sepolia'), { ...roots, verified: receipt }), refused);
    const edited = structuredClone(plan);
    edited.versions[1].sdk.storeSha256 = 'e'.repeat(64);
    await assert.rejects(build.verifyPlanOnDisk(edited, { ...roots, verified: receipt }), /wallet storage namespace|immutable Git commit/);
    await assert.rejects(build.verifyPlanOnDisk(plan, { ...roots, lockPath: lockFile, packageRoot: path.join(project.temp, 'node_modules'), verified: receipt }), refused);
    await assert.rejects(build.verifyPlanOnDisk(plan, { ...roots, verified: {} }), refused);
    await assert.rejects(build.verifyPlanOnDisk(plan, { ...roots, verified: Object.freeze({}) }), refused);
    await assert.rejects(build.verifyPlanOnDisk(plan, { ...roots, verified: true }), refused);
    await assert.rejects(build.verifyPlanOnDisk(plan, { ...roots, verified: structuredClone(receipt) }), refused);

    // buildZkapiAssets: a standalone call verifies in full and leaves the
    // output untouched; the receipt from scripts/build.mjs skips the repeat.
    const outDir = path.join(project.temp, 'out');
    const options = { network: 'mainnet', deployment: DEPLOYMENT, repoRoot: project.temp, outDir, build: esbuild.build, plan, packageRoot: project.temp };
    await assert.rejects(build.buildZkapiAssets(options), refused);
    await assert.rejects(fs.stat(path.join(outDir, 'zkapi')), { code: 'ENOENT' });
    await assert.rejects(build.buildZkapiAssets({ ...options, verified: { forged: true } }), refused);
    const result = await build.buildZkapiAssets({ ...options, verified: receipt });
    assert.deepEqual(result.versions.map(version => version.id), ['v1', 'v2']);
});

// ---------------------------------------------------------------------------
// Patches, generator, ignore rules, CLI
// ---------------------------------------------------------------------------

test('the recovery patch list is per version and skips versions without one', async t => {
    const { patch } = await helpers();
    assert.equal(await patch.patchSdkVersion({ alias: FIXTURE_ALIAS, source: 'x', patches: [] }), 0);
    await assert.rejects(patch.patchSdkVersion({ alias: FIXTURE_ALIAS, source: 'github:x/y#1', patches: ['not-a-patch'] }), /Unknown zkAPI SDK patch/);
    const provenance = patch.zkapiSdkPatchProvenance('wallet-recovery-v1');
    assert.equal(provenance.name, 'wallet-recovery-v1');
    assert.deepEqual(patch.zkapiSdkPatchProvenance(), provenance);
    assert.throws(() => patch.zkapiSdkPatchProvenance('nope'), /Unknown zkAPI SDK patch/);
    // A registered version that is installed and lists no patch is untouched;
    // a missing install is skipped, never fatal.
    const logs = [];
    assert.equal(await patch.patchRegisteredSdks(root, {
        rows: [{ id: 'v9', sdk: { alias: 'not-installed-anywhere', source: 'github:x/y#' + 'a'.repeat(40), patches: ['wallet-recovery-v1'] },
            networks: { mainnet: { status: 'active' }, sepolia: { status: 'active' } } },
        { id: 'v8', sdk: { alias: 'also-missing', patches: ['wallet-recovery-v1'] }, networks: { mainnet: { status: 'pending' } } }],
        log: message => logs.push(message)
    }), 0);
    assert.equal(logs.length, 1);
    assert.match(logs[0], /not installed/);
    void t;
});

test('the bundled Vercel generator imports only node built-ins and routes every live version', async t => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'oa-bundled-generator-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const outfile = path.join(directory, '.vercel/vercel-temp.mjs');
    const bundled = await esbuild.build({
        entryPoints: [path.join(root, 'scripts/generate-zkapi-vercel-config.mjs')], outfile, bundle: true, platform: 'node',
        format: 'esm', target: 'node20.20', packages: 'external', metafile: true, logLevel: 'silent'
    });
    const specifiers = Object.values(bundled.metafile.outputs).flatMap(output => output.imports.map(entry => entry.path));
    assert.ok(specifiers.length > 0);
    assert.deepEqual(specifiers.filter(specifier => !specifier.startsWith('node:')), []);
    // Bare SDK or esbuild specifiers must not appear even as strings in imports.
    const text = await fs.readFile(outfile, 'utf8');
    assert.equal(/from\s+['"]esbuild['"]/.test(text), false);
    assert.equal(/import\s*\(\s*['"]@openanonymity/.test(text), false);
    await fs.writeFile(outfile, `import.meta.resolve = () => { throw new Error('SDK package resolution is unavailable'); };\n${text}`);
    const result = execFileSync(process.execPath, ['--input-type=module', '-e', `
        import { buildZkapiVercelConfig } from ${JSON.stringify(pathToFileURL(outfile).href)};
        console.log(JSON.stringify(['mainnet', 'sepolia'].map(network => buildZkapiVercelConfig({
            network, deployment: ${JSON.stringify(DEPLOYMENT)}, orgOrigin: 'https://org-staging.openanonymity.ai'
        }).rewrites.map(rewrite => rewrite.source))));
    `], { cwd: directory, encoding: 'utf8' });
    const [mainnetSources, sepoliaSources] = JSON.parse(result);
    for (const sources of [mainnetSources, sepoliaSources]) assert.equal(sources[0], '/zkapi-deployment/:path*');
    assert.deepEqual(mainnetSources.filter(source => source.startsWith('/zkapi-deployment')), ['/zkapi-deployment/:path*']);
    assert.deepEqual(sepoliaSources.filter(source => source.startsWith('/zkapi-deployment')),
        ['/zkapi-deployment/:path*', '/zkapi-deployment-v2c/v0.2/:path*', '/zkapi-deployment-v3/v0.3/:path*']);
});

test('Vercel source uploads allow exactly the reviewed registry file besides the pins', async t => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'oa-registry-allowlist-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    await fs.copyFile('.vercelignore', path.join(directory, '.vercelignore'));
    execFileSync('git', ['init', '-q', directory]);
    const included = ['deployments/zkapi/registry.json', 'deployments/zkapi/mainnet.json', 'deployments/zkapi/sepolia.json',
        'patches/zkapi-browser-sdk-wallet-recovery.mjs', 'patches/zkapi-browser-sdk-v2c-recovery.mjs',
        'patches/zkapi-browser-sdk-proof-cache.mjs', 'patches/zkapi-browser-sdk-provider-verification.mjs',
        'scripts/zkapi-registry-cli.mjs', 'scripts/zkapiRegistry.mjs',
        'scripts/zkapiFacadePlugin.mjs', 'chat/zkapi/versioning/registryModel.mjs'];
    const excluded = ['deployments/zkapi/registry.json.bak', 'deployments/zkapi/other-registry.json',
        'deployments/zkapi/nested/registry.json', 'patches/zkapi-browser-sdk-unreviewed.mjs'];
    const ignored = execFileSync('git', ['-c', 'core.excludesFile=.vercelignore', 'check-ignore', '--no-index', '--stdin'], {
        cwd: directory, input: [...included, ...excluded].join('\n') + '\n', encoding: 'utf8'
    }).trim().split('\n');
    assert.deepEqual(ignored, excluded);
});

test('registry CLI prints the store hash and refuses a backwards lifecycle move', async t => {
    const { fixtures } = await helpers();
    const cli = path.join(root, 'scripts/zkapi-registry-cli.mjs');
    const run = (args, options = {}) => {
        try {
            return { code: 0, out: execFileSync(process.execPath, [cli, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options }) };
        } catch (error) {
            return { code: error.status, out: `${error.stdout}${error.stderr}` };
        }
    };
    const storeSource = await fs.readFile(path.join(legacySdkRoot(), 'sdk/services/browserWalletStore.js'));
    assert.equal(run(['store-hash', LEGACY_ALIAS]).out.trim(), digest(storeSource));
    // Started through a symlink (a linked checkout), it still runs: a check
    // that quietly does nothing would pass every registry change.
    const linkDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'oa-registry-cli-link-'));
    t.after(() => fs.rm(linkDirectory, { recursive: true, force: true }));
    await fs.symlink(path.join(root, 'scripts'), path.join(linkDirectory, 'scripts'), 'dir');
    const linked = execFileSync(process.execPath, [path.join(linkDirectory, 'scripts/zkapi-registry-cli.mjs'), 'store-hash', LEGACY_ALIAS],
        { encoding: 'utf8' });
    assert.equal(linked.trim(), digest(storeSource));
    assert.equal(run(['store-hash']).code, 1);
    assert.equal(run(['store-hash', 'not-installed-anywhere']).code, 1);
    assert.equal(run(['check']).code, 1);
    assert.equal(run(['check', '--base', '--output=x']).code, 1);

    // A repository holding two registries: v1 active, then v1 exit-only (valid
    // with v2 still pending); going back is a revert and must fail.
    const repository = await fs.mkdtemp(path.join(os.tmpdir(), 'oa-registry-cli-'));
    t.after(() => fs.rm(repository, { recursive: true, force: true }));
    const git = (...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.test', ...args],
        { cwd: repository, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    git('init', '-q');
    const file = path.join(repository, 'deployments/zkapi/registry.json');
    await fs.mkdir(path.dirname(file), { recursive: true });
    const write = registry => fs.writeFile(file, `${JSON.stringify(registry, null, 2)}\n`);
    // The reviewed profile files a version-1 row names are committed with it:
    // the check compares identity with what the base ref held.
    for (const [name, profile] of Object.entries(fixtures.fixtureProfiles())) {
        await fs.writeFile(path.join(path.dirname(file), name), `${JSON.stringify(profile, null, 2)}\n`);
    }
    await write(fixtures.validRegistry());
    git('add', '.');
    git('commit', '-q', '-m', 'v1 active');
    // Forward: v1 exit-only (deposits unavailable) is a legitimate next state.
    await write(fixtures.partialRevertRegistry());
    const forward = run(['check', '--base', 'HEAD', '--file', file]);
    assert.equal(forward.code, 0, forward.out);
    assert.match(forward.out, /valid forward move/);
    git('add', '.');
    git('commit', '-q', '-m', 'v1 exit-only');
    // Backward: the same file as before is a revert of that move.
    await write(fixtures.validRegistry());
    const backward = run(['check', '--base', 'HEAD', '--file', file]);
    assert.equal(backward.code, 1);
    assert.match(backward.out, /forward_only|moved back/);
    assert.equal(run(['check', '--base', 'no-such-ref', '--file', file]).code, 1);
});

// Two note-bound deployments side by side (a family that needs no protocol
// wiring), so a retirement can be checked end to end with the real validator:
// v1 closed and v2 taking deposits.
function twoNoteBoundRegistry(fixtures) {
    const registry = fixtures.validRegistry();
    const v1 = registry.versions[0];
    const v2 = JSON.parse(JSON.stringify(v1));
    Object.assign(v2, { id: 'v2', ordinal: 2, label: 'Version 2', publicPath: '/zkapi/v2n/', proxyPath: '/zkapi-deployment-v2n/' });
    v2.sdk = { ...v2.sdk, alias: 'zkapi-sdk-v2n' };
    for (const network of NETWORKS) {
        v2.networks[network] = {
            status: 'active',
            activatedAt: '2026-11-01T00:00:00Z',
            config: fixtures.noteBoundProfile(network, config => {
                const origin = `https://zkapi-v2n-${network}.example.test`;
                config.deployment_manifest_url = `${origin}/config.json`;
                config.allowed_deployment_manifest_urls = [`${origin}/config.json`];
                config.trusted_deployment.deployment_id = `zkapi-native-eth-${network}-note-bound-v1-second`;
                config.trusted_deployment.contract_address = `0x${'a'.repeat(40)}`;
                config.trusted_deployment.protocol_server_url = origin;
                config.trusted_deployment.indexer_url = origin;
                config.deployment_api_proxy_path = '/zkapi-deployment-v2n/';
            })
        };
        v1.networks[network] = {
            status: 'exit-only', activatedAt: '2026-09-30T00:00:00Z',
            depositsClosedSince: '2026-11-01T00:00:00Z', profile: `${network}.json`
        };
    }
    registry.versions = [v1, v2];
    return registry;
}

test('registry CLI holds a version\'s identity across a retirement and a pin change', async t => {
    const { fixtures } = await helpers();
    const cli = path.join(root, 'scripts/zkapi-registry-cli.mjs');
    const run = args => {
        try {
            return { code: 0, out: execFileSync(process.execPath, [cli, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) };
        } catch (error) {
            return { code: error.status, out: `${error.stdout}${error.stderr}` };
        }
    };
    // The override is documented where an operator will look.
    const help = run(['--help']);
    assert.equal(help.code, 0);
    assert.match(help.out, /--allow-identity-change/);
    assert.match(help.out, /tombstone/);
    assert.match(run([]).out, /--allow-identity-change/, 'the usage line names it too');

    const makeRepository = async ({ withProfiles }) => {
        const repository = await fs.mkdtemp(path.join(os.tmpdir(), 'oa-registry-identity-'));
        t.after(() => fs.rm(repository, { recursive: true, force: true }));
        const git = (...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.test', ...args],
            { cwd: repository, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
        git('init', '-q');
        const directory = path.join(repository, 'deployments/zkapi');
        await fs.mkdir(directory, { recursive: true });
        if (withProfiles) {
            for (const [name, profile] of Object.entries(fixtures.fixtureProfiles())) {
                await fs.writeFile(path.join(directory, name), `${JSON.stringify(profile, null, 2)}\n`);
            }
        }
        const file = path.join(directory, 'registry.json');
        const write = registry => fs.writeFile(file, `${JSON.stringify(registry, null, 2)}\n`);
        await write(twoNoteBoundRegistry(fixtures));
        git('add', '.');
        git('commit', '-q', '-m', 'v1 closed, v2 active');
        return { directory, file, write, git };
    };
    const retire = tombstone => fixtures.mutated(twoNoteBoundRegistry(fixtures), registry => {
        for (const network of NETWORKS) {
            const entry = registry.versions[0].networks[network];
            delete entry.profile;
            delete entry.depositsClosedSince;
            entry.status = 'retired';
            entry.retiredAt = '2027-01-15T00:00:00Z';
            entry.tombstone = tombstone(network);
        }
    });
    const named = network => {
        const pins = fixtures.noteBoundProfile(network).trusted_deployment;
        return { deploymentId: pins.deployment_id, chainId: pins.chain_id, vault: pins.contract_address };
    };

    const project = await makeRepository({ withProfiles: true });
    // The committed state is itself a valid forward move from itself.
    assert.equal(run(['check', '--base', 'HEAD', '--file', project.file]).code, 0);

    // Retiring v1 with the tombstone of the deployment it had passes...
    await project.write(retire(named));
    const retired = run(['check', '--base', 'HEAD', '--file', project.file]);
    assert.equal(retired.code, 0, retired.out);
    assert.match(retired.out, /valid forward move/);
    // ...and with a tombstone that names something else, it does not, whatever
    // the override says: nothing would recognize the leftovers afterwards.
    await project.write(retire(network => ({ ...named(network), deploymentId: 'typo-deployment' })));
    const typo = run(['check', '--base', 'HEAD', '--file', project.file]);
    assert.equal(typo.code, 1);
    assert.match(typo.out, /tombstone_mismatch/);
    assert.equal(run(['check', '--base', 'HEAD', '--file', project.file, '--allow-identity-change']).code, 1);
    await project.write(retire(network => ({ ...named(network), vault: `0x${'1'.repeat(40)}` })));
    assert.match(run(['check', '--base', 'HEAD', '--file', project.file]).out, /tombstone_mismatch/);

    // A version that stays live keeps its deployment, chain, vault and pins.
    await project.write(fixtures.mutated(twoNoteBoundRegistry(fixtures), registry => {
        for (const network of NETWORKS) {
            registry.versions[1].networks[network].config.trusted_deployment.deployment_id = 'another-deployment';
        }
    }));
    const swapped = run(['check', '--base', 'HEAD', '--file', project.file]);
    assert.equal(swapped.code, 1);
    assert.match(swapped.out, /identity_changed/);
    const allowed = run(['check', '--base', 'HEAD', '--file', project.file, '--allow-identity-change']);
    assert.equal(allowed.code, 0, allowed.out);
    assert.match(allowed.out, /skipped \(--allow-identity-change\)/);
    // An SDK pin bump is an identity change too.
    await project.write(fixtures.mutated(twoNoteBoundRegistry(fixtures), registry => {
        registry.versions[1].sdk.storeSha256 = 'd'.repeat(64);
    }));
    assert.match(run(['check', '--base', 'HEAD', '--file', project.file]).out, /identity_changed/);
    assert.equal(run(['check', '--base', 'HEAD', '--file', project.file, '--allow-identity-change']).code, 0);

    // A profile FILE edited in place under an unchanged registry is the same
    // swap: the base ref's copy of the file is what the identity is read from.
    await project.write(twoNoteBoundRegistry(fixtures));
    const edited = fixtures.noteBoundProfile('mainnet');
    edited.trusted_deployment.deployment_id = 'edited-in-place';
    await fs.writeFile(path.join(project.directory, 'mainnet.json'), `${JSON.stringify(edited, null, 2)}\n`);
    const inPlace = run(['check', '--base', 'HEAD', '--file', project.file]);
    assert.equal(inPlace.code, 1);
    assert.match(inPlace.out, /identity_changed/);
    assert.match(inPlace.out, /v1 on mainnet/);
    assert.equal(run(['check', '--base', 'HEAD', '--file', project.file, '--allow-identity-change']).code, 0);

    // A base ref that does not carry the profile files cannot be compared
    // against them: the check fails instead of passing blind.
    const bare = await makeRepository({ withProfiles: false });
    const unverified = run(['check', '--base', 'HEAD', '--file', bare.file]);
    assert.equal(unverified.code, 1);
    assert.match(unverified.out, /identity_unverified/);
    assert.match(unverified.out, /was not provided/);
});
