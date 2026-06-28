function defaultGetMessageTextContent(content) {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        return content
            .map((part) => {
                if (!part) return '';
                if (typeof part.text === 'string') return part.text;
                if (typeof part.content === 'string') return part.content;
                return '';
            })
            .filter(Boolean)
            .join('');
    }
    if (content && typeof content.text === 'string') return content.text;
    return '';
}

export function normalizeMessagesForMemory(messages, {
    getMessageTextContent = defaultGetMessageTextContent,
    getScrubberMessageContent = null
} = {}) {
    return (messages || [])
        .filter((message) => {
            if (!message) return false;
            if (message.isLocalOnly || message.model === 'memory agent') return false;
            return message.role === 'user' || message.role === 'assistant';
        })
        .map((message) => {
            const rawContent = typeof getScrubberMessageContent === 'function'
                ? getScrubberMessageContent(message, 'restored')
                : message.content;
            const content = typeof getMessageTextContent === 'function'
                ? getMessageTextContent(rawContent)
                : defaultGetMessageTextContent(rawContent);
            return {
                role: message.role,
                content: typeof content === 'string' ? content.trim() : ''
            };
        })
        .filter((message) => message.content);
}
