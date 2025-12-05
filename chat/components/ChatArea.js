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
     * Sets up event listeners for message actions (copy, regenerate, edit, fork)
     * Uses event delegation for dynamically added messages
     */
    setupEventListeners() {
        const messagesContainer = this.app.elements.messagesContainer;

        // Event delegation for message action buttons
        messagesContainer.addEventListener('click', async (e) => {
            // User message show more/less toggle
            const showMoreBtn = e.target.closest('.user-message-show-more');
            if (showMoreBtn) {
                e.preventDefault();
                this.handleToggleUserMessage(showMoreBtn);
                return;
            }

            // Code block copy button
            const codeBlockCopyBtn = e.target.closest('.code-block-copy-btn');
            if (codeBlockCopyBtn) {
                e.preventDefault();
                this.handleCopyCodeBlock(codeBlockCopyBtn);
                return;
            }

            const copyBtn = e.target.closest('.copy-message-btn');
            if (copyBtn) {
                const messageId = copyBtn.dataset.messageId;
                await this.handleCopyMessage(messageId);
                return;
            }

            const copyUserBtn = e.target.closest('.copy-user-message-btn');
            if (copyUserBtn) {
                const messageId = copyUserBtn.dataset.messageId;
                await this.handleCopyMessage(messageId);
                return;
            }

            const regenerateBtn = e.target.closest('.regenerate-message-btn');
            if (regenerateBtn) {
                const messageId = regenerateBtn.dataset.messageId;
                await this.handleRegenerateMessage(messageId);
                return;
            }

            const editBtn = e.target.closest('.edit-prompt-btn');
            if (editBtn) {
                const messageId = editBtn.dataset.messageId;
                await this.app.enterEditMode(messageId);
                return;
            }

            const resendBtn = e.target.closest('.resend-prompt-btn');
            if (resendBtn) {
                const messageId = resendBtn.dataset.messageId;
                await this.handleResendMessage(messageId);
                return;
            }

            const cancelEditBtn = e.target.closest('.cancel-edit-btn');
            if (cancelEditBtn) {
                const messageId = cancelEditBtn.dataset.messageId;
                this.app.cancelEditMode(messageId);
                return;
            }

            const confirmEditBtn = e.target.closest('.confirm-edit-btn');
            if (confirmEditBtn) {
                const messageId = confirmEditBtn.dataset.messageId;
                await this.app.confirmEditPrompt(messageId);
                return;
            }

            const forkBtn = e.target.closest('.fork-conversation-btn');
            if (forkBtn) {
                const messageId = forkBtn.dataset.messageId;
                await this.app.forkConversation(messageId);
                return;
            }
        });

        // Add keyboard listener for Cmd/Ctrl+Enter in edit textarea and Escape to cancel
        messagesContainer.addEventListener('keydown', async (e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && !e.shiftKey) {
                const textarea = e.target.closest('.edit-prompt-textarea');
                if (textarea) {
                    e.preventDefault();
                    const messageId = textarea.dataset.messageId;
                    await this.app.confirmEditPrompt(messageId);
                }
            } else if (e.key === 'Escape') {
                const textarea = e.target.closest('.edit-prompt-textarea');
                if (textarea) {
                    e.preventDefault();
                    const messageId = textarea.dataset.messageId;
                    this.app.cancelEditMode(messageId);
                }
            }
        });
    }

    /**
     * Copies text to clipboard with Safari fallback.
     * Uses execCommand for immediate synchronous copy (required for Safari user activation).
     * @param {string} text - Text to copy
     * @returns {boolean} Success status
     */
    copyToClipboard(text) {
        try {
            const textarea = document.createElement('textarea');
            textarea.value = text;
            textarea.style.position = 'fixed';
            textarea.style.opacity = '0';
            textarea.style.pointerEvents = 'none';
            document.body.appendChild(textarea);
            textarea.select();
            const success = document.execCommand('copy');
            document.body.removeChild(textarea);
            return success;
        } catch (e) {
            // Fallback to async Clipboard API
            navigator.clipboard.writeText(text).catch(() => {});
            return true;
        }
    }

    /**
     * Gets visible text content from a message element in the DOM.
     * @param {string} messageId - The message ID
     * @returns {string|null} The text content or null
     */
    getMessageTextFromDOM(messageId) {
        const messageEl = document.querySelector(`[data-message-id="${messageId}"]`);
        if (!messageEl) return null;

        const contentEl = messageEl.querySelector('.message-content');
        if (contentEl) {
            return contentEl.innerText || contentEl.textContent;
        }
        return null;
    }

    /**
     * Handles copying the content of a message.
     * Prioritizes raw markdown from database; falls back to DOM for streaming.
     * @param {string} messageId - The message ID to copy
     */
    async handleCopyMessage(messageId) {
        const session = this.app.getCurrentSession();
        if (!session) return;

        // Try database first to get raw markdown/LaTeX
        const messages = await chatDB.getSessionMessages(session.id);
        const message = messages.find(m => m.id === messageId);

        if (message && message.content && message.content.trim()) {
            this.copyToClipboard(message.content);
            this.showCopySuccess(messageId);
            return;
        }

        // Fallback to DOM for streaming messages not yet saved
        const domContent = this.getMessageTextFromDOM(messageId);
        if (domContent && domContent.trim()) {
            this.copyToClipboard(domContent);
            this.showCopySuccess(messageId);
        }
    }

    /**
     * Shows copy success feedback on the appropriate button.
     * @param {string} messageId - The message ID
     */
    showCopySuccess(messageId) {
        // Handle assistant copy button
        const btn = document.querySelector(`.copy-message-btn[data-message-id="${messageId}"]`);
        if (btn) {
            this.animateCopyButton(btn);
        }

        // Handle user copy button
        const userBtn = document.querySelector(`.copy-user-message-btn[data-message-id="${messageId}"]`);
        if (userBtn) {
            this.animateCopyButton(userBtn);
            // Keep parent visible
            const actionsContainer = userBtn.closest('.message-user-actions');
            if (actionsContainer) {
                actionsContainer.classList.add('force-visible');
                setTimeout(() => {
                    actionsContainer.classList.remove('force-visible');
                }, 2000);
            }
        }
    }

    /**
     * Animates a copy button with tick icon
     * @param {HTMLElement} btn - The button element
     */
    animateCopyButton(btn) {
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

            // Blur the button to ensure it hides if relying on focus state
            btn.blur();
        }, 2000);
    }

    /**
     * Handles toggling the collapsed state of long user messages.
     * @param {HTMLElement} btn - The show more/less button element
     */
    handleToggleUserMessage(btn) {
        const bubble = btn.closest('.message-user');
        if (!bubble) return;

        const content = bubble.querySelector('.user-message-collapsible');
        if (!content) return;

        const isCollapsed = content.classList.contains('collapsed');
        if (isCollapsed) {
            content.classList.remove('collapsed');
            btn.textContent = 'Show less';
        } else {
            content.classList.add('collapsed');
            btn.textContent = 'Show more';
        }
    }

    /**
     * Handles copying code from a code block
     * @param {HTMLElement} btn - The copy button element
     */
    handleCopyCodeBlock(btn) {
        // Get code from data attribute (preserves original formatting)
        const code = btn.dataset.code;
        if (!code) return;

        // Decode HTML entities that were escaped for the attribute
        const tempEl = document.createElement('textarea');
        tempEl.innerHTML = code;
        const decodedCode = tempEl.value;

        // Get button elements for animation
        const svg = btn.querySelector('.copy-icon');
        const textEl = btn.querySelector('.copy-text');
        if (!svg) return;

        this.copyToClipboard(decodedCode);

        // Animate button to show success
        const originalSvgContent = svg.innerHTML;
        const originalText = textEl ? textEl.textContent : '';
        svg.innerHTML = '<path stroke-linecap="round" stroke-linejoin="round" d="M4.5 12.75l6 6 9-13.5" />';
        if (textEl) textEl.textContent = 'Copied';

        setTimeout(() => {
            svg.innerHTML = originalSvgContent;
            if (textEl) textEl.textContent = originalText;
        }, 2000);
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
     * Resends a user message - deletes any responses after it and regenerates
     * @param {string} messageId - User message ID to resend
     */
    async handleResendMessage(messageId) {
        const session = this.app.getCurrentSession();
        if (!session) return;

        if (this.app.isCurrentSessionStreaming()) return;

        const messages = await chatDB.getSessionMessages(session.id);
        const messageIndex = messages.findIndex(m => m.id === messageId);

        if (messageIndex === -1 || messages[messageIndex].role !== 'user') return;

        // Delete all messages after this user message
        const messagesToDelete = messages.slice(messageIndex + 1);
        for (const msg of messagesToDelete) {
            await chatDB.deleteMessage(msg.id);
        }

        await this.render();
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

        messagesContainer.innerHTML = messages.map(message => {
            const options = this.app.getMessageTemplateOptions ? this.app.getMessageTemplateOptions(message.id) : {};
            // Normalize streaming state for messages loaded from DB.
            // If streamingReasoning/streamingTokens are set, it means streaming was interrupted
            // (e.g., browser closed, network error). Reset them for proper display.
            // Active streaming uses appendMessage/updateStreamingMessage, not render().
            const normalizedMessage = (message.streamingReasoning || message.streamingTokens !== null)
                ? { ...message, streamingReasoning: false, streamingTokens: null }
                : message;
            return buildMessageHTML(normalizedMessage, helpers, this.app.state.models, session.model, options);
        }).join('');

        // Render LaTeX in all message content elements
        this.renderLatex();

        // Setup citation carousel scrolling
        this.setupCitationCarouselScroll();

        // Restore last seen scroll position or snap to bottom
        const restored = this.app.restoreSessionScrollPosition(session.id);
        if (!restored) {
            this.app.scrollChatAreaToBottomInstant();
            this.app.saveCurrentSessionScrollPosition();
        }

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
     * Applies KaTeX rendering to message content elements.
     * KaTeX is loaded with defer, guaranteeing it's ready before app.js runs.
     * @param {HTMLElement} scope - The element to search within (default: document)
     */
    renderLatex(scope = document) {
        scope.querySelectorAll('.message-content').forEach(el => {
            renderMathInElement(el, {
                delimiters: [
                    {left: '$$', right: '$$', display: true},
                    {left: '\\[', right: '\\]', display: true},
                    {left: '\\(', right: '\\)', display: false}
                ],
                throwOnError: false
            });
        });
    }

    /**
     * Updates a specific message in the DOM without full re-render.
     * @param {Object} message - The message object to update
     */
    updateMessage(message) {
        const messageEl = document.querySelector(`[data-message-id="${message.id}"]`);
        if (messageEl) {
            const session = this.app.getCurrentSession();
            const helpers = {
                processContentWithLatex: this.app.processContentWithLatex.bind(this.app),
                formatTime: this.app.formatTime.bind(this.app)
            };
            const options = this.app.getMessageTemplateOptions ? this.app.getMessageTemplateOptions(message.id) : {};

            // Build new HTML
            const newHtml = buildMessageHTML(message, helpers, this.app.state.models, session.model, options);

            // Create temp element to parse HTML
            const tempDiv = document.createElement('div');
            tempDiv.innerHTML = newHtml;
            const newMessageEl = tempDiv.firstElementChild;

            if (newMessageEl) {
                messageEl.replaceWith(newMessageEl);
                // Re-run LaTeX on just this element
                this.renderLatex(newMessageEl);
                // Re-setup listeners if needed (delegated listeners cover most)
            }
        }
    }

    /**
     * Removes all messages that come after the specified message ID in the DOM.
     * @param {string} messageId - The reference message ID
     */
    removeMessagesAfter(messageId) {
        const messageEl = document.querySelector(`[data-message-id="${messageId}"]`);
        if (!messageEl) return;

        let nextEl = messageEl.nextElementSibling;
        while (nextEl) {
            const toRemove = nextEl;
            nextEl = nextEl.nextElementSibling;
            // Only remove message elements (check for data-message-id or typical classes)
            if (toRemove.hasAttribute('data-message-id') || toRemove.classList.contains('w-full')) {
                toRemove.remove();
            }
        }
    }

    /**
     * Sets up horizontal mouse wheel scrolling for citation carousels.
     * Converts vertical wheel events to horizontal scrolling when hovering over carousels.
     */
    setupCitationCarouselScroll() {
        const carousels = document.querySelectorAll('.citations-carousel');
        carousels.forEach(carousel => {
            // Remove any existing listeners to prevent duplicates
            if (carousel._wheelHandler) {
                carousel.removeEventListener('wheel', carousel._wheelHandler);
            }
            if (carousel._mouseEnterHandler) {
                carousel.removeEventListener('mouseenter', carousel._mouseEnterHandler);
            }
            if (carousel._mouseLeaveHandler) {
                carousel.removeEventListener('mouseleave', carousel._mouseLeaveHandler);
            }

            // Mouse enter handler
            carousel._mouseEnterHandler = () => {
                // Add a class to indicate mouse is over carousel
                carousel.classList.add('hover-active');
            };

            // Mouse leave handler
            carousel._mouseLeaveHandler = () => {
                carousel.classList.remove('hover-active');
                carousel.classList.remove('is-scrolling');
                carousel.classList.remove('wheel-active');
                if (carousel._scrollTimeout) {
                    clearTimeout(carousel._scrollTimeout);
                }
            };

            // Wheel event handler
            carousel._wheelHandler = (e) => {
                // Only handle if we have scroll delta
                if (e.deltaY === 0 && e.deltaX === 0) return;

                // Check if this carousel has horizontal overflow
                if (carousel.scrollWidth <= carousel.clientWidth) return;

                // Prevent default vertical scrolling only if we have vertical delta
                if (e.deltaY !== 0) {
                    e.preventDefault();
                }

                // Add scrolling classes
                carousel.classList.add('is-scrolling');
                carousel.classList.add('wheel-active');

                // Clear existing timeout
                if (carousel._scrollTimeout) {
                    clearTimeout(carousel._scrollTimeout);
                }

                // Calculate scroll amount
                // Support both vertical wheel (converted to horizontal) and native horizontal wheel
                const verticalDelta = e.deltaY * 0.8;
                const horizontalDelta = e.deltaX * 0.8;

                // Use horizontal delta if available, otherwise use vertical
                const scrollAmount = horizontalDelta !== 0 ? horizontalDelta : verticalDelta;

                // Apply scroll
                carousel.scrollLeft += scrollAmount;

                // Remove scrolling classes after a brief delay
                carousel._scrollTimeout = setTimeout(() => {
                    carousel.classList.remove('is-scrolling');
                    carousel.classList.remove('wheel-active');
                }, 100);
            };

            // Add event listeners
            carousel.addEventListener('mouseenter', carousel._mouseEnterHandler);
            carousel.addEventListener('mouseleave', carousel._mouseLeaveHandler);
            carousel.addEventListener('wheel', carousel._wheelHandler, { passive: false });

            // Also add wheel handlers to all citation cards to ensure smooth scrolling
            const cards = carousel.querySelectorAll('.citation-card-modern');
            cards.forEach(card => {
                card.addEventListener('wheel', (e) => {
                    // Forward the wheel event to the carousel's handler
                    carousel._wheelHandler(e);
                }, { passive: false });
            });
        });
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
        if (!messageEl) return;

        let contentEl = messageEl.querySelector('.message-content');

        // If content element doesn't exist (e.g., first output after reasoning), create it
        if (!contentEl) {
            const groupEl = messageEl.querySelector('.group.flex.w-full.flex-col');
            if (groupEl) {
                // Find the reasoning trace element to insert after it
                const reasoningEl = groupEl.querySelector('.reasoning-trace');
                const actionButtons = groupEl.querySelector('.flex.items-center.justify-between');

                // Create the text bubble
                const textBubble = document.createElement('div');
                textBubble.className = 'py-3 px-4 font-normal message-assistant w-full flex items-center';
                textBubble.innerHTML = '<div class="min-w-0 w-full overflow-hidden message-content prose"></div>';

                // Insert after reasoning trace but before action buttons
                if (reasoningEl && actionButtons) {
                    groupEl.insertBefore(textBubble, actionButtons);
                } else if (actionButtons) {
                    groupEl.insertBefore(textBubble, actionButtons);
                } else {
                    groupEl.appendChild(textBubble);
                }

                contentEl = textBubble.querySelector('.message-content');
            }
        }

        if (contentEl) {
            // Use the app's LaTeX-safe processor
            contentEl.innerHTML = this.app.processContentWithLatex(content);
            // Re-render LaTeX for the updated content
            renderMathInElement(contentEl, {
                delimiters: [
                    {left: '$$', right: '$$', display: true},
                    {left: '\\[', right: '\\]', display: true},
                    {left: '\\(', right: '\\)', display: false}
                ],
                throwOnError: false
            });
        }
    }

    /**
     * FEATURE DISABLED: Token count display - uncomment to re-enable
     * Updates the streaming token count display for a message.
     * @param {string} messageId - The message ID
     * @param {number} tokenCount - Token count to display
     */
    // updateStreamingTokens(messageId, tokenCount) {
    //     const messageEl = document.querySelector(`[data-message-id="${messageId}"]`);
    //     if (messageEl) {
    //         const tokenEl = messageEl.querySelector('.streaming-token-count');
    //         if (tokenEl) {
    //             tokenEl.textContent = tokenCount;
    //         }
    //     }
    // }

    /**
     * Converts basic markdown (bold) to HTML for streaming display.
     * Faster than full markdown processing but renders bold titles properly.
     * @param {string} text - The text to convert
     * @returns {string} HTML with bold converted and lines wrapped for spacing
     */
    convertBasicMarkdownToHtml(text) {
        // Escape HTML entities first to prevent XSS
        const escaped = text
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
        // Convert **bold** to <strong>bold</strong>
        const withBold = escaped.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
        // Wrap each line in a div for vertical spacing (CSS can't add margin to pre-line breaks)
        return withBold
            .split('\n')
            .map(line => `<div class="streaming-line">${line}</div>`)
            .join('');
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

            // Convert basic markdown (bold) to HTML for proper rendering during streaming
            // Full markdown/LaTeX will be applied when streaming completes
            reasoningContentEl.innerHTML = this.convertBasicMarkdownToHtml(parsedReasoning);
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
     * Updates the reasoning subtitle to show duration when thinking completes.
     * Called when output starts streaming after reasoning finishes.
     * @param {string} messageId - The message ID
     * @param {number} reasoningDuration - Duration in milliseconds
     */
    updateReasoningSubtitleToDuration(messageId, reasoningDuration) {
        const subtitleEl = document.getElementById(`reasoning-subtitle-${messageId}`);
        if (subtitleEl) {
            // Remove streaming animation class
            subtitleEl.classList.remove('reasoning-subtitle-streaming');
            // Update text to show duration
            subtitleEl.textContent = this.formatReasoningDuration(reasoningDuration);
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
            renderMathInElement(reasoningContentEl, {
                delimiters: [
                    {left: '$$', right: '$$', display: true},
                    {left: '\\[', right: '\\]', display: true},
                    {left: '\\(', right: '\\)', display: false}
                ],
                throwOnError: false
            });
        }

        // Update the subtitle to show timing instead of the summary
        // Only update if it hasn't already been updated (when output started streaming)
        const subtitleEl = document.getElementById(`reasoning-subtitle-${messageId}`);
        if (subtitleEl) {
            // Check if subtitle was already updated (no longer has streaming animation)
            const alreadyUpdated = !subtitleEl.classList.contains('reasoning-subtitle-streaming');

            if (!alreadyUpdated) {
                // Subtitle hasn't been updated yet, update it now
                subtitleEl.classList.remove('reasoning-subtitle-streaming');
                if (reasoningDuration) {
                    subtitleEl.textContent = this.formatReasoningDuration(reasoningDuration);
                } else {
                    // Fallback if no duration is available
                    subtitleEl.textContent = 'Reasoning complete';
                }
            }
            // If already updated, we skip the re-render to avoid redundancy
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
            // Create the image bubble after text bubble but before action buttons wrapper
            // Use the outer wrapper selector (justify-between) to get a direct child of groupEl
            const actionButtonsWrapper = groupEl.querySelector(':scope > .flex.items-center.justify-between');

            imageBubble = document.createElement('div');
            imageBubble.className = 'font-normal message-assistant-images w-full';

            if (actionButtonsWrapper) {
                groupEl.insertBefore(imageBubble, actionButtonsWrapper);
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
        if (newMessageEl) {
            const contentEl = newMessageEl.querySelector('.message-content');
            if (contentEl) {
                renderMathInElement(contentEl, {
                    delimiters: [
                        {left: '$$', right: '$$', display: true},
                        {left: '\\[', right: '\\]', display: true},
                        {left: '\\(', right: '\\)', display: false}
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
     * FEATURE DISABLED: Token count display - uncomment to re-enable
     * Updates the final token count for a message after streaming completes.
     * @param {string} messageId - The message ID
     * @param {number} tokenCount - Final token count
     */
    // updateFinalTokens(messageId, tokenCount) {
    //     const messageEl = document.querySelector(`[data-message-id="${messageId}"]`);
    //     if (messageEl) {
    //         // Remove streaming indicator
    //         const streamingTokenEl = messageEl.querySelector('.streaming-token-count');
    //         if (streamingTokenEl) {
    //             streamingTokenEl.remove();
    //         }
    //
    //         // Create and append final token count
    //         const tokenDisplayHtml = `<span class="text-xs text-muted-foreground ml-auto" style="font-size: 0.7rem;">${tokenCount}</span>`;
    //         const headerEl = messageEl.querySelector('.flex.w-full.items-center');
    //         if (headerEl) {
    //             headerEl.insertAdjacentHTML('beforeend', tokenDisplayHtml);
    //         }
    //     }
    // }

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

            // Re-build the entire message HTML to reflect its final state
            const newMessageHtml = window.buildMessageHTML(message, helpers, this.app.state.models, modelName);

            // Create a temporary container to parse the new HTML
            const tempDiv = document.createElement('div');
            tempDiv.innerHTML = newMessageHtml;
            const newMessageEl = tempDiv.firstElementChild;

            if (newMessageEl) {
                messageEl.parentElement.replaceChild(newMessageEl, messageEl);
                // Re-run KaTeX rendering on the new element
                renderMathInElement(newMessageEl, {
                    delimiters: [
                        {left: '$$', right: '$$', display: true},
                        {left: '\\[', right: '\\]', display: true},
                        {left: '\\(', right: '\\)', display: false}
                    ],
                    throwOnError: false
                });
                // Setup citation carousel scrolling for the updated message
                this.setupCitationCarouselScroll();
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

