import test from 'node:test';
import assert from 'node:assert/strict';
import katex from '../../chat/vendor/katex/katex.min.js';
import markedApi from '../../chat/vendor/marked/marked.min.js';

import {
    createMathPlaceholderNamespace,
    normalizeMathTextAmpersands,
    renderMathContent,
    normalizeInlineDollarMath,
    protectDollarMathForMarkdown,
    restoreLiteralDollarPlaceholders
} from '../../chat/services/mathRendering.js';

test('creates a per-render placeholder namespace absent from message content', () => {
    const candidates = ['collision', 'safe'];
    const namespace = createMathPlaceholderNamespace(
        'Literal OAMATHcollisionPLACEHOLDER must survive.',
        { randomId: () => candidates.shift() }
    );

    assert.equal(namespace, 'OAMATHsafePLACEHOLDER');
});

test('restores literal-dollar tokens without replacement-string semantics', () => {
    assert.equal(
        restoreLiteralDollarPlaceholders(
            '<p>TOKEN and $& stay literal.</p>',
            ['TOKEN'],
            null
        ),
        '<p><span class="math-literal-dollar">$</span> and $& stay literal.</p>'
    );
});

test('normalizes Gemini-style single-dollar inline math', () => {
    assert.equal(
        normalizeInlineDollarMath('Use $x^2$ and $\\frac{a}{b}$ inline.'),
        'Use \\(x^2\\) and \\(\\frac{a}{b}\\) inline.'
    );
});

test('preserves supported block delimiters and escaped dollars', () => {
    const content = String.raw`Keep $$x^2$$, \[y^2\], \(z^2\), and \$5 unchanged.`;
    assert.equal(normalizeInlineDollarMath(content), content);
});

test('does not treat ordinary prices or price ranges as inline math', () => {
    const examples = [
        'It costs $5 or $10.',
        'Plans range from $5-$10.',
        'Plans range from $5–$10.',
        'The totals were $1,200 and $3,400.'
    ];

    examples.forEach(content => {
        assert.equal(normalizeInlineDollarMath(content), content);
    });
});

test('recovers from a currency dollar before a valid math expression', () => {
    assert.equal(
        normalizeInlineDollarMath('It costs $5; solve $x+1$ next.'),
        'It costs $5; solve \\(x+1\\) next.'
    );
});

test('does not let punctuation-adjacent prices steal a math opener', () => {
    const examples = [
        ['Use $5+$x$ next.', 'Use $5+\\(x\\) next.'],
        ['Use cost=$5,$x$ next.', 'Use cost=$5,\\(x\\) next.'],
        ['Use $5;($x$) next.', 'Use $5;(\\(x\\)) next.']
    ];

    examples.forEach(([content, expected]) => {
        assert.equal(normalizeInlineDollarMath(content), expected);
    });
});

test('leaves malformed or whitespace-padded dollar pairs alone', () => {
    const examples = [
        'Unclosed $x remains text.',
        'Padded $ x $ remains text.',
        'Digit suffix $x$2 remains text.'
    ];

    examples.forEach(content => {
        assert.equal(normalizeInlineDollarMath(content), content);
    });
});

test('protects single-dollar math before Markdown can split it', () => {
    const protectedContent = protectDollarMathForMarkdown('$x **y** + z$ and $a*b*+c$', {
        math: (_match, _content, index) => `MATH${index}PLACEHOLDER`,
        literalDollar: index => `LITERAL${index}PLACEHOLDER`
    });
    const html = markedApi.parse(protectedContent);

    assert.equal(protectedContent, 'MATH0PLACEHOLDER and MATH1PLACEHOLDER');
    assert.equal(html, '<p>MATH0PLACEHOLDER and MATH1PLACEHOLDER</p>\n');
    assert.equal(html.includes('<strong>'), false);
    assert.equal(html.includes('<em>'), false);
});

test('carries escaped dollars through Markdown as literal placeholders', () => {
    const protectedContent = protectDollarMathForMarkdown(String.raw`Keep \$x\$ literal.`, {
        math: (_match, _content, index) => `MATH${index}PLACEHOLDER`,
        literalDollar: index => `LITERAL${index}PLACEHOLDER`
    });
    const html = markedApi.parse(protectedContent);

    assert.equal(protectedContent, 'Keep LITERAL0PLACEHOLDERxLITERAL1PLACEHOLDER literal.');
    assert.equal(html, '<p>Keep LITERAL0PLACEHOLDERxLITERAL1PLACEHOLDER literal.</p>\n');
});

test('leaves inline and fenced code untouched during Markdown protection', () => {
    const content = [
        "Inline `$x$ and \\$5`.",
        '',
        '```text',
        '$y$ and \\$10',
        '```',
        '',
        '~~~text',
        '$z$ and \\$20',
        '~~~'
    ].join('\n');
    const protectedContent = protectDollarMathForMarkdown(content, {
        math: (_match, _content, index) => `MATH${index}PLACEHOLDER`,
        literalDollar: index => `LITERAL${index}PLACEHOLDER`
    });

    assert.equal(protectedContent, content);
});


test('renders the reported Gemini flow without breaking matrix alignment', () => {
    const source = String.raw`\text{Deposit on-chain} \longrightarrow \begin{matrix} \text{ZK Proof of Solvency} \\ + \text{ RLN Nullifier} \end{matrix} \xrightarrow{\text{Off-chain API Call}} \text{Server executes & refunds diff} \longrightarrow \text{Accumulate & Repeat}`;
    assert.throws(() => katex.renderToString(source, { throwOnError: true }));
    const repaired = normalizeMathTextAmpersands(source);
    assert.doesNotThrow(() => katex.renderToString(repaired, { throwOnError: true }));
    const matrix = String.raw`\begin{matrix} a & b \\ \text{A & B} & c \end{matrix}`;
    const normalized = normalizeMathTextAmpersands(matrix);
    assert.equal(normalized, String.raw`\begin{matrix} a & b \\ \text{A \& B} & c \end{matrix}`);
    assert.doesNotThrow(() => katex.renderToString(normalized, { throwOnError: true }));
});

test('math repair preserves escaped ampersands, other math and incomplete text groups', () => {
    for (const source of [String.raw`\text{A \& B}`, String.raw`a & b`, String.raw`\text{unfinished &`, String.raw`\\text{A & B}`]) {
        assert.equal(normalizeMathTextAmpersands(source), source);
    }
    assert.equal(normalizeMathTextAmpersands(String.raw`\text{A {B & C} \{ D & E}`), String.raw`\text{A {B \& C} \{ D \& E}`);
});

test('shared math renderer applies repair without enabling trusted HTML', () => {
    const previous = globalThis.renderMathInElement;
    let options;
    globalThis.renderMathInElement = (_, value) => { options = value; };
    try { renderMathContent({}); } finally { globalThis.renderMathInElement = previous; }
    assert.equal(options.preProcess(String.raw`\text{A & B}`), String.raw`\text{A \& B}`);
    assert.notEqual(options.trust, true);
});


test('math repair leaves embedded matrices, verbatim and URL commands intact', () => {
    const sources = [
        String.raw`\text{matrix $\begin{matrix} a & b \end{matrix}$}`,
        String.raw`\text{matrix \(\begin{matrix} a & b \end{matrix}\)}`,
        String.raw`\text{\verb|a & b|}`,
        String.raw`\verb|\text{A & B}|`,
        String.raw`\verb*+\text{A & B}+`,
        String.raw`\text{\href{https://example.com/?a=1&b=2}{link}}`
    ];
    for (const source of sources) {
        const normalized = normalizeMathTextAmpersands(source);
        assert.equal(normalized, source);
        assert.equal(katex.renderToString(normalized, { throwOnError: true }),
            katex.renderToString(source, { throwOnError: true }));
    }
    const mixed = sources[0] + String.raw` + \text{A & B}`;
    const normalized = normalizeMathTextAmpersands(mixed);
    assert.equal(normalized, sources[0] + String.raw` + \text{A \& B}`);
    const rendered = katex.renderToString(normalized, { throwOnError: true });
    assert.equal((rendered.match(/<mtd>/g) || []).length, 2);
});
