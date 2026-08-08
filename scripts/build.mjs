import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs/promises';
import { execSync } from 'node:child_process';
import esbuild from 'esbuild';
import { minify } from 'terser';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');

const readOption = (name) => {
    const index = process.argv.indexOf(name);
    if (index < 0) return null;
    const value = process.argv[index + 1];
    if (!value || value.startsWith('--')) {
        throw new Error(`[build] ${name} requires a value.`);
    }
    return value;
};

const srcDir = path.join(repoRoot, 'chat');
const appEntry = readOption('--app-entry');
const outputDirectory = readOption('--out-dir');
const outDir = outputDirectory
    ? path.resolve(process.cwd(), outputDirectory)
    : path.join(repoRoot, 'dist');
const assetsDir = path.join(outDir, 'assets');
const vectorDir = path.join(repoRoot, 'vector');
const localInferenceDir = path.join(repoRoot, 'local_inference');
const nanomemDir = path.join(repoRoot, 'nanomem');
const outputMarkerName = '.oa-chat-build-output';

const pathExists = async (target) => {
    try {
        await fs.access(target);
        return true;
    } catch {
        return false;
    }
};

const entryPoints = {
    app: appEntry
        ? path.resolve(process.cwd(), appEntry)
        : path.join(srcDir, 'standalone.js'),
    prelude: path.join(srcDir, 'prelude.js')
};

const toPosixPath = (value) => value.split(path.sep).join('/');

const assertSafeOutputDirectory = async () => {
    const workingDirectory = path.resolve(process.cwd());
    const relative = path.relative(workingDirectory, outDir);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
        throw new Error('[build] --out-dir must be a child directory of the current working directory.');
    }
    const defaultOutputDirectory = path.join(repoRoot, 'dist');
    if (outDir !== defaultOutputDirectory && await pathExists(outDir) &&
        !(await pathExists(path.join(outDir, outputMarkerName)))) {
        throw new Error('[build] Refusing to replace an existing custom directory that was not created by this build helper.');
    }
};

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
    await assertSafeOutputDirectory();
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
    await fs.mkdir(outDir, { recursive: true });
    await fs.writeFile(path.join(outDir, outputMarkerName), 'oa-chat build output\n', 'utf8');
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
        define: { '__DEV__': 'false' },
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

    html = replaceBundleBlock(html, 'PRELUDE', preludeScriptPath);
    html = replaceBundleBlock(html, 'APP', appScriptPath);
    if (appCssPath) {
        html = html.replace(
            '</head>',
            `    <link rel="stylesheet" href="${appCssPath}">\n</head>`
        );
    }

    const appHash = appOutput[0].match(/-([a-z0-9]+)\.js$/i)?.[1];
    html = versionStaticAssetRefs(html, appHash);

    await fs.writeFile(indexPath, html, 'utf8');

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
            JSON.stringify({ hash: appHash, builtAt: new Date().toISOString() }, null, 2)
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
