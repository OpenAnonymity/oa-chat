import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs/promises';
import esbuild from 'esbuild';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');

await esbuild.build({
    entryPoints: [path.join(scriptDir, 'supertokens-session-entry.js')],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: ['es2020'],
    minify: true,
    legalComments: 'inline',
    banner: {
        js: '/*! SuperTokens session SDK bundle; Apache-2.0; see supertokens-session.LICENSE.md */',
    },
    outfile: path.join(repoRoot, 'chat/vendor/supertokens-session.js'),
});

const licensePackages = ['supertokens-web-js', 'supertokens-website'];
const licenseSections = await Promise.all(licensePackages.map(async (packageName) => {
    const license = await fs.readFile(
        path.join(repoRoot, 'node_modules', packageName, 'LICENSE.md'),
        'utf8'
    );
    // Upstream license markdown contains trailing spaces on blank lines. Keep
    // the checked-in vendor artifact deterministic across every production
    // build instead of dirtying the worktree during prebuild.
    const normalizedLicense = license.replace(/[ \t]+$/gm, '').trim();
    return `# ${packageName}\n\n${normalizedLicense}\n`;
}));
await fs.writeFile(
    path.join(repoRoot, 'chat/vendor/supertokens-session.LICENSE.md'),
    licenseSections.join('\n---\n\n'),
    'utf8'
);
