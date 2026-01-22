/**
 * ChatArea Component
 * Manages the main chat messages area including rendering messages,
 * scroll behaviors, and LaTeX rendering.
 */

import { buildMessageHTML, buildEmptyState, buildSharedIndicator, buildImportedIndicator, buildTypingIndicator } from './MessageTemplates.js';
import { exportChats, exportTickets } from '../services/globalExport.js';
import { parseStreamingReasoningContent, parseReasoningContent } from '../services/reasoningParser.js';
import { chatDB } from '../db.js';

export default class ChatArea {
    /**
     * @param {Object} app - Reference to the main ChatApp instance
     */
    constructor(app) {
        this.app = app;
        // Buffer for debounced reasoning updates during streaming
        this.reasoningBuffer = { content: '', timeout: null, messageId: null };
        // Typewriter state for gradual content reveal
        this.typewriter = {
            targetContent: '',      // Full content to display
            displayedLength: 0,     // Characters currently shown
            interval: null,         // Typing interval ID
            messageId: null,        // Current message being typed
            charsPerTick: 3,        // Characters to reveal per tick
            tickMs: 16              // Milliseconds between ticks (~60fps)
        };
        // Track if user has scrolled up in reasoning content (pauses auto-scroll)
        this.reasoningAutoScrollPaused = false;
        // Pending animation frame for debounced auto-grow
        this.pendingAutoGrowFrame = null;
        // Render generation counter - used to cancel stale renders during rapid session switching
        this.renderGeneration = 0;
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

            // File attachments use data attributes instead of inline JS for safer clicks.
            const attachmentCard = e.target.closest('.file-attachment-card');
            if (attachmentCard && attachmentCard.dataset.attachmentAction) {
                e.preventDefault();
                const action = attachmentCard.dataset.attachmentAction;
                if (action === 'expand-image') {
                    const imageId = attachmentCard.dataset.imageId;
                    if (imageId && typeof window.expandImage === 'function') {
                        window.expandImage(imageId);
                    }
                    return;
                }
                if (action === 'download') {
                    const url = attachmentCard.dataset.downloadUrl;
                    if (url) {
                        const name = attachmentCard.dataset.downloadName || 'download';
                        const anchor = document.createElement('a');
                        anchor.href = url;
                        anchor.download = name;
                        document.body.appendChild(anchor);
                        anchor.click();
                        document.body.removeChild(anchor);
                    }
                    return;
                }
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

            // Edit model picker button - opens the model picker modal
            const editModelPickerBtn = e.target.closest('.edit-model-picker-btn');
            if (editModelPickerBtn) {
                e.preventDefault();
                e.stopPropagation();
                // Open the model picker (same as Cmd+K)
                if (this.app.modelPicker) {
                    this.app.modelPicker.open();
                }
                return;
            }
        });

        // Auto-grow edit textarea on input (debounced via requestAnimationFrame)
        messagesContainer.addEventListener('input', (e) => {
            const textarea = e.target.closest('.edit-prompt-textarea');
            if (textarea) {
                this.scheduleAutoGrow(textarea);
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
     *
     * SESSION SWITCHING & STREAMING CONTINUITY:
     * When switching between sessions while one is streaming, this method preserves
     * the reasoning trace state so the user sees a consistent UI when switching back:
     *
     * 1. The reasoningBuffer is NOT cleared on render() - it persists across session
     *    switches so we can restore the exact content the user last saw.
     *
     * 2. For streaming sessions, we prioritize buffer content over DB content because
     *    DB saves may lag behind the live stream (async saves).
     *
     * 3. We immediately update the DOM with buffer content after setting innerHTML,
     *    so the user sees all accumulated trace blocks (T1+T2+T3) right away,
     *    not just what was saved to DB (which might only be T1).
     *
     * 4. The typewriter's displayedLength is set to match the buffer content length,
     *    so only NEW content that arrives after the switch animates.
     */
    async render() {
        // Increment render generation - used to cancel stale renders during rapid session switching
        const currentGeneration = ++this.renderGeneration;

        // Clear debounce timer but DON'T clear buffer content - it persists across
        // session switches to enable seamless restoration of streaming state
        if (this.reasoningBuffer.timeout) {
            clearTimeout(this.reasoningBuffer.timeout);
            this.reasoningBuffer.timeout = null;
        }
        // Stop typewriter interval but preserve displayedLength for continuity
        if (this.typewriter.interval) {
            clearInterval(this.typewriter.interval);
            this.typewriter.interval = null;
        }

        const session = this.app.getCurrentSession();
        const messagesContainer = this.app.elements.messagesContainer;

        if (!session) {
            messagesContainer.innerHTML = buildEmptyState();
            this.attachDownloadHandler();
            return;
        }

        // Load messages from IndexedDB
        const messages = await chatDB.getSessionMessages(session.id);

        // Check if this render is stale (a newer render was triggered while we were loading messages)
        if (currentGeneration !== this.renderGeneration) {
            return; // Bail out - a newer render is in progress
        }

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

        // Check if this session is currently streaming
        const isSessionStreaming = this.app.isCurrentSessionStreaming();

        // Check if this is an imported (or forked from import) session with new messages added
        // importedFrom = share import (can still receive updates)
        // importedSource = external import (ChatGPT, etc.)
        // forkedFrom = was imported but user made changes (no longer receives updates)
        const wasImported = session.importedFrom || session.forkedFrom || session.importedSource;
        const importedCount = session.importedMessageCount || 0;
        const hasNewMessagesAfterImport = wasImported && importedCount > 0 && messages.length > importedCount;

        // Check if session is shared and has new messages after sharing
        const sharedCount = session.shareInfo?.messageCount || 0;
        const hasNewMessagesAfterShare = session.shareInfo?.shareId && sharedCount > 0 && messages.length > sharedCount;

        // Debug logging for shared indicator position
        if (session.shareInfo?.shareId) {
            console.log(`[ChatArea] Shared session: messageCount=${sharedCount}, currentMessages=${messages.length}, hasNewAfterShare=${hasNewMessagesAfterShare}`);
        }

        let messagesHtml = messages.map((message, index) => {
            const options = this.app.getMessageTemplateOptions ? this.app.getMessageTemplateOptions(message.id) : {};
            // Pass session streaming state to template
            options.isSessionStreaming = isSessionStreaming;
            // Normalize streaming state for messages loaded from DB.
            // If streamingReasoning/streamingTokens are set AND session is NOT currently streaming,
            // it means streaming was interrupted (e.g., browser closed, network error).
            // Skip normalization if session is actively streaming to preserve the streaming UI state.
            const shouldNormalize = !isSessionStreaming && (message.streamingReasoning || message.streamingTokens !== null);
            const normalizedMessage = shouldNormalize
                ? { ...message, streamingReasoning: false, streamingTokens: null }
                : message;

            let html = buildMessageHTML(normalizedMessage, helpers, this.app.state.models, session.model, options);

            // Insert "Above was shared" indicator after the last imported message
            if (hasNewMessagesAfterImport && index === importedCount - 1) {
                html += buildImportedIndicator(importedCount);
            }

            // Insert shared indicator after the last shared message (only if there are new messages after)
            if (hasNewMessagesAfterShare && !isSessionStreaming && index === sharedCount - 1) {
                html += buildSharedIndicator();
            }

            return html;
        }).join('');

        // If session is imported but no new messages yet, show indicator at the end
        if (wasImported && !hasNewMessagesAfterImport && messages.length > 0) {
            messagesHtml += buildImportedIndicator(messages.length);
        }

        // Show shared indicator at the end only if no new messages after sharing
        if (session.shareInfo?.shareId && !hasNewMessagesAfterShare && !isSessionStreaming && messages.length > 0) {
            messagesHtml += buildSharedIndicator();
        }

        // If session is streaming but no assistant message exists yet (message not saved to DB),
        // show a typing indicator so the user knows a response is pending
        const lastMsg = messages[messages.length - 1];
        const needsTypingIndicator = isSessionStreaming && (!lastMsg || lastMsg.role === 'user');
        if (needsTypingIndicator) {
            // Get provider from session model for the typing indicator
            const sessionModel = this.app.state.models?.find(m => m.name === session.model);
            const providerName = sessionModel?.provider || 'OpenAI';
            messagesHtml += buildTypingIndicator('typing-restore-' + Date.now(), providerName);
        }

        messagesContainer.innerHTML = messagesHtml;

        // For streaming sessions, initialize typewriter state from live buffer OR DB content
        // Priority: live buffer > DB (because DB saves may lag behind the live stream)
        if (isSessionStreaming) {
            const streamingMsg = messages.find(m => m.role === 'assistant' && m.streamingReasoning);
            if (streamingMsg) {
                // Check if we have live buffer content for THIS message (more up-to-date than DB)
                const hasLiveBuffer = this.reasoningBuffer.messageId === streamingMsg.id && this.reasoningBuffer.content;
                const reasoningSource = hasLiveBuffer ? this.reasoningBuffer.content : streamingMsg.reasoning;

                if (reasoningSource) {
                    const parsedReasoning = parseStreamingReasoningContent(reasoningSource);
                    this.typewriter.messageId = streamingMsg.id;
                    this.typewriter.targetContent = parsedReasoning;
                    // Set displayedLength to full content so typewriter shows all existing content
                    // and only animates NEW content that arrives after this render
                    this.typewriter.displayedLength = parsedReasoning.length;

                    // Immediately update DOM with buffer content (don't wait for flushReasoningBuffer)
                    // This ensures user sees T1+T2+T3 right away, not just T1 from DB
                    const reasoningContentEl = document.getElementById(`reasoning-content-${streamingMsg.id}`);
                    if (reasoningContentEl && hasLiveBuffer) {
                        // Clear existing content and insert buffer content
                        let loadingIndicator = reasoningContentEl.querySelector('.reasoning-loading-indicator');
                        if (!loadingIndicator) {
                            loadingIndicator = document.createElement('span');
                            loadingIndicator.className = 'reasoning-loading-indicator reasoning-subtitle-streaming';
                            loadingIndicator.textContent = 'Thinking...';
                        }
                        reasoningContentEl.innerHTML = '';
                        const wrapper = document.createElement('div');
                        wrapper.innerHTML = this.convertBasicMarkdownToHtml(parsedReasoning);
                        while (wrapper.firstChild) {
                            reasoningContentEl.appendChild(wrapper.firstChild);
                        }
                        reasoningContentEl.appendChild(loadingIndicator);

                        // Also update the subtitle to match the latest content
                        const subtitleEl = document.getElementById(`reasoning-subtitle-${streamingMsg.id}`);
                        if (subtitleEl) {
                            const subtitle = this.extractReasoningSubtitle(reasoningSource);
                            subtitleEl.textContent = subtitle;
                            if (!subtitleEl.classList.contains('reasoning-subtitle-streaming')) {
                                subtitleEl.classList.add('reasoning-subtitle-streaming');
                            }
                        }
                    }
                }
            }
        } else {
            // Not streaming - fully reset typewriter state
            // DON'T clear buffer here - it may contain content from a different streaming session
            // that the user might switch back to
            this.typewriter.targetContent = '';
            this.typewriter.displayedLength = 0;
            this.typewriter.messageId = null;
        }

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
            this.app.updateToolbarDivider();
        });

        // Update message navigation if it exists
        if (this.app.messageNavigation) {
            this.app.messageNavigation.update();
        }

        // Initialize edit form if we're in edit mode
        if (this.app.editingMessageId) {
            this.initializeEditForm();
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
            // Add streaming class to disable hover effects (prevents flicker)
            contentEl.classList.add('streaming');

            // Use the app's LaTeX-safe processor
            let processedContent = this.app.processContentWithLatex(content);

            // Enhance inline links into styled buttons during streaming
            processedContent = window.MessageTemplates.enhanceInlineLinks(processedContent, messageId);

            contentEl.innerHTML = processedContent;
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
     * Uses debounced buffering for smoother rendering of rapid chunks.
     * @param {string} messageId - The message ID
     * @param {string} reasoning - The reasoning content
     */
    updateStreamingReasoning(messageId, reasoning) {
        // Always update buffer immediately (non-blocking)
        this.reasoningBuffer.content = reasoning;
        this.reasoningBuffer.messageId = messageId;

        // Debounce the actual DOM render (~80ms batches rapid chunks)
        if (!this.reasoningBuffer.timeout) {
            this.reasoningBuffer.timeout = setTimeout(() => {
                this.flushReasoningBuffer();
            }, 80);
        }
    }

    /**
     * Flushes the reasoning buffer and starts/updates typewriter animation.
     * Called on debounce timeout to batch rapid streaming updates.
     */
    flushReasoningBuffer() {
        this.reasoningBuffer.timeout = null;
        const { content, messageId } = this.reasoningBuffer;
        if (!messageId || !content) return;

        // Parse the reasoning content
        const parsedReasoning = parseStreamingReasoningContent(content);

        // Update typewriter target (it will catch up gradually)
        this.typewriter.targetContent = parsedReasoning;

        // If message changed, reset typewriter state
        // Note: render() pre-initializes typewriter.messageId for streaming sessions,
        // so this won't reset displayedLength when returning to the same streaming session
        if (this.typewriter.messageId !== messageId) {
            this.typewriter.messageId = messageId;
            this.typewriter.displayedLength = 0;
            // Reset scroll tracking for new message
            this.reasoningAutoScrollPaused = false;
        }

        // Start typewriter if not already running
        if (!this.typewriter.interval) {
            this.typewriter.interval = setInterval(() => {
                this.typewriterTick();
            }, this.typewriter.tickMs);
        }

        // Update the subtitle with the last meaningful line and ensure animation is active
        const subtitleEl = document.getElementById(`reasoning-subtitle-${messageId}`);
        if (subtitleEl) {
            const subtitle = this.extractReasoningSubtitle(content);
            subtitleEl.textContent = subtitle;
            if (!subtitleEl.classList.contains('reasoning-subtitle-streaming')) {
                subtitleEl.classList.add('reasoning-subtitle-streaming');
            }
        }
    }

    /**
     * Sets up scroll tracking on a reasoning content element.
     * Detects user input (wheel/touch) to pause auto-scroll, resumes when user scrolls to bottom.
     * @param {HTMLElement} el - The reasoning content element
     */
    setupReasoningScrollTracking(el) {
        if (!el || el._reasoningScrollTracked) return;
        el._reasoningScrollTracked = true;

        // Detect user wheel input - this is the primary way users scroll
        el.addEventListener('wheel', (e) => {
            // Any scroll up pauses auto-scroll immediately
            if (e.deltaY < 0) {
                this.reasoningAutoScrollPaused = true;
            }
            // Scrolling down only resumes if truly at the very bottom (strict threshold)
            // This prevents accidental resume from trackpad momentum
            else if (e.deltaY > 0 && this.reasoningAutoScrollPaused) {
                const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
                // Very strict: must be within 5px of bottom to resume
                if (distanceFromBottom <= 5) {
                    this.reasoningAutoScrollPaused = false;
                }
            }
        }, { passive: true });

        // Detect touch scrolling (mobile)
        let touchStartY = 0;
        el.addEventListener('touchstart', (e) => {
            touchStartY = e.touches[0].clientY;
        }, { passive: true });

        el.addEventListener('touchmove', (e) => {
            const touchY = e.touches[0].clientY;
            const deltaY = touchStartY - touchY; // positive = finger moving up = scrolling down in content

            if (deltaY < 0) {
                // Swiping down (scrolling up in content) - pause
                this.reasoningAutoScrollPaused = true;
            } else if (deltaY > 0 && this.reasoningAutoScrollPaused) {
                // Swiping up (scrolling down) - only resume if at very bottom
                const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
                if (distanceFromBottom <= 5) {
                    this.reasoningAutoScrollPaused = false;
                }
            }
            touchStartY = touchY;
        }, { passive: true });
    }

    /**
     * Typewriter tick - reveals a few more characters of reasoning content.
     * Handles race conditions by continuing from displayed position toward target.
     * Auto-scrolls only if user hasn't manually scrolled up.
     */
    typewriterTick() {
        const { targetContent, displayedLength, messageId, charsPerTick } = this.typewriter;
        if (!messageId) return;

        const reasoningContentEl = document.getElementById(`reasoning-content-${messageId}`);
        if (!reasoningContentEl) return;

        // Set up scroll tracking on first access
        this.setupReasoningScrollTracking(reasoningContentEl);

        // Ensure streaming class is present
        if (!reasoningContentEl.classList.contains('streaming')) {
            reasoningContentEl.classList.add('streaming');
        }

        // Calculate how much to reveal this tick
        const targetLength = targetContent.length;

        /*
         * ANIMATED ELEMENT PRESERVATION PATTERN
         * =====================================
         * The loading indicator has a CSS shimmer animation. For the animation to
         * run smoothly, the DOM element must NOT be recreated on each tick.
         *
         * WRONG: Using innerHTML to replace everything (resets animation to frame 0)
         *   container.innerHTML = content + '<span class="animated">...</span>';
         *
         * RIGHT: Keep the animated element in DOM, update content around it
         *   1. Query for existing animated element (or create once)
         *   2. Remove other children while keeping the animated element
         *   3. Insert new content before/after the animated element
         *
         * This pattern preserves animation state across rapid updates.
         * See styles.css "SHIMMER ANIMATION" section for related CSS notes.
         */
        let loadingIndicator = reasoningContentEl.querySelector('.reasoning-loading-indicator');
        if (!loadingIndicator) {
            loadingIndicator = document.createElement('span');
            loadingIndicator.className = 'reasoning-loading-indicator reasoning-subtitle-streaming';
            loadingIndicator.textContent = 'Thinking...';
            reasoningContentEl.appendChild(loadingIndicator);
        }

        // Helper: update content while preserving loading indicator in DOM
        const updateContentPreservingIndicator = (html) => {
            // Remove all children EXCEPT loading indicator
            const children = Array.from(reasoningContentEl.childNodes);
            for (const child of children) {
                if (child !== loadingIndicator) {
                    child.remove();
                }
            }
            // Insert new content before loading indicator
            const wrapper = document.createElement('div');
            wrapper.innerHTML = html;
            while (wrapper.firstChild) {
                reasoningContentEl.insertBefore(wrapper.firstChild, loadingIndicator);
            }
        };

        if (displayedLength >= targetLength) {
            // Caught up to target - update content, wait for more
            updateContentPreservingIndicator(this.convertBasicMarkdownToHtml(targetContent));
            // Only auto-scroll if user hasn't scrolled up
            if (!this.reasoningAutoScrollPaused) {
                reasoningContentEl.scrollTop = reasoningContentEl.scrollHeight;
            }
            return;
        }

        // Reveal more characters
        const newLength = Math.min(displayedLength + charsPerTick, targetLength);
        this.typewriter.displayedLength = newLength;

        // Update displayed content
        const displayContent = targetContent.substring(0, newLength);
        updateContentPreservingIndicator(this.convertBasicMarkdownToHtml(displayContent));

        // Only auto-scroll if user hasn't manually scrolled up
        if (!this.reasoningAutoScrollPaused) {
            reasoningContentEl.scrollTop = reasoningContentEl.scrollHeight;
        }

        // Update scroll button visibility
        this.app.updateScrollButtonVisibility();
    }

    /**
     * Stops the typewriter animation and clears state.
     */
    stopTypewriter() {
        if (this.typewriter.interval) {
            clearInterval(this.typewriter.interval);
            this.typewriter.interval = null;
        }
        this.typewriter.targetContent = '';
        this.typewriter.displayedLength = 0;
        this.typewriter.messageId = null;
        // Reset scroll tracking for next stream
        this.reasoningAutoScrollPaused = false;
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
     * Only uses explicit subtitle markers (## headings or **bold** text).
     * Returns "Thinking..." if no markers are found (e.g., Claude models).
     * @param {string} reasoning - The reasoning content
     * @returns {string} The subtitle text
     */
    extractReasoningSubtitle(reasoning) {
        if (!reasoning || reasoning.trim().length === 0) {
            return 'Thinking...';
        }

        const MAX_LENGTH = 150;
        const structure = this.parseReasoningStructure(reasoning);

        // Only use explicit subtitle markers (headings or bold text)
        // If none found, keep showing "Thinking..." - don't fall back to body text
        if (structure.summaries.length > 0) {
            const lastSummary = structure.summaries[structure.summaries.length - 1];
            const summaryText = lastSummary.text;

            return summaryText.length > MAX_LENGTH
                ? summaryText.substring(0, MAX_LENGTH - 3) + '...'
                : summaryText;
        }

        // No subtitle markers detected - keep default streaming indicator
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
        // Clear any pending buffer timeout and reset state
        if (this.reasoningBuffer.timeout) {
            clearTimeout(this.reasoningBuffer.timeout);
            this.reasoningBuffer.timeout = null;
        }
        this.reasoningBuffer.content = '';
        this.reasoningBuffer.messageId = null;

        // Stop typewriter animation
        this.stopTypewriter();

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
     * If the message already exists in DOM (e.g., from streamingPending placeholder), replaces it.
     * @param {Object} message - The message object to append
     */
    async appendMessage(message) {
        const messagesContainer = this.app.elements.messagesContainer;
        const session = this.app.getCurrentSession();

        if (!session) return;

        // Remove any typing indicators (including restored ones from render())
        messagesContainer.querySelectorAll('[id^="typing-"]').forEach(el => el.remove());

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

        // Check if message already exists in DOM (e.g., from streamingPending placeholder)
        const existingMessageEl = messagesContainer.querySelector(`[data-message-id="${message.id}"]`);
        if (existingMessageEl) {
            // Replace existing element instead of appending duplicate
            const tempDiv = document.createElement('div');
            tempDiv.innerHTML = messageHtml;
            const newMessageEl = tempDiv.firstElementChild;
            if (newMessageEl) {
                existingMessageEl.replaceWith(newMessageEl);
                // Re-run LaTeX on the replaced element
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
                // Scroll to bottom and update navigation
                this.scrollToBottom();
                this.app.updateScrollButtonVisibility();
                if (this.app.messageNavigation) {
                    this.app.messageNavigation.update();
                }
                return;
            }
        }

        // Append the message (normal case - no existing element)
        messagesContainer.insertAdjacentHTML('beforeend', messageHtml);

        // Render LaTeX only for the new message and add fade-in animation
        const newMessageEl = messagesContainer.querySelector(`[data-message-id="${message.id}"]`);
        if (newMessageEl) {
            // Add fade-in animation for newly appended messages
            newMessageEl.classList.add('fade-in');
            // Also add to reasoning trace if present
            const reasoningTrace = newMessageEl.querySelector('.reasoning-trace');
            if (reasoningTrace) {
                reasoningTrace.classList.add('fade-in');
            }

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
     * When reasoning is already finalized, does targeted updates to avoid flash.
     * @param {Object} message - The completed message object
     */
    async finalizeStreamingMessage(message) {
        const messageEl = document.querySelector(`[data-message-id="${message.id}"]`);
        if (!messageEl) return;

        // Check if reasoning trace is already finalized (subtitle shows duration, not streaming)
        const existingReasoningTrace = messageEl.querySelector('.reasoning-trace');
        const existingSubtitle = existingReasoningTrace?.querySelector(`#reasoning-subtitle-${message.id}`);
        const isReasoningFinalized = existingSubtitle &&
            !existingSubtitle.classList.contains('reasoning-subtitle-streaming') &&
            existingSubtitle.textContent.startsWith('Thought for');

        // If reasoning is finalized, do targeted updates instead of full replacement
        // This prevents flash by not touching the reasoning trace DOM at all
        if (isReasoningFinalized) {
            // Just update the content element if it exists
            const contentEl = messageEl.querySelector('.message-content');
            if (contentEl && message.content) {
                // Remove streaming class to re-enable hover effects
                contentEl.classList.remove('streaming');

                // Process content with the full pipeline (same as buildAssistantMessage)
                let processedContent = message.content;

                // Insert raw citation markers before LaTeX processing
                if (message.citations && message.citations.length > 0) {
                    processedContent = window.MessageTemplates.insertRawCitationMarkers(processedContent, message.citations);
                }

                // Process LaTeX/Markdown
                processedContent = this.app.processContentWithLatex(processedContent);

                // Style citation markers into clickable elements
                if (message.citations && message.citations.length > 0) {
                    processedContent = window.MessageTemplates.addInlineCitationMarkers(processedContent, message.id);
                }

                // Enhance inline links into styled buttons
                processedContent = window.MessageTemplates.enhanceInlineLinks(processedContent, message.id);

                contentEl.innerHTML = processedContent;
                renderMathInElement(contentEl, {
                    delimiters: [
                        {left: '$$', right: '$$', display: true},
                        {left: '\\[', right: '\\]', display: true},
                        {left: '\\(', right: '\\)', display: false}
                    ],
                    throwOnError: false
                });
            }

            // Setup citation carousel if citations were added
            if (message.citations && message.citations.length > 0) {
                this.setupCitationCarouselScroll();
            }

            // Update message navigation to reflect final content (fixes preview + indicator height)
            if (this.app.messageNavigation) {
                this.app.messageNavigation.update();
            }
            return;
        }

        // Full replacement for messages without finalized reasoning
        const session = this.app.getCurrentSession();
        const helpers = {
            processContentWithLatex: this.app.processContentWithLatex.bind(this.app),
            formatTime: this.app.formatTime.bind(this.app)
        };

        const newMessageHtml = window.buildMessageHTML(message, helpers, this.app.state.models, session?.model);
        const tempDiv = document.createElement('div');
        tempDiv.innerHTML = newMessageHtml;
        const newMessageEl = tempDiv.firstElementChild;

        if (newMessageEl) {
            messageEl.parentElement.replaceChild(newMessageEl, messageEl);
            renderMathInElement(newMessageEl, {
                delimiters: [
                    {left: '$$', right: '$$', display: true},
                    {left: '\\[', right: '\\]', display: true},
                    {left: '\\(', right: '\\)', display: false}
                ],
                throwOnError: false
            });
            this.setupCitationCarouselScroll();
        }

        // Update message navigation to reflect final content (fixes preview + indicator height)
        if (this.app.messageNavigation) {
            this.app.messageNavigation.update();
        }
    }

    /**
     * Attaches click handler to the download chats link in the empty state.
     */
    attachDownloadHandler() {
        const downloadLink = document.querySelector('a[href="#download-chats-link"]');
        if (downloadLink && downloadLink.dataset.downloadChatsBound !== 'true') {
            downloadLink.dataset.downloadChatsBound = 'true';
            downloadLink.addEventListener('click', async (e) => {
                e.preventDefault();
                const success = await exportChats();
                if (!success) {
                    console.error('Failed to download chat history');
                }
            });
        }

        const exportLink = document.querySelector('a[href="#download-tickets-link"]');
        if (exportLink && exportLink.dataset.downloadTicketsBound !== 'true') {
            exportLink.dataset.downloadTicketsBound = 'true';
            exportLink.addEventListener('click', async (e) => {
                e.preventDefault();
                const success = await exportTickets();
                if (!success) {
                    console.error('Failed to export inference tickets');
                }
            });
        }
    }

    /**
     * Schedules auto-grow using requestAnimationFrame for debouncing.
     * Prevents layout thrashing when pasting text rapidly.
     * @param {HTMLTextAreaElement} textarea - The textarea element to resize
     */
    scheduleAutoGrow(textarea) {
        // Cancel any pending frame to debounce rapid inputs
        if (this.pendingAutoGrowFrame) {
            cancelAnimationFrame(this.pendingAutoGrowFrame);
        }
        // Schedule the resize for the next animation frame
        this.pendingAutoGrowFrame = requestAnimationFrame(() => {
            this.pendingAutoGrowFrame = null;
            this.autoGrowTextarea(textarea);
        });
    }

    /**
     * Auto-grows a textarea to fit its content while respecting min/max heights.
     * Works alongside CSS resize-y for manual drag resizing.
     * Uses overflow:hidden technique to avoid visual glitches with resizer.
     * @param {HTMLTextAreaElement} textarea - The textarea element to resize
     */
    autoGrowTextarea(textarea) {
        if (!textarea) return;
        // Temporarily hide overflow to prevent visual glitches during resize
        const prevOverflow = textarea.style.overflow;
        textarea.style.overflow = 'hidden';
        // Reset to minimum to get true scrollHeight
        textarea.style.height = '0';
        // Set height to scrollHeight, respecting CSS min-height (80px via CSS)
        const newHeight = Math.max(textarea.scrollHeight, 80);
        textarea.style.height = newHeight + 'px';
        // Restore overflow for manual resize capability
        textarea.style.overflow = prevOverflow || '';
    }

    /**
     * Updates the edit model picker button content to sync with the main model picker.
     * Called after render when editing a message.
     */
    updateEditModelPickerButton() {
        const editModelPickerBtn = document.getElementById('edit-model-picker-btn');
        if (!editModelPickerBtn) return;

        // Get the main model picker button's inner HTML (except the keyboard shortcut)
        const mainBtn = this.app.elements.modelPickerBtn;
        if (!mainBtn) return;

        // Extract icon and model name from main button
        const iconDiv = mainBtn.querySelector('.w-5.h-5');
        const modelNameSpan = mainBtn.querySelector('.model-name-container');

        if (iconDiv && modelNameSpan) {
            editModelPickerBtn.innerHTML = `
                ${iconDiv.outerHTML}
                <span class="model-name-container min-w-0 truncate">${modelNameSpan.textContent}</span>
            `;
        }
    }

    /**
     * Initializes the edit form after it's rendered.
     * Sets up auto-grow and syncs the model picker button.
     */
    initializeEditForm() {
        const textarea = document.querySelector('.edit-prompt-textarea');
        if (textarea) {
            // Auto-grow on initial render
            this.autoGrowTextarea(textarea);
        }
        // Sync the model picker button
        this.updateEditModelPickerButton();
    }
}
