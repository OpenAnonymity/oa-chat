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

export const DEFAULT_SESSION_PREVIOUS_TITLE_LIMIT = 5;

/**
 * Titles a chat used to have, so a search for a name someone remembers still
 * finds the renamed chat. Newest first, bounded, without the current title or
 * placeholders. Returns null when nothing changes.
 */
export function recordPreviousSessionTitle(session, nextTitle, options = {}) {
    const limit = options.limit || DEFAULT_SESSION_PREVIOUS_TITLE_LIMIT;
    const clean = value => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '');
    const previous = clean(session?.title);
    const next = clean(nextTitle);
    const existing = Array.isArray(session?.previousTitles) ? session.previousTitles.map(clean) : [];
    const keep = title => title && title !== 'New Chat' && title !== next;
    const titles = [];
    for (const title of [previous, ...existing]) {
        if (keep(title) && !titles.includes(title)) titles.push(title);
    }
    const bounded = titles.slice(0, limit);
    const unchanged = bounded.length === existing.length && bounded.every((title, i) => title === existing[i]);
    return unchanged ? null : bounded;
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
