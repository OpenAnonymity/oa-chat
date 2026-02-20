import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs/promises';
import esbuild from 'esbuild';
import { minify } from 'terser';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');

const srcDir = path.join(repoRoot, 'chat');
const outDir = path.join(repoRoot, 'dist');
const assetsDir = path.join(outDir, 'assets');
const vectorDir = path.join(repoRoot, 'vector');
const localInferenceDir = path.join(repoRoot, 'local_inference');

const pathExists = async (target) => {
    try {
        await fs.access(target);
        return true;
    } catch {
        return false;
    }
};

const entryPoints = {
    app: path.join(srcDir, 'app.js'),
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

    const result = await esbuild.build({
        absWorkingDir: repoRoot,
        entryPoints,
        bundle: true,
        splitting: true,
        format: 'esm',
        outdir: assetsDir,
        entryNames: '[name]-[hash]',
        chunkNames: 'chunk-[hash]',
        assetNames: 'asset-[hash]',
        target: ['es2020'],
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

    const indexPath = path.join(outDir, 'index.html');
    let html = await fs.readFile(indexPath, 'utf8');

    html = replaceBundleBlock(html, 'PRELUDE', preludeScriptPath);
    html = replaceBundleBlock(html, 'APP', appScriptPath);

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
    const appHash = appOutput[0].match(/-([a-z0-9]+)\.js$/i)?.[1];
    if (appHash) {
        await fs.writeFile(
            path.join(outDir, 'build.json'),
            JSON.stringify({ hash: appHash, builtAt: new Date().toISOString() }, null, 2)
        );
    }

    console.log(`Built app bundle: ${appScriptPath}`);
    console.log(`Built prelude bundle: ${preludeScriptPath}`);
    if (appHash) console.log(`Build hash: ${appHash}`);
};

build().catch((error) => {
    console.error('[build] Failed:', error);
    process.exit(1);
});
