import fs from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import patch from '../patches/zkapi-browser-sdk-wallet-recovery.mjs';
import proofCachePatch from '../patches/zkapi-browser-sdk-proof-cache.mjs';
import providerVerificationPatch from '../patches/zkapi-browser-sdk-provider-verification.mjs';
import patchV2c from '../patches/zkapi-browser-sdk-v2c-recovery.mjs';
import registry from '../deployments/zkapi/registry.json' with { type: 'json' };

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const digest = value => createHash('sha256').update(value).digest('hex');

// Package name the app's source imports and the first protocol version installs.
const LEGACY_ALIAS = '@openanonymity/zkapi-browser-sdk';
const LEGACY_PATCH = 'wallet-recovery-v1';
const V2C_PATCH = 'wallet-recovery-v2c';
// Compatibility patches of the same legacy revision, applied after the recovery
// patch in a file chain (a later entry starts from the earlier entry's result).
const PROOF_CACHE_PATCH = proofCachePatch.name;
const PROVIDER_VERIFICATION_PATCH = providerVerificationPatch.name;

// Reviewed repairs by the name a registry row lists in `sdk.patches`. A patch
// is bound to one SDK revision and one set of file hashes; a new SDK revision
// gets its own entry (and its own .vercelignore line), never an edit of this
// one. A row naming a patch that is not listed here cannot be built.
const SDK_PATCHES = Object.freeze({
    [LEGACY_PATCH]: patch,
    [PROOF_CACHE_PATCH]: proofCachePatch,
    [PROVIDER_VERIFICATION_PATCH]: providerVerificationPatch,
    [V2C_PATCH]: patchV2c
});

// The patches of the legacy SDK, in the order their file chains apply.
export const LEGACY_PATCH_NAMES = Object.freeze([LEGACY_PATCH, PROOF_CACHE_PATCH, PROVIDER_VERIFICATION_PATCH]);
export const zkapiSdkPatches = Object.freeze(LEGACY_PATCH_NAMES.map(name => SDK_PATCHES[name]));

// What each reviewed patch covers, by the protocol wiring name an adapter lists
// in `requiredWiring` (chat/zkapi/versioning/wiring.mjs). Some wiring has a
// half that only the SDK itself can provide: `withdrawal-operation-recheck` is
// the host re-verifying the displayed withdrawal under the wallet lock AND the
// SDK refusing, inside its own lock, a prepared withdrawal that was replaced
// after it was displayed. A revision that does not carry that second half
// keeps a window the host cannot close, so a live row of a family that lists
// the name must apply a patch named here, bound to the row's own SDK revision
// (recoveryCoverageGaps of scripts/zkapiRegistry.mjs, which the build applies
// to the shipped registry and the registry CLI `check` applies to the file it
// is given, code `recovery_patch_coverage`). A revision that provides the half
// itself still registers an entry above, with no files, and a line here.
//
// This map is deliberately NOT a field of a patch entry: the entry is hashed
// into the build provenance, and stating what it covers must not change those
// bytes. A name is added when a patch is registered above and reviewed to
// provide that half (test/zkapi/zkapi-recovery-coverage.test.mjs pins that
// every key is a registered patch and every value an adapter wiring name).
export const PATCH_COVERAGE = Object.freeze({
    [LEGACY_PATCH]: Object.freeze(['withdrawal-operation-recheck']),
    [V2C_PATCH]: Object.freeze(['withdrawal-operation-recheck'])
});

export function zkapiSdkPatchProvenance(name = LEGACY_PATCH) {
    if (!Object.hasOwn(SDK_PATCHES, name)) throw new Error(`Unknown zkAPI SDK patch "${name}".`);
    const entry = SDK_PATCHES[name];
    return { name, revision: entry.revision,
        sha256: digest(JSON.stringify(entry)),
        files: Object.fromEntries(entry.files.map(file => [file.file, file.afterSha256])) };
}

// Apply the reviewed patches of one SDK directory. A file named by several
// patches is a chain: each entry must start from the previous entry's result.
// Pristine files, an intermediate reviewed state and the final result are
// accepted byte for byte, so an interrupted install or a repeat build is
// repairable, and every unreviewed state is refused before any file is written.
async function applyPatches(entries, directory) {
    const chains = new Map();
    for (const entry of entries) {
        for (const file of entry.files) {
            const chain = chains.get(file.file) || [];
            if (chain.length && chain.at(-1).afterSha256 !== file.beforeSha256) {
                throw new Error(`The zkAPI SDK patch chain is inconsistent for ${file.file}.`);
            }
            chain.push(file);
            chains.set(file.file, chain);
        }
    }
    const updates = [];
    for (const [name, chain] of chains) {
        const target = path.join(directory, name);
        let source = await fs.readFile(target, 'utf8');
        const hash = digest(source);
        const completed = chain.findLastIndex(file => hash === file.afterSha256);
        if (completed === chain.length - 1) continue;
        if (completed < 0 && hash !== chain[0].beforeSha256) {
            throw new Error(`Unexpected zkAPI SDK contents in ${name}. Reinstall or review the recovery patch.`);
        }
        for (const file of chain.slice(completed + 1)) {
            for (const { before, after } of file.replacements) {
                if (source.split(before).length !== 2) throw new Error(`Recovery patch context changed in ${name}.`);
                source = source.replace(before, after);
            }
            if (digest(source) !== file.afterSha256) throw new Error(`Recovery patch result mismatch in ${name}.`);
        }
        updates.push([target, source]);
    }
    return updates;
}

/**
 * Apply a registry row's patch list to its installed SDK. `root` holds the
 * package.json that declares the dependency; `alias` is the package name it is
 * installed under and `source` the exact dependency specifier the registry
 * pins. An empty list touches nothing, not even the install.
 */
export async function patchSdkVersion({ root = repoRoot, alias, source, patches }) {
    if (!Array.isArray(patches) || !patches.length) return 0;
    const entries = patches.map(name => {
        if (!Object.hasOwn(SDK_PATCHES, name)) throw new Error(`Unknown zkAPI SDK patch "${name}".`);
        return SDK_PATCHES[name];
    });
    const manifest = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
    for (const entry of entries) {
        if (typeof source !== 'string' || !source.endsWith(`#${entry.revision}`)
            || manifest.dependencies?.[alias] !== source) {
            throw new Error('The zkAPI SDK revision changed. Review its deposit recovery patch before continuing.');
        }
    }
    // Package consumers may hoist the SDK above oa-chat's directory.
    let directory;
    try {
        directory = path.dirname(createRequire(path.join(root, 'package.json')).resolve(`${alias}/package.json`));
    } catch (cause) {
        throw new Error(`The zkAPI SDK package ${alias} is not installed. Run npm install.`, { cause });
    }
    const updates = await applyPatches(entries, directory);
    // Validate every file before modifying any. A partial interrupted install
    // remains repairable on the next invocation because each file is checked.
    for (const [target, patched] of updates) await fs.writeFile(target, patched);
    return updates.length;
}

// Refuse SDK drift instead of silently shipping without a recovery repair.
// Both pristine and already patched installs are checked byte for byte. This is
// the unconditional legacy patch of an SDK-default build, which has no registry;
// install-time patching goes through patchRegisteredSdks below.
export async function patchZkapiSdk(root = repoRoot) {
    return patchSdkVersion({
        root,
        alias: LEGACY_ALIAS,
        source: `github:OpenAnonymity/zkapi#${patch.revision}`,
        patches: [...LEGACY_PATCH_NAMES]
    });
}

// A row no network builds: pending (not yet activated) or retired (gone). A
// row without network entries is not dormant, so an incomplete row fails closed
// into the patch (or its loud refusal) instead of being skipped.
function isDormant(row) {
    const entries = Object.values(row.networks ?? {});
    return entries.length > 0 && entries.every(entry => entry?.status === 'pending' || entry?.status === 'retired');
}

// postinstall, pretest and predev: every version is driven by its registry row,
// the legacy SDK included, so a version is retired through the registry alone.
//
//   dormant row (pending or retired on every network)   skipped, whether or not
//       its package is installed or still pinned in package.json: nothing builds
//       it. A retired row is logged; a pending one is the quiet default.
//   live row, legacy alias   required: a missing package, a changed pin or
//       changed SDK bytes fail loudly, exactly as the unconditional legacy patch
//       always did.
//   live row, any other alias   patched when its package is installed and
//       skipped when it is not: this script must never fail an install for a
//       package npm has not fetched. The build still refuses a live version
//       whose package is missing (scripts/zkapiRegistry.mjs verifyPlanOnDisk).
export async function patchRegisteredSdks(root = repoRoot, { rows = registry.versions, log = () => {} } = {}) {
    let rewritten = 0;
    for (const row of rows) {
        const { alias, source, patches } = row.sdk;
        if (!patches?.length) continue;
        if (isDormant(row)) {
            if (Object.values(row.networks).some(entry => entry.status === 'retired')) {
                log(`Skipping the ${row.id} recovery patch: ${alias} is not live on any network.`);
            }
            continue;
        }
        if (alias !== LEGACY_ALIAS) {
            try {
                createRequire(path.join(root, 'package.json')).resolve(`${alias}/package.json`);
            } catch {
                log(`Skipping the ${row.id} recovery patch: ${alias} is not installed.`);
                continue;
            }
        }
        rewritten += await patchSdkVersion({ root, alias, source, patches });
    }
    return rewritten;
}

// Whether this file is the process entry point, run as scripts/patch-zkapi-sdk.mjs
// itself. Node resolves the symlinks of an entry module but leaves argv[1] as
// typed, so both sides are resolved: a guard that quietly does not run (a
// symlinked checkout) would install an unpatched SDK without a word. And when
// this module is bundled into another entry file (the unit tests, the Vercel
// route generator) import.meta.url is that bundle, which must never patch.
function isEntryPoint() {
    const self = fileURLToPath(import.meta.url);
    if (!process.argv[1] || path.basename(self) !== 'patch-zkapi-sdk.mjs') return false;
    try {
        return realpathSync(process.argv[1]) === realpathSync(self);
    } catch {
        return false;
    }
}

if (isEntryPoint()) {
    await patchRegisteredSdks(repoRoot, { log: message => console.log(`[patch-zkapi-sdk] ${message}`) });
}
