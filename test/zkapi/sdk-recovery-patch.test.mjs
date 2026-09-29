import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import patch from '../../patches/zkapi-browser-sdk-wallet-recovery.mjs';
import { patchZkapiSdk, zkapiSdkPatchProvenance } from '../../scripts/patch-zkapi-sdk.mjs';

const installed = path.dirname(fileURLToPath(import.meta.resolve('@openanonymity/zkapi-browser-sdk/package.json')));
const digest = value => createHash('sha256').update(value).digest('hex');

async function pristineFixture(t, { hoisted = false } = {}) {
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'oa-sdk-recovery-patch-'));
    t.after(() => fs.rm(temp, { recursive: true, force: true }));
    const root = hoisted ? path.join(temp, 'node_modules/oa-chat') : temp;
    const sdk = path.join(temp, 'node_modules/@openanonymity/zkapi-browser-sdk');
    await fs.mkdir(root, { recursive: true });
    await fs.mkdir(sdk, { recursive: true });
    await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ dependencies: {
        '@openanonymity/zkapi-browser-sdk': `github:OpenAnonymity/zkapi#${patch.revision}`
    } }));
    await fs.copyFile(path.join(installed, 'package.json'), path.join(sdk, 'package.json'));
    for (const file of patch.files) {
        let source = await fs.readFile(path.join(installed, file.file), 'utf8');
        if (digest(source) === file.afterSha256) {
            for (const replacement of [...file.replacements].reverse()) source = source.replace(replacement.after, replacement.before);
        }
        assert.equal(digest(source), file.beforeSha256);
        await fs.mkdir(path.dirname(path.join(sdk, file.file)), { recursive: true });
        await fs.writeFile(path.join(sdk, file.file), source);
    }
    return { root, sdk };
}

for (const hoisted of [false, true]) {
    test(`pristine ${hoisted ? 'hoisted consumer' : 'local'} SDK applies exactly the reviewed patch and repeated checks do not rewrite it`, async t => {
        const fixture = await pristineFixture(t, { hoisted });
        assert.equal(await patchZkapiSdk(fixture.root), 2);
        const mtimes = [];
        for (const file of patch.files) {
            const target = path.join(fixture.sdk, file.file);
            assert.equal(digest(await fs.readFile(target)), file.afterSha256);
            mtimes.push((await fs.stat(target)).mtimeMs);
        }
        assert.equal(await patchZkapiSdk(fixture.root), 0);
        assert.deepEqual(await Promise.all(patch.files.map(async file => (await fs.stat(path.join(fixture.sdk, file.file))).mtimeMs)), mtimes);
    });
}

test('a changed second SDK file fails before the first file is modified', async t => {
    const fixture = await pristineFixture(t);
    await fs.appendFile(path.join(fixture.sdk, patch.files[1].file), '\n// unexpected SDK change\n');
    await assert.rejects(patchZkapiSdk(fixture.root), /Unexpected zkAPI SDK contents/);
    assert.equal(digest(await fs.readFile(path.join(fixture.sdk, patch.files[0].file))), patch.files[0].beforeSha256);
});

test('a changed SDK pin requires review rather than silently applying a previous repair', async t => {
    const fixture = await pristineFixture(t);
    await fs.writeFile(path.join(fixture.root, 'package.json'), JSON.stringify({ dependencies: {
        '@openanonymity/zkapi-browser-sdk': 'github:OpenAnonymity/zkapi#main'
    } }));
    await assert.rejects(patchZkapiSdk(fixture.root), /revision changed/);
});

test('provenance identifies the exact patch and patched source files', () => {
    const record = zkapiSdkPatchProvenance();
    assert.equal(record.revision, patch.revision);
    assert.equal(record.sha256, digest(JSON.stringify(patch)));
    assert.deepEqual(record.files, Object.fromEntries(patch.files.map(file => [file.file, file.afterSha256])));
});
