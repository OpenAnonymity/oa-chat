import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs/promises';
import { execSync } from 'node:child_process';
import esbuild from 'esbuild';
import { minify } from 'terser';
import {
    DEFAULT_PRODUCTION_ORG_ORIGIN,
    resolveBuildOrgOrigin,
    resolveBuildWebAuthnRelayUrl
} from './buildConfig.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');

const args = process.argv.slice(2);
const readArg = (name) => {
    const index = args.indexOf(name);
    if (index === -1) return null;
    if (!args[index + 1] || args[index + 1].startsWith('--')) {
        throw new Error(`[build] ${name} requires a value`);
    }
    return args[index + 1];
};
const appEntryArgument = readArg('--app-entry');
const outputDirectoryArgument = readArg('--out-dir');

const srcDir = path.join(repoRoot, 'chat');
const outDir = outputDirectoryArgument
    ? path.resolve(process.cwd(), outputDirectoryArgument)
    : path.join(repoRoot, 'dist');
const assetsDir = path.join(outDir, 'assets');
const vectorDir = path.join(repoRoot, 'vector');
const localInferenceDir = path.join(repoRoot, 'local_inference');
const nanomemDir = path.join(repoRoot, 'nanomem');
const configuredOrgOrigin = resolveBuildOrgOrigin();
const configuredWebAuthnRelayUrl = resolveBuildWebAuthnRelayUrl();
const sameOriginOrgSetting = process.env.OA_ORG_SAME_ORIGIN;
if (sameOriginOrgSetting && !['true', 'false'].includes(sameOriginOrgSetting)) {
    throw new Error('[build] OA_ORG_SAME_ORIGIN must be exactly true or false');
}
const sameOriginOrg = sameOriginOrgSetting === 'true';
if (sameOriginOrg && configuredOrgOrigin) {
    throw new Error('[build] OA_ORG_ORIGIN and OA_ORG_SAME_ORIGIN=true are mutually exclusive');
}
const demoVerifierBypassSetting = process.env.OA_DEMO_VERIFIER_BYPASS;
if (demoVerifierBypassSetting && !['true', 'false'].includes(demoVerifierBypassSetting)) {
    throw new Error('[build] OA_DEMO_VERIFIER_BYPASS must be exactly true or false');
}
const demoVerifierBypass = demoVerifierBypassSetting === 'true';
if (demoVerifierBypass && !sameOriginOrg) {
    throw new Error('[build] verifier bypass is allowed only in an explicit same-origin demo build');
}
const demoProxyUrlSetting = process.env.OA_DEMO_PROXY_URL || '';
if (demoProxyUrlSetting) {
    let demoProxyUrl;
    try {
        demoProxyUrl = new URL(demoProxyUrlSetting);
    } catch {
        throw new Error('[build] OA_DEMO_PROXY_URL must be a valid WSS URL');
    }
    if (!sameOriginOrg || !demoVerifierBypass || demoProxyUrl.protocol !== 'wss:' ||
        demoProxyUrl.username || demoProxyUrl.password || demoProxyUrl.search ||
        demoProxyUrl.hash || demoProxyUrl.pathname !== '/') {
        throw new Error('[build] OA_DEMO_PROXY_URL requires an explicit same-origin verifier-bypass demo and an exact root WSS origin');
    }
}
const verifierOriginSetting = process.env.OA_VERIFIER_ORIGIN || '';
if (verifierOriginSetting) {
    let verifierOrigin;
    try {
        verifierOrigin = new URL(verifierOriginSetting);
    } catch {
        throw new Error('[build] OA_VERIFIER_ORIGIN must be a valid HTTPS origin');
    }
    if (verifierOrigin.protocol !== 'https:' || verifierOrigin.username ||
        verifierOrigin.password || verifierOrigin.pathname !== '/' ||
        verifierOrigin.search || verifierOrigin.hash || verifierOrigin.origin !== verifierOriginSetting) {
        throw new Error('[build] OA_VERIFIER_ORIGIN must be an exact HTTPS origin');
    }
    if (demoVerifierBypass) {
        throw new Error('[build] OA_VERIFIER_ORIGIN cannot be used with verifier bypass');
    }
}

const pathExists = async (target) => {
    try {
        await fs.access(target);
        return true;
    } catch {
        return false;
    }
};

const entryPoints = {
    app: appEntryArgument
        ? path.resolve(process.cwd(), appEntryArgument)
        : path.join(srcDir, 'standalone.js'),
    prelude: path.join(srcDir, 'prelude.js')
};

const toPosixPath = (value) => value.split(path.sep).join('/');

const replaceBundleBlock = (html, name, scriptPath) => {
    const blockRegex = new RegExp(`<!--\\s*BUNDLE:${name}\\s*-->[\\s\\S]*?<!--\\s*\\/BUNDLE:${name}\\s*-->`);
    const tag = `<!-- BUNDLE:${name} -->\n    <script type="module" src="${scriptPath}"></script>\n    <!-- /BUNDLE:${name} -->`;
    if (!blockRegex.test(html)) {
        throw new Error(`Missing BUNDLE:${name} block in index.html`);
    }
    return html.replace(blockRegex, tag);
};

const versionStaticAssetRefs = (html, version) => {
    if (!version) return html;

    const addVersion = (rawUrl) => {
        if (!rawUrl) return rawUrl;
        if (/^(?:[a-z]+:)?\/\//i.test(rawUrl) || rawUrl.startsWith('data:')) return rawUrl;
        if (/[?&]v=/.test(rawUrl)) return rawUrl;
        const joiner = rawUrl.includes('?') ? '&' : '?';
        return `${rawUrl}${joiner}v=${version}`;
    };

    return html
        .replace(/(<link\b[^>]*\bhref=")([^"]+)(")/g, (_, prefix, href, suffix) => {
            return `${prefix}${addVersion(href)}${suffix}`;
        })
        .replace(/(<script\b[^>]*\bsrc=")([^"]+)(")/g, (_, prefix, src, suffix) => {
            return `${prefix}${addVersion(src)}${suffix}`;
        });
};

const collectJsFiles = async (dir) => {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const files = [];
    for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            files.push(...await collectJsFiles(fullPath));
        } else if (entry.isFile() && entry.name.endsWith('.js')) {
            files.push(fullPath);
        }
    }
    return files;
};

const build = async () => {
    if (!(await pathExists(path.join(nanomemDir, 'src')))) {
        try {
            execSync('git submodule update --init nanomem', { cwd: repoRoot, stdio: 'pipe' });
        } catch {
            throw new Error(
                '[build] nanomem submodule is missing and could not be initialized.\n' +
                'Run: git submodule update --init nanomem'
            );
        }
    }

    await fs.rm(outDir, { recursive: true, force: true });
    await fs.mkdir(path.join(repoRoot, 'dist'), { recursive: true });
    await fs.cp(srcDir, outDir, { recursive: true });
    const vectorOutDir = path.join(outDir, 'vector');
    if (await pathExists(vectorOutDir)) {
        const vectorStat = await fs.lstat(vectorOutDir);
        if (vectorStat.isSymbolicLink()) {
            await fs.rm(vectorOutDir, { recursive: true, force: true });
        }
    }
    await fs.mkdir(vectorOutDir, { recursive: true });

    const vectorVendorSrc = path.join(vectorDir, 'vendor');
    if (await pathExists(vectorVendorSrc)) {
        await fs.cp(vectorVendorSrc, path.join(vectorOutDir, 'vendor'), { recursive: true });
    }

    const vectorWasmSrc = path.join(vectorDir, 'wasm');
    if (await pathExists(vectorWasmSrc)) {
        await fs.cp(vectorWasmSrc, path.join(vectorOutDir, 'wasm'), { recursive: true });
    }

    const localInferenceOutDir = path.join(outDir, 'local_inference');
    if (await pathExists(localInferenceOutDir)) {
        const localStat = await fs.lstat(localInferenceOutDir);
        if (localStat.isSymbolicLink()) {
            await fs.rm(localInferenceOutDir, { recursive: true, force: true });
        }
    }
    if (await pathExists(localInferenceDir)) {
        await fs.cp(localInferenceDir, localInferenceOutDir, { recursive: true });
    }

    const nanomemOutDir = path.join(outDir, 'nanomem');
    if (await pathExists(nanomemOutDir)) {
        const nanomemStat = await fs.lstat(nanomemOutDir);
        if (nanomemStat.isSymbolicLink()) {
            await fs.rm(nanomemOutDir, { recursive: true, force: true });
        }
    }
    if (await pathExists(nanomemDir)) {
        await fs.cp(nanomemDir, nanomemOutDir, { recursive: true });
        const nanomemGitDir = path.join(nanomemOutDir, '.git');
        if (await pathExists(nanomemGitDir)) {
            await fs.rm(nanomemGitDir, { recursive: true, force: true });
        }
    }

    const result = await esbuild.build({
        entryPoints,
        bundle: true,
        splitting: true,
        format: 'esm',
        outdir: assetsDir,
        entryNames: '[name]-[hash]',
        chunkNames: 'chunk-[hash]',
        assetNames: 'asset-[hash]',
        target: ['es2020'],
        loader: {
            '.png': 'file',
            '.jpg': 'file',
            '.jpeg': 'file',
            '.gif': 'file',
            '.webp': 'file',
            '.svg': 'file',
            '.woff': 'file',
            '.woff2': 'file',
            '.ttf': 'file',
            '.otf': 'file'
        },
        define: {
            '__DEV__': 'false',
            '__OA_ORG_SAME_ORIGIN__': JSON.stringify(sameOriginOrg),
            '__OA_PRODUCTION_ORG_ORIGIN__': JSON.stringify(
                sameOriginOrg
                    ? ''
                    : configuredOrgOrigin || DEFAULT_PRODUCTION_ORG_ORIGIN
            ),
            '__OA_DEMO_VERIFIER_BYPASS__': JSON.stringify(demoVerifierBypass),
            '__OA_DEMO_PROXY_URL__': JSON.stringify(demoProxyUrlSetting),
            '__OA_VERIFIER_ORIGIN__': JSON.stringify(verifierOriginSetting)
        },
        minify: true,
        metafile: true,
        logLevel: 'silent'
    });

    const outputs = result.metafile.outputs;
    const appEntry = path.resolve(entryPoints.app);
    const preludeEntry = path.resolve(entryPoints.prelude);
    const appOutput = Object.entries(outputs).find(([, info]) => info.entryPoint && path.resolve(info.entryPoint) === appEntry);
    const preludeOutput = Object.entries(outputs).find(([, info]) => info.entryPoint && path.resolve(info.entryPoint) === preludeEntry);

    if (!appOutput || !preludeOutput) {
        throw new Error('Missing expected esbuild outputs for app or prelude.');
    }

    const appScriptPath = toPosixPath(path.relative(outDir, appOutput[0]));
    const preludeScriptPath = toPosixPath(path.relative(outDir, preludeOutput[0]));
    const appCssPath = appOutput[1].cssBundle
        ? toPosixPath(path.relative(outDir, path.resolve(appOutput[1].cssBundle)))
        : null;

    const indexPath = path.join(outDir, 'index.html');
    let html = await fs.readFile(indexPath, 'utf8');

    if (sameOriginOrg || configuredOrgOrigin) {
        // Never warm production-org DNS in a same-origin or staging build.
        const replacement = configuredOrgOrigin
            ? `\n    <link rel="dns-prefetch" href="${configuredOrgOrigin}">`
            : '';
        html = html.replace(
            /\s*<link\s+rel="dns-prefetch"\s+href="https:\/\/org\.openanonymity\.ai"\s*>/g,
            replacement
        );
    }

    html = replaceBundleBlock(html, 'PRELUDE', preludeScriptPath);
    html = replaceBundleBlock(html, 'APP', appScriptPath);
    if (appCssPath) {
        html = html.replace('</head>', `    <link rel="stylesheet" href="${appCssPath}">\n</head>`);
    }

    if (sameOriginOrg) {
        const executableModuleSources = [...html.matchAll(
            /<script\b[^>]*\btype="module"[^>]*\bsrc="([^"]+)"[^>]*>/g
        )].map((match) => match[1].split('?')[0]);
        const uncompiledModules = executableModuleSources.filter(
            (source) => !source.startsWith('assets/')
        );
        if (uncompiledModules.length > 0 || /<script\b[^>]*\btype="module"[^>]*>\s*import\s*\(/.test(html)) {
            throw new Error(
                `[build] same-origin demo contains an uncompiled executable module: ${uncompiledModules.join(', ') || 'inline import'}`
            );
        }
    }

    const appHash = appOutput[0].match(/-([a-z0-9]+)\.js$/i)?.[1];
    html = versionStaticAssetRefs(html, appHash);

    await fs.writeFile(indexPath, html, 'utf8');

    if (sameOriginOrg) {
        // The source tree is copied for non-module runtime assets, but this
        // module is bundled into the executable graph. Do not publish its
        // dormant production fallback in an isolated same-origin demo.
        await fs.rm(path.join(outDir, 'services', 'orgEndpoints.js'), { force: true });
        const publishedJs = await collectJsFiles(outDir);
        for (const filePath of publishedJs) {
            const source = await fs.readFile(filePath, 'utf8');
            if (source.includes('org.openanonymity.ai')) {
                throw new Error(
                    `[build] same-origin demo artifact retains a production-org fallback: ${path.relative(outDir, filePath)}`
                );
            }
        }
    }

    const jsFiles = await collectJsFiles(assetsDir);
    await Promise.all(jsFiles.map(async (filePath) => {
        const code = await fs.readFile(filePath, 'utf8');
        const result = await minify(code, {
            module: true,
            compress: true,
            mangle: true,
            format: { comments: false }
        });
        if (!result.code) {
            throw new Error(`Terser produced no output for ${filePath}`);
        }
        await fs.writeFile(filePath, result.code, 'utf8');
    }));

    // Extract content hash from esbuild output filename for update checking
    if (appHash) {
        await fs.writeFile(
            path.join(outDir, 'build.json'),
            JSON.stringify({
                hash: appHash,
                builtAt: new Date().toISOString(),
                orgOrigin: sameOriginOrg
                    ? 'same-origin'
                    : configuredOrgOrigin || DEFAULT_PRODUCTION_ORG_ORIGIN,
                webauthnRelayUrl: configuredWebAuthnRelayUrl,
                verifierOrigin: verifierOriginSetting || 'https://verifier2.openanonymity.ai'
            }, null, 2)
        );
    }

    console.log(`Built app bundle: ${appScriptPath}`);
    if (appCssPath) console.log(`Built app styles: ${appCssPath}`);
    console.log(`Built prelude bundle: ${preludeScriptPath}`);
    if (appHash) console.log(`Build hash: ${appHash}`);
};

build().catch((error) => {
    console.error('[build] Failed:', error);
    process.exit(1);
});
