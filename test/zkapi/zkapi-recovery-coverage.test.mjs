import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import patch from '../../patches/zkapi-browser-sdk-wallet-recovery.mjs';
import patchV2c from '../../patches/zkapi-browser-sdk-v2c-recovery.mjs';
import { ADAPTER_IDS, getAdapter } from '../../chat/zkapi/versioning/adapters/index.mjs';
import { RegistryError } from '../../chat/zkapi/versioning/registryModel.mjs';
import { WIRED } from '../../chat/zkapi/versioning/wiring.mjs';
import { PATCH_COVERAGE, zkapiSdkPatchProvenance } from '../../scripts/patch-zkapi-sdk.mjs';
import {
    SDK_HALF_WIRING,
    assertRecoveryCoverage,
    planFromRegistry,
    recoveryCoverageGaps,
    reviewedRecoveryPatches
} from '../../scripts/zkapiRegistry.mjs';
import {
    activatedRegistry,
    fixtureProfiles,
    mutated,
    rollbackRegistry,
    threeVersionRegistry,
    validRegistry,
    validate
} from './_registryFixtures.mjs';

// A live row of a protocol family that lists `withdrawal-operation-recheck`
// needs the SDK itself to refuse a withdrawal that was replaced after it was
// displayed; the host can only narrow that window. Which patch provides the
// SDK half, and for which SDK revision, is stated in PATCH_COVERAGE and the
// patch entry. The registry CLI refuses a live row whose sdk.patches names no
// patch that covers it, and the build refuses to plan the shipped registry
// for one: the rule must not rest on somebody remembering to run the CLI.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CLI = path.join(repoRoot, 'scripts/zkapi-registry-cli.mjs');
const RECHECK = 'withdrawal-operation-recheck';
const NETWORKS = ['mainnet', 'sepolia'];
const DEPLOYMENT = 'fresh-20260930';
// The SDK revision of the one registered patch, and of the activated fixture's successor.
const PATCH_REVISION = patch.revision;
const FIXTURE_REVISION = activatedRegistry().versions[1].sdk.revision;

// The activated fixture, with the successor row naming `patches` and a review
// that agrees with them (the validator needs the two to be consistent). The
// row is pinned at `revision` when one is given.
function withPatches(registry, patches, { revision = null } = {}) {
    return mutated(registry, copy => {
        const row = copy.versions.find(entry => entry.id === 'v2');
        if (revision) {
            row.sdk.revision = revision;
            row.sdk.source = `github:OpenAnonymity/zkapi#${revision}`;
        }
        row.sdk.patches = [...patches];
        row.gate.recoveryReview.revision = row.sdk.revision;
        row.gate.recoveryReview.verdict = patches.length ? 'patched' : 'not_required';
        row.gate.recoveryReview.patch = patches.length ? patches[0] : null;
    });
}

// What the real map says covers the behavior, at the revision that makes it so.
const covered = () => withPatches(activatedRegistry(), ['wallet-recovery-v1'], { revision: PATCH_REVISION });

// ---------------------------------------------------------------------------
// The coverage map
// ---------------------------------------------------------------------------

test('PATCH_COVERAGE names registered patches and adapter wiring, and is not part of a patch entry', () => {
    assert.ok(Object.isFrozen(PATCH_COVERAGE));
    assert.deepEqual(Object.keys(PATCH_COVERAGE), ['wallet-recovery-v1', 'wallet-recovery-v2c']);
    assert.deepEqual([...PATCH_COVERAGE['wallet-recovery-v1']], [RECHECK]);
    assert.deepEqual([...PATCH_COVERAGE['wallet-recovery-v2c']], [RECHECK]);
    const everyName = new Set(ADAPTER_IDS.flatMap(id => getAdapter(id).requiredWiring));
    for (const [name, covers] of Object.entries(PATCH_COVERAGE)) {
        // A registered patch: provenance exists for it, and throws for any other.
        assert.equal(zkapiSdkPatchProvenance(name).name, name);
        assert.ok(Object.isFrozen(covers), name);
        assert.ok(covers.length > 0, name);
        assert.equal(new Set(covers).size, covers.length, name);
        // Only behaviors an adapter requires, and only ones the host lists.
        for (const wiring of covers) {
            assert.ok(everyName.has(wiring), `${name} covers ${wiring}, which no adapter requires`);
            assert.ok(WIRED.has(wiring), `${name} covers ${wiring}, which the host does not list as wired`);
        }
    }
    // The provenance of a build is the hash of the patch entry. Stating what a
    // patch covers must not change those bytes, so it is not a field of it.
    assert.equal('coverage' in patch, false);
    assert.deepEqual(Object.keys(zkapiSdkPatchProvenance('wallet-recovery-v1')), ['name', 'revision', 'sha256', 'files']);
    assert.deepEqual(Object.keys(patch).sort(), ['files', 'revision']);
    // The successor's entry rewrites nothing (its revision carries the SDK half
    // itself) and is still bound to exactly that revision.
    assert.deepEqual(patchV2c.files, []);
    assert.match(patchV2c.revision, /^[0-9a-f]{40}$/);
    assert.deepEqual(Object.keys(zkapiSdkPatchProvenance('wallet-recovery-v2c')), ['name', 'revision', 'sha256', 'files']);
    assert.deepEqual(zkapiSdkPatchProvenance('wallet-recovery-v2c').files, {});
});

test('the reviewed patches are the map joined with the revision each patch is bound to', () => {
    assert.deepEqual(reviewedRecoveryPatches(), {
        'wallet-recovery-v1': { revision: PATCH_REVISION, covers: [RECHECK] },
        'wallet-recovery-v2c': { revision: patchV2c.revision, covers: [RECHECK] }
    });
    // A copy: changing it cannot change the map or the next answer.
    reviewedRecoveryPatches()['wallet-recovery-v1'].covers.push('payout-alert');
    assert.deepEqual([...PATCH_COVERAGE['wallet-recovery-v1']], [RECHECK]);
    assert.deepEqual(reviewedRecoveryPatches()['wallet-recovery-v1'].covers, [RECHECK]);
});

test('every behavior with a half in the SDK is wired by the host and required by a family', () => {
    assert.deepEqual([...SDK_HALF_WIRING], [RECHECK]);
    assert.ok(Object.isFrozen(SDK_HALF_WIRING));
    for (const name of SDK_HALF_WIRING) {
        assert.ok(WIRED.has(name), name);
        assert.ok(getAdapter('concession-v1').requiredWiring.includes(name), name);
        // A family that does not list the behavior is not asked for the patch.
        assert.equal(getAdapter('note-bound-v1').requiredWiring.includes(name), false, name);
    }
    // Something in the map covers each one, or no live row could ever pass.
    for (const name of SDK_HALF_WIRING) {
        assert.ok(Object.values(PATCH_COVERAGE).some(covers => covers.includes(name)), name);
    }
});

// ---------------------------------------------------------------------------
// The pure check
// ---------------------------------------------------------------------------

test('a registry whose successor is pending, or whose live rows need nothing, has no gap', () => {
    // The fixture: v1 live (a family that lists no such behavior), v2 pending.
    assert.deepEqual(recoveryCoverageGaps(validRegistry()), []);
    const shipped = JSON.parse(fs.readFileSync(path.join(repoRoot, 'deployments/zkapi/registry.json'), 'utf8'));
    assert.deepEqual(recoveryCoverageGaps(shipped), []);
    assert.doesNotThrow(() => assertRecoveryCoverage(shipped));
    // The shipped successor is live on Sepolia only, and its patch is the
    // registered one for its own revision, so nothing is missing; mainnet is
    // pending and is not asked for what its family lists.
    assert.equal(shipped.versions[1].adapter, 'concession-v1');
    assert.deepEqual(NETWORKS.map(network => shipped.versions[1].networks[network].status), ['pending', 'active']);
    assert.deepEqual(shipped.versions[1].sdk.patches, ['wallet-recovery-v2c']);
    assert.equal(shipped.versions[1].sdk.revision, patchV2c.revision);
});

test('a live row of a family that lists the recheck, with no patch that covers it, is a gap', () => {
    const gaps = recoveryCoverageGaps(activatedRegistry());
    assert.deepEqual(gaps, [{
        versionId: 'v2', adapter: 'concession-v1', name: RECHECK, networks: NETWORKS, patches: [], otherRevision: []
    }]);
    // The same row exit-only is still live, and still has the window.
    const exitOnly = recoveryCoverageGaps(rollbackRegistry());
    assert.deepEqual(exitOnly.map(gap => [gap.versionId, gap.name, gap.networks]), [['v2', RECHECK, NETWORKS]]);
    // Both closed concession rows of a three-version registry need it.
    assert.deepEqual(recoveryCoverageGaps(threeVersionRegistry()).map(gap => gap.versionId), ['v2', 'v3']);
    // Only the networks it is live on are named.
    const oneNetwork = mutated(activatedRegistry(), registry => {
        registry.versions[1].networks.sepolia = { status: 'pending', config: { deployment_status: 'not_deployed' } };
    });
    assert.deepEqual(recoveryCoverageGaps(oneNetwork).map(gap => gap.networks), [['mainnet']]);
    // Pending or retired on every network is not live: nothing to cover.
    const dormant = mutated(activatedRegistry(), registry => {
        for (const network of NETWORKS) registry.versions[1].networks[network] = { status: 'pending', config: { deployment_status: 'not_deployed' } };
    });
    assert.deepEqual(recoveryCoverageGaps(dormant), []);
    const retired = mutated(activatedRegistry(), registry => {
        for (const network of NETWORKS) registry.versions[1].networks[network] = { status: 'retired' };
    });
    assert.deepEqual(recoveryCoverageGaps(retired), []);
});

test('only a patch whose coverage names the behavior closes the gap', () => {
    const reviewed = {
        'recovery-v2c': { revision: FIXTURE_REVISION, covers: [RECHECK] },
        'other-repair': { revision: FIXTURE_REVISION, covers: ['payout-alert'] },
        'empty-repair': { revision: FIXTURE_REVISION, covers: [] }
    };
    const check = (patches, options = {}) => recoveryCoverageGaps(withPatches(activatedRegistry(), patches), { reviewed, ...options });
    assert.deepEqual(check(['recovery-v2c']), []);
    // Any one covering patch is enough, in any position.
    assert.deepEqual(check(['other-repair', 'recovery-v2c']), []);
    // Naming a patch that covers something else, nothing, or is unknown is not coverage.
    assert.equal(check(['other-repair']).length, 1);
    assert.equal(check(['empty-repair']).length, 1);
    assert.equal(check(['not-registered']).length, 1);
    assert.deepEqual(check(['other-repair', 'not-registered'])[0].patches, ['other-repair', 'not-registered']);
    // The reviewed set decides, not the registry: with the real one the same name covers nothing.
    assert.equal(recoveryCoverageGaps(withPatches(activatedRegistry(), ['recovery-v2c'])).length, 1);
    // A name inherited from Object.prototype is no patch.
    for (const inherited of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
        assert.equal(check([inherited]).length, 1, inherited);
    }
    // A malformed entry covers nothing.
    for (const value of [null, undefined, RECHECK, 1, [], { revision: FIXTURE_REVISION, covers: RECHECK },
        { revision: FIXTURE_REVISION, covers: { [RECHECK]: true } }, { covers: [RECHECK] },
        { revision: 7, covers: [RECHECK] }, { revision: null, covers: [RECHECK] }]) {
        const gaps = check(['recovery-v2c'], { reviewed: { 'recovery-v2c': value } });
        assert.equal(gaps.length, 1, JSON.stringify(value));
    }
    // So does a reviewed set that is not a plain object.
    for (const value of [null, undefined, [], 'recovery-v2c', 7, new Map([['recovery-v2c', reviewed['recovery-v2c']]])]) {
        const gaps = recoveryCoverageGaps(withPatches(activatedRegistry(), ['recovery-v2c']), { reviewed: value });
        assert.equal(gaps.length, 1, String(value));
    }
    // The real map: the legacy patch is the only registered one that covers it.
    assert.deepEqual(recoveryCoverageGaps(covered()), []);
});

test('a patch covers the behavior only for the SDK revision it is bound to', () => {
    // The patch is the real one and covers the behavior, but a row pinned at
    // another revision cannot apply it (the install refuses it), so naming it
    // is not coverage: a registry that passed this check could not be built.
    const elsewhere = withPatches(activatedRegistry(), ['wallet-recovery-v1']);
    assert.notEqual(elsewhere.versions[1].sdk.revision, PATCH_REVISION);
    assert.deepEqual(recoveryCoverageGaps(elsewhere), [{
        versionId: 'v2', adapter: 'concession-v1', name: RECHECK, networks: NETWORKS,
        patches: ['wallet-recovery-v1'], otherRevision: ['wallet-recovery-v1']
    }]);
    assert.throws(() => assertRecoveryCoverage(elsewhere), error => {
        assert.equal(error.code, 'recovery_patch_coverage');
        assert.match(error.message, /names wallet-recovery-v1, but wallet-recovery-v1 covers it only for another SDK revision/);
        return true;
    });
    // At its own revision it is coverage, and the validator agrees with the row.
    validate(covered());
    assert.deepEqual(recoveryCoverageGaps(covered()), []);
    assert.doesNotThrow(() => assertRecoveryCoverage(covered()));
    // A row that has no revision pinned cannot be covered by anything.
    const unpinned = mutated(covered(), registry => { registry.versions[1].sdk.revision = null; });
    assert.equal(recoveryCoverageGaps(unpinned).length, 1);
});

test('a family that does not list the behavior is not asked for a patch, whatever else it lists', () => {
    const quiet = { ...getAdapter('concession-v1'), requiredWiring: ['service-message', 'exit-kit'] };
    const adapters = id => (id === 'concession-v1' ? quiet : getAdapter(id));
    assert.deepEqual(recoveryCoverageGaps(activatedRegistry(), { adapters }), []);
    // The rule follows the adapter's list, not a family name: a family that
    // lists the behavior is asked for it, with or without a patch of its own.
    const listing = { ...getAdapter('note-bound-v1'), requiredWiring: [RECHECK] };
    const noteBound = id => (id === 'note-bound-v1' ? listing : getAdapter(id));
    assert.deepEqual(recoveryCoverageGaps(validRegistry(), { adapters: noteBound }), []);
    const unpatched = mutated(validRegistry(), registry => { registry.versions[0].sdk.patches = []; });
    assert.deepEqual(recoveryCoverageGaps(unpatched, { adapters: noteBound }).map(gap => gap.versionId), ['v1']);
});

test('the assertion is a RegistryError with its own code and says which row, where, and what to do', () => {
    assert.throws(() => assertRecoveryCoverage(activatedRegistry()), error => {
        assert.ok(error instanceof RegistryError);
        assert.equal(error.code, 'recovery_patch_coverage');
        assert.match(error.message, /^v2 is live on mainnet and sepolia and its concession-v1 protocol lists withdrawal-operation-recheck/);
        assert.match(error.message, /names no patch/);
        assert.match(error.message, /keep the version pending/);
        // The way through, for a revision that provides the half itself too:
        // a verdict that no patch is required is not coverage, so what would
        // satisfy the rule has to be said where the rule is refused.
        assert.match(error.message, /PATCH_COVERAGE in scripts\/patch-zkapi-sdk\.mjs/);
        assert.match(error.message, /an entry with no files is enough for a revision that provides it itself/);
        assert.match(error.message, /a not_required verdict alone is not coverage/);
        // No raw path, URL or secret: it is printed by an operator tool.
        assert.doesNotMatch(error.message, /\/Users\/|https?:/);
        return true;
    });
    assert.throws(() => assertRecoveryCoverage(withPatches(activatedRegistry(), ['recovery-v2c'])), error => {
        assert.equal(error.code, 'recovery_patch_coverage');
        assert.match(error.message, /names recovery-v2c, none of which covers it/);
        return true;
    });
    // Not a validator rule: the registry model accepts a row the CLI refuses,
    // so fixtures of an activation do not need a patch to be valid.
    validate(activatedRegistry());
    validate(withPatches(activatedRegistry(), ['recovery-v2c']));
});

// ---------------------------------------------------------------------------
// The build
// ---------------------------------------------------------------------------

const plan = (options = {}) => planFromRegistry({
    network: 'mainnet', deployment: DEPLOYMENT, profiles: fixtureProfiles(), ...options
});

test('a plan is refused for a live row without coverage when it is held to the reviewed patches', () => {
    // A fixture registry is planned as it always was: its rows carry no patches.
    assert.equal(plan({ registry: activatedRegistry() }).mode, 'multi');

    const options = { recoveryPatches: reviewedRecoveryPatches() };
    assert.throws(() => plan({ registry: activatedRegistry(), ...options }), error => {
        assert.equal(error.code, 'recovery_patch_coverage');
        assert.ok(error.cause instanceof RegistryError);
        assert.match(error.message, /^\[build\] The zkAPI version registry is invalid \(recovery_patch_coverage\): v2 is live on mainnet and sepolia/);
        return true;
    });
    // Either network's build, and a row that only exits is live too.
    for (const network of NETWORKS) {
        assert.throws(() => plan({ network, registry: rollbackRegistry(), ...options }), { code: 'recovery_patch_coverage' }, network);
    }
    // A patch bound to another revision is no coverage at build time either.
    assert.throws(() => plan({ registry: withPatches(activatedRegistry(), ['wallet-recovery-v1']), ...options }),
        { code: 'recovery_patch_coverage' });
    // Covered at its own revision: planned, both live versions.
    const planned = plan({ registry: covered(), ...options });
    assert.equal(planned.mode, 'multi');
    assert.deepEqual(planned.versions.map(version => [version.id, version.status]), [['v1', 'exit-only'], ['v2', 'active']]);
    // A registry whose successor is pending needs nothing.
    assert.equal(plan({ registry: validRegistry(), ...options }).mode, 'single');
    // The validator's own refusals still come first and keep their codes.
    assert.throws(() => plan({ registry: mutated(activatedRegistry(), registry => { registry.lineage = 'other'; }), ...options }),
        /OA_ZKAPI_DEPLOYMENT must be other/);
});

// The shipped registry is what a build plans without being told anything, so
// the rule has to hold there. The shipped one is dormant, so the registry the
// build reads is replaced in a copy of the scripts that read it.
function mirror(t, registry) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'oa-registry-mirror-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    for (const relative of ['scripts/zkapiRegistry.mjs', 'scripts/patch-zkapi-sdk.mjs', 'chat/zkapi/versioning',
        'patches/zkapi-browser-sdk-wallet-recovery.mjs', 'patches/zkapi-browser-sdk-v2c-recovery.mjs',
        'deployments/zkapi/mainnet.json', 'deployments/zkapi/sepolia.json']) {
        fs.mkdirSync(path.dirname(path.join(directory, relative)), { recursive: true });
        fs.cpSync(path.join(repoRoot, relative), path.join(directory, relative), { recursive: true });
    }
    fs.writeFileSync(path.join(directory, 'deployments/zkapi/registry.json'), `${JSON.stringify(registry, null, 2)}\n`);
    return import(pathToFileURL(path.join(directory, 'scripts/zkapiRegistry.mjs')).href);
}

test('the shipped registry cannot be planned for a build while a live row lacks the SDK half', async t => {
    // Defaults only, as scripts/build.mjs, the asset build and the Vercel
    // route generator call it.
    const bare = await mirror(t, activatedRegistry());
    for (const network of NETWORKS) {
        assert.throws(() => bare.planFromRegistry({ network, deployment: DEPLOYMENT }), error => {
            assert.equal(error.code, 'recovery_patch_coverage');
            assert.match(error.message, /^\[build\] The zkAPI version registry is invalid \(recovery_patch_coverage\)/);
            return true;
        }, network);
    }
    // The same registry with its patch applied (at the patch's own revision) plans.
    const patched = await mirror(t, covered());
    for (const network of NETWORKS) {
        const planned = patched.planFromRegistry({ network, deployment: DEPLOYMENT });
        assert.equal(planned.mode, 'multi', network);
        assert.deepEqual(planned.versions.map(version => version.id), ['v1', 'v2'], network);
    }
    // And a build of the registry that ships today plans: mainnet is still
    // single, Sepolia has both versions with the registered covering patch.
    const shipped = await mirror(t, JSON.parse(fs.readFileSync(path.join(repoRoot, 'deployments/zkapi/registry.json'), 'utf8')));
    assert.equal(shipped.planFromRegistry({ network: 'mainnet', deployment: DEPLOYMENT }).mode, 'single');
    assert.equal(shipped.planFromRegistry({ network: 'sepolia', deployment: DEPLOYMENT }).mode, 'multi');
    assert.equal(shipped.planFromRegistry({ network: 'mainnet', deployment: '' }).mode, 'sdk-default');
});

// ---------------------------------------------------------------------------
// The command
// ---------------------------------------------------------------------------

function makeRepository(t, { committed }) {
    const repository = fs.mkdtempSync(path.join(os.tmpdir(), 'oa-recovery-coverage-'));
    t.after(() => fs.rmSync(repository, { recursive: true, force: true }));
    const git = (...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.test', ...args],
        { cwd: repository, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    git('init', '-q');
    const directory = path.join(repository, 'deployments/zkapi');
    fs.mkdirSync(directory, { recursive: true });
    for (const [name, profile] of Object.entries(fixtureProfiles())) {
        fs.writeFileSync(path.join(directory, name), `${JSON.stringify(profile, null, 2)}\n`);
    }
    const file = path.join(directory, 'registry.json');
    const write = registry => fs.writeFileSync(file, `${JSON.stringify(registry, null, 2)}\n`);
    if (committed) write(committed);
    else fs.writeFileSync(path.join(repository, 'README.md'), 'no registry yet\n');
    git('add', '.');
    git('commit', '-q', '-m', 'base');
    return { file, write };
}

const run = args => {
    try {
        return { code: 0, out: execFileSync(process.execPath, [CLI, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) };
    } catch (error) {
        return { code: error.status, out: `${error.stdout}${error.stderr}` };
    }
};

test('check refuses a live row without a covering patch, and accepts one with it', t => {
    const project = makeRepository(t, { committed: validRegistry() });
    const check = (...extra) => run(['check', '--base', 'HEAD', '--file', project.file, ...extra]);

    // The base state itself passes (v2 pending, v1 needs nothing).
    assert.equal(check().code, 0, check().out);

    // Activation with no patch: refused, by this rule, with its code.
    project.write(activatedRegistry());
    const bare = check();
    assert.equal(bare.code, 1, bare.out);
    assert.match(bare.out, /recovery_patch_coverage/);
    assert.match(bare.out, /v2 is live on mainnet and sepolia/);
    assert.match(bare.out, /withdrawal-operation-recheck/);
    // What would satisfy it is in the refusal: a verdict alone does not.
    assert.match(bare.out, /an entry with no files is enough/);
    assert.match(bare.out, /a not_required verdict alone is not coverage/);

    // A patch that covers something else, or nothing registered: still refused.
    project.write(withPatches(activatedRegistry(), ['recovery-v2c']));
    const unregistered = check();
    assert.equal(unregistered.code, 1, unregistered.out);
    assert.match(unregistered.out, /recovery_patch_coverage/);
    assert.match(unregistered.out, /recovery-v2c, none of which covers it/);

    // The patch that covers it, applied to a revision it is not bound to: the
    // install would refuse it, so the check does too.
    project.write(withPatches(activatedRegistry(), ['wallet-recovery-v1']));
    const elsewhere = check();
    assert.equal(elsewhere.code, 1, elsewhere.out);
    assert.match(elsewhere.out, /recovery_patch_coverage/);
    assert.match(elsewhere.out, /covers it only for another SDK revision/);

    // The same row exit-only is live too.
    project.write(rollbackRegistry());
    const exitOnly = check();
    assert.equal(exitOnly.code, 1, exitOnly.out);
    assert.match(exitOnly.out, /recovery_patch_coverage/);

    // No override lifts it, and the identity override is for something else.
    project.write(activatedRegistry());
    const overridden = check('--allow-identity-change');
    assert.equal(overridden.code, 1, overridden.out);
    assert.match(overridden.out, /recovery_patch_coverage/);

    // A row that names a patch the map says covers it, at its revision, is a
    // valid forward move.
    project.write(covered());
    const accepted = check();
    assert.equal(accepted.code, 0, accepted.out);
    assert.match(accepted.out, /valid forward move/);

    // And the shipped dormant registry is untouched by the rule.
    project.write(validRegistry());
    assert.equal(check().code, 0);
});

test('check applies the rule when there is nothing to compare against', t => {
    // A registry that does not exist at the base ref (a first commit of the
    // file) is still judged by every rule that needs no base.
    const project = makeRepository(t, { committed: null });
    const check = () => run(['check', '--base', 'HEAD', '--file', project.file]);
    project.write(validRegistry());
    const valid = check();
    assert.equal(valid.code, 0, valid.out);
    assert.match(valid.out, /Nothing to compare/);
    project.write(activatedRegistry());
    const refused = check();
    assert.equal(refused.code, 1, refused.out);
    assert.match(refused.out, /recovery_patch_coverage/);
    project.write(covered());
    assert.equal(check().code, 0);
});

test('the command line says what the rule refuses and that nothing lifts it', () => {
    const help = run(['--help']);
    assert.equal(help.code, 0);
    assert.match(help.out, /recovery_patch_coverage/);
    assert.match(help.out, /withdrawal-operation-recheck/);
    assert.match(help.out, /no override/i);
    assert.match(help.out, /a not_required\s+verdict alone is not coverage/);
    assert.match(help.out, /the\s+build applies it to the shipped registry too/);
    // The other checks are untouched.
    assert.match(help.out, /--allow-identity-change/);
    assert.match(help.out, /tombstone/);
});
