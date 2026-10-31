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

function omitPdfAttachments(message) {
    if (!Array.isArray(message?.content)) return message;
    return {
        ...message,
        content: message.content.map(part => {
            const filename = part?.file?.filename;
            const fileData = part?.file?.file_data;
            const isPdf = part?.type === 'file' && (
                (typeof filename === 'string' && /\.pdf$/i.test(filename.trim())) ||
                (typeof fileData === 'string' && /^data:application\/pdf(?:;|,)/i.test(fileData))
            );
            // Quick Ask explains existing conversation text without reopening PDFs.
            // A text marker also keeps an attachment-only message nonempty.
            return isPdf
                ? { type: 'text', text: '[PDF attachment omitted from this quick explanation.]' }
                : part;
        })
    };
}

export function buildQuickAskMessages(conversationMessages, selection) {
    const question = buildQuickAskQuestion(selection);
    if (!question) return [];
    const baseMessages = Array.isArray(conversationMessages) ? conversationMessages : [];
    return [
        ...baseMessages.map(omitPdfAttachments),
        {
            role: 'user',
            content: question
        }
    ];
}
