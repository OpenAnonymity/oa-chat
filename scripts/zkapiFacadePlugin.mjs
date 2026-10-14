// esbuild plugin that lets one app bundle carry more than one zkAPI SDK.
//
// Active only when a plan needs it (facadeRequired): more than one live
// version, or one live version installed under a non-canonical package alias.
// Single-version builds with the canonical alias are wired exactly as before:
// the application's `@openanonymity/zkapi-browser-sdk/...` imports resolve to
// the installed package and none of this runs.
//
// How it works
//
//   chat/zkapi/**  --import '@openanonymity/zkapi-browser-sdk/client'-->  facade
//
//   facade  oa-zkapi-facade:<sub>   one per SDK subpath the app imports. Its
//           exports are `let` live bindings, the UNION of the export names of
//           every live SDK's subpath (read from esbuild's metafile; no SDK code
//           is executed). `__oaBind(namespace)` fills them in.
//   variant oa-zkapi-variant:<id>   one per live version: `import * as` of that
//           alias's real modules, one per facade subpath. Its own chunk, so a
//           page fetches only the SDK it uses.
//   loader  chat/zkapi/versioning/variants.js   REPLACED at bundle time by a
//           generated module whose loadVariant(id) imports exactly one variant
//           (literal `import('oa-zkapi-variant:<id>')` branches: chunk names
//           are hashes) and binds every facade to it.
//
// Boot contract (chat/zkapi/boot.js):
//
//   1. Statically import only SDK-free modules, among them versioning/variants.js.
//   2. await loadVariant(version.id)  BEFORE importing anything that reads the SDK:
//      the `import('@openanonymity/zkapi-browser-sdk/...')` calls and
//      `chat/zkapi/index.js` come after, so module-scope reads see bound values.
//   3. loadVariant rejects with code `no_variants` in a build that has no
//      facades (sdk-default or a single canonical-alias build): boot treats
//      exactly that code as "nothing to load". Any other rejection is
//      `unknown_variant` / `variant_conflict` / an import failure and makes the
//      boot unavailable. A second, different id in one page is refused: one SDK
//      per page (globalThis.zkapiClient, the shared wallet slot and its lock).
//
// Importers outside chat/zkapi may not import the SDK in a faceted build, and no
// code may import a live non-canonical alias directly: either would bundle a
// second, unbound copy of an SDK next to the facade and break "one SDK per page".
//
// A facade exports the UNION of the live SDKs' names, so a name only some of
// them export would be bound `undefined` under the others with no build error.
// The build therefore also requires every NAMED import of the SDK in chat/zkapi
// to be exported by EVERY live SDK (assertSdkNameParity); a name that is
// intentionally guarded at its use is listed, with its reason, in
// GUARDED_UNION_ONLY_NAMES. Imports are read with esbuild's own parser
// (scanSdkImports), so comments and strings never count.
import fs from 'node:fs/promises';
import path from 'node:path';
import { CANONICAL_SDK_ALIAS, resolveSdkEntry, resolveSdkPackage } from './zkapiRegistry.mjs';

const FACADE_NAMESPACE = 'oa-zkapi-facade';
const VARIANT_NAMESPACE = 'oa-zkapi-variant';

const ROOT_SUBPATH = '@root';
const FACADE_PREFIX = `${FACADE_NAMESPACE}:`;
const VARIANT_PREFIX = `${VARIANT_NAMESPACE}:`;
const BIND_FUNCTION = '__oaBind';
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
// SDK subpaths that are build-time only (Node built-ins) or data. Never part of
// the browser graph.
const NON_BROWSER_SUBPATHS = new Set(['build', 'package.json']);
// Namespace of the stand-in module the import scan resolves SDK specifiers to.
const SCAN_NAMESPACE = 'oa-zkapi-scan';
// esbuild's wording for a named import (or re-export) a module does not export,
// and for a namespace member that can never be defined. The scan module exports
// nothing, so each message names one imported name.
const MISSING_EXPORT = new RegExp(`^No matching export in "${SCAN_NAMESPACE}:([^"]*)" for import "(.*)"$`);
const UNDEFINED_MEMBER = new RegExp(
    `^Import "(.*)" will always be undefined because there is no matching export in "${SCAN_NAMESPACE}:([^"]*)"$`
);

/**
 * Names chat/zkapi imports from the SDK although a live SDK does not export
 * them, each used behind a runtime guard. A facade binds such a name `undefined`
 * under the SDK that lacks it, so listing one is a reviewed decision:
 *
 *   { subpath: 'wallet', name: 'parseTokenAmount', reason: 'why the use is guarded' }
 *
 * `subpath` is '' for the package root and `name` is 'default' for a default
 * import. An entry that nothing imports, or that every live SDK now exports,
 * fails the build so the list cannot go stale. Empty today: every name the host
 * imports exists in every SDK, and host helpers live in chat/zkapi/services.
 */
export const GUARDED_UNION_ONLY_NAMES = Object.freeze([]);

const escapeRegExp = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const isUnder = (file, directory) => typeof file === 'string'
    && (file === directory || file.startsWith(`${directory}${path.sep}`));

function buildError(message) {
    return new Error(`[build] ${message}`);
}

// esbuild reports importers by their real path; compare like with like. A file
// that does not exist yet resolves through its directory.
async function realPath(file) {
    try {
        return await fs.realpath(file);
    } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
        return path.join(await fs.realpath(path.dirname(file)), path.basename(file));
    }
}

/** Whether a plan needs the facade mechanism at all. */
export function facadeRequired(plan) {
    return Boolean(plan) && plan.mode !== 'sdk-default'
        && (plan.mode === 'multi' || plan.versions.some(version => version.sdk.alias !== CANONICAL_SDK_ALIAS));
}

// ---------------------------------------------------------------------------
// Source scan: which SDK subpaths and names does the application import?
// ---------------------------------------------------------------------------

async function sourceFiles(directory) {
    const found = [];
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
        const absolute = path.join(directory, entry.name);
        if (entry.isDirectory()) found.push(...await sourceFiles(absolute));
        else if (entry.isFile() && /\.(?:m?js)$/.test(entry.name)) found.push(absolute);
    }
    return found.sort();
}

/**
 * What the sources under `importerRoot` import from the canonical SDK, as
 * esbuild's parser sees it. Only real import, re-export and dynamic-import
 * specifiers count: a comment or a string that merely mentions the package is
 * not an import and cannot add a facade or fail the build.
 *
 * Returns `{ subpaths, names }`:
 *   subpaths  sorted subpaths ('' is the package root) of every specifier.
 *   names     Map subpath -> Map name -> sorted importing files (relative to
 *             importerRoot) for every named or default import, named
 *             re-export and namespace member access. A dynamic import, a
 *             star re-export or a computed member names nothing the scan can
 *             attribute: its subpath is found, its names are not.
 *
 * Nothing is executed or written. Every file is an entry point, every other
 * module is external, and the SDK specifiers resolve to an empty ESM module, so
 * each imported name surfaces as one esbuild message. An error that is not
 * about an imported name (a file that does not parse) fails the scan: the
 * result is never a partial list.
 */
export async function scanSdkImports(esbuild, importerRoot, alias = CANONICAL_SDK_ALIAS) {
    if (!esbuild || typeof esbuild.build !== 'function') {
        throw new TypeError('[build] scanSdkImports needs the esbuild module.');
    }
    const files = await sourceFiles(importerRoot);
    if (!files.length) return { subpaths: [], names: new Map() };
    const subpaths = new Set();
    const specifier = new RegExp(`^${escapeRegExp(alias)}(?:/(.*))?$`);
    const plugin = {
        name: 'oa-zkapi-import-scan',
        setup(build) {
            build.onResolve({ filter: /.*/ }, args => {
                if (args.kind === 'entry-point') return null;
                const match = specifier.exec(args.path);
                if (!match) return { path: args.path, external: true };
                const subpath = match[1] || '';
                subpaths.add(subpath);
                // The package root ('') still needs a non-empty module path.
                return { path: `/${subpath}`, namespace: SCAN_NAMESPACE };
            });
            build.onLoad({ filter: /.*/, namespace: SCAN_NAMESPACE }, () => ({ contents: 'export {};', loader: 'js' }));
        }
    };
    let outcome;
    try {
        outcome = await esbuild.build({
            entryPoints: Object.fromEntries(files.map((file, index) => [`e${index}`, file])),
            bundle: true, write: false, format: 'esm', platform: 'browser', target: 'esnext',
            outdir: path.join(importerRoot, '.oa-zkapi-import-scan'), absWorkingDir: importerRoot,
            logLevel: 'silent', plugins: [plugin]
        });
    } catch (failure) {
        // A BuildFailure carries the messages; they are inspected below.
        if (!Array.isArray(failure?.errors)) {
            throw new Error(`[build] Could not scan the zkAPI SDK imports of ${importerRoot}: ${failure?.message}`, { cause: failure });
        }
        outcome = failure;
    }
    const names = new Map();
    const record = (subpathKey, name, file) => {
        const subpath = subpathKey.slice(1);
        if (!names.has(subpath)) names.set(subpath, new Map());
        const byName = names.get(subpath);
        if (!byName.has(name)) byName.set(name, new Set());
        if (file) byName.get(name).add(file.split(path.sep).join('/'));
    };
    const unexpected = [];
    for (const message of outcome.errors || []) {
        const missing = MISSING_EXPORT.exec(message.text);
        if (missing) record(missing[1], missing[2], message.location?.file);
        else unexpected.push(message);
    }
    for (const message of outcome.warnings || []) {
        const member = UNDEFINED_MEMBER.exec(message.text);
        if (member) record(member[2], member[1], message.location?.file);
    }
    if (unexpected.length) {
        const [first] = unexpected;
        const where = first.location ? ` (${first.location.file}:${first.location.line})` : '';
        throw buildError(`Could not scan the zkAPI SDK imports of ${importerRoot}: ${first.text}${where}`);
    }
    return {
        subpaths: [...subpaths].sort(),
        names: new Map([...names].map(([subpath, byName]) => [
            subpath, new Map([...byName].map(([name, set]) => [name, [...set].sort()]))
        ]))
    };
}

// ---------------------------------------------------------------------------
// Name parity: every imported name must exist in every live SDK
// ---------------------------------------------------------------------------

function validateGuarded(guarded) {
    if (!Array.isArray(guarded)) throw new TypeError('[build] The guarded SDK names must be an array.');
    for (const entry of guarded) {
        if (!entry || typeof entry.subpath !== 'string' || typeof entry.name !== 'string' || !entry.name
            || typeof entry.reason !== 'string' || !entry.reason.trim()) {
            throw buildError('Every guarded zkAPI SDK name needs a subpath, a name and a reason.');
        }
    }
}

/**
 * The imported names a live SDK does not export, and the allowlist entries
 * that no longer do anything. Pure.
 *
 *   imported       Map subpath -> Map name -> files (scanSdkImports `names`)
 *   variants       [{ id, alias, modules: [{ subpath, file }] }], one per live
 *                  SDK; a subpath the SDK does not export has no module
 *   exportsByFile  Map file -> export names (enumerateExports)
 *   guarded        allowlist entries ({ subpath, name, reason })
 *
 * An allowlist entry only excuses a UNION-ONLY name: one that some live SDK
 * exports and another does not. A name no live SDK exports is undefined
 * everywhere and is never excused.
 *
 * Returns `{ unavailable: [{ subpath, name, files, missing: [{ id, alias,
 * moduleMissing }] }], stale: [entry] }`, both sorted.
 */
export function findUnionOnlyImports({ imported, variants, exportsByFile, guarded = GUARDED_UNION_ONLY_NAMES }) {
    validateGuarded(guarded);
    const keyOf = (subpath, name) => JSON.stringify([subpath, name]);
    const byKey = ([a], [b]) => (a < b ? -1 : a > b ? 1 : 0);
    const allowed = new Set(guarded.map(entry => keyOf(entry.subpath, entry.name)));
    const excused = new Set();
    const unavailable = [];
    for (const [subpath, byName] of [...imported].sort(byKey)) {
        for (const [name, files] of [...byName].sort(byKey)) {
            const missing = [];
            for (const variant of variants) {
                const module = variant.modules.find(entry => entry.subpath === subpath);
                const exported = module ? exportsByFile.get(module.file) : null;
                if (!exported || !exported.includes(name)) {
                    missing.push({ id: variant.id, alias: variant.alias, moduleMissing: !module });
                }
            }
            if (!missing.length) continue;
            const key = keyOf(subpath, name);
            if (allowed.has(key) && missing.length < variants.length) {
                excused.add(key);
                continue;
            }
            unavailable.push({ subpath, name, files, missing });
        }
    }
    const stale = guarded.filter(entry => !excused.has(keyOf(entry.subpath, entry.name)));
    return { unavailable, stale };
}

const subpathLabel = subpath => `${CANONICAL_SDK_ALIAS}${subpath ? `/${subpath}` : ''}`;

/** Fail the build, naming each name, subpath and SDK, when parity does not hold. */
export function assertSdkNameParity(options) {
    const { unavailable, stale } = findUnionOnlyImports(options);
    if (unavailable.length) {
        const lines = unavailable.map(entry => {
            const label = entry.name === 'default' ? 'the default export' : entry.name;
            const where = entry.missing.map(missing => `${missing.alias} (${missing.id})${missing.moduleMissing ? ', which has no such subpath' : ''}`);
            return `  - ${label} of ${subpathLabel(entry.subpath)} is not exported by ${where.join(', ')}; imported by ${entry.files.join(', ') || 'chat/zkapi'}`;
        });
        throw buildError([
            'chat/zkapi imports SDK names that not every live zkAPI SDK exports; under the SDK that lacks one the facade binds it undefined at runtime.',
            'Move the helper into chat/zkapi/services, or guard the use and list it in GUARDED_UNION_ONLY_NAMES (scripts/zkapiFacadePlugin.mjs):',
            ...lines
        ].join('\n'));
    }
    if (stale.length) {
        const lines = stale.map(entry => `  - ${entry.name} of ${subpathLabel(entry.subpath)}`);
        throw buildError([
            'GUARDED_UNION_ONLY_NAMES lists names that are not union-only any more (nothing imports them, or every live SDK exports them). Remove them:',
            ...lines
        ].join('\n'));
    }
}

// ---------------------------------------------------------------------------
// Export enumeration (no SDK code is executed)
// ---------------------------------------------------------------------------

/**
 * Export names of each entry file, as esbuild's metafile reports them for an
 * ESM bundle of that entry. `files` is an array of absolute paths; the result
 * maps each to a sorted array of names (default included as 'default').
 */
async function enumerateExports(esbuild, files, { cwd = process.cwd() } = {}) {
    if (!files.length) return new Map();
    const entryPoints = Object.fromEntries(files.map((file, index) => [`e${index}`, file]));
    let result;
    try {
        result = await esbuild.build({
            entryPoints, bundle: true, write: false, metafile: true, format: 'esm', platform: 'browser',
            target: 'es2020', outdir: path.join(cwd, '.oa-zkapi-export-scan'), absWorkingDir: cwd, logLevel: 'silent'
        });
    } catch (cause) {
        throw new Error(`[build] Could not read the exports of the zkAPI SDK: ${cause?.message}`, { cause });
    }
    const names = new Map();
    for (const [output, info] of Object.entries(result.metafile.outputs)) {
        const index = /^e(\d+)\.js$/.exec(path.basename(output));
        if (!index || !Array.isArray(info.exports)) continue;
        names.set(files[Number(index[1])], [...new Set(info.exports)].sort());
    }
    for (const file of files) {
        if (!names.has(file)) throw buildError(`Could not read the exports of ${file}.`);
    }
    return names;
}

// ---------------------------------------------------------------------------
// Generated sources (pure; unit-tested directly)
// ---------------------------------------------------------------------------

/** Module text of one facade: live bindings plus its binder. */
export function renderFacadeModule({ names }) {
    const bound = [];
    names.forEach((name, index) => {
        if (name === BIND_FUNCTION) throw buildError(`The SDK exports a name reserved by the facade: ${name}.`);
        if (name !== 'default' && !IDENTIFIER.test(name)) {
            throw buildError(`The SDK exports a name the facade cannot bind: ${JSON.stringify(name)}.`);
        }
        bound.push({ name, local: `v${index}` });
    });
    const lines = ['// Generated by scripts/zkapiFacadePlugin.mjs. Live bindings filled by loadVariant().'];
    if (bound.length) {
        lines.push(`let ${bound.map(entry => entry.local).join(', ')};`);
        lines.push(`export { ${bound.map(entry => `${entry.local} as ${entry.name}`).join(', ')} };`);
    }
    lines.push(`export function ${BIND_FUNCTION}(namespace) {`);
    lines.push("    const source = namespace !== null && typeof namespace === 'object' ? namespace : {};");
    for (const entry of bound) lines.push(`    ${entry.local} = source[${JSON.stringify(entry.name)}];`);
    lines.push('}');
    return `${lines.join('\n')}\n`;
}

/** Module text of one variant: the real SDK modules of one live alias. */
export function renderVariantModule({ modules }) {
    const lines = ['// Generated by scripts/zkapiFacadePlugin.mjs. One live SDK; loaded by loadVariant().'];
    modules.forEach((entry, index) => lines.push(`import * as m${index} from ${JSON.stringify(entry.file)};`));
    lines.push('export const namespaces = Object.freeze({');
    modules.forEach((entry, index) => {
        lines.push(`    ${JSON.stringify(entry.subpath || ROOT_SUBPATH)}: m${index}${index < modules.length - 1 ? ',' : ''}`);
    });
    lines.push('});');
    return `${lines.join('\n')}\n`;
}

/** Module text that replaces chat/zkapi/versioning/variants.js. */
export function renderVariantsModule({ subpaths, variantIds }) {
    const lines = ['// Generated by scripts/zkapiFacadePlugin.mjs; replaces the checked-in stub at bundle time.'];
    subpaths.forEach((subpath, index) => {
        lines.push(`import { ${BIND_FUNCTION} as bind${index} } from ${JSON.stringify(`${FACADE_PREFIX}${subpath || ROOT_SUBPATH}`)};`);
    });
    lines.push('const binders = {');
    subpaths.forEach((subpath, index) => {
        lines.push(`    ${JSON.stringify(subpath || ROOT_SUBPATH)}: bind${index}${index < subpaths.length - 1 ? ',' : ''}`);
    });
    lines.push('};');
    lines.push('const loaders = {');
    variantIds.forEach((id, index) => {
        lines.push(`    ${JSON.stringify(id)}: () => import(${JSON.stringify(`${VARIANT_PREFIX}${id}`)})${index < variantIds.length - 1 ? ',' : ''}`);
    });
    lines.push('};');
    lines.push(`
let selected = null;
let pending = null;

// Loads the one SDK this page will use and binds every facade to it. A page
// runs exactly one SDK: a second, different id is refused rather than bound.
export function loadVariant(id) {
    if (typeof id !== 'string' || !Object.prototype.hasOwnProperty.call(loaders, id)) {
        return Promise.reject(Object.assign(new Error('No zkAPI build variant exists for that version.'), { code: 'unknown_variant' }));
    }
    if (selected !== null && selected !== id) {
        return Promise.reject(Object.assign(new Error('Another zkAPI variant is already loaded in this page.'), { code: 'variant_conflict' }));
    }
    if (pending === null) {
        selected = id;
        pending = loaders[id]().then(module => {
            for (const key of Object.keys(binders)) binders[key](module.namespaces[key]);
        }, error => {
            selected = null;
            pending = null;
            throw error;
        });
    }
    return pending;
}
`);
    return `${lines.join('\n')}\n`;
}

// ---------------------------------------------------------------------------
// The plugin
// ---------------------------------------------------------------------------

/**
 * options
 *   plan          BuildPlan (required)
 *   packageRoot   directory that holds package.json and node_modules
 *   importerRoot  directory whose files may import the SDK (chat/zkapi)
 *   variantsFile  the stub module replaced by the generated loader
 *   esbuild       the esbuild module (defaults to build.esbuild)
 *   guardedNames  union-only names the host guards at their use (defaults to
 *                 GUARDED_UNION_ONLY_NAMES); tests inject their own
 */
export function zkapiFacadePlugin({
    plan, packageRoot, importerRoot: configuredRoot, variantsFile, esbuild = null, guardedNames = GUARDED_UNION_ONLY_NAMES
} = {}) {
    if (!plan || !facadeRequired(plan)) throw buildError('The zkAPI facade plugin needs a plan with more than one SDK.');
    if (typeof packageRoot !== 'string' || typeof configuredRoot !== 'string') {
        throw new TypeError('[build] The zkAPI facade plugin needs packageRoot and importerRoot.');
    }
    validateGuarded(guardedNames);
    return {
        name: 'oa-zkapi-versions',
        async setup(build) {
            const importerRoot = await realPath(configuredRoot);
            const loaderFile = await realPath(variantsFile || path.join(configuredRoot, 'versioning', 'variants.js'));
            // No static or dynamic esbuild import lives in this file: the Vercel
            // route generator bundles it transitively and must stay free of bare
            // specifiers. A plugin always receives esbuild as build.esbuild.
            const engine = esbuild || build.esbuild;
            if (!engine || typeof engine.build !== 'function') {
                throw buildError('The zkAPI facade plugin needs the esbuild module (build.esbuild).');
            }
            const scan = await scanSdkImports(engine, importerRoot);
            const requested = scan.subpaths;
            for (const subpath of requested) {
                if (NON_BROWSER_SUBPATHS.has(subpath)) {
                    throw buildError(`${CANONICAL_SDK_ALIAS}/${subpath} is not a browser module; chat code may not import it.`);
                }
            }
            if (!requested.length) throw buildError('No zkAPI SDK imports were found under the importer root.');

            // Real modules per live version and facade subpath. A version that
            // does not export a subpath simply binds undefined there.
            const variants = [];
            for (const version of plan.versions) {
                const pkg = resolveSdkPackage(version.sdk.alias, packageRoot);
                const modules = [];
                for (const subpath of requested) {
                    const file = resolveSdkEntry(pkg, subpath);
                    if (file) modules.push({ subpath, file: await fs.realpath(file) });
                }
                variants.push({ id: version.id, alias: version.sdk.alias, modules });
            }
            const exportsByFile = await enumerateExports(engine,
                [...new Set(variants.flatMap(variant => variant.modules.map(module => module.file)))],
                { cwd: packageRoot });
            const facades = new Map();
            for (const subpath of requested) {
                const names = new Set();
                for (const variant of variants) {
                    const module = variant.modules.find(entry => entry.subpath === subpath);
                    if (module) for (const name of exportsByFile.get(module.file)) names.add(name);
                }
                if (!variants.some(variant => variant.modules.some(module => module.subpath === subpath))) {
                    throw buildError(`No live zkAPI SDK exports ${CANONICAL_SDK_ALIAS}${subpath ? `/${subpath}` : ''}.`);
                }
                facades.set(subpath || ROOT_SUBPATH, renderFacadeModule({ names: [...names].sort() }));
            }
            // The facades are unions; a name only some SDKs export would be
            // bound undefined under the rest with no error from esbuild.
            assertSdkNameParity({ imported: scan.names, variants, exportsByFile, guarded: guardedNames });
            const variantSources = new Map(variants.map(variant => [variant.id, renderVariantModule({ modules: variant.modules })]));
            const loaderSource = renderVariantsModule({
                subpaths: requested, variantIds: variants.map(variant => variant.id)
            });

            const canonical = new RegExp(`^${escapeRegExp(CANONICAL_SDK_ALIAS)}(?:/(.*))?$`);
            build.onResolve({ filter: canonical }, args => {
                if (!isUnder(args.importer, importerRoot)) {
                    return { errors: [{ text: `[build] ${args.importer || 'An entry point'} imports the zkAPI SDK; only files under ${importerRoot} may.` }] };
                }
                const subpath = canonical.exec(args.path)[1] || '';
                if (!requested.includes(subpath)) {
                    return { errors: [{ text: `[build] ${args.path} was not found by the SDK import scan.` }] };
                }
                return { path: subpath || ROOT_SUBPATH, namespace: FACADE_NAMESPACE };
            });

            // Live aliases other than the canonical name are reachable only
            // through the generated variants (absolute file paths).
            const others = [...new Set(plan.versions.map(version => version.sdk.alias))]
                .filter(alias => alias !== CANONICAL_SDK_ALIAS);
            if (others.length) {
                const direct = new RegExp(`^(?:${others.map(escapeRegExp).join('|')})(?:/.*)?$`);
                build.onResolve({ filter: direct }, args => ({
                    errors: [{ text: `[build] ${args.importer || 'An entry point'} imports ${args.path}; import the SDK as ${CANONICAL_SDK_ALIAS} so it goes through the version facade.` }]
                }));
            }

            build.onResolve({ filter: new RegExp(`^${escapeRegExp(FACADE_PREFIX)}`) }, args => {
                const subpath = args.path.slice(FACADE_PREFIX.length);
                return facades.has(subpath) ? { path: subpath, namespace: FACADE_NAMESPACE } : {
                    errors: [{ text: `[build] Unknown zkAPI facade ${args.path}.` }]
                };
            });
            build.onResolve({ filter: new RegExp(`^${escapeRegExp(VARIANT_PREFIX)}`) }, args => {
                const id = args.path.slice(VARIANT_PREFIX.length);
                return variantSources.has(id) ? { path: id, namespace: VARIANT_NAMESPACE } : {
                    errors: [{ text: `[build] Unknown zkAPI variant ${args.path}.` }]
                };
            });

            build.onLoad({ filter: /.*/, namespace: FACADE_NAMESPACE }, args => ({
                contents: facades.get(args.path), loader: 'js'
            }));
            build.onLoad({ filter: /.*/, namespace: VARIANT_NAMESPACE }, args => ({
                contents: variantSources.get(args.path), loader: 'js', resolveDir: packageRoot
            }));
            build.onLoad({ filter: /[\\/]variants\.js$/ }, args => {
                if (args.path !== loaderFile) return null;
                return { contents: loaderSource, loader: 'js', resolveDir: path.dirname(loaderFile) };
            });
        }
    };
}
