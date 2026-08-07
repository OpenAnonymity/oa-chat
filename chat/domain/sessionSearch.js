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

export function buildForkSessionTitleFields(sourceSession, firstUserContent, options = {}) {
    const forkSuffix = options.forkSuffix || ' (fork)';
    const sourceTitle = typeof sourceSession?.title === 'string'
        ? sourceSession.title.replace(/\s+/g, ' ').trim()
        : '';
    const sourceTitleSource = sourceSession?.titleSource || 'local';
    const titleSearchText = firstUserContent
        ? buildSessionTitleSearchText(firstUserContent)
        : '';

    if ((sourceTitleSource === 'generated' || sourceTitleSource === 'manual') && sourceTitle) {
        return {
            title: `${sourceTitle}${forkSuffix}`,
            titleSource: sourceTitleSource,
            titleSearchText: sourceTitleSource === 'manual' ? '' : titleSearchText
        };
    }

    const title = firstUserContent
        ? buildLocalSessionTitle(firstUserContent)
        : 'Forked Chat';

    return {
        title: `${title}${forkSuffix}`,
        titleSource: 'local',
        titleSearchText
    };
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

export function getSessionDateFilterBounds(filters = {}, now = Date.now()) {
    const startOfDay = (value) => {
        const date = new Date(value);
        return new Date(date.getFullYear(), date.getMonth(), date.getDate());
    };
    const shiftDays = (date, days) => {
        const shifted = new Date(date);
        shifted.setDate(shifted.getDate() + days);
        return shifted;
    };
    const toBounds = (start, endExclusive) => ({
        minUpdatedAt: start.getTime(),
        maxUpdatedAt: endExclusive.getTime() - 1
    });

    if (filters.customDate) {
        const start = new Date(`${filters.customDate}T00:00:00`);
        if (!Number.isFinite(start.getTime())) return {};
        return toBounds(start, shiftDays(start, 1));
    }

    const today = startOfDay(now);
    const tomorrow = shiftDays(today, 1);
    if (filters.dateMode === 'today') {
        return toBounds(today, tomorrow);
    }
    if (filters.dateMode === 'yesterday') {
        return toBounds(shiftDays(today, -1), today);
    }
    if (filters.dateMode === '7d') {
        return toBounds(shiftDays(today, -6), tomorrow);
    }
    if (filters.dateMode === '30d') {
        return toBounds(shiftDays(today, -29), tomorrow);
    }
    return {};
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
