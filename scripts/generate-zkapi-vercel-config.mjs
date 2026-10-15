import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDemoVercelConfig } from './generate-demo-vercel-config.mjs';
import { planFromRegistry, readZkapiBuildConfig, resolveZkapiNetwork } from './zkapiBuild.mjs';
import { bundlerRoutePath, pinnedBundlerUrl } from '../chat/zkapi/versioning/sponsored.mjs';

// The deployment origin a reviewed profile pins, as an exact credential-free
// HTTPS origin the same-origin proxy may forward to.
function protocolOrigin(pins) {
    const deployment = new URL(pins.trusted_deployment.protocol_server_url);
    if (deployment.protocol !== 'https:' || deployment.username || deployment.password
        || deployment.pathname !== '/' || deployment.search || deployment.hash) {
        throw new Error('The SDK deployment must pin a credential-free HTTPS origin.');
    }
    return deployment.origin;
}

/**
 * One proxy route per live version of a plan, ordinal ascending (version 1
 * first): `<proxyPath>:path*` to that version's pinned protocol origin. A
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
        rewrites.push({ source: `${version.proxyPath}:path*`, destination: `${protocolOrigin(version.config)}/:path*` });
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
        : [{ source: '/zkapi-deployment/:path*',
            destination: `${protocolOrigin(readZkapiBuildConfig({ network, deployment: selectedDeployment }))}/:path*` }];
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
