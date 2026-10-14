import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'acorn';

// AccountModal.js and WelcomePanel.js are evaluated by tests inside a vm with
// their import lines removed, so neither may import a shared module. Five small
// helpers that read the version facade are therefore written out in both files:
//
//   versionFacade       the facade the boot attached, or null
//   depositGate         whether a deposit may start (fails closed)
//   depositsClosedLine  the sentence said when it may not
//   versionStamp        the network and version a saved view was written under
//   stampMatches        whether a saved view belongs to this page
//
// The two copies must say and do the same thing: a gate that one dialog reads
// as closed and the other as open, or a stamp one writes and the other
// rejects, would send a person to the wrong view. This test compares the two
// copies as syntax trees (comments and layout are free to differ) and fails
// on any difference.

const repoRoot = process.cwd();
const FILES = [
    'chat/zkapi/components/AccountModal.js',
    'chat/zkapi/components/WelcomePanel.js'
];
const SHARED = ['versionFacade', 'depositGate', 'depositsClosedLine', 'versionStamp', 'stampMatches'];

const IGNORED_KEYS = new Set(['start', 'end', 'loc', 'range', 'raw']);

// A function's syntax tree as text, without positions or the source's own
// spelling of a literal, so only what the code means is compared.
function normalized(node) {
    return JSON.stringify(node, (key, value) => (IGNORED_KEYS.has(key) ? undefined : value));
}

// Top-level function declarations of a module, by name.
function topLevelFunctions(source) {
    const program = parse(source, { ecmaVersion: 'latest', sourceType: 'module', allowHashBang: true });
    const found = new Map();
    for (const node of program.body) {
        const declaration = node.type === 'ExportNamedDeclaration' || node.type === 'ExportDefaultDeclaration'
            ? node.declaration : node;
        if (declaration?.type === 'FunctionDeclaration' && declaration.id) {
            if (!found.has(declaration.id.name)) found.set(declaration.id.name, []);
            found.get(declaration.id.name).push(declaration);
        }
    }
    return found;
}

// The names in `names` whose two definitions differ, or that one source does
// not define exactly once.
function differences(left, right, names) {
    const a = topLevelFunctions(left);
    const b = topLevelFunctions(right);
    const problems = [];
    for (const name of names) {
        const first = a.get(name) || [];
        const second = b.get(name) || [];
        if (first.length !== 1 || second.length !== 1) {
            problems.push(`${name}: defined ${first.length} time(s) in one source and ${second.length} in the other`);
        } else if (normalized(first[0]) !== normalized(second[0])) {
            problems.push(`${name}: the two definitions differ`);
        }
    }
    return problems;
}

test('the facade helpers written out in the account dialog and the welcome panel are identical', () => {
    const [account, welcome] = FILES.map(file => fs.readFileSync(path.join(repoRoot, file), 'utf8'));
    assert.deepEqual(differences(account, welcome, SHARED), [],
        'A helper was changed in one dialog and not the other. These sources cannot import, so each carries its own copy: change both.');
});

test('each shared helper is a plain function declaration in both sources', () => {
    for (const file of FILES) {
        const functions = topLevelFunctions(fs.readFileSync(path.join(repoRoot, file), 'utf8'));
        for (const name of SHARED) {
            const declared = functions.get(name) || [];
            assert.equal(declared.length, 1, `${file} declares ${name} once`);
            assert.equal(declared[0].async, false, `${file}: ${name} is synchronous`);
        }
    }
});

// The comparison itself, on small sources: it must see a changed sentence, a
// changed condition and a missing copy, and must not mind a comment or layout.
test('the comparison notices a changed body and a missing copy, and ignores comments and layout', () => {
    const base = [
        'function gate() {',
        '    try { return facade.depositGate(); } catch { return { canStart: false }; }',
        '}'
    ].join('\n');
    const names = ['gate'];
    assert.deepEqual(differences(base, base, names), []);
    const commented = `// the gate\nfunction gate() {\n    // fail closed\n    try {\n        return facade.depositGate();\n    } catch {\n        return { canStart: false };\n    }\n}\n`;
    assert.deepEqual(differences(base, commented, names), [], 'comments and layout are free');
    const looser = base.replace('canStart: false', 'canStart: true');
    assert.deepEqual(differences(base, looser, names), ['gate: the two definitions differ']);
    const reworded = 'function gate() { return "This version no longer accepts new deposits."; }';
    const reworded2 = 'function gate() { return "This version accepts no new deposits."; }';
    assert.deepEqual(differences(reworded, reworded2, names), ['gate: the two definitions differ']);
    assert.deepEqual(differences(base, 'const unrelated = 1;', names),
        ['gate: defined 1 time(s) in one source and 0 in the other']);
});
