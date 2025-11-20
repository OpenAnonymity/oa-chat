/**
 * Message Templates Module
 * Provides pure HTML template functions and shared class constants for message rendering.
 * No DOM manipulation; only generates HTML strings.
 */

import { getProviderIcon } from '../services/providerIcons.js';
import { extractDomain } from '../services/urlMetadata.js';

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
   Every chat requests an *ephemeral and cryptographically unlinkable* OpenRouter API key from a random proxy (*oa-stations*) with blind-signed tokens (*inference tickets*). Because users hit different oa-stations who issue such ephemeral keys to many users, OpenRouter and providers only see anonymous and mixed traffic.
2. **Chat prompts and responses *never* go through Open Anonymity.**\\
   Because the ephemeral API key itself is unlinkably issued to *you*, your browser talks to models on OpenRouter *directly* via encrypted HTTPS.
   Open Anonymity simply handles the key issuance, rotation, and encrypted tunneling.
3. **Chat history is entirely local.**\\
   Because every chat takes a random anonymous path to the model, *only you* have your full chat history, [saved locally](#download-chats-link).
4. **This chat client is lightweight, fast, and disposable.**\\
    The entire client is less than 1MB. All it does is fetching API keys, sending prompts, and streaming responses on your behalf. You can (and should) <a href="javascript:void(0)" onclick="window.downloadInferenceTickets()">export</a> your tickets to make the same API calls without this client.

**The OA project is actively developed at Stanford and Michigan.** This client is currently in closed alpha and more details coming soon. We appreciate your [feedback](https://forms.gle/HEmvxnJpN1jQC7CfA)!

[11/18/2025] Added Gemini 3 Pro and GPT-5.1 Instant and Thinking
    `.trim(),
    // Future: Add diagram/image support
    // diagram: null,
};

// Shared class constants (copied verbatim from existing markup)
const CLASSES = {
    userWrapper: 'w-full px-2 md:px-3 fade-in self-end mb-2',
    userGroup: 'group my-1 flex w-full flex-col gap-2 justify-end items-end relative',
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
 * @param {Object} options - Template options
 * @param {boolean} options.isEditing - Whether this message is in edit mode
 * @returns {string} HTML string
 */
function buildUserMessage(message, options = {}) {
    const fileAttachments = buildFileAttachments(message.files);
    const { isEditing = false } = options;

    // If in edit mode, show the edit form instead of the static message
    if (isEditing) {
        return `
            <div class="${CLASSES.userWrapper}" data-message-id="${message.id}">
                <div class="${CLASSES.userGroup}">
                    <div class="edit-prompt-form w-full">
                        <textarea
                            class="edit-prompt-textarea w-full px-4 py-3 border border-border rounded-lg bg-background text-foreground resize-none focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent"
                            rows="3"
                            data-message-id="${message.id}"
                        >${escapeHtml(message.content)}</textarea>
                        <div class="flex items-center justify-between gap-2 mt-2">
                            <span class="text-xs text-muted-foreground">Press Cmd/Ctrl+Enter to submit</span>
                            <div class="flex items-center gap-2">
                                <button
                                    class="cancel-edit-btn inline-flex items-center justify-center rounded-md text-xs font-medium transition-colors hover:bg-muted text-foreground px-3 py-1.5 border border-border"
                                    data-message-id="${message.id}"
                                >
                                    Cancel
                                </button>
                                <button
                                    class="confirm-edit-btn inline-flex items-center justify-center rounded-md text-xs font-medium transition-colors bg-primary text-primary-foreground hover:bg-primary/90 px-3 py-1.5"
                                    data-message-id="${message.id}"
                                >
                                    Save & Regenerate
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        `;
    }

    // Normal display mode with action buttons (shown on hover)
    return `
        <div class="${CLASSES.userWrapper}" data-message-id="${message.id}">
            <div class="${CLASSES.userGroup}">
                <div class="${CLASSES.userBubble}">
                    <div class="${CLASSES.userContent}">
                        ${fileAttachments}
                        <p class="mb-0">${escapeHtml(message.content)}</p>
                    </div>
                </div>
                <div class="message-user-actions absolute top-full right-0 mt-1 flex items-center gap-1 z-10">
                    <button
                        class="copy-user-message-btn message-action-btn flex items-center justify-center w-7 h-7 rounded-md transition-colors hover:bg-muted/80 text-muted-foreground hover:text-foreground"
                        data-message-id="${message.id}"
                        title="Copy prompt"
                    >
                        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="w-4 h-4">
                            <path stroke-linecap="round" stroke-linejoin="round" d="M15.666 3.888A2.25 2.25 0 0 0 13.5 2.25h-3c-1.03 0-1.9.693-2.166 1.638m7.332 0c.055.194.084.4.084.612v0a.75.75 0 0 1-.75.75H9a.75.75 0 0 1-.75-.75v0c0-.212.03-.418.084-.612m7.332 0c.646.049 1.288.11 1.927.184 1.1.128 1.907 1.077 1.907 2.185V19.5a2.25 2.25 0 0 1-2.25 2.25H6.75A2.25 2.25 0 0 1 4.5 19.5V6.257c0-1.108.806-2.057 1.907-2.185a48.208 48.208 0 0 1 1.927-.184" />
                        </svg>
                    </button>
                    <button
                        class="edit-prompt-btn message-action-btn flex items-center justify-center w-7 h-7 rounded-md transition-colors hover:bg-muted/80 text-muted-foreground hover:text-foreground"
                        data-message-id="${message.id}"
                        title="Edit prompt"
                    >
                        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="w-4 h-4">
                            <path stroke-linecap="round" stroke-linejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931zm0 0L19.5 7.125M18 14v4.75A2.25 2.25 0 0115.75 21H5.25A2.25 2.25 0 013 18.75V8.25A2.25 2.25 0 015.25 6H10" />
                        </svg>
                    </button>
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
 * Extracts summaries from reasoning content (headings and bold text).
 * @param {string} reasoning - The reasoning content
 * @returns {Array} Array of summary objects
 */
function extractReasoningSummaries(reasoning) {
    if (!reasoning) return [];

    const lines = reasoning.trim().split('\n');
    const summaries = [];

    for (const line of lines) {
        const trimmedLine = line.trim();
        if (!trimmedLine) continue;

        // Check for markdown headings
        const headingMatch = trimmedLine.match(/^(#+)\s*(.+)$/);
        if (headingMatch) {
            const level = headingMatch[1].length;
            const text = headingMatch[2].trim();
            summaries.push({ type: 'heading', level, text });
            continue;
        }

        // Check for bold text (potential summary markers)
        // Match bold text that appears at the start or middle of a line
        const boldMatches = trimmedLine.matchAll(/\*\*(.+?)\*\*/g);
        for (const match of boldMatches) {
            const boldText = match[1].trim();
            // Only treat as summary if it's reasonably short and looks like a title
            if (boldText.length > 5 && boldText.length < 100 && !boldText.includes('.')) {
                summaries.push({ type: 'bold', text: boldText });
            }
        }
    }

    return summaries;
}

/**
 * Formats a duration in milliseconds to a human-readable string.
 * @param {number} durationMs - Duration in milliseconds
 * @returns {string} Formatted duration string
 */
function formatReasoningDuration(durationMs) {
    if (!durationMs) return '';

    const seconds = Math.round(durationMs / 1000);

    if (seconds < 60) {
        return `Thought for ${seconds}s`;
    } else {
        const minutes = Math.floor(seconds / 60);
        const remainingSeconds = seconds % 60;
        if (remainingSeconds === 0) {
            return `Thought for ${minutes}m`;
        }
        return `Thought for ${minutes}m ${remainingSeconds}s`;
    }
}

/**
 * Generates a subtitle for reasoning content.
 * @param {string} reasoning - The reasoning content
 * @param {number} reasoningDuration - Duration in milliseconds (optional)
 * @returns {string} The subtitle text
 */
function generateReasoningSubtitle(reasoning, reasoningDuration) {
    // If duration is available, show timing
    if (reasoningDuration) {
        return formatReasoningDuration(reasoningDuration);
    }

    if (!reasoning || reasoning.trim().length === 0) {
        return 'Thinking...';
    }

    const MAX_LENGTH = 150;
    const summaries = extractReasoningSummaries(reasoning);

    // If we have summaries, use ONLY the last one (current step)
    if (summaries.length > 0) {
        const lastSummary = summaries[summaries.length - 1];
        const summaryText = lastSummary.text;

        return summaryText.length > MAX_LENGTH
            ? summaryText.substring(0, MAX_LENGTH - 3) + '...'
            : summaryText;
    }

    // Fallback: look for the last substantial line that isn't too detailed
    const lines = reasoning.trim().split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i].trim();
        if (!line) continue;

        // Skip lines that look like detailed explanations
        if (line.includes('I see that') ||
            line.includes('I think') ||
            line.includes('I should') ||
            line.includes('I might') ||
            line.length > 200) {
            continue;
        }

        // Use this line if it's a reasonable length
        if (line.length > 10 && line.length < 150) {
            return line.length > MAX_LENGTH
                ? line.substring(0, MAX_LENGTH - 3) + '...'
                : line;
        }
    }

    // Final fallback
    const lastLine = lines[lines.length - 1].trim();
    if (lastLine) {
        return lastLine.length > MAX_LENGTH
            ? lastLine.substring(0, MAX_LENGTH - 3) + '...'
            : lastLine;
    }

    return 'Reasoning complete';
}

/**
 * Builds HTML for a reasoning trace display (for thinking models like o1, o4).
 * @param {string} reasoning - The reasoning content
 * @param {string} messageId - The message ID for unique identification
 * @param {boolean} isStreaming - Whether reasoning is currently streaming
 * @param {function} processContent - Function to process and render reasoning content as HTML
 * @param {number} reasoningDuration - Duration in milliseconds (optional)
 * @returns {string} HTML string or empty string
 */
function buildReasoningTrace(reasoning, messageId, isStreaming = false, processContent, reasoningDuration) {
    if (!reasoning && !isStreaming) return '';

    const reasoningId = `reasoning-${messageId}`;
    const contentId = `reasoning-content-${messageId}`;
    const toggleId = `reasoning-toggle-${messageId}`;
    const subtitleId = `reasoning-subtitle-${messageId}`;

    const contentVisibilityClass = 'hidden';
    const chevronRotation = '';

    // Trim whitespace and process content appropriately
    // During streaming, reasoning will be plain text
    // After streaming, it will be processed with markdown
    const trimmedReasoning = (reasoning || '').trim();
    // For streaming, start with empty content (will be filled as plain text by ChatArea updates)
    const reasoningHtml = isStreaming
        ? ''
        : (processContent ? processContent(trimmedReasoning) : trimmedReasoning);

    // Generate subtitle - show timing for completed reasoning, summary during streaming
    const subtitle = isStreaming ? 'Thinking...' : generateReasoningSubtitle(reasoning, reasoningDuration);

    // Full-width during streaming to show more subtitle, compact when finished
    const buttonWidthClass = isStreaming ? 'w-full' : '';
    const buttonFlexClass = isStreaming ? 'flex' : 'inline-flex';
    const spanFlexClass = isStreaming ? 'flex-1 truncate' : '';
    const spanAnimationClass = isStreaming ? 'reasoning-subtitle-streaming' : '';
    const contentStreamingClass = isStreaming ? 'streaming' : '';

    return `
        <div class="reasoning-trace w-full" id="${reasoningId}">
            <button
                class="reasoning-toggle ${buttonFlexClass} items-center gap-2 ${buttonWidthClass} px-2 py-1 text-left hover:bg-slate-2 rounded transition-colors"
                id="${toggleId}"
                onclick="window.toggleReasoning('${messageId}')"
            >
                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="w-3.5 h-3.5 text-muted-foreground flex-shrink-0">
                    <path stroke-linecap="round" stroke-linejoin="round" d="M9.813 15.904 9 18.75l-.813-2.846a4.5 4.5 0 0 0-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 0 0 3.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 0 0 3.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 0 0-3.09 3.09ZM18.259 8.715 18 9.75l-.259-1.035a3.375 3.375 0 0 0-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 0 0 2.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 0 0 2.456 2.456L21.75 6l-1.035.259a3.375 3.375 0 0 0-2.456 2.456ZM16.894 20.567 16.5 21.75l-.394-1.183a2.25 2.25 0 0 0-1.423-1.423L13.5 18.75l1.183-.394a2.25 2.25 0 0 0 1.423-1.423l.394-1.183.394 1.183a2.25 2.25 0 0 0 1.423 1.423l1.183.394-1.183.394a2.25 2.25 0 0 0-1.423 1.423Z" />
                </svg>
                <span id="${subtitleId}" class="text-xs text-muted-foreground ${spanFlexClass} ${spanAnimationClass}">${subtitle}</span>
                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="w-3.5 h-3.5 text-muted-foreground reasoning-chevron transition-transform flex-shrink-0" ${chevronRotation}>
                    <path stroke-linecap="round" stroke-linejoin="round" d="m19.5 8.25-7.5 7.5-7.5-7.5" />
                </svg>
            </button>
            <div class="reasoning-content ${contentStreamingClass} ${contentVisibilityClass} text-xs text-muted-foreground overflow-auto max-h-96" id="${contentId}">${reasoningHtml}</div>
        </div>
    `;
}


/**
 * Inserts plain text citation markers [1], [2] into raw content at specified positions.
 * This should be called BEFORE HTML/Markdown processing.
 * @param {string} content - The raw message content
 * @param {Array} citations - Array of citation objects with startIndex/endIndex
 * @returns {string} Content with [1], [2] markers inserted
 */
function insertRawCitationMarkers(content, citations) {
    if (!content || !citations || citations.length === 0) return content;

    // Filter citations that have valid text ranges
    const citationsWithRanges = citations.filter(c =>
        c.startIndex !== null &&
        c.endIndex !== null &&
        c.startIndex >= 0 &&
        c.endIndex <= content.length
    );

    if (citationsWithRanges.length === 0) return content;

    // Sort by startIndex in reverse order to avoid offset issues
    const sortedCitations = [...citationsWithRanges].sort((a, b) => b.startIndex - a.startIndex);

    let markedContent = content;
    sortedCitations.forEach(citation => {
        // Insert plain text marker [1], [2], etc.
        const marker = `[${citation.index}]`;
        markedContent = markedContent.slice(0, citation.endIndex) +
                       marker +
                       markedContent.slice(citation.endIndex);
    });

    return markedContent;
}

/**
 * Converts citation markers like [1], [2] into styled, clickable elements.
 * This should be called AFTER HTML/Markdown processing.
 * @param {string} content - The HTML-processed message content
 * @param {string} messageId - The message ID
 * @returns {string} Content with styled citation markers
 */
function addInlineCitationMarkers(content, messageId) {
    if (!content) return content;

    // Replace citation markers [1], [2], etc. with styled spans
    return content.replace(/\[(\d+)\]/g, (match, num) => {
        return `<sup class="inline-citation" data-citation="${num}" data-message-id="${messageId}" title="View source ${num}">[${num}]</sup>`;
    });
}


/**
 * Transforms regular anchor links into elegant button-style citations with hover previews.
 * This should be called AFTER HTML/Markdown processing.
 * @param {string} content - The HTML-processed message content
 * @param {string} messageId - The message ID for unique identification
 * @returns {string} Content with enhanced inline links
 */
function enhanceInlineLinks(content, messageId) {
    if (!content) return content;

    // Parse HTML to find all <a> tags
    const parser = new DOMParser();
    const doc = parser.parseFromString(content, 'text/html');
    const links = doc.querySelectorAll('a[href]');

    if (links.length === 0) return content;

    // Transform each link
    links.forEach((link, index) => {
        const url = link.href;
        const originalText = link.textContent;
        const domain = extractDomain(url);

        // Skip javascript: and internal links
        if (url.startsWith('javascript:') || url.startsWith('#')) {
            return;
        }

        // Check for surrounding parentheses and remove them
        const prevSibling = link.previousSibling;
        const nextSibling = link.nextSibling;

        if (prevSibling && prevSibling.nodeType === Node.TEXT_NODE &&
            prevSibling.textContent.endsWith('(')) {
            prevSibling.textContent = prevSibling.textContent.slice(0, -1);
        }

        if (nextSibling && nextSibling.nodeType === Node.TEXT_NODE &&
            nextSibling.textContent.startsWith(')')) {
            nextSibling.textContent = nextSibling.textContent.slice(1);
        }

        // Create the enhanced link button with space before
        const linkId = `inline-link-${messageId}-${index}`;
        const enhancedLink = doc.createElement('span');
        enhancedLink.className = 'inline-link-citation';

        // Get favicon URL
        const faviconUrl = `https://www.google.com/s2/favicons?domain=${domain}&sz=16`;

        enhancedLink.innerHTML = ` <a href="${escapeHtml(url)}"
            target="_blank"
            rel="noopener noreferrer"
            class="inline-link-button"
            data-link-id="${linkId}"
            data-url="${escapeHtml(url)}"
            data-domain="${escapeHtml(domain)}"
            title="${escapeHtml(originalText || domain)}">
            <img class="inline-link-icon"
                 src="${escapeHtml(faviconUrl)}"
                 alt="${escapeHtml(domain)}"
                 onerror="this.style.display='none'; this.nextElementSibling.style.display='inline-block';" />
            <svg class="inline-link-icon-fallback" style="display: none;" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" d="M13.19 8.688a4.5 4.5 0 0 1 1.242 7.244l-4.5 4.5a4.5 4.5 0 0 1-6.364-6.364l1.757-1.757m13.35-.622 1.757-1.757a4.5 4.5 0 0 0-6.364-6.364l-4.5 4.5a4.5 4.5 0 0 0 1.242 7.244" />
            </svg>
            <span class="inline-link-domain">${escapeHtml(domain)}</span>
        </a>`;

        // Replace the original link
        link.parentNode.replaceChild(enhancedLink, link);
    });

    return doc.body.innerHTML;
}

/**
 * Builds HTML for citations toggle button.
 * @param {Array} citations - Array of citation objects
 * @param {string} messageId - The message ID for unique identification
 * @returns {string} HTML string for toggle button
 */
function buildCitationsToggleButton(citations, messageId) {
    if (!citations || citations.length === 0) return '';

    const toggleId = `citations-toggle-${messageId}`;

    return `
        <button
            class="citations-toggle-btn inline-flex items-center gap-2 px-2 py-1 text-left hover:bg-muted/80 rounded transition-colors"
            id="${toggleId}"
            data-message-id="${messageId}"
        >
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="w-4 h-4 text-muted-foreground">
                <path stroke-linecap="round" stroke-linejoin="round" d="M12 21a9.004 9.004 0 0 0 8.716-6.747M12 21a9.004 9.004 0 0 1-8.716-6.747M12 21c2.485 0 4.5-4.03 4.5-9S14.485 3 12 3m0 18c-2.485 0-4.5-4.03-4.5-9S9.515 3 12 3m0 0a8.997 8.997 0 0 1 7.843 4.582M12 3a8.997 8.997 0 0 0-7.843 4.582m15.686 0A11.953 11.953 0 0 1 12 10.5c-2.998 0-5.74-1.1-7.843-2.918m15.686 0A8.959 8.959 0 0 1 21 12c0 .778-.099 1.533-.284 2.253m0 0A17.919 17.919 0 0 1 12 16.5c-3.162 0-6.133-.815-8.716-2.247m0 0A9.015 9.015 0 0 1 3 12c0-1.605.42-3.113 1.157-4.418" />
            </svg>
            <span class="text-xs text-muted-foreground font-medium">${citations.length} source${citations.length > 1 ? 's' : ''}</span>
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="w-3.5 h-3.5 text-muted-foreground citations-chevron transition-transform flex-shrink-0">
                <path stroke-linecap="round" stroke-linejoin="round" d="m19.5 8.25-7.5 7.5-7.5-7.5" />
            </svg>
        </button>
    `;
}

/**
 * Builds HTML for web search citations carousel.
 * @param {Array} citations - Array of citation objects with url, title, description, favicon, index
 * @param {string} messageId - The message ID for unique identification
 * @returns {string} HTML string or empty string
 */
function buildCitationsSection(citations, messageId) {
    if (!citations || citations.length === 0) return '';

    const citationsId = `citations-${messageId}`;

    // Build modern horizontal citation cards with proper metadata
    const citationCards = citations.map((citation, idx) => {
        const displayIndex = idx + 1;
        const domain = citation.domain || extractDomain(citation.url);

        // Use actual title from annotations or metadata
        let title = citation.title;

        // Clean up title - remove "Page not found", empty strings, etc.
        if (title && (title.toLowerCase().includes('page not found') ||
                     title.toLowerCase().includes('404') ||
                     title.toLowerCase().includes('error') ||
                     title.trim().length < 3)) {
            title = null;
        }

        // If no title or title is just the domain/URL, create a descriptive title
        if (!title || title === domain || title === citation.url || title.toLowerCase() === domain.toLowerCase()) {
            // If we have content snippet, use first part of it
            if (citation.content && citation.content.trim().length > 10) {
                // Clean up content and use as title
                let contentTitle = citation.content.trim();
                // Remove citation markers [1], [2], etc.
                contentTitle = contentTitle.replace(/\[\d+\]/g, '').trim();
                // Take first sentence or 60 chars
                const firstSentence = contentTitle.match(/^[^.!?]+[.!?]?/);
                title = firstSentence ? firstSentence[0] : contentTitle.substring(0, 60);
                if (contentTitle.length > 60 && !firstSentence) {
                    title += '...';
                }
            } else {
                // Last resort - use domain name with proper formatting
                title = domain.charAt(0).toUpperCase() + domain.slice(1);
            }
        }

        const favicon = citation.favicon || `https://www.google.com/s2/favicons?domain=${domain}&sz=64`;

        return `
            <a href="${escapeHtml(citation.url)}"
               target="_blank"
               rel="noopener noreferrer"
               id="citation-${messageId}-${displayIndex}"
               class="citation-card-modern group"
               data-citation-index="${displayIndex}"
               title="View source">
                <div class="citation-card-header">
                    <img src="${escapeHtml(favicon)}"
                         alt="${escapeHtml(domain)}"
                         class="citation-favicon"
                         loading="lazy"
                         onerror="this.style.display='none'; this.nextElementSibling.style.display='flex';" />
                    <div class="citation-favicon-fallback">
                        ${displayIndex}
                    </div>
                    <span class="citation-domain">${escapeHtml(domain)}</span>
                </div>
                <div class="citation-title">
                    ${escapeHtml(title.substring(0, 80))}${title.length > 80 ? '...' : ''}
                </div>
                <div class="citation-number">
                    ${displayIndex}
                </div>
            </a>
        `;
    }).join('');

    return `
        <div class="citations-section w-full" id="${citationsId}">
            <div class="citations-carousel hidden" id="citations-content-${messageId}">
                ${citationCards}
            </div>
        </div>
    `;
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

    // Build reasoning trace if present
    const reasoningBubble = buildReasoningTrace(
        message.reasoning,
        message.id,
        message.streamingReasoning || false,
        processContentWithLatex,
        message.reasoningDuration
    );

    // Build text bubble if there's content
    let processedContent = message.content;
    if (processedContent) {
        // First insert raw citation markers [1], [2] at correct positions (before HTML processing)
        if (message.citations && message.citations.length > 0) {
            processedContent = insertRawCitationMarkers(processedContent, message.citations);
        }

        // Then process with LaTeX/Markdown
        processedContent = processContentWithLatex(processedContent);

        // Style the citation markers [1], [2] into clickable elements
        if (message.citations && message.citations.length > 0) {
            processedContent = addInlineCitationMarkers(processedContent, message.id);
        }

        // Finally, enhance inline links into elegant button-style citations
        processedContent = enhanceInlineLinks(processedContent, message.id);
    }

    const textBubble = processedContent ? `
        <div class="${CLASSES.assistantBubble}">
            <div class="${CLASSES.assistantContent}">
                ${processedContent}
            </div>
        </div>
    ` : '';

    // Build image bubble if there are images
    const imageBubble = (message.images && message.images.length > 0) ? `
        <div class="font-normal message-assistant-images w-full">
            ${buildGeneratedImages(message.images)}
        </div>
    ` : '';

    // Build citations section if there are citations
    const citationsBubble = buildCitationsSection(message.citations, message.id);

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
                ${reasoningBubble}
                ${textBubble}
                ${imageBubble}
                <div class="flex items-center justify-between gap-2 w-full -mt-1">
                    <div class="flex items-center gap-1">
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
                        <button
                            class="message-action-btn fork-conversation-btn flex items-center justify-center w-7 h-7 rounded-md transition-colors hover:bg-muted/80 text-muted-foreground hover:text-foreground"
                            data-message-id="${message.id}"
                            title="Fork conversation from here">
                            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="w-4 h-4">
                                <path stroke-linecap="round" stroke-linejoin="round" d="M7.5 21L3 16.5m0 0L7.5 12M3 16.5h13.5m0-13.5L21 7.5m0 0L16.5 12M21 7.5H7.5" />
                            </svg>
                        </button>
                    </div>
                    ${buildCitationsToggleButton(message.citations, message.id)}
                </div>
                ${citationsBubble}
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
 * @param {Object} options - Template options (e.g., isEditing for user messages)
 * @returns {string} HTML string
 */
export function buildMessageHTML(message, helpers, models, sessionModelName, options = {}) {
    if (message.role === 'user') {
        return buildUserMessage(message, options);
    } else {
        // Determine provider name and model name
        const modelName = sessionModelName || 'OpenAI: GPT-5.1 Instant';
        const modelOption = models.find(m => m.name === modelName);
        const providerName = modelOption ? modelOption.provider : 'OpenAI';

        return buildAssistantMessage(message, helpers, providerName, modelName);
    }
}

export {
    buildTypingIndicator,
    buildEmptyState,
    buildGeneratedImages,
    buildReasoningTrace,
    buildCitationsSection,
    buildCitationsToggleButton,
    CLASSES
};

// Make functions available globally for ChatArea and reasoning toggle
if (typeof window !== 'undefined') {
    window.MessageTemplates = window.MessageTemplates || {};
    window.MessageTemplates.buildGeneratedImages = buildGeneratedImages;
    window.MessageTemplates.buildReasoningTrace = buildReasoningTrace;
    window.MessageTemplates.buildCitationsSection = buildCitationsSection;
    window.MessageTemplates.buildCitationsToggleButton = buildCitationsToggleButton;
    window.buildMessageHTML = buildMessageHTML; // Make buildMessageHTML globally available

    // Global function to toggle reasoning trace visibility
    window.toggleReasoning = function(messageId) {
        const contentEl = document.getElementById(`reasoning-content-${messageId}`);
        const chevronEl = document.querySelector(`#reasoning-toggle-${messageId} .reasoning-chevron`);

        if (contentEl && chevronEl) {
            const isHidden = contentEl.classList.contains('hidden');
            if (isHidden) {
                contentEl.classList.remove('hidden');
                chevronEl.style.transform = 'rotate(180deg)';
            } else {
                contentEl.classList.add('hidden');
                chevronEl.style.transform = 'rotate(0deg)';
            }

            // Update scroll button visibility after content change
            if (window.app && window.app.updateScrollButtonVisibility) {
                window.app.updateScrollButtonVisibility();
            }
        }
    };
}

