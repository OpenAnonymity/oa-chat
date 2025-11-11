/**
 * ChatArea Component
 * Manages the main chat messages area including rendering messages,
 * scroll behaviors, and LaTeX rendering.
 */

import { buildMessageHTML, buildEmptyState } from './MessageTemplates.js';
import { downloadAllChats } from '../services/fileUtils.js';

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
     * Updates images for a streaming message.
     * @param {string} messageId - The message ID
     * @param {Array} images - Array of image objects
     */
    updateStreamingImages(messageId, images) {
        console.log('updateStreamingImages called:', messageId, images.length);
        const messageEl = document.querySelector(`[data-message-id="${messageId}"]`);
        if (!messageEl || !images || images.length === 0) {
            console.log('Early return:', !messageEl ? 'no messageEl' : 'no images');
            return;
        }
        
        // Find the group element (assistantGroup class)
        const groupEl = messageEl.querySelector('.group.flex.w-full.flex-col');
        if (!groupEl) {
            console.log('No groupEl found');
            return;
        }
        console.log('groupEl found, updating images');
        
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
        
        // Keep scrolling to bottom during streaming
        this.scrollToBottom();
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

