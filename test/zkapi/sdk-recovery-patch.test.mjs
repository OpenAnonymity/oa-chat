import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import esbuild from 'esbuild';
import { ZkapiClient } from '@openanonymity/zkapi-browser-sdk/client';
import walletRuntime from '@openanonymity/zkapi-browser-sdk/runtime';
import { validRegistry } from './_registryFixtures.mjs';

// The install guard is exercised on the dormant registry (version 1 live,
// version 2 pending): the shipped file now has version 2 live on Sepolia, which
// needs its own SDK and pin and is covered by the shipped-registry tests.
const registry = validRegistry();
import patch from '../../patches/zkapi-browser-sdk-wallet-recovery.mjs';
import { patchRegisteredSdks, patchZkapiSdk, zkapiSdkPatchProvenance, zkapiSdkPatches } from '../../scripts/patch-zkapi-sdk.mjs';

const installed = path.dirname(fileURLToPath(import.meta.resolve('@openanonymity/zkapi-browser-sdk/package.json')));
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const digest = value => createHash('sha256').update(value).digest('hex');
const patchFiles = zkapiSdkPatches.flatMap(definition => definition.files);
const sdkFiles = [...new Set(patchFiles.map(entry => entry.file))];
const LEGACY_ALIAS = '@openanonymity/zkapi-browser-sdk';
const LEGACY_PIN = `github:OpenAnonymity/zkapi#${patch.revision}`;

// The reviewed files of the legacy SDK exactly as the registry's revision ships
// them (the installed copy is already patched, so the repairs are undone).
async function writePristineSdk(sdk) {
    await fs.mkdir(sdk, { recursive: true });
    await fs.copyFile(path.join(installed, 'package.json'), path.join(sdk, 'package.json'));
    for (const file of sdkFiles) {
        const chain = patchFiles.filter(entry => entry.file === file);
        let source = await fs.readFile(path.join(installed, file), 'utf8');
        for (const entry of [...chain].reverse()) {
            if (digest(source) === entry.afterSha256) {
                for (const replacement of [...entry.replacements].reverse()) source = source.replace(replacement.after, replacement.before);
            }
        }
        assert.equal(digest(source), chain[0].beforeSha256);
        await fs.mkdir(path.dirname(path.join(sdk, file)), { recursive: true });
        await fs.writeFile(path.join(sdk, file), source);
    }
}

async function pristineFixture(t, { hoisted = false } = {}) {
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'oa-sdk-recovery-patch-'));
    t.after(() => fs.rm(temp, { recursive: true, force: true }));
    const root = hoisted ? path.join(temp, 'node_modules/oa-chat') : temp;
    const sdk = path.join(temp, 'node_modules/@openanonymity/zkapi-browser-sdk');
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ dependencies: { [LEGACY_ALIAS]: LEGACY_PIN } }));
    await writePristineSdk(sdk);
    return { root, sdk };
}

for (const hoisted of [false, true]) {
    test(`pristine ${hoisted ? 'hoisted consumer' : 'local'} SDK applies exactly the reviewed patch and repeated checks do not rewrite it`, async t => {
        const fixture = await pristineFixture(t, { hoisted });
        assert.equal(await patchZkapiSdk(fixture.root), sdkFiles.length);
        const mtimes = [];
        for (const file of sdkFiles) {
            const target = path.join(fixture.sdk, file);
            assert.equal(digest(await fs.readFile(target)), patchFiles.findLast(entry => entry.file === file).afterSha256);
            mtimes.push((await fs.stat(target)).mtimeMs);
        }
        assert.equal(await patchZkapiSdk(fixture.root), 0);
        assert.deepEqual(await Promise.all(sdkFiles.map(async file => (await fs.stat(path.join(fixture.sdk, file))).mtimeMs)), mtimes);
    });
}

test('a changed second SDK file fails before the first file is modified', async t => {
    const fixture = await pristineFixture(t);
    await fs.appendFile(path.join(fixture.sdk, patch.files[1].file), '\n// unexpected SDK change\n');
    await assert.rejects(patchZkapiSdk(fixture.root), /Unexpected zkAPI SDK contents/);
    assert.equal(digest(await fs.readFile(path.join(fixture.sdk, patch.files[0].file))), patch.files[0].beforeSha256);
});

test('an interrupted install resumes from an already reviewed intermediate patch', async t => {
    const fixture = await pristineFixture(t);
    const entry = patchFiles[0];
    const target = path.join(fixture.sdk, entry.file);
    let source = await fs.readFile(target, 'utf8');
    for (const replacement of entry.replacements) source = source.replace(replacement.before, replacement.after);
    assert.equal(digest(source), entry.afterSha256);
    await fs.writeFile(target, source);
    await patchZkapiSdk(fixture.root);
    for (const file of sdkFiles) {
        assert.equal(digest(await fs.readFile(path.join(fixture.sdk, file))),
            patchFiles.findLast(candidate => candidate.file === file).afterSha256);
    }
    assert.equal(await patchZkapiSdk(fixture.root), 0);
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
    const options = { destination: `0x${'12'.repeat(20)}`, expectedWithdrawalOperationId: 'saved-withdrawal', reviewedFunding: null };
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

// ---------------------------------------------------------------------------
// The install-time guard (postinstall, pretest, predev) is driven by the
// registry, the legacy SDK included.
// ---------------------------------------------------------------------------

const SUCCESSOR_ALIAS = 'zkapi-sdk-v2c';

// The registry in its retirement state: version 1 retired on every network,
// version 2 the live one.
function retiredLegacyRegistry() {
    const retired = structuredClone(registry);
    const [legacy, successor] = retired.versions;
    for (const [network, entry] of Object.entries(legacy.networks)) {
        legacy.networks[network] = { status: 'retired', activatedAt: entry.activatedAt, retiredAt: '2027-02-01T00:00:00Z' };
    }
    for (const network of Object.keys(successor.networks)) {
        successor.networks[network] = { status: 'active', activatedAt: '2027-01-01T00:00:00Z', profile: `${network}.json` };
    }
    return retired;
}

// A throwaway checkout holding only what the script reads: itself, the patch,
// a registry, package.json and node_modules. Running the copy executes the real
// main guard against that tree.
async function checkout(t, { registryData = registry, dependencies, legacy = false, successor = false } = {}) {
    const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'oa-patch-guard-')));
    t.after(() => fs.rm(temp, { recursive: true, force: true }));
    for (const file of ['scripts/patch-zkapi-sdk.mjs', 'patches/zkapi-browser-sdk-wallet-recovery.mjs',
        'patches/zkapi-browser-sdk-v2c-recovery.mjs', 'patches/zkapi-browser-sdk-v3-recovery.mjs', 'patches/zkapi-browser-sdk-v3-provider-verification.mjs',
        'patches/zkapi-browser-sdk-v3-gasless-recovery.mjs', 'patches/zkapi-browser-sdk-v3-gasless-provider-verification.mjs', 'patches/zkapi-browser-sdk-v4-recovery.mjs', 'patches/zkapi-browser-sdk-v4-provider-verification.mjs', 'patches/zkapi-browser-sdk-proof-cache.mjs', 'patches/zkapi-browser-sdk-provider-verification.mjs', 'patches/zkapi-browser-sdk-v2c-provider-verification.mjs']) {
        await fs.mkdir(path.dirname(path.join(temp, file)), { recursive: true });
        await fs.copyFile(path.join(repositoryRoot, file), path.join(temp, file));
    }
    await fs.mkdir(path.join(temp, 'deployments/zkapi'), { recursive: true });
    await fs.writeFile(path.join(temp, 'deployments/zkapi/registry.json'), `${JSON.stringify(registryData, null, 2)}\n`);
    await fs.writeFile(path.join(temp, 'package.json'), JSON.stringify({
        dependencies: dependencies ?? {
            ...(legacy ? { [LEGACY_ALIAS]: LEGACY_PIN } : {}),
            ...(successor ? { [SUCCESSOR_ALIAS]: 'github:OpenAnonymity/zkapi#' + 'b'.repeat(40) } : {})
        }
    }));
    const sdk = path.join(temp, 'node_modules', LEGACY_ALIAS);
    if (legacy) await writePristineSdk(sdk);
    if (successor) {
        await fs.mkdir(path.join(temp, 'node_modules', SUCCESSOR_ALIAS), { recursive: true });
        await fs.writeFile(path.join(temp, 'node_modules', SUCCESSOR_ALIAS, 'package.json'),
            JSON.stringify({ name: LEGACY_ALIAS, version: '0.3.0' }));
    }
    return { temp, sdk, script: path.join(temp, 'scripts/patch-zkapi-sdk.mjs') };
}

function runGuard(script, cwd) {
    try {
        return { code: 0, output: execFileSync(process.execPath, [script], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) };
    } catch (error) {
        return { code: error.status, output: `${error.stdout}${error.stderr}` };
    }
}

// The result of a file's whole patch chain (the recovery patch, then the
// compatibility patches that start from its result).
const finalHash = name => patchFiles.filter(entry => entry.file === name).at(-1).afterSha256;

const patchedFiles = async sdk => Promise.all(patch.files.map(async file => digest(await fs.readFile(path.join(sdk, file.file)))));

test('install guard: a live legacy row patches the SDK and a repeat changes nothing', async t => {
    const tree = await checkout(t, { legacy: true });
    const first = runGuard(tree.script, tree.temp);
    assert.equal(first.code, 0, first.output);
    assert.deepEqual(await patchedFiles(tree.sdk), patch.files.map(file => finalHash(file.file)));
    const second = runGuard(tree.script, tree.temp);
    assert.equal(second.code, 0, second.output);
    assert.deepEqual(await patchedFiles(tree.sdk), patch.files.map(file => finalHash(file.file)));
});

test('install guard: a retired legacy row needs neither its package nor its dependency', async t => {
    // The retirement PR's state: the alias is gone from package.json and from
    // node_modules, and only the successor is installed.
    const tree = await checkout(t, { registryData: retiredLegacyRegistry(), successor: true });
    await assert.rejects(fs.stat(path.join(tree.temp, 'node_modules', LEGACY_ALIAS)), { code: 'ENOENT' });
    const outcome = runGuard(tree.script, tree.temp);
    assert.equal(outcome.code, 0, outcome.output);
    assert.match(outcome.output, /Skipping the v1 recovery patch: @openanonymity\/zkapi-browser-sdk is not live on any network/);
});

test('install guard: a retired legacy row that is still installed is left alone, not failed on', async t => {
    // Stale node_modules after a pull that removed the pin must not block pretest.
    const tree = await checkout(t, { registryData: retiredLegacyRegistry(), dependencies: {}, legacy: true, successor: true });
    const outcome = runGuard(tree.script, tree.temp);
    assert.equal(outcome.code, 0, outcome.output);
    assert.deepEqual(await patchedFiles(tree.sdk), patch.files.map(file => file.beforeSha256));
});

test('install guard: a live legacy row still fails loudly when its package, pin or bytes are wrong', async t => {
    const missing = await checkout(t, { dependencies: { [LEGACY_ALIAS]: LEGACY_PIN } });
    const absent = runGuard(missing.script, missing.temp);
    assert.notEqual(absent.code, 0);
    assert.match(absent.output, /zkAPI SDK package @openanonymity\/zkapi-browser-sdk is not installed/);

    const unpinned = await checkout(t, { dependencies: { [SUCCESSOR_ALIAS]: 'github:OpenAnonymity/zkapi#' + 'b'.repeat(40) }, legacy: true });
    const noPin = runGuard(unpinned.script, unpinned.temp);
    assert.notEqual(noPin.code, 0);
    assert.match(noPin.output, /revision changed/);

    const changed = await checkout(t, { legacy: true });
    await fs.appendFile(path.join(changed.sdk, patch.files[0].file), '\n// unexpected SDK change\n');
    const drifted = runGuard(changed.script, changed.temp);
    assert.notEqual(drifted.code, 0);
    assert.match(drifted.output, /Unexpected zkAPI SDK contents/);

    // A row with no network entries is not dormant: it cannot be skipped by
    // accident, so the missing package is still refused.
    const incomplete = structuredClone(registry);
    incomplete.versions[0].networks = {};
    const row = await checkout(t, { registryData: incomplete, dependencies: { [LEGACY_ALIAS]: LEGACY_PIN } });
    assert.notEqual(runGuard(row.script, row.temp).code, 0);
});

test('install guard: runs when started through a symlink to the checkout', async t => {
    const tree = await checkout(t, { legacy: true });
    const link = `${tree.temp}-link`;
    await fs.symlink(tree.temp, link, 'dir');
    t.after(() => fs.rm(link, { force: true }));
    const outcome = runGuard(path.join(link, 'scripts/patch-zkapi-sdk.mjs'), link);
    assert.equal(outcome.code, 0, outcome.output);
    // The guard really ran: the pristine SDK is patched, not silently skipped.
    assert.deepEqual(await patchedFiles(tree.sdk), patch.files.map(file => finalHash(file.file)));
});

test('bundled into another entry file, neither the install guard nor the registry CLI runs', async t => {
    // The unit tests and the Vercel route generator bundle these modules into
    // their own entry file. A main guard that fired there would patch (or
    // fail) at import time, in a directory that is not a checkout.
    const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'oa-bundled-guards-')));
    t.after(() => fs.rm(temp, { recursive: true, force: true }));
    for (const [name, source] of [['patch', 'scripts/patch-zkapi-sdk.mjs'], ['cli', 'scripts/zkapi-registry-cli.mjs']]) {
        const outfile = path.join(temp, `${name}-bundle.mjs`);
        await esbuild.build({
            entryPoints: [path.join(repositoryRoot, source)], outfile, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent'
        });
        const outcome = runGuard(outfile, temp);
        assert.equal(outcome.code, 0, `${source}: ${outcome.output}`);
        assert.equal(outcome.output, '', source);
    }
});

test('patchRegisteredSdks drives every row, legacy included, from its status', async t => {
    const retired = retiredLegacyRegistry();
    const only = await checkout(t, { registryData: retired, successor: true });
    const logs = [];
    assert.equal(await patchRegisteredSdks(only.temp, { rows: retired.versions, log: message => logs.push(message) }), 0);
    assert.equal(logs.length, 1);
    assert.match(logs[0], /v1 recovery patch.*not live on any network/);

    // A dormant default (pending) is quiet; a live row is patched exactly once.
    const pending = structuredClone(registry);
    for (const entry of Object.values(pending.versions[0].networks)) entry.status = 'pending';
    const quiet = await checkout(t, { registryData: pending, legacy: false });
    logs.length = 0;
    assert.equal(await patchRegisteredSdks(quiet.temp, { rows: pending.versions, log: message => logs.push(message) }), 0);
    assert.deepEqual(logs, []);

    // Live on one network is live: patched even though retired on the other.
    const mixed = structuredClone(registry);
    mixed.versions[0].networks.sepolia = { status: 'retired', activatedAt: '2026-09-30T00:00:00Z', retiredAt: '2027-02-01T00:00:00Z' };
    const live = await checkout(t, { registryData: mixed, legacy: true });
    assert.equal(await patchRegisteredSdks(live.temp, { rows: mixed.versions }), sdkFiles.length);
    assert.equal(await patchRegisteredSdks(live.temp, { rows: mixed.versions }), 0);
});
