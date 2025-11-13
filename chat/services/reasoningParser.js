/**
 * Reasoning Content Parser
 *
 * Parses and normalizes reasoning traces from model providers.
 * This module is designed to be easily updated if provider formats change.
 *
 * Current format expectations (as of Nov 2025):
 * - Bold sections (**text**) are used as subtitles/section headers
 * - Paragraphs may run together without proper line breaks
 * - Bold sections may be directly adjacent to paragraph text without spacing
 * - During streaming, bold markers may have newlines within them: **\nTitle\n**
 *
 * Important notes:
 * - During streaming, content is shown as plain text (no markdown/LaTeX rendering)
 * - When streaming completes, the parsed content is processed with markdown and LaTeX
 * - This two-step approach avoids expensive processing during streaming
 */

/**
 * Converts any bold pair (**...**) into a standalone subtitle block:
 * - Trims inner whitespace (including newlines) inside bold markers
 * - Ensures a blank line BEFORE and configurable newlines AFTER each bold pair
 * - Drops unmatched/stray "**" markers
 *
 * NOTE: Markdown requires a BLANK line (two '\n') to start a new paragraph.
 * We therefore ensure:
 *   - BEFORE: 2 newlines when newlineAfterCount >= 2 (final render)
 *   - BEFORE: 1 newline when newlineAfterCount < 2 (streaming readability)
 *   - AFTER: exactly 'newlineAfterCount' newlines (caller decides)
 *
 * This treats all bold pairs as subtitles per product guideline.
 *
 * @param {string} text
 * @param {number} newlineAfterCount - number of newlines to place after the bold block
 * @returns {string}
 */
function blockifyBoldMarkers(text, newlineAfterCount = 1) {
    if (!text) return '';
    let i = 0;
    let out = '';

    const len = text.length;
    const requiredBefore = newlineAfterCount >= 2 ? 2 : 1;
    while (i < len) {
        const start = text.indexOf('**', i);
        if (start === -1) {
            out += text.slice(i);
            break;
        }

        // Append non-bold segment first
        out += text.slice(i, start);

        // Find closing marker
        const end = text.indexOf('**', start + 2);
        if (end === -1) {
            // Stray opener; drop it and continue scanning
            i = start + 2;
            continue;
        }

        // Extract and normalize inner title
        let inner = text.slice(start + 2, end);
        inner = inner.replace(/\s+/g, ' ').trim();
        if (inner.length === 0) {
            // Empty bold block, drop it
            i = end + 2;
            continue;
        }

        // Ensure a blank line (or at least one newline for streaming) BEFORE the bold block
        if (out.length > 0) {
            // Remove trailing spaces
            out = out.replace(/[ \t]+$/, '');
            // Count existing trailing newlines
            const match = out.match(/\n+$/);
            const existingNewlines = match ? match[0].length : 0;
            if (existingNewlines < requiredBefore) {
                out += '\n'.repeat(requiredBefore - existingNewlines);
            }
        }

        // Append bold block and ensure newline(s) after
        const newlineAfter = '\n'.repeat(Math.max(1, newlineAfterCount));
        out += `**${inner}**${newlineAfter}`;
        i = end + 2;
    }

    return out;
}

/**
 * Parses raw reasoning content from the provider into properly formatted text.
 *
 * Current behavior:
 * - Removes newlines within bold markers (streaming can cause: **\nTitle\n**)
 * - Ensures every bold block is on its own line (newline before and after)
 * - Visual spacing is controlled by CSS
 *
 * Format:
 * **subtitle 1**
 * paragraph 1
 * **subtitle 2**
 * paragraph 2
 *
 * This handles common Markdown elements:
 * - Bold headings: **Title**
 * - Lists: - item or * item (preserved by maintaining their spacing)
 * - LaTeX: $inline$ or $$display$$ (preserved as-is, rendered later)
 *
 * @param {string} rawReasoning - The raw reasoning content from the provider
 * @returns {string} Properly formatted reasoning text ready for markdown rendering
 */
export function parseReasoningContent(rawReasoning) {
    if (!rawReasoning || typeof rawReasoning !== 'string') {
        return '';
    }

    let content = rawReasoning.replace(/\r\n/g, '\n').trim();

    // Step 1: Convert any bold pair into a standalone block and drop strays.
    // For final markdown rendering, ensure a blank line after bold subtitles.
    content = blockifyBoldMarkers(content, 2);

    // Step 2: Collapse excessive newlines but preserve paragraph breaks.
    // Reduce 3+ newlines to exactly two so subtitles remain separate paragraphs.
    content = content.replace(/\n{3,}/g, '\n\n');

    // Step 3: Remove leading/trailing whitespace
    content = content.trim();

    return content;
}

/**
 * Parses reasoning content during streaming.
 * Uses same logic as final parsing for consistency.
 *
 * @param {string} rawReasoning - The raw reasoning content (may be incomplete)
 * @returns {string} Formatted reasoning text
 */
export function parseStreamingReasoningContent(rawReasoning) {
    if (!rawReasoning || typeof rawReasoning !== 'string') {
        return '';
    }
    // Streaming: produce readable plain text with single newlines after subtitles
    let content = rawReasoning.replace(/\r\n/g, '\n').trim();
    content = blockifyBoldMarkers(content, 1);
    // Collapse runs of blank lines to single newline for smoother streaming
    content = content.replace(/\n{2,}/g, '\n');
    return content.trim();
}

/**
 * Extracts structured information from reasoning content.
 * Useful for generating summaries, outlines, or navigation.
 *
 * @param {string} reasoning - The reasoning content (raw or parsed)
 * @returns {Object} Structured data with sections and summaries
 */
export function extractReasoningStructure(reasoning) {
    if (!reasoning || typeof reasoning !== 'string') {
        return { sections: [], summaries: [] };
    }

    const lines = reasoning.trim().split('\n');
    const sections = [];
    const summaries = [];
    let currentSection = null;

    for (const line of lines) {
        const trimmedLine = line.trim();
        if (!trimmedLine) continue;

        // Check for markdown headings (# Header)
        const headingMatch = trimmedLine.match(/^(#+)\s+(.+)$/);
        if (headingMatch) {
            const level = headingMatch[1].length;
            const text = headingMatch[2].trim();
            summaries.push({ type: 'heading', level, text });

            // Start new section
            if (currentSection) sections.push(currentSection);
            currentSection = { type: 'heading', heading: text, level, content: [] };
            continue;
        }

        // Check for bold text (**text**) - treat as section headers
        const boldMatch = trimmedLine.match(/^\*\*(.+?)\*\*$/);
        if (boldMatch) {
            const text = boldMatch[1].trim();
            summaries.push({ type: 'bold', text });

            // Start new section
            if (currentSection) sections.push(currentSection);
            currentSection = { type: 'bold', heading: text, content: [] };
            continue;
        }

        // Extract inline bold text for summaries (not full line)
        const inlineBoldMatches = trimmedLine.matchAll(/\*\*(.+?)\*\*/g);
        for (const match of inlineBoldMatches) {
            const boldText = match[1].trim();
            // Only treat as summary if it's reasonably short and looks like a title
            if (boldText.length > 5 && boldText.length < 100 && !boldText.includes('.')) {
                summaries.push({ type: 'inline-bold', text: boldText });
            }
        }

        // Add line to current section
        if (currentSection) {
            currentSection.content.push(trimmedLine);
        }
    }

    // Push final section
    if (currentSection) {
        sections.push(currentSection);
    }

    return { sections, summaries };
}

/**
 * Provider-specific parsers.
 * If a specific provider needs custom handling, add it here.
 */
const providerParsers = {
    // Example: OpenAI o1 models might have specific formatting
    // 'openai-o1': (content) => { ... },

    // Default parser used for all providers unless specified
    'default': parseReasoningContent
};

/**
 * Parses reasoning content with optional provider-specific handling.
 *
 * @param {string} rawReasoning - The raw reasoning content
 * @param {string} providerId - Optional provider identifier (e.g., 'openai', 'anthropic')
 * @returns {string} Formatted reasoning text
 */
export function parseReasoningContentForProvider(rawReasoning, providerId = 'default') {
    const parser = providerParsers[providerId] || providerParsers.default;
    return parser(rawReasoning);
}
