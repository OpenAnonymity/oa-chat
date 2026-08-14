import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function buildDemoVercelConfig(rawOrgOrigin, enableVerifierBypass = false, demoProxyUrl = '') {
    let orgOrigin;
    try {
        orgOrigin = new URL(String(rawOrgOrigin || ''));
    } catch {
        throw new Error('OA_DEMO_ORG_ORIGIN must be a valid HTTPS origin');
    }
    if (
        orgOrigin.protocol !== 'https:' ||
        orgOrigin.username ||
        orgOrigin.password ||
        orgOrigin.pathname !== '/' ||
        orgOrigin.search ||
        orgOrigin.hash
    ) {
        throw new Error('OA_DEMO_ORG_ORIGIN must be an exact HTTPS origin');
    }

    const origin = orgOrigin.origin;
    let proxyBuildSetting = '';
    if (demoProxyUrl) {
        let proxyUrl;
        try {
            proxyUrl = new URL(demoProxyUrl);
        } catch {
            throw new Error('OA_DEMO_PROXY_URL must be a valid WSS URL');
        }
        if (proxyUrl.protocol !== 'wss:' || proxyUrl.username || proxyUrl.password ||
            proxyUrl.search || proxyUrl.hash || !proxyUrl.pathname.endsWith('/')) {
            throw new Error('OA_DEMO_PROXY_URL must be an exact WSS endpoint ending in /');
        }
        proxyBuildSetting = ` OA_DEMO_PROXY_URL=${proxyUrl.toString()}`;
    }
    return {
        outputDirectory: 'dist',
        buildCommand: `OA_ORG_SAME_ORIGIN=true OA_DEMO_VERIFIER_BYPASS=${enableVerifierBypass ? 'true' : 'false'}${proxyBuildSetting} npm run build`,
        rewrites: [
            { source: '/auth/:path*', destination: `${origin}/auth/:path*` },
            { source: '/api/:path*', destination: `${origin}/api/:path*` },
            { source: '/chat/:path*', destination: `${origin}/chat/:path*` },
            { source: '/(.*)', destination: '/index.html' }
        ]
    };
}

async function main() {
    const outputPath = process.argv[2];
    if (!outputPath) {
        throw new Error('Pass an explicit output path for the generated Vercel config');
    }
    const bypassSetting = process.env.OA_DEMO_VERIFIER_BYPASS;
    if (bypassSetting && !['true', 'false'].includes(bypassSetting)) {
        throw new Error('OA_DEMO_VERIFIER_BYPASS must be exactly true or false');
    }
    const config = buildDemoVercelConfig(
        process.env.OA_DEMO_ORG_ORIGIN,
        bypassSetting === 'true',
        process.env.OA_DEMO_PROXY_URL || ''
    );
    await fs.writeFile(
        path.resolve(outputPath),
        `${JSON.stringify(config, null, 2)}\n`,
        'utf8'
    );
}

const isMain = process.argv[1] && (
    path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
);
if (isMain) {
    main().catch(error => {
        console.error(error.message);
        process.exitCode = 1;
    });
}
