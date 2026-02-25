import { registerChatHistoryImporter } from '../chatHistoryImportRegistry.js';

/**
 * OA Importer
 * Imports chat history from OA's own export format (chats or all-data exports).
 */

/**
 * Check if the file is an OA export format.
 */
function isOaExport(file, sample) {
    const fileName = (file?.name || '').toLowerCase();
    const nameMatch = fileName.startsWith('oa-fastchat-chats-') || fileName.startsWith('oa-fastchat-export-');

    if (nameMatch) {
        return true;
    }

    if (!sample.includes('"formatVersion"') || !sample.includes('"oa-fastchat"')) {
        return false;
    }

    return sample.includes('"chats"') || sample.includes('"sessions"');
}

/**
 * Normalize OA export into the standard import format.
 */
function normalizeOaExport(data) {
    // Handle both chat-only and all-data exports
    const chatsData = data?.data?.chats || {};
    const sessions = chatsData.sessions || [];
    const messages = chatsData.messages || [];

    // Build a lookup of messages by session ID
    const messagesBySession = new Map();
    messages.forEach(msg => {
        const sessionId = msg.sessionId;
        if (!sessionId) return;
        if (!messagesBySession.has(sessionId)) {
            messagesBySession.set(sessionId, []);
        }
        messagesBySession.get(sessionId).push(msg);
    });

    // Convert sessions to import format
    const normalizedSessions = sessions.map(session => {
        const sessionMessages = messagesBySession.get(session.id) || [];

        // Sort messages by timestamp
        sessionMessages.sort((a, b) => {
            const timeA = new Date(a.timestamp || a.createdAt || 0).getTime();
            const timeB = new Date(b.timestamp || b.createdAt || 0).getTime();
            return timeA - timeB;
        });

        // Normalize messages
        const normalizedMessages = sessionMessages.map(msg => ({
            role: msg.role,
            content: msg.content || '',
            timestamp: new Date(msg.timestamp || msg.createdAt || Date.now()).getTime(),
            model: msg.model || null,
            tokenCount: msg.tokenCount || null,
            reasoning: msg.reasoning || null,
            reasoningDuration: msg.reasoningDuration || null,
            citations: msg.citations || null,
            files: msg.files || null,
            hasText: Boolean(msg.content && msg.content.trim()),
            hasMedia: Boolean(msg.files && msg.files.length > 0)
        }));

        const createdAt = session.createdAt
            ? new Date(session.createdAt).getTime()
            : (normalizedMessages[0]?.timestamp || Date.now());
        const updatedAt = session.updatedAt || session.lastUpdated
            ? new Date(session.updatedAt || session.lastUpdated).getTime()
            : (normalizedMessages[normalizedMessages.length - 1]?.timestamp || createdAt);

        return {
            sourceId: session.id,
            title: session.title || 'Imported Chat',
            createdAt,
            updatedAt,
            model: session.model || null,
            summary: typeof session.summary === 'string' ? session.summary : null,
            sessionMemory: typeof session.sessionMemory === 'string' ? session.sessionMemory : null,
            keywords: Array.isArray(session.keywords) ? session.keywords : [],
            keywordsGeneratedAt: session.keywordsGeneratedAt || null,
            messageCountAtGeneration: session.messageCountAtGeneration || null,
            messages: normalizedMessages
        };
    });

    // Calculate stats
    let messageCount = 0;
    let mediaMessages = 0;
    let emptySessions = 0;

    normalizedSessions.forEach(session => {
        if (!session.messages || session.messages.length === 0) {
            emptySessions += 1;
            return;
        }
        messageCount += session.messages.length;
        session.messages.forEach(msg => {
            if (msg.hasMedia) {
                mediaMessages += 1;
            }
        });
    });

    return {
        source: 'oa-fastchat',
        sessions: normalizedSessions,
        stats: {
            sessionCount: normalizedSessions.length,
            messageCount,
            mediaMessages,
            emptySessions
        }
    };
}

/**
 * Parse OA export file.
 */
async function parseOaExportFile(file, options = {}) {
    const text = await file.text();
    const data = JSON.parse(text);

    // Validate structure
    if (!data || typeof data !== 'object') {
        throw new Error('Invalid OA export file.');
    }

    if (!data.formatVersion || !data.data) {
        throw new Error('Invalid OA export format: missing formatVersion or data.');
    }

    const chats = data.data?.chats;
    if (!chats || !Array.isArray(chats.sessions)) {
        throw new Error('Invalid OA export format: missing chats data.');
    }

    return normalizeOaExport(data);
}

// Register the OA importer
registerChatHistoryImporter({
    id: 'oa-fastchat',
    label: 'oa-fastchat (export)',
    source: 'oa-fastchat',
    description: 'Import from OA\'s own chat export format.',
    fileHint: 'oa-fastchat-chats-*.json or oa-fastchat-export-*.json',
    accept: '.json,application/json',
    canImport: (file, sample) => isOaExport(file, sample),
    parse: (file, options) => parseOaExportFile(file, options),
    filterSession: (session) => Array.isArray(session.messages) && session.messages.length > 0 &&
        session.messages.some(message =>
            message.hasText ||
            (message.content && message.content.trim()) ||
            message.hasMedia
        )
});
