/**
 * Parse structured memory blocks from file content.
 *
 * Block format:
 *   <!-- @memory created=2026-03-05 session=abc123 -->
 *   ## Title Here
 *   - fact 1
 *   - fact 2
 *   <!-- @/memory -->
 *
 * Gracefully handles files without blocks (returns empty array).
 */

const OPEN_TAG_RE = /<!-- @memory\s+(.*?)\s*-->/g;
const CLOSE_TAG = '<!-- @/memory -->';

/**
 * Parse all structured memory blocks from file content.
 * @param {string} content
 * @returns {Array<{ title: string, body: string, created: string, session: string, raw: string }>}
 */
export function parseMemoryBlocks(content) {
    if (!content) return [];

    const blocks = [];
    let match;
    OPEN_TAG_RE.lastIndex = 0;

    while ((match = OPEN_TAG_RE.exec(content)) !== null) {
        const openStart = match.index;
        const attrsStr = match[1];
        const afterOpen = openStart + match[0].length;

        const closeIdx = content.indexOf(CLOSE_TAG, afterOpen);
        if (closeIdx === -1) continue; // unclosed block, skip

        const raw = content.slice(openStart, closeIdx + CLOSE_TAG.length);
        const inner = content.slice(afterOpen, closeIdx).trim();

        // Parse key=value attributes
        const attrs = {};
        const attrRe = /(\w+)=(\S+)/g;
        let attrMatch;
        while ((attrMatch = attrRe.exec(attrsStr)) !== null) {
            attrs[attrMatch[1]] = attrMatch[2];
        }

        // Title = first ## heading in the block
        let title = '';
        let body = inner;
        const titleMatch = inner.match(/^##\s+(.+)$/m);
        if (titleMatch) {
            title = titleMatch[1].trim();
            body = inner.slice(inner.indexOf('\n', inner.indexOf(titleMatch[0])) + 1).trim();
        }

        blocks.push({
            title,
            body,
            created: attrs.created || '',
            session: attrs.session || '',
            raw,
        });
    }

    return blocks;
}

/**
 * Extract just the titles from blocks, for l0/index generation.
 * @param {string} content
 * @returns {string[]}
 */
export function extractBlockTitles(content) {
    return parseMemoryBlocks(content)
        .map(b => b.title)
        .filter(t => t.length > 0);
}
