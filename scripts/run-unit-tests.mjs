import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const testsRoot = path.join(repoRoot, 'test');
const outDir = path.join('/tmp', 'oa-fastchat-unit-tests');

async function pathExists(target) {
    try {
        await fs.access(target);
        return true;
    } catch {
        return false;
    }
}

async function collectTests(dir) {
    if (!(await pathExists(dir))) return [];
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const files = [];
    for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            files.push(...await collectTests(fullPath));
        } else if (entry.isFile() && (entry.name.endsWith('.test.js') || entry.name.endsWith('.test.mjs'))) {
            files.push(fullPath);
        }
    }
    return files;
}

const testFiles = await collectTests(testsRoot);
if (testFiles.length === 0) {
    console.log('No unit tests found.');
    process.exit(0);
}

await fs.rm(outDir, { recursive: true, force: true });
await fs.mkdir(outDir, { recursive: true });

await esbuild.build({
    entryPoints: testFiles,
    bundle: true,
    platform: 'node',
    format: 'esm',
    outdir: outDir,
    outExtension: { '.js': '.mjs' },
    entryNames: '[dir]/[name]',
    absWorkingDir: repoRoot,
    external: ['node:*'],
    logLevel: 'silent'
});

const bundledTests = await collectTests(outDir);
const child = spawn(process.execPath, ['--test', ...bundledTests], {
    stdio: 'inherit'
});

child.on('exit', (code, signal) => {
    if (signal) {
        console.error(`Unit tests terminated by signal ${signal}`);
        process.exit(1);
    }
    process.exit(code ?? 1);
});
