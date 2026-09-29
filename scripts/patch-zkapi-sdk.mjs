import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import patch from '../patches/zkapi-browser-sdk-wallet-recovery.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const digest = value => createHash('sha256').update(value).digest('hex');

export function zkapiSdkPatchProvenance() {
    return { name: 'wallet-recovery-v1', revision: patch.revision,
        sha256: digest(JSON.stringify(patch)),
        files: Object.fromEntries(patch.files.map(entry => [entry.file, entry.afterSha256])) };
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
    const updates = [];
    for (const entry of patch.files) {
        const target = path.join(directory, entry.file);
        let source = await fs.readFile(target, 'utf8');
        const hash = digest(source);
        if (hash === entry.afterSha256) continue;
        if (hash !== entry.beforeSha256) {
            throw new Error(`Unexpected zkAPI SDK contents in ${entry.file}. Reinstall or review the recovery patch.`);
        }
        for (const { before, after } of entry.replacements) {
            if (source.split(before).length !== 2) throw new Error(`Recovery patch context changed in ${entry.file}.`);
            source = source.replace(before, after);
        }
        if (digest(source) !== entry.afterSha256) throw new Error(`Recovery patch result mismatch in ${entry.file}.`);
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
