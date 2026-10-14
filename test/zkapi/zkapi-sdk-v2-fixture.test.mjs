// Pins the test-only fixture that stands in for the successor zkAPI SDK
// (test/fixtures/zkapi-sdk-v2-fixture). The build and plugin tests rely on its
// identity: the real exports map and export names, the store's declaration
// lines and SHA-256, the real ./build contract over tiny deterministic assets,
// and deployed-looking profiles whose key hashes equal the emitted bytes.
// Plain Node, no browser shims; the fixture is only ever copied or imported.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const fixture = path.join(root, 'test/fixtures/zkapi-sdk-v2-fixture');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const fixtureFile = relative => path.join(fixture, relative);
const readFixture = relative => fs.readFileSync(fixtureFile(relative));
const readFixtureJson = relative => JSON.parse(readFixture(relative).toString('utf8'));
const importFrom = (base, relative) => import(pathToFileURL(path.join(base, relative)).href);

const readme = readFixture('README.md').toString('utf8');
const pinned = Object.fromEntries([...readme.matchAll(/^([a-z0-9-]+): ([0-9a-f]{64})$/gm)]
    .map(match => [match[1], match[2]]));

function node(args, options = {}) {
    // Hermetic: never compare against a real SDK that happens to be configured.
    return spawnSync(process.execPath, args, {
        encoding: 'utf8', env: { ...process.env, ZKAPI_REAL_SDK_ROOT: '' }, ...options
    });
}

// A copy laid out as an installed package, plus the refresh script beside it
// for tests that edit a pinned asset and need the manifest recomputed.
function installedCopy(t) {
    // Real path: the SDK build compares string paths and Node resolves module
    // URLs through symlinks (os.tmpdir() is one on macOS).
    const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'zkapi-sdk-fixture-')));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const packageRoot = path.join(directory, 'node_modules', 'zkapi-sdk-v2c');
    fs.mkdirSync(packageRoot, { recursive: true });
    fs.cpSync(fixtureFile('sdk'), path.join(packageRoot, 'sdk'), { recursive: true });
    fs.copyFileSync(fixtureFile('package.json'), path.join(packageRoot, 'package.json'));
    fs.copyFileSync(fixtureFile('refresh-assets.mjs'), path.join(packageRoot, 'refresh-assets.mjs'));
    return { directory, packageRoot, outDir: path.join(directory, 'dist', 'zkapi', 'v2c') };
}

function editConfig(packageRoot, network, edit) {
    const file = path.join(packageRoot, 'sdk/assets/config', `${network}.json`);
    const config = JSON.parse(fs.readFileSync(file, 'utf8'));
    edit(config);
    fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
    const refreshed = node([path.join(packageRoot, 'refresh-assets.mjs')]);
    assert.equal(refreshed.status, 0, refreshed.stderr);
}

// Evaluating the client module publishes the singleton as
// globalThis.zkapiClient. A test that evaluates one puts the global back, so
// what another test observes does not depend on which of them ran first.
function keepClientGlobal(t) {
    const published = globalThis.zkapiClient;
    t.after(() => {
        if (published === undefined) delete globalThis.zkapiClient;
        else globalThis.zkapiClient = published;
    });
}

// A build that stands in for esbuild: writes a fixed worker, records options.
function fakeBuild(calls = []) {
    return async options => {
        calls.push(options);
        fs.mkdirSync(path.dirname(options.outfile), { recursive: true });
        fs.writeFileSync(options.outfile, 'fixture-worker\n');
    };
}

test('the fixture is the real package identity: name, version, exports map and every export name', () => {
    const pkg = readFixtureJson('package.json');
    assert.equal(pkg.name, '@openanonymity/zkapi-browser-sdk');
    assert.equal(pkg.version, '0.2.0');
    assert.deepEqual(pkg.files, ['sdk/']);
    assert.equal(Object.keys(pkg.exports).length, 17);
    assert.equal(pkg.exports['.'], './sdk/index.js');
    assert.equal(pkg.exports['./build'], './sdk/build.mjs');
    assert.equal(pkg.exports['./package.json'], './package.json');
    for (const target of Object.values(pkg.exports)) {
        assert.ok(fs.existsSync(path.resolve(fixture, target)), `${target} exists`);
    }
    assert.deepEqual(readFixtureJson('sdk/package.json'), { type: 'module' });
    // The digests of the real name lists (package, 16 subpaths, client and
    // runtime surface) equal the fixture's.
    const verified = node([fixtureFile('verify-exports.mjs')]);
    assert.equal(verified.status, 0, `${verified.stdout}${verified.stderr}`);
    assert.match(verified.stdout, /25 name lists match the recorded real SDK digests/);
});

test('the store has the real declaration lines, lock and channel literals, and the pinned SHA-256', () => {
    const bytes = readFixture('sdk/services/browserWalletStore.js');
    const source = bytes.toString('utf8');
    assert.match(pinned['store-sha256'], /^[0-9a-f]{64}$/, 'the README documents the store hash');
    assert.equal(sha256(bytes), pinned['store-sha256']);
    const occurrences = (text, needle) => text.split(needle).length - 1;
    assert.equal(occurrences(source, "const DB_NAME = 'zkapi-browser-wallet-v1';"), 1);
    assert.equal(occurrences(source, 'const DB_VERSION = 3;'), 1);
    assert.equal(occurrences(source, "    const lockName = 'zkapi-wallet:active-runtime';"), 1);
    assert.equal(occurrences(source, "    const channel = new BroadcastChannel('zkapi-wallet:active-runtime');"), 1);
    // After a correct rename no default name may remain in any bundled module.
    const walk = directory => fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => (entry.isDirectory()
        ? walk(path.join(directory, entry.name)) : [path.join(directory, entry.name)]));
    const carriers = walk(fixtureFile('sdk')).filter(file => /\.(js|mjs)$/.test(file)
        && fs.readFileSync(file, 'utf8').includes('zkapi-browser-wallet-v1'));
    assert.deepEqual(carriers.map(file => path.relative(fixture, file)), ['sdk/services/browserWalletStore.js']);
});

test('the pinned assets, profiles and manifest are current, and the README documents them', () => {
    const refreshed = node([fixtureFile('refresh-assets.mjs'), '--check']);
    assert.equal(refreshed.status, 0, `${refreshed.stdout}${refreshed.stderr}`);

    assert.equal(sha256(readFixture('sdk/assets/proofs/request.pk')), pinned['request-pk-sha256']);
    assert.equal(sha256(readFixture('sdk/assets/proofs/withdrawal.pk')), pinned['withdrawal-pk-sha256']);
    assert.equal(sha256(readFixture('sdk/assets/proofs/request.vk')), pinned['request-vk-sha256']);
    for (const network of ['mainnet', 'sepolia']) {
        const file = `sdk/assets/config/${network}.json`;
        assert.equal(sha256(readFixture(file)), pinned[`browser-config-${network}-sha256`]);
        const pins = readFixtureJson(file).trusted_deployment;
        assert.equal(pins.request_proving_key_sha256, pinned['request-pk-sha256']);
        assert.equal(pins.withdrawal_proving_key_sha256, pinned['withdrawal-pk-sha256']);
        assert.equal(pins.request_verifying_key_sha256, pinned['request-vk-sha256']);
        // Deployed-looking and acceptable to the successor SDK's own checks.
        assert.equal(pins.deployment_status, 'deployed');
        assert.equal(pins.circuit_id, 'zkapi-v2-concession-v1');
        assert.equal(pins.setup_id, 'mpc-1');
        assert.equal(pins.vault_revision, 3);
        assert.equal(pins.exit_concession, 1);
        assert.equal(pins.clearance_ownership_proof, 'required');
        assert.equal(pins.chain_id, network === 'mainnet' ? 1 : 11155111);
        assert.equal(readFixtureJson(file).deployment_api_proxy_path, '/zkapi-deployment-v2c/');
        assert.equal(readFixtureJson(file).proving_keys_base_url, './proofs/');
    }
    const manifest = readFixtureJson('sdk/assets/manifest.json');
    assert.equal(manifest.schema, 2);
    assert.equal(manifest.circuitId, 'zkapi-v2-concession-v1');
    assert.equal(manifest.setupId, 'mpc-1');
    assert.equal(manifest.files['assets/proofs/request.vk'], pinned['request-vk-sha256']);
});

test('buildBrowserSdkAssets emits the real layout and result shape, deterministically', async t => {
    const { packageRoot, outDir } = installedCopy(t);
    const { buildBrowserSdkAssets } = await importFrom(packageRoot, 'sdk/build.mjs');
    const emitted = {};
    for (const network of ['mainnet', 'sepolia']) {
        const calls = [];
        const directory = `${outDir}-${network}`;
        const first = await buildBrowserSdkAssets({ outDir: directory, network, build: fakeBuild(calls) });
        assert.deepEqual(Object.keys(first), ['directory', 'config', 'manifest', 'files', 'configUrl', 'workerUrl']);
        assert.equal(first.directory, directory);
        assert.equal(first.configUrl, '/zkapi/v2c/browser-config.json');
        assert.equal(first.workerUrl, '/zkapi/v2c/assets/zkapiWasmWorker.js');
        assert.deepEqual(Object.keys(first.files), [
            'proofs/request.pk', 'proofs/withdrawal.pk', 'proofs/request.vk', 'wasm/zkapi_browser_bg.wasm',
            'browser-config.json', 'assets/zkapiWasmWorker.js', 'sdk-assets.json'
        ]);
        // sdk-assets.json lists every file but itself.
        assert.deepEqual(first.manifest, {
            schema: 2, network, circuitId: 'zkapi-v2-concession-v1', setupId: 'mpc-1',
            sourceRevision: '0123456789abcdef0123456789abcdef01234567', publicPath: '/zkapi/v2c/',
            files: Object.fromEntries(Object.entries(first.files).filter(([name]) => name !== 'sdk-assets.json'))
        });
        // The emitted bytes are the pinned bytes.
        assert.equal(first.files['proofs/request.pk'], pinned['request-pk-sha256']);
        assert.equal(first.files['proofs/withdrawal.pk'], pinned['withdrawal-pk-sha256']);
        assert.equal(first.files['proofs/request.vk'], pinned['request-vk-sha256']);
        assert.equal(first.files['browser-config.json'], pinned[`browser-config-${network}-sha256`]);
        assert.equal(first.config.trusted_deployment.request_proving_key_sha256, first.files['proofs/request.pk']);
        for (const [relative, hash] of Object.entries(first.files)) {
            assert.equal(sha256(fs.readFileSync(path.join(directory, relative))), hash, relative);
        }
        // The worker is built from the package's worker entry by the host's build.
        assert.equal(calls.length, 1);
        assert.equal(calls[0].entryPoints[0], path.join(packageRoot, 'sdk/services/zkapiWasmWorker.js'));
        assert.equal(calls[0].outfile, path.join(directory, 'assets/zkapiWasmWorker.js'));
        assert.equal(calls[0].format, 'esm');
        assert.equal(calls[0].bundle, true);

        const second = await buildBrowserSdkAssets({ outDir: directory, network, build: fakeBuild() });
        assert.deepEqual(second.files, first.files);
        emitted[network] = first;
    }
    assert.notEqual(emitted.mainnet.files['browser-config.json'], emitted.sepolia.files['browser-config.json']);
    assert.equal(emitted.mainnet.manifest.publicPath, '/zkapi/v2c/');

    // A custom public path flows into the manifest and the URLs.
    const custom = await buildBrowserSdkAssets({ outDir: `${outDir}-custom`, network: 'sepolia', publicPath: '/zkapi/v3c/', build: fakeBuild() });
    assert.equal(custom.manifest.publicPath, '/zkapi/v3c/');
    assert.equal(custom.configUrl, '/zkapi/v3c/browser-config.json');
});

test('the worker entry bundles with esbuild like the host builds it', async t => {
    const { packageRoot, outDir } = installedCopy(t);
    const { build } = await import('esbuild');
    const { buildBrowserSdkAssets } = await importFrom(packageRoot, 'sdk/build.mjs');
    const result = await buildBrowserSdkAssets({ outDir, network: 'sepolia', build });
    const worker = fs.readFileSync(path.join(outDir, 'assets/zkapiWasmWorker.js'), 'utf8');
    assert.match(worker, /zkapi-v2-concession-v1/);
    assert.match(worker, /zkapi_browser_bg\.wasm/);
    assert.equal(result.files['assets/zkapiWasmWorker.js'], sha256(worker));
});

test('buildBrowserSdkAssets refuses what the real one refuses, before writing anything', async t => {
    const { packageRoot, outDir } = installedCopy(t);
    const { buildBrowserSdkAssets } = await importFrom(packageRoot, 'sdk/build.mjs');
    const build = fakeBuild();
    const refused = async (options, pattern) => {
        await assert.rejects(buildBrowserSdkAssets({ build, ...options }), pattern);
        assert.equal(fs.existsSync(options.outDir || outDir), false, 'nothing was written');
    };
    await refused({ outDir, network: 'goerli' }, /Network must be sepolia or mainnet/);
    await refused({ outDir, network: 'sepolia', build: null }, /outDir and an esbuild build function are required/);
    for (const publicPath of ['zkapi/v2c/', '/zkapi/v2c', '//host/zkapi/', '/zkapi/../x/', '/zkapi/?q=1/']) {
        await refused({ outDir, network: 'sepolia', publicPath }, /publicPath must be an absolute same-origin directory path/);
    }
    for (const unsafe of [packageRoot, path.join(packageRoot, 'sdk'), path.join(packageRoot, 'sdk', 'out'), path.parse(outDir).root]) {
        await assert.rejects(buildBrowserSdkAssets({ outDir: unsafe, network: 'sepolia', build }),
            /must not overwrite its package source/);
    }
});

test('a placeholder or foreign package profile is refused before any output', async t => {
    const cases = [
        ['not deployed', config => { config.trusted_deployment.deployment_status = 'not_deployed'; }, 'deployment_not_deployed'],
        ['another circuit', config => { config.trusted_deployment.circuit_id = 'zkapi-v2-note-bound-v1'; }, 'incompatible_proof_circuit'],
        ['another setup', config => { config.trusted_deployment.setup_id = 'dev'; }, 'setup_mismatch'],
        ['no concession exit', config => { config.trusted_deployment.exit_concession = 0; }, 'exit_concession_required']
    ];
    for (const [label, edit, code] of cases) {
        const { packageRoot, outDir } = installedCopy(t);
        editConfig(packageRoot, 'sepolia', edit);
        const { buildBrowserSdkAssets } = await importFrom(packageRoot, 'sdk/build.mjs');
        await assert.rejects(buildBrowserSdkAssets({ outDir, network: 'sepolia', build: fakeBuild() }),
            error => error.code === code, label);
        assert.equal(fs.existsSync(outDir), false, `${label}: nothing was written`);
        // The other network is untouched by the edit.
        const mainnet = await buildBrowserSdkAssets({ outDir, network: 'mainnet', build: fakeBuild() });
        assert.equal(mainnet.manifest.network, 'mainnet');
    }
    // An asset that no longer matches the manifest is an integrity failure,
    // not a profile failure.
    const { packageRoot, outDir } = installedCopy(t);
    fs.appendFileSync(path.join(packageRoot, 'sdk/assets/proofs/request.pk'), 'x');
    const { buildBrowserSdkAssets } = await importFrom(packageRoot, 'sdk/build.mjs');
    await assert.rejects(buildBrowserSdkAssets({ outDir, network: 'sepolia', build: fakeBuild() }),
        /integrity check failed: assets\/proofs\/request\.pk/);
    assert.equal(fs.existsSync(outDir), false);
});

test('assertDeployableProfile mirrors the real refusals and codes', async () => {
    const { assertDeployableProfile, REQUIRED_CIRCUIT_ID, PRODUCTION_SETUP_ID } = await importFrom(fixture, 'sdk/build.mjs');
    assert.equal(REQUIRED_CIRCUIT_ID, 'zkapi-v2-concession-v1');
    assert.equal(PRODUCTION_SETUP_ID, 'mpc-1');
    const manifest = readFixtureJson('sdk/assets/manifest.json');
    const hashes = manifest.files;
    const profile = network => structuredClone(readFixtureJson(`sdk/assets/config/${network}.json`));
    const run = (network, edit, edited = manifest) => {
        const config = profile(network);
        edit(config);
        return assertDeployableProfile(config, edited, network, hashes);
    };
    const code = expected => error => error.code === expected;

    assert.equal(run('mainnet', () => {}), undefined);
    assert.equal(run('sepolia', () => {}), undefined);
    // Key hashes are compared case-insensitively.
    run('sepolia', config => {
        config.trusted_deployment.request_proving_key_sha256 = config.trusted_deployment.request_proving_key_sha256.toUpperCase();
    });

    assert.throws(() => run('mainnet', config => { config.trusted_deployment.deployment_status = 'not_deployed'; }),
        code('deployment_not_deployed'));
    assert.throws(() => run('mainnet', config => { config.deployment_status = 'not_deployed'; }),
        code('deployment_not_deployed'));
    assert.throws(() => run('mainnet', config => { config.trusted_deployment.deployment_status = 'pending'; }),
        error => error.code === undefined && /unknown deployment_status/.test(error.message));
    assert.throws(() => run('mainnet', config => { delete config.trusted_deployment; }), /no trusted_deployment pins/);
    assert.throws(() => run('mainnet', config => { config.trusted_deployment.circuit_id = 'zkapi-v2-note-bound-v1'; }),
        code('incompatible_proof_circuit'));
    assert.throws(() => run('sepolia', config => { config.trusted_deployment.setup_id = 'dev'; }), code('setup_mismatch'));
    assert.throws(() => run('mainnet', config => { config.trusted_deployment.exit_concession = 0; }),
        code('exit_concession_required'));
    for (const [field, file] of [
        ['request_proving_key_sha256', 'assets/proofs/request.pk'],
        ['withdrawal_proving_key_sha256', 'assets/proofs/withdrawal.pk'],
        ['request_verifying_key_sha256', 'assets/proofs/request.vk']
    ]) {
        assert.throws(() => run('sepolia', config => { config.trusted_deployment[field] = 'f'.repeat(64); }),
            error => error.message.includes(file) && error.message.includes(field), field);
    }

    // The bundle's setup, not the profile's alone, decides mainnet.
    const dev = { ...manifest, setupId: 'dev' };
    const devOn = (network, setupId) => run(network, config => { config.trusted_deployment.setup_id = setupId; }, dev);
    assert.throws(() => devOn('mainnet', 'dev'), code('development_setup_on_mainnet'));
    assert.equal(devOn('sepolia', 'dev'), undefined);
    assert.throws(() => devOn('mainnet', 'mpc-1'), code('setup_mismatch'));
});

test('the singletons record calls, publish globalThis.zkapiClient and keep the real event semantics', async t => {
    // A private copy: the publication happens when the module is evaluated, so
    // it can only be observed on an evaluation this test makes itself.
    const { packageRoot } = installedCopy(t);
    keepClientGlobal(t);
    const { default: client, ZkapiClient } = await importFrom(packageRoot, 'sdk/services/zkapiClient.js');
    const { default: runtime, BrowserWalletRuntime, BrowserWalletHttpError } =
        await importFrom(packageRoot, 'sdk/services/browserWalletRuntime.js');
    const index = await importFrom(packageRoot, 'sdk/index.js');
    assert.ok(client instanceof ZkapiClient);
    assert.ok(client instanceof EventTarget);
    assert.ok(runtime instanceof BrowserWalletRuntime);
    assert.equal(globalThis.zkapiClient, client);
    assert.equal(index.zkapiClient, client);
    assert.equal(index.browserWalletRuntime, runtime);
    assert.equal(client.fixtureCalls, runtime.fixtureCalls);
    assert.deepEqual(Object.keys(client).filter(key => /fixture/i.test(key)), []);

    const calls = client.fixtureCalls;
    calls.length = 0;
    const seen = [];
    const stop = client.subscribe((snapshot, detail) => seen.push([snapshot.initialized, detail.reason]));
    client.emitChange('probe');
    stop();
    client.emitChange('ignored');
    assert.deepEqual(seen, [[false, 'probe']]);
    await client.deposit('1', () => {});
    await client.quoteDepositUsd(5);
    await runtime.prepareDepositQuote({ amount: '1' });
    assert.deepEqual(calls.filter(call => /deposit/i.test(call.name)).map(call => `${call.target}.${call.name}`),
        ['client.deposit', 'client.quoteDepositUsd', 'runtime.prepareDepositQuote']);
    assert.deepEqual(calls.map(call => call.seq), calls.map((_, position) => calls[0].seq + position));
    assert.deepEqual(calls.find(call => call.name === 'quoteDepositUsd').args, [5]);

    // State getters follow the assigned state, as the host's tests drive the real singleton.
    client.wallet = { has_note: true, note: { note_id: 7 } };
    assert.equal(client.hasNote, true);
    assert.equal(client.note.note_id, 7);
    client.withdrawals = [{ phase: 'pending' }, { phase: 'closed' }];
    assert.equal(client.openWithdrawals.length, 1);
    assert.throws(() => { client.hasNote = false; }, TypeError);
    // Methods can be shadowed by an own property, as on the real instance.
    client.deposit = async () => 'shadowed';
    assert.equal(await client.deposit(), 'shadowed');
    delete client.deposit;

    // The access has the real shape and header set; extra headers are opt-in.
    const access = await client.acquireInferenceAccess('session-1', { spendingLimitUsd: 2 });
    assert.equal(access.mode, 'ephemeral-key');
    assert.equal(access.spendingLimitUsd, 2);
    assert.deepEqual(Object.keys(access.headers).sort(), ['authorization', 'content-type', 'http-referer', 'x-title']);
    assert.equal(access.headers['x-title'], 'zkAPI');
    client.fixtureAccessHeaders = { 'x-extra': '1' };
    assert.equal((await client.acquireInferenceAccess('session-2')).headers['x-extra'], '1');
    client.fixtureAccessHeaders = {};

    const error = new BrowserWalletHttpError('closed', 409, 'deposits_closed', { a: 1 });
    assert.deepEqual([error.name, error.status, error.code, error.data], ['BrowserWalletHttpError', 409, 'deposits_closed', { a: 1 }]);
});

test('exports the fixture cannot implement fail loudly and are recorded', async t => {
    keepClientGlobal(t);
    const store = await importFrom(fixture, 'sdk/services/browserWalletStore.js');
    const wallet = await importFrom(fixture, 'sdk/wallet.js');
    const client = (await importFrom(fixture, 'sdk/services/zkapiClient.js')).default;
    client.fixtureCalls.length = 0;
    for (const call of [() => store.readBrowserWalletHoldings({}), () => wallet.encodeDeposit('1'), () => wallet.default.encodeWithdrawal({})]) {
        assert.throws(call, error => error.code === 'fixture_not_implemented');
    }
    assert.deepEqual(client.fixtureCalls.map(call => `${call.target}.${call.name}`),
        ['store.readBrowserWalletHoldings', 'wallet.encodeDeposit', 'wallet.encodeWithdrawal']);
    client.fixtureCalls.length = 0;
    // The real constants and tiny helpers are real.
    assert.equal(wallet.ABI.mutualClose, '72cd2e44');
    assert.equal(wallet.WITHDRAWAL_CALLDATA_BYTES, 4 + 26 * 32);
    assert.equal(wallet.callData('ff8f5585', [wallet.abiWord(5)]), `0xff8f5585${'0'.repeat(63)}5`);
    assert.equal(Object.hasOwn(wallet, 'parseTokenAmount'), false);
    assert.equal(Object.hasOwn(wallet, 'formatTokenAmount'), false);
});

test('configure keeps the real rule: no configuration after a client init begins', async t => {
    // A private copy: init() flips module state that other tests share.
    const { packageRoot } = installedCopy(t);
    keepClientGlobal(t);
    const { configureBrowserSdk, browserSdkOptions } = await importFrom(packageRoot, 'sdk/configure.js');
    const { default: client } = await importFrom(packageRoot, 'sdk/services/zkapiClient.js');
    configureBrowserSdk({ configUrl: 'https://app.example.test/zkapi/v2c/browser-config.json' });
    assert.equal(browserSdkOptions().configUrl, 'https://app.example.test/zkapi/v2c/browser-config.json');
    assert.throws(() => configureBrowserSdk({ mode: 'daemon' }), /Only browser mode is supported/);
    assert.throws(() => configureBrowserSdk({ nonsense: true }), /Unknown zkAPI browser SDK option/);
    // No IndexedDB in plain Node: init starts, then the wallet read fails. The
    // start alone is what freezes the configuration.
    await assert.rejects(client.init());
    assert.throws(() => configureBrowserSdk({}), /Configure the zkAPI browser SDK before initializing/);
});

test('the store functional core opens the database named by its DB_NAME over a fake IndexedDB', async t => {
    const opens = [];
    const database = {
        objectStoreNames: { contains: () => false },
        created: [],
        createObjectStore(name, options) { this.created.push([name, options?.keyPath || null]); },
        transaction() {
            const transaction = {
                objectStore: () => ({
                    get() {
                        const request = {};
                        // Macrotasks: the store assigns its handlers after an await.
                        setTimeout(() => {
                            request.result = { deploymentId: 'fixture-deployment' };
                            request.onsuccess();
                            setTimeout(() => transaction.oncomplete(), 0);
                        }, 0);
                        return request;
                    }
                })
            };
            return transaction;
        }
    };
    const previous = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB');
    t.after(() => {
        if (previous) Object.defineProperty(globalThis, 'indexedDB', previous); else delete globalThis.indexedDB;
    });
    Object.defineProperty(globalThis, 'indexedDB', {
        configurable: true,
        value: { open(name, version) {
            opens.push([name, version]);
            const request = { result: database };
            queueMicrotask(() => { request.onupgradeneeded(); request.onsuccess(); });
            return request;
        } }
    });
    // A private copy so the store's cached connection is not shared.
    const { packageRoot } = installedCopy(t);
    const { readBrowserWallet } = await importFrom(packageRoot, 'sdk/services/browserWalletStore.js');
    const runtime = await readBrowserWallet();
    assert.deepEqual(opens, [['zkapi-browser-wallet-v1', 3]]);
    assert.deepEqual(database.created, [['runtime', null], ['archives', 'archiveId'], ['withdrawals', 'recordId'], ['deposits', 'recordId']]);
    assert.equal(runtime.deploymentId, 'fixture-deployment');
    assert.equal(runtime.version, 1);
    assert.deepEqual(runtime.lateWithdrawalAttempts, []);
});

test('the fixture stays small, self-contained and invisible to the test runner', () => {
    const files = [];
    const walk = directory => {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
            const absolute = path.join(directory, entry.name);
            if (entry.isDirectory()) walk(absolute); else files.push(absolute);
        }
    };
    walk(fixture);
    assert.ok(files.length > 0);
    assert.ok(files.reduce((total, file) => total + fs.statSync(file).size, 0) < 100 * 1024, 'under 100 KB');
    // The runner collects every *.test.js and *.test.mjs under test/.
    assert.deepEqual(files.filter(file => /\.test\.(?:js|mjs|cjs)$/.test(file)), []);
    // No machine-specific path, and no real SDK source tree reference.
    for (const file of files.filter(candidate => /\.(?:js|mjs|json|md)$/.test(candidate))) {
        const text = fs.readFileSync(file, 'utf8');
        assert.doesNotMatch(text, /\/Users\/|\/private\/tmp|\/home\//, path.relative(fixture, file));
    }
});
