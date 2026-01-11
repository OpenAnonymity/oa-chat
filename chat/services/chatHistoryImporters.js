const MEDIA_CONTENT_TYPES = new Map([
    ['image_asset_pointer', 'image'],
    ['video_container_asset_pointer', 'video'],
    ['audio_asset_pointer', 'audio'],
    ['real_time_user_audio_video_asset_pointer', 'audio/video']
]);

const SKIP_CONTENT_TYPES = new Set([
    'user_editable_context',
    'thoughts',
    'reasoning_recap'
]);

function decodeHtmlEntities(text) {
    if (!text || text.indexOf('&') === -1) {
        return text || '';
    }
    if (typeof document === 'undefined') {
        return text;
    }
    const textarea = document.createElement('textarea');
    textarea.innerHTML = text;
    return textarea.value;
}

function extractJsonDataFromHtml(htmlText) {
    const marker = 'var jsonData =';
    const startIndex = htmlText.indexOf(marker);
    if (startIndex === -1) {
        throw new Error('Could not find ChatGPT jsonData block in HTML export.');
    }

    const dataStart = startIndex + marker.length;
    const endMarker = 'function getConversationMessages';
    const endIndex = htmlText.indexOf(endMarker, dataStart);
    if (endIndex === -1) {
        throw new Error('Could not locate end of jsonData block in HTML export.');
    }

    const jsonText = htmlText.slice(dataStart, endIndex).trim();
    return jsonText.replace(/;?\s*$/, '');
}

function collectPartText(part, textParts, mediaTypes) {
    if (typeof part === 'string') {
        textParts.push(part);
        return;
    }
    if (!part || typeof part !== 'object') {
        return;
    }

    if (typeof part.text === 'string') {
        textParts.push(part.text);
    }
    if (typeof part.content === 'string') {
        textParts.push(part.content);
    }
    if (typeof part.title === 'string') {
        textParts.push(part.title);
    }

    if (part.asset_pointer || part.asset_pointer_data || part.file_id || part.image_url) {
        mediaTypes.push('image');
    }
    if (part.audio_url) {
        mediaTypes.push('audio');
    }
    if (part.video_url) {
        mediaTypes.push('video');
    }
}

function extractTextAndMedia(content) {
    if (!content || typeof content !== 'object') {
        return { text: '', mediaTypes: [] };
    }

    const contentType = content.content_type || content.contentType || '';
    const textParts = [];
    const mediaTypes = [];

    if (MEDIA_CONTENT_TYPES.has(contentType)) {
        mediaTypes.push(MEDIA_CONTENT_TYPES.get(contentType));
    }

    if (contentType === 'code' && typeof content.text === 'string') {
        const language = content.language ? content.language.trim() : '';
        const fence = language ? `\`\`\`${language}\n${content.text}\n\`\`\`` : `\`\`\`\n${content.text}\n\`\`\``;
        textParts.push(fence);
    } else {
        if (Array.isArray(content.parts)) {
            content.parts.forEach(part => collectPartText(part, textParts, mediaTypes));
        }
        if (typeof content.text === 'string') {
            textParts.push(content.text);
        }
        if (typeof content.result === 'string') {
            textParts.push(content.result);
        }
    }

    return {
        text: textParts.join('\n').trim(),
        mediaTypes
    };
}

function buildMediaPlaceholder(mediaTypes) {
    if (!mediaTypes || mediaTypes.length === 0) {
        return '';
    }

    const counts = {};
    mediaTypes.forEach(type => {
        counts[type] = (counts[type] || 0) + 1;
    });

    const summary = Object.entries(counts)
        .map(([type, count]) => count > 1 ? `${type} x${count}` : type)
        .join(', ');

    return `> Media omitted (text-only import): ${summary}`;
}

function getConversationPathMessages(conversation) {
    const mapping = conversation?.mapping || {};
    const currentNode = conversation?.current_node;
    if (!currentNode || !mapping[currentNode]) {
        const nodes = Object.values(mapping)
            .map(node => node?.message)
            .filter(Boolean)
            .sort((a, b) => (a.create_time || 0) - (b.create_time || 0));
        return nodes;
    }

    const ordered = [];
    const visited = new Set();
    let nodeId = currentNode;
    while (nodeId && mapping[nodeId] && !visited.has(nodeId)) {
        visited.add(nodeId);
        const node = mapping[nodeId];
        if (node?.message) {
            ordered.push(node.message);
        }
        nodeId = node.parent;
    }
    return ordered.reverse();
}

function normalizeChatGptConversation(conversation, options = {}) {
    const sourceId = conversation?.id || conversation?.conversation_id;
    const messages = [];

    const rawMessages = getConversationPathMessages(conversation);
    let lastTimestamp = null;

    rawMessages.forEach(message => {
        const authorRole = message?.author?.role;
        const isSystemLike = authorRole === 'system' || authorRole === 'tool' || authorRole === 'developer';
        const role = isSystemLike ? 'assistant' : authorRole;
        if (role !== 'user' && role !== 'assistant') {
            return;
        }
        if (message?.metadata?.is_visually_hidden_from_conversation) {
            return;
        }

        const contentType = message?.content?.content_type || message?.content?.contentType;
        if (SKIP_CONTENT_TYPES.has(contentType)) {
            return;
        }

        const { text, mediaTypes } = extractTextAndMedia(message?.content);
        if (!text && mediaTypes.length === 0) {
            return;
        }

        let timestamp = null;
        if (typeof message.create_time === 'number') {
            timestamp = Math.floor(message.create_time * 1000);
        } else if (typeof message.update_time === 'number') {
            timestamp = Math.floor(message.update_time * 1000);
        }

        if (!timestamp) {
            const fallback = typeof conversation?.create_time === 'number'
                ? Math.floor(conversation.create_time * 1000)
                : Date.now();
            timestamp = lastTimestamp ? lastTimestamp + 1 : fallback;
        }

        if (lastTimestamp && timestamp <= lastTimestamp) {
            timestamp = lastTimestamp + 1;
        }
        lastTimestamp = timestamp;

        const mediaNote = buildMediaPlaceholder(mediaTypes);
        const hasText = Boolean(text);
        let finalText = text || '';
        if (options.decodeHtmlEntities) {
            finalText = decodeHtmlEntities(finalText);
        }
        if (mediaNote) {
            finalText = finalText ? `${finalText}\n\n${mediaNote}` : mediaNote;
        }

        messages.push({
            role,
            content: isSystemLike ? '' : finalText,
            reasoning: isSystemLike ? finalText : null,
            timestamp,
            model: message?.metadata?.model_slug || message?.metadata?.model?.slug || null,
            hasMedia: mediaTypes.length > 0,
            hasText
        });
    });

    const createdAt = typeof conversation?.create_time === 'number'
        ? Math.floor(conversation.create_time * 1000)
        : (messages[0]?.timestamp || Date.now());
    const updatedAt = typeof conversation?.update_time === 'number'
        ? Math.floor(conversation.update_time * 1000)
        : (messages[messages.length - 1]?.timestamp || createdAt);

    let title = (conversation?.title || '').trim();
    if (options.decodeHtmlEntities) {
        title = decodeHtmlEntities(title);
    }

    return {
        sourceId,
        title,
        createdAt,
        updatedAt,
        model: conversation?.default_model_slug || conversation?.model_slug || null,
        messages
    };
}

function buildSessionTitle(conversationTitle, messages) {
    const normalizedTitle = (conversationTitle || '').trim();
    if (normalizedTitle && normalizedTitle.toLowerCase() !== 'new chat') {
        return normalizedTitle;
    }
    const firstUser = messages.find(message => message.role === 'user' && message.hasText)
        || messages.find(message => message.role === 'user');
    if (firstUser?.content) {
        const snippet = firstUser.content.replace(/\s+/g, ' ').trim();
        return snippet.length > 50 ? `${snippet.slice(0, 50)}...` : snippet;
    }
    return 'Imported Chat';
}

function summarizeSessions(sessions) {
    let messageCount = 0;
    let mediaMessages = 0;
    let emptySessions = 0;

    sessions.forEach(session => {
        if (!session.messages || session.messages.length === 0) {
            emptySessions += 1;
            return;
        }
        messageCount += session.messages.length;
        session.messages.forEach(message => {
            if (message.hasMedia) {
                mediaMessages += 1;
            }
        });
    });

    return {
        sessionCount: sessions.length,
        messageCount,
        mediaMessages,
        emptySessions
    };
}

async function parseChatGptJsonFile(file, options = {}) {
    const text = await file.text();
    const data = JSON.parse(text);
    if (!Array.isArray(data)) {
        throw new Error('ChatGPT JSON export should be an array of conversations.');
    }

    const sessions = data.map(conversation => normalizeChatGptConversation(conversation, options));
    const stats = summarizeSessions(sessions);
    return {
        source: 'chatgpt',
        sessions,
        stats
    };
}

async function parseChatGptHtmlFile(file, options = {}) {
    const htmlText = await file.text();
    const jsonText = extractJsonDataFromHtml(htmlText);
    const data = JSON.parse(jsonText);
    if (!Array.isArray(data)) {
        throw new Error('ChatGPT HTML export did not contain conversations array.');
    }

    const sessions = data.map(conversation => normalizeChatGptConversation(conversation, {
        ...options,
        decodeHtmlEntities: true
    }));
    const stats = summarizeSessions(sessions);
    return {
        source: 'chatgpt',
        sessions,
        stats
    };
}

function isChatGptJsonFile(file, sample) {
    const name = file?.name?.toLowerCase() || '';
    if (name.endsWith('conversations.json')) {
        return true;
    }
    return sample.includes('"mapping"') && sample.includes('"current_node"');
}

function isChatGptHtmlFile(file, sample) {
    const name = file?.name?.toLowerCase() || '';
    if (name.endsWith('.html') || name.endsWith('.htm')) {
        return sample.includes('ChatGPT Data Export') && sample.includes('var jsonData');
    }
    return false;
}

async function readFileSample(file, size = 2048) {
    const slice = file.slice(0, size);
    return slice.text();
}

const IMPORTERS = [
    {
        id: 'chatgpt-json',
        label: 'ChatGPT (JSON export)',
        canImport: (file, sample) => isChatGptJsonFile(file, sample),
        parse: (file, options) => parseChatGptJsonFile(file, options)
    },
    {
        id: 'chatgpt-html',
        label: 'ChatGPT (HTML export)',
        canImport: (file, sample) => isChatGptHtmlFile(file, sample),
        parse: (file, options) => parseChatGptHtmlFile(file, options)
    }
];

export async function parseChatHistoryFile(file, options = {}) {
    if (!file) {
        throw new Error('No file provided.');
    }

    const sample = await readFileSample(file);
    const importer = IMPORTERS.find(entry => entry.canImport(file, sample));
    if (!importer) {
        throw new Error('Unsupported file. Please upload conversations.json from the ChatGPT export.');
    }
    if (importer.id === 'chatgpt-html') {
        throw new Error('chat.html is not supported yet. Please upload conversations.json for text-only import.');
    }

    const parsed = await importer.parse(file, options);
    return {
        importer,
        parsed
    };
}

export function buildImportPlan(parsedSessions) {
    const sessions = parsedSessions
        .map(session => ({
            ...session,
            title: buildSessionTitle(session.title, session.messages)
        }))
        .filter(session => Array.isArray(session.messages) && session.messages.length > 0)
        .filter(session => session.messages.some(message => message.hasText))
        .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));

    return sessions;
}
