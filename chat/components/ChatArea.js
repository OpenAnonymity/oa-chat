/**
 * ChatArea Component
 * Manages the main chat messages area including rendering messages,
 * scroll behaviors, and LaTeX rendering.
 */

import { buildMessageHTML, buildEmptyState, buildSharedIndicator, buildImportedIndicator, buildTypingIndicator, buildReasoningTrace, RAW_CLIPBOARD_ATTRIBUTE_ENABLED } from './MessageTemplates.js';
import { exportChats, exportTickets } from '../services/globalExport.js';
import { parseStreamingReasoningContent, parseReasoningContent } from '../services/reasoningParser.js';
import { buildQuickAskQuestion, normalizeQuickAskSelection } from '../domain/quickAsk.js';

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
        // Pointer-down copy is used for streaming code blocks because token updates
        // can replace the DOM before a normal click event fires.
        this.streamingCodeCopyPointerWindowMs = 1200;
        // Render generation counter - used to cancel stale renders during rapid session switching
        this.renderGeneration = 0;
        this.memoryPromptModal = null;
        this.memoryPromptModalKeyHandler = null;
        this.quickAsk = {
            popover: null,
            window: null,
            selectedText: '',
            question: '',
            messageId: '',
            activeKey: '',
            selectionRect: null,
            windowAnchor: null,
            abortController: null,
            activeRequestId: 0,
            requestInFlight: false
        };
        this.setupEventListeners();
    }

    /**
     * Sets up event listeners for message actions (copy, regenerate, edit, fork)
     * Uses event delegation for dynamically added messages
     */
    setupEventListeners() {
        const messagesContainer = this.app.elements.messagesContainer;

        messagesContainer.addEventListener('pointerdown', (e) => {
            const codeBlockCopyBtn = e.target.closest('.code-block-copy-btn');
            if (!codeBlockCopyBtn) return;
            if (typeof e.button === 'number' && e.button !== 0) return;

            const messageEl = codeBlockCopyBtn.closest('[data-message-id]');
            const messageId = messageEl?.dataset.messageId;
            if (!messageId || !this.isMessageStreamingInDOM(messageId)) {
                return;
            }

            e.preventDefault();
            this.handleCopyCodeBlock(codeBlockCopyBtn);
            codeBlockCopyBtn.dataset.pointerCopyHandledAt = String(Date.now());
        });

        // Event delegation for message action buttons
        messagesContainer.addEventListener('click', async (e) => {
            const removeEditAttachmentBtn = e.target.closest('.remove-edit-attachment-btn');
            if (removeEditAttachmentBtn) {
                e.preventDefault();
                const messageId = removeEditAttachmentBtn.dataset.messageId;
                const index = Number(removeEditAttachmentBtn.dataset.attachmentIndex);
                await this.app.removeEditAttachment?.(messageId, index);
                return;
            }

            const addEditFilesBtn = e.target.closest('.edit-add-files-btn, .edit-add-files-label');
            if (addEditFilesBtn) {
                e.preventDefault();
                const input = addEditFilesBtn.closest('.edit-prompt-form')?.querySelector('.edit-file-input');
                input?.click();
                return;
            }

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
                const pointerCopyHandledAt = Number(codeBlockCopyBtn.dataset.pointerCopyHandledAt || 0);
                if (pointerCopyHandledAt &&
                    (Date.now() - pointerCopyHandledAt) < this.streamingCodeCopyPointerWindowMs) {
                    delete codeBlockCopyBtn.dataset.pointerCopyHandledAt;
                    e.preventDefault();
                    return;
                }
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

            const memoryApprovalBtn = e.target.closest('.memory-approval-btn');
            if (memoryApprovalBtn) {
                const messageId = memoryApprovalBtn.dataset.messageId;
                const decision = memoryApprovalBtn.dataset.decision;
                await this.app.handleMemoryApprovalDecision(messageId, decision);
                return;
            }

            const memoryPreviewBtn = e.target.closest('.memory-preview-btn');
            if (memoryPreviewBtn) {
                const messageId = memoryPreviewBtn.dataset.messageId;
                const userMessageId = memoryPreviewBtn.dataset.userMessageId;
                await this.handleMemoryPromptPreview(messageId, userMessageId);
                return;
            }

            const memFileLink = e.target.closest('.mem-prompt-file[data-mem-file]');
            if (memFileLink) {
                e.preventDefault();
                const filePath = memFileLink.dataset.memFile;
                if (filePath && this.app.memoryEditor) {
                    await this.app.memoryEditor.openToFile(filePath);
                }
                return;
            }

            const scrubberBtn = e.target.closest('.scrubber-restore-btn');
            if (scrubberBtn) {
                const messageId = scrubberBtn.dataset.messageId;
                await this.handleScrubberRestore(messageId);
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
                await this.handleResendMessage(messageId, resendBtn);
                return;
            }

            const toggleScrubberBtn = e.target.closest('.toggle-scrubber-btn');
            if (toggleScrubberBtn) {
                const messageId = toggleScrubberBtn.dataset.messageId;
                await this.handleToggleScrubber(messageId);
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
                this.app.updateEditDraftContent?.(textarea.dataset.messageId, textarea.value);
                this.scheduleAutoGrow(textarea);
            }
        });

        messagesContainer.addEventListener('change', async (e) => {
            const input = e.target.closest('.edit-file-input');
            if (!input) return;
            const messageId = input.dataset.messageId;
            const files = Array.from(input.files || []);
            input.value = '';
            if (files.length > 0) {
                await this.app.handleEditFileUpload?.(messageId, files);
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

        messagesContainer.addEventListener('mouseup', () => {
            window.setTimeout(() => this.maybeShowQuickAskPopover(), 0);
        });

        messagesContainer.addEventListener('keyup', (e) => {
            if (e.key === 'Shift' || e.key.startsWith('Arrow') || e.key === 'Home' || e.key === 'End') {
                window.setTimeout(() => this.maybeShowQuickAskPopover(), 0);
            }
        });

        messagesContainer.addEventListener('touchend', () => {
            window.setTimeout(() => this.maybeShowQuickAskPopover(), 0);
        });

        document.addEventListener('selectionchange', () => {
            const selection = window.getSelection();
            if (!selection || selection.isCollapsed || !selection.toString().trim()) {
                this.hideQuickAskPopover();
            }
        });

        document.addEventListener('pointerdown', (e) => {
            if (e.target.closest?.('.quick-ask-popover, .quick-ask-window')) return;
            if (this.quickAsk.window && !this.quickAsk.window.classList.contains('hidden')) {
                this.closeQuickAskWindow();
            }
            if (!e.target.closest?.('#messages-container .message-content')) {
                this.hideQuickAskPopover();
            }
        }, true);

        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                this.hideQuickAskPopover();
                if (this.quickAsk.window) {
                    this.closeQuickAskWindow();
                }
            }
        });

        window.addEventListener('resize', () => this.hideQuickAskPopover());
        this.app.elements.chatArea?.addEventListener('scroll', () => {
            this.hideQuickAskPopover();
            this.syncQuickAskWindowToScroll();
        }, { passive: true });
    }

    getAssistantSelectionData() {
        const selection = window.getSelection();
        if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null;

        const selectedText = normalizeQuickAskSelection(selection.toString());
        if (!selectedText) return null;

        const range = selection.getRangeAt(0);
        const commonNode = range.commonAncestorContainer;
        const commonEl = commonNode.nodeType === Node.ELEMENT_NODE
            ? commonNode
            : commonNode.parentElement;
        const contentEl = commonEl?.closest?.('.message-content');
        if (!contentEl || contentEl.closest('.quick-ask-window')) return null;

        const messageEl = contentEl.closest('[data-message-id]');
        if (!messageEl || !messageEl.querySelector('.message-assistant')) return null;
        if (messageEl.dataset.scrubberRestored === 'true') return null;

        let rect = range.getBoundingClientRect();
        if (!rect || (rect.width === 0 && rect.height === 0)) {
            rect = range.getClientRects()[0];
        }
        if (!rect) return null;

        return {
            selectedText,
            messageId: messageEl.dataset.messageId || '',
            rect: {
                top: rect.top,
                right: rect.right,
                bottom: rect.bottom,
                left: rect.left,
                width: rect.width,
                height: rect.height
            }
        };
    }

    maybeShowQuickAskPopover() {
        if (this.quickAsk.window &&
            !this.quickAsk.window.classList.contains('hidden') &&
            this.quickAsk.window.contains(document.activeElement)) return;

        const selectionData = this.getAssistantSelectionData();
        if (!selectionData) {
            this.hideQuickAskPopover();
            return;
        }

        this.quickAsk.selectedText = selectionData.selectedText;
        this.quickAsk.question = buildQuickAskQuestion(selectionData.selectedText);
        this.quickAsk.messageId = selectionData.messageId;
        this.quickAsk.selectionRect = selectionData.rect;

        const popover = this.ensureQuickAskPopover();
        popover.classList.remove('hidden');
        popover.setAttribute('aria-hidden', 'false');
        this.positionQuickAskPopover(popover, selectionData.rect);
        this.updateQuickAskLayerState();
    }

    ensureQuickAskPopover() {
        if (this.quickAsk.popover) return this.quickAsk.popover;

        const popover = document.createElement('div');
        popover.className = 'quick-ask-popover hidden';
        popover.setAttribute('aria-hidden', 'true');
        popover.innerHTML = `
            <button type="button" class="quick-ask-popover-btn">
                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.7" stroke="currentColor" class="w-3.5 h-3.5">
                    <path stroke-linecap="round" stroke-linejoin="round" d="M9.879 7.519c1.171-1.025 3.071-1.025 4.242 0 1.172 1.025 1.172 2.687 0 3.712-.203.178-.43.326-.67.442-.745.361-1.45.999-1.45 1.827v.75M12 17.25h.008v.008H12v-.008Z" />
                    <path stroke-linecap="round" stroke-linejoin="round" d="M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z" />
                </svg>
                <span>Ask</span>
            </button>
        `;
        popover.querySelector('.quick-ask-popover-btn')?.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            this.openQuickAskWindow();
        });
        document.body.appendChild(popover);
        this.quickAsk.popover = popover;
        return popover;
    }

    positionQuickAskPopover(popover, rect) {
        const margin = 8;
        const width = popover.offsetWidth || 76;
        const height = popover.offsetHeight || 36;
        const centerX = rect.left + (rect.width / 2);
        const left = Math.min(
            Math.max(margin, centerX - (width / 2)),
            window.innerWidth - width - margin
        );
        const top = rect.top - height - margin > margin
            ? rect.top - height - margin
            : rect.bottom + margin;

        Object.assign(popover.style, {
            left: `${left}px`,
            top: `${Math.min(Math.max(margin, top), window.innerHeight - height - margin)}px`
        });
    }

    hideQuickAskPopover() {
        const popover = this.quickAsk.popover;
        if (!popover) return;
        popover.classList.add('hidden');
        popover.setAttribute('aria-hidden', 'true');
        this.updateQuickAskLayerState();
    }

    getQuickAskKey(selectedText = this.quickAsk.selectedText, messageId = this.quickAsk.messageId) {
        const sessionId = this.app.getCurrentSession?.()?.id || '';
        return [sessionId, messageId || '', selectedText || ''].join('::');
    }

    openQuickAskWindow() {
        const selectedText = this.quickAsk.selectedText;
        if (!selectedText) return;

        this.hideQuickAskPopover();
        window.getSelection()?.removeAllRanges();
        const key = this.getQuickAskKey(selectedText);
        const panel = this.ensureQuickAskWindow();
        if (this.quickAsk.activeKey && this.quickAsk.activeKey === key) {
            panel.classList.remove('hidden');
            panel.setAttribute('aria-hidden', 'false');
            this.positionQuickAskWindow(panel, this.quickAsk.selectionRect);
            this.updateQuickAskLayerState();
            return;
        }

        this.quickAsk.abortController?.abort();
        this.quickAsk.abortController = new AbortController();
        this.quickAsk.activeRequestId += 1;
        const requestId = this.quickAsk.activeRequestId;
        this.quickAsk.question = buildQuickAskQuestion(selectedText);
        this.quickAsk.activeKey = key;

        panel.classList.remove('hidden');
        panel.setAttribute('aria-hidden', 'false');
        this.updateQuickAskLayerState();
        panel.querySelector('.quick-ask-user-bubble').textContent = this.quickAsk.question;
        panel.querySelector('.quick-ask-status').textContent = '';
        this.updateQuickAskReasoning('');
        this.updateQuickAskCitations(null);
        this.updateQuickAskAnswer('', { pending: true, status: 'Waiting for response' });
        this.positionQuickAskWindow(panel, this.quickAsk.selectionRect);
        this.startQuickAskRequest(requestId);
    }

    ensureQuickAskWindow() {
        if (this.quickAsk.window) {
            if (!this.quickAsk.window.isConnected ||
                this.quickAsk.window.parentElement !== document.body) {
                document.body.appendChild(this.quickAsk.window);
            }
            return this.quickAsk.window;
        }

        const panel = document.createElement('section');
        panel.className = 'quick-ask-window hidden';
        panel.setAttribute('role', 'dialog');
        panel.setAttribute('aria-label', 'Inline quick ask');
        panel.setAttribute('aria-hidden', 'true');
        panel.innerHTML = `
            <div class="quick-ask-mini-chat" tabindex="-1">
                <div class="quick-ask-turn quick-ask-turn-user">
                    <div class="quick-ask-user-bubble message-user py-3 px-4 font-normal max-w-full"></div>
                </div>
                <div class="quick-ask-turn quick-ask-turn-assistant">
                    <div class="quick-ask-assistant-bubble message-assistant">
                        <div class="quick-ask-status"></div>
                        <div class="quick-ask-reasoning hidden"></div>
                        <div class="quick-ask-answer message-content prose"></div>
                        <div class="quick-ask-sources hidden"></div>
                    </div>
                </div>
            </div>
        `;
        panel.addEventListener('click', (e) => {
            const codeBlockCopyBtn = e.target.closest('.code-block-copy-btn');
            if (!codeBlockCopyBtn) return;
            e.preventDefault();
            this.handleCopyCodeBlock(codeBlockCopyBtn);
        });
        document.body.appendChild(panel);
        this.quickAsk.window = panel;
        return panel;
    }

    syncQuickAskWindowToScroll() {
        if (!this.quickAsk.window ||
            this.quickAsk.window.classList.contains('hidden') ||
            !this.quickAsk.windowAnchor) return;
        this.positionQuickAskWindow(this.quickAsk.window, null, { preserveAnchor: true });
    }

    positionQuickAskWindow(panel, rect, options = {}) {
        const margin = 16;
        const chatArea = this.app.elements.chatArea;
        const scrollTop = chatArea?.scrollTop || 0;
        const scrollLeft = chatArea?.scrollLeft || 0;
        const chatAreaRect = chatArea?.getBoundingClientRect();
        const panelRect = panel.getBoundingClientRect();
        const width = panelRect.width || Math.min(520, window.innerWidth - (margin * 2));
        const height = panelRect.height || 360;

        if (options.preserveAnchor && this.quickAsk.windowAnchor) {
            const anchoredLeft = (chatAreaRect?.left || 0) + this.quickAsk.windowAnchor.left - scrollLeft;
            const anchoredTop = (chatAreaRect?.top || 0) + this.quickAsk.windowAnchor.top - scrollTop;
            const isInChatViewport = !chatAreaRect ||
                (anchoredTop + height > chatAreaRect.top && anchoredTop < chatAreaRect.bottom);

            Object.assign(panel.style, {
                left: `${anchoredLeft}px`,
                top: `${anchoredTop}px`,
                visibility: isInChatViewport ? '' : 'hidden'
            });
            return;
        }

        const sourceRect = rect || {
            left: window.innerWidth / 2,
            right: window.innerWidth / 2,
            top: window.innerHeight / 3,
            bottom: window.innerHeight / 3,
            width: 0,
            height: 0
        };
        const centerX = sourceRect.left + ((sourceRect.width || 0) / 2);
        const left = Math.min(
            Math.max(margin, centerX - (width / 2)),
            window.innerWidth - width - margin
        );
        const belowTop = sourceRect.bottom + margin;
        const aboveTop = sourceRect.top - height - margin;
        const top = belowTop + height <= window.innerHeight - margin
            ? belowTop
            : Math.max(margin, aboveTop);
        const clampedTop = Math.min(Math.max(margin, top), window.innerHeight - height - margin);

        Object.assign(panel.style, {
            left: `${left}px`,
            top: `${clampedTop}px`,
            visibility: ''
        });
        this.quickAsk.windowAnchor = {
            left: left - (chatAreaRect?.left || 0) + scrollLeft,
            top: clampedTop - (chatAreaRect?.top || 0) + scrollTop
        };
    }

    async startQuickAskRequest(requestId) {
        this.quickAsk.requestInFlight = true;
        try {
            await this.app.inlineQuickAsk(this.quickAsk.selectedText, {
                abortController: this.quickAsk.abortController,
                onStatus: (status) => {
                    if (requestId !== this.quickAsk.activeRequestId) return;
                    this.updateQuickAskStatus(status);
                },
                onChunk: (content) => {
                    if (requestId !== this.quickAsk.activeRequestId) return;
                    this.updateQuickAskAnswer(content);
                },
                onReasoningChunk: (reasoning) => {
                    if (requestId !== this.quickAsk.activeRequestId) return;
                    this.updateQuickAskReasoning(reasoning, { streaming: true });
                },
                onDone: (result) => {
                    if (requestId !== this.quickAsk.activeRequestId) return;
                    this.updateQuickAskReasoning(result.reasoning || '');
                    this.updateQuickAskAnswer(result.content || '[Model provider returned no response.]');
                    this.updateQuickAskCitations(result.citations || null);
                }
            });
        } catch (error) {
            if (requestId !== this.quickAsk.activeRequestId) return;
            if (error?.isCancelled || this.quickAsk.abortController?.signal.aborted) {
                this.updateQuickAskStatus('stopped');
                return;
            }
            this.updateQuickAskError(error?.message || 'Quick ask failed.');
        } finally {
            if (requestId === this.quickAsk.activeRequestId) {
                this.quickAsk.requestInFlight = false;
            }
        }
    }

    updateQuickAskStatus(status) {
        const labelByStatus = {
            'requesting-key': 'Requesting ephemeral key',
            'waiting-response': 'Waiting for response',
            'stream-open': 'Waiting for response',
            streaming: '',
            stopped: ''
        };
        const label = labelByStatus[status] ?? status ?? '';
        const statusEl = this.quickAsk.window?.querySelector('.quick-ask-status');
        if (statusEl) {
            statusEl.textContent = '';
            statusEl.classList.remove('pending-response-streaming');
        }
        if (label) {
            const answerEl = this.quickAsk.window?.querySelector('.quick-ask-answer');
            const hasAnswerContent = answerEl && answerEl.textContent.trim() && !answerEl.querySelector('.pending-response-line');
            if (!hasAnswerContent) {
                this.updateQuickAskAnswer('', { pending: true, status: label });
            }
        }
    }

    updateQuickAskAnswer(content, options = {}) {
        const answerEl = this.quickAsk.window?.querySelector('.quick-ask-answer');
        if (!answerEl) return;
        const assistantBubble = answerEl.closest('.quick-ask-assistant-bubble');

        if (options.pending && !content) {
            assistantBubble?.classList.add('quick-ask-assistant-pending');
            answerEl.innerHTML = `
                <div class="pending-response-line">
                    <span class="pending-response-label pending-response-streaming">${this.escapeHtml(options.status || 'Waiting for response')}</span>
                </div>
            `;
            return;
        }

        assistantBubble?.classList.remove('quick-ask-assistant-pending');
        this.updateQuickAskStatus(content ? '' : options.status);
        answerEl.innerHTML = this.app.processContentWithLatex(content || '');
        renderMathInElement(answerEl, {
            delimiters: [
                {left: '$$', right: '$$', display: true},
                {left: '\\[', right: '\\]', display: true},
                {left: '\\(', right: '\\)', display: false}
            ],
            throwOnError: false
        });
        const miniChat = this.quickAsk.window?.querySelector('.quick-ask-mini-chat');
        if (miniChat) {
            miniChat.scrollTop = miniChat.scrollHeight;
        }
    }

    updateQuickAskReasoning(reasoning, options = {}) {
        const reasoningEl = this.quickAsk.window?.querySelector('.quick-ask-reasoning');
        if (!reasoningEl) return;
        const text = typeof reasoning === 'string' ? reasoning.trim() : '';
        if (!text) {
            reasoningEl.classList.add('hidden');
            reasoningEl.innerHTML = '';
            return;
        }

        reasoningEl.classList.remove('hidden');
        reasoningEl.innerHTML = buildReasoningTrace(
            text,
            `quick-ask-inline-${this.quickAsk.activeRequestId}`,
            !!options.streaming,
            this.app.processContentWithLatex.bind(this.app)
        );
        renderMathInElement(reasoningEl, {
            delimiters: [
                {left: '$$', right: '$$', display: true},
                {left: '\\[', right: '\\]', display: true},
                {left: '\\(', right: '\\)', display: false}
            ],
            throwOnError: false
        });
    }

    updateQuickAskCitations(citations) {
        const sourcesEl = this.quickAsk.window?.querySelector('.quick-ask-sources');
        if (!sourcesEl) return;
        const items = Array.isArray(citations) ? citations.filter(citation => citation?.url) : [];
        if (items.length === 0) {
            sourcesEl.classList.add('hidden');
            sourcesEl.innerHTML = '';
            return;
        }

        const links = items.slice(0, 5).map((citation, index) => {
            let safeUrl = '';
            try {
                const parsed = new URL(citation.url);
                if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
                    safeUrl = parsed.href;
                }
            } catch {
                safeUrl = '';
            }
            const label = citation.title || citation.domain || citation.url;
            const prefix = `${index + 1}. `;
            if (!safeUrl) {
                return `<span class="quick-ask-source">${this.escapeHtml(prefix + label)}</span>`;
            }
            return `<a class="quick-ask-source" href="${this.escapeHtml(safeUrl)}" target="_blank" rel="noopener noreferrer">${this.escapeHtml(prefix + label)}</a>`;
        }).join('');

        sourcesEl.classList.remove('hidden');
        sourcesEl.innerHTML = `
            <div class="quick-ask-sources-label">${items.length} source${items.length === 1 ? '' : 's'}</div>
            <div class="quick-ask-sources-list">${links}</div>
        `;
    }

    updateQuickAskError(message) {
        const answerEl = this.quickAsk.window?.querySelector('.quick-ask-answer');
        if (!answerEl) return;
        this.updateQuickAskStatus('');
        this.updateQuickAskReasoning('');
        this.updateQuickAskCitations(null);
        answerEl.closest('.quick-ask-assistant-bubble')?.classList.remove('quick-ask-assistant-pending');
        answerEl.innerHTML = `<p><strong>Error:</strong> ${this.escapeHtml(message)}</p>`;
    }

    closeQuickAskWindow(options = {}) {
        const { abort = false, reset = false } = options;
        if (abort) {
            this.quickAsk.abortController?.abort();
            this.quickAsk.abortController = null;
            this.quickAsk.activeRequestId += 1;
            this.quickAsk.requestInFlight = false;
        }
        if (this.quickAsk.window) {
            this.quickAsk.window.classList.add('hidden');
            this.quickAsk.window.setAttribute('aria-hidden', 'true');
            this.updateQuickAskLayerState();
        }
        if (reset) {
            this.quickAsk.selectedText = '';
            this.quickAsk.question = '';
            this.quickAsk.messageId = '';
            this.quickAsk.activeKey = '';
            this.quickAsk.selectionRect = null;
            this.quickAsk.windowAnchor = null;
        }
    }

    updateQuickAskLayerState() {
        const popoverVisible = this.quickAsk.popover && !this.quickAsk.popover.classList.contains('hidden');
        const windowVisible = this.quickAsk.window && !this.quickAsk.window.classList.contains('hidden');
        document.body.classList.toggle('quick-ask-layer-active', Boolean(popoverVisible || windowVisible));
    }

    getQuickAskActiveSessionId() {
        return this.quickAsk.activeKey ? this.quickAsk.activeKey.split('::')[0] || '' : '';
    }

    shouldPreserveQuickAskWindowForRender(sessionId) {
        return Boolean(
            sessionId &&
            this.quickAsk.window &&
            this.quickAsk.activeKey &&
            this.getQuickAskActiveSessionId() === sessionId
        );
    }

    detachQuickAskWindowForRender(sessionId) {
        if (!this.shouldPreserveQuickAskWindowForRender(sessionId)) return null;
        const panel = this.quickAsk.window;
        if (panel.isConnected) {
            panel.remove();
        }
        return panel;
    }

    restoreQuickAskWindowAfterRender(panel, sessionId) {
        if (!panel || panel !== this.quickAsk.window) return;
        if (!this.shouldPreserveQuickAskWindowForRender(sessionId)) return;

        if (!panel.isConnected ||
            panel.parentElement !== document.body) {
            document.body.appendChild(panel);
        }
    }

    /**
     * Immediately renders the empty state without async loads.
     * Desktop hooks can call this to avoid intermediate flashes.
     */
    renderEmptyStateImmediate() {
        const messagesContainer = this.app.elements.messagesContainer;
        if (!messagesContainer) return;
        messagesContainer.innerHTML = buildEmptyState();
        this.attachDownloadHandler();
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
            const contentClone = contentEl.cloneNode(true);
            contentClone.querySelectorAll('.code-block-copy-btn').forEach(el => el.remove());
            return contentClone.innerText || contentClone.textContent;
        }
        return null;
    }

    /**
     * Checks whether a message is actively streaming in the current DOM.
     * @param {string} messageId - The message ID
     * @returns {boolean} True when the DOM is still in a streaming state
     */
    isMessageStreamingInDOM(messageId) {
        const messageEl = document.querySelector(`[data-message-id="${messageId}"]`);
        if (!messageEl) return false;

        return !!(
            messageEl.querySelector('.message-content.streaming, .reasoning-content.streaming') ||
            messageEl.querySelector('.pending-response-label')
        );
    }

    /**
     * Gets raw message content from a data attribute (sync, Safari-safe).
     * @param {string} messageId - The message ID
     * @returns {string|null} The raw content or null
     */
    getMessageRawFromDOM(messageId) {
        if (!RAW_CLIPBOARD_ATTRIBUTE_ENABLED) return null;
        const messageEl = document.querySelector(`[data-message-id="${messageId}"]`);
        if (!messageEl) return null;

        const rawContent = messageEl.dataset.rawContent;
        if (rawContent && rawContent.trim()) {
            return rawContent;
        }
        return null;
    }

    isStreamingCodeBlockNode(node) {
        return node?.nodeType === Node.ELEMENT_NODE &&
            node.classList.contains('code-block-wrapper');
    }

    areStreamingNodesEquivalent(currentNode, nextNode) {
        if (!currentNode || !nextNode || currentNode.nodeType !== nextNode.nodeType) {
            return false;
        }

        if (currentNode.nodeType === Node.TEXT_NODE) {
            return currentNode.textContent === nextNode.textContent;
        }

        return currentNode.outerHTML === nextNode.outerHTML;
    }

    syncStreamingCodeBlock(currentNode, nextNode) {
        const currentLang = currentNode.querySelector('.code-block-lang');
        const nextLang = nextNode.querySelector('.code-block-lang');
        if (currentLang && nextLang) {
            currentLang.textContent = nextLang.textContent;
        }

        const currentCopyBtn = currentNode.querySelector('.code-block-copy-btn');
        const nextCopyBtn = nextNode.querySelector('.code-block-copy-btn');
        if (currentCopyBtn && nextCopyBtn) {
            currentCopyBtn.dataset.code = nextCopyBtn.dataset.code || '';

            const isShowingCopyFeedback = currentCopyBtn.dataset.copyFeedbackActive === 'true';
            if (!isShowingCopyFeedback) {
                const currentText = currentCopyBtn.querySelector('.copy-text');
                const nextText = nextCopyBtn.querySelector('.copy-text');
                if (currentText && nextText) {
                    currentText.textContent = nextText.textContent;
                }

                const currentIcon = currentCopyBtn.querySelector('.copy-icon');
                const nextIcon = nextCopyBtn.querySelector('.copy-icon');
                if (currentIcon && nextIcon) {
                    currentIcon.innerHTML = nextIcon.innerHTML;
                }
            }
        }

        const currentCode = currentNode.querySelector('pre code');
        const nextCode = nextNode.querySelector('pre code');
        if (currentCode && nextCode) {
            currentCode.className = nextCode.className;
            currentCode.innerHTML = nextCode.innerHTML;
        }
    }

    patchStreamingContent(contentEl, processedContent) {
        const tempContainer = document.createElement('div');
        tempContainer.innerHTML = processedContent;
        const nextChildren = Array.from(tempContainer.childNodes);

        for (let index = 0; index < nextChildren.length; index++) {
            const nextNode = nextChildren[index];
            const currentNode = contentEl.childNodes[index];

            if (!currentNode) {
                contentEl.appendChild(nextNode);
                continue;
            }

            if (this.isStreamingCodeBlockNode(currentNode) && this.isStreamingCodeBlockNode(nextNode)) {
                this.syncStreamingCodeBlock(currentNode, nextNode);
                continue;
            }

            if (this.areStreamingNodesEquivalent(currentNode, nextNode)) {
                continue;
            }

            contentEl.insertBefore(nextNode, currentNode);
            currentNode.remove();
        }

        while (contentEl.childNodes.length > nextChildren.length) {
            contentEl.lastChild?.remove();
        }
    }

    /**
     * Handles copying the content of a message.
     * Prioritizes Safari-safe raw DOM data when enabled, else DB-first.
     * @param {string} messageId - The message ID to copy
     */
    async handleCopyMessage(messageId) {
        const session = this.app.getCurrentSession();
        if (!session) return;

        const isLiveStreamingMessage = this.isMessageStreamingInDOM(messageId);

        // During streaming, the DOM can be ahead of the latest IndexedDB save.
        // Prefer the live DOM snapshot so copy matches what the user can see.
        if (isLiveStreamingMessage) {
            const rawContent = this.getMessageRawFromDOM(messageId);
            if (rawContent && rawContent.trim()) {
                this.copyToClipboard(rawContent);
                this.showCopySuccess(messageId);
                return;
            }

            const domContent = this.getMessageTextFromDOM(messageId);
            if (domContent && domContent.trim()) {
                this.copyToClipboard(domContent);
                this.showCopySuccess(messageId);
                return;
            }
        }

        if (RAW_CLIPBOARD_ATTRIBUTE_ENABLED) {
            // Try raw content from DOM data attributes (sync, preserves Safari user activation).
            const rawContent = this.getMessageRawFromDOM(messageId);
            if (rawContent) {
                this.copyToClipboard(rawContent);
                this.showCopySuccess(messageId);
                return;
            }

            // Fallback to visible DOM content if raw data is missing.
            const domContent = this.getMessageTextFromDOM(messageId);
            if (domContent && domContent.trim()) {
                this.copyToClipboard(domContent);
                this.showCopySuccess(messageId);
                return;
            }
        }

        // Default path (non-Safari): DB-first to preserve raw markdown/LaTeX.
        const messages = await this.app.data.getSessionMessages(session.id);
        const message = messages.find(m => m.id === messageId);

        if (message && message.content && message.content.trim()) {
            this.copyToClipboard(message.content);
            this.showCopySuccess(messageId);
            return;
        }

        // Final fallback to visible DOM content.
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
        btn.classList.add('text-status-success');

        setTimeout(() => {
            // Restore original icon
            svg.innerHTML = originalSvgContent;
            btn.title = originalTitle;
            btn.classList.remove('text-status-success');

            // Blur the button to ensure it hides if relying on focus state
            btn.blur();
        }, 2000);
    }

    /**
     * Handles toggling the collapsed state of long user messages.
     * For scrubber messages, persists the collapsed state to ensure consistency across re-renders.
     * Note: Height-locking (for scrubber toggle) is separate - show more/less always expands/collapses fully.
     * @param {HTMLElement} btn - The show more/less button element
     */
    async handleToggleUserMessage(btn) {
        const bubble = btn.closest('.message-user');
        if (!bubble) return;

        const content = bubble.querySelector('.user-message-collapsible');
        if (!content) return;

        const isCollapsed = content.classList.contains('collapsed');
        if (isCollapsed) {
            // Expanding: remove collapsed class AND any height lock to show full content
            content.classList.remove('collapsed');
            btn.textContent = 'Show less';
            // Remove height-lock so content can expand fully (height-lock is only for scrubber toggle)
            bubble.classList.remove('height-locked');
            bubble.style.height = '';
        } else {
            // Collapsing: add collapsed class (CSS handles truncation)
            content.classList.add('collapsed');
            btn.textContent = 'Show more';
        }

        // Persist collapsed state for scrubber messages so it survives re-renders (e.g., toggling original/redacted)
        const messageId = btn.dataset.messageId;
        if (messageId) {
            const session = this.app.getCurrentSession();
            if (session) {
                const messages = await this.app.data.getSessionMessages(session.id);
                const message = messages.find(m => m.id === messageId);
                if (message?.scrubber) {
                    message.scrubber.isCollapsed = !isCollapsed; // New state after toggle
                    await this.app.data.saveMessage(message);
                }
            }
        }
    }

    /**
     * Handles copying code from a code block
     * @param {HTMLElement} btn - The copy button element
     */
    handleCopyCodeBlock(btn) {
        // Get code from data attribute (preserves original formatting)
        let decodedCode;
        const code = btn.dataset.code;
        if (code) {
            // Decode HTML entities that were escaped for the attribute
            const tempEl = document.createElement('textarea');
            tempEl.innerHTML = code;
            decodedCode = tempEl.value;
        } else {
            // Fallback: extract from the <pre><code> sibling (handles cases where
            // data-code attribute was lost during HTML round-tripping e.g. DOMParser)
            const wrapper = btn.closest('.code-block-wrapper');
            const codeEl = wrapper && wrapper.querySelector('pre code');
            decodedCode = codeEl ? codeEl.textContent : '';
        }
        if (!decodedCode) return;

        // Get button elements for animation
        const svg = btn.querySelector('.copy-icon');
        const textEl = btn.querySelector('.copy-text');
        if (!svg) return;

        const messageEl = btn.closest('[data-message-id]');
        const messageId = messageEl?.dataset.messageId || null;
        const isStreamingMessage = messageId ? this.isMessageStreamingInDOM(messageId) : false;

        this.copyToClipboard(decodedCode);
        btn.dataset.copyFeedbackActive = 'true';
        if (isStreamingMessage && typeof this.app.showToast === 'function') {
            this.app.showToast('Code copied', 'success');
        }

        // Animate button to show success
        const originalSvgContent = svg.innerHTML;
        const originalText = textEl ? textEl.textContent : '';
        svg.innerHTML = '<path stroke-linecap="round" stroke-linejoin="round" d="M4.5 12.75l6 6 9-13.5" />';
        if (textEl) textEl.textContent = 'Copied';

        setTimeout(() => {
            svg.innerHTML = originalSvgContent;
            if (textEl) textEl.textContent = originalText;
            delete btn.dataset.copyFeedbackActive;
        }, 2000);
    }

    /**
     * Handles regenerating an assistant message
     * @param {string} messageId - The assistant message ID to regenerate
     */
    async handleRegenerateMessage(messageId) {
        const session = this.app.getCurrentSession();
        if (!session) return;

        if (this.app.isCurrentSessionStreaming()) {
            const stopped = await this.app.stopCurrentSessionStreamingAndWait();
            if (!stopped) return;
        }

        const messages = await this.app.data.getSessionMessages(session.id);
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
            await this.app.data.deleteMessage(msg.id);
        }

        // Re-render messages to remove deleted messages from UI
        await this.render();

        // Trigger regeneration by calling the app's regenerateResponse method
        await this.app.regenerateResponse();
    }

    /**
     * Handles toggling scrubber restoration on an assistant message.
     * @param {string} messageId - The assistant message ID to restore/toggle
     */
    async handleScrubberRestore(messageId) {
        await this.app.toggleScrubberRestore(messageId);
    }

    async handleMemoryPromptPreview(messageId, userMessageId = null) {
        const session = this.app.getCurrentSession();
        if (!session) return;

        const messages = await this.app.data.getSessionMessages(session.id);
        let message = messageId
            ? messages.find((entry) => entry.id === messageId)
            : null;

        if (!message && userMessageId) {
            message = messages.find((entry) => entry?.ciPromptDraft?.linkedUserMessageId === userMessageId);
        }

        if (!message?.ciPromptDraft) return;
        await this.showCiPromptEditor(message.id, message.ciPromptDraft);
    }

    renderTaggedPromptEditable(text) {
        let html = this.escapeHtml(text || '');
        html = html.replace(
            /\[\[user_data\]\]([\s\S]*?)\[\[\/user_data\]\]/g,
            '<mark class="user-data-highlight">$1</mark>'
        );
        html = html.replace(/\[\[user_data\]\]/g, '');
        html = html.replace(/\[\[\/user_data\]\]/g, '');
        html = html.replace(/\n/g, '<br>');
        return html;
    }

    extractTaggedPromptText(container) {
        let text = '';
        const walk = (node) => {
            if (node.nodeType === Node.TEXT_NODE) {
                text += node.textContent;
                return;
            }
            if (node.nodeType !== Node.ELEMENT_NODE) {
                return;
            }

            const tag = node.tagName;
            if (tag === 'BR') {
                text += '\n';
                return;
            }
            if (tag === 'MARK' && node.classList.contains('user-data-highlight')) {
                text += '[[user_data]]';
                for (const child of node.childNodes) {
                    walk(child);
                }
                text += '[[/user_data]]';
                return;
            }
            if (tag === 'DIV' || tag === 'P') {
                if (text.length > 0 && !text.endsWith('\n')) {
                    text += '\n';
                }
                for (const child of node.childNodes) {
                    walk(child);
                }
                return;
            }
            for (const child of node.childNodes) {
                walk(child);
            }
        };

        for (const child of container.childNodes) {
            walk(child);
        }
        return text;
    }

    async showTaggedPromptEditor({
        title = 'Prompt',
        modelName = 'frontier model',
        fullPrompt = '',
        isReadOnly = false,
        onSave = null
    } = {}) {
        const currentPrompt = typeof fullPrompt === 'string' ? fullPrompt : '';
        const hasUserDataTags = /\[\[user_data\]\]/.test(currentPrompt);
        const userDataBadge = hasUserDataTags
            ? `<span class="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground/60">
                <span class="inline-block rounded-sm flex-shrink-0 user-data-highlight" style="width:14px;height:8px"></span>
                from private local memory
               </span>`
            : '';
        const subtitle = `${title} to ${modelName || 'frontier model'}`;

        const modal = document.createElement('div');
        modal.className = 'escalation-prompt-overlay';
        modal.innerHTML = `
            <div role="dialog" aria-modal="true"
                 class="memory-editor-dialog w-full max-w-2xl mx-4 overflow-hidden flex flex-col rounded-2xl"
                 style="max-height: min(85vh, 780px)">
                <div class="flex items-center justify-between px-4 py-3 shrink-0" style="border-bottom: 1px solid hsl(var(--color-border) / 0.5)">
                    <div class="flex items-center gap-2">
                        <div class="flex h-7 w-7 items-center justify-center rounded-lg bg-muted/50">
                            <svg class="w-3.5 h-3.5 text-muted-foreground" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5">
                                <path stroke-linecap="round" stroke-linejoin="round" d="M3.75 3.75v4.5m0-4.5h4.5m-4.5 0L9 9M3.75 20.25v-4.5m0 4.5h4.5m-4.5 0L9 15M20.25 3.75h-4.5m4.5 0v4.5m0-4.5L15 9m5.25 11.25h-4.5m4.5 0v-4.5m0 4.5L15 15" />
                            </svg>
                        </div>
                        <h2 class="text-sm font-semibold text-foreground">${this.escapeHtml(title)}</h2>
                    </div>
                    <button id="close-tagged-prompt-editor" class="text-muted-foreground hover:text-foreground transition-colors p-1.5 rounded-lg hover:bg-muted/50 ml-1" aria-label="Close">
                        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5">
                            <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"></path>
                        </svg>
                    </button>
                </div>
                <div class="flex items-center justify-between px-3 py-2 shrink-0" style="border-bottom: 1px solid hsl(var(--color-border) / 0.35); background: hsl(var(--color-muted) / 0.08)">
                    <div class="flex items-center gap-1.5 text-xs text-muted-foreground">
                        <svg class="w-3.5 h-3.5 flex-shrink-0 opacity-50" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5">
                            <path stroke-linecap="round" stroke-linejoin="round" d="m16.862 4.487 1.687-1.688a1.875 1.875 0 1 1 2.652 2.652L10.582 16.07a4.5 4.5 0 0 1-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 0 1 1.13-1.897l8.932-8.931Zm0 0L19.5 7.125M18 14v4.75A2.25 2.25 0 0 1 15.75 21H5.25A2.25 2.25 0 0 1 3 18.75V8.25A2.25 2.25 0 0 1 5.25 6H10" />
                        </svg>
                        <span>${this.escapeHtml(subtitle)}</span>
                        <span class="text-muted-foreground/40">— ${isReadOnly ? 'sent' : 'editable'}</span>
                    </div>
                    <div class="flex items-center gap-1.5 flex-shrink-0">
                        ${userDataBadge}
                        <span id="tagged-prompt-save-indicator" class="text-[10px] text-muted-foreground/40"></span>
                    </div>
                </div>
                <div id="tagged-prompt-editable"
                     class="escalation-prompt-editable${isReadOnly ? ' read-only' : ''}"
                     contenteditable="${isReadOnly ? 'false' : 'true'}" role="textbox" aria-multiline="true"
                     spellcheck="false">${this.renderTaggedPromptEditable(currentPrompt)}</div>
            </div>
        `;

        document.body.appendChild(modal);

        const editable = modal.querySelector('#tagged-prompt-editable');
        const closeBtn = modal.querySelector('#close-tagged-prompt-editor');
        const saveIndicator = modal.querySelector('#tagged-prompt-save-indicator');

        if (!isReadOnly && editable) {
            editable.addEventListener('paste', (event) => {
                event.preventDefault();
                const text = event.clipboardData?.getData('text/plain') || '';
                document.execCommand('insertText', false, text);
            });

            editable.addEventListener('keydown', (event) => {
                if (event.key === 'Escape') return;
                event.stopPropagation();
                if (event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault();
                    document.execCommand('insertLineBreak');
                }
            });
        }

        let hasEdits = false;
        let saveTimer = null;

        const saveEdits = async () => {
            if (isReadOnly || !hasEdits || typeof onSave !== 'function' || !editable) return;
            const edited = this.extractTaggedPromptText(editable);
            await onSave(edited);
            if (saveIndicator) {
                saveIndicator.textContent = 'saved';
                setTimeout(() => {
                    saveIndicator.textContent = '';
                }, 1200);
            }
            hasEdits = false;
        };

        if (!isReadOnly && editable && typeof onSave === 'function') {
            editable.addEventListener('input', () => {
                hasEdits = true;
                clearTimeout(saveTimer);
                saveTimer = setTimeout(() => {
                    saveEdits().catch((error) => {
                        console.warn('[ChatArea] Failed to save tagged prompt edits:', error);
                    });
                }, 500);
            });
        }

        const closeModal = async () => {
            clearTimeout(saveTimer);
            if (hasEdits) {
                await saveEdits();
            }
            modal.remove();
            document.removeEventListener('keydown', handleKeydown);
        };

        closeBtn.addEventListener('click', () => {
            closeModal().catch((error) => {
                console.warn('[ChatArea] Failed to close tagged prompt editor:', error);
            });
        });
        modal.addEventListener('click', (event) => {
            if (event.target === modal) {
                closeModal().catch((error) => {
                    console.warn('[ChatArea] Failed to close tagged prompt editor:', error);
                });
            }
        });

        const handleKeydown = (event) => {
            if (event.key === 'Escape') {
                closeModal().catch((error) => {
                    console.warn('[ChatArea] Failed to close tagged prompt editor:', error);
                });
            }
        };
        document.addEventListener('keydown', handleKeydown);

        if (isReadOnly) {
            closeBtn.focus();
        } else {
            editable.focus();
        }
    }

    async showCiPromptEditor(messageId, draftOverride = null) {
        const session = this.app.getCurrentSession();
        if (!session) return;

        const messages = await this.app.data.getSessionMessages(session.id);
        const message = messages.find((entry) => entry.id === messageId);
        const draft = draftOverride || message?.ciPromptDraft;
        if (!message?.ciPromptDraft || !draft) return;

        const draftStatus = draft.status || 'pending';
        const isReadOnly = draftStatus !== 'pending';
        const modelName = draft.model
            || this.app.normalizeModelName(session.model)
            || session.model
            || this.app.state.pendingModelName
            || 'frontier model';

        await this.showTaggedPromptEditor({
            title: 'Full Prompt',
            modelName,
            fullPrompt: draft.editedFullPrompt || draft.fullPrompt || '',
            isReadOnly,
            onSave: isReadOnly ? null : async (editedPrompt) => {
                message.ciPromptDraft = {
                    ...message.ciPromptDraft,
                    editedFullPrompt: editedPrompt
                };
                await this.app.data.saveMessage(message);
            }
        });
    }

    /**
     * Resends a user message - deletes any responses after it and regenerates
     * @param {string} messageId - User message ID to resend
     */
    async handleResendMessage(messageId, triggerButton = null) {
        const session = this.app.getCurrentSession();
        if (!session) return;

        if (this.app.isCurrentSessionStreaming()) {
            const stopped = await this.app.stopCurrentSessionStreamingAndWait();
            if (!stopped) return;
        }

        const messages = await this.app.data.getSessionMessages(session.id);
        const messageIndex = messages.findIndex(m => m.id === messageId);

        if (messageIndex === -1 || messages[messageIndex].role !== 'user') return;

        if (triggerButton) {
            triggerButton.classList.add('is-processing');
            triggerButton.setAttribute('aria-busy', 'true');
            triggerButton.blur();
        }

        if (typeof this.app.pruneMemoryRetrievedContextFromMessage === 'function') {
            await this.app.pruneMemoryRetrievedContextFromMessage(session, messages, messageIndex);
        }

        // Delete all messages after this user message
        const messagesToDelete = messages.slice(messageIndex + 1);
        for (const msg of messagesToDelete) {
            await this.app.data.deleteMessage(msg.id);
        }

        await this.render();
        await this.app.regenerateResponse();
    }

    /**
     * Toggles between showing original and scrubbed (anonymized) prompt
     * @param {string} messageId - User message ID to toggle
     */
    async handleToggleScrubber(messageId) {
        const session = this.app.getCurrentSession();
        if (!session) return;

        const messages = await this.app.data.getSessionMessages(session.id);
        const message = messages.find(m => m.id === messageId);
        if (!message || message.role !== 'user' || !message.scrubber) return;

        // Toggle the state
        message.scrubber.showingOriginal = !message.scrubber.showingOriginal;

        // Update the displayed content
        if (message.scrubber.showingOriginal) {
            message.content = message.scrubber.original;
        } else {
            message.content = message.scrubber.redacted;
        }

        // Save to database
        await this.app.data.saveMessage(message);

        // Re-render just this message - collapsed state is persisted in message.scrubber.isCollapsed
        // and will be automatically applied by the template
        this.updateMessage(message);
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
        const session = this.app.getCurrentSession();
        const sessionId = session?.id || '';
        const messagesContainer = this.app.elements.messagesContainer;
        const preserveQuickAskWindow = this.shouldPreserveQuickAskWindowForRender(sessionId);
        this.hideQuickAskPopover();
        if (!preserveQuickAskWindow) {
            this.closeQuickAskWindow({ abort: true, reset: true });
        }

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

        // Check if empty state is already rendered (by prelude.js) to avoid re-render flash
        const hasEmptyState = messagesContainer.querySelector('.welcome-landing') !== null;

        if (!session) {
            if (!hasEmptyState) {
                messagesContainer.innerHTML = buildEmptyState();
            }
            this.attachDownloadHandler();
            return;
        }

        // Load messages from IndexedDB
        const messages = await this.app.data.getSessionMessages(session.id);

        // Check if this render is stale (a newer render was triggered while we were loading messages)
        if (currentGeneration !== this.renderGeneration) {
            return; // Bail out - a newer render is in progress
        }

        if (messages.length === 0) {
            if (!hasEmptyState) {
                this.app.detachStalePromptSlideUpEffect?.();
                messagesContainer.innerHTML = buildEmptyState();
            }
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
        const streamingPhase = this.app.getCurrentSessionStreamingPhase
            ? this.app.getCurrentSessionStreamingPhase()
            : 'waiting';

        // Check if this is an imported (or forked from import) session with new messages added
        // importedFrom = share import (can still receive updates)
        // importedSource = external import (ChatGPT, etc.)
        // forkedFrom = was imported but user made changes (no longer receives updates)
        // Note: forkedFrom alone (without importedMessageCount) indicates a LOCAL fork, not an import
        const wasImported = session.importedFrom || session.importedSource ||
            (session.forkedFrom && (session.importedMessageCount || 0) > 0);
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
            options.pendingPhase = streamingPhase;
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
            messagesHtml += buildTypingIndicator('typing-restore-' + Date.now(), providerName, session.model, Date.now(), streamingPhase);
        }

        this.app.detachStalePromptSlideUpEffect?.();
        const detachedQuickAskWindow = this.detachQuickAskWindowForRender(session.id);
        messagesContainer.innerHTML = messagesHtml;
        this.restoreQuickAskWindowAfterRender(detachedQuickAskWindow, session.id);
        const promptSlideMessageId = this.app.getPromptSlideUpMessageIdForSession?.(
            session.id,
            messages,
            { allowStreamingFallback: isSessionStreaming }
        );
        const restoredPromptSlide = promptSlideMessageId
            ? this.app.restorePromptSlideUpEffectForSession?.(session.id, promptSlideMessageId, { primeRunway: true })
            : false;

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
            if (restoredPromptSlide) {
                this.app.updateActivePromptScrollSpacer({ scroll: true, behavior: 'auto' });
            } else {
                this.app.scrollChatAreaToBottomInstant();
                this.app.saveCurrentSessionScrollPosition();
            }
        } else if (restoredPromptSlide) {
            this.app.updateActivePromptScrollSpacer();
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
            options.pendingPhase = this.app.getCurrentSessionStreamingPhase
                ? this.app.getCurrentSessionStreamingPhase()
                : 'waiting';

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

    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text || '';
        return div.innerHTML;
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
        if (!this.app.shouldAutoScrollChat(force)) {
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

        if (RAW_CLIPBOARD_ATTRIBUTE_ENABLED) {
            messageEl.dataset.rawContent = content || '';
        }

        let contentEl = messageEl.querySelector('.message-content');

        // If content element doesn't exist (e.g., first output after reasoning), create it
        if (!contentEl) {
            const groupEl = messageEl.querySelector('.group.flex.w-full.flex-col');
            if (groupEl) {
                // The action anchor may be either the real toolbar row or the placeholder
                // that reserves its footprint during reasoning-only streaming.
                const actionAnchor = groupEl.querySelector(':scope > .assistant-actions-anchor');

                // Create the text bubble
                const textBubble = document.createElement('div');
                textBubble.className = 'py-3 px-4 font-normal message-assistant w-full flex items-center';
                textBubble.innerHTML = '<div class="min-w-0 w-full overflow-hidden message-content prose"></div>';

                // Keep streamed content above the action row placeholder so reasoning
                // does not leave a temporary gap before the answer.
                if (actionAnchor) {
                    groupEl.insertBefore(textBubble, actionAnchor);
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

            this.patchStreamingContent(contentEl, processedContent);
            // Re-render LaTeX for the updated content
            renderMathInElement(contentEl, {
                delimiters: [
                    {left: '$$', right: '$$', display: true},
                    {left: '\\[', right: '\\]', display: true},
                    {left: '\\(', right: '\\)', display: false}
                ],
                throwOnError: false
            });
            this.app.updateActivePromptScrollSpacer();
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
        this.app.updateActivePromptScrollSpacer();
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

        const promptSlideAnchor = this.app.captureActivePromptScrollAnchor?.({ primeRunway: true });
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

        this.app.restoreActivePromptScrollAnchor?.(promptSlideAnchor);
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
            // Create the image bubble after text bubble but before the shared action anchor.
            const actionButtonsWrapper = groupEl.querySelector(':scope > .assistant-actions-anchor');

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
        this.app.updateActivePromptScrollSpacer();
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
                // Update scroll button visibility (no auto-scroll for appended messages)
                this.app.updateActivePromptScrollSpacer();
                this.app.updateScrollButtonVisibility();
                if (this.app.messageNavigation) {
                    this.app.messageNavigation.update();
                }
                return;
            }
        }

        const existingTypingIndicator = messagesContainer.querySelector('[id^="typing-"]');
        if (existingTypingIndicator) {
            const tempDiv = document.createElement('div');
            tempDiv.innerHTML = messageHtml;
            const newMessageEl = tempDiv.firstElementChild;
            if (newMessageEl) {
                existingTypingIndicator.replaceWith(newMessageEl);
                messagesContainer.querySelectorAll('[id^="typing-"]').forEach(el => el.remove());

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
                this.app.updateActivePromptScrollSpacer();
                this.app.updateScrollButtonVisibility();
                if (this.app.messageNavigation) {
                    this.app.messageNavigation.update();
                }
                return;
            }
        }

        // Append before the prompt-slide spacer when it exists so new prompts do
        // not briefly drop the viewport before the spacer is retargeted.
        const promptSpacer = messagesContainer.lastElementChild?.classList?.contains('prompt-scroll-spacer')
            ? messagesContainer.lastElementChild
            : null;
        if (promptSpacer) {
            promptSpacer.insertAdjacentHTML('beforebegin', messageHtml);
        } else {
            messagesContainer.insertAdjacentHTML('beforeend', messageHtml);
        }

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

        // Update scroll button visibility (no auto-scroll for appended messages)
        this.app.updateActivePromptScrollSpacer();
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

        const promptSlideAnchor = this.app.captureActivePromptScrollAnchor?.({ primeRunway: true });

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
            this.app.restoreActivePromptScrollAnchor?.(promptSlideAnchor);
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
        this.app.restoreActivePromptScrollAnchor?.(promptSlideAnchor);
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
                const result = await exportTickets();
                if (!result.success && !result.cancelled) {
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
