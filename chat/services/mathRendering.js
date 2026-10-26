const MATH_DELIMITERS = [
    { left: '\\[', right: '\\]', display: true },
    { left: '\\(', right: '\\)', display: false }
];

const IGNORED_MATH_TAGS = new Set([
    'code',
    'noscript',
    'option',
    'pre',
    'script',
    'style',
    'textarea'
]);

let placeholderFallbackSequence = 0;

export function createMathPlaceholderNamespace(content, options = {}) {
    const value = String(content ?? '');
    const createRandomId = typeof options.randomId === 'function'
        ? options.randomId
        : () => globalThis.crypto?.randomUUID?.()
            || `${Date.now().toString(36)}${(placeholderFallbackSequence += 1).toString(36)}`;
    let namespace = '';

    do {
        const randomId = String(createRandomId()).replace(/[^a-z0-9]/gi, '')
            || `${Date.now().toString(36)}${(placeholderFallbackSequence += 1).toString(36)}`;
        namespace = `OAMATH${randomId}PLACEHOLDER`;
    } while (value.includes(namespace));

    return namespace;
}

function isEscaped(text, index) {
    let slashCount = 0;
    for (let cursor = index - 1; cursor >= 0 && text[cursor] === '\\'; cursor -= 1) {
        slashCount += 1;
    }
    return slashCount % 2 === 1;
}

// Price ratings ($$, $$$, $$$$) must not join unrelated table rows into one
// display equation. Only exact, unescaped double-dollar runs can delimit math.
export function replaceDisplayDollarMath(text, replacer) {
    const value = String(text ?? '');
    const tokens = [];
    for (const match of value.matchAll(/\$+/g)) {
        const index = match.index;
        if (match[0].length !== 2 || isEscaped(value, index)) continue;
        const before = value.slice(0, index);
        const after = value.slice(index + 2);
        if ((before.endsWith('*') && after.startsWith('*'))
            || (before.endsWith('_') && after.startsWith('_'))
            || (/\|[ \t]*$/.test(before) && /^[ \t]*\|/.test(after))) continue;
        tokens.push(index);
    }
    let result = '';
    let cursor = 0;
    for (let i = 0; i + 1 < tokens.length; i++) {
        const start = tokens[i];
        const end = tokens[i + 1];
        const content = value.slice(start + 2, end);
        // A rating inside a table must not consume another row. Inspect the
        // delimiter's line, not the equation body (which may contain |x|).
        const inTableRow = index => {
            const lineStart = value.lastIndexOf('\n', index - 1) + 1;
            const lineEnd = value.indexOf('\n', index + 2);
            return /^\s*\|.*\|\s*$/.test(value.slice(lineStart, lineEnd === -1 ? value.length : lineEnd));
        };
        if (!content.trim() || (content.includes('\n') && (inTableRow(start) || inTableRow(end)))) continue;
        // "$$20 billion in pesos ... bank$$" is two prices, not an equation.
        // Skip only the opener so a later real pair can still form.
        if (looksLikeCurrencyProse(content)) continue;
        result += value.slice(cursor, start) + replacer(value.slice(start, end + 2), content);
        cursor = end + 2;
        i++;
    }
    return result + value.slice(cursor);
}

function isSingleDollar(text, index) {
    return text[index] === '$'
        && text[index - 1] !== '$'
        && text[index + 1] !== '$'
        && !isEscaped(text, index);
}

function canOpenInlineMath(text, index) {
    const next = text[index + 1];
    return Boolean(next) && !/\s/.test(next) && next !== '$';
}

function canCloseInlineMath(text, index) {
    const previous = text[index - 1];
    const next = text[index + 1];
    return Boolean(previous)
        && !/\s/.test(previous)
        && previous !== '$'
        && !(next && /\d/.test(next));
}

// TeX commands whose braced argument is prose by design: their words are not
// evidence that a dollar pair wraps a sentence.
const TEXT_ARGUMENT_COMMAND = /\\(?:text[a-z]*|math[a-z]*|operatorname\*?|mbox|hbox|begin|end|label|tag|color|textcolor|mathrm)\s*\{[^{}]*\}/g;

/**
 * A dollar pair around prose is two currency amounts, not math. Models write
 * "$20 billion in pesos from the central bank$..." far more often than TeX
 * with three bare words in a row; TeX words are commands or \text arguments.
 */
export function looksLikeCurrencyProse(content) {
    const value = String(content ?? '');
    // "$20 billion", "$3.5 million", "$5 per seat": an amount, then a word.
    if (/^\s*\d[\d,.]*\s+[A-Za-z]{2,}/.test(value)) return true;
    const bare = value.replace(TEXT_ARGUMENT_COMMAND, ' ').replace(/\\[A-Za-z]+/g, ' ');
    return /(?:^|[^\\A-Za-z])[A-Za-z]{2,}\s+[A-Za-z]{2,}\s+[A-Za-z]{2,}(?![A-Za-z])/.test(bare);
}

function isPlausibleInlineMath(content) {
    const value = content.trim();
    return Boolean(value)
        && !/[\r\n]/.test(value)
        && !/[+\-*/=<>|,;:.([{]$/.test(value)
        && !looksLikeCurrencyProse(value);
}

function findInlineDollarMathPairs(value) {
    const pairs = [];
    let openIndex = null;

    for (let index = 0; index < value.length; index += 1) {
        if (!isSingleDollar(value, index)) continue;

        const canOpen = canOpenInlineMath(value, index);
        const canClose = canCloseInlineMath(value, index);

        if (openIndex !== null && canClose) {
            const content = value.slice(openIndex + 1, index);
            if (isPlausibleInlineMath(content)) {
                pairs.push([openIndex, index]);
                openIndex = null;
                continue;
            }
        }

        if (canOpen) {
            // A new opening token supersedes an unmatched currency dollar.
            openIndex = index;
        }
    }

    return pairs;
}

export function replaceInlineDollarMath(text, replacer) {
    const value = String(text ?? '');
    const pairs = findInlineDollarMathPairs(value);
    if (pairs.length === 0) return value;

    let replaced = '';
    let cursor = 0;
    pairs.forEach(([start, end], index) => {
        const match = value.slice(start, end + 1);
        const content = value.slice(start + 1, end);
        replaced += value.slice(cursor, start);
        replaced += replacer(match, content, index);
        cursor = end + 1;
    });
    return replaced + value.slice(cursor);
}

export function replaceEscapedDollars(text, replacer) {
    const value = String(text ?? '');
    let replaced = '';
    let cursor = 0;
    let replacementIndex = 0;

    for (let index = 0; index < value.length; index += 1) {
        if (value[index] !== '$' || !isEscaped(value, index)) continue;

        replaced += value.slice(cursor, index - 1);
        replaced += replacer(replacementIndex);
        replacementIndex += 1;
        cursor = index + 1;
    }

    return replaced + value.slice(cursor);
}

function findClosingCodeRun(value, start, marker, length) {
    const delimiter = marker.repeat(length);
    let searchIndex = start + length;

    while (searchIndex < value.length) {
        const closeIndex = value.indexOf(delimiter, searchIndex);
        if (closeIndex === -1) return -1;

        if (value[closeIndex - 1] !== marker && value[closeIndex + length] !== marker) {
            return closeIndex;
        }
        searchIndex = closeIndex + length;
    }
    return -1;
}

function isTildeFenceStart(value, index) {
    const lineStart = value.lastIndexOf('\n', index - 1) + 1;
    const prefix = value.slice(lineStart, index);
    return prefix.length <= 3 && /^ *$/.test(prefix);
}

export function transformMarkdownOutsideCode(text, transform) {
    const value = String(text ?? '');
    let transformed = '';
    let cursor = 0;
    let index = 0;

    while (index < value.length) {
        const marker = value[index];
        const isBacktick = marker === '`';
        const isTildeFence = marker === '~'
            && value.slice(index, index + 3) === '~~~'
            && isTildeFenceStart(value, index);

        if (!isBacktick && !isTildeFence) {
            index += 1;
            continue;
        }

        let runLength = 1;
        while (value[index + runLength] === marker) runLength += 1;
        if (isTildeFence && runLength < 3) {
            index += runLength;
            continue;
        }

        const closeIndex = findClosingCodeRun(value, index, marker, runLength);
        if (closeIndex === -1) {
            index += runLength;
            continue;
        }

        transformed += transform(value.slice(cursor, index));
        transformed += value.slice(index, closeIndex + runLength);
        cursor = closeIndex + runLength;
        index = cursor;
    }

    return transformed + transform(value.slice(cursor));
}

export function protectDollarMathForMarkdown(text, { math, literalDollar }) {
    let mathIndex = 0;
    let literalDollarIndex = 0;
    return transformMarkdownOutsideCode(text, segment => {
        const protectedMath = replaceInlineDollarMath(segment, (match, content) => {
            const replacement = math(match, content, mathIndex);
            mathIndex += 1;
            return replacement;
        });
        return replaceEscapedDollars(protectedMath, () => {
            const replacement = literalDollar(literalDollarIndex);
            literalDollarIndex += 1;
            return replacement;
        });
    });
}

function replaceLiteralDollarTokens(value, placeholders) {
    return placeholders.reduce(
        (result, placeholder) => result.split(placeholder).join('$'),
        value
    );
}

export function restoreLiteralDollarPlaceholders(
    html,
    placeholders,
    ownerDocument = globalThis.document
) {
    if (!Array.isArray(placeholders) || placeholders.length === 0) return html;

    if (!ownerDocument?.createElement || !ownerDocument.createTreeWalker) {
        return placeholders.reduce(
            (result, placeholder) => result
                .split(placeholder)
                .join('<span class="math-literal-dollar">$</span>'),
            html
        );
    }

    const template = ownerDocument.createElement('template');
    template.innerHTML = html;

    template.content.querySelectorAll('*').forEach(element => {
        Array.from(element.attributes).forEach(attribute => {
            if (placeholders.some(placeholder => attribute.value.includes(placeholder))) {
                element.setAttribute(
                    attribute.name,
                    replaceLiteralDollarTokens(attribute.value, placeholders)
                );
            }
        });
    });

    const textWalker = ownerDocument.createTreeWalker(template.content, 4);
    const textNodes = [];
    let textNode = textWalker.nextNode();
    while (textNode) {
        if (placeholders.some(placeholder => textNode.nodeValue?.includes(placeholder))) {
            textNodes.push(textNode);
        }
        textNode = textWalker.nextNode();
    }

    const tokenPattern = new RegExp(placeholders.join('|'), 'g');
    textNodes.forEach(node => {
        if (isIgnoredTextNode(node, template.content)) {
            node.nodeValue = replaceLiteralDollarTokens(node.nodeValue, placeholders);
            return;
        }

        const fragment = ownerDocument.createDocumentFragment();
        let cursor = 0;
        let match = tokenPattern.exec(node.nodeValue);
        while (match) {
            fragment.append(node.nodeValue.slice(cursor, match.index));
            const span = ownerDocument.createElement('span');
            span.className = 'math-literal-dollar';
            span.textContent = '$';
            fragment.append(span);
            cursor = match.index + match[0].length;
            match = tokenPattern.exec(node.nodeValue);
        }
        fragment.append(node.nodeValue.slice(cursor));
        node.replaceWith(fragment);
        tokenPattern.lastIndex = 0;
    });

    const commentWalker = ownerDocument.createTreeWalker(template.content, 128);
    let commentNode = commentWalker.nextNode();
    while (commentNode) {
        commentNode.nodeValue = replaceLiteralDollarTokens(commentNode.nodeValue, placeholders);
        commentNode = commentWalker.nextNode();
    }

    return template.innerHTML;
}

/**
 * Normalize Gemini-style $...$ inline math to the delimiters used by KaTeX.
 * The pairing rules intentionally reject whitespace-adjacent delimiters and a
 * closing dollar followed by a digit so price ranges such as $5-$10 stay text.
 */
export function normalizeInlineDollarMath(text) {
    return replaceInlineDollarMath(text, (_match, content) => `\\(${content}\\)`);
}

function isIgnoredTextNode(node, root) {
    let element = node.parentElement;
    while (element) {
        if (IGNORED_MATH_TAGS.has(element.tagName.toLowerCase())
            || element.classList.contains('katex')
            || element.classList.contains('math-literal-dollar')) {
            return true;
        }
        if (element === root) break;
        element = element.parentElement;
    }
    return false;
}

function normalizeDollarMathTextNodes(root) {
    const ownerDocument = root?.ownerDocument;
    if (!ownerDocument?.createTreeWalker) return;

    const walker = ownerDocument.createTreeWalker(root, 4);
    const textNodes = [];
    let node = walker.nextNode();
    while (node) {
        if (!isIgnoredTextNode(node, root) && node.nodeValue?.includes('$')) {
            textNodes.push(node);
        }
        node = walker.nextNode();
    }

    textNodes.forEach(textNode => {
        textNode.nodeValue = normalizeInlineDollarMath(replaceDisplayDollarMath(
            textNode.nodeValue, (_match, content) => `\\[${content}\\]`
        ));
    });
}

// Models sometimes emit prose ampersands inside \text without escaping them.
// Restrict recovery to balanced text groups; & outside them aligns matrix columns.
export function normalizeMathTextAmpersands(source) {
    // A literal \text command inside verbatim is content, not a text group.
    if ([...source.matchAll(/\\verb\b/g)].some(token => !isEscaped(source, token.index))) {
        return source;
    }
    const command = /\\text\s*\{/g;
    let result = '';
    let cursor = 0;
    let match;
    while ((match = command.exec(source))) {
        if (isEscaped(source, match.index)) continue;
        const contentStart = command.lastIndex;
        let depth = 1;
        let end = contentStart;
        for (; end < source.length; end++) {
            if (source[end] !== '{' && source[end] !== '}') continue;
            if (isEscaped(source, end)) continue;
            if (source[end] === '{') depth++;
            if (source[end] === '}' && --depth === 0) break;
        }
        if (depth !== 0) break;
        result += source.slice(cursor, contentStart);
        // Embedded math, verbatim and other commands have their own ampersand
        // rules. Leave those groups alone instead of guessing at TeX semantics.
        const text = source.slice(contentStart, end);
        const hasCommandsOrMath = [...text.matchAll(/\$|\\(?:[a-zA-Z]|\()/g)]
            .some(token => !isEscaped(text, token.index));
        for (let i = contentStart; i < end; i++) {
            result += !hasCommandsOrMath && source[i] === '&' && !isEscaped(source, i)
                ? '\\&' : source[i];
        }
        result += '}';
        cursor = end + 1;
        command.lastIndex = cursor;
    }
    return result + source.slice(cursor);
}

export function renderMathContent(root) {
    if (!root) return;

    const renderer = globalThis.renderMathInElement;
    if (typeof renderer !== 'function') return;

    normalizeDollarMathTextNodes(root);
    renderer(root, {
        delimiters: MATH_DELIMITERS,
        ignoredClasses: ['math-literal-dollar'],
        preProcess: normalizeMathTextAmpersands,
        throwOnError: false
    });
    // Make horizontal equation scrolling available to keyboard users too.
    root.querySelectorAll?.('.katex-display').forEach(equation => {
        equation.setAttribute('tabindex', '0');
        equation.setAttribute('role', 'region');
        equation.setAttribute('aria-label', 'Equation');
    });
}

/**
 * Markdown + math for one message. Math is swapped for namespaced placeholders
 * before Markdown so emphasis and lists cannot split it, then swapped back.
 * Every placeholder is restored, whatever Markdown did around it.
 */
export function renderMarkdownWithMath(content, { parse, escapeHtml }) {
    const source = String(content ?? '');
    // Terminate numeric IDs: token 1 must never match the prefix of token 10.
    const placeholderNamespace = createMathPlaceholderNamespace(source);
    const blockLatexPlaceholders = [];
    const inlineLatexPlaceholders = [];
    const literalDollarPlaceholders = [];
    const blockPlaceholder = match => {
        const placeholder = `${placeholderNamespace}BLOCK${blockLatexPlaceholders.length}END`;
        blockLatexPlaceholders.push({ placeholder, latex: escapeHtml(match) });
        return `\n\n${placeholder}\n\n`;
    };
    const inlinePlaceholder = match => {
        const placeholder = `${placeholderNamespace}INLINE${inlineLatexPlaceholders.length}END`;
        inlineLatexPlaceholders.push({ placeholder, latex: escapeHtml(match) });
        return placeholder;
    };

    let processedContent = source.replace(/\\\[([\s\S]*?)\\\]/g, match => blockPlaceholder(match));
    processedContent = transformMarkdownOutsideCode(processedContent,
        segment => replaceDisplayDollarMath(segment, match => blockPlaceholder(match)));
    processedContent = processedContent.replace(/\\\(([\s\S]*?)\\\)/g, match => inlinePlaceholder(match));
    // Gemini sometimes emits $...$ despite the requested \(...\) format.
    processedContent = protectDollarMathForMarkdown(processedContent, {
        math: match => inlinePlaceholder(match),
        // Marked consumes the slash in \$, so carry literal-dollar intent
        // through parsing with a non-math span.
        literalDollar: () => {
            const placeholder = `${placeholderNamespace}LITERAL${literalDollarPlaceholders.length}END`;
            literalDollarPlaceholders.push(placeholder);
            return placeholder;
        }
    });

    let html = parse(processedContent);

    blockLatexPlaceholders.forEach(({ placeholder, latex }) => {
        html = html.split(`<p>${placeholder}</p>`).join(placeholder);
        html = html.split(placeholder).join(latex);
    });
    inlineLatexPlaceholders.forEach(({ placeholder, latex }) => {
        html = html.split(placeholder).join(latex);
    });
    return restoreLiteralDollarPlaceholders(html, literalDollarPlaceholders);
}
