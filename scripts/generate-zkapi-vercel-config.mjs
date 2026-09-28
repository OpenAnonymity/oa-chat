import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDemoVercelConfig } from './generate-demo-vercel-config.mjs';
import { readZkapiBuildConfig } from './zkapiBuild.mjs';

export function buildZkapiVercelConfig({ orgOrigin, network, deployment: selectedDeployment = process.env.OA_ZKAPI_DEPLOYMENT || '' }) {
    // Asset emission and routing must select the same reviewed deployment.
    const pins = readZkapiBuildConfig({ network, deployment: selectedDeployment });
    const deployment = new URL(pins.trusted_deployment.protocol_server_url);
    if (deployment.protocol !== 'https:' || deployment.username || deployment.password
        || deployment.pathname !== '/' || deployment.search || deployment.hash) {
        throw new Error('The SDK deployment must pin a credential-free HTTPS origin.');
    }
    const config = buildDemoVercelConfig(orgOrigin, false);
    return {
        ...config,
        buildCommand: `OA_ZKAPI_NETWORK=${network}${selectedDeployment ? ` OA_ZKAPI_DEPLOYMENT=${selectedDeployment}` : ''} ${config.buildCommand}`,
        build: { env: { ...config.build.env, OA_ZKAPI_NETWORK: network,
            ...(selectedDeployment ? { OA_ZKAPI_DEPLOYMENT: selectedDeployment } : {}) } },
        rewrites: [
            { source: '/zkapi-deployment/:path*', destination: `${deployment.origin}/:path*` },
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
