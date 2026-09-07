import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

import { prepareNanomemBrowser } from '../../scripts/prepareNanomemBrowser.mjs';

// Resolve the installed build tool at runtime so the unit-test bundler does not
// inline esbuild's native executable loader into its temporary ESM test file.
const requireFromRepo = createRequire(path.join(process.cwd(), 'package.json'));
const esbuild = requireFromRepo('esbuild');

async function createFixture(t) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'oa-nanomem-browser-test-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    await fs.mkdir(path.join(root, 'nanomem', 'src'), { recursive: true });
    await fs.mkdir(path.join(root, 'chat', 'services'), { recursive: true });
    await fs.writeFile(path.join(root, 'nanomem', 'browser.js'), "export * from './src/browser.js';\n");
    await fs.writeFile(path.join(root, 'nanomem', 'src', 'browser.js'), "export const memory = 'fixture-memory';\n");
    await fs.writeFile(
        path.join(root, 'chat', 'services', 'memoryBridge.js'),
        "export const load = () => import('../nanomem/browser.js');\n"
    );
    return { root, browserPath: path.join(root, 'chat', 'nanomem') };
}

async function bundleMemoryImport(root) {
    return esbuild.build({
        absWorkingDir: root,
        entryPoints: ['chat/services/memoryBridge.js'],
        bundle: true,
        write: false,
        platform: 'browser',
        format: 'esm',
        logLevel: 'silent'
    });
}

async function assertMemoryImportWorks(root) {
    const result = await bundleMemoryImport(root);
    const bundledModule = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
    assert.equal((await bundledModule.load()).memory, 'fixture-memory');
}

test('repairs the missing source link so real browser bundling succeeds', async (t) => {
    const { root, browserPath } = await createFixture(t);

    await assert.rejects(bundleMemoryImport(root), /Could not resolve "\.\.\/nanomem\/browser\.js"/);
    await prepareNanomemBrowser(root);

    assert.equal(await fs.readlink(browserPath), '../nanomem');
    await assertMemoryImportWorks(root);
});

test('preserves the existing tracked source symlink across repeated preparation', async (t) => {
    const { root, browserPath } = await createFixture(t);
    await fs.symlink('../nanomem', browserPath, 'dir');
    const before = await fs.lstat(browserPath);

    await prepareNanomemBrowser(root);
    await prepareNanomemBrowser(root);

    const after = await fs.lstat(browserPath);
    assert.equal(after.ino, before.ino);
    assert.equal(await fs.readlink(browserPath), '../nanomem');
    await assertMemoryImportWorks(root);
});

test('repairs a flattened Git symlink containing the expected target', async (t) => {
    const { root, browserPath } = await createFixture(t);
    await fs.writeFile(browserPath, '../nanomem');

    await assert.rejects(bundleMemoryImport(root), /Could not resolve "\.\.\/nanomem\/browser\.js"/);
    await prepareNanomemBrowser(root);

    assert.equal((await fs.lstat(browserPath)).isSymbolicLink(), true);
    assert.equal(await fs.readlink(browserPath), '../nanomem');
    await assertMemoryImportWorks(root);
});

test('preserves a valid materialized browser package directory', async (t) => {
    const { root, browserPath } = await createFixture(t);
    await fs.cp(path.join(root, 'nanomem'), browserPath, { recursive: true });
    await fs.writeFile(path.join(browserPath, 'keep.txt'), 'keep this file');
    const before = await fs.lstat(browserPath);

    await prepareNanomemBrowser(root);

    const after = await fs.lstat(browserPath);
    assert.equal(after.isDirectory(), true);
    assert.equal(after.ino, before.ino);
    assert.equal(await fs.readFile(path.join(browserPath, 'keep.txt'), 'utf8'), 'keep this file');
    await assertMemoryImportWorks(root);
});

test('rejects an unexpected source file without changing it', async (t) => {
    const { root, browserPath } = await createFixture(t);
    await fs.writeFile(browserPath, 'user-owned contents');
    const before = await fs.lstat(browserPath);

    await assert.rejects(prepareNanomemBrowser(root), /Unexpected chat\/nanomem contents.*left unchanged/);

    assert.equal((await fs.lstat(browserPath)).ino, before.ino);
    assert.equal(await fs.readFile(browserPath, 'utf8'), 'user-owned contents');
});

test('rejects an unexpected source directory without deleting its contents', async (t) => {
    const { root, browserPath } = await createFixture(t);
    await fs.mkdir(browserPath);
    await fs.writeFile(path.join(browserPath, 'keep.txt'), 'user-owned contents');
    const before = await fs.lstat(browserPath);

    await assert.rejects(prepareNanomemBrowser(root), /Unexpected chat\/nanomem contents.*left unchanged/);

    assert.equal((await fs.lstat(browserPath)).ino, before.ino);
    assert.equal(await fs.readFile(path.join(browserPath, 'keep.txt'), 'utf8'), 'user-owned contents');
});

test('rejects an unexpected symlink target without changing the link or its target', async (t) => {
    const { root, browserPath } = await createFixture(t);
    const otherDirectory = path.join(root, 'other-package');
    await fs.mkdir(otherDirectory);
    await fs.writeFile(path.join(otherDirectory, 'keep.txt'), 'user-owned contents');
    await fs.symlink('../other-package', browserPath, 'dir');
    const before = await fs.lstat(browserPath);

    await assert.rejects(prepareNanomemBrowser(root), /chat\/nanomem must point to \.\.\/nanomem.*left unchanged/);

    assert.equal((await fs.lstat(browserPath)).ino, before.ino);
    assert.equal(await fs.readlink(browserPath), '../other-package');
    assert.equal(await fs.readFile(path.join(otherDirectory, 'keep.txt'), 'utf8'), 'user-owned contents');
});

for (const missingEntry of ['browser.js', 'src/browser.js']) {
    test(`rejects a missing root nanomem/${missingEntry} before altering chat source`, async (t) => {
        const { root, browserPath } = await createFixture(t);
        await fs.rm(path.join(root, 'nanomem', missingEntry));
        await fs.writeFile(browserPath, '../nanomem');
        const before = await fs.lstat(browserPath);

        await assert.rejects(prepareNanomemBrowser(root), (error) => {
            assert.ok(error.message.includes(`Missing nanomem/${missingEntry}`));
            assert.match(error.message, /Initialize the complete nanomem submodule/);
            return true;
        });

        assert.equal((await fs.lstat(browserPath)).ino, before.ino);
        assert.equal(await fs.readFile(browserPath, 'utf8'), '../nanomem');
    });
}
