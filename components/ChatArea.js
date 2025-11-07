/**
 * ChatArea Component
 * Manages the main chat messages area including rendering messages,
 * scroll behaviors, and LaTeX rendering.
 */

import { buildMessageHTML, buildEmptyState } from './MessageTemplates.js';

export default class ChatArea {
    /**
     * @param {Object} app - Reference to the main ChatApp instance
     */
    constructor(app) {
        this.app = app;
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
            return;
        }

        // Load messages from IndexedDB
        const messages = await chatDB.getSessionMessages(session.id);

        if (messages.length === 0) {
            messagesContainer.innerHTML = buildEmptyState();
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
        this.scrollToBottom();

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
    scrollToBottom() {
        requestAnimationFrame(() => {
            this.app.elements.chatArea.scrollTop = this.app.elements.chatArea.scrollHeight;
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
        // Keep scrolling to bottom during streaming
        this.app.elements.chatArea.scrollTop = this.app.elements.chatArea.scrollHeight;
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
            const tokenEl = messageEl.querySelector('.streaming-token-count');
            if (tokenEl) {
                // Replace streaming token count with final count
                tokenEl.textContent = tokenCount;
                tokenEl.classList.remove('streaming-token-count');
            }
        }
    }
}

