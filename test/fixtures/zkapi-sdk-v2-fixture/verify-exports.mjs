// Check that the fixture SDK exports exactly the names of the real SDK.
//
//   node test/fixtures/zkapi-sdk-v2-fixture/verify-exports.mjs
//       the fixture against real-sdk-exports.json, which records a digest of
//       each real name list (works offline)
//   node test/fixtures/zkapi-sdk-v2-fixture/verify-exports.mjs <real SDK root>
//       ... and the real SDK itself, name by name. The root is the SDK package
//       root (or its sdk/ directory); ZKAPI_REAL_SDK_ROOT is read when no
//       argument is given. A root that does not exist skips the real comparison.
//   node test/fixtures/zkapi-sdk-v2-fixture/verify-exports.mjs <real SDK root> --update
//       re-record the digests from the real SDK, then compare.
//
// Lists compared: package name, version and exports map; the export names of
// every subpath; the instance surface of the two singleton classes (methods,
// which of them are async, getters, constructor fields). The real SDK is only
// read: modules are bundled to read their export names (esbuild metafile) and
// class bodies are scanned as text. None of its code is executed.
// Exit status 1 on any difference.
//
// A script, not a test: no exports, imported by nothing, and its name does not
// match the test runner's *.test.* pattern.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const RECORD = path.join(here, 'real-sdk-exports.json');
const args = process.argv.slice(2);
const update = args.includes('--update');
const realArgument = args.find(arg => !arg.startsWith('--')) || process.env.ZKAPI_REAL_SDK_ROOT || '';

const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const digest = names => createHash('sha256').update(names.join('\n')).digest('hex');

// facts -> Map of list name -> sorted array of strings
function lists({ pkg, subpaths, surface }) {
    const result = new Map();
    result.set('package', [`name=${pkg.name}`, `version=${pkg.version}`,
        ...Object.entries(pkg.exports).map(([key, value]) => `exports ${key}=${value}`)].sort());
    for (const [subpath, names] of Object.entries(subpaths)) result.set(`exports ${subpath}`, [...names].sort());
    for (const [target, kinds] of Object.entries(surface)) {
        for (const [kind, names] of Object.entries(kinds)) result.set(`${target} ${kind}`, [...names].sort());
    }
    return result;
}

async function describeClass(Class) {
    const methods = []; const asyncMethods = []; const getters = [];
    for (const [name, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(Class.prototype))) {
        if (name === 'constructor') continue;
        if (descriptor.get) getters.push(name);
        else if (typeof descriptor.value === 'function') {
            methods.push(name);
            if (descriptor.value.constructor.name === 'AsyncFunction') asyncMethods.push(name);
        }
    }
    return { methods, asyncMethods, getters, fields: Object.keys(new Class()) };
}

// The fixture is our own code: import it.
async function fixtureLists() {
    const pkg = readJson(path.join(here, 'package.json'));
    const load = target => import(pathToFileURL(path.join(here, target)).href);
    const subpaths = {};
    for (const [subpath, target] of Object.entries(pkg.exports)) {
        if (subpath !== './package.json') subpaths[subpath] = Object.keys(await load(target));
    }
    const { ZkapiClient } = await load(pkg.exports['./client']);
    const { BrowserWalletRuntime } = await load(pkg.exports['./runtime']);
    return lists({ pkg, subpaths, surface: {
        client: await describeClass(ZkapiClient), runtime: await describeClass(BrowserWalletRuntime)
    } });
}

// Members of `class <name>` declared at four-space indentation, as the real
// SDK writes them, plus the `this.x =` fields of its constructor.
function scanClass(file, name) {
    const text = fs.readFileSync(file, 'utf8').split('\n');
    const start = text.findIndex(line => new RegExp(`^class ${name}\\b`).test(line));
    if (start < 0) throw new Error(`class ${name} not found in ${file}`);
    const methods = []; const asyncMethods = []; const getters = []; const fields = [];
    let inConstructor = false;
    for (let i = start + 1; i < text.length && !/^}/.test(text[i]); i += 1) {
        const line = text[i];
        let match;
        if (/^    constructor\(/.test(line)) { inConstructor = true; continue; }
        if (inConstructor && /^    }/.test(line)) inConstructor = false;
        if (inConstructor && (match = /^        this\.([A-Za-z_$][\w$]*)\s*=/.exec(line))) fields.push(match[1]);
        if ((match = /^    get ([A-Za-z_$][\w$]*)\s*\(/.exec(line))) getters.push(match[1]);
        else if ((match = /^    (async )?([A-Za-z_$][\w$]*)\s*\(/.exec(line))) {
            methods.push(match[2]);
            if (match[1]) asyncMethods.push(match[2]);
        }
    }
    return { methods: [...new Set(methods)], asyncMethods, getters, fields };
}

async function realLists(root) {
    const { build } = await import('esbuild');
    const pkg = readJson(path.join(root, 'package.json'));
    const subpaths = {};
    for (const [subpath, target] of Object.entries(pkg.exports)) {
        if (subpath === './package.json') continue;
        const result = await build({
            entryPoints: [path.resolve(root, target)], bundle: true, write: false, metafile: true, format: 'esm',
            platform: subpath === './build' ? 'node' : 'browser', outdir: '/out', external: ['node:*'], logLevel: 'silent'
        });
        const outputs = Object.values(result.metafile.outputs);
        if (outputs.length !== 1) throw new Error(`Unexpected bundle outputs for ${subpath}.`);
        subpaths[subpath] = outputs[0].exports;
    }
    const surface = {
        client: scanClass(path.resolve(root, pkg.exports['./client']), 'ZkapiClient'),
        runtime: scanClass(path.resolve(root, pkg.exports['./runtime']), 'BrowserWalletRuntime')
    };
    return lists({ pkg, subpaths, surface });
}

function realRootOf(value) {
    if (!value) return null;
    const given = path.resolve(value);
    return [given, path.dirname(given)].find(candidate =>
        fs.existsSync(path.join(candidate, 'package.json')) && fs.existsSync(path.join(candidate, 'sdk'))) || null;
}

const problems = [];
const fixture = await fixtureLists();
const realRoot = realRootOf(realArgument);
let recorded = fs.existsSync(RECORD) ? readJson(RECORD).lists : null;

if (realRoot) {
    const real = await realLists(realRoot);
    const digests = Object.fromEntries([...real].map(([key, names]) => [key, { count: names.length, sha256: digest(names) }]));
    if (update) {
        fs.writeFileSync(RECORD, `${JSON.stringify({
            source: 'zkapi browser SDK 0.2.0 (82c8504, unpublished). Re-record: verify-exports.mjs <real SDK root> --update',
            lists: digests
        }, null, 2)}\n`);
        recorded = digests;
        console.log('recorded real-sdk-exports.json');
    } else if (JSON.stringify(recorded) !== JSON.stringify(digests)) {
        problems.push('real-sdk-exports.json is out of date for the real SDK (re-record with --update)');
    }
    for (const key of new Set([...real.keys(), ...fixture.keys()])) {
        const want = real.get(key) || []; const have = fixture.get(key) || [];
        const missing = want.filter(name => !have.includes(name));
        const extra = have.filter(name => !want.includes(name));
        if (missing.length) problems.push(`${key}: missing from the fixture: ${missing.join(' ')}`);
        if (extra.length) problems.push(`${key}: extra in the fixture: ${extra.join(' ')}`);
    }
} else if (update) {
    console.error(`--update needs the real SDK root; ${realArgument || 'none was given'} is not one.`);
    process.exit(2);
} else {
    console.log(realArgument
        ? `skipped the real SDK comparison: ${realArgument} is not an SDK package root.`
        : 'skipped the real SDK comparison: no root given (argument or ZKAPI_REAL_SDK_ROOT).');
}

if (!recorded) {
    console.error('real-sdk-exports.json is missing; run with the real SDK root and --update.');
    process.exit(2);
}
if (!realRoot) {
    // Offline: the recorded digests are the only reference.
    for (const key of new Set([...Object.keys(recorded), ...fixture.keys()])) {
        const have = fixture.get(key);
        if (!recorded[key] || !have) problems.push(`${key}: ${recorded[key] ? 'missing from the fixture' : 'not recorded'}`);
        else if (recorded[key].sha256 !== digest(have)) {
            problems.push(`${key}: ${have.length} fixture names differ from the ${recorded[key].count} recorded for the real SDK`);
        }
    }
}

if (problems.length) {
    for (const problem of problems) console.error(`MISMATCH ${problem}`);
    process.exit(1);
}
console.log(`ok: ${fixture.size} name lists match${realRoot ? ' the real SDK, name by name' : ' the recorded real SDK digests'}`);
