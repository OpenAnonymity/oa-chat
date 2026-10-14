// Operator checks for deployments/zkapi/registry.json.
//
//   node scripts/zkapi-registry-cli.mjs store-hash <alias>
//       SHA-256 of the wallet store module of an installed SDK package: the
//       value a registry row pins as sdk.storeSha256 when the version is
//       activated (the build refuses a store whose bytes differ).
//
//   node scripts/zkapi-registry-cli.mjs check --base <git-ref> [--file <registry.json>]
//                                            [--allow-identity-change] [--package-root <dir>]
//       Validate the registry and require it to be a legitimate successor of
//       the registry committed at <git-ref>: no version leaves its lifecycle
//       stage backwards (the one exception being a rollback to a lower version
//       while every higher live version is exit-only), and the wallet
//       namespace is unchanged. A `git revert` of an activation fails here.
//       It also holds identity across the change: a version that goes from
//       live to retired must carry a tombstone naming the deployment id, chain
//       id and vault it had at <git-ref> (read from the profile file at that
//       ref, `git show <ref>:<dir of --file>/<profile>`), and a version that
//       stays live must keep its deployment id, chain id, vault, proof setup
//       and proof key pins (setup id, proving and verifying key hashes), SDK
//       revision and wallet store hash: a vault verifies proofs against the
//       keys it was deployed with, so another setup (dev to mpc-1) or key set
//       is another vault and a new version. --allow-identity-change lifts the
//       second rule for one reviewed change, such as an SDK pin bump; the
//       tombstone rule has no override.
//       It also refuses (code recovery_patch_coverage) a live version whose
//       protocol lists a behavior with a half only the SDK can provide, today
//       withdrawal-operation-recheck, unless sdk.patches names a reviewed
//       patch that covers it for the version's own SDK revision
//       (PATCH_COVERAGE in scripts/patch-zkapi-sdk.mjs). The rule is
//       recoveryCoverageGaps of scripts/zkapiRegistry.mjs, which the build
//       applies to the shipped registry as well; it is not a validator rule and
//       has no override.
//       A live version whose profile pins the single-party development proof
//       setup is accepted (the host accepts it on every network); the check
//       prints a warning on stderr for each one and still succeeds. When the
//       SDK package of such a version is installed (under --package-root, this
//       repository by default) and its own build would refuse that profile for
//       mainnet (development_setup_on_mainnet), a second warning says the build
//       of that network stops there; the exit code is unchanged.
//       --file defaults to deployments/zkapi/registry.json of this repository.
//
//   node scripts/zkapi-registry-cli.mjs --help
//
// A standalone command with its own main guard, so importing it runs nothing.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAdapter } from '../chat/zkapi/versioning/adapters/index.mjs';
import { assertForwardOnly, validateRegistry } from '../chat/zkapi/versioning/registryModel.mjs';
import { WIRED } from '../chat/zkapi/versioning/wiring.mjs';
import {
    PROFILE_FILES,
    REGISTRY,
    assertRecoveryCoverage,
    developmentSetupRows,
    developmentSetupWarning,
    resolveSdkEntry,
    resolveSdkPackage,
    sdkDevelopmentSetupRefusals
} from './zkapiRegistry.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const USAGE = 'Usage: zkapi-registry-cli.mjs store-hash <alias> | '
    + 'check --base <git-ref> [--file <registry.json>] [--allow-identity-change] [--package-root <dir>] | --help';
const HELP = `${USAGE}

  store-hash <alias>
      SHA-256 of the wallet store module of an installed SDK package: the value
      a registry row pins as sdk.storeSha256 when the version is activated.

  check --base <git-ref> [--file <registry.json>] [--allow-identity-change] [--package-root <dir>]
      Validate the registry and require it to be a legitimate forward move from
      the registry committed at <git-ref>. Versions never move to an earlier
      stage (a rollback to a lower version while every higher live version is
      exit-only is the one exception), the wallet namespace is unchanged, a
      version that is retired carries a tombstone naming the deployment id,
      chain id and vault it had at <git-ref>, and a version that stays live keeps
      its deployment id, chain id, vault, proof setup and proof key pins (setup
      id, proving and verifying key hashes), SDK revision and wallet store hash.

      A live version whose protocol lists a behavior with a half only the SDK
      can provide (withdrawal-operation-recheck) must also apply a reviewed
      recovery patch that covers it for its own SDK revision (sdk.patches,
      PATCH_COVERAGE in scripts/patch-zkapi-sdk.mjs; an entry with no files is
      enough for a revision that provides the half itself, and a not_required
      verdict alone is not coverage); otherwise the check fails with
      recovery_patch_coverage. There is no override for that rule, and the
      build applies it to the shipped registry too.

      A live version whose profile pins the single-party development proof
      setup (dev) is accepted on every network. The check prints one warning on
      stderr per such version and network: whoever generated those keys can
      forge proofs and take every deposit of the vault, and a vault on dev keys
      cannot later be switched to mpc-1 (that is a new vault and a user
      migration). If the version's SDK package is installed and its own build
      refuses the profile for mainnet (development_setup_on_mainnet), one more
      warning says the build of that network stops there. The exit code is not
      changed by either.

      --file                    registry to check; default deployments/zkapi/registry.json
      --allow-identity-change   accept a changed deployment id, chain id, vault,
                                proof setup or proof key pins, SDK revision or
                                wallet store hash on a version that stays live,
                                and a changed tombstone. Use it only for a
                                reviewed change such as an SDK pin bump. A
                                tombstone that does not match the version it
                                retires is never accepted.
      --package-root            directory whose node_modules holds the SDK
                                packages, for the development setup probe;
                                default this repository
`;
// A ref that begins with "-" would be read by git as an option.
const SAFE_REF = /^[A-Za-z0-9_][A-Za-z0-9._\-/@^~{}:]*$/;

// A profile file name as the registry schema allows it (no directory part).
const PROFILE_NAME = /^[a-z0-9][a-z0-9._-]*\.json$/;

const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

function option(args, name) {
    const index = args.indexOf(name);
    if (index === -1) return null;
    const value = args[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${name} requires a value.`);
    return value;
}

async function storeHash(alias, { packageRoot = repoRoot } = {}) {
    const file = resolveSdkEntry(resolveSdkPackage(alias, packageRoot), 'store');
    if (!file) throw new Error(`${alias} exports no ./store.`);
    return createHash('sha256').update(await fs.readFile(file)).digest('hex');
}

// The profile files a registry names, as a plain object by file name.
function profileNames(registry) {
    const names = new Set();
    for (const row of Array.isArray(registry?.versions) ? registry.versions : []) {
        for (const entry of Object.values(row?.networks || {})) {
            if (typeof entry?.profile === 'string' && PROFILE_NAME.test(entry.profile)) names.add(entry.profile);
        }
    }
    return [...names];
}

// The profiles of the working-tree registry: the files next to it, and for a
// name that is not there this repository's reviewed copy (a registry checked
// from outside this tree still validates against what this tree would build).
async function readNextProfiles(registry, directory) {
    const profiles = {};
    for (const name of profileNames(registry)) {
        try {
            profiles[name] = JSON.parse(await fs.readFile(path.join(directory, name), 'utf8'));
        } catch {
            if (Object.hasOwn(PROFILE_FILES, name)) profiles[name] = PROFILE_FILES[name];
        }
    }
    return profiles;
}

// The profiles the registry at <ref> was committed with. A file that does not
// exist at the ref is left out: the identity check then fails closed instead
// of comparing against a profile nobody reviewed.
function readBaseProfiles(registry, ref, top, directory) {
    const profiles = {};
    for (const name of profileNames(registry)) {
        try {
            profiles[name] = JSON.parse(git(['show', `${ref}:${directory ? `${directory}/` : ''}${name}`], top));
        } catch { /* not at that ref, or not JSON */ }
    }
    return profiles;
}

async function checkRegistry({ base, file, allowIdentityChange = false, packageRoot = repoRoot }) {
    if (!SAFE_REF.test(base)) throw new Error(`Not a usable git ref: ${JSON.stringify(base)}.`);
    // Real path: git reports its top level with symlinks resolved.
    const absolute = await fs.realpath(path.resolve(file || path.join(repoRoot, 'deployments/zkapi/registry.json')));
    const next = JSON.parse(await fs.readFile(absolute, 'utf8'));
    const top = git(['rev-parse', '--show-toplevel'], path.dirname(absolute)).trim();
    const relative = path.relative(top, absolute).split(path.sep).join('/');
    const nextProfiles = await readNextProfiles(next, path.dirname(absolute));

    // The working-tree registry (an activation PR that is not committed yet is
    // what is judged) passes its own rules before it is compared.
    validateRegistry(next, { profiles: nextProfiles, adapters: getAdapter, wired: WIRED, lineage: REGISTRY.lineage });
    // A name the host lists as wired can still have a half in the SDK itself.
    assertRecoveryCoverage(next);
    // Accepted, not hidden: reported to whoever runs the check, with what the
    // installed SDK's own build would do with it.
    const developmentSetups = developmentSetupRows(next, { profiles: nextProfiles });
    const sdkRefusals = await sdkDevelopmentSetupRefusals(next, developmentSetups,
        { profiles: nextProfiles, packageRoot: path.resolve(packageRoot) });

    try {
        git(['cat-file', '-e', `${base}^{commit}`], top);
    } catch {
        throw new Error(`The git ref ${JSON.stringify(base)} does not name a commit.`);
    }
    let previous;
    try {
        previous = git(['show', `${base}:${relative}`], top);
    } catch {
        // The registry did not exist at the base ref: nothing to move forward from.
        return { compared: false, reason: `${relative} does not exist at ${base}.`, developmentSetups, sdkRefusals };
    }
    const previousRegistry = JSON.parse(previous);
    const directory = path.posix.dirname(relative);
    assertForwardOnly(previousRegistry, next, {
        baseProfiles: readBaseProfiles(previousRegistry, base, top, directory === '.' ? '' : directory),
        nextProfiles,
        allowIdentityChange
    });
    return { compared: true, identityOverride: allowIdentityChange === true, developmentSetups, sdkRefusals };
}

async function main(argv) {
    const [command, ...rest] = argv;
    if (command === '--help' || command === '-h' || command === 'help') {
        console.log(HELP);
        return;
    }
    if (command === 'store-hash') {
        if (!rest[0]) throw new Error(USAGE);
        console.log(await storeHash(rest[0]));
        return;
    }
    if (command === 'check') {
        const base = option(rest, '--base');
        if (!base) throw new Error(USAGE);
        const allowIdentityChange = rest.includes('--allow-identity-change');
        const outcome = await checkRegistry({
            base, file: option(rest, '--file'), allowIdentityChange, packageRoot: option(rest, '--package-root') || repoRoot
        });
        console.log(outcome.compared
            ? `zkAPI registry is a valid forward move from ${base}.${outcome.identityOverride
                ? ' Identity checks (deployment, chain, vault, proof setup and key pins and SDK pins of live versions, and retired tombstones) were skipped (--allow-identity-change).' : ''}`
            : `zkAPI registry is valid. ${outcome.reason} Nothing to compare.`);
        for (const row of outcome.developmentSetups) console.warn(`[zkapi-registry] ${developmentSetupWarning(row)}`);
        for (const refusal of outcome.sdkRefusals) console.warn(`[zkapi-registry] ${refusal.message}`);
        return;
    }
    throw new Error(USAGE);
}

// Whether this file is the process entry point, run as
// scripts/zkapi-registry-cli.mjs itself. Node resolves the symlinks of an entry
// module but leaves argv[1] as typed, so both sides are resolved: a check that
// quietly does not run would pass every registry change. A bundle that happens
// to include this module is a different file and never runs it.
function isEntryPoint() {
    const self = fileURLToPath(import.meta.url);
    if (!process.argv[1] || path.basename(self) !== 'zkapi-registry-cli.mjs') return false;
    try {
        return realpathSync(process.argv[1]) === realpathSync(self);
    } catch {
        return false;
    }
}

if (isEntryPoint()) {
    try {
        await main(process.argv.slice(2));
    } catch (error) {
        console.error(`[zkapi-registry] ${error.code ? `${error.code}: ` : ''}${error.message}`);
        process.exitCode = 1;
    }
}
