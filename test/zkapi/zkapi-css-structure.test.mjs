// The zkAPI stylesheet's block structure, read with a standards CSS parser.
//
// A missing `}` once left `@media (prefers-reduced-motion: reduce)` open to
// the end of zkapi.css, so every later rule (version pill, banners, sheets,
// balance extras) applied only to reduced-motion users and the pill rendered
// "ZkAPI V0.2" through .zkapi-pill's capitalize everywhere else. A browser
// recovers from that silently, so the structure is checked here: the file
// must parse strictly, the version rules must sit at the top level, and the
// version pill's text-transform must resolve to `none` with and without
// reduced motion.
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { createRequire } from 'node:module';

// postcss is installed with the pinned tailwindcss devDependency.
const postcss = createRequire(import.meta.url)('postcss');
const CSS_FILE = new URL('../../chat/zkapi/zkapi.css', import.meta.url);

function parse() {
    return postcss.parse(fs.readFileSync(CSS_FILE, 'utf8'), { from: 'chat/zkapi/zkapi.css' });
}

// The at-rules a rule is nested in, outermost first: `media (max-width: 640px)`.
function ancestors(rule) {
    const chain = [];
    for (let node = rule.parent; node && node.type !== 'root'; node = node.parent) {
        chain.unshift(node.type === 'atrule' ? `${node.name} ${node.params}` : node.type);
    }
    return chain;
}

function selectorsOf(rule) {
    return rule.selector.split(',').map(selector => selector.trim());
}

test('zkapi.css parses strictly: no unclosed block and no stray brace', () => {
    // postcss throws CssSyntaxError ("Unclosed block", "Unexpected }") on both.
    assert.doesNotThrow(parse);
});

test('every reduced-motion block closes where it starts', () => {
    const root = parse();
    const blocks = [];
    root.walkAtRules('media', rule => {
        if (/prefers-reduced-motion:\s*reduce/.test(rule.params)) blocks.push(rule);
    });
    assert.ok(blocks.length > 0, 'the stylesheet has reduced-motion overrides');
    for (const block of blocks) {
        // An override block is short; the unclosed one swallowed ~200 lines.
        const lines = block.source.end.line - block.source.start.line;
        assert.ok(lines < 80, `@media ${block.params} at line ${block.source.start.line} spans ${lines} lines`);
        block.walkRules(rule => {
            assert.doesNotMatch(rule.selector, /zkapi-version|zkapi-pill\b/,
                `reduced-motion block at line ${block.source.start.line} holds ${rule.selector}`);
        });
    }
});

test('the protocol-version rules sit at the top level', () => {
    const root = parse();
    const seen = new Set();
    root.walkRules(rule => {
        for (const selector of selectorsOf(rule)) {
            if (!/^\.zkapi-version-(pill|badge-group|banner|notice)\b/.test(selector)) continue;
            seen.add(selector.split(/[\s:.[]/).filter(Boolean)[0]);
            assert.deepEqual(ancestors(rule), [], `${selector} (line ${rule.source.start.line}) is nested`);
        }
    });
    for (const name of ['zkapi-version-pill', 'zkapi-version-badge-group', 'zkapi-version-banner']) {
        assert.ok(seen.has(name), `${name} has a rule`);
    }
});

// The cascade for an element with class="zkapi-version-pill zkapi-pill": both
// single-class selectors have the same specificity, so the later declaration
// wins. A rule inside an at-rule applies only when that condition matches.
function pillTextTransform({ reducedMotion }) {
    const root = parse();
    let value = 'none'; // the initial value
    root.walkRules(rule => {
        if (!selectorsOf(rule).some(selector => selector === '.zkapi-pill' || selector === '.zkapi-version-pill')) return;
        const conditions = ancestors(rule);
        const applies = conditions.every(condition => reducedMotion && /prefers-reduced-motion:\s*reduce/.test(condition));
        if (!applies) return;
        rule.walkDecls('text-transform', declaration => { value = declaration.value; });
    });
    return value;
}

test('the version pill prints "zkAPI v0.2" as written, with or without reduced motion', () => {
    assert.equal(pillTextTransform({ reducedMotion: false }), 'none');
    assert.equal(pillTextTransform({ reducedMotion: true }), 'none');
});

test('the other readiness pills keep their capitalized look', () => {
    const root = parse();
    let pill = null;
    root.walkRules(rule => { if (rule.selector === '.zkapi-pill' && ancestors(rule).length === 0) pill = rule; });
    assert.ok(pill, '.zkapi-pill is a top-level rule');
    const transform = [];
    pill.walkDecls('text-transform', declaration => transform.push(declaration.value));
    assert.deepEqual(transform, ['capitalize']);
});
