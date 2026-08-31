const MATH_DELIMITERS = [
    { left: '$$', right: '$$', display: true },
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

function isPlausibleInlineMath(content) {
    const value = content.trim();
    return Boolean(value)
        && !/[\r\n]/.test(value)
        && !/[+\-*/=<>|,;:.([{]$/.test(value);
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
        textNode.nodeValue = normalizeInlineDollarMath(textNode.nodeValue);
    });
}

export function renderMathContent(root) {
    if (!root) return;

    const renderer = globalThis.renderMathInElement;
    if (typeof renderer !== 'function') return;

    normalizeDollarMathTextNodes(root);
    renderer(root, {
        delimiters: MATH_DELIMITERS,
        ignoredClasses: ['math-literal-dollar'],
        throwOnError: false
    });
}
