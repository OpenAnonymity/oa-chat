/**
 * ChatArea Component
 * Manages the main chat messages area including rendering messages,
 * scroll behaviors, and LaTeX rendering.
 */

import { buildMessageHTML, buildEmptyState } from './MessageTemplates.js';
import { downloadAllChats } from '../services/fileUtils.js';
import { parseStreamingReasoningContent, parseReasoningContent } from '../services/reasoningParser.js';

export default class ChatArea {
    /**
     * @param {Object} app - Reference to the main ChatApp instance
     */
    constructor(app) {
        this.app = app;
        this.setupEventListeners();
    }

    /**
     * Sets up event listeners for message actions (copy, regenerate)
     * Uses event delegation for dynamically added messages
     */
    setupEventListeners() {
        const messagesContainer = this.app.elements.messagesContainer;

        // Event delegation for copy button
        messagesContainer.addEventListener('click', async (e) => {
            const copyBtn = e.target.closest('.copy-message-btn');
            if (copyBtn) {
                const messageId = copyBtn.dataset.messageId;
                await this.handleCopyMessage(messageId);
            }

            const regenerateBtn = e.target.closest('.regenerate-message-btn');
            if (regenerateBtn) {
                const messageId = regenerateBtn.dataset.messageId;
                await this.handleRegenerateMessage(messageId);
            }
        });
    }

    /**
     * Handles copying the raw markdown/latex content of a message
     * @param {string} messageId - The message ID to copy
     */
    async handleCopyMessage(messageId) {
        const session = this.app.getCurrentSession();
        if (!session) return;

        const messages = await chatDB.getSessionMessages(session.id);
        const message = messages.find(m => m.id === messageId);

        if (message && message.content) {
            try {
                await navigator.clipboard.writeText(message.content);
                // Show brief visual feedback with icon change
                const btn = document.querySelector(`.copy-message-btn[data-message-id="${messageId}"]`);
                if (btn) {
                    const originalTitle = btn.title;
                    const svg = btn.querySelector('svg');
                    const originalSvgContent = svg.innerHTML;

                    // Replace with checkmark icon
                    svg.innerHTML = '<path stroke-linecap="round" stroke-linejoin="round" d="M4.5 12.75l6 6 9-13.5" />';
                    btn.title = 'Copied!';
                    btn.classList.add('text-green-600');

                    setTimeout(() => {
                        // Restore original icon
                        svg.innerHTML = originalSvgContent;
                        btn.title = originalTitle;
                        btn.classList.remove('text-green-600');
                    }, 2000);
                }
            } catch (error) {
                console.error('Failed to copy message:', error);
            }
        }
    }

    /**
     * Handles regenerating an assistant message
     * @param {string} messageId - The assistant message ID to regenerate
     */
    async handleRegenerateMessage(messageId) {
        const session = this.app.getCurrentSession();
        if (!session) return;

        // Check if currently streaming
        if (this.app.isCurrentSessionStreaming()) {
            return;
        }

        const messages = await chatDB.getSessionMessages(session.id);
        const messageIndex = messages.findIndex(m => m.id === messageId);

        if (messageIndex === -1 || messages[messageIndex].role !== 'assistant') {
            return;
        }

        // Find the previous user message
        const userMessage = messageIndex > 0 ? messages[messageIndex - 1] : null;
        if (!userMessage || userMessage.role !== 'user') {
            return;
        }

        // Delete the assistant message and all messages after it
        const messagesToDelete = messages.slice(messageIndex);
        for (const msg of messagesToDelete) {
            await chatDB.deleteMessage(msg.id);
        }

        // Re-render messages to remove deleted messages from UI
        await this.render();

        // Trigger regeneration by calling the app's regenerateResponse method
        await this.app.regenerateResponse();
    }

    /**
     * Renders all messages for the current session.
     * Handles empty states, message rendering, LaTeX processing, and scroll behavior.
     */
    async render() {
        const session = this.app.getCurrentSession();
        const messagesContainer = this.app.elements.messagesContainer;

        if (!session) {
            messagesContainer.innerHTML = buildEmptyState();
            this.attachDownloadHandler();
            return;
        }

        // Load messages from IndexedDB
        const messages = await chatDB.getSessionMessages(session.id);

        if (messages.length === 0) {
            messagesContainer.innerHTML = buildEmptyState();
            this.attachDownloadHandler();
            return;
        }

        // Build HTML for all messages using shared templates
        const helpers = {
            processContentWithLatex: this.app.processContentWithLatex.bind(this.app),
            formatTime: this.app.formatTime.bind(this.app)
        };

        messagesContainer.innerHTML = messages.map(message =>
            buildMessageHTML(message, helpers, this.app.state.models, session.model)
        ).join('');

        // Render LaTeX in all message content elements
        this.renderLatex();

        // Scroll to bottom after rendering
        this.scrollToBottom(true);
        
        // Defer button visibility check to allow DOM to settle after render
        requestAnimationFrame(() => {
            this.app.updateScrollButtonVisibility();
        });

        // Update message navigation if it exists
        if (this.app.messageNavigation) {
            this.app.messageNavigation.update();
        }
    }

    /**
     * Applies KaTeX rendering to all message content elements.
     */
    renderLatex() {
        if (typeof renderMathInElement !== 'undefined') {
            document.querySelectorAll('.message-content').forEach(el => {
                renderMathInElement(el, {
                    delimiters: [
                        {left: '$$', right: '$$', display: true},
                        {left: '\\[', right: '\\]', display: true},
                        {left: '\\(', right: '\\)', display: false},
                        {left: '$', right: '$', display: false}
                    ],
                    throwOnError: false
                });
            });
        }
    }

    /**
     * Scrolls the chat area to the bottom.
     * Uses requestAnimationFrame to ensure rendering is complete.
     */
    scrollToBottom(force = false) {
        if (!force && this.app.isAutoScrollPaused) {
            return;
        }
        requestAnimationFrame(() => {
            const chatArea = this.app.elements.chatArea;
            if (chatArea) {
                chatArea.scrollTop = chatArea.scrollHeight;
            }
        });
    }

    /**
     * Updates a specific message's content in real-time (for streaming).
     * @param {string} messageId - The message ID to update
     * @param {string} content - New content to display
     */
    updateStreamingMessage(messageId, content) {
        const messageEl = document.querySelector(`[data-message-id="${messageId}"]`);
        if (messageEl) {
            const contentEl = messageEl.querySelector('.message-content');
            if (contentEl) {
                // Use the app's LaTeX-safe processor
                contentEl.innerHTML = this.app.processContentWithLatex(content);
                // Re-render LaTeX for the updated content
                if (typeof renderMathInElement !== 'undefined') {
                    renderMathInElement(contentEl, {
                        delimiters: [
                            {left: '$$', right: '$$', display: true},
                            {left: '\\[', right: '\\]', display: true},
                            {left: '\\(', right: '\\)', display: false},
                            {left: '$', right: '$', display: false}
                        ],
                        throwOnError: false
                    });
                }
            }
        }
    }

    /**
     * Updates the streaming token count display for a message.
     * @param {string} messageId - The message ID
     * @param {number} tokenCount - Token count to display
     */
    updateStreamingTokens(messageId, tokenCount) {
        const messageEl = document.querySelector(`[data-message-id="${messageId}"]`);
        if (messageEl) {
            const tokenEl = messageEl.querySelector('.streaming-token-count');
            if (tokenEl) {
                tokenEl.textContent = tokenCount;
            }
        }
    }

    /**
     * Updates the reasoning trace content during streaming.
     * @param {string} messageId - The message ID
     * @param {string} reasoning - The reasoning content
     */
    updateStreamingReasoning(messageId, reasoning) {
        const reasoningContentEl = document.getElementById(`reasoning-content-${messageId}`);
        if (reasoningContentEl) {
            // Ensure streaming whitespace behavior while streaming
            if (!reasoningContentEl.classList.contains('streaming')) {
                reasoningContentEl.classList.add('streaming');
            }
            // Parse the reasoning content to fix formatting issues from the provider
            const parsedReasoning = parseStreamingReasoningContent(reasoning);

            // During streaming, use plain text to avoid expensive markdown processing
            // Markdown will be applied when streaming completes
            reasoningContentEl.textContent = parsedReasoning;
        }

        // Update the subtitle with the last meaningful line and ensure animation is active
        const subtitleEl = document.getElementById(`reasoning-subtitle-${messageId}`);
        if (subtitleEl) {
            const subtitle = this.extractReasoningSubtitle(reasoning);
            subtitleEl.textContent = subtitle;
            // Ensure streaming animation class is present
            if (!subtitleEl.classList.contains('reasoning-subtitle-streaming')) {
                subtitleEl.classList.add('reasoning-subtitle-streaming');
            }
        }

        // Update scroll button visibility based on content overflow
        this.app.updateScrollButtonVisibility();
    }

    /**
     * Parses reasoning content to extract structure (headings, summaries, bold text).
     * @param {string} reasoning - The reasoning content
     * @returns {Object} Parsed structure with summaries array and sections
     */
    parseReasoningStructure(reasoning) {
        if (!reasoning) return { summaries: [], sections: [] };

        const lines = reasoning.trim().split('\n');
        const summaries = [];
        const sections = [];
        let currentSection = null;

        for (const line of lines) {
            const trimmedLine = line.trim();
            if (!trimmedLine) continue;

            // Check for markdown headings
            const headingMatch = trimmedLine.match(/^(#+)\s*(.+)$/);
            if (headingMatch) {
                const level = headingMatch[1].length;
                const text = headingMatch[2].trim();
                summaries.push({ type: 'heading', level, text });

                // Start a new section
                if (currentSection) sections.push(currentSection);
                currentSection = { heading: text, level, content: [] };
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

            // Add line to current section
            if (currentSection) {
                currentSection.content.push(trimmedLine);
            }
        }

        if (currentSection) sections.push(currentSection);

        return { summaries, sections };
    }

    /**
     * Extracts a meaningful subtitle from reasoning content.
     * Shows only the latest/current step, not all steps combined.
     * @param {string} reasoning - The reasoning content
     * @returns {string} The subtitle text
     */
    extractReasoningSubtitle(reasoning) {
        if (!reasoning || reasoning.trim().length === 0) {
            return 'Thinking...';
        }

        const MAX_LENGTH = 150;
        const structure = this.parseReasoningStructure(reasoning);

        // If we have summaries, use ONLY the last one (current step)
        if (structure.summaries.length > 0) {
            const lastSummary = structure.summaries[structure.summaries.length - 1];
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

            // Skip lines that look like detailed explanations (containing certain patterns)
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

        return 'Thinking...';
    }

    /**
     * Formats a duration in milliseconds to a human-readable string.
     * @param {number} durationMs - Duration in milliseconds
     * @returns {string} Formatted duration string
     */
    formatReasoningDuration(durationMs) {
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
     * Finalizes the reasoning display after streaming completes.
     * Applies markdown processing to the final content and updates the subtitle with timing.
     * @param {string} messageId - The message ID
     * @param {string} reasoning - The final reasoning content
     * @param {number} reasoningDuration - Duration in milliseconds (optional)
     */
    finalizeReasoningDisplay(messageId, reasoning, reasoningDuration) {
        if (!reasoning) return;

        const reasoningContentEl = document.getElementById(`reasoning-content-${messageId}`);
        if (reasoningContentEl) {
            // Parse the reasoning content to fix formatting issues from the provider
            const parsedReasoning = parseReasoningContent(reasoning);

            // Apply full markdown processing now that streaming is complete
            reasoningContentEl.innerHTML = this.app.processContentWithLatex(parsedReasoning);
            // Switch to normal whitespace handling now that we have HTML
            reasoningContentEl.classList.remove('streaming');

            // Remove any leading/trailing empty paragraphs that markdown might have added
            while (reasoningContentEl.firstChild &&
                   reasoningContentEl.firstChild.nodeType === Node.ELEMENT_NODE &&
                   reasoningContentEl.firstChild.tagName === 'P' &&
                   !reasoningContentEl.firstChild.textContent.trim()) {
                reasoningContentEl.removeChild(reasoningContentEl.firstChild);
            }
            while (reasoningContentEl.lastChild &&
                   reasoningContentEl.lastChild.nodeType === Node.ELEMENT_NODE &&
                   reasoningContentEl.lastChild.tagName === 'P' &&
                   !reasoningContentEl.lastChild.textContent.trim()) {
                reasoningContentEl.removeChild(reasoningContentEl.lastChild);
            }

            // Render LaTeX in the reasoning content
            if (typeof renderMathInElement !== 'undefined') {
                renderMathInElement(reasoningContentEl, {
                    delimiters: [
                        {left: '$$', right: '$$', display: true},
                        {left: '\\[', right: '\\]', display: true},
                        {left: '\\(', right: '\\)', display: false},
                        {left: '$', right: '$', display: false}
                    ],
                    throwOnError: false
                });
            }
        }

        // Update the subtitle to show timing instead of the summary
        const subtitleEl = document.getElementById(`reasoning-subtitle-${messageId}`);
        if (subtitleEl) {
            // Remove streaming animation class
            subtitleEl.classList.remove('reasoning-subtitle-streaming');

            if (reasoningDuration) {
                subtitleEl.textContent = this.formatReasoningDuration(reasoningDuration);
            } else {
                // Fallback if no duration is available
                subtitleEl.textContent = 'Reasoning complete';
            }
        }
    }

    /**
     * Updates images for a streaming message.
     * @param {string} messageId - The message ID
     * @param {Array} images - Array of image objects
     */
    updateStreamingImages(messageId, images) {
        const messageEl = document.querySelector(`[data-message-id="${messageId}"]`);
        if (!messageEl || !images || images.length === 0) {
            return;
        }

        // Find the group element (assistantGroup class)
        const groupEl = messageEl.querySelector('.group.flex.w-full.flex-col');
        if (!groupEl) {
            return;
        }

        // Find or create the image bubble container
        let imageBubble = messageEl.querySelector('.message-assistant-images');

        if (!imageBubble) {
            // Create the image bubble after text bubble but before action buttons
            const actionButtons = groupEl.querySelector('.flex.items-center.gap-1');

            imageBubble = document.createElement('div');
            imageBubble.className = 'font-normal message-assistant-images w-full';

            if (actionButtons) {
                groupEl.insertBefore(imageBubble, actionButtons);
            } else {
                groupEl.appendChild(imageBubble);
            }
        }

        // Update images using the template function
        const { buildGeneratedImages } = window.MessageTemplates || {};
        if (buildGeneratedImages) {
            imageBubble.innerHTML = buildGeneratedImages(images);
        }

        // Update scroll button visibility based on content overflow
        this.app.updateScrollButtonVisibility();
    }

    /**
     * Appends a single message to the chat area without re-rendering the entire list.
     * @param {Object} message - The message object to append
     */
    async appendMessage(message) {
        const messagesContainer = this.app.elements.messagesContainer;
        const session = this.app.getCurrentSession();

        if (!session) return;

        // Check if we need to clear the empty state
        const emptyState = messagesContainer.querySelector('.text-center.text-muted-foreground');
        if (emptyState) {
            messagesContainer.innerHTML = '';
        }

        // Build HTML for the new message
        const helpers = {
            processContentWithLatex: this.app.processContentWithLatex.bind(this.app),
            formatTime: this.app.formatTime.bind(this.app)
        };

        const messageHtml = buildMessageHTML(message, helpers, this.app.state.models, session.model);

        // Append the message
        messagesContainer.insertAdjacentHTML('beforeend', messageHtml);

        // Render LaTeX only for the new message
        const newMessageEl = messagesContainer.querySelector(`[data-message-id="${message.id}"]`);
        if (newMessageEl && typeof renderMathInElement !== 'undefined') {
            const contentEl = newMessageEl.querySelector('.message-content');
            if (contentEl) {
                renderMathInElement(contentEl, {
                    delimiters: [
                        {left: '$$', right: '$$', display: true},
                        {left: '\\[', right: '\\]', display: true},
                        {left: '\\(', right: '\\)', display: false},
                        {left: '$', right: '$', display: false}
                    ],
                    throwOnError: false
                });
            }
        }

        // Scroll to bottom
        this.scrollToBottom();
        this.app.updateScrollButtonVisibility();

        // Update message navigation
        if (this.app.messageNavigation) {
            this.app.messageNavigation.update();
        }
    }

    /**
     * Updates the final token count for a message after streaming completes.
     * @param {string} messageId - The message ID
     * @param {number} tokenCount - Final token count
     */
    updateFinalTokens(messageId, tokenCount) {
        const messageEl = document.querySelector(`[data-message-id="${messageId}"]`);
        if (messageEl) {
            // Remove streaming indicator
            const streamingTokenEl = messageEl.querySelector('.streaming-token-count');
            if (streamingTokenEl) {
                streamingTokenEl.remove();
            }

            // Create and append final token count
            const tokenDisplayHtml = `<span class="text-xs text-muted-foreground ml-auto" style="font-size: 0.7rem;">${tokenCount}</span>`;
            const headerEl = messageEl.querySelector('.flex.w-full.items-center');
            if (headerEl) {
                headerEl.insertAdjacentHTML('beforeend', tokenDisplayHtml);
            }
        }
    }

    /**
     * Re-renders a message to its final state after streaming is complete.
     * This ensures reasoning traces are collapsed and tokens are correctly displayed.
     * @param {Object} message - The completed message object
     */
    async finalizeStreamingMessage(message) {
        const messageEl = document.querySelector(`[data-message-id="${message.id}"]`);
        if (messageEl) {
            // Find model details from the app state - try by ID first, then by name
            let model = this.app.state.models.find(m => m.id === message.model);
            if (!model) {
                model = this.app.state.models.find(m => m.name === message.model);
            }
            const modelName = model ? model.name : (message.model || 'Unknown Model');

            const helpers = {
                processContentWithLatex: this.app.processContentWithLatex.bind(this.app),
                formatTime: this.app.formatTime.bind(this.app)
            };

            // We need to get the provider name
            const providerName = model ? model.provider : 'Unknown';

            // Re-build the entire message HTML to reflect its final state
            const newMessageHtml = window.buildMessageHTML(message, helpers, this.app.state.models, modelName, providerName);

            // Create a temporary container to parse the new HTML
            const tempDiv = document.createElement('div');
            tempDiv.innerHTML = newMessageHtml;
            const newMessageEl = tempDiv.firstElementChild;

            if (newMessageEl) {
                messageEl.parentElement.replaceChild(newMessageEl, messageEl);
                // Re-run KaTeX rendering on the new element
                if (typeof renderMathInElement !== 'undefined') {
                    renderMathInElement(newMessageEl, {
                        delimiters: [
                            {left: '$$', right: '$$', display: true},
                            {left: '\\[', right: '\\]', display: true},
                            {left: '\\(', right: '\\)', display: false},
                            {left: '$', right: '$', display: false}
                        ],
                        throwOnError: false
                    });
                }
            }
        }
    }

    /**
     * Attaches click handler to the download chats link in the empty state.
     */
    attachDownloadHandler() {
        const downloadLink = document.querySelector('a[href="#download-chats-link"]');
        if (downloadLink) {
            downloadLink.addEventListener('click', async (e) => {
                e.preventDefault();
                const success = await downloadAllChats();
                if (!success) {
                    console.error('Failed to download chat history');
                }
            });
        }
    }
}

