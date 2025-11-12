/**
 * Message Templates Module
 * Provides pure HTML template functions and shared class constants for message rendering.
 * No DOM manipulation; only generates HTML strings.
 */

import { getProviderIcon } from '../services/providerIcons.js';

// Welcome message content configuration
// Edit this markdown string to customize the intro message shown on new chat sessions
// Supports full markdown: **bold**, *italic*, lists, links, etc.
// Title and subtitle support inline markdown - use backticks for monospace: `code`
const WELCOME_CONTENT = {
    title: '`oa-fastchat`',
    subtitle: 'A minimal, fast, and anonymous chat client by The Open Anonymity Project', // Optional subtitle that appears centered below the title
    content: `
How it works:
1. **Chats are end-to-end anonymous.**\\
   Every chat requests a *disposable and mathematically unlinkable* OpenRouter API key from a random proxy (*oa-stations*) with blind-signed tokens (*inference tickets*).\\
   Because users hit different oa-stations who issue such ephemeral keys to many users, OpenRouter and providers only see anonymous and mixed traffic.
2. **Chat prompts and responses *never* go through Open Anonymity.**\\
   Because the ephemeral API key itself is unlinkably issued to *you*, your browser talks to models on OpenRouter *directly* via encrypted HTTPS.
   Open Anonymity simply handles the disposable key issuance, rotation, and encrypted tunneling.
3. **Chat history is entirely local.**\\
   Because every chat takes a random anonymous path to the model, *only you* have your full chat history, [saved locally](#download-chats-link).
4. **This chat client is lightweight, fast, and disposable.**\\
    The entire client is less than 1MB. All it does is fetching API keys, sending prompts, and streaming responses on your behalf. You can (and should) <a href="javascript:void(0)" onclick="window.downloadInferenceTickets()">export</a> your tickets to make the same API calls without this client.

**The OA project is actively developed at Stanford and Michigan.** This client is currently in alpha testing and more details coming soon. We appreciate your [feedback](https://forms.gle/HEmvxnJpN1jQC7CfA)!
    `.trim(),
    // Future: Add diagram/image support
    // diagram: null,
};

// Shared class constants (copied verbatim from existing markup)
const CLASSES = {
    userWrapper: 'w-full px-2 md:px-3 fade-in self-end',
    userGroup: 'group my-1 flex w-full flex-col gap-2 justify-end items-end',
    userBubble: 'py-3 px-4 font-normal message-user max-w-full',
    userContent: 'min-w-0 w-full overflow-hidden break-words',

    assistantWrapper: 'w-full px-2 md:px-3 self-start pb-1',
    assistantGroup: 'group flex w-full flex-col items-start justify-start gap-2',
    assistantHeader: 'flex w-full items-center justify-start gap-2',
    assistantAvatar: 'flex items-center justify-center w-6 h-6 flex-shrink-0 rounded-full border border-border/50 shadow bg-muted',
    assistantAvatarText: 'text-xs font-semibold text-foreground',
    assistantModelName: 'text-xs text-foreground font-medium',
    assistantTime: 'text-xs text-muted-foreground',
    assistantTokens: 'text-xs text-muted-foreground ml-auto',
    assistantBubble: 'py-3 px-4 font-normal message-assistant w-full flex items-center',
    assistantContent: 'min-w-0 w-full overflow-hidden message-content prose',

    typingWrapper: 'w-full px-2 md:px-3 fade-in pb-4',
    typingGroup: 'flex items-center gap-4',
    typingAvatar: 'flex items-center justify-center w-6 h-6 flex-shrink-0 rounded-full border border-border/50 shadow bg-muted p-0.5',
    typingAvatarText: 'text-xs font-semibold',
    typingDots: 'flex gap-1',
    typingDot: 'w-2 h-2 bg-muted-foreground rounded-full animate-pulse',

    emptyStateWrapper: 'text-center text-muted-foreground mt-20 flex flex-col items-center',
    emptyStateIcon: 'w-16 h-16 mb-4 opacity-40',
    emptyStateTitle: 'text-lg',
    emptyStateSubtitle: 'text-sm mt-2',
};

/**
 * Escapes HTML special characters in text.
 * @param {string} text - The text to escape
 * @returns {string} HTML-safe text
 */
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

/**
 * Builds HTML for generated images in a message.
 * @param {Array} images - Array of image objects with type and image_url
 * @returns {string} HTML string for image display
 */
function buildGeneratedImages(images) {
    if (!images || images.length === 0) return '';

    let imagesHtml = images.map((image, index) => {
        if (image.type === 'image_url' && image.image_url?.url) {
            const imageId = `image-${Date.now()}-${index}`;
            return `
                <div class="relative inline-block">
                    <img
                        src="${escapeHtml(image.image_url.url)}"
                        alt="Generated image"
                        class="aspect-auto h-96 max-w-xl rounded-lg border object-cover cursor-pointer hover:opacity-95 transition-opacity"
                        data-image-id="${imageId}"
                        onclick="window.expandImage('${imageId}')"
                    />
                    <button
                        class="absolute bottom-2 right-2 inline-flex items-center justify-center whitespace-nowrap rounded-md font-medium transition-colors bg-white/90 hover:bg-white text-gray-700 shadow-lg border border-gray-200 p-1.5"
                        aria-label="Expand image"
                        onclick="event.stopPropagation(); window.expandImage('${imageId}')"
                    >
                        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="w-4 h-4">
                            <path stroke-linecap="round" stroke-linejoin="round" d="M3.75 3.75v4.5m0-4.5h4.5m-4.5 0L9 9M3.75 20.25v-4.5m0 4.5h4.5m-4.5 0L9 15M20.25 3.75h-4.5m4.5 0v4.5m0-4.5L15 9m5.25 11.25h-4.5m4.5 0v-4.5m0 4.5L15 15" />
                        </svg>
                    </button>
                </div>
            `;
        }
        return '';
    }).join('');

    return imagesHtml || '';
}

/**
 * Builds HTML for file attachments in a message.
 * @param {Array} files - Array of file objects with name, type, size, dataUrl
 * @returns {string} HTML string for file previews
 */
function buildFileAttachments(files) {
    if (!files || files.length === 0) return '';

    const fileCards = files.map((file, index) => {
        const isImage = file.type.startsWith('image/');
        const isPdf = file.type === 'application/pdf';
        const isAudio = file.type.startsWith('audio/');

        const fileSizeKB = (file.size / 1024).toFixed(1);
        const fileSize = file.size > 1024 * 1024
            ? `${(file.size / (1024 * 1024)).toFixed(1)} MB`
            : `${fileSizeKB} KB`;

        // Compact card with modal for images
        if (isImage && file.dataUrl) {
            const imageId = `uploaded-image-${Date.now()}-${index}`;
            return `
                <div class="bg-background relative h-28 w-40 overflow-hidden rounded-xl border border-border shadow-md cursor-pointer hover:shadow-lg transition-shadow" onclick="window.expandImage('${imageId}')">
                    <img src="${file.dataUrl}" class="absolute inset-0 w-full h-full object-cover" alt="${escapeHtml(file.name)}" data-image-id="${imageId}">
                    <div class="absolute inset-0 bg-gradient-to-t from-black/60 to-transparent pointer-events-none"></div>
                    <div class="absolute bottom-0 left-0 right-0 p-2 text-white pointer-events-none">
                        <div class="text-xs font-medium truncate" title="${escapeHtml(file.name)}">
                            ${escapeHtml(file.name)}
                        </div>
                        <div class="text-xs text-white/80">
                            ${fileSize}
                        </div>
                    </div>
                </div>
            `;
        }

        // Compact card for non-image files (PDF, audio, etc.)
        let preview = '';
        if (isPdf) {
            preview = `
                <div class="absolute inset-0 flex items-center justify-center bg-gradient-to-br from-red-50 to-red-100 dark:from-red-900/20 dark:to-red-800/20">
                    <div class="flex flex-col items-center justify-center text-red-600 dark:text-red-400">
                        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="w-12 h-12 mb-1">
                            <path stroke-linecap="round" stroke-linejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z" />
                        </svg>
                        <span class="text-xs font-semibold">PDF</span>
                    </div>
                </div>
                <div class="absolute inset-0 bg-gradient-to-t from-black/40 to-transparent"></div>
            `;
        } else if (isAudio) {
            preview = `
                <div class="absolute inset-0 flex items-center justify-center bg-gradient-to-br from-purple-50 to-purple-100 dark:from-purple-900/20 dark:to-purple-800/20">
                    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="w-12 h-12 text-purple-600 dark:text-purple-400">
                        <path stroke-linecap="round" stroke-linejoin="round" d="M19.114 5.636a9 9 0 0 1 0 12.728M16.463 8.288a5.25 5.25 0 0 1 0 7.424M6.75 8.25l4.72-4.72a.75.75 0 0 1 1.28.53v15.88a.75.75 0 0 1-1.28.53l-4.72-4.72H4.51c-.88 0-1.704-.507-1.938-1.354A9.009 9.009 0 0 1 2.25 12c0-.83.112-1.633.322-2.396C2.806 8.756 3.63 8.25 4.51 8.25H6.75Z" />
                    </svg>
                </div>
            `;
        }

        return `
            <div class="bg-background relative h-28 w-40 overflow-hidden rounded-xl border border-border shadow-md">
                ${preview}
                <div class="absolute bottom-0 left-0 right-0 p-2 ${isPdf ? 'text-white' : 'text-foreground'}">
                    <div class="text-xs font-medium truncate" title="${escapeHtml(file.name)}">
                        ${escapeHtml(file.name)}
                    </div>
                    <div class="text-xs ${isPdf ? 'text-white/80' : 'text-muted-foreground'}">
                        ${fileSize}
                    </div>
                </div>
            </div>
        `;
    }).join('');

    return `<div class="flex flex-wrap gap-3 mb-2">${fileCards}</div>`;
}

/**
 * Builds HTML for a user message bubble.
 * @param {Object} message - Message object with id, content, etc.
 * @returns {string} HTML string
 */
function buildUserMessage(message) {
    const fileAttachments = buildFileAttachments(message.files);

    return `
        <div class="${CLASSES.userWrapper}" data-message-id="${message.id}">
            <div class="${CLASSES.userGroup}">
                <div class="${CLASSES.userBubble}">
                    <div class="${CLASSES.userContent}">
                        ${fileAttachments}
                        <p class="mb-0">${escapeHtml(message.content)}</p>
                    </div>
                </div>
            </div>
        </div>
    `;
}

/**
 * Builds token display HTML for assistant messages.
 * @param {Object} message - Message object with tokenCount and streamingTokens
 * @returns {string} HTML string or empty string
 */
function buildTokenDisplay(message) {
    if (message.tokenCount) {
        return `<span class="${CLASSES.assistantTokens}" style="font-size: 0.7rem;">${message.tokenCount}</span>`;
    }
    if (message.streamingTokens !== null && message.streamingTokens !== undefined) {
        return `<span class="${CLASSES.assistantTokens} streaming-token-count" style="font-size: 0.7rem;">${message.streamingTokens}</span>`;
    }
    return '';
}

/**
 * Builds HTML for an assistant message bubble.
 * @param {Object} message - Message object
 * @param {Object} helpers - Helper functions { processContentWithLatex, formatTime }
 * @param {string} providerName - Provider name (e.g., "OpenAI", "Anthropic")
 * @param {string} modelName - Model display name
 * @returns {string} HTML string
 */
function buildAssistantMessage(message, helpers, providerName, modelName) {
    const { processContentWithLatex, formatTime } = helpers;
    const tokenDisplay = buildTokenDisplay(message);
    const iconData = getProviderIcon(providerName, 'w-3.5 h-3.5');
    const bgClass = iconData.hasIcon ? 'bg-white' : 'bg-muted';

    // Build text bubble if there's content
    const textBubble = message.content ? `
        <div class="${CLASSES.assistantBubble}">
            <div class="${CLASSES.assistantContent}">
                ${processContentWithLatex(message.content)}
            </div>
        </div>
    ` : '';

    // Build image bubble if there are images
    const imageBubble = (message.images && message.images.length > 0) ? `
        <div class="font-normal message-assistant-images w-full">
            ${buildGeneratedImages(message.images)}
        </div>
    ` : '';

    return `
        <div class="${CLASSES.assistantWrapper}" data-message-id="${message.id}">
            <div class="${CLASSES.assistantGroup}">
                <div class="${CLASSES.assistantHeader}">
                    <div class="flex items-center justify-center w-6 h-6 flex-shrink-0 rounded-full border border-border/50 shadow ${bgClass}">
                        ${iconData.html}
                    </div>
                    <span class="${CLASSES.assistantModelName}" style="font-size: 0.7rem;">${modelName}</span>
                    <span class="${CLASSES.assistantTime}" style="font-size: 0.7rem;">${formatTime(message.timestamp)}</span>
                    ${tokenDisplay}
                </div>
                ${textBubble}
                ${imageBubble}
                <div class="flex items-center gap-1 -mt-1">
                    <button
                        class="message-action-btn copy-message-btn flex items-center justify-center w-7 h-7 rounded-md transition-colors hover:bg-muted/80 text-muted-foreground hover:text-foreground"
                        data-message-id="${message.id}"
                        title="Copy message">
                        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="w-4 h-4">
                            <path stroke-linecap="round" stroke-linejoin="round" d="M15.666 3.888A2.25 2.25 0 0 0 13.5 2.25h-3c-1.03 0-1.9.693-2.166 1.638m7.332 0c.055.194.084.4.084.612v0a.75.75 0 0 1-.75.75H9a.75.75 0 0 1-.75-.75v0c0-.212.03-.418.084-.612m7.332 0c.646.049 1.288.11 1.927.184 1.1.128 1.907 1.077 1.907 2.185V19.5a2.25 2.25 0 0 1-2.25 2.25H6.75A2.25 2.25 0 0 1 4.5 19.5V6.257c0-1.108.806-2.057 1.907-2.185a48.208 48.208 0 0 1 1.927-.184" />
                        </svg>
                    </button>
                    <button
                        class="message-action-btn regenerate-message-btn flex items-center justify-center w-7 h-7 rounded-md transition-colors hover:bg-muted/80 text-muted-foreground hover:text-foreground"
                        data-message-id="${message.id}"
                        title="Regenerate response">
                        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="w-4 h-4">
                            <path stroke-linecap="round" stroke-linejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0 3.181 3.183a8.25 8.25 0 0 0 13.803-3.7M4.031 9.865a8.25 8.25 0 0 1 13.803-3.7l3.181 3.182m0-4.991v4.99" />
                        </svg>
                    </button>
                </div>
            </div>
        </div>
    `;
}

/**
 * Builds HTML for a typing indicator.
 * @param {string} id - Unique ID for the indicator element
 * @param {string} providerName - Provider name (e.g., "OpenAI", "Anthropic")
 * @returns {string} HTML string
 */
function buildTypingIndicator(id, providerName) {
    const iconData = getProviderIcon(providerName, 'w-3.5 h-3.5');
    const bgClass = iconData.hasIcon ? 'bg-white' : 'bg-muted';
    return `
        <div id="${id}" class="${CLASSES.typingWrapper}">
            <div class="${CLASSES.typingGroup}">
                <div class="flex items-center justify-center w-6 h-6 flex-shrink-0 rounded-full border border-border/50 shadow ${bgClass} p-0.5">
                    ${iconData.html}
                </div>
                <div class="${CLASSES.typingDots}">
                    <div class="${CLASSES.typingDot}"></div>
                    <div class="${CLASSES.typingDot}" style="animation-delay: 0.2s"></div>
                    <div class="${CLASSES.typingDot}" style="animation-delay: 0.4s"></div>
                </div>
            </div>
        </div>
    `;
}

/**
 * Builds HTML for the empty state (no messages).
 * Uses WELCOME_CONTENT configuration for customizable intro text.
 * Parses markdown content using marked.js for rich formatting support.
 * @returns {string} HTML string
 */
function buildEmptyState() {
    // Parse markdown content using marked (loaded from CDN)
    const contentHtml = typeof marked !== 'undefined'
        ? marked.parse(WELCOME_CONTENT.content)
        : escapeHtml(WELCOME_CONTENT.content);

    // Parse title as inline markdown (for monospace/bold/italic support)
    const titleHtml = typeof marked !== 'undefined' && marked.parseInline
        ? marked.parseInline(WELCOME_CONTENT.title)
        : escapeHtml(WELCOME_CONTENT.title);

    // Parse optional subtitle as inline markdown
    const subtitleHtml = WELCOME_CONTENT.subtitle
        ? (typeof marked !== 'undefined' && marked.parseInline
            ? marked.parseInline(WELCOME_CONTENT.subtitle)
            : escapeHtml(WELCOME_CONTENT.subtitle))
        : '';

    return `
        <div class="${CLASSES.emptyStateWrapper}">
            <svg xmlns="http://www.w3.org/2000/svg" class="${CLASSES.emptyStateIcon}" viewBox="0 0 24 24" fill="currentColor">
                <path d="M8.7,14.2C8,14.7,7.1,15,6.2,15H4c-0.6,0-1,0.4-1,1s0.4,1,1,1h2.2c1.3,0,2.6-0.4,3.7-1.2c0.4-0.3,0.5-1,0.2-1.4C9.7,13.9,9.1,13.8,8.7,14.2z"/>
                <path d="M13,10.7c0.3,0,0.6-0.1,0.8-0.3C14.5,9.5,15.6,9,16.8,9h0.8l-0.3,0.3c-0.4,0.4-0.4,1,0,1.4c0.2,0.2,0.5,0.3,0.7,0.3s0.5-0.1,0.7-0.3l2-2c0.1-0.1,0.2-0.2,0.2-0.3c0.1-0.2,0.1-0.5,0-0.8c-0.1-0.1-0.1-0.2-0.2-0.3l-2-2c-0.4-0.4-1-0.4-1.4,0s-0.4,1,0,1.4L17.6,7h-0.8c-1.8,0-3.4,0.8-4.6,2.1c-0.4,0.4-0.3,1,0.1,1.4C12.5,10.7,12.8,10.7,13,10.7z"/>
                <path d="M20.7,15.3l-2-2c-0.4-0.4-1-0.4-1.4,0s-0.4,1,0,1.4l0.3,0.3h-1.5c-1.6,0-2.9-0.9-3.6-2.3l-1.2-2.4C10.3,8.3,8.2,7,5.9,7H4C3.4,7,3,7.4,3,8s0.4,1,1,1h1.9c1.6,0,2.9,0.9,3.6,2.3l1.2,2.4c1,2.1,3.1,3.4,5.4,3.4h1.5l-0.3,0.3c-0.4,0.4-0.4,1,0,1.4c0.2,0.2,0.5,0.3,0.7,0.3s0.5-0.1,0.7-0.3l2-2C21.1,16.3,21.1,15.7,20.7,15.3z"/>
            </svg>
            <p class="${CLASSES.emptyStateTitle}">${titleHtml}</p>
            ${subtitleHtml ? `<p class="${CLASSES.emptyStateSubtitle}">${subtitleHtml}</p>` : ''}
            <div class="max-w-2xl px-20 mx-auto mt-4 prose prose-sm text-left" style="font-size: 0.75rem !important;">
                <style>
                    .welcome-content p,
                    .welcome-content li,
                    .welcome-content a,
                    .welcome-content strong,
                    .welcome-content em,
                    .welcome-content ol,
                    .welcome-content ul {
                        font-size: 0.75rem !important;
                    }
                    .welcome-content a {
                        text-decoration: underline;
                    }
                </style>
                <div class="welcome-content">
                    ${contentHtml}
                </div>
            </div>
        </div>
    `;
}

/**
 * Builds HTML for a single message (user or assistant).
 * @param {Object} message - Message object with role, content, etc.
 * @param {Object} helpers - Helper functions { processContentWithLatex, formatTime }
 * @param {Array} models - Array of model objects for provider lookup
 * @param {string} sessionModelName - Current session's model name
 * @returns {string} HTML string
 */
export function buildMessageHTML(message, helpers, models, sessionModelName) {
    if (message.role === 'user') {
        return buildUserMessage(message);
    } else {
        // Determine provider name and model name
        const modelName = sessionModelName || 'GPT-5 Chat';
        const model = models.find(m => m.name === modelName);
        const providerName = model ? model.provider : 'OpenAI';

        return buildAssistantMessage(message, helpers, providerName, modelName);
    }
}

export {
    buildTypingIndicator,
    buildEmptyState,
    buildGeneratedImages,
    CLASSES
};

// Make buildGeneratedImages available globally for ChatArea
if (typeof window !== 'undefined') {
    window.MessageTemplates = window.MessageTemplates || {};
    window.MessageTemplates.buildGeneratedImages = buildGeneratedImages;
}

