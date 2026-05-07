import { getMessageTextContent } from './messageContent.js';

export const DEFAULT_SESSION_TITLE_MAX_LENGTH = 60;
export const DEFAULT_SESSION_TITLE_FALLBACK_LENGTH = 50;
export const DEFAULT_SESSION_CONTENT_SEARCH_MAX_CHARS = 12000;
export const DEFAULT_SESSION_CONTENT_SEARCH_MESSAGE_MAX_CHARS = 2000;

export function buildLocalSessionTitle(content, options = {}) {
    const fallbackLength = options.fallbackLength || DEFAULT_SESSION_TITLE_FALLBACK_LENGTH;
    const text = getMessageTextContent(content)
        .replace(/\s+/g, ' ')
        .trim();
    if (!text) return 'New Chat';
    return text.substring(0, fallbackLength) +
        (text.length > fallbackLength ? '...' : '');
}

export function buildSessionTitleSearchText(content) {
    return getMessageTextContent(content)
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 1000);
}

export function normalizeSessionSearchText(content) {
    return getMessageTextContent(content)
        .replace(/\s+/g, ' ')
        .trim();
}

export function getSearchableMessageText(message) {
    if (!message || message.isLocalOnly) return '';
    if (message.role !== 'user' && message.role !== 'assistant') return '';
    return normalizeSessionSearchText(message.content);
}

export function buildSessionConversationSearchText(messages, options = {}) {
    if (!Array.isArray(messages)) return '';

    const maxChars = options.maxChars || DEFAULT_SESSION_CONTENT_SEARCH_MAX_CHARS;
    const maxMessageChars = options.maxMessageChars || DEFAULT_SESSION_CONTENT_SEARCH_MESSAGE_MAX_CHARS;
    const segments = messages
        .map(message => getSearchableMessageText(message))
        .filter(Boolean)
        .map(text => text.slice(0, maxMessageChars));

    if (!segments.length) return '';

    const firstSegment = segments[0].slice(0, maxChars);
    if (segments.length === 1 || firstSegment.length >= maxChars) {
        return firstSegment;
    }

    const recentSegments = [];
    let remaining = maxChars - firstSegment.length - 1;

    for (let i = segments.length - 1; i >= 1 && remaining > 0; i -= 1) {
        const segment = segments[i];
        const separatorCost = recentSegments.length ? 1 : 0;
        const available = remaining - separatorCost;
        if (available <= 0) break;

        if (segment.length <= available) {
            recentSegments.unshift(segment);
            remaining -= segment.length + separatorCost;
            continue;
        }

        recentSegments.unshift(segment.slice(segment.length - available));
        remaining = 0;
    }

    return [firstSegment, ...recentSegments].filter(Boolean).join('\n').slice(0, maxChars);
}

export function buildSessionSearchIndexFields(messages, options = {}) {
    const now = typeof options.now === 'function' ? options.now() : Date.now();
    return {
        conversationSearchText: buildSessionConversationSearchText(messages, options),
        conversationSearchIndexedAt: now
    };
}

export function cleanGeneratedSessionTitle(title, options = {}) {
    const maxLength = options.maxLength || DEFAULT_SESSION_TITLE_MAX_LENGTH;
    if (typeof title !== 'string') return '';
    let cleaned = title
        .replace(/\s+/g, ' ')
        .replace(/^title\s*:\s*/i, '')
        .trim();

    cleaned = cleaned.replace(/^["'“”‘’`]+|["'“”‘’`]+$/g, '').trim();
    cleaned = cleaned.replace(/[.!?;:]+$/g, '').trim();
    if (!cleaned) return '';

    if (cleaned.length > maxLength) {
        cleaned = cleaned.slice(0, maxLength).trimEnd();
        cleaned = cleaned.replace(/\s+\S*$/, '').trim() || cleaned;
    }

    return cleaned;
}
