import test from 'node:test';
import assert from 'node:assert/strict';
import katex from '../../chat/vendor/katex/katex.min.js';
import markedApi from '../../chat/vendor/marked/marked.min.js';

import {
    createMathPlaceholderNamespace,
    replaceDisplayDollarMath,
    normalizeMathTextAmpersands,
    renderMathContent,
    normalizeInlineDollarMath,
    protectDollarMathForMarkdown,
    restoreLiteralDollarPlaceholders,
    renderMarkdownWithMath
} from '../../chat/services/mathRendering.js';

test('display math leaves restaurant price ratings and escaped dollars literal', () => {
    for (const source of [
        '**$$** and **$$$** and **$$$$**',
        '*$$* and _$$_ and __$$__',
        '| A | $$ |\n| B | $$$ |\n| C | $$$$ |',
        String.raw`Keep \$\$x\$\$ literal.`
    ]) {
        assert.equal(replaceDisplayDollarMath(source, () => 'MATH'), source);
    }
    assert.equal(replaceDisplayDollarMath('$$x^2$$ and $$\ny=2\n$$', (_match, value) => `[${value}]`),
        '[x^2] and [\ny=2\n]');
    assert.equal(replaceDisplayDollarMath('$$|x|$$', (_match, value) => `[${value}]`), '[|x|]');
    assert.equal(replaceDisplayDollarMath('Therefore $$\n|x|\n$$', (_match, value) => `[${value}]`), 'Therefore [\n|x|\n]');
    for (const body of ['\n|x|\n', '\n\\begin{aligned}\nx&=1\\\\\n\ny&=2\n\\end{aligned}\n']) {
        assert.doesNotThrow(() => katex.renderToString(body, { throwOnError: true }));
        assert.equal(replaceDisplayDollarMath(`$$${body}$$`, (_match, value) => `[${value}]`), `[${body}]`);
    }
});

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

// Reported 2026-10-26 (Haiku answer about the Treasury swap line): an opening
// "$20" paired with a later dollar and KaTeX swallowed the prose between them.
const CURRENCY_PROSE_CORPUS = [
    'The ESF agreed to buy up to $20 billion in Argentine pesos from the central bank$\n\n$20 billion worth of pesos.',
    'Buy up to $20 billion in pesos from the central bank$ then stop.',
    'Up to $20 billion in Argentine pesos from the central bank$$20 billion worth',
    'It raised $3 million from investors and spent it on servers$, then $4 more.',
    'Costs were $1.5 billion last year and the budget$ was cut.',
    '**$20 billion** in pesos from the central bank and **$20 billion** in dollars',
    'Between $5 and $10 per seat.',
    'Fees: $2/month for the basic tier, $5/month for pro$.'
];

test('currency dollars never open math around prose', () => {
    for (const source of CURRENCY_PROSE_CORPUS) {
        assert.equal(normalizeInlineDollarMath(source), source, source);
        assert.equal(replaceDisplayDollarMath(source, () => 'MATH'), source, source);
        const protectedContent = protectDollarMathForMarkdown(source, {
            math: () => 'MATHPLACEHOLDER',
            literalDollar: () => 'LITERALPLACEHOLDER'
        });
        assert.equal(protectedContent, source, source);
    }
});

test('real math still renders beside currency', () => {
    const examples = [
        ['Spend $20 billion; then $x^2 + y^2 = r^2$ holds.', 'Spend $20 billion; then \\(x^2 + y^2 = r^2\\) holds.'],
        ['$\\text{Revenue} = p \\cdot q$ costs $5.', '\\(\\text{Revenue} = p \\cdot q\\) costs $5.'],
        ['$\\text{total cost in dollars} = 20b$', '\\(\\text{total cost in dollars} = 20b\\)'],
        ['$O(n \\log n)$ and $\\lim_{n \\to \\infty} a_n$', '\\(O(n \\log n)\\) and \\(\\lim_{n \\to \\infty} a_n\\)'],
        ['$2x + 3$ and $3 \\times 4$', '\\(2x + 3\\) and \\(3 \\times 4\\)'],
        ['$A(\\rho)/T$ curve and $\\bar{\\omega}$', '\\(A(\\rho)/T\\) curve and \\(\\bar{\\omega}\\)']
    ];
    for (const [source, expected] of examples) {
        assert.equal(normalizeInlineDollarMath(source), expected, source);
    }
    assert.equal(
        replaceDisplayDollarMath('$$\\begin{aligned} x &= 1 \\end{aligned}$$', (_m, c) => `[${c}]`),
        '[\\begin{aligned} x &= 1 \\end{aligned}]'
    );
    // A skipped price pair takes both of its delimiters out of play.
    assert.equal(replaceDisplayDollarMath('$$20 billion in pesos$$, then $$5 million more$$', () => 'MATH'),
        '$$20 billion in pesos$$, then $$5 million more$$');
    assert.equal(replaceDisplayDollarMath('$$20 billion in pesos$$ and $$x^2$$', () => 'MATH'), '$$20 billion in pesos$$ and MATH');
    assert.equal(
        replaceDisplayDollarMath('$$\\text{Deposit on-chain} \\longrightarrow \\text{Server executes and refunds}$$', () => 'MATH'),
        'MATH'
    );
});

test('math delimiters split across stream chunks settle to the final render', () => {
    const final = 'Up to $20 billion in pesos. Then $x^2$ and \\(y\\) and $$z$$.';
    for (let cut = 1; cut <= final.length; cut += 1) {
        const partial = final.slice(0, cut);
        // Partial renders may show literal text but must never swallow the
        // currency sentence into math.
        const normalized = normalizeInlineDollarMath(partial);
        assert.ok(!normalized.includes('\\(20 billion'), partial);
    }
    assert.equal(
        normalizeInlineDollarMath(final),
        'Up to $20 billion in pesos. Then \\(x^2\\) and \\(y\\) and $$z$$.'
    );
});

const renderMessage = content => renderMarkdownWithMath(content, {
    parse: source => markedApi.parse(source),
    escapeHtml: value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
});

// Every structure Markdown can wrap around math. Each source holds `count`
// math expressions; all must come back as their original delimiters.
const PLACEHOLDER_CORPUS = [
    ['**The $A(\\rho)/T$ curve:** how productive the leader is.', 1],
    ['- **The $B(\\rho)$ curve:** balance of trade\n- Where $\\bar{\\rho}$ and $\\bar{\\omega}$ meet', 3],
    ['1. Step $x$\n2. Step \\(y\\)\n3. Block:\n\n   $$z^2$$', 3],
    ['## Heading with $\\rho$', 1],
    ['| a | b |\n|---|---|\n| $x$ | \\(y\\) |', 2],
    ['> Quoted $x+1$ and \\[y\\]', 2],
    ['[link $x$](https://example.com) and _em $y$_ and ~~$z$~~', 3],
    ['Use `code` then $x$ then `more` then \\(y\\).', 2],
    ['**$$x^2$$** and *\\[y\\]*', 2],
    ['$x$$y$ and \\(a\\)\\(b\\)', 3]
];

test('math placeholders are always restored, whatever Markdown wraps them in', () => {
    for (const [source, count] of PLACEHOLDER_CORPUS) {
        const html = renderMessage(source);
        assert.doesNotMatch(html, /OAMATH|PLACEHOLDER|BLOCK\d+END|INLINE\d+END/, source);
        const restored = (html.match(/\\\(|\\\[|\$\$|(?<![\\$])\$(?!\$)/g) || []).length;
        assert.ok(restored >= count, `${source}\n${html}`);
    }
});

test('no placeholder leaks at any streaming cut of a math-heavy answer', () => {
    const answer = PLACEHOLDER_CORPUS.map(([source]) => source).join('\n\n')
        + '\n\nThe Fund bought up to $20 billion in pesos from the central bank$\n\n$20 billion worth.';
    for (let cut = 1; cut <= answer.length; cut += 1) {
        const html = renderMessage(answer.slice(0, cut));
        assert.doesNotMatch(html, /OAMATH|PLACEHOLDER/, `cut ${cut}`);
    }
});
