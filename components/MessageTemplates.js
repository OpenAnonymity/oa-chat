/**
 * Message Templates Module
 * Provides pure HTML template functions and shared class constants for message rendering.
 * No DOM manipulation; only generates HTML strings.
 */

import { getProviderIcon } from '../services/providerIcons.js';

// Shared class constants (copied verbatim from existing markup)
const CLASSES = {
    userWrapper: 'w-full px-2 md:px-3 fade-in self-end',
    userGroup: 'group my-1 flex w-full flex-col gap-2 justify-end items-end',
    userBubble: 'py-3 px-4 font-normal message-user max-w-full',
    userContent: 'min-w-0 w-full overflow-hidden break-words',

    assistantWrapper: 'w-full px-2 md:px-3 self-start pb-3',
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
 * Builds HTML for file attachments in a message.
 * @param {Array} files - Array of file objects with name, type, size, dataUrl
 * @returns {string} HTML string for file previews
 */
function buildFileAttachments(files) {
    if (!files || files.length === 0) return '';

    const fileCards = files.map(file => {
        const isImage = file.type.startsWith('image/');
        const isPdf = file.type === 'application/pdf';
        const isAudio = file.type.startsWith('audio/');

        let preview = '';
        if (isImage && file.dataUrl) {
            preview = `
                <img src="${file.dataUrl}" class="absolute inset-0 w-full h-full object-cover" alt="${escapeHtml(file.name)}">
                <div class="absolute inset-0 bg-gradient-to-t from-black/60 to-transparent"></div>
            `;
        } else if (isPdf) {
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

        const fileSizeKB = (file.size / 1024).toFixed(1);
        const fileSize = file.size > 1024 * 1024
            ? `${(file.size / (1024 * 1024)).toFixed(1)} MB`
            : `${fileSizeKB} KB`;

        return `
            <div class="bg-background relative h-28 w-40 overflow-hidden rounded-xl border border-border shadow-md">
                ${preview}
                <div class="absolute bottom-0 left-0 right-0 p-2 ${isImage || isPdf ? 'text-white' : 'text-foreground'}">
                    <div class="text-xs font-medium truncate" title="${escapeHtml(file.name)}">
                        ${escapeHtml(file.name)}
                    </div>
                    <div class="text-xs ${isImage || isPdf ? 'text-white/80' : 'text-muted-foreground'}">
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
                <div class="${CLASSES.assistantBubble}">
                    <div class="${CLASSES.assistantContent}">
                        ${processContentWithLatex(message.content || '')}
                    </div>
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
 * @returns {string} HTML string
 */
function buildEmptyState() {
    return `
        <div class="${CLASSES.emptyStateWrapper}">
            <svg xmlns="http://www.w3.org/2000/svg" class="${CLASSES.emptyStateIcon}" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" d="M20.25 8.511c.884.284 1.5 1.128 1.5 2.097v4.286c0 1.136-.847 2.1-1.98 2.193-.34.027-.68.052-1.02.072v3.091l-3-3c-1.354 0-2.694-.055-4.02-.163a2.115 2.115 0 0 1-.825-.242m9.345-8.334a2.126 2.126 0 0 0-.476-.095 48.64 48.64 0 0 0-8.048 0c-1.131.094-1.976 1.057-1.976 2.192v4.286c0 .837.46 1.58 1.155 1.951m9.345-8.334V6.637c0-1.621-1.152-3.026-2.76-3.235A48.455 48.455 0 0 0 11.25 3c-2.115 0-4.198.137-6.24.402-1.608.209-2.76 1.614-2.76 3.235v6.226c0 1.621 1.152 3.026 2.76 3.235.577.075 1.157.14 1.74.194V21l4.155-4.155" />
            </svg>
            <p class="${CLASSES.emptyStateTitle}">Ask anonymously</p>
            <p class="${CLASSES.emptyStateSubtitle}">Type a message below to get started</p>
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
    CLASSES
};

