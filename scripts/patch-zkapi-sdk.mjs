import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import patch from '../patches/zkapi-browser-sdk-wallet-recovery.mjs';
import proofCachePatch from '../patches/zkapi-browser-sdk-proof-cache.mjs';
import providerVerificationPatch from '../patches/zkapi-browser-sdk-provider-verification.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const digest = value => createHash('sha256').update(value).digest('hex');
export const zkapiSdkPatches = [patch, proofCachePatch, providerVerificationPatch];

export function zkapiSdkPatchProvenance() {
    return { name: 'wallet-recovery-v1', revision: patch.revision,
        sha256: digest(JSON.stringify(patch)),
        files: Object.fromEntries(patch.files.map(entry => [entry.file, entry.afterSha256])) };
}

export function zkapiSdkPatchesProvenance() {
    return zkapiSdkPatches.map(definition => definition === patch ? zkapiSdkPatchProvenance() : {
        name: definition.name, revision: definition.revision,
        sha256: digest(JSON.stringify(definition)),
        files: Object.fromEntries(definition.files.map(entry => [entry.file, entry.afterSha256]))
    });
}

// Refuse SDK drift instead of silently shipping without a recovery repair.
// Both pristine and already patched installs are checked byte for byte.
export async function patchZkapiSdk(root = repoRoot) {
    const manifest = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
    const expected = `github:OpenAnonymity/zkapi#${patch.revision}`;
    if (manifest.dependencies?.['@openanonymity/zkapi-browser-sdk'] !== expected) {
        throw new Error('The zkAPI SDK revision changed. Review its deposit recovery patch before continuing.');
    }
    // Package consumers may hoist the SDK above oa-chat's directory.
    const directory = path.dirname(createRequire(path.join(root, 'package.json'))
        .resolve('@openanonymity/zkapi-browser-sdk/package.json'));
    const files = new Map();
    for (const definition of zkapiSdkPatches) {
        if (definition.revision !== patch.revision) throw new Error('The zkAPI SDK compatibility patches disagree on their revision.');
        for (const entry of definition.files) {
            const chain = files.get(entry.file) || [];
            if (chain.length && chain.at(-1).afterSha256 !== entry.beforeSha256) {
                throw new Error(`The zkAPI SDK patch chain is inconsistent for ${entry.file}.`);
            }
            chain.push(entry);
            files.set(entry.file, chain);
        }
    }
    const updates = [];
    for (const [file, chain] of files) {
        const target = path.join(directory, file);
        let source = await fs.readFile(target, 'utf8');
        const hash = digest(source);
        // Accept pristine files, a prior reviewed patch, or the final result.
        // This makes interrupted installs and repeat builds repairable while
        // refusing every unreviewed source state before writing any file.
        const completed = chain.findLastIndex(entry => hash === entry.afterSha256);
        if (completed === chain.length - 1) continue;
        if (completed < 0 && hash !== chain[0].beforeSha256) {
            throw new Error(`Unexpected zkAPI SDK contents in ${file}. Reinstall or review the compatibility patches.`);
        }
        for (const entry of chain.slice(completed + 1)) {
            for (const { before, after } of entry.replacements) {
                if (source.split(before).length !== 2) throw new Error(`Compatibility patch context changed in ${file}.`);
                source = source.replace(before, after);
            }
            if (digest(source) !== entry.afterSha256) throw new Error(`Compatibility patch result mismatch in ${file}.`);
        }
        updates.push([target, source]);
    }
    // Validate every file before modifying any. A partial interrupted install
    // remains repairable on the next invocation because each file is checked.
    for (const [target, source] of updates) await fs.writeFile(target, source);
    return updates.length;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    await patchZkapiSdk();
}
