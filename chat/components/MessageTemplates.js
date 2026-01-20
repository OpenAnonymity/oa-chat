/**
 * Message Templates Module
 * Provides pure HTML template functions and shared class constants for message rendering.
 * No DOM manipulation; only generates HTML strings.
 */

import { getProviderIcon } from '../services/providerIcons.js';
import { extractDomain } from '../services/urlMetadata.js';
import { getFileIconSvg } from '../services/fileUtils.js';

// In-memory cache for reasoning trace expanded state (persists across session switches)
const reasoningExpandedState = new Set();

// Welcome message content configuration
// Edit this markdown string to customize the intro message shown on new chat sessions
// Supports full markdown: **bold**, *italic*, lists, links, etc.
// Title and subtitle support inline markdown - use backticks for monospace: `code`
const DEFAULT_WELCOME_CONTENT = {
    title: '`oa-fastchat`',
    subtitle: 'A minimal, fast, and anonymous chat client by The Open Anonymity Project', // Optional subtitle that appears centered below the title
    content: `
1. **Chats are end-to-end anonymous.**\\
   Every chat requests an *ephemeral and cryptographically unlinkable* access key from a random proxy (*oa-stations*) with blind-signed tokens (*inference tickets*). Because users hit different oa-stations who issue such ephemeral keys to many users, model providers only see anonymous and mixed traffic.
2. **Chat prompts and responses are *never* seen by OA infra.**\\
   Because the ephemeral key itself is unlinkably issued to *you*, your browser either talks to models on the provider *directly* via encrypted HTTPS or through an enclaved inference proxy.
   Open Anonymity simply handles the key issuance, rotation, and encrypted tunneling.
3. **Chat history is entirely local.**\\
   Because every chat takes a random anonymous path to the model, *only you* have your full chat history, [saved locally](#download-chats-link).
4. **This chat client is lightweight, fast, and disposable.**\\
    The entire client is less than 1MB. All it does is fetching ephemeral keys, sending prompts, and streaming responses on your behalf. You can (and should) <a href="javascript:void(0)" onclick="window.downloadInferenceTickets()">export</a> your tickets to make the same API calls without this client.

**The OA project is actively developed at Stanford and Michigan.** This client is currently in closed alpha and more details coming soon. We appreciate your [feedback](https://forms.gle/HEmvxnJpN1jQC7CfA)!

[12/16/2025] Various UI/UX improvements & GPT-5.2 Instant/Thinking\\
[11/26/2025] Added Claude Opus 4.5, Gemini 3 Pro, and GPT-5.1 Instant and Thinking\\
[11/25/2025] Added TLS-over-WebSocket inference proxy\\
[11/19/2025] Added prompt editing and chat branching + UI fixes
    `.trim(),
    // Future: Add diagram/image support
    // diagram: null,
};

function getWelcomeContent() {
    if (typeof window !== 'undefined' &&
        window.inferenceService &&
        typeof window.inferenceService.getWelcomeContent === 'function') {
        return window.inferenceService.getWelcomeContent();
    }
    return DEFAULT_WELCOME_CONTENT;
}

// Shared class constants (copied verbatim from existing markup)
// NOTE: Removed 'fade-in' from wrappers to prevent flash on session switch.
// Animation is added dynamically in appendMessage() for new messages only.
const CLASSES = {
    userWrapper: 'w-full px-2 md:px-3 self-end mb-2',
    userGroup: 'group my-1 flex w-full flex-col gap-2 justify-end items-end relative',
    userBubble: 'py-3 px-4 font-normal message-user max-w-full',
    userContent: 'min-w-0 w-full overflow-hidden break-words',

    assistantWrapper: 'w-full px-2 md:px-3 self-start pb-1',
    assistantGroup: 'group flex w-full flex-col items-start justify-start gap-2',
    assistantHeader: 'flex w-full items-center justify-start gap-2 group',
    assistantAvatar: 'flex items-center justify-center w-6 h-6 flex-shrink-0 rounded-full border border-border/50 shadow bg-muted',
    assistantAvatarText: 'text-xs font-semibold text-foreground',
    assistantModelName: 'text-xs text-foreground font-medium',
    assistantTime: 'text-xs text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity',
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

    // Filter out imported thumbnails - they're rendered separately
    const generatedImages = images.filter(img => img.type === 'image_url');
    if (generatedImages.length === 0) return '';

    let imagesHtml = generatedImages.map((image, index) => {
        if (image.image_url?.url) {
            const imageId = `image-${Date.now()}-${index}`;
            return `
                <div class="relative inline-block max-w-full">
                    <img
                        src="${escapeHtml(image.image_url.url)}"
                        alt="Generated image"
                        class="w-full max-w-xl max-h-96 rounded-lg border object-contain cursor-pointer hover:opacity-95 transition-opacity"
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
 * Builds HTML for imported thumbnail images (e.g., from ChatGPT exports).
 * Renders as a horizontal scrollable row of small thumbnails.
 * @param {Array} images - Array of image objects with type 'imported_thumbnail'
 * @returns {string} HTML string for thumbnail display
 */
function buildImportedThumbnails(images) {
    if (!images || images.length === 0) return '';

    const thumbnails = images.filter(img => img.type === 'imported_thumbnail');
    if (thumbnails.length === 0) return '';

    const thumbsHtml = thumbnails.map((image, index) => {
        const thumbUrl = image.thumbnail_url || image.full_url;
        const fullUrl = image.full_url || image.thumbnail_url;
        const sourceUrl = image.source_url || fullUrl;
        const title = image.title || 'Image';
        const imageId = `imported-thumb-${Date.now()}-${index}`;

        return `
            <a href="${escapeHtml(sourceUrl)}"
               target="_blank"
               rel="noopener noreferrer"
               class="imported-thumbnail-card flex-shrink-0 group"
               title="${escapeHtml(title)}">
                <img
                    src="${escapeHtml(thumbUrl)}"
                    alt="${escapeHtml(title)}"
                    class="w-32 h-24 rounded-lg border border-border object-cover bg-muted hover:opacity-90 transition-opacity"
                    data-image-id="${imageId}"
                    loading="lazy"
                    onerror="this.parentElement.style.display='none';"
                />
            </a>
        `;
    }).join('');

    return `
        <div class="imported-thumbnails-row flex gap-2 overflow-x-auto pb-2 mb-2 scrollbar-thin">
            ${thumbsHtml}
        </div>
    `;
}

/**
 * Builds HTML for file attachments in a message.
 * @param {Array} files - Array of file objects with name, type, size, dataUrl
 * @returns {string} HTML string for file previews
 */
function buildFileAttachments(files) {
    if (!files || files.length === 0) return '';

    const fileCards = files.map((file, index) => {
        const fileSizeKB = (file.size / 1024).toFixed(1);
        const fileSize = file.size > 1024 * 1024
            ? `${(file.size / (1024 * 1024)).toFixed(1)} MB`
            : `${fileSizeKB} KB`;

        const isImage = file.type.startsWith('image/');
        let iconOrPreview = '';
        let clickHandler = '';

        if (isImage && file.dataUrl) {
            const imageId = `uploaded-image-${Date.now()}-${index}`;
            iconOrPreview = `
                <img
                    src="${file.dataUrl}"
                    class="w-full h-full object-cover hover:opacity-90 transition-opacity"
                    alt="${escapeHtml(file.name)}"
                    data-image-id="${imageId}"
                >
            `;
            clickHandler = `onclick="window.expandImage('${imageId}')" style="cursor: pointer;"`;
        } else {
            const isPdf = file.type === 'application/pdf';
            const isAudio = file.type.startsWith('audio/');

            // Check if file is text-based by MIME type or common code file extensions
            const isText = file.type.startsWith('text/') ||
                          file.type.includes('json') ||
                          file.type.includes('javascript') ||
                          file.type.includes('xml') ||
                          file.type.includes('sh') ||
                          file.type.includes('yaml') ||
                          file.type.includes('toml') ||
                          // Also check by file extension for code files that might have generic MIME types
                          /\.(go|py|js|ts|jsx|tsx|java|c|cpp|h|hpp|cs|rb|php|swift|kt|rs|scala|r|m|mm|sql|sh|bash|zsh|pl|lua|vim|el|clj|ex|exs|erl|hrl|hs|lhs|ml|mli|fs|fsx|fsi|v|sv|svh|vhd|vhdl|tcl|awk|sed|diff|patch|md|markdown|rst|tex|bib|csv|tsv|txt|log|cfg|conf|ini|toml|yaml|yml|xml|html|css|scss|sass|less|json|jsonl|proto|thrift)$/i.test(file.name);

            let fileTypeForIcon = null;
            if (isPdf) fileTypeForIcon = 'pdf';
            else if (isAudio) fileTypeForIcon = 'audio';
            else if (isText) fileTypeForIcon = 'text';

            iconOrPreview = getFileIconSvg(fileTypeForIcon, file.type, 'w-6 h-6');

            // For non-images, trigger download by creating a link from dataUrl
            if (file.dataUrl) {
                clickHandler = `onclick="(function() { const a = document.createElement('a'); a.href = '${file.dataUrl}'; a.download = '${escapeHtml(file.name)}'; a.click(); })()" style="cursor: pointer;"`;
            }
        }

        return `
            <div class="file-attachment-card group relative flex items-center p-2 gap-3 rounded-xl w-auto max-w-[240px] transition-all select-none overflow-hidden shadow-sm backdrop-blur-sm" ${clickHandler}>
                <!-- Icon/Preview Container -->
                <div class="file-attachment-icon flex-shrink-0 w-10 h-10 rounded-lg overflow-hidden flex items-center justify-center shadow-sm">
                    ${iconOrPreview}
                </div>

                <!-- Text Info -->
                <div class="flex flex-col min-w-0 pr-2">
                    <span class="text-xs font-medium truncate leading-tight" title="${escapeHtml(file.name)}">
                        ${escapeHtml(file.name)}
                    </span>
                    <span class="text-[10px] opacity-70 truncate">
                        ${fileSize}
                    </span>
                </div>
            </div>
        `;
    }).join('');

    return `<div class="flex flex-wrap gap-3 mb-2">${fileCards}</div>`;
}

// Threshold for collapsing long user messages (in characters)
const USER_MESSAGE_COLLAPSE_THRESHOLD = 560;

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
                            class="edit-prompt-textarea w-full px-4 py-3 border border-border rounded-lg bg-background text-foreground resize-y focus:outline-none shadow-sm"
                            rows="3"
                            data-message-id="${message.id}"
                        >${escapeHtml(message.content)}</textarea>
                        <div class="flex items-center justify-between gap-2 mt-2">
                            <button
                                id="edit-model-picker-btn"
                                class="edit-model-picker-btn btn-ghost-hover inline-flex items-center justify-center rounded-md text-xs font-medium transition-colors focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50 border border-input h-7 px-2 gap-1.5"
                                data-message-id="${message.id}"
                                title="Select model for regeneration"
                            >
                                <!-- Content will be populated by ChatArea.updateEditModelPickerButton -->
                                <div class="flex items-center justify-center w-5 h-5 flex-shrink-0 rounded-full border border-border/50 bg-muted">
                                    <span class="text-[10px] font-semibold">...</span>
                                </div>
                                <span class="model-name-container min-w-0 truncate">Loading...</span>
                            </button>
                            <div class="flex items-center gap-2">
                                <button
                                    class="cancel-edit-btn group inline-flex items-center justify-center gap-2 rounded-md text-xs font-medium transition-colors hover-highlight text-muted-foreground hover:text-foreground px-3 py-1.5 border border-transparent"
                                    data-message-id="${message.id}"
                                >
                                    <span>Cancel</span>
                                    <kbd class="pointer-events-none inline-flex h-4 select-none items-center gap-1 rounded border border-border bg-muted px-1 font-mono text-[10px] font-medium opacity-100">Esc</kbd>
                                </button>
                                <button
                                    class="confirm-edit-btn group inline-flex items-center justify-center gap-2 rounded-md text-xs font-medium transition-colors border border-border px-3 py-1.5 shadow-sm"
                                    data-message-id="${message.id}"
                                >
                                    <span>Save</span>
                                    <span class="flex items-center gap-0.5 text-muted-foreground pointer-events-none text-xs">
                                        <span class="opacity-60">⌘</span>
                                        <span class="opacity-60">↵</span>
                                    </span>
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        `;
    }

    // Check if message is long enough to collapse
    const isLongMessage = message.content && message.content.length > USER_MESSAGE_COLLAPSE_THRESHOLD;
    const collapsibleClass = isLongMessage ? 'user-message-collapsible collapsed' : '';
    const showMoreBtn = isLongMessage ? `
        <button class="user-message-show-more" data-message-id="${message.id}">Show more</button>
    ` : '';

    // Normal display mode with action buttons (shown on hover)
    return `
        <div class="${CLASSES.userWrapper}" data-message-id="${message.id}">
            <div class="${CLASSES.userGroup}">
                <div class="${CLASSES.userBubble}">
                    <div class="${CLASSES.userContent} ${collapsibleClass}">
                        ${fileAttachments}
                        <p class="mb-0">${escapeHtml(message.content)}</p>
                    </div>
                    ${showMoreBtn}
                </div>
                <div class="message-user-actions absolute top-full right-0 mt-1 flex items-center gap-1 z-10">
                    <button
                        class="resend-prompt-btn message-action-btn flex items-center justify-center w-7 h-7 rounded-md transition-colors hover:bg-muted/80 text-muted-foreground hover:text-foreground"
                        data-message-id="${message.id}"
                        data-tooltip="Resend prompt"
                    >
                        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="w-4 h-4">
                            <path stroke-linecap="round" stroke-linejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0 3.181 3.183a8.25 8.25 0 0 0 13.803-3.7M4.031 9.865a8.25 8.25 0 0 1 13.803-3.7l3.181 3.182m0-4.991v4.99" />
                        </svg>
                    </button>
                    <button
                        class="copy-user-message-btn message-action-btn flex items-center justify-center w-7 h-7 rounded-md transition-colors hover:bg-muted/80 text-muted-foreground hover:text-foreground"
                        data-message-id="${message.id}"
                        data-tooltip="Copy prompt"
                    >
                        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="w-4 h-4">
                            <path stroke-linecap="round" stroke-linejoin="round" d="M15.666 3.888A2.25 2.25 0 0 0 13.5 2.25h-3c-1.03 0-1.9.693-2.166 1.638m7.332 0c.055.194.084.4.084.612v0a.75.75 0 0 1-.75.75H9a.75.75 0 0 1-.75-.75v0c0-.212.03-.418.084-.612m7.332 0c.646.049 1.288.11 1.927.184 1.1.128 1.907 1.077 1.907 2.185V19.5a2.25 2.25 0 0 1-2.25 2.25H6.75A2.25 2.25 0 0 1 4.5 19.5V6.257c0-1.108.806-2.057 1.907-2.185a48.208 48.208 0 0 1 1.927-.184" />
                        </svg>
                    </button>
                    <button
                        class="edit-prompt-btn message-action-btn flex items-center justify-center w-7 h-7 rounded-md transition-colors hover:bg-muted/80 text-muted-foreground hover:text-foreground"
                        data-message-id="${message.id}"
                        data-tooltip="Edit prompt"
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
 * Only uses explicit subtitle markers (## headings or **bold** text).
 * If none found, shows duration or generic completion text.
 * @param {string} reasoning - The reasoning content
 * @param {number} reasoningDuration - Duration in milliseconds (optional)
 * @returns {string} The subtitle text
 */
function generateReasoningSubtitle(reasoning, reasoningDuration) {
    // If duration is available, show timing (preferred for completed reasoning)
    if (reasoningDuration) {
        return formatReasoningDuration(reasoningDuration);
    }

    // This function is only called when NOT streaming.
    // If reasoning is empty, it means streaming was interrupted without capturing reasoning.
    if (!reasoning || reasoning.trim().length === 0) {
        return 'Reasoning incomplete';
    }

    const MAX_LENGTH = 150;
    const summaries = extractReasoningSummaries(reasoning);

    // Only use explicit subtitle markers (headings or bold text)
    // If none found, fall back to generic "Reasoning complete"
    if (summaries.length > 0) {
        const lastSummary = summaries[summaries.length - 1];
        const summaryText = lastSummary.text;

        return summaryText.length > MAX_LENGTH
            ? summaryText.substring(0, MAX_LENGTH - 3) + '...'
            : summaryText;
    }

    // No subtitle markers detected - use generic completion text
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

    // Check in-memory cache for expanded state (persists across session switches, not page reloads)
    const isExpanded = reasoningExpandedState.has(messageId);
    const contentVisibilityClass = isExpanded ? '' : 'hidden';
    const chevronRotation = isExpanded ? 'style="transform: rotate(180deg)"' : '';

    // Trim whitespace and process content appropriately
    // During streaming, reasoning will be plain text
    // After streaming, it will be processed with markdown
    const trimmedReasoning = (reasoning || '').trim();
    // Loading indicator shown at bottom of content during streaming (shimmer animation)
    const loadingIndicator = '<span class="reasoning-loading-indicator reasoning-subtitle-streaming">Thinking...</span>';
    // For streaming: show existing reasoning content (if any) PLUS loading indicator
    // This ensures switching back to a streaming session shows accumulated reasoning
    let reasoningHtml;
    if (isStreaming) {
        if (trimmedReasoning) {
            // Convert basic markdown (bold) to HTML for streaming display and add loading indicator
            const escapedReasoning = trimmedReasoning
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;');
            const withBold = escapedReasoning.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
            const lines = withBold.split('\n').map(line => `<div class="streaming-line">${line}</div>`).join('');
            reasoningHtml = lines + loadingIndicator;
        } else {
            reasoningHtml = loadingIndicator;
        }
    } else {
        reasoningHtml = processContent ? processContent(trimmedReasoning) : trimmedReasoning;
    }

    // Generate subtitle - show timing for completed reasoning, or compute from content during streaming
    // When switching back to a streaming session, compute subtitle from available reasoning content
    let subtitle;
    if (isStreaming) {
        // If we have reasoning content, try to extract a meaningful subtitle from it
        if (trimmedReasoning && trimmedReasoning.length > 20) {
            const summaries = extractReasoningSummaries(trimmedReasoning);
            if (summaries.length > 0) {
                const lastSummary = summaries[summaries.length - 1];
                subtitle = lastSummary.text.length > 150
                    ? lastSummary.text.substring(0, 147) + '...'
                    : lastSummary.text;
            } else {
                subtitle = 'Thinking...';
            }
        } else {
            subtitle = 'Thinking...';
        }
    } else {
        subtitle = generateReasoningSubtitle(reasoning, reasoningDuration);
    }

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

        // Get favicon URL from DuckDuckGo (privacy-friendly)
        const faviconUrl = `https://icons.duckduckgo.com/ip3/${domain}.ico`;

        enhancedLink.innerHTML = ` <a href="${escapeHtml(url)}"
            target="_blank"
            rel="noopener noreferrer"
            class="inline-link-button"
            data-link-id="${linkId}"
            data-url="${escapeHtml(url)}"
            data-domain="${escapeHtml(domain)}">
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
 * Builds HTML for citations toggle button with stacked source favicons.
 * @param {Array} citations - Array of citation objects
 * @param {string} messageId - The message ID for unique identification
 * @returns {string} HTML string for toggle button
 */
function buildCitationsToggleButton(citations, messageId) {
    if (!citations || citations.length === 0) return '';

    const toggleId = `citations-toggle-${messageId}`;

    // Get unique domains for favicons (max 4)
    const seenDomains = new Set();
    const uniqueFavicons = [];
    for (const c of citations) {
        const domain = extractDomain(c.url);
        if (!seenDomains.has(domain)) {
            seenDomains.add(domain);
            uniqueFavicons.push({ domain, favicon: c.favicon || `https://icons.duckduckgo.com/ip3/${domain}.ico` });
            if (uniqueFavicons.length >= 4) break;
        }
    }

    // Build stacked favicon HTML
    const faviconsHtml = uniqueFavicons.map((f, i) => `
        <img src="${escapeHtml(f.favicon)}"
             alt="${escapeHtml(f.domain)}"
             class="citations-toggle-favicon"
             style="z-index: ${uniqueFavicons.length - i};"
             onerror="this.style.display='none';" />`
    ).join('');

    return `
        <button
            class="citations-toggle-btn inline-flex items-center gap-1.5 px-2 py-1 text-left hover:bg-muted/80 rounded transition-colors"
            id="${toggleId}"
            data-message-id="${messageId}"
        >
            <span class="citations-toggle-favicons">${faviconsHtml}</span>
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

        const favicon = citation.favicon || `https://icons.duckduckgo.com/ip3/${domain}.ico`;

        // Get description/preview from content or description (enrichment), distinct from title
        let description = '';
        const rawDescription = citation.description || citation.content || '';
        if (rawDescription.trim().length > 0) {
            description = rawDescription.trim().replace(/\[\d+\]/g, '').trim();
            // Truncate description
            if (description.length > 120) {
                description = description.substring(0, 117) + '...';
            }
        }

        return `
            <a href="${escapeHtml(citation.url)}"
               target="_blank"
               rel="noopener noreferrer"
               id="citation-${messageId}-${displayIndex}"
               class="citation-card-modern group"
               data-citation-index="${displayIndex}"
               title="${escapeHtml(citation.url)}">
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
                ${description ? `<div class="citation-description">${escapeHtml(description)}</div>` : ''}
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
 * Extracts just the model name from a full "Provider: ModelName" string.
 * @param {string} fullName - Full model name (e.g., "OpenAI: GPT-5.1 Thinking")
 * @returns {string} Short model name (e.g., "GPT-5.1 Thinking")
 */
function extractShortModelName(fullName) {
    if (!fullName || typeof fullName !== 'string') return fullName;
    // Handle "Provider: ModelName" format
    const colonIdx = fullName.indexOf(': ');
    if (colonIdx !== -1) {
        return fullName.slice(colonIdx + 2);
    }
    // Handle "provider/model-id" format (e.g., "google/gemini-3-pro-preview" -> "Gemini 3 Pro Preview")
    const slashIdx = fullName.indexOf('/');
    if (slashIdx !== -1) {
        const modelPart = fullName.slice(slashIdx + 1);
        // Convert kebab-case to Title Case (e.g., "gemini-3-pro-preview" -> "Gemini 3 Pro Preview")
        return modelPart
            .split('-')
            .map(word => word.charAt(0).toUpperCase() + word.slice(1))
            .join(' ');
    }
    return fullName;
}

// Provider slug to display name mapping (module-level constant for efficiency)
const PROVIDER_SLUG_MAP = {
    'openai': 'OpenAI',
    'anthropic': 'Anthropic',
    'google': 'Google',
    'meta': 'Meta',
    'meta-llama': 'Meta',
    'mistral': 'Mistral',
    'mistralai': 'Mistral',
    'deepseek': 'DeepSeek',
    'qwen': 'Qwen',
    'alibaba': 'Qwen',
    'cohere': 'Cohere',
    'perplexity': 'Perplexity',
    'nvidia': 'Nvidia'
};

/**
 * Infers provider name from model name when models list is unavailable.
 * Uses the "Provider: Model" format, model ID format, or keyword matching as fallback.
 * @param {string} name - Model name (e.g., "OpenAI: GPT-5.1 Thinking", "openai/gpt-5.2-chat", or "GPT-4")
 * @returns {string|null} Provider name or null if unknown
 */
function inferProvider(name) {
    if (!name || typeof name !== 'string') return null;
    // Strategy 1: "Provider: Model" format (our custom names)
    const colonIdx = name.indexOf(': ');
    if (colonIdx !== -1) {
        return name.slice(0, colonIdx);
    }
    // Strategy 2: "provider/model-id" format (model IDs)
    const slashIdx = name.indexOf('/');
    if (slashIdx !== -1) {
        const provider = name.slice(0, slashIdx).toLowerCase();
        return PROVIDER_SLUG_MAP[provider] || provider.charAt(0).toUpperCase() + provider.slice(1);
    }
    // Strategy 3: Keyword matching for common model names
    const lowerName = name.toLowerCase();
    if (lowerName.includes('gpt') || lowerName.includes('o1-') || lowerName.includes('o3-') || lowerName.includes('o4-')) return 'OpenAI';
    if (lowerName.includes('claude')) return 'Anthropic';
    if (lowerName.includes('gemini')) return 'Google';
    if (lowerName.includes('llama')) return 'Meta';
    if (lowerName.includes('mistral')) return 'Mistral';
    if (lowerName.includes('deepseek')) return 'DeepSeek';
    if (lowerName.includes('qwen')) return 'Qwen';
    if (lowerName.includes('command')) return 'Cohere';
    if (lowerName.includes('sonar')) return 'Perplexity';
    if (lowerName.includes('nemotron')) return 'Nvidia';
    return null;
}

/**
 * Builds HTML for an assistant message bubble.
 * @param {Object} message - Message object
 * @param {Object} helpers - Helper functions { processContentWithLatex, formatTime }
 * @param {string} providerName - Provider name (e.g., "OpenAI", "Anthropic")
 * @param {string} modelName - Model display name
 * @param {Object} options - Template options (e.g., isSessionStreaming)
 * @returns {string} HTML string
 */
function buildAssistantMessage(message, helpers, providerName, modelName, options = {}) {
    const { processContentWithLatex, formatTime } = helpers;
    // FEATURE DISABLED: Token count display - uncomment to re-enable
    // const tokenDisplay = buildTokenDisplay(message);
    const tokenDisplay = '';
    const iconData = getProviderIcon(providerName, 'w-3.5 h-3.5');
    const bgClass = iconData.hasIcon ? 'bg-white' : 'bg-muted';
    // Use short model name for display (without provider prefix)
    const displayModelName = extractShortModelName(modelName);

    // If message is pending (waiting for first chunk), show header with typing indicator
    if (message.streamingPending) {
        return `
            <div class="${CLASSES.assistantWrapper}" data-message-id="${message.id}">
                <div class="${CLASSES.assistantGroup}">
                    <div class="${CLASSES.assistantHeader}">
                        <div class="flex items-center justify-center w-6 h-6 flex-shrink-0 rounded-full border border-border/50 shadow ${bgClass}">
                            ${iconData.html}
                        </div>
                        <span class="${CLASSES.assistantModelName}" style="font-size: 0.7rem;">${displayModelName}</span>
                        <span class="${CLASSES.assistantTime}" style="font-size: 0.7rem;">${formatTime(message.timestamp)}</span>
                    </div>
                    <div class="flex gap-1 px-4 py-2">
                        <div class="w-2 h-2 bg-muted-foreground rounded-full animate-pulse"></div>
                        <div class="w-2 h-2 bg-muted-foreground rounded-full animate-pulse" style="animation-delay: 0.2s"></div>
                        <div class="w-2 h-2 bg-muted-foreground rounded-full animate-pulse" style="animation-delay: 0.4s"></div>
                    </div>
                </div>
            </div>
        `;
    }

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

    // Build imported thumbnails (small horizontal row before text)
    const thumbnailsBubble = buildImportedThumbnails(message.images);

    // Build image bubble for generated images (large, after text)
    const generatedImagesHtml = buildGeneratedImages(message.images);
    const imageBubble = generatedImagesHtml ? `
        <div class="font-normal message-assistant-images w-full">
            ${generatedImagesHtml}
        </div>
    ` : '';

    // Check if message is complete but has no output (no text, no images)
    // This happens when provider doesn't return a response
    const hasNoOutput = !processedContent && (!message.images || message.images.length === 0);
    // Message is complete if:
    // - Not actively streaming reasoning
    // - streamingTokens is null/undefined (finalized)
    // - The session itself is not streaming (prevents false positives when switching sessions)
    const isMessageComplete = !message.streamingReasoning &&
        (message.streamingTokens === null || message.streamingTokens === undefined);
    const isSessionStreaming = options.isSessionStreaming || false;
    const noResponseNotice = (hasNoOutput && isMessageComplete && !isSessionStreaming) ? `
        <span class="text-xs text-muted-foreground opacity-70">[Model provider returned no response. Try a new prompt or a new session.]</span>
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
                    <span class="${CLASSES.assistantModelName}" style="font-size: 0.7rem;">${displayModelName}</span>
                    <span class="${CLASSES.assistantTime}" style="font-size: 0.7rem;">${formatTime(message.timestamp)}</span>
                    ${tokenDisplay}
                </div>
                ${reasoningBubble}
                ${thumbnailsBubble}
                ${textBubble}
                ${imageBubble}
                <div class="flex items-center justify-between gap-2 w-full -mt-1">
                    <div class="flex items-center gap-1">
                        <button
                            class="message-action-btn copy-message-btn flex items-center justify-center w-7 h-7 rounded-md transition-colors hover:bg-muted/80 text-muted-foreground hover:text-foreground"
                            data-message-id="${message.id}"
                            data-tooltip="Copy message">
                            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="w-4 h-4">
                                <path stroke-linecap="round" stroke-linejoin="round" d="M15.666 3.888A2.25 2.25 0 0 0 13.5 2.25h-3c-1.03 0-1.9.693-2.166 1.638m7.332 0c.055.194.084.4.084.612v0a.75.75 0 0 1-.75.75H9a.75.75 0 0 1-.75-.75v0c0-.212.03-.418.084-.612m7.332 0c.646.049 1.288.11 1.927.184 1.1.128 1.907 1.077 1.907 2.185V19.5a2.25 2.25 0 0 1-2.25 2.25H6.75A2.25 2.25 0 0 1 4.5 19.5V6.257c0-1.108.806-2.057 1.907-2.185a48.208 48.208 0 0 1 1.927-.184" />
                            </svg>
                        </button>
                        <button
                            class="message-action-btn regenerate-message-btn flex items-center justify-center w-7 h-7 rounded-md transition-colors hover:bg-muted/80 text-muted-foreground hover:text-foreground"
                            data-message-id="${message.id}"
                            data-tooltip="Regenerate response">
                            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="w-4 h-4">
                                <path stroke-linecap="round" stroke-linejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0 3.181 3.183a8.25 8.25 0 0 0 13.803-3.7M4.031 9.865a8.25 8.25 0 0 1 13.803-3.7l3.181 3.182m0-4.991v4.99" />
                            </svg>
                        </button>
                        <button
                            class="message-action-btn fork-conversation-btn flex items-center justify-center w-7 h-7 rounded-md transition-colors hover:bg-muted/80 text-muted-foreground hover:text-foreground"
                            data-message-id="${message.id}"
                            data-tooltip="Fork conversation from here">
                            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="w-4 h-4">
                                <path stroke-linecap="round" stroke-linejoin="round" d="M2 12h6c6 0 10-4 14-8m-4 0h4v4M8 12c6 0 10 4 14 8m-4 0h4v-4" />
                            </svg>
                        </button>
                        ${noResponseNotice}
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
    const welcomeContent = getWelcomeContent();
    // Parse markdown content using marked (loaded from CDN)
    const contentHtml = typeof marked !== 'undefined'
        ? marked.parse(welcomeContent.content)
        : escapeHtml(welcomeContent.content);

    // Parse title as inline markdown (for monospace/bold/italic support)
    const titleHtml = typeof marked !== 'undefined' && marked.parseInline
        ? marked.parseInline(welcomeContent.title)
        : escapeHtml(welcomeContent.title);

    // Parse optional subtitle as inline markdown
    const subtitleHtml = welcomeContent.subtitle
        ? (typeof marked !== 'undefined' && marked.parseInline
            ? marked.parseInline(welcomeContent.subtitle)
            : escapeHtml(welcomeContent.subtitle))
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
 * Builds HTML for a divider message (e.g., for forked sessions).
 * @param {Object} message - Message object with content and metadata
 * @returns {string} HTML string
 */
function buildDividerMessage(message) {
    return `
        <div class="w-full flex items-center justify-center gap-4 select-none fade-in opacity-80">
            <div class="h-px bg-muted-foreground/20 flex-1 max-w-[100px] sm:max-w-[140px]"></div>
            <div class="flex items-center gap-1 text-xs text-muted-foreground">
                <span class="opacity-70">Branched from</span>
                <button
                    onclick="window.app.switchSession('${message.forkedFromSessionId}')"
                    class="hover:text-foreground dark:hover:text-gray-200 font-medium underline underline-offset-2 transition-colors cursor-pointer"
                    title="Go back to original session"
                >
                    this past session
                </button>
            </div>
            <div class="h-px bg-muted-foreground/20 flex-1 max-w-[100px] sm:max-w-[140px]"></div>
        </div>
    `;
}

/**
 * Builds HTML for a "shared" indicator at the end of messages.
 * Shows that chat is shared up until this point.
 * @param {string} shareId - The share ID for the session
 * @returns {string} HTML string
 */
export function buildSharedIndicator() {
    return `
        <div class="w-full flex items-center justify-center gap-4 select-none fade-in opacity-80 mt-4 mb-4">
            <div class="h-px bg-primary/30 flex-1 max-w-[80px] sm:max-w-[120px]"></div>
            <div class="flex items-center gap-1.5 text-xs text-muted-foreground">
                <!-- Arrow up from box icon -->
                <svg class="w-3.5 h-3.5 text-primary flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5">
                    <path stroke-linecap="round" stroke-linejoin="round" d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5m-13.5-9L12 3m0 0 4.5 4.5M12 3v13.5" />
                </svg>
                <span><span onclick="document.getElementById('share-btn')?.click()" class="cursor-pointer hover:text-foreground transition-colors underline underline-offset-2" title="Open share settings">Shared content</span> ends here and messages below are private</span>
            </div>
            <div class="h-px bg-primary/30 flex-1 max-w-[80px] sm:max-w-[120px]"></div>
        </div>
    `;
}

/**
 * Builds HTML for an "imported" indicator showing where the shared content ends.
 * Displayed at the point where imported messages end and new messages begin.
 * @param {number} importedCount - Number of messages that were imported
 * @returns {string} HTML string
 */
export function buildImportedIndicator(importedCount) {
    return `
        <div class="w-full flex items-center justify-center gap-4 select-none fade-in opacity-80 mt-4 mb-4">
            <div class="h-px bg-muted-foreground/30 flex-1 max-w-[80px] sm:max-w-[120px]"></div>
            <div class="flex items-center gap-1.5 text-xs text-muted-foreground">
                <!-- Arrow down to box icon (imported) -->
                <svg class="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5">
                    <path stroke-linecap="round" stroke-linejoin="round" d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5M16.5 12 12 16.5m0 0L7.5 12m4.5 4.5V3" />
                </svg>
                <span>Imported content ends here and messages below are private</span>
            </div>
            <div class="h-px bg-muted-foreground/30 flex-1 max-w-[80px] sm:max-w-[120px]"></div>
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
    if (message.role === 'system' && message.type === 'divider') {
        return buildDividerMessage(message);
    } else if (message.role === 'user') {
        return buildUserMessage(message, options);
    } else {
        // Determine provider name and model name
        const defaultModelName = window.app && typeof window.app.getDefaultModelName === 'function'
            ? window.app.getDefaultModelName()
            : 'OpenAI: GPT-5.2 Instant';
        // For assistant messages, prefer the model stored on the message itself
        const storedModel = message.model || sessionModelName || defaultModelName;
        const isModelId = typeof storedModel === 'string' && storedModel.includes('/');
        const modelsArray = Array.isArray(models) ? models : [];

        // Resolve model: storedModel can be either a model ID (e.g., "openai/gpt-5.2-chat")
        // or a display name (e.g., "OpenAI: GPT-5.2 Instant"). Look up by ID first, then by name.
        // Note: O(n) lookup per message - acceptable for typical chat sizes (<100 messages)
        let modelOption = isModelId
            ? modelsArray.find(m => m.id === storedModel)
            : modelsArray.find(m => m.name === storedModel);

        // Get display name: prefer model lookup, then API display name override, then stored value
        let modelName;
        if (modelOption) {
            modelName = modelOption.name;
        } else if (isModelId && typeof openRouterAPI !== 'undefined' && openRouterAPI.getDisplayName) {
            // Try to get display name from API overrides (e.g., "openai/gpt-5.2-chat" -> "OpenAI: GPT-5.2 Instant")
            modelName = openRouterAPI.getDisplayName(storedModel, storedModel);
        } else {
            modelName = storedModel;
        }
        // Use models lookup first, then infer from name, then default to OpenAI
        const providerName = modelOption?.provider || inferProvider(modelName) || 'OpenAI';

        return buildAssistantMessage(message, helpers, providerName, modelName, options);
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
    window.MessageTemplates.insertRawCitationMarkers = insertRawCitationMarkers;
    window.MessageTemplates.addInlineCitationMarkers = addInlineCitationMarkers;
    window.MessageTemplates.enhanceInlineLinks = enhanceInlineLinks;
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
                reasoningExpandedState.add(messageId);
            } else {
                contentEl.classList.add('hidden');
                chevronEl.style.transform = 'rotate(0deg)';
                reasoningExpandedState.delete(messageId);
            }

            // Update scroll button visibility after content change
            if (window.app && window.app.updateScrollButtonVisibility) {
                window.app.updateScrollButtonVisibility();
            }
        }
    };
}
