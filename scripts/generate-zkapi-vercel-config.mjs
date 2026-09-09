import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDemoVercelConfig } from './generate-demo-vercel-config.mjs';
import { resolveZkapiNetwork } from './zkapiBuild.mjs';

const DEPLOYMENTS = Object.freeze({
    sepolia: 'https://d33l4w2z2nh4cg.cloudfront.net',
    mainnet: 'https://d27v1dvkaxfc09.cloudfront.net'
});

export function buildZkapiVercelConfig({ orgOrigin, network }) {
    if (!resolveZkapiNetwork({ OA_ZKAPI_NETWORK: network })) throw new Error('An explicit zkAPI network is required.');
    const config = buildDemoVercelConfig(orgOrigin, false);
    return {
        ...config,
        buildCommand: `OA_ZKAPI_NETWORK=${network} ${config.buildCommand}`,
        build: { env: { ...config.build.env, OA_ZKAPI_NETWORK: network } },
        rewrites: [
            { source: '/zkapi-deployment/:path*', destination: `${DEPLOYMENTS[network]}/:path*` },
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
        network: process.env.OA_ZKAPI_NETWORK
    });
    await fs.writeFile(path.resolve(process.argv[2]), `${JSON.stringify(config, null, 2)}\n`);
}
