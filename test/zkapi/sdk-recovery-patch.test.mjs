import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { ZkapiClient } from '@openanonymity/zkapi-browser-sdk/client';
import walletRuntime from '@openanonymity/zkapi-browser-sdk/runtime';
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

test('recovery binding preserves Sepolia mutual authentication and password-free escape', async t => {
    const previousAuth = walletRuntime.testnetAuth;
    t.after(() => { walletRuntime.testnetAuth = previousAuth; });
    let passwordAccepted = false;
    const prompts = [];
    walletRuntime.testnetAuth = { async ensure(options) {
        prompts.push(options);
        if (!passwordAccepted) throw Object.assign(new Error('Sepolia password required or invalid'), {
            code: 'testnet_password_required'
        });
    } };
    const client = new ZkapiClient();
    client.browserMode = true;
    const options = { destination: `0x${'12'.repeat(20)}`, expectedWithdrawalOperationId: 'saved-withdrawal' };
    const withdrawals = [];
    t.mock.method(client, 'performWithdrawal', async (mode, _status, received) => {
        withdrawals.push({ mode, ...received });
        return { mode };
    });
    assert.deepEqual(await client.withdraw('escape', undefined, options), { mode: 'escape' });
    assert.deepEqual(prompts, []);
    assert.deepEqual(withdrawals, [{ mode: 'escape', ...options }]);
    await assert.rejects(client.withdraw('mutual', undefined, options), { code: 'testnet_password_required' });
    assert.equal(withdrawals.length, 1, 'denied authentication must not begin withdrawal recovery');
    passwordAccepted = true;
    assert.deepEqual(await client.withdraw('mutual', undefined, options), { mode: 'mutual' });
    assert.deepEqual(withdrawals[1], { mode: 'mutual', ...options });
    assert.deepEqual(prompts, [{ interactive: true }, { interactive: true }]);
});

test('recovery operations with the same destination keep distinct in-flight identities', async t => {
    const client = new ZkapiClient();
    let complete;
    t.mock.method(client, 'performWithdrawal', async () => new Promise(resolve => { complete = resolve; }));
    const options = { destination: `0x${'12'.repeat(20)}`, expectedWithdrawalOperationId: 'original' };
    const original = client.withdraw('escape', undefined, options);
    await assert.rejects(client.withdraw('escape', undefined, { ...options, expectedWithdrawalOperationId: 'successor' }),
        /different withdrawal action is already running/);
    complete({ mode: 'escape' });
    assert.deepEqual(await original, { mode: 'escape' });
});

for (const [originalNote, nextNote] of [[7, 8], [7, null], [null, 8]]) {
    test(`mutual withdrawal refuses a note changed from ${originalNote} to ${nextNote} during the password dialog`, async t => {
        const previousAuth = walletRuntime.testnetAuth;
        t.after(() => { walletRuntime.testnetAuth = previousAuth; });
        const client = new ZkapiClient();
        client.browserMode = true;
        client.wallet = { note: originalNote == null ? null : { note_id: originalNote } };
        walletRuntime.testnetAuth = { async ensure() {
            client.wallet.note = nextNote == null ? null : { note_id: nextNote };
        } };
        t.mock.method(client, 'assertBalanceNotClaimed', async () => assert.fail('the changed note must never enter withdrawal'));
        await assert.rejects(client.withdraw('mutual', undefined, {
            destination: `0x${'12'.repeat(20)}`, expectedWithdrawalOperationId: 'original-withdrawal'
        }), /private balance changed while withdrawal was opening/i);
        assert.equal(client.withdrawPromise, null);
    });
}
