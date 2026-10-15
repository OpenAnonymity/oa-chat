import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDemoVercelConfig } from './generate-demo-vercel-config.mjs';
import { planFromRegistry, readZkapiBuildConfig, resolveZkapiNetwork } from './zkapiBuild.mjs';
import { bundlerRoutePath, pinnedBundlerUrl } from '../chat/zkapi/versioning/sponsored.mjs';
import { parseServiceBase, proxyRewrite } from '../chat/zkapi/versioning/serviceBase.mjs';

// The service a reviewed profile pins: an exact credential-free HTTPS origin,
// optionally with a plain path prefix so two deployments can share a hostname
// (versioning/serviceBase.mjs), which the same-origin proxy may forward to.
function protocolService(pins) {
    const service = parseServiceBase(pins.trusted_deployment.protocol_server_url);
    if (!service) {
        throw new Error('The SDK deployment must pin a credential-free HTTPS origin, optionally with a plain path prefix.');
    }
    return service;
}

/**
 * One proxy route per live version of a plan, ordinal ascending (version 1
 * first): `<proxyPath><prefix>/:path*` to that version's pinned protocol base
 * (its origin and path prefix, if any: only the service's own subtree is
 * forwarded, so a version's proxy path never reaches another deployment's
 * routes on a shared hostname). A
 * version whose reviewed profile pins sponsored withdrawals (a `gasless`
 * object with its bundler URL) gets its bundler route first: the exact path
 * `<proxyPath>_bundler` to that URL, listed before the version's own
 * `:path*` rewrite, which would otherwise carry it to the operator's service.
 * Pure.
 */
export function zkapiProxyRewrites(plan) {
    return plan.versions.flatMap(version => {
        const rewrites = [];
        const bundler = pinnedBundlerUrl(version.config?.trusted_deployment?.gasless);
        const route = bundlerRoutePath(version.proxyPath);
        if (bundler && route) rewrites.push({ source: route, destination: bundler });
        rewrites.push(proxyRewrite(version.proxyPath, protocolService(version.config)));
        return rewrites;
    });
}

export function buildZkapiVercelConfig({ orgOrigin, network, deployment: selectedDeployment = process.env.OA_ZKAPI_DEPLOYMENT || '' }) {
    // Asset emission and routing must select the same reviewed deployment.
    // With a deployment, every live version of the network gets its own proxy
    // route (version 1 first, so rewrites[0] is unchanged): a route for a
    // retired version is never emitted, and none is added for a pending one.
    // The plan is static JSON only; the SDK package is not resolved here.
    if (!resolveZkapiNetwork({ OA_ZKAPI_NETWORK: network, OA_ZKAPI_DEPLOYMENT: selectedDeployment })) {
        throw new Error('[build] An explicit zkAPI network is required.');
    }
    const proxies = selectedDeployment
        ? zkapiProxyRewrites(planFromRegistry({ network, deployment: selectedDeployment }))
        : [proxyRewrite('/zkapi-deployment/',
            protocolService(readZkapiBuildConfig({ network, deployment: selectedDeployment })))];
    const config = buildDemoVercelConfig(orgOrigin, false);
    return {
        ...config,
        buildCommand: `OA_ZKAPI_NETWORK=${network}${selectedDeployment ? ` OA_ZKAPI_DEPLOYMENT=${selectedDeployment}` : ''} ${config.buildCommand}`,
        build: { env: { ...config.build.env, OA_ZKAPI_NETWORK: network,
            ...(selectedDeployment ? { OA_ZKAPI_DEPLOYMENT: selectedDeployment } : {}) } },
        rewrites: [
            ...proxies,
            { source: '/zkapi-model-catalog', destination: 'https://openrouter.ai/api/v1/models' },
            ...config.rewrites
        ],
        headers: [{ source: '/(.*)', headers: [
            { key: 'X-Content-Type-Options', value: 'nosniff' },
            { key: 'Referrer-Policy', value: 'no-referrer' },
            { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' }
        ] }, { source: '/zkapi-model-catalog', headers: [{ key: 'Cache-Control', value: 'no-store' }] }]
    };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    if (!process.argv[2]) throw new Error('Provide a destination for the generated Vercel configuration.');
    const config = buildZkapiVercelConfig({
        orgOrigin: process.env.OA_DEPLOYMENT_ORG_ORIGIN,
        network: process.env.OA_ZKAPI_NETWORK,
        deployment: process.env.OA_ZKAPI_DEPLOYMENT || ''
    });
    await fs.writeFile(path.resolve(process.argv[2]), `${JSON.stringify(config, null, 2)}\n`);
}
