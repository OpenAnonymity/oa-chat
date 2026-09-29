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
    for (const network of ['mainnet', 'sepolia']) {
        const environment = { OA_ZKAPI_NETWORK: network, OA_ZKAPI_DEPLOYMENT: 'fresh-20260928' };
        assert.equal(resolveZkapiDeployment(environment), 'fresh-20260928');
        assert.equal(resolveZkapiNetwork(environment), network);
    }
    for (const value of ['mainnet', 'fresh', '../fresh-20260928', ' fresh-20260928', 'https://untrusted.test']) {
        assert.throws(() => resolveZkapiNetwork({ OA_ZKAPI_NETWORK: 'mainnet', OA_ZKAPI_DEPLOYMENT: value }), /OA_ZKAPI_DEPLOYMENT/);
    }
    assert.throws(() => resolveZkapiNetwork({ OA_ZKAPI_DEPLOYMENT: 'fresh-20260928' }), /requires an explicit/);
});

test('Vercel bundled fresh config resolves outside the repository without an installed SDK', async t => {
    const { root, build } = await sourceBuildHelpers();
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
        const results = ['mainnet', 'sepolia'].map(network => buildZkapiVercelConfig({
            network, deployment: 'fresh-20260928', orgOrigin: 'https://org-staging.openanonymity.ai'
        }));
        console.log(JSON.stringify(results));
    `], { cwd: directory, encoding: 'utf8' });
    for (const [index, config] of JSON.parse(result).entries()) {
        const network = index === 0 ? 'mainnet' : 'sepolia';
        assert.equal(config.rewrites[0].destination,
            index === 0 ? 'https://54.67.93.98.sslip.io/:path*' : 'https://52.52.207.206.sslip.io/:path*');
        assert.equal(config.build.env.OA_ZKAPI_DEPLOYMENT, 'fresh-20260928');
        assert.equal(config.build.env.OA_ZKAPI_NETWORK, network);
        assert.match(config.buildCommand, new RegExp(`OA_ZKAPI_NETWORK=${network} OA_ZKAPI_DEPLOYMENT=fresh-20260928 `));
    }
});

test('Vercel source uploads include only the two reviewed public deployment pin files', async t => {
    // Installed core packages may sit inside another Git repository. Check the
    // ignore rules in their own temporary root, matching a source upload.
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'oa-deployment-allowlist-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    await fs.copyFile('.vercelignore', path.join(directory, '.vercelignore'));
    execFileSync('git', ['init', '-q', directory]);
    const included = ['deployments/zkapi/fresh-20260928/mainnet.json', 'deployments/zkapi/fresh-20260928/sepolia.json',
        'patches/zkapi-browser-sdk-wallet-recovery.mjs'];
    const excluded = ['deployments/private/key.json', 'deployments/zkapi/other/mainnet.json',
        'deployments/zkapi/fresh-20260928/secret.json', 'deployments/zkapi/fresh-20260928/nested/secret.json',
        'deployments/zkapi/fresh-20260928/.env', 'deployments/zkapi/fresh-20260928/.git/config', 'patches/private-test.json'];
    const ignored = execFileSync('git', ['-c', 'core.excludesFile=.vercelignore', 'check-ignore', '--no-index', '--stdin'], {
        cwd: directory, input: [...included, ...excluded].join('\n') + '\n', encoding: 'utf8'
    }).trim().split('\n');
    assert.deepEqual(ignored, excluded);
});

test('reviewed deployment pins reject mismatched networks, circuits, assets and routes', async () => {
    const { readZkapiBuildConfig } = await sourceBuildHelpers();
    const original = readZkapiBuildConfig({ network: 'mainnet', deployment: 'fresh-20260928' });
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
    for (const network of ['mainnet', 'sepolia']) {
        const outDir = path.join(temporary, network);
        const result = await emit({ network, deployment: 'fresh-20260928', repoRoot: root, outDir, build });
        const config = JSON.parse(await fs.readFile(path.join(result.directory, 'browser-config.json')));
        const manifest = JSON.parse(await fs.readFile(path.join(result.directory, 'sdk-assets.json')));
        assert.deepEqual(result.config, config);
        assert.deepEqual(config, readZkapiBuildConfig({ network, deployment: 'fresh-20260928' }));
        assert.equal(config.trusted_deployment.deployment_id, `zkapi-native-eth-${network}-note-bound-v1-fresh-20260928`);
        assert.equal(config.trusted_deployment.protocol_server_url,
            network === 'mainnet' ? 'https://54.67.93.98.sslip.io' : 'https://52.52.207.206.sslip.io');
        assert.equal(result.deployment, 'fresh-20260928');
        assert.deepEqual(result.manifest, manifest);
        assert.equal(manifest.deployment, 'fresh-20260928');
        for (const [relative, hash] of Object.entries(manifest.files)) {
            assert.equal(digest(await fs.readFile(path.join(result.directory, relative))), hash, relative);
        }
        for (const [relative, hash] of Object.entries(result.files)) {
            assert.equal(digest(await fs.readFile(path.join(result.directory, relative))), hash, relative);
        }
        const routing = buildZkapiVercelConfig({ orgOrigin: 'https://org-staging.openanonymity.ai', network, deployment: 'fresh-20260928' });
        assert.equal(routing.rewrites[0].destination, `${config.trusted_deployment.protocol_server_url}/:path*`);
        assert.equal(routing.build.env.OA_ZKAPI_DEPLOYMENT, 'fresh-20260928');
        assert.match(routing.buildCommand, new RegExp(`OA_ZKAPI_NETWORK=${network} OA_ZKAPI_DEPLOYMENT=fresh-20260928 `));
        assert.equal(routing.build.env.OA_DEMO_VERIFIER_BYPASS, 'false');
        const provenance = await zkapiBuildProvenance({ network, repoRoot: root, outDir, sdkAssets: result });
        assert.equal(provenance.deployment, 'fresh-20260928');
        assert.deepEqual(provenance.sdk.assets, manifest);
        assert.equal(provenance.sdk.patches[0].name, 'wallet-recovery-v1');
        assert.equal(provenance.sdk.patches[0].revision, provenance.sdk.revision);
        for (const [relative, hash] of Object.entries(provenance.sdk.patches[0].files)) {
            assert.equal(digest(await fs.readFile(path.join(root, 'node_modules/@openanonymity/zkapi-browser-sdk', relative))), hash);
        }
        assert.equal(provenance.files['zkapi/sdk-assets.json'], digest(await fs.readFile(path.join(result.directory, 'sdk-assets.json'))));
    }
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
    for (const settings of [{ network: 'mainnet', deployment: 'unknown' }, { network: '', deployment: 'fresh-20260928' }]) {
        await assert.rejects(emit({ ...settings, repoRoot: root, outDir, build }), /OA_ZKAPI_DEPLOYMENT/);
        assert.throws(() => buildZkapiVercelConfig({ ...settings, orgOrigin: 'https://org-staging.openanonymity.ai' }), /OA_ZKAPI_DEPLOYMENT/);
        assert.deepEqual(await fs.readFile(path.join(result.directory, 'browser-config.json')), prior);
    }
});

test('fresh selection checks emitted proving bytes before writing replacement config', async t => {
    const { root, build, buildZkapiAssets: emit } = await sourceBuildHelpers();
    const outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oa-corrupt-emitted-proof-'));
    t.after(() => fs.rm(outDir, { recursive: true, force: true }));
    await assert.rejects(emit({ network: 'mainnet', deployment: 'fresh-20260928', repoRoot: root, outDir,
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
        'node_modules/@openanonymity/zkapi-browser-sdk': { version: '0.2.0', resolved: 'git+https://github.com/OpenAnonymity/zkapi.git#cf56d67e0c1dd4bc3f3c32392478ce242c746446' }
    } }));
    const result = await zkapiBuildProvenance({ network: 'sepolia', repoRoot, outDir });
    assert.deepEqual(Object.keys(result.files), ['vendor.js']);
    assert.deepEqual(await fs.readdir(outDir), ['vendor.js']);
});
