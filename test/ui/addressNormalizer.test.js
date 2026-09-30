import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// The inline <script data-oa-link-normalizer> in chat/index.html rewrites
// pre-rename `?s=` links and `/tickets/<code>` paths during parsing, before a
// deferred analytics script can report them. Run it against a fake window.
const html = await readFile(new URL('../../chat/index.html', import.meta.url), 'utf8');
const match = html.match(/<script data-oa-link-normalizer>([\s\S]*?)<\/script>/);
assert.ok(match, 'index.html carries the address normalizer');

function run(href, state = { kept: true }) {
    const calls = [];
    const window = { location: { href }, history: { state, replaceState: (...args) => calls.push(args) } };
    new Function('window', 'console', match[1])(window, { warn: () => assert.fail('normalizer must not warn') });
    return calls;
}

test('a legacy ?s= link becomes ?c= with query, fragment and history state kept', () => {
    assert.deepEqual(run('https://chat.example/?s=abc&view=read#billing'),
        [[{ kept: true }, '', 'https://chat.example/?view=read&c=abc#billing']]);
    assert.deepEqual(run('https://chat.example/?s=old&c=new'), [[{ kept: true }, '', 'https://chat.example/?c=new']]);
});

test('a /tickets/<code> path becomes ?tickets=<code> at the root', () => {
    const code = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
    assert.deepEqual(run(`https://chat.example/tickets/${code}`), [[{ kept: true }, '', `https://chat.example/?tickets=${code}`]]);
    assert.deepEqual(run(`https://chat.example/tickets/${code}?s=abc#x`),
        [[{ kept: true }, '', `https://chat.example/?tickets=${code}&c=abc#x`]]);
    // An explicit ?tickets= wins over the path form.
    assert.deepEqual(run(`https://chat.example/tickets/${code}?tickets=OTHER`), [[{ kept: true }, '', 'https://chat.example/?tickets=OTHER']]);
});

test('current-form addresses are left untouched', () => {
    for (const href of ['https://chat.example/', 'https://chat.example/?c=abc', 'https://chat.example/?tickets=abc',
        'https://chat.example/login', 'https://chat.example/?auth=google#oauth=x', 'https://chat.example/?cs=1&subject=s']) {
        assert.deepEqual(run(href), [], href);
    }
});
