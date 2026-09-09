import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

export function resolveZkapiNetwork(environment = process.env) {
    const value = environment.OA_ZKAPI_NETWORK || '';
    if (!['', 'sepolia', 'mainnet'].includes(value)) {
        throw new Error('[build] OA_ZKAPI_NETWORK must be sepolia or mainnet, or unset for Tickets only.');
    }
    return value;
}

export function zkapiBuildPlugins(network) {
    if (network) return [];
    return [{
        name: 'omit-disabled-zkapi',
        setup(build) {
            build.onResolve({ filter: /^\.\/zkapi\/index\.js$/ }, args => {
                if (!args.importer.endsWith(`${path.sep}chat${path.sep}startup.js`)) return null;
                return { path: 'disabled', namespace: 'oa-zkapi-disabled' };
            });
            build.onLoad({ filter: /.*/, namespace: 'oa-zkapi-disabled' }, () => ({
                contents: 'export function createZkapiPaymentIntegration() { throw new Error("zkAPI is not enabled in this build."); }',
                loader: 'js'
            }));
        }
    }];
}

export async function buildZkapiAssets({ network, outDir, repoRoot, build }) {
    // The source adapter is bundled into the executable graph, never published
    // as a second unconfigured app beside it. Disabled builds ship no SDK assets.
    const destination = path.join(outDir, 'zkapi');
    await fs.rm(destination, { recursive: true, force: true });
    if (!network) return null;
    const { buildBrowserSdkAssets } = await import('@openanonymity/zkapi-browser-sdk/build');
    const result = await buildBrowserSdkAssets({
        outDir: destination,
        network,
        build,
        publicPath: '/zkapi/'
    });
    await fs.copyFile(path.join(repoRoot, 'chat/zkapi/zkapi.css'), path.join(destination, 'zkapi.css'));
    return result;
}

async function artifactFiles(root, directory = root) {
    const files = {};
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
        const absolute = path.join(directory, entry.name);
        if (entry.isSymbolicLink()) throw new Error(`[build] Unexpected symlink in deployment: ${absolute}`);
        if (entry.isDirectory()) Object.assign(files, await artifactFiles(root, absolute));
        else if (entry.isFile()) {
            const relative = path.relative(root, absolute).split(path.sep).join('/');
            if (relative === 'build.json') continue;
            files[relative] = createHash('sha256').update(await fs.readFile(absolute)).digest('hex');
        }
    }
    return files;
}

export async function zkapiBuildProvenance({ network, repoRoot, outDir, sdkAssets }) {
    if (!network) return null;
    const lock = JSON.parse(await fs.readFile(path.join(repoRoot, 'package-lock.json'), 'utf8'));
    const dependency = lock.packages?.['node_modules/@openanonymity/zkapi-browser-sdk'];
    if (!dependency) throw new Error('[build] The zkAPI SDK must be pinned in package-lock.json.');
    const revision = dependency.resolved?.match(/#([0-9a-f]{40})$/)?.[1];
    if (!revision) throw new Error('[build] The zkAPI SDK dependency must resolve to an immutable Git commit.');
    let oaRevision = process.env.VERCEL_GIT_COMMIT_SHA || null;
    if (!oaRevision) {
        try { oaRevision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim(); }
        catch { /* Source archives may supply their revision through Vercel. */ }
    }
    return {
        network,
        oaChatRevision: oaRevision,
        sdk: { version: dependency.version, revision, assets: sdkAssets?.manifest || null },
        files: await artifactFiles(outDir)
    };
}
