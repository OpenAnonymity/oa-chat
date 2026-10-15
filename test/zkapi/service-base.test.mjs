// One hostname for several deployments: the service base URL
// (chat/zkapi/versioning/serviceBase.mjs).
//
// Two protocol generations answer on the same route names (`/v2/...`,
// `/v1/tree/snapshot`, `/config.json`), and the browser can vary nothing but
// the URL path, so an operator who serves both from one hostname puts the
// newer one under a plain path prefix and the pin names it. What is pinned
// here:
//
//   - the shape rules (what a prefix may be, what is reserved, what is exact);
//   - which pairs of bases are distinct services and which overlap;
//   - the proxy rewrite a version gets: only its own subtree is forwarded,
//     the prefix on both sides, and a root deployment's rewrite is the one it
//     always had;
//   - that the real SDKs (the installed legacy one, and a successor when one
//     is present) turn a URL under a prefix into the proxy URL this rewrite
//     forwards, so the pieces agree end to end.
//
// The registry and adapter rules that use these helpers are in
// zkapi-registry-model.test.mjs and zkapi-snapshot-adapters.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { webcrypto } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
    MAX_PREFIX_SEGMENTS, RESERVED_PREFIX_SEGMENTS, parseServiceBase, pathPrefix, proxyRewrite, servicesOverlap
} from '../../chat/zkapi/versioning/serviceBase.mjs';
import { buildZkapiVercelConfig, zkapiProxyRewrites } from '../../scripts/generate-zkapi-vercel-config.mjs';
import { createFakeEnvironment, createFakeStorage } from './_fakeIndexedDb.mjs';

const repoRoot = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));

test('a base is an origin, or an origin and a plain prefix written exactly', () => {
    const accepted = [
        ['https://zkapi.example.com', '', 'https://zkapi.example.com'],
        ['https://zkapi.example.com/', '', 'https://zkapi.example.com'],
        ['https://zkapi.example.com/c', '/c', 'https://zkapi.example.com/c'],
        ['https://zkapi.example.com/zkapi-v2c', '/zkapi-v2c', 'https://zkapi.example.com/zkapi-v2c'],
        ['https://zkapi.example.com/a/b/c', '/a/b/c', 'https://zkapi.example.com/a/b/c'],
        // A prefix named after the deployment's protocol version, the
        // convention of the guide: the dots are plain characters of a segment.
        ['https://zkapi.example.com/v0.2', '/v0.2', 'https://zkapi.example.com/v0.2'],
        ['https://zkapi.example.com/v0.3', '/v0.3', 'https://zkapi.example.com/v0.3'],
        ['https://zkapi.example.com/v1.0', '/v1.0', 'https://zkapi.example.com/v1.0'],
        ['https://zkapi.example.com/v0.2.1', '/v0.2.1', 'https://zkapi.example.com/v0.2.1'],
        ['https://zkapi.example.com:8443/c', '/c', 'https://zkapi.example.com:8443/c']
    ];
    for (const [value, prefix, base] of accepted) {
        const parsed = parseServiceBase(value);
        assert.ok(parsed, value);
        assert.equal(parsed.prefix, prefix, value);
        assert.equal(parsed.base, base, value);
        assert.equal(parsed.origin, new URL(value).origin, value);
    }
    const refused = [
        'http://zkapi.example.com/c', 'https://u:p@zkapi.example.com/c', 'https://zkapi.example.com/c?x=1',
        'https://zkapi.example.com/c#top', 'https://zkapi.example.com/c/', 'https://zkapi.example.com//c',
        'https://zkapi.example.com/c//d', 'https://zkapi.example.com/%2e%2e/c', 'https://zkapi.example.com/c%2Fd',
        'https://zkapi.example.com/a/b/c/d', 'https://zkapi.example.com/c.', 'https://zkapi.example.com/-c',
        'https://zkapi.example.com/' + 'x'.repeat(70), 'not a url', '', undefined, null
    ];
    for (const value of refused) assert.equal(parseServiceBase(value), null, String(value));
    assert.equal(MAX_PREFIX_SEGMENTS, 3);
});

test('the protocol\'s own route names and this app\'s proxy name cannot be a prefix', () => {
    assert.deepEqual([...RESERVED_PREFIX_SEGMENTS].sort(), ['_bundler', 'config.json', 'v1', 'v2']);
    for (const name of RESERVED_PREFIX_SEGMENTS) {
        for (const spelled of [name, name.toUpperCase()]) {
            assert.equal(pathPrefix(`/${spelled}`), null, spelled);
            assert.equal(pathPrefix(`/${spelled}/x`), null, `${spelled}/x`);
        }
    }
    // Only the first segment is reserved: it is the one that would shadow a
    // root deployment's route.
    assert.equal(pathPrefix('/c/v2'), '/c/v2');
    assert.equal(pathPrefix('/v2c'), '/v2c');
    // The bare registry ids are the protocol's own API route names and cannot
    // be a prefix; a version number with a dot is a different segment.
    assert.equal(pathPrefix('/v1'), null);
    assert.equal(pathPrefix('/v2'), null);
    for (const name of ['v0.2', 'v0.3', 'v1.0', 'v2.0', 'v10', 'v3']) assert.equal(pathPrefix(`/${name}`), `/${name}`, name);
    // A trailing dot is not a version number.
    assert.equal(pathPrefix('/v0.'), null);
});

test('two services overlap when they are the same base or one prefix contains another', () => {
    const at = value => parseServiceBase(value);
    const overlap = (left, right) => servicesOverlap(at(left), at(right));
    const host = 'https://zkapi.example.com';
    // A root and a prefix of one hostname are distinct: the root's routes are
    // fixed names and a prefix never starts with one.
    assert.equal(overlap(host, `${host}/c`), false);
    assert.equal(overlap(`${host}/c`, host), false);
    assert.equal(overlap(`${host}/c`, `${host}/d`), false);
    assert.equal(overlap(`${host}/c`, `${host}/cc`), false, 'a sibling that starts with the same letters');
    // Successive upgrades side by side: 0.2 is not inside 0.20, and 0.2 is
    // distinct from 0.3 and 1.0; only a nested path overlaps.
    assert.equal(overlap(`${host}/v0.2`, `${host}/v0.20`), false);
    assert.equal(overlap(`${host}/v0.2`, `${host}/v0.3`), false);
    assert.equal(overlap(`${host}/v0.2`, `${host}/v1.0`), false);
    assert.equal(overlap(`${host}/v0.2`, `${host}/v0.2/next`), true);
    assert.equal(overlap(host, host), true);
    assert.equal(overlap(host, `${host}/`), true);
    assert.equal(overlap(`${host}/c`, `${host}/c`), true);
    assert.equal(overlap(`${host}/c`, `${host}/c/next`), true);
    assert.equal(overlap(`${host}/c/next`, `${host}/c`), true);
    // Other hostnames never overlap, whatever the path.
    assert.equal(overlap(`${host}/c`, 'https://other.example.com/c'), false);
    assert.equal(overlap(host, 'https://other.example.com'), false);
    assert.equal(servicesOverlap(null, at(host)), false);
});

test('a version\'s proxy rewrite forwards its own subtree, with the prefix on both sides', () => {
    // The root deployment keeps the rewrite it always had.
    assert.deepEqual(proxyRewrite('/zkapi-deployment/', 'https://zkapi.example.com'),
        { source: '/zkapi-deployment/:path*', destination: 'https://zkapi.example.com/:path*' });
    assert.deepEqual(proxyRewrite('/zkapi-deployment-v2c/', 'https://zkapi.example.com/c'),
        { source: '/zkapi-deployment-v2c/c/:path*', destination: 'https://zkapi.example.com/c/:path*' });
    assert.deepEqual(proxyRewrite('/zkapi-deployment-v3c/', 'https://zkapi.example.com/a/b'),
        { source: '/zkapi-deployment-v3c/a/b/:path*', destination: 'https://zkapi.example.com/a/b/:path*' });
    assert.deepEqual(proxyRewrite('/zkapi-deployment-v2c/', 'https://zkapi.example.com/v0.2'),
        { source: '/zkapi-deployment-v2c/v0.2/:path*', destination: 'https://zkapi.example.com/v0.2/:path*' });
    // Anything unusable is null, never a rewrite that forwards more than asked.
    assert.equal(proxyRewrite('zkapi-deployment/', 'https://zkapi.example.com'), null);
    assert.equal(proxyRewrite('/zkapi-deployment', 'https://zkapi.example.com'), null);
    assert.equal(proxyRewrite('/zkapi-deployment//', 'https://zkapi.example.com'), null);
    assert.equal(proxyRewrite('/zkapi-deployment/', 'https://zkapi.example.com/c/'), null);
    assert.equal(proxyRewrite('/zkapi-deployment/', 'http://zkapi.example.com'), null);
});

test('the generated configuration routes each version to its own subtree, bundler route first', () => {
    const profile = (url, gasless = null) => ({ trusted_deployment: { protocol_server_url: url, gasless } });
    const plan = {
        versions: [
            { proxyPath: '/zkapi-deployment/', config: profile('https://zkapi.example.com') },
            { proxyPath: '/zkapi-deployment-v2c/', config: profile('https://zkapi.example.com/v0.2', {
                deployment_status: 'deployed', bundler_url: 'https://bundler.example.com/rpc'
            }) }
        ]
    };
    // The bundler's own profile object is only read for its URL here; an
    // incomplete one is the registry's concern, not the generator's.
    assert.deepEqual(zkapiProxyRewrites(plan), [
        { source: '/zkapi-deployment/:path*', destination: 'https://zkapi.example.com/:path*' },
        { source: '/zkapi-deployment-v2c/_bundler', destination: 'https://bundler.example.com/rpc' },
        { source: '/zkapi-deployment-v2c/v0.2/:path*', destination: 'https://zkapi.example.com/v0.2/:path*' }
    ]);
    // A version's proxy path does not reach another deployment's routes on the
    // shared hostname: nothing here forwards `/zkapi-deployment-v2c/v2/...`.
    const sources = zkapiProxyRewrites(plan).map(rewrite => rewrite.source);
    assert.equal(sources.some(source => source === '/zkapi-deployment-v2c/:path*'), false);
    // A pin the generator cannot route is a build failure, not a broad rewrite.
    assert.throws(() => zkapiProxyRewrites({
        versions: [{ proxyPath: '/zkapi-deployment/', config: profile('https://zkapi.example.com/c/') }]
    }), /plain path prefix/);
    assert.equal(typeof buildZkapiVercelConfig, 'function');
});

// ---------------------------------------------------------------------------
// The real SDKs agree with the rewrite
// ---------------------------------------------------------------------------

function successorRoot() {
    if (process.env.ZKAPI_V2_SDK_DIR) {
        const root = path.resolve(process.env.ZKAPI_V2_SDK_DIR);
        return fs.existsSync(path.join(root, 'sdk/wallet.js')) ? root : null;
    }
    const registry = JSON.parse(fs.readFileSync(path.join(repoRoot, 'deployments/zkapi/registry.json'), 'utf8'));
    for (const row of registry.versions) {
        if (row.sdk.alias === '@openanonymity/zkapi-browser-sdk') continue;
        const root = path.join(repoRoot, 'node_modules', row.sdk.alias);
        if (fs.existsSync(path.join(root, 'sdk/wallet.js'))) return root;
    }
    return null;
}

const legacyRuntimeFile = path.join(repoRoot, 'node_modules/@openanonymity/zkapi-browser-sdk/sdk/services/browserWalletRuntime.js');
const successor = successorRoot();
const candidates = [
    ['the installed legacy SDK', fs.existsSync(legacyRuntimeFile) ? legacyRuntimeFile : null],
    ['the successor SDK', successor ? path.join(successor, 'sdk/services/browserWalletRuntime.js') : null]
].filter(([, file]) => file !== null);

async function loadRuntime(file) {
    if (!globalThis.crypto) globalThis.crypto = webcrypto;
    createFakeEnvironment().install();
    globalThis.localStorage ??= createFakeStorage();
    globalThis.location = { href: 'https://app.example/', origin: 'https://app.example', search: '' };
    globalThis.window ??= { dispatchEvent() {}, addEventListener() {}, removeEventListener() {}, setInterval: () => 0, clearInterval() {} };
    globalThis.CustomEvent ??= class CustomEvent extends Event {
        constructor(type, options) { super(type); this.detail = options?.detail; }
    };
    return (await import(pathToFileURL(file).href)).default;
}

for (const [label, file] of candidates) {
    test(`${label} maps a URL under a prefix to the proxy URL that the rewrite forwards`, async () => {
        const runtime = await loadRuntime(file);
        const service = parseServiceBase('https://zkapi.example.com/v0.2');
        const config = {
            deployment_api_proxy_path: '/zkapi-deployment-v2c/',
            deployment_manifest_url: `${service.base}/config.json`,
            allowed_deployment_manifest_urls: [`${service.base}/config.json`],
            trusted_deployment: { protocol_server_url: service.base, indexer_url: service.base }
        };
        const rewrite = proxyRewrite('/zkapi-deployment-v2c/', service);
        const pattern = new RegExp(`^${rewrite.source.replace(':path*', '(.*)')}$`);
        const routes = ['/v2/billing/quote', '/v2/openrouter/leases/abc', '/v1/tree/snapshot', '/config.json'];
        for (const route of routes) {
            const target = `${service.base}${route}`;
            const proxied = new URL(runtime.deploymentProxyUrl.call({ browserConfig: config }, target));
            assert.equal(proxied.origin, 'https://app.example', route);
            // The page asks its own origin; the rewrite forwards exactly the
            // URL the service is pinned at, route by route.
            const match = pattern.exec(proxied.pathname);
            assert.ok(match, `${route}: ${proxied.pathname} matches ${rewrite.source}`);
            assert.equal(`${service.origin}${service.prefix}/${match[1]}`, target, route);
        }
        // A root deployment on the same hostname is untouched by the prefix.
        const root = { ...config, deployment_api_proxy_path: '/zkapi-deployment/', deployment_manifest_url: 'https://zkapi.example.com/config.json',
            allowed_deployment_manifest_urls: ['https://zkapi.example.com/config.json'],
            trusted_deployment: { protocol_server_url: 'https://zkapi.example.com', indexer_url: 'https://zkapi.example.com' } };
        assert.equal(runtime.deploymentProxyUrl.call({ browserConfig: root }, 'https://zkapi.example.com/v2/billing/quote'),
            'https://app.example/zkapi-deployment/v2/billing/quote');
    });
}

test('at least one SDK was read for the end-to-end check', { skip: candidates.length > 0 ? false : 'no SDK is installed' }, () => {
    assert.ok(candidates.length >= 1);
});
