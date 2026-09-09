import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const testsRoot = path.join(repoRoot, 'test');
const outDirPrefix = path.join('/tmp', 'oa-fastchat-unit-tests-');

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

const paymentTestsRoot = path.join(testsRoot, 'zkapi');
const testFiles = (await collectTests(testsRoot)).filter(file => !file.startsWith(`${paymentTestsRoot}${path.sep}`));
const paymentTestFiles = await fs.readdir(paymentTestsRoot).then(entries => entries
    .filter(name => /\.test\.(?:mjs|cjs)$/.test(name))
    .sort()
    .map(name => path.join(paymentTestsRoot, name))).catch(error => {
    if (error.code === 'ENOENT') return [];
    throw error;
});
if (testFiles.length === 0) {
    console.log('No unit tests found.');
    process.exit(0);
}

// Parallel worktrees and review agents must not overwrite one shared bundle
// while another Node test process is still reading it.
const outDir = await fs.mkdtemp(outDirPrefix);

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
// These bundled tests share browser/global shims and a single temporary output
// directory. Node 24's isolated workers can corrupt verifier-suite IPC even at
// concurrency one, so keep the repository test group serial and in-process.
const child = spawn(process.execPath, [
    '--test',
    '--test-force-exit',
    '--test-concurrency=1',
    '--test-isolation=none',
    ...bundledTests
], {
    stdio: 'inherit'
});

child.on('exit', async (code, signal) => {
    await fs.rm(outDir, { recursive: true, force: true });
    if (signal) {
        console.error(`Unit tests terminated by signal ${signal}`);
        process.exit(1);
    }
    if (code !== 0 || !paymentTestFiles.length) process.exit(code ?? 1);
    // The native payment tests retain their source-relative fixtures and SDK
    // package resolution. Run them in isolated processes so their browser
    // shims cannot replace the legacy suite's shared globals.
    const payments = spawn(process.execPath, [
        '--test', '--test-force-exit', '--test-concurrency=1', ...paymentTestFiles
    ], { stdio: 'inherit', cwd: repoRoot });
    payments.on('error', error => { console.error(error); process.exit(1); });
    payments.on('exit', (paymentCode, paymentSignal) => process.exit(paymentSignal ? 1 : paymentCode ?? 1));
});
