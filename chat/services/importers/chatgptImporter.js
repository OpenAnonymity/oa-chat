import { registerChatHistoryImporter } from '../chatHistoryImportRegistry.js';

const MEDIA_CONTENT_TYPES = new Map([
    ['image_asset_pointer', 'image'],
    ['video_container_asset_pointer', 'video'],
    ['audio_asset_pointer', 'audio'],
    ['real_time_user_audio_video_asset_pointer', 'audio/video']
]);

const TAG_START = '\uE200';
const TAG_END = '\uE201';
const TAG_SEPARATOR = '\uE202';

const SKIP_CONTENT_TYPES = new Set([
    'user_editable_context',
    'reasoning_recap'
]);

function isChatGptInternalToolCodeBlock(content) {
    if (!content || typeof content !== 'object') return false;
    const contentType = content.content_type || content.contentType || '';
    if (contentType !== 'code') return false;
    if (typeof content.text !== 'string') return false;

    const language = typeof content.language === 'string' ? content.language.trim().toLowerCase() : '';
    const likelyInternalLanguage = !language || language === 'unknown';
    if (!likelyInternalLanguage) return false;

    const raw = content.text.trim();

    // Detect function-call style tool invocations: search("..."), web.search("..."), etc.
    // These are NOT JSON but look like: search("query text")
    const functionCallPattern = /^[a-z_][a-z0-9_.]*\s*\(/i;
    if (functionCallPattern.test(raw)) {
        return true;
    }

    // For JSON payloads, continue with existing checks
    if (!raw.startsWith('{') || !raw.endsWith('}')) return false;

    let parsed = null;
    try {
        parsed = JSON.parse(raw);
    } catch (error) {
        return false;
    }
    if (!parsed || typeof parsed !== 'object') return false;

    // Detect search/image query payloads
    const hasSearchQueries = Array.isArray(parsed.search_query) && parsed.search_query.some(entry =>
        entry && typeof entry.q === 'string' && entry.q.trim().length > 0
    );
    const hasImageQueries = Array.isArray(parsed.image_query) && parsed.image_query.some(entry =>
        entry && typeof entry.q === 'string' && entry.q.trim().length > 0
    );
    if (hasSearchQueries || hasImageQueries) return true;

    // Detect "open" payloads (internal tool for opening references)
    const hasOpenRefs = Array.isArray(parsed.open) && parsed.open.some(entry =>
        entry && typeof entry.ref_id === 'string'
    );
    if (hasOpenRefs) return true;

    // Detect response_length without any actual content (internal control payload)
    const hasResponseLength = typeof parsed.response_length === 'string';
    const hasNoRealContent = !parsed.text && !parsed.content && !parsed.message;
    if (hasResponseLength && hasNoRealContent) return true;

    return false;
}

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
        // Skip ChatGPT internal tool payloads (search queries, open refs, etc.).
        if (isChatGptInternalToolCodeBlock(content)) {
            return { text: '', mediaTypes: [] };
        }
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

function buildContentReferenceLookup(contentReferences) {
    const lookup = new Map();
    if (!Array.isArray(contentReferences)) return lookup;
    contentReferences.forEach(ref => {
        if (!ref || typeof ref !== 'object') return;
        const matchedText = ref.matched_text;
        if (typeof matchedText === 'string' && matchedText.includes(TAG_START)) {
            if (!lookup.has(matchedText)) {
                lookup.set(matchedText, ref);
            }
        }
    });
    return lookup;
}

function buildCitationFromContentReference(ref) {
    if (!ref || typeof ref !== 'object') return null;
    const item = Array.isArray(ref.items) && ref.items.length > 0 ? ref.items[0] : null;
    const url = item?.url || (Array.isArray(ref.safe_urls) ? ref.safe_urls[0] : null) || null;
    if (!url || typeof url !== 'string') return null;

    return {
        url,
        title: item?.title || null,
        description: item?.snippet || null,
        domain: item?.attribution || null
    };
}

function processCitationTags(text, contentReferences) {
    if (typeof text !== 'string' || text.length === 0) {
        return { cleanedText: text || '', citations: [] };
    }
    if (!text.includes(TAG_START)) {
        return { cleanedText: text, citations: [] };
    }

    const lookup = buildContentReferenceLookup(contentReferences);
    const outputParts = [];
    const citations = [];
    const seenUrls = new Set();
    let nextIndex = 1;
    let cursor = 0;

    while (cursor < text.length) {
        const startIndex = text.indexOf(TAG_START, cursor);
        if (startIndex === -1) {
            outputParts.push(text.slice(cursor));
            break;
        }

        if (startIndex > cursor) {
            outputParts.push(text.slice(cursor, startIndex));
        }

        const endIndex = text.indexOf(TAG_END, startIndex + 1);
        if (endIndex === -1) {
            // Malformed tag; skip just the tag start char to avoid spewing private-use glyphs.
            cursor = startIndex + 1;
            continue;
        }

        const matchedText = text.slice(startIndex, endIndex + 1);
        const inner = matchedText.slice(1, -1);
        const parts = inner.split(TAG_SEPARATOR);
        const tagType = parts[0];

        if (tagType === 'cite') {
            const ref = lookup.get(matchedText);
            const citation = ref ? buildCitationFromContentReference(ref) : null;
            if (citation && citation.url) {
                // Insert markdown link inline - the app's enhanceInlineLinks will style it.
                const linkText = citation.domain || citation.title || extractDomainFromUrl(citation.url);
                outputParts.push(`[${linkText}](${citation.url})`);

                // Also collect for the citations list at the bottom (dedupe by URL)
                if (!seenUrls.has(citation.url)) {
                    seenUrls.add(citation.url);
                    citations.push({
                        ...citation,
                        index: nextIndex
                    });
                    nextIndex += 1;
                }
            }
        }
        // Image tags ('i') and unknown tags are stripped silently.

        cursor = endIndex + 1;
    }

    return { cleanedText: outputParts.join('').trim(), citations };
}

function extractDomainFromUrl(url) {
    try {
        const parsed = new URL(url);
        return parsed.hostname.replace(/^www\./, '');
    } catch {
        return url;
    }
}

function extractImages(contentReferences) {
    const images = [];
    if (!Array.isArray(contentReferences)) return images;
    const seen = new Set();

    contentReferences.forEach(ref => {
        if (!ref || typeof ref !== 'object') return;
        if (ref.type !== 'image_v2') return;
        const refImages = Array.isArray(ref.images) ? ref.images : [];
        refImages.forEach(image => {
            const thumbnailUrl = image?.thumbnail_url;
            const fullUrl = image?.content_url || image?.url;
            const url = thumbnailUrl || fullUrl;
            if (typeof url !== 'string' || url.trim().length === 0) return;
            if (seen.has(url)) return;
            seen.add(url);
            images.push({
                type: 'imported_thumbnail',
                thumbnail_url: thumbnailUrl || url,
                full_url: fullUrl || url,
                title: image?.title || null,
                source_url: image?.url || null
            });
        });
    });

    return images;
}

function formatThoughts(thoughts) {
    if (!Array.isArray(thoughts) || thoughts.length === 0) return '';
    const blocks = thoughts
        .map(thought => {
            if (!thought || typeof thought !== 'object') return '';
            const summary = typeof thought.summary === 'string' ? thought.summary.trim() : '';
            const content = typeof thought.content === 'string' ? thought.content.trim() : '';
            if (!summary && !content) return '';
            if (summary && content) return `## ${summary}\n${content}`;
            if (summary) return `## ${summary}`;
            return content;
        })
        .filter(Boolean);
    return blocks.join('\n\n').trim();
}

function parseReasoningDurationMs(message) {
    const metadataSeconds = message?.metadata?.finished_duration_sec;
    if (typeof metadataSeconds === 'number' && Number.isFinite(metadataSeconds) && metadataSeconds >= 0) {
        return Math.round(metadataSeconds * 1000);
    }

    const recapText = message?.content?.content;
    if (typeof recapText !== 'string') return null;
    const text = recapText.trim();
    if (!text) return null;

    // Examples: "Thought for 2m 17s", "Thought for 12s"
    const match = text.match(/(\d+)\s*m\s*(\d+)\s*s|(\d+)\s*s/);
    if (!match) return null;
    const mins = match[1] ? parseInt(match[1], 10) : 0;
    const secs = match[2] ? parseInt(match[2], 10) : match[3] ? parseInt(match[3], 10) : 0;
    if (!Number.isFinite(mins) || !Number.isFinite(secs)) return null;
    return (mins * 60 + secs) * 1000;
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
    let pendingReasoning = '';
    let pendingReasoningDuration = null;

    rawMessages.forEach(message => {
        const authorRole = message?.author?.role;

        // Skip tool messages entirely - they're internal search results, not user-facing content
        if (authorRole === 'tool') {
            return;
        }

        const isSystemLike = authorRole === 'system' || authorRole === 'developer';
        const role = isSystemLike ? 'assistant' : authorRole;
        if (role !== 'user' && role !== 'assistant') {
            return;
        }
        if (message?.metadata?.is_visually_hidden_from_conversation) {
            return;
        }

        const contentType = message?.content?.content_type || message?.content?.contentType;
        if (contentType === 'reasoning_recap') {
            const durationMs = parseReasoningDurationMs(message);
            if (durationMs !== null) {
                const lastMessage = messages.length > 0 ? messages[messages.length - 1] : null;
                if (lastMessage && lastMessage.role === 'assistant' && lastMessage.reasoning && !lastMessage.reasoningDuration) {
                    lastMessage.reasoningDuration = durationMs;
                } else {
                    pendingReasoningDuration = durationMs;
                }
            }
            return;
        }

        if (contentType === 'thoughts') {
            const formatted = formatThoughts(message?.content?.thoughts);
            if (formatted) {
                pendingReasoning = pendingReasoning ? `${pendingReasoning}\n\n${formatted}` : formatted;
            }
            return;
        }

        if (SKIP_CONTENT_TYPES.has(contentType)) {
            return;
        }

        const { text, mediaTypes } = extractTextAndMedia(message?.content);
        const contentReferences = message?.metadata?.content_references || message?.metadata?.contentReferences || [];
        const images = extractImages(contentReferences);

        // Skip empty messages - they're placeholders in the ChatGPT tree structure
        if (!text && mediaTypes.length === 0 && images.length === 0) {
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
        let finalText = text || '';
        if (options.decodeHtmlEntities) {
            finalText = decodeHtmlEntities(finalText);
        }

        // Process citation tags into inline markdown links + collect for bottom list
        let citations = [];
        if (finalText && finalText.includes(TAG_START)) {
            const processed = processCitationTags(finalText, contentReferences);
            finalText = processed.cleanedText;
            citations = processed.citations || [];
        }

        if (mediaNote) {
            finalText = finalText ? `${finalText}\n\n${mediaNote}` : mediaNote;
        }

        const hasText = Boolean(finalText && finalText.trim().length > 0);
        const hasMedia = mediaTypes.length > 0 || images.length > 0;

        messages.push({
            role,
            content: isSystemLike ? '' : finalText,
            reasoning: isSystemLike ? finalText : (role === 'assistant' && pendingReasoning ? pendingReasoning : null),
            reasoningDuration: role === 'assistant' && pendingReasoningDuration !== null ? pendingReasoningDuration : null,
            timestamp,
            model: message?.metadata?.model_slug || message?.metadata?.model?.slug || null,
            hasMedia,
            hasText,
            citations: citations.length > 0 ? citations : null,
            images: images.length > 0 ? images : null
        });

        if (role === 'assistant' && !isSystemLike) {
            pendingReasoning = '';
            pendingReasoningDuration = null;
        }
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

registerChatHistoryImporter({
    id: 'chatgpt-json',
    label: 'ChatGPT',
    source: 'chatgpt',
    description: 'Use conversations.json from the ChatGPT export.',
    fileHint: 'conversations.json',
    accept: '.json,application/json',
    canImport: (file, sample) => isChatGptJsonFile(file, sample),
    parse: (file, options) => parseChatGptJsonFile(file, options)
});

registerChatHistoryImporter({
    id: 'chatgpt-html',
    label: 'ChatGPT (HTML export)',
    source: 'chatgpt',
    description: 'chat.html from the ChatGPT export (not yet supported).',
    fileHint: 'chat.html',
    accept: '.html,.htm,text/html',
    enabled: false,
    showInList: false,
    disabledReason: 'chat.html is not supported yet. Please upload conversations.json for text-only import.',
    canImport: (file, sample) => isChatGptHtmlFile(file, sample),
    parse: (file, options) => parseChatGptHtmlFile(file, options)
});
