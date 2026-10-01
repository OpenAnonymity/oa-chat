import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { buildZkapiAssets, resolveZkapiDeployment, resolveZkapiNetwork, validateZkapiDeploymentPins, zkapiBuildProvenance } from '../../scripts/zkapiBuild.mjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const deployments = ['fresh-20260930'];

// The suite bundles architecture tests. Load file-emission helpers from their
// source location so package/config paths retain the production resolution.
async function sourceBuildHelpers() {
    const root = process.cwd();
    return {
        root,
        ...await import(pathToFileURL(path.join(root, 'scripts/zkapiBuild.mjs')).href),
        ...await import(pathToFileURL(path.join(root, 'scripts/generate-zkapi-vercel-config.mjs')).href),
        build: createRequire(path.join(root, 'package.json'))('esbuild').build
    };
}

test('zkAPI network selection is explicit and rejects ambiguous build settings', () => {
    assert.equal(resolveZkapiNetwork({}), '');
    assert.equal(resolveZkapiNetwork({ OA_ZKAPI_NETWORK: 'sepolia' }), 'sepolia');
    assert.equal(resolveZkapiNetwork({ OA_ZKAPI_NETWORK: 'mainnet' }), 'mainnet');
    for (const value of ['true', 'false', 'ethereum', ' mainnet', 'https://untrusted.test']) {
        assert.throws(() => resolveZkapiNetwork({ OA_ZKAPI_NETWORK: value }), /OA_ZKAPI_NETWORK/);
    }
});

test('fresh deployment selection is explicit, named and requires a network', () => {
    assert.equal(resolveZkapiDeployment({}), '');
    for (const deployment of deployments) for (const network of ['mainnet', 'sepolia']) {
        const environment = { OA_ZKAPI_NETWORK: network, OA_ZKAPI_DEPLOYMENT: deployment };
        assert.equal(resolveZkapiDeployment(environment), deployment);
        assert.equal(resolveZkapiNetwork(environment), network);
    }
    for (const value of ['mainnet', 'fresh', 'fresh-20260928', '../fresh-20260930', ' fresh-20260930', 'https://untrusted.test']) {
        assert.throws(() => resolveZkapiNetwork({ OA_ZKAPI_NETWORK: 'mainnet', OA_ZKAPI_DEPLOYMENT: value }), /OA_ZKAPI_DEPLOYMENT/);
    }
    assert.throws(() => resolveZkapiNetwork({ OA_ZKAPI_DEPLOYMENT: 'fresh-20260930' }), /requires an explicit/);
});

test('Vercel bundled fresh config resolves outside the repository without an installed SDK', async t => {
    const { root, build, readZkapiBuildConfig } = await sourceBuildHelpers();
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'oa-isolated-vercel-config-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const outfile = path.join(directory, '.vercel/vercel-temp.mjs');
    await build({ entryPoints: [path.join(root, 'scripts/generate-zkapi-vercel-config.mjs')],
        outfile, bundle: true, platform: 'node', format: 'esm', target: 'node20.20', packages: 'external', logLevel: 'silent' });
    // The child has neither the source JSON directory nor an SDK dependency.
    // Even package resolution is denied so an accidentally reintroduced fresh
    // import.meta.resolve() fails independently of the developer's /tmp setup.
    const source = await fs.readFile(outfile, 'utf8');
    await fs.writeFile(outfile, `import.meta.resolve = () => { throw new Error('SDK package resolution is unavailable'); };\n${source}`);
    const result = execFileSync(process.execPath, ['--input-type=module', '-e', `
        import { buildZkapiVercelConfig } from ${JSON.stringify(pathToFileURL(outfile).href)};
        const results = ${JSON.stringify(deployments)}.flatMap(deployment =>
            ['mainnet', 'sepolia'].map(network => ({ deployment, network, config: buildZkapiVercelConfig({
                network, deployment, orgOrigin: 'https://org-staging.openanonymity.ai'
            }) })));
        console.log(JSON.stringify(results));
    `], { cwd: directory, encoding: 'utf8' });
    for (const { deployment, network, config } of JSON.parse(result)) {
        assert.equal(config.rewrites[0].destination,
            `${readZkapiBuildConfig({ network, deployment }).trusted_deployment.protocol_server_url}/:path*`);
        assert.equal(config.build.env.OA_ZKAPI_DEPLOYMENT, deployment);
        assert.equal(config.build.env.OA_ZKAPI_NETWORK, network);
        assert.match(config.buildCommand, new RegExp(`OA_ZKAPI_NETWORK=${network} OA_ZKAPI_DEPLOYMENT=${deployment} `));
    }
});

test('Vercel source uploads include only reviewed public deployment pin files', async t => {
    // Installed core packages may sit inside another Git repository. Check the
    // ignore rules in their own temporary root, matching a source upload.
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'oa-deployment-allowlist-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    await fs.copyFile('.vercelignore', path.join(directory, '.vercelignore'));
    execFileSync('git', ['init', '-q', directory]);
    const included = [...['mainnet', 'sepolia'].map(network =>
        `deployments/zkapi/${network}.json`),
        'patches/zkapi-browser-sdk-wallet-recovery.mjs'];
    const excluded = ['deployments/private/key.json', 'deployments/zkapi/other/mainnet.json',
        ...['secret.json', 'nested/secret.json', '.env', '.git/config']
            .map(file => `deployments/zkapi/${file}`), 'patches/private-test.json'];
    const ignored = execFileSync('git', ['-c', 'core.excludesFile=.vercelignore', 'check-ignore', '--no-index', '--stdin'], {
        cwd: directory, input: [...included, ...excluded].join('\n') + '\n', encoding: 'utf8'
    }).trim().split('\n');
    assert.deepEqual(ignored, excluded);
});

test('reviewed deployment pins reject mismatched networks, circuits, assets and routes', async () => {
    const { readZkapiBuildConfig } = await sourceBuildHelpers();
    const original = readZkapiBuildConfig({ network: 'mainnet', deployment: 'fresh-20260930' });
    const artifacts = { network: 'mainnet', circuitId: 'zkapi-v2-note-bound-v1', files: {
        'proofs/request.pk': original.trusted_deployment.request_proving_key_sha256,
        'proofs/withdrawal.pk': original.trusted_deployment.withdrawal_proving_key_sha256
    } };
    assert.equal(validateZkapiDeploymentPins(original, artifacts), original);
    const invalidPins = [
        [config => { config.trusted_deployment.chain_id = 11155111; }, /selected network/],
        [config => { config.trusted_deployment.circuit_id = 'legacy'; }, /proof circuit/],
        [config => { config.trusted_deployment.request_proving_key_sha256 = 'a'.repeat(64); }, /request proving key/],
        [config => { config.trusted_deployment.withdrawal_proving_key_sha256 = 'b'.repeat(64); }, /withdrawal proving key/],
        [config => { config.deployment_manifest_url = 'https://untrusted.test/config.json'; }, /routes/],
        [config => { config.allowed_deployment_manifest_urls.push('https://untrusted.test/config.json'); }, /routes/],
        [config => { config.trusted_deployment.protocol_server_url = 'https://user:password@example.test'; }, /credential-free/],
        [config => { config.deployment_api_proxy_path = '/other/'; }, /routes/],
        [config => { config.proving_keys_base_url = 'https://untrusted.test/proofs/'; }, /routes/],
        [config => { config.trusted_deployment.billing_asset = 'erc20'; }, /native ETH/],
        [config => { config.trusted_deployment.billing_token_address = '0x' + '11'.repeat(20); }, /native ETH/],
        [config => { config.require_oa_key_source = false; }, /verified OA/]
    ];
    for (const [mutate, error] of invalidPins) {
        const config = structuredClone(original);
        mutate(config);
        assert.throws(() => validateZkapiDeploymentPins(config, artifacts), error);
    }
    assert.throws(() => validateZkapiDeploymentPins(original, { ...artifacts, circuitId: 'legacy' }), /proof circuit/);
});

test('fresh asset emission and Vercel rewrites use identical pins with complete integrity metadata', async t => {
    const { root, build, buildZkapiAssets: emit, buildZkapiVercelConfig, readZkapiBuildConfig } = await sourceBuildHelpers();
    const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'oa-fresh-deployment-'));
    t.after(() => fs.rm(temporary, { recursive: true, force: true }));
    for (const deployment of deployments) for (const network of ['mainnet', 'sepolia']) {
        const outDir = path.join(temporary, deployment, network);
        const result = await emit({ network, deployment, repoRoot: root, outDir, build });
        const config = JSON.parse(await fs.readFile(path.join(result.directory, 'browser-config.json')));
        const manifest = JSON.parse(await fs.readFile(path.join(result.directory, 'sdk-assets.json')));
        assert.deepEqual(result.config, config);
        assert.deepEqual(config, readZkapiBuildConfig({ network, deployment }));
        assert.equal(config.trusted_deployment.deployment_id, `zkapi-native-eth-${network}-note-bound-v1-${deployment}`);
        assert.equal(config.trusted_deployment.protocol_server_url,
            `https://zkapi-${network}.openanonymity.ai`);
        assert.equal(result.deployment, deployment);
        assert.deepEqual(result.manifest, manifest);
        assert.equal(manifest.deployment, deployment);
        for (const [relative, hash] of Object.entries(manifest.files)) {
            assert.equal(digest(await fs.readFile(path.join(result.directory, relative))), hash, relative);
        }
        for (const [relative, hash] of Object.entries(result.files)) {
            assert.equal(digest(await fs.readFile(path.join(result.directory, relative))), hash, relative);
        }
        const routing = buildZkapiVercelConfig({ orgOrigin: 'https://org-staging.openanonymity.ai', network, deployment });
        assert.equal(routing.rewrites[0].destination, `${config.trusted_deployment.protocol_server_url}/:path*`);
        assert.equal(routing.build.env.OA_ZKAPI_DEPLOYMENT, deployment);
        assert.match(routing.buildCommand, new RegExp(`OA_ZKAPI_NETWORK=${network} OA_ZKAPI_DEPLOYMENT=${deployment} `));
        assert.equal(routing.build.env.OA_DEMO_VERIFIER_BYPASS, 'false');
        const provenance = await zkapiBuildProvenance({ network, repoRoot: root, outDir, sdkAssets: result });
        assert.equal(provenance.deployment, deployment);
        assert.equal(provenance.walletStorage?.database,
            deployment === 'fresh-20260930' ? `zkapi-browser-wallet-${deployment}-${network}-v1` : undefined);
        assert.deepEqual(provenance.sdk.assets, manifest);
        assert.equal(provenance.sdk.patches[0].name, 'wallet-recovery-v1');
        assert.equal(provenance.sdk.patches[0].revision, provenance.sdk.revision);
        for (const [relative, hash] of Object.entries(provenance.sdk.patches[0].files)) {
            assert.equal(digest(await fs.readFile(path.join(root, 'node_modules/@openanonymity/zkapi-browser-sdk', relative))), hash);
        }
        assert.equal(provenance.files['zkapi/sdk-assets.json'], digest(await fs.readFile(path.join(result.directory, 'sdk-assets.json'))));
    }
});

test('clean-reset bundles isolate wallet writes and preserve existing origin storage and SDK source', async t => {
    const { root, build, zkapiBuildPlugins } = await sourceBuildHelpers();
    const sdkRoot = path.dirname(createRequire(path.join(root, 'package.json'))
        .resolve('@openanonymity/zkapi-browser-sdk/package.json'));
    const storePath = path.join(sdkRoot, 'sdk/services/browserWalletStore.js');
    const originalSource = await fs.readFile(storePath);
    const oldRuntime = { deploymentId: 'old-deployment', state: { secret: 'test-old-note' },
        journal: { requestId: 'test-pending-request' }, lease: { leaseId: 'test-active-lease' } };
    const databases = new Map([
        ['zkapi-browser-wallet-v1', new Map([['runtime', new Map([['active', structuredClone(oldRuntime)]])]])],
        ['oa-zkapi-address-funding-v1', new Map([['addresses', new Map([['old-vault', 'test-encrypted-signer']])]])]
    ]);
    const opened = [];
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB');
    t.after(() => {
        if (descriptor) Object.defineProperty(globalThis, 'indexedDB', descriptor);
        else delete globalThis.indexedDB;
    });
    // Exercise the actual bundled SDK store against durable named databases.
    // This fixture intentionally has no deletion API: a destructive reset fails.
    Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: {
        open(name) {
            opened.push(name);
            if (!databases.has(name)) databases.set(name, new Map());
            const stores = databases.get(name);
            const request = {};
            queueMicrotask(() => {
                request.result = {
                    close() {},
                    transaction() {
                        const transaction = {};
                        const complete = value => {
                            const operation = {};
                            queueMicrotask(() => {
                                operation.result = structuredClone(value);
                                operation.onsuccess?.();
                                setTimeout(() => transaction.oncomplete?.(), 0);
                            });
                            return operation;
                        };
                        transaction.objectStore = name => {
                            if (!stores.has(name)) stores.set(name, new Map());
                            const records = stores.get(name);
                            return {
                                get: key => complete(records.get(key)),
                                getAll: () => complete([...records.values()]),
                                put(value, key = value.recordId) {
                                    records.set(key, structuredClone(value));
                                    return complete(key);
                                }
                            };
                        };
                        return transaction;
                    }
                };
                request.onsuccess();
            });
            return request;
        }
    } });
    const modules = [];
    for (const [network, deployment] of [['mainnet', ''],
        ['mainnet', 'fresh-20260930'], ['sepolia', 'fresh-20260930']]) {
        const result = await build({ entryPoints: [storePath], bundle: true, write: false,
            platform: 'node', format: 'esm', logLevel: 'silent', plugins: zkapiBuildPlugins(network, deployment) });
        modules.push(await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].contents).toString('base64')}`));
    }
    const [oldStore, mainnetStore, sepoliaStore] = modules;
    assert.deepEqual((await oldStore.readBrowserWallet()).state, oldRuntime.state);
    assert.equal((await mainnetStore.readBrowserWallet()).state, null);
    assert.equal((await sepoliaStore.readBrowserWallet()).state, null);
    await mainnetStore.writeBrowserWallet({ deploymentId: 'fresh-mainnet', journal: { requestId: 'new-mainnet' } });
    await sepoliaStore.writeBrowserWallet({ deploymentId: 'fresh-sepolia', journal: { requestId: 'new-sepolia' } });
    assert.equal((await mainnetStore.readBrowserWallet()).journal.requestId, 'new-mainnet');
    assert.equal((await sepoliaStore.readBrowserWallet()).journal.requestId, 'new-sepolia');
    assert.deepEqual(databases.get('zkapi-browser-wallet-v1').get('runtime').get('active'), oldRuntime);
    assert.equal(databases.get('oa-zkapi-address-funding-v1').get('addresses').get('old-vault'), 'test-encrypted-signer');
    assert.deepEqual(opened, ['zkapi-browser-wallet-v1',
        'zkapi-browser-wallet-fresh-20260930-mainnet-v1', 'zkapi-browser-wallet-fresh-20260930-sepolia-v1']);
    assert.deepEqual(await fs.readFile(storePath), originalSource);
});

test('unset selector preserves SDK defaults and invalid selectors fail before output changes', async t => {
    const { root, build, buildZkapiAssets: emit, buildZkapiVercelConfig, readZkapiBuildConfig } = await sourceBuildHelpers();
    const outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oa-sdk-defaults-'));
    t.after(() => fs.rm(outDir, { recursive: true, force: true }));
    const result = await emit({ network: 'mainnet', deployment: '', repoRoot: root, outDir, build });
    assert.deepEqual(result.config, readZkapiBuildConfig({ network: 'mainnet', deployment: '' }));
    assert.equal(result.config.trusted_deployment.protocol_server_url, 'https://d3hmaz52qw22t.cloudfront.net');
    assert.equal(result.deployment, undefined);
    assert.equal(result.manifest.deployment, undefined);
    const routing = buildZkapiVercelConfig({ orgOrigin: 'https://org-staging.openanonymity.ai', network: 'mainnet', deployment: '' });
    assert.equal(routing.rewrites[0].destination, 'https://d3hmaz52qw22t.cloudfront.net/:path*');
    assert.equal(routing.build.env.OA_ZKAPI_DEPLOYMENT, undefined);
    assert.doesNotMatch(routing.buildCommand, /OA_ZKAPI_DEPLOYMENT/);
    const prior = await fs.readFile(path.join(result.directory, 'browser-config.json'));
    for (const settings of [{ network: 'mainnet', deployment: 'unknown' },
        { network: 'mainnet', deployment: 'fresh-20260928' }, { network: '', deployment: 'fresh-20260930' }]) {
        await assert.rejects(emit({ ...settings, repoRoot: root, outDir, build }), /OA_ZKAPI_DEPLOYMENT/);
        assert.throws(() => buildZkapiVercelConfig({ ...settings, orgOrigin: 'https://org-staging.openanonymity.ai' }), /OA_ZKAPI_DEPLOYMENT/);
        assert.deepEqual(await fs.readFile(path.join(result.directory, 'browser-config.json')), prior);
    }
});

test('fresh selection checks emitted proving bytes before writing replacement config', async t => {
    const { root, build, buildZkapiAssets: emit } = await sourceBuildHelpers();
    const outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oa-corrupt-emitted-proof-'));
    t.after(() => fs.rm(outDir, { recursive: true, force: true }));
    await assert.rejects(emit({ network: 'mainnet', deployment: 'fresh-20260930', repoRoot: root, outDir,
        build: async options => {
            await build(options);
            await fs.writeFile(path.join(outDir, 'zkapi/proofs/request.pk'), 'changed after SDK copy');
        }
    }), /request proving key/);
    const config = JSON.parse(await fs.readFile(path.join(outDir, 'zkapi/browser-config.json')));
    assert.equal(config.trusted_deployment.protocol_server_url, 'https://d3hmaz52qw22t.cloudfront.net');
});

test('a ticket-only build removes stale SDK source and assets without loading a worker', async t => {
    const outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oa-ticket-build-'));
    t.after(() => fs.rm(outDir, { recursive: true, force: true }));
    await fs.mkdir(path.join(outDir, 'zkapi'), { recursive: true });
    await fs.writeFile(path.join(outDir, 'zkapi/browser-config.json'), 'stale mainnet config');
    const result = await buildZkapiAssets({ network: '', outDir, build() { throw new Error('SDK build must stay disabled'); } });
    assert.equal(result, null);
    await assert.rejects(fs.stat(path.join(outDir, 'zkapi')), { code: 'ENOENT' });
});

test('zkAPI provenance refuses floating or local SDK dependencies', async t => {
    const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'oa-sdk-pin-'));
    t.after(() => fs.rm(repoRoot, { recursive: true, force: true }));
    for (const resolved of ['file:../zkapi', 'git+https://github.com/example/sdk.git#main', 'https://registry.example/sdk.tgz']) {
        await fs.writeFile(path.join(repoRoot, 'package-lock.json'), JSON.stringify({ packages: {
            'node_modules/@openanonymity/zkapi-browser-sdk': { version: '0.2.0', resolved }
        } }));
        await assert.rejects(zkapiBuildProvenance({ network: 'sepolia', repoRoot, outDir: repoRoot }), /immutable Git commit/);
    }
});

test('public deployment provenance excludes and removes host-omitted build metadata', async t => {
    const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'oa-sdk-public-files-'));
    t.after(() => fs.rm(repoRoot, { recursive: true, force: true }));
    const outDir = path.join(repoRoot, 'dist');
    await fs.mkdir(path.join(outDir, '.cache'), { recursive: true });
    await fs.writeFile(path.join(outDir, '.cache/metadata'), 'private metadata');
    await fs.writeFile(path.join(outDir, '.gitignore'), 'ignored');
    await fs.writeFile(path.join(outDir, 'vendor.js.map'), '{}');
    await fs.writeFile(path.join(outDir, 'vendor.js'), 'export const ok = true;');
    await fs.writeFile(path.join(repoRoot, 'package-lock.json'), JSON.stringify({ packages: {
        'node_modules/@openanonymity/zkapi-browser-sdk': { version: '0.2.0', resolved: 'git+https://github.com/OpenAnonymity/zkapi.git#3342c95871e8422bb878ad40072687c241a68a5b' }
    } }));
    const result = await zkapiBuildProvenance({ network: 'sepolia', repoRoot, outDir });
    assert.deepEqual(Object.keys(result.files), ['vendor.js']);
    assert.deepEqual(await fs.readdir(outDir), ['vendor.js']);
});
