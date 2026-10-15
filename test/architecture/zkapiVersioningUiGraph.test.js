import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// A direct devDependency (also what terser parses with). Same parser the
// vm-source pin test uses.
import { parse } from 'acorn';

// The version UI helpers (chat/zkapi/versioning/ui.js) and the payment boot
// (chat/zkapi/boot.js) are the two modules that compose the rest, and both
// load their pieces so that a missing one is only a warning: boot imports
// ui.js fail-soft (a page without the notices is complete, it just has none),
// and the default readers it hands the facade are never executed by the unit
// tests, which inject their own. So a module that is renamed, deleted or no
// longer exports a name an importer reads would not fail anything, it would
// only quietly remove a feature at runtime.
//
// This test reads the import graph the way the module linker does: every
// relative import of a module in the static closure of either entry names a
// file that exists, and every named import names something that file exports.
// It also pins what the two modules are allowed to reach statically (no SDK
// module, no Node built-in: both run before any SDK build is bound) and what
// boot reads from each module it imports on demand.

const repoRoot = process.cwd();
const ENTRIES = ['chat/zkapi/versioning/ui.js', 'chat/zkapi/boot.js'];

// What boot reads from the modules it imports on demand, by specifier. A
// rename on either side fails here and not on a person's page.
const BOOT_ON_DEMAND = {
    './index.js': ['createZkapiPaymentIntegration'],
    './versioning/ui.js': ['versionUi'],
    './services/canceledDeposit.mjs': ['discardUnsentDeposit'],
    './services/abandonedNote.mjs': ['giveUpBalance'],
    './versioning/otherVersionHistory.mjs': ['readOtherVersionHistory']
};
// The modules ui.js composes. Each must stay in its static closure: a member
// that silently lost its component would render nothing.
const UI_COMPONENTS = [
    'chat/zkapi/components/VersionNotices.js',
    'chat/zkapi/components/UpgradeView.js',
    'chat/zkapi/components/BalanceExtras.js',
    'chat/zkapi/components/ExitChoice.js',
    'chat/zkapi/components/RecordExtras.js',
    'chat/zkapi/components/OtherVersionHistory.js'
];

const relative = file => path.relative(repoRoot, file).split(path.sep).join('/');

const parsed = new Map();

function walkAst(node, visit) {
    if (!node || typeof node.type !== 'string') return;
    visit(node);
    for (const key of Object.keys(node)) {
        const value = node[key];
        if (Array.isArray(value)) {
            for (const child of value) walkAst(child, visit);
        } else if (value && typeof value === 'object') {
            walkAst(value, visit);
        }
    }
}

function declaredNames(pattern, into) {
    if (!pattern) return;
    switch (pattern.type) {
        case 'Identifier': into.push(pattern.name); break;
        case 'ObjectPattern':
            for (const property of pattern.properties) declaredNames(property.value || property.argument, into);
            break;
        case 'ArrayPattern': for (const element of pattern.elements) declaredNames(element, into); break;
        case 'RestElement': declaredNames(pattern.argument, into); break;
        case 'AssignmentPattern': declaredNames(pattern.left, into); break;
        default: break;
    }
}

const nameOf = node => (node.type === 'Identifier' ? node.name : String(node.value));

// What a module imports (static), imports on demand (literal dynamic), and
// exports. Source order does not matter.
function analyse(file) {
    if (parsed.has(file)) return parsed.get(file);
    const text = fs.readFileSync(file, 'utf8');
    const ast = parse(text, { ecmaVersion: 'latest', sourceType: 'module' });
    const info = { statics: [], dynamics: [], exported: new Set(), stars: [] };
    for (const node of ast.body) {
        if (node.type === 'ImportDeclaration') {
            const names = [];
            let namespace = false;
            for (const specifier of node.specifiers) {
                if (specifier.type === 'ImportNamespaceSpecifier') namespace = true;
                else if (specifier.type === 'ImportDefaultSpecifier') names.push('default');
                else names.push(nameOf(specifier.imported));
            }
            info.statics.push({ source: node.source.value, names, namespace });
        } else if (node.type === 'ExportNamedDeclaration') {
            if (node.declaration) {
                const declaration = node.declaration;
                if (declaration.type === 'VariableDeclaration') {
                    const names = [];
                    for (const entry of declaration.declarations) declaredNames(entry.id, names);
                    names.forEach(name => info.exported.add(name));
                } else if (declaration.id) {
                    info.exported.add(declaration.id.name);
                }
            }
            if (node.source) {
                const names = node.specifiers.map(specifier => nameOf(specifier.local));
                info.statics.push({ source: node.source.value, names, namespace: false });
            }
            for (const specifier of node.specifiers) info.exported.add(nameOf(specifier.exported));
        } else if (node.type === 'ExportDefaultDeclaration') {
            info.exported.add('default');
        } else if (node.type === 'ExportAllDeclaration') {
            if (node.exported) info.exported.add(nameOf(node.exported));
            else info.stars.push(node.source.value);
            info.statics.push({ source: node.source.value, names: [], namespace: true });
        }
    }
    walkAst(ast, node => {
        if (node.type === 'ImportExpression' && node.source.type === 'Literal') {
            info.dynamics.push(String(node.source.value));
        }
    });
    parsed.set(file, info);
    return info;
}

function exportsOf(file, seen = new Set()) {
    if (seen.has(file)) return new Set();
    seen.add(file);
    const info = analyse(file);
    const names = new Set(info.exported);
    for (const source of info.stars) {
        const target = path.resolve(path.dirname(file), source);
        for (const name of exportsOf(target, seen)) {
            if (name !== 'default') names.add(name);
        }
    }
    return names;
}

// Every module reachable from `entry` through static relative imports, the
// bare specifiers met on the way, and every problem found. Explicit
// extensions only: the browser resolves nothing for us.
function closureOf(entry) {
    const start = path.resolve(repoRoot, entry);
    const files = new Set();
    const bare = new Set();
    const problems = [];
    const visit = file => {
        if (files.has(file)) return;
        files.add(file);
        const info = analyse(file);
        for (const dependency of info.statics) {
            if (!dependency.source.startsWith('.')) {
                bare.add(dependency.source);
                continue;
            }
            const target = path.resolve(path.dirname(file), dependency.source);
            if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
                problems.push(`${relative(file)} imports ${dependency.source}, which is not a file`);
                continue;
            }
            const offered = exportsOf(target);
            for (const name of dependency.names) {
                if (!offered.has(name)) {
                    problems.push(`${relative(file)} imports { ${name} } from ${dependency.source}, which does not export it`);
                }
            }
            visit(target);
        }
        for (const source of info.dynamics) {
            if (!source.startsWith('.')) continue;
            const target = path.resolve(path.dirname(file), source);
            if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
                problems.push(`${relative(file)} imports ${source} on demand, which is not a file`);
            }
        }
    };
    visit(start);
    return { files: [...files].map(relative).sort(), bare: [...bare].sort(), problems };
}

for (const entry of ENTRIES) {
    test(`${entry}: every static import resolves to a file that exports the names it reads`, () => {
        const { files, problems } = closureOf(entry);
        assert.ok(files.length > 5, 'the closure was read');
        assert.deepEqual(problems, []);
    });

    test(`${entry}: reaches no SDK module and no Node built-in statically`, () => {
        // Both run before any SDK build is chosen (the SDK modules of a
        // multi-version build are facades only bound by then), and both are
        // bundled for the browser.
        const { bare } = closureOf(entry);
        assert.deepEqual(bare, []);
    });
}

test('ui.js composes every component it renders', () => {
    const { files } = closureOf('chat/zkapi/versioning/ui.js');
    for (const component of UI_COMPONENTS) assert.ok(files.includes(component), `${component} is imported`);
});

test('boot.js on-demand imports name modules that exist and export what boot reads', () => {
    const boot = path.resolve(repoRoot, 'chat/zkapi/boot.js');
    const info = analyse(boot);
    const relativeSources = info.dynamics.filter(source => source.startsWith('.')).sort();
    assert.deepEqual(relativeSources, Object.keys(BOOT_ON_DEMAND).sort());
    for (const [source, names] of Object.entries(BOOT_ON_DEMAND)) {
        const target = path.resolve(path.dirname(boot), source);
        assert.ok(fs.existsSync(target), `${source} exists`);
        const offered = exportsOf(target);
        for (const name of names) assert.ok(offered.has(name), `${source} exports ${name}`);
    }
    // The SDK is only ever reached dynamically, and only these three.
    const sdk = info.dynamics.filter(source => !source.startsWith('.')).sort();
    assert.deepEqual(sdk, [
        '@openanonymity/zkapi-browser-sdk/client',
        '@openanonymity/zkapi-browser-sdk/runtime',
        '@openanonymity/zkapi-browser-sdk/store'
    ]);
});

test('the modules boot imports on demand resolve their own imports too', () => {
    // Their static closures may reach the SDK (the payment adapter and the
    // give-up do), so only existence and exported names are checked. This
    // is what a person's click would otherwise be the first to find out.
    const boot = path.resolve(repoRoot, 'chat/zkapi/boot.js');
    const problems = [];
    for (const source of Object.keys(BOOT_ON_DEMAND)) {
        const entry = path.resolve(path.dirname(boot), source);
        const seen = new Set();
        const visit = file => {
            if (seen.has(file)) return;
            seen.add(file);
            for (const dependency of analyse(file).statics) {
                if (!dependency.source.startsWith('.')) continue;
                const target = path.resolve(path.dirname(file), dependency.source);
                if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
                    problems.push(`${relative(file)} imports ${dependency.source}, which is not a file`);
                    continue;
                }
                const offered = exportsOf(target);
                for (const name of dependency.names) {
                    if (!offered.has(name)) {
                        problems.push(`${relative(file)} imports { ${name} } from ${dependency.source}, which does not export it`);
                    }
                }
                visit(target);
            }
        };
        visit(entry);
    }
    assert.deepEqual(problems, []);
});

test('the graph reader catches a missing file and a missing export (self check)', () => {
    // The checks above are only worth anything if the reader sees these.
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'oa-graph-check-'));
    try {
        fs.writeFileSync(path.join(directory, 'a.js'), 'export const present = 1;\n');
        fs.writeFileSync(path.join(directory, 'entry.js'), [
            "import { present, absent } from './a.js';",
            "import './missing.js';",
            "export * from './a.js';",
            "const later = () => import('./nowhere.js');",
            'export { later };',
            ''
        ].join('\n'));
        const { problems } = closureOf(path.join(directory, 'entry.js'));
        assert.deepEqual(problems.map(entry => entry.replace(/^.*?entry\.js/, 'entry.js')), [
            "entry.js imports { absent } from ./a.js, which does not export it",
            'entry.js imports ./missing.js, which is not a file',
            'entry.js imports ./nowhere.js on demand, which is not a file'
        ]);
        assert.ok(exportsOf(path.join(directory, 'entry.js')).has('present'), 'export * is followed');
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});
