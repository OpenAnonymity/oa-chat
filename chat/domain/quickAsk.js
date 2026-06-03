const DEFAULT_MAX_SELECTION_CHARS = 240;

export function normalizeQuickAskSelection(text, options = {}) {
    const maxChars = Number.isFinite(options.maxChars)
        ? Math.max(1, options.maxChars)
        : DEFAULT_MAX_SELECTION_CHARS;
    const normalized = String(text || '')
        .replace(/\s+/g, ' ')
        .trim();

    if (!normalized) return '';
    if (normalized.length <= maxChars) return normalized;
    return `${normalized.slice(0, maxChars).trimEnd()}...`;
}

export function buildQuickAskQuestion(selection) {
    const normalized = normalizeQuickAskSelection(selection);
    return normalized ? `Briefly explain "${normalized}" in context.` : '';
}

export function buildQuickAskMessages(conversationMessages, selection) {
    const question = buildQuickAskQuestion(selection);
    if (!question) return [];
    const baseMessages = Array.isArray(conversationMessages) ? conversationMessages : [];
    return [
        ...baseMessages,
        {
            role: 'user',
            content: question
        }
    ];
}
