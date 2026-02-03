const ALPHA_REGEX = /[A-Za-z]/;

const escapeHtml = (value) => (
    value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
);

const escapeHtmlWithNewlines = (value) => (
    escapeHtml(value).replace(/\n/g, '<br>')
);

const tokenizeText = (text) => {
    const value = String(text || '');
    const tokens = [];
    let buffer = '';
    let bufferingWord = false;

    for (const char of value) {
        const isWordChar = ALPHA_REGEX.test(char);
        if (isWordChar) {
            if (!bufferingWord && buffer) {
                tokens.push(buffer);
                buffer = '';
            }
            buffer += char;
            bufferingWord = true;
        } else {
            if (bufferingWord && buffer) {
                tokens.push(buffer);
                buffer = '';
            }
            bufferingWord = false;
            tokens.push(char);
        }
    }

    if (buffer) {
        tokens.push(buffer);
    }

    return tokens;
};

const buildLcsTable = (aTokens, bTokens) => {
    const aLen = aTokens.length;
    const bLen = bTokens.length;
    const rows = new Array(aLen + 1);
    rows[aLen] = new Uint16Array(bLen + 1);

    for (let i = aLen - 1; i >= 0; i -= 1) {
        const row = new Uint16Array(bLen + 1);
        const nextRow = rows[i + 1];
        for (let j = bLen - 1; j >= 0; j -= 1) {
            if (aTokens[i] === bTokens[j]) {
                row[j] = nextRow[j + 1] + 1;
            } else {
                const down = nextRow[j];
                const right = row[j + 1];
                row[j] = down >= right ? down : right;
            }
        }
        rows[i] = row;
    }

    return rows;
};

const diffTokens = (aTokens, bTokens) => {
    const rows = buildLcsTable(aTokens, bTokens);
    const parts = [];
    let i = 0;
    let j = 0;

    while (i < aTokens.length && j < bTokens.length) {
        if (aTokens[i] === bTokens[j]) {
            parts.push({ type: 'equal', value: aTokens[i] });
            i += 1;
            j += 1;
            continue;
        }

        if (rows[i + 1][j] >= rows[i][j + 1]) {
            parts.push({ type: 'delete', value: aTokens[i] });
            i += 1;
        } else {
            parts.push({ type: 'insert', value: bTokens[j] });
            j += 1;
        }
    }

    while (i < aTokens.length) {
        parts.push({ type: 'delete', value: aTokens[i] });
        i += 1;
    }

    while (j < bTokens.length) {
        parts.push({ type: 'insert', value: bTokens[j] });
        j += 1;
    }

    return parts;
};

const mergeParts = (parts) => {
    const merged = [];
    for (const part of parts) {
        const last = merged[merged.length - 1];
        if (last && last.type === part.type) {
            last.value += part.value;
        } else {
            merged.push({ ...part });
        }
    }
    return merged;
};

const renderTextSegment = (segment, type) => {
    if (!segment) return '';
    const safeValue = escapeHtml(segment);
    if (type === 'delete') {
        return `<del class="scrubber-deleted">${safeValue}</del>`;
    }
    if (type === 'insert') {
        return `<span class="scrubber-added">${safeValue}</span>`;
    }
    return safeValue;
};

const renderNewline = () => '<br>\u200B';

const renderPart = (part) => {
    const pieces = String(part.value || '').split('\n');
    if (pieces.length === 1) {
        return renderTextSegment(part.value, part.type);
    }
    const rendered = [];
    pieces.forEach((segment, index) => {
        rendered.push(renderTextSegment(segment, part.type));
        if (index < pieces.length - 1) {
            // Only render newlines for non-deleted parts
            // Deleted newlines should not appear in the output
            if (part.type !== 'delete') {
                rendered.push(renderNewline());
            }
        }
    });
    return rendered.join('');
};

export const renderEditableDiff = (originalText, redactedText) => {
    const aTokens = tokenizeText(originalText);
    const bTokens = tokenizeText(redactedText);
    const parts = mergeParts(diffTokens(aTokens, bTokens));
    return parts.map(renderPart).join('');
};

const getTextOffset = (container, node, offset) => {
    let textOffset = 0;
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_ALL, null);
    let current = walker.nextNode();
    while (current) {
        if (current === node) {
            return textOffset + offset;
        }
        if (current.nodeType === Node.TEXT_NODE) {
            textOffset += current.nodeValue?.length || 0;
        } else if (current.nodeName === 'BR') {
            textOffset += 1;
        } else if (current.nodeName === 'DIV' || current.nodeName === 'P') {
            // Block elements imply a newline at the start (except the first one usually, but let's match extractText)
            // Actually extractText adds newline at the END of block elements.
            // Let's align with extractTextFromEditableDiff logic.
        }
        
        // Check if we just finished a block element
        // This is hard with TreeWalker as we visit children.
        // Better approach: Re-implement using the same logic as extractText but stopping at target.
        
        current = walker.nextNode();
    }
    return textOffset;
};

// Helper to check if node is a block element that adds a newline
const isBlockElement = (node) => node.nodeName === 'DIV' || node.nodeName === 'P';
const isDeletedNode = (node) => (
    node?.nodeType === Node.ELEMENT_NODE && node.classList?.contains('scrubber-deleted')
);

// Helper to get text length excluding zero-width spaces (used as invisible cursor spacers)
const getTextLengthExcludingZWSP = (text) => {
    if (!text) return 0;
    return text.replace(/\u200B/g, '').length;
};

const getNodeTextLength = (node) => {
    if (!node || isDeletedNode(node)) return 0;
    if (node.nodeType === Node.TEXT_NODE) {
        return getTextLengthExcludingZWSP(node.nodeValue);
    }
    if (node.nodeName === 'BR') {
        return 1;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return 0;

    let length = 0;
    const children = Array.from(node.childNodes);
    children.forEach((child, index) => {
        length += getNodeTextLength(child);
        if (isBlockElement(child) && index < children.length - 1) {
            length += 1;
        }
    });
    return length;
};

const getChildTextOffset = (node, targetOffset) => {
    if (!node || node.nodeType !== Node.ELEMENT_NODE) return 0;
    const children = Array.from(node.childNodes);
    const limit = Math.min(targetOffset, children.length);
    let length = 0;
    for (let i = 0; i < limit; i += 1) {
        length += getNodeTextLength(children[i]);
        if (isBlockElement(children[i]) && i < children.length - 1) {
            length += 1;
        }
    }
    return length;
};

const getCursorAffinity = (container, range) => {
    if (!container || !range) return 'after';
    const node = range.startContainer;
    const offset = range.startOffset;

    const deletedAncestor = node?.nodeType === Node.ELEMENT_NODE
        ? node.closest?.('.scrubber-deleted')
        : node.parentElement?.closest('.scrubber-deleted');
    if (deletedAncestor) {
        const deletedLength = getNodeTextLength(deletedAncestor);
        let relativeOffset = 0;
        if (node.nodeType === Node.TEXT_NODE) {
            relativeOffset = offset;
        } else if (node.nodeType === Node.ELEMENT_NODE) {
            relativeOffset = getChildTextOffset(node, offset);
        }
        if (relativeOffset >= deletedLength) return 'after';
        return 'before';
    }

    if (node.nodeType === Node.TEXT_NODE) {
        const len = node.nodeValue?.length || 0;
        if (offset === 0 && isDeletedNode(node.previousSibling)) {
            return 'after';
        }
        if (offset === len && isDeletedNode(node.nextSibling)) {
            return 'before';
        }
    } else if (node.nodeType === Node.ELEMENT_NODE) {
        const children = Array.from(node.childNodes);
        if (offset > 0 && isDeletedNode(children[offset - 1])) {
            return 'after';
        }
        if (children[offset] && isDeletedNode(children[offset])) {
            return 'before';
        }
    }

    return 'after';
};

const getNormalizedTextOffset = (container, targetNode, targetOffset) => {
    if (!container) return 0;
    let offset = 0;
    let found = false;

    const traverse = (node) => {
        if (found) return;

        if (isDeletedNode(node)) {
            if (node === targetNode || node.contains(targetNode)) {
                found = true;
            }
            return;
        }

        if (node === targetNode) {
            if (node.nodeType === Node.ELEMENT_NODE) {
                const children = Array.from(node.childNodes);
                const limit = Math.min(targetOffset, children.length);
                for (let i = 0; i < limit; i += 1) {
                    offset += getNodeTextLength(children[i]);
                    if (isBlockElement(children[i]) && i < children.length - 1) {
                        offset += 1;
                    }
                }
            } else {
                // Count chars up to targetOffset, excluding ZWSP
                const text = node.nodeValue || '';
                let count = 0;
                for (let i = 0; i < targetOffset && i < text.length; i++) {
                    if (text[i] !== '\u200B') count++;
                }
                offset += count;
            }
            found = true;
            return;
        }

        if (node.nodeType === Node.TEXT_NODE) {
            if (node.parentElement?.closest('.scrubber-deleted')) {
                return;
            }
            const len = getTextLengthExcludingZWSP(node.nodeValue);
            offset += len;
        } else if (node.nodeName === 'BR') {
            offset += 1;
        } else if (node.nodeType === Node.ELEMENT_NODE) {
            // Traverse children
            const children = Array.from(node.childNodes);
            children.forEach((child, index) => {
                traverse(child);
                if (found) return;
                
                // Add newline after block elements if not last child
                if (isBlockElement(child) && index < children.length - 1) {
                    offset += 1;
                }
            });
        }
    };

    // Traverse children of container directly to match extractText structure
    Array.from(container.childNodes).forEach((child, index) => {
        traverse(child);
        if (found) return;
        if (isBlockElement(child) && index < container.childNodes.length - 1) {
            offset += 1;
        }
    });

    return offset;
};

const setNormalizedOffsetCursor = (container, targetOffset, affinity = 'after') => {
    let normalizedOffset = Number.isFinite(targetOffset) ? targetOffset : 0;
    normalizedOffset = Math.max(0, normalizedOffset);
    const maxOffset = getNodeTextLength(container);
    if (Number.isFinite(maxOffset)) {
        normalizedOffset = Math.min(normalizedOffset, maxOffset);
    }
    let currentOffset = 0;
    let found = false;

    const placeCaretAt = (node, placeAfter) => {
        const range = document.createRange();
        if (placeAfter) {
            range.setStartAfter(node);
        } else {
            range.setStartBefore(node);
        }
        range.collapse(true);
        const sel = window.getSelection();
        sel?.removeAllRanges();
        sel?.addRange(range);
        found = true;
    };

    const traverse = (node) => {
        if (found) return;

        if (isDeletedNode(node)) {
            return;
        }

        if (node.nodeType === Node.TEXT_NODE && !node.parentElement?.closest('.scrubber-deleted')) {
            const text = node.nodeValue || '';
            const lenExcludingZWSP = getTextLengthExcludingZWSP(text);
            if (currentOffset + lenExcludingZWSP >= normalizedOffset) {
                // Convert logical offset to physical offset (accounting for ZWSP)
                const logicalTarget = Math.min(Math.max(normalizedOffset - currentOffset, 0), lenExcludingZWSP);
                let physicalOffset = 0;
                let logicalCount = 0;
                for (let i = 0; i < text.length; i++) {
                    if (logicalCount >= logicalTarget) break;
                    physicalOffset = i + 1;
                    if (text[i] !== '\u200B') logicalCount++;
                }
                const range = document.createRange();
                range.setStart(node, physicalOffset);
                range.collapse(true);
                const sel = window.getSelection();
                sel?.removeAllRanges();
                sel?.addRange(range);
                found = true;
                return;
            }
            currentOffset += lenExcludingZWSP;
        } else if (node.nodeName === 'BR') {
            currentOffset += 1;
            // Check if target is at or before this position (after the BR)
            if (!found && currentOffset >= normalizedOffset) {
                placeCaretAt(node, true);
                return;
            }
        } else if (node.nodeType === Node.ELEMENT_NODE) {
            const children = Array.from(node.childNodes);
            children.forEach((child, index) => {
                traverse(child);
                if (found) return;
                if (isDeletedNode(child) && currentOffset === normalizedOffset) {
                    if (affinity === 'before') {
                        placeCaretAt(child, false);
                        return;
                    }
                    if (affinity === 'after') {
                        placeCaretAt(child, true);
                        return;
                    }
                }
                if (isBlockElement(child) && index < children.length - 1) {
                    currentOffset += 1;
                }
            });
        }
        
        // Handle case where target is exactly at the end of text/br
        if (!found && currentOffset === normalizedOffset) {
            // We are at the right spot, but maybe between nodes.
            // This is tricky. Usually the text node check catches it (>=).
        }
    };

    Array.from(container.childNodes).forEach((child, index) => {
        traverse(child);
        if (found) return;
        if (isBlockElement(child) && index < container.childNodes.length - 1) {
            currentOffset += 1;
        }
    });
    
    // Fallback if at the very end
    if (!found && normalizedOffset >= currentOffset) {
        const range = document.createRange();
        range.selectNodeContents(container);
        range.collapse(false);
        const sel = window.getSelection();
        sel?.removeAllRanges();
        sel?.addRange(range);
    }
};

// Ensure cursor is not inside a deleted span, move it outside if needed
const ensureCursorOutsideDeleted = (container) => {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    const range = sel.getRangeAt(0);
    if (!container.contains(range.startContainer)) return;
    
    const deletedAncestor = range.startContainer.nodeType === Node.ELEMENT_NODE
        ? range.startContainer.closest?.('.scrubber-deleted')
        : range.startContainer.parentElement?.closest('.scrubber-deleted');
    
    if (!deletedAncestor) return;
    
    // Move cursor after the deleted span
    const newRange = document.createRange();
    const nextSibling = deletedAncestor.nextSibling;
    if (nextSibling?.nodeType === Node.TEXT_NODE) {
        newRange.setStart(nextSibling, 0);
    } else {
        newRange.setStartAfter(deletedAncestor);
    }
    newRange.collapse(true);
    sel.removeAllRanges();
    sel.addRange(newRange);
};

export const updateEditableDiff = (container, originalText, editedText, cursorState = null, options = {}) => {
    if (!container) return;
    const { restoreFocus = false } = options;

    // Save cursor position
    let cursorOffset = 0;
    let affinity = 'after';
    let hasCursor = false;
    if (cursorState && Number.isFinite(cursorState.offset)) {
        cursorOffset = cursorState.offset;
        affinity = cursorState.affinity || 'after';
        hasCursor = true;
    } else {
        const sel = window.getSelection();
        if (sel && sel.rangeCount > 0) {
            const range = sel.getRangeAt(0);
            if (container.contains(range.startContainer)) {
                cursorOffset = getNormalizedTextOffset(container, range.startContainer, range.startOffset);
                affinity = getCursorAffinity(container, range);
                hasCursor = true;
            }
        }
    }

    // Re-render diff
    const html = renderEditableDiff(originalText, editedText);
    container.innerHTML = html;

    // Restore cursor position
    if (hasCursor) {
        setNormalizedOffsetCursor(container, cursorOffset, affinity);
        // Ensure cursor didn't land inside a deleted span
        ensureCursorOutsideDeleted(container);
        if (restoreFocus && container.focus) {
            container.focus({ preventScroll: true });
        }
    }
};

export const getEditableDiffSelectionState = (container) => {
    if (!container) return null;
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return null;
    const range = sel.getRangeAt(0);
    if (!container.contains(range.startContainer)) return null;
    return {
        offset: getNormalizedTextOffset(container, range.startContainer, range.startOffset),
        affinity: getCursorAffinity(container, range)
    };
};

export const restoreEditableDiffSelection = (container, state) => {
    if (!container || !state) return;
    setNormalizedOffsetCursor(container, state.offset, state.affinity);
};

export const extractTextFromEditableDiff = (container) => {
    if (!container) return '';
    const clone = container.cloneNode(true);
    clone.querySelectorAll('.scrubber-deleted').forEach((node) => node.remove());

    const output = [];
    const blockTags = new Set(['DIV', 'P']);

    const appendNodeText = (node) => {
        if (node.nodeType === Node.TEXT_NODE) {
            output.push(node.nodeValue || '');
            return;
        }
        if (node.nodeType !== Node.ELEMENT_NODE) return;

        const element = node;
        if (element.tagName === 'BR') {
            output.push('\n');
            return;
        }

        Array.from(element.childNodes).forEach(appendNodeText);
    };

    const children = Array.from(clone.childNodes);
    children.forEach((child, index) => {
        appendNodeText(child);
        if (
            child.nodeType === Node.ELEMENT_NODE &&
            blockTags.has(child.tagName) &&
            index < children.length - 1
        ) {
            output.push('\n');
        }
    });

    const text = output.join('').replace(/\u00a0/g, ' ').replace(/\u200B/g, '');
    return text.replace(/\r\n/g, '\n');
};

const insertTextAtCursor = (text) => {
    if (!text) return;
    if (document.queryCommandSupported?.('insertText')) {
        document.execCommand('insertText', false, text);
        return;
    }

    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return;
    selection.deleteFromDocument();
    selection.getRangeAt(0).insertNode(document.createTextNode(text));
    selection.collapseToEnd();
};

export const handleEditableDiffPaste = (event) => {
    event.preventDefault();
    const text = event.clipboardData?.getData('text/plain') || '';
    insertTextAtCursor(text);
};
