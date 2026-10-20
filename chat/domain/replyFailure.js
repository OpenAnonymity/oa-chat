// What a failed reply row is, read from its saved shape. A regenerate that
// fails must not "keep" an earlier failure as if it were an answer.

const ERROR_PREFIX = /^\s*(?:⚠️\s*)?\*\*(?:Error|Response interrupted)\b[^*]*\*\*:?\s*/i;

/** A row that holds no answer: only an error line (or nothing at all). */
export function isFailureReply(message) {
    if (!message || message.role !== 'assistant') return false;
    const content = typeof message.content === 'string' ? message.content : '';
    const hasMedia = Array.isArray(message.images) && message.images.length > 0;
    if (hasMedia || String(message.reasoning || '').trim()) return false;
    if (!content.trim()) return Boolean(message.inferenceError || message.isLocalOnly);
    // An error line written in place of an answer (local-only rows only: a
    // partial answer with an error note below it is still an answer).
    return message.isLocalOnly === true && ERROR_PREFIX.test(content);
}

/** The plain words of an error row ("**Error:** Too many requests…" → "Too many requests…"). */
export function failureReplyText(message) {
    if (!message) return '';
    const content = typeof message.content === 'string' ? message.content : '';
    const text = content.trim() ? content.replace(ERROR_PREFIX, '') : String(message.inferenceError || '');
    return text.replace(/\*\*/g, '').replace(/\s+/g, ' ').trim().slice(0, 240);
}
