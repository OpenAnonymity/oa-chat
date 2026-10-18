import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parse } from 'acorn';
import { ADAPTER_IDS, getAdapter } from '../../chat/zkapi/versioning/adapters/index.mjs';
import { WIRED } from '../../chat/zkapi/versioning/wiring.mjs';
import { SDK_HALF_WIRING } from '../../scripts/zkapiRegistry.mjs';

// WIRED is the host's statement that every behavior a protocol family makes
// mandatory is implemented. A name is only credible with evidence, so this
// file holds the evidence table and fails when it is not met:
//
//   - WIRED is exactly the union of every adapter's `requiredWiring`, and
//     cannot be changed at run time;
//   - every name has a runnable host test whose title starts
//     `wiring:<name>`, in a file that imports a named production symbol, and
//     that symbol exists in the module it is imported from;
//   - a test that only runs against a real successor SDK is activation
//     evidence and never the only evidence of a name;
//   - the behaviors with a half in the SDK itself are bound to the real-SDK
//     test that exercises that half;
//   - a known gap of a wired name is carried as a passing test titled
//     `wiring:<name>` that pins the gap as it is today: it fails when the gap
//     grows and when it is closed, so neither happens without the pin and the
//     documentation that states the gap being updated.
//
// Titles and imports are read from each test file's source with a real parser,
// so a renamed test, a removed import or a symbol that no longer exists fails
// here and not in front of a person.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const absolute = relative => path.join(repoRoot, relative);

// ---------------------------------------------------------------------------
// The evidence table
// ---------------------------------------------------------------------------

// One row is one test file and one production symbol it imports:
//
//   test        file with at least one runnable test for the name
//   module      production module the file imports, repository-relative
//   symbol      named export it imports from there ('default' for the default
//               export), or null for activation rows that drive the SDK only
//   member      optional: a function the symbol itself must carry (an adapter
//               object, a class or a facade)
//   titles      optional: title prefixes of tests that predate the
//               `wiring:` prefix, used instead of the prefix
//   activation  the row's tests only run against a real successor SDK (they
//               are skipped without one) and are never the only evidence
const row = (testFile, module, symbol, extra = {}) => ({ test: testFile, module, symbol, ...extra });

const T = name => `test/zkapi/${name}.test.mjs`;
const EXIT_REFUSAL = T('zkapi-exit-refusal');
const STATE_PROTOCOL = T('zkapi-version-state-protocol');
const NOTICES = T('zkapi-protocol-notices');
const FACADE = T('zkapi-facade-protocol');
const RECORD_EXTRAS = T('zkapi-record-extras');
const SIGNER = T('address-funding-escape-concession');
const REAL_SHAPES = T('zkapi-concession-real-shapes');
const RECOVERY = T('withdrawal-recovery');
const UI_RENDER = T('zkapi-version-ui-render');
const EXIT_CHOICE = T('zkapi-balance-extras-exit-choice');
const REHEARSAL = T('zkapi-v2-real-sdk-rehearsal');
const OTHER_CREDITS = T('zkapi-other-deployment-credits');

const EXIT_REFUSAL_MODULE = 'chat/zkapi/versioning/exitRefusal.mjs';
const STATE_MODULE = 'chat/zkapi/versioning/versionState.mjs';
const NOTICES_MODULE = 'chat/zkapi/components/VersionNotices.js';
const FACADE_MODULE = 'chat/zkapi/versioning/index.js';
const RECORD_EXTRAS_MODULE = 'chat/zkapi/components/RecordExtras.js';
const SIGNER_MODULE = 'chat/zkapi/services/addressFundingProvider.mjs';
const ADAPTER_MODULE = 'chat/zkapi/versioning/adapters/concessionV1.mjs';
const RECOVERY_MODULE = 'chat/zkapi/services/withdrawalRecovery.mjs';
const DIALOG_MODULE = 'chat/zkapi/components/AccountModal.js';

const EVIDENCE = {
    'deposit-activation': [
        row(T('zkapi-proved-activation'), 'chat/zkapi/components/BalanceExtras.js', 'renderBalanceExtras')
    ],
    // The service pause is said in the host's words by code, with "Check
    // again", from the snapshot, from errors, and from a refusal the snapshot
    // does not report.
    'service-message': [
        row(EXIT_REFUSAL, EXIT_REFUSAL_MODULE, 'readServiceRefusal'),
        row(STATE_PROTOCOL, STATE_MODULE, 'deriveVersionState'),
        row(NOTICES, NOTICES_MODULE, 'buildVersionNotices'),
        row(FACADE, FACADE_MODULE, 'createZkapiVersioning')
    ],

    // A payout the contract credited is "held", claimed from Payment history.
    'credited-payouts': [
        row(RECORD_EXTRAS, RECORD_EXTRAS_MODULE, 'recordExtras'),
        row(SIGNER, SIGNER_MODULE, 'AddressFundingProvider'),
        row(NOTICES, NOTICES_MODULE, 'buildVersionNotices'),
        row(FACADE, FACADE_MODULE, 'createZkapiVersioning'),
        row(REHEARSAL, SIGNER_MODULE, 'AddressFundingProvider', { activation: true })
    ],

    // A close that paid less than expected is a standing note and a notice.
    'payout-alert': [
        row(RECORD_EXTRAS, RECORD_EXTRAS_MODULE, 'recordExtras'),
        row(NOTICES, NOTICES_MODULE, 'buildVersionNotices'),
        row(FACADE, FACADE_MODULE, 'createZkapiVersioning')
    ],

    // A balance another device used is explained, not offered for a
    // withdrawal that would be rejected.
    'device-not-newest': [
        row(STATE_PROTOCOL, STATE_MODULE, 'deriveVersionState'),
        row(RECORD_EXTRAS, RECORD_EXTRAS_MODULE, 'recordExtras'),
        row(NOTICES, NOTICES_MODULE, 'buildVersionNotices'),
        row(FACADE, FACADE_MODULE, 'createZkapiVersioning')
    ],

    // New chats pause near expiry, with the way out, never an upgrade nudge.
    'near-expiry': [
        row(STATE_PROTOCOL, STATE_MODULE, 'deriveVersionState'),
        row(NOTICES, NOTICES_MODULE, 'buildVersionNotices'),
        row(FACADE, FACADE_MODULE, 'createZkapiVersioning')
    ],

    // A refused withdrawal says when it can be retried and what the choice
    // costs; the signer holds the withdrawal to the bound that was disclosed.
    // Rows without `wiring:` titles name the dialog's own call site and the
    // choice markup by title prefix.
    //
    // Not implemented, and no row below claims it: the dialog's call sites
    // that CONTINUE a withdrawal (retrying an unknown or dropped one,
    // withdrawing a set-aside balance) name no bound to the signer, so a
    // conceding escape the signer has not itself accepted is refused there
    // and the person starts again from the dialog. That fails closed. It is
    // the one known gap of this name, pinned by the last test of this file.
    'ownership-proof-wait': [
        row(EXIT_REFUSAL, EXIT_REFUSAL_MODULE, 'readExitRefusal'),
        row(SIGNER, SIGNER_MODULE, 'AddressFundingProvider'),
        row(NOTICES, NOTICES_MODULE, 'buildVersionNotices'),
        row(FACADE, FACADE_MODULE, 'createZkapiVersioning'),
        row(UI_RENDER, DIALOG_MODULE, 'default', {
            member: 'submitWithdrawal',
            titles: [
                'what the person chose about a settling chat is what the signer is told',
                'a page drawn for something else, or before the figure grew'
            ]
        }),
        row(EXIT_CHOICE, 'chat/zkapi/components/ExitChoice.js', 'readExitChoice', {
            titles: [
                'waiting gives up nothing now, and carries the bound that was shown',
                'leaving now with nothing given up asks for exactly nothing'
            ]
        }),
        row(REHEARSAL, SIGNER_MODULE, 'AddressFundingProvider', { activation: true })
    ],

    // The balance and the prepared withdrawal are re-verified under the
    // wallet lock, after settling and connecting, right before the SDK. The
    // SDK half is the real-SDK row.
    'withdrawal-operation-recheck': [
        row(RECOVERY, RECOVERY_MODULE, 'assertWithdrawalEscapeAvailable'),
        row(UI_RENDER, DIALOG_MODULE, 'default', { member: 'submitWithdrawal' }),
        row(FACADE, FACADE_MODULE, 'createZkapiVersioning'),
        row(REHEARSAL, RECOVERY_MODULE, 'assertWithdrawalEscapeAvailable', { activation: true })
    ],

    // Another deployment's unfinished withdrawal holds new deposits.
    'other-deployment-withdrawals': [
        row(REAL_SHAPES, ADAPTER_MODULE, 'default', { member: 'normalizeSnapshot' }),
        row(NOTICES, NOTICES_MODULE, 'buildVersionNotices'),
        row(FACADE, FACADE_MODULE, 'createZkapiVersioning')
    ],

    // Other deployments' credits never block deposits and keep their amount.
    // The adapter reads the SDK's own list; the state, the notice and the
    // facade are what that list reaches when the holdings read knows nothing.
    'other-deployment-credits': [
        row(REAL_SHAPES, ADAPTER_MODULE, 'default', { member: 'normalizeSnapshot' }),
        row(OTHER_CREDITS, STATE_MODULE, 'deriveVersionState'),
        row(OTHER_CREDITS, NOTICES_MODULE, 'buildVersionNotices'),
        row(OTHER_CREDITS, FACADE_MODULE, 'createZkapiVersioning')
    ]
};

// The behaviors with a half in the SDK itself (scripts/zkapiRegistry.mjs,
// SDK_HALF_WIRING), and the real-SDK test that exercises that half. The
// registry CLI check and the build refuse a live row without a patch that
// covers it; this test is what the activation change runs against the
// revision that provides it.
const SDK_HALF_TESTS = {
    'withdrawal-operation-recheck': {
        test: REHEARSAL,
        title: 'wiring:withdrawal-operation-recheck the SDK refuses to prepare or claim a withdrawal replaced after it was displayed'
    }
};

// ---------------------------------------------------------------------------
// Reading test sources
// ---------------------------------------------------------------------------

const parsed = new Map();

function parseFile(relative) {
    if (!parsed.has(relative)) {
        const source = fs.readFileSync(absolute(relative), 'utf8');
        parsed.set(relative, parse(source, { ecmaVersion: 'latest', sourceType: 'module', allowHashBang: true, locations: true }));
    }
    return parsed.get(relative);
}

function walk(node, visit, parent = null) {
    if (!node || typeof node.type !== 'string') return;
    visit(node, parent);
    for (const key of Object.keys(node)) {
        const value = node[key];
        if (Array.isArray(value)) value.forEach(child => walk(child, visit, node));
        else if (value && typeof value === 'object') walk(value, visit, node);
    }
}

const propertyName = property => {
    if (property.computed) return null;
    return property.key.type === 'Identifier' ? property.key.name : String(property.key.value);
};

// Every test declared in a file: its title (the literal text of a template
// title, with `${}` for each expression) and whether it is gated on the
// environment (an options object that carries `skip` or `todo`, or
// `test.skip`). A test is declared by a call to `test` or `it`.
function declaredTests(relative) {
    const found = [];
    walk(parseFile(relative), node => {
        if (node.type !== 'CallExpression') return;
        const callee = node.callee;
        const base = callee.type === 'MemberExpression' ? callee.object : callee;
        if (base.type !== 'Identifier' || !['test', 'it'].includes(base.name)) return;
        const [first, second] = node.arguments;
        let title = null;
        if (first?.type === 'Literal' && typeof first.value === 'string') title = first.value;
        if (first?.type === 'TemplateLiteral') title = first.quasis.map(part => part.value.cooked).join('${}');
        if (title === null) return;
        let gated = callee.type === 'MemberExpression' && ['skip', 'todo'].includes(callee.property.name);
        if (second?.type === 'ObjectExpression') {
            for (const property of second.properties) {
                const name = property.type === 'Property' ? propertyName(property) : null;
                if (name !== 'skip' && name !== 'todo') continue;
                // `{ skip: false }` is an ordinary test; anything computed from
                // the environment is gated.
                const literalFalse = property.value.type === 'Literal' && property.value.value === false;
                if (!literalFalse) gated = true;
            }
        }
        found.push({ title, gated });
    });
    return found;
}

// A `wiring:<name>` title must continue with something that is not part of a
// name, so one name is never mistaken for another that it prefixes.
const wiringTitle = name => new RegExp(`^wiring:${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![a-z0-9-])`);

// Which names a file imports from which module, as {absolute path: Set(name)}.
// Static imports, `const { a, default: b } = await import(...)`,
// `(await import(...)).a`, and a namespace (`import * as ns`,
// `const ns = await import(...)`) used as `ns.a`. Only relative specifiers are
// production modules; packages are left out.
function importedNames(relative) {
    const base = path.dirname(absolute(relative));
    const ast = parseFile(relative);
    const parents = new Map();
    walk(ast, (node, parent) => parents.set(node, parent));
    const modules = new Map();
    const namespaces = [];
    const record = (specifier, names) => {
        if (!specifier.startsWith('.')) return;
        const target = path.resolve(base, specifier);
        if (!modules.has(target)) modules.set(target, new Set());
        for (const name of names) modules.get(target).add(name);
    };
    walk(ast, node => {
        if (node.type === 'ImportDeclaration') {
            const names = [];
            for (const specifier of node.specifiers) {
                if (specifier.type === 'ImportSpecifier') names.push(specifier.imported.name ?? String(specifier.imported.value));
                else if (specifier.type === 'ImportDefaultSpecifier') names.push('default');
                else namespaces.push({ specifier: node.source.value, local: specifier.local.name });
            }
            record(node.source.value, names);
            return;
        }
        if (node.type !== 'ImportExpression' || node.source.type !== 'Literal' || typeof node.source.value !== 'string') return;
        const specifier = node.source.value;
        record(specifier, []);
        const awaited = parents.get(node);
        if (awaited?.type !== 'AwaitExpression') return;
        const holder = parents.get(awaited);
        if (holder?.type === 'VariableDeclarator' && holder.init === awaited) {
            if (holder.id.type === 'ObjectPattern') {
                record(specifier, holder.id.properties.filter(property => property.type === 'Property')
                    .map(propertyName).filter(Boolean));
            } else if (holder.id.type === 'Identifier') {
                namespaces.push({ specifier, local: holder.id.name });
            }
        } else if (holder?.type === 'MemberExpression' && holder.object === awaited && !holder.computed) {
            record(specifier, [holder.property.name]);
        }
    });
    // `ns.name` uses of a namespace binding.
    walk(ast, node => {
        if (node.type !== 'MemberExpression' || node.computed || node.object.type !== 'Identifier') return;
        for (const namespace of namespaces) {
            if (namespace.local === node.object.name) record(namespace.specifier, [node.property.name]);
        }
    });
    return modules;
}

// The `wiring:<name>` of every test declared anywhere under test/ (fixtures
// excepted), found by text so that a file that does not parse is still seen.
function wiringNamesInTests() {
    const names = new Set();
    const visit = directory => {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
            const file = path.join(directory, entry.name);
            if (entry.isDirectory()) {
                if (entry.name !== 'fixtures' && entry.name !== 'node_modules') visit(file);
            } else if (/\.test\.(?:mjs|js|cjs)$/.test(entry.name)) {
                const source = fs.readFileSync(file, 'utf8');
                for (const match of source.matchAll(/\b(?:test|it)(?:\.\w+)?\(\s*['"`]wiring:([A-Za-z0-9_-]+)/g)) names.add(match[1]);
            }
        }
    };
    visit(absolute('test'));
    return names;
}

// ---------------------------------------------------------------------------
// The set
// ---------------------------------------------------------------------------

test('WIRED is exactly the union of every adapter\'s requiredWiring', () => {
    const required = new Set(ADAPTER_IDS.flatMap(id => getAdapter(id).requiredWiring));
    const unlisted = [...required].filter(name => !WIRED.has(name));
    const unrequired = [...WIRED].filter(name => !required.has(name));
    assert.deepEqual(unlisted, [], 'an adapter requires a behavior the host does not list as wired');
    assert.deepEqual(unrequired, [], 'the host lists a behavior no adapter requires');
    assert.equal(WIRED.size, required.size);
    // The family that exists today asks for nine (the web exit-kit feature is removed).
    assert.equal(getAdapter('concession-v1').requiredWiring.length, 9);
    assert.deepEqual(getAdapter('note-bound-v1').requiredWiring, []);
});

test('WIRED cannot be changed at run time', () => {
    const before = [...WIRED];
    assert.ok(WIRED instanceof Set);
    assert.throws(() => WIRED.add('a-behavior-nobody-wrote'), TypeError);
    assert.throws(() => WIRED.delete(before[0]), TypeError);
    assert.throws(() => WIRED.clear(), TypeError);
    assert.deepEqual([...WIRED], before);
});

test('a withdrawal re-verification is the host\'s own: no adapter supplies a beforeWithdraw seam', () => {
    for (const id of ADAPTER_IDS) {
        assert.equal(getAdapter(id).beforeWithdraw, undefined, id);
    }
});

// ---------------------------------------------------------------------------
// The evidence
// ---------------------------------------------------------------------------

test('every wired name has evidence, and every piece of evidence is for a wired name', () => {
    assert.deepEqual(Object.keys(EVIDENCE).sort(), [...WIRED].sort());
    for (const name of WIRED) {
        assert.ok(EVIDENCE[name].length > 0, name);
        // At least one row is not activation-only: a name never rests on a
        // test that is skipped without a real successor SDK.
        assert.ok(EVIDENCE[name].some(entry => !entry.activation), `${name} has only activation evidence`);
    }
});

test('no test names a behavior that is not wired (a typo would otherwise be silent evidence for nothing)', () => {
    const unknown = [...wiringNamesInTests()].filter(name => !WIRED.has(name));
    assert.deepEqual(unknown, []);
    // And the scan sees the tests: every wired name is found in some title.
    const seen = wiringNamesInTests();
    for (const name of WIRED) assert.ok(seen.has(name), `no test is titled wiring:${name}`);
});

for (const name of Object.keys(EVIDENCE)) {
    test(`wiring evidence: ${name}`, async () => {
        for (const entry of EVIDENCE[name]) {
            const label = `${name} in ${entry.test}`;
            assert.ok(fs.existsSync(absolute(entry.test)), `${label}: no such test file`);

            // 1. The file declares tests for the name.
            const tests = declaredTests(entry.test);
            const matching = tests.filter(({ title }) => (entry.titles
                ? entry.titles.some(prefix => title.startsWith(prefix))
                : wiringTitle(name).test(title)));
            assert.ok(matching.length > 0, `${label}: no test is titled ${entry.titles ? entry.titles.join(' | ') : `wiring:${name}`}`);
            if (entry.titles) {
                for (const prefix of entry.titles) {
                    assert.ok(tests.some(({ title }) => title.startsWith(prefix)), `${label}: no test starts "${prefix}"`);
                }
            }
            const runnable = matching.filter(({ gated }) => !gated).length;
            if (entry.activation) {
                // Activation evidence is gated on a real SDK, all of it.
                assert.equal(runnable, 0, `${label}: an activation row has tests that run without a successor SDK`);
            } else {
                assert.ok(runnable > 0, `${label}: every test for it is skipped`);
            }

            // 2. The file imports a named production symbol, and that symbol exists.
            if (entry.symbol === null) {
                assert.equal(entry.activation, true, `${label}: only an activation row may name no symbol`);
                continue;
            }
            const target = absolute(entry.module);
            assert.ok(fs.existsSync(target), `${label}: no such module ${entry.module}`);
            const imported = importedNames(entry.test).get(target);
            assert.ok(imported, `${label}: the file does not import ${entry.module}`);
            assert.ok(imported.has(entry.symbol), `${label}: the file does not use ${entry.symbol} of ${entry.module}`);
            const exported = await import(pathToFileURL(target).href);
            assert.ok(entry.symbol in exported, `${entry.module} does not export ${entry.symbol}`);
            assert.notEqual(exported[entry.symbol], undefined, `${entry.module} exports ${entry.symbol} as undefined`);
            if (entry.member) {
                const value = exported[entry.symbol];
                const carried = value?.[entry.member] ?? value?.prototype?.[entry.member];
                assert.equal(typeof carried, 'function', `${entry.module} ${entry.symbol} has no ${entry.member}`);
            }
        }
    });
}

test('each behavior with a half in the SDK is bound to the real-SDK test of that half', () => {
    assert.deepEqual(Object.keys(SDK_HALF_TESTS).sort(), [...SDK_HALF_WIRING].sort());
    for (const [name, half] of Object.entries(SDK_HALF_TESTS)) {
        assert.ok(WIRED.has(name), name);
        const test = declaredTests(half.test).find(({ title }) => title === half.title);
        assert.ok(test, `${name}: no test is titled "${half.title}" in ${half.test}`);
        // It cannot run without a successor SDK, so it is activation evidence:
        // against a revision without the SDK half it fails, and that failure
        // is the gate (the registry CLI refuses the row without the patch).
        assert.equal(test.gated, true, name);
        assert.ok(wiringTitle(name).test(half.title), name);
    }
});

// ---------------------------------------------------------------------------
// The known gap
// ---------------------------------------------------------------------------

// The dialog's withdrawal that is started from its own form carries the bound
// that was disclosed (details.concededMax). Its call sites that continue an
// earlier one (retry an unknown or a dropped withdrawal, replace a background
// one, withdraw a set-aside balance) are not started from that form and carry
// none: the signer then refuses a conceding escape it did not itself accept,
// which fails closed (the person starts the withdrawal again from the form).
//
// Giving those call sites a bound is a product decision: it needs the bound
// that applies to a balance the form is not showing. Until it is made this
// test pins the exact set of call sites that carry none. Closing the gap (or
// adding a call site that continues a withdrawal without a bound) means
// changing this list and the documentation that states the gap in the same
// change.
const CONTINUING_WITHOUT_BOUND = [
    'Replacing background withdrawal',
    'Replacing pending withdrawal',
    'Retrying withdrawal',
    'Withdrawing set-aside balance'
];

test('wiring:ownership-proof-wait the dialog\'s continuing withdrawal call sites without a bound are exactly the documented set (closing the gap is a product decision)', () => {
    const ast = parseFile('chat/zkapi/components/AccountModal.js');
    const sites = [];
    let formSetsBound = false;
    walk(ast, node => {
        // The dialog's own form puts the disclosed bound on the details it
        // runs: `details.concededMax = ...`.
        if (node.type === 'AssignmentExpression' && node.left.type === 'MemberExpression' && !node.left.computed
            && node.left.object.type === 'Identifier' && node.left.object.name === 'details'
            && node.left.property.name === 'concededMax') {
            formSetsBound = true;
        }
        if (node.type !== 'CallExpression' || node.callee.type !== 'MemberExpression') return;
        const { object, property } = node.callee;
        if (object.type !== 'ThisExpression' || property.name !== 'run') return;
        const details = node.arguments[1];
        if (details?.type !== 'ObjectExpression') return;
        const field = name => details.properties.find(entry => entry.type === 'Property' && propertyName(entry) === name);
        const kind = field('kind');
        if (!kind || kind.value.type !== 'Literal' || !['withdraw', 'escape'].includes(kind.value.value)) return;
        const title = field('title');
        sites.push({
            title: title?.value.type === 'Literal' ? String(title.value.value) : `line ${node.loc?.start.line ?? '?'}`,
            bound: Boolean(field('concededMax'))
        });
    });
    // A scan that found nothing would pass for the wrong reason.
    assert.ok(sites.length > 0, 'no call site that starts or continues a withdrawal was found: update this test');
    assert.equal(formSetsBound, true, 'the dialog\'s own form no longer names the bound it disclosed');
    const without = sites.filter(site => !site.bound).map(site => site.title).sort();
    assert.deepEqual(without, CONTINUING_WITHOUT_BOUND,
        'The set of call sites that continue a withdrawal without naming a bound changed. '
        + 'Update this list and the documentation that states the gap together (docs/ZKAPI_VERSIONING.md).');
});
