/**
 * ChatInput Component
 * Manages the chat input area including textarea auto-resize,
 * send button state, search toggle UI, and settings dropdown.
 */

import themeManager from '../services/themeManager.js';
import preferencesStore, { PREF_KEYS } from '../services/preferencesStore.js';
import { exportAllData, exportChats, exportTickets } from '../services/globalExport.js';
import { importFromFile, formatImportSummary } from '../services/globalImport.js';
import ticketClient from '../services/ticketClient.js';
import scrubberService from '../services/scrubberService.js';
import {
    renderEditableDiff,
    extractTextFromEditableDiff,
    handleEditableDiffPaste,
    updateEditableDiff,
    getEditableDiffSelectionState
} from '../services/editableDiffRenderer.js';
import { chatDB } from '../db.js';
import { mentionService } from '../services/mentionService.js';

const MESSAGE_INPUT_MAX_HEIGHT_PX = 300;

export default class ChatInput {
    /**
     * @param {Object} app - Reference to the main ChatApp instance
     */
    constructor(app) {
        this.app = app;
        this.scrubberState = {
            lastTabAt: 0,
            timer: null,
            isRunning: false,
            ctrlHeld: false,
            ctrlPinned: false
        };
        this.scrubberDiffState = {
            previewCleanup: null,
            previewRendered: false,
            previewVisible: false,
            originalTooltipVisible: false,
            tooltipInteracted: false,
            tooltipClickOutsideHandler: null,
            globalEscapeHandler: null,
            previewEditing: false,
            previewInputHandler: null,
            previewPasteHandler: null,
            previewKeydownHandler: null,
            previewBeforeInputHandler: null,
            previewInitialRedacted: '',
            previewOriginalText: '',
            previewHintDefault: '',
            previewHistory: [],
            previewLastText: '',
            previewPreEditCursor: null
        };
        this.scrubberModelsReady = false;
        this.scrubberModelSelect = null;
        // Store undone scrubber state for redo functionality
        this.scrubberUndoState = null;
    }

    /**
     * Sets up all event listeners for the input area controls.
     */
    setupEventListeners() {
        // Initialize mention service
        const mentionPopup = document.getElementById('mention-popup');
        mentionService.initialize(mentionPopup, this.app.elements.messageInput);

        // Auto-resize textarea and clear file undo stack on text input
        this.app.elements.messageInput.addEventListener('input', () => {
            const input = this.app.elements.messageInput;
            this.app.resetMessageInputLayout();
            const isExpanded = this.app.elements.inputCard?.classList.contains('scrubber-preview-expanded');
            const expandedMax = Math.floor(window.innerHeight * 0.55);
            const maxHeight = isExpanded ? Math.max(MESSAGE_INPUT_MAX_HEIGHT_PX, expandedMax) : MESSAGE_INPUT_MAX_HEIGHT_PX;
            // When expanded, also consider diff preview's scroll height for proper sizing
            let contentHeight = input.scrollHeight;
            if (isExpanded && this.app.elements.scrubberPreviewDiff) {
                const diffHeight = this.app.elements.scrubberPreviewDiff.scrollHeight;
                if (diffHeight > 0) {
                    contentHeight = Math.max(contentHeight, diffHeight);
                }
            }
            input.style.maxHeight = `${maxHeight}px`;
            input.style.height = Math.min(contentHeight, maxHeight) + 'px';
            this.app.updateInputState();
            
            // Check for mention context
            this.handleMentionInput();

            // Clear file undo stack - text input should take undo precedence
            this.app.fileUndoStack = [];

            const inputValue = this.app.elements.messageInput.value;

            // Edge case: If user clears the input completely, reset scrubber state
            // This means the user is starting fresh, not editing the scrubbed prompt
            if (!inputValue.trim() && this.app.scrubberPending) {
                this.app.scrubberPending = null;
                this.clearScrubberPreview();
            } else if (this.app.scrubberPending && this.app.scrubberPending.redacted !== inputValue) {
                // User is editing the scrubbed prompt
                this.app.scrubberPending = {
                    ...this.app.scrubberPending,
                    redacted: inputValue,
                    modified: true,
                    timestamp: Date.now()
                };
                if (this.scrubberDiffState.previewEditing) {
                    this.scrubberDiffState.previewRendered = true;
                } else {
                    this.scrubberDiffState.previewRendered = false;
                    this.clearScrubberPreview();
                }
            }

            // Update hint visibility and has-scrubber-pending class
            this.updateScrubberHintVisibility();
            this.updateScrubberPreviewHintVisibility();

            if (this.app.updateToastPosition) {
                this.app.updateToastPosition();
            }
        });

        // Send on Enter (not Shift+Enter and not composing with IME)
        this.app.elements.messageInput.addEventListener('keydown', (e) => {
            const mentionPopup = document.getElementById('mention-popup');
            const isMentionPopupVisible = mentionPopup && !mentionPopup.classList.contains('hidden');

            // Close mention popup on Escape
            if (e.key === 'Escape' && isMentionPopupVisible) {
                mentionService.hideMentionPopup();
                return;
            }

            if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
                window.oaPendingSend = false; // Clear pending flag if we're handling it live
                e.preventDefault();
                if (!this.app.elements.sendBtn.disabled) {
                    if (this.app.isCurrentSessionStreaming()) {
                        this.app.stopCurrentSessionStreaming();
                    } else {
                        this.clearScrubberPreview();
                        this.app.sendMessage();
                    }
                }
            }
        });

        // Scrubber shortcut: Tab Tab to scrub
        this.app.elements.messageInput.addEventListener('keydown', (e) => {
            if (!this.isMessageInputFocused()) {
                this.resetScrubberTabShortcutState();
                return;
            }
            if (e.key !== 'Tab' || e.shiftKey || e.ctrlKey || e.metaKey || e.altKey || e.isComposing) {
                return;
            }
            e.preventDefault();
            this.handleScrubberTabKeydown();
        });
        this.app.elements.messageInput.addEventListener('blur', () => {
            this.resetScrubberTabShortcutState();
        });

        // Scrubber undo/redo: Cmd+Z to undo scrubbing, Cmd+Shift+Z to redo
        this.app.elements.messageInput.addEventListener('keydown', (e) => {
            if (!e.metaKey && !e.ctrlKey) return;
            if (e.key.toLowerCase() !== 'z') return;

            if (e.shiftKey) {
                // Cmd+Shift+Z: Redo scrubbing
                if (this.scrubberUndoState) {
                    e.preventDefault();
                    // Restore the scrubbed state
                    this.app.scrubberPending = this.scrubberUndoState;
                    this.scrubberUndoState = null;
                    this.app.elements.messageInput.value = this.app.scrubberPending.redacted;
                    this.app.elements.messageInput.dispatchEvent(new Event('input', { bubbles: true }));
                    this.app.elements.messageInput.scrollTop = 0;
                    this.app.elements.messageInput.setSelectionRange(0, 0);
                    this.updateScrubberHintVisibility();
                    this.updateScrubberPreviewHintVisibility();
                }
            } else {
                // Cmd+Z: Undo scrubbing (only if current text matches scrubbed text and not modified)
                const pending = this.app.scrubberPending;
                const currentValue = this.app.elements.messageInput.value;
                if (pending && pending.original && currentValue === pending.redacted && !pending.modified) {
                    e.preventDefault();
                    // Store for redo
                    this.scrubberUndoState = { ...pending };
                    // Restore original text
                    this.app.elements.messageInput.value = pending.original;
                    this.app.elements.messageInput.dispatchEvent(new Event('input', { bubbles: true }));
                    // Clear scrubber state (treat as never scrubbed)
                    this.app.scrubberPending = null;
                    this.clearScrubberPreview();
                    this.updateScrubberHintVisibility();
                    this.updateScrubberPreviewHintVisibility();
                }
            }
        });

        // Control key for preview: hold to show, release to hide
        document.addEventListener('keydown', (e) => {
            if (e.key !== 'Control' || e.repeat) return;
            if (!this.app.scrubberPending) return;
            this.handleScrubberControlKeydown();
        });

        document.addEventListener('keyup', (e) => {
            if (e.key !== 'Control') return;
            if (!this.app.scrubberPending) return;
            this.handleScrubberControlKeyup();
        });

        // Option key (⌥) for edit: pin and expand preview for editing
        document.addEventListener('keydown', (e) => {
            if (e.key !== 'Alt' || e.repeat) return;
            if (!this.app.scrubberPending) return;
            this.handleScrubberOptionKeydown();
        });

        // Note: Paste events (files + text) are handled globally in app.js

        // Setup mention popup click handler
        const mentionPopupElement = document.getElementById('mention-popup');
        if (mentionPopupElement) {
            mentionPopupElement.addEventListener('click', (e) => {
                const mentionItem = e.target.closest('.mention-item');
                if (mentionItem) {
                    const mentionName = mentionItem.dataset.mention;
                    if (mentionName) {
                        mentionService.insertMention(mentionName);
                    }
                }
            });
        }

        // Close mention popup when clicking outside
        document.addEventListener('click', (e) => {
            const mentionPopup = document.getElementById('mention-popup');
            if (mentionPopup && !mentionPopup.classList.contains('hidden')) {
                if (!mentionPopup.contains(e.target) && e.target !== this.app.elements.messageInput) {
                    mentionService.hideMentionPopup();
                }
            }
        });

        // Send button click - handles both send and stop
        this.app.elements.sendBtn.addEventListener('click', () => {
            if (this.app.isCurrentSessionStreaming()) {
                this.app.stopCurrentSessionStreaming();
            } else {
                this.clearScrubberPreview();
                this.app.sendMessage();
            }
        });

        window.addEventListener('blur', () => {
            this.hideScrubberPreview();
        });

        // Search toggle functionality
        this.app.elements.searchToggle.addEventListener('click', async () => {
            this.app.searchEnabled = !this.app.searchEnabled;
            this.updateSearchToggleUI();
            this.app.updateInputState();
            // Persist search state globally
            await chatDB.saveSetting('searchEnabled', this.app.searchEnabled);
        });

        // Memory toggle functionality - enable/disable memory interactions
        const memoryToggle = document.getElementById('memory-toggle');
        if (memoryToggle) {
            memoryToggle.addEventListener('click', async () => {
                this.app.memoryEnabled = !this.app.memoryEnabled;
                this.updateMemoryToggleUI();
                await chatDB.saveSetting('memoryEnabled', this.app.memoryEnabled);

                if (!this.app.memoryEnabled) {
                    this.app.memorySelector?.close();
                    this.app.pendingMemoryContext = null;
                    this.renderMemoryChips([]);
                }
            });
        }

        // Reasoning toggle functionality (entire row is clickable)
        const reasoningToggleRow = document.getElementById('reasoning-toggle-row');
        if (reasoningToggleRow) {
            reasoningToggleRow.addEventListener('click', async (e) => {
                e.stopPropagation(); // Prevent menu from closing
                this.app.reasoningEnabled = !this.app.reasoningEnabled;
                this.updateReasoningToggleUI();
                await chatDB.saveSetting('reasoningEnabled', this.app.reasoningEnabled);
            });
        }

        // Settings menu toggle
        // IMPORTANT: The menu is moved to document.body when opened to enable backdrop-filter.
        // backdrop-filter only blurs content OUTSIDE the element's stacking context.
        // Since input-card has `isolation: isolate`, any child element's backdrop-filter
        // can only blur content within input-card, not the page behind it.
        // By moving to body, the menu escapes input-card's stacking context.
        this.app.elements.settingsBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const menu = this.app.elements.settingsMenu;
            const btn = this.app.elements.settingsBtn;
            const isHidden = menu.classList.contains('hidden');

            if (isHidden) {
                // Move menu to body for backdrop-filter to work (escapes input-card stacking context)
                document.body.appendChild(menu);
                menu.classList.remove('hidden');
                btn.classList.add('tooltip-disabled'); // Hide tooltip while menu is open

                // Position relative to settings button
                const btnRect = btn.getBoundingClientRect();
                menu.style.left = `${btnRect.left}px`;
                menu.style.bottom = `${window.innerHeight - btnRect.top + 8}px`;

                // Lock width to the initial rendered size to prevent resizing on async content
                const menuRect = menu.getBoundingClientRect();
                if (menuRect.width) {
                    menu.style.width = `${menuRect.width}px`;
                    menu.style.maxWidth = `${menuRect.width}px`;
                }

                this.ensureScrubberModelsLoaded();
            } else {
                menu.classList.add('hidden');
                btn.classList.remove('tooltip-disabled');
            }
        });

        // Settings menu actions
        // Stop propagation for all clicks inside the menu to prevent document click handler from closing it
        this.app.elements.settingsMenu.addEventListener('click', async (e) => {
            e.stopPropagation();
            // Skip toggle buttons - they have their own handlers
            if (e.target.closest('.display-toggle-container') || e.target.closest('.theme-toggle-container')) {
                return;
            }
            if (e.target.tagName === 'BUTTON') {
                const action = e.target.dataset.action || e.target.textContent.trim();

                // Copy Markdown functionality (temporarily disabled)
                // if (action === 'Copy Markdown') {
                //     await this.copyLatestMarkdown(e.target);
                //     return; // Don't close menu immediately
                // }

                // TODO: Re-enable when implementing Clear Models functionality
                // if (action === 'Clear Models') {
                //     const session = this.app.getCurrentSession();
                //     if (session) {
                //         session.model = null;
                //         await chatDB.saveSession(session);
                //         this.app.renderCurrentModel();
                //     }
                // }
                if (action === 'export-all-data') {
                    await this.handleExportAllData();
                } else if (action === 'import-data') {
                    this.handleImportData();
                    return; // Don't close menu until file is selected
                } else if (action === 'export-chats') {
                    await this.handleExportChats();
                } else if (action === 'import-history') {
                    this.app.chatHistoryImportModal?.open();
                } else if (action === 'export-tickets') {
                    await this.handleExportTickets();
                } else if (action === 'import-tickets') {
                    this.handleImportTickets();
                    return; // Don't close menu until file is selected
                }
                this.app.elements.settingsMenu.classList.add('hidden');
            }
        });

        // Global import file input handler
        const globalImportInput = document.getElementById('global-import-input');
        if (globalImportInput) {
            globalImportInput.addEventListener('change', async (e) => {
                const file = e.target.files?.[0];
                if (file) {
                    await this.processImportFile(file);
                }
                // Reset input so the same file can be selected again
                e.target.value = '';
            });
        }

        // Tickets import file input handler
        const ticketsImportInput = document.getElementById('tickets-import-input');
        if (ticketsImportInput) {
            ticketsImportInput.addEventListener('change', async (e) => {
                const file = e.target.files?.[0];
                if (file) {
                    await this.processTicketsImportFile(file);
                }
                // Reset input so the same file can be selected again
                e.target.value = '';
            });
        }

        // Clear chat functionality (temporarily disabled)
        // this.app.elements.clearChatBtn.addEventListener('click', async () => {
        //     const session = this.app.getCurrentSession();
        //     if (session) {
        //         await chatDB.deleteSessionMessages(session.id);
        //         this.app.renderMessages();
        //         this.app.elements.settingsMenu.classList.add('hidden');
        //     }
        // });

        // Keyboard shortcut for Copy Markdown (Cmd+Shift+C) (temporarily disabled)
        // document.addEventListener('keydown', async (e) => {
        //     if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === 'c') {
        //         e.preventDefault();
        //         await this.copyLatestMarkdown();
        //     }
        // });

        // Close settings menu when clicking outside
        // Note: Toggle controls inside the menu use stopPropagation() to prevent this from firing
        document.addEventListener('click', () => {
            if (!this.app.elements.settingsMenu.classList.contains('hidden')) {
                this.app.elements.settingsMenu.classList.add('hidden');
                this.app.elements.settingsBtn.classList.remove('tooltip-disabled');
            }
            // Also close session menus
            document.querySelectorAll('.session-menu').forEach(menu => {
                menu.classList.add('hidden');
            });
        });

        // Setup theme controls
        this.setupThemeControls();

        // Setup flat mode (display mode) controls
        this.setupFlatModeControls();

        // Setup font mode controls
        this.setupFontModeControls();

        // Setup scrubber controls (model picker + shortcut)
        this.setupScrubberControls();

        // Initialize scrubber hint visibility
        this.updateScrubberHintVisibility();
        this.cacheScrubberPreviewHint();
        this.cacheScrubberHintAnchor();
        if (window.fontsReadyPromise && typeof window.fontsReadyPromise.then === 'function') {
            window.fontsReadyPromise.then(() => this.cacheScrubberHintAnchor(true));
        }

        // Mark input as ready for the inline script to defer handling
        window.chatInputReady = true;
    }

    handleScrubberTabKeydown() {
        if (!this.isMessageInputFocused()) {
            this.resetScrubberTabShortcutState();
            return;
        }
        const now = Date.now();
        const withinWindow = now - this.scrubberState.lastTabAt < 420;
        this.scrubberState.lastTabAt = now;
        if (this.scrubberState.timer) {
            clearTimeout(this.scrubberState.timer);
        }
        this.scrubberState.timer = setTimeout(() => {
            this.scrubberState.lastTabAt = 0;
        }, 420);

        if (!withinWindow) {
            if (!this.scrubberState.isRunning) {
                this.app.showToast('Press Tab again to scrub', 'success');
            }
            return;
        }

        if (this.scrubberState.isRunning) return;
        this.runScrubberShortcut();
    }

    isMessageInputFocused() {
        return document.activeElement === this.app.elements.messageInput;
    }

    resetScrubberTabShortcutState() {
        this.scrubberState.lastTabAt = 0;
        if (this.scrubberState.timer) {
            clearTimeout(this.scrubberState.timer);
            this.scrubberState.timer = null;
        }
    }

    handleScrubberControlKeydown() {
        this.scrubberState.ctrlHeld = true;

        // Control press - show preview with tooltip
        if (!this.scrubberDiffState.previewVisible) {
            this.showScrubberPreview({ skipTooltip: false });
        }
        this.updateScrubberPreviewHint();
    }

    handleScrubberOptionKeydown() {
        // Option key (⌥) - pin and auto-expand the preview for editing
        this.scrubberState.ctrlPinned = true;
        // Hide the original prompt tooltip (don't show on pin)
        this.hideOriginalPromptPreview();
        if (!this.scrubberDiffState.previewVisible) {
            this.showScrubberPreview({ skipTooltip: true });
        }
        this.enableScrubberPreviewSticky(true);
        // Auto-expand the input box
        if (this.app.elements.inputCard) {
            this.app.elements.inputCard.classList.add('scrubber-preview-expanded');
            // Resize input to match diff preview content (up to max height)
            this.resizeInputForExpandedPreview();
        }
        // Focus the diff preview for editing
        if (this.app.elements.scrubberPreviewDiff) {
            this.app.elements.scrubberPreviewDiff.focus({ preventScroll: true });
        }
        // Add global Escape handler for expanded mode
        this.addGlobalEscapeHandler();
        this.updateScrubberPreviewHint();
    }

    resizeInputForExpandedPreview() {
        const input = this.app.elements.messageInput;
        const diffPreview = this.app.elements.scrubberPreviewDiff;
        if (!input) return;

        // Calculate max height (55% of viewport, minimum 384px)
        const expandedMax = Math.floor(window.innerHeight * 0.55);
        const maxHeight = Math.max(384, expandedMax);

        // Use the diff preview's scroll height if available, otherwise use input's
        let contentHeight = input.scrollHeight;
        if (diffPreview && diffPreview.scrollHeight > 0) {
            contentHeight = Math.max(contentHeight, diffPreview.scrollHeight);
        }

        // Set input height to content height (capped at max)
        input.style.height = Math.min(contentHeight, maxHeight) + 'px';

        // Update toast position if needed
        if (this.app.updateToastPosition) {
            this.app.updateToastPosition();
        }
    }

    handleScrubberControlKeyup() {
        this.scrubberState.ctrlHeld = false;
        // Always hide the original prompt tooltip when ctrl is released
        this.hideOriginalPromptPreview();
        // If preview is not pinned, hide the diff preview too
        if (!this.scrubberState.ctrlPinned && this.scrubberDiffState.previewVisible) {
            this.forceHideScrubberPreview();
        }
        this.updateScrubberPreviewHint();
    }

    async runScrubberShortcut() {
        const text = this.app.elements.messageInput.value || '';
        if (!text.trim()) {
            this.app.showToast('Nothing to scrub', 'error');
            return;
        }

        const modeLabel = scrubberService.getModeLabel ? scrubberService.getModeLabel() : 'confidential model';
        const stopToast = this.app.showLoadingToast?.(`Scrubbing input query with ${modeLabel}`);
        if (this.app.elements.inputCard) {
            this.app.elements.inputCard.classList.add('scrubbing');
        }
        this.scrubberState.isRunning = true;
        try {
            let currentSession = this.app.getCurrentSession();
            if (!currentSession && typeof this.app.createSession === 'function') {
                await this.app.createSession();
                currentSession = this.app.getCurrentSession();
            }
            if (!currentSession) {
                throw new Error('No session available for scrubber key.');
            }
            const result = await scrubberService.redactPrompt(text, currentSession);
            if (result?.success && result.text) {
                const hasChanges = text.trim() !== result.text.trim();

                this.app.elements.messageInput.value = result.text;
                this.app.elements.messageInput.dispatchEvent(new Event('input', { bubbles: true }));
                // Scroll to top and place cursor at the beginning
                this.app.elements.messageInput.scrollTop = 0;
                this.app.elements.messageInput.setSelectionRange(0, 0);

                if (hasChanges) {
                    const existingOriginal = this.app.scrubberPending?.original;
                    this.app.scrubberPending = {
                        original: existingOriginal || text,
                        redacted: result.text,
                        timestamp: Date.now()
                    };
                    this.app.showToast('PII removed', 'success');
                } else {
                    this.app.scrubberPending = null;
                    this.app.showToast('No PII detected', 'success');
                }

                this.updateScrubberHintVisibility();
                this.updateScrubberPreviewHintVisibility();

                if (typeof stopToast === 'function') {
                    stopToast();
                }
                if (this.app.elements.inputCard) {
                    this.app.elements.inputCard.classList.remove('scrubbing');
                }
                this.scrubberDiffState.previewRendered = false;
            } else {
                if (typeof stopToast === 'function') {
                    stopToast();
                }
                if (this.app.elements.inputCard) {
                    this.app.elements.inputCard.classList.remove('scrubbing');
                }
                const errorMsg = result?.error || 'Scrubber failed';
                this.app.showToast(errorMsg, 'error');
            }
        } catch (error) {
            console.error('Scrubber shortcut failed:', error);
            if (typeof stopToast === 'function') {
                stopToast();
            }
            if (this.app.elements.inputCard) {
                this.app.elements.inputCard.classList.remove('scrubbing');
            }
            // Show specific error message if available
            const errorMsg = error?.message || 'Scrubber failed';
            this.app.showToast(errorMsg, 'error');
        } finally {
            this.scrubberState.isRunning = false;
        }
    }
    showScrubberPreview(options = {}) {
        const { skipTooltip = false } = options;
        const pending = this.app.scrubberPending;
        if (!pending || pending.redacted !== this.app.elements.messageInput.value) return;
        const originalText = pending.original || '';
        const redactedText = pending.redacted || '';
        const originalTrimmed = originalText.trim();
        const redactedTrimmed = redactedText.trim();
        // Only show preview if scrubbing actually changed the text
        if (!originalTrimmed || originalTrimmed === redactedTrimmed) return;
        if (!this.app.elements.inputCard || !this.app.elements.scrubberPreviewDiff) return;
        if (this.scrubberDiffState.previewVisible) return;

        console.log('[Scrubber] Control key toggling preview');
        this.scrubberDiffState.previewVisible = true;
        this.app.elements.inputCard.classList.add('scrubber-preview-active');

        if (this.app.elements.scrubberPreviewDiff) {
            this.app.elements.scrubberPreviewDiff.removeAttribute('aria-hidden');
        }

        if (!this.scrubberDiffState.previewRendered) {
            this.renderScrubberPreview(originalText, redactedText);
        } else if (this.app.elements.scrubberPreviewDiff) {
            this.app.elements.scrubberPreviewDiff.setAttribute('contenteditable', 'true');
            this.setScrubberPreviewEditing(false);
        }
        // Only show original tooltip while holding ctrl (not when pinned)
        if (!skipTooltip) {
            this.showOriginalPromptPreview(originalText);
        }
    }

    hideScrubberPreview() {
        if (!this.scrubberDiffState.previewVisible) return;
        // If user interacted with tooltip (e.g., selecting text), keep it visible
        if (this.scrubberDiffState.tooltipInteracted) return;
        this.scrubberDiffState.previewVisible = false;
        if (this.app.elements.inputCard) {
            this.app.elements.inputCard.classList.remove('scrubber-preview-active');
        }
        if (this.app.elements.scrubberPreviewDiff) {
            this.app.elements.scrubberPreviewDiff.setAttribute('contenteditable', 'false');
            this.blurScrubberPreviewIfFocused();
            this.app.elements.scrubberPreviewDiff.setAttribute('aria-hidden', 'true');
        }
        this.setScrubberPreviewEditing(false);
        this.resetScrubberPreviewHint();
        console.log('[Scrubber] Preview hidden');
        this.hideOriginalPromptPreview();
    }

    clearScrubberPreview() {
        // Reset interaction state first so hideScrubberPreview() works
        this.scrubberDiffState.tooltipInteracted = false;
        this.scrubberState.ctrlPinned = false;
        this.setScrubberPreviewEditing(false);
        this.scrubberDiffState.previewInitialRedacted = '';
        this.scrubberDiffState.previewOriginalText = '';
        this.resetScrubberPreviewHint();
        // Reset expanded state
        if (this.app.elements.inputCard) {
            this.app.elements.inputCard.classList.remove('scrubber-preview-expanded');
        }
        if (this.scrubberDiffState.tooltipClickOutsideHandler) {
            document.removeEventListener('mousedown', this.scrubberDiffState.tooltipClickOutsideHandler, true);
            this.scrubberDiffState.tooltipClickOutsideHandler = null;
        }
        if (this.app.elements.scrubberPreviewDiff) {
            if (this.scrubberDiffState.previewInputHandler) {
                this.app.elements.scrubberPreviewDiff.removeEventListener('input', this.scrubberDiffState.previewInputHandler);
                this.scrubberDiffState.previewInputHandler = null;
            }
            if (this.scrubberDiffState.previewPasteHandler) {
                this.app.elements.scrubberPreviewDiff.removeEventListener('paste', this.scrubberDiffState.previewPasteHandler);
                this.scrubberDiffState.previewPasteHandler = null;
            }
            if (this.scrubberDiffState.previewKeydownHandler) {
                this.app.elements.scrubberPreviewDiff.removeEventListener('keydown', this.scrubberDiffState.previewKeydownHandler);
                this.scrubberDiffState.previewKeydownHandler = null;
            }
            if (this.scrubberDiffState.previewBeforeInputHandler) {
                this.app.elements.scrubberPreviewDiff.removeEventListener('beforeinput', this.scrubberDiffState.previewBeforeInputHandler);
                this.scrubberDiffState.previewBeforeInputHandler = null;
            }
            this.app.elements.scrubberPreviewDiff.setAttribute('contenteditable', 'false');
            this.blurScrubberPreviewIfFocused();
            this.app.elements.scrubberPreviewDiff.setAttribute('aria-hidden', 'true');
        }
        this.hideScrubberPreview();
        this.scrubberDiffState.previewRendered = false;
        if (this.scrubberDiffState.previewCleanup) {
            this.scrubberDiffState.previewCleanup();
            this.scrubberDiffState.previewCleanup = null;
        }
        // Update hint visibility (will remove has-scrubber-pending if no valid diff)
        this.updateScrubberPreviewHintVisibility();
    }

    async renderScrubberPreview(originalText, redactedText) {
        const container = this.app.elements.scrubberPreviewDiff;
        if (!container) return;
        if (this.scrubberDiffState.previewEditing) return;

        const inputEl = this.app.elements.messageInput;
        const inputStyle = inputEl ? window.getComputedStyle(inputEl) : null;
        const fontFamily = inputStyle?.fontFamily || '';
        const fontSize = inputStyle?.fontSize || '14px';
        const lineHeight = inputStyle?.lineHeight && inputStyle.lineHeight !== 'normal'
            ? inputStyle.lineHeight
            : '1.5';

        if (fontFamily) {
            container.style.fontFamily = fontFamily;
        }
        container.style.fontSize = fontSize;
        container.style.lineHeight = lineHeight;

        const html = renderEditableDiff(originalText, redactedText);
        container.innerHTML = html;
        container.setAttribute('contenteditable', 'true');
        container.setAttribute('role', 'textbox');
        container.setAttribute('aria-multiline', 'true');
        container.tabIndex = 0;

        this.setScrubberPreviewEditing(false);
        this.scrubberDiffState.previewInitialRedacted = redactedText;
        this.scrubberDiffState.previewOriginalText = originalText;
        this.scrubberDiffState.previewRendered = true;
        this.scrubberDiffState.previewHistory = [];
        this.scrubberDiffState.previewLastText = redactedText;
        this.scrubberDiffState.previewLastCursor = null;

        if (this.scrubberDiffState.previewInputHandler) {
            container.removeEventListener('input', this.scrubberDiffState.previewInputHandler);
        }
        if (this.scrubberDiffState.previewPasteHandler) {
            container.removeEventListener('paste', this.scrubberDiffState.previewPasteHandler);
        }
        if (this.scrubberDiffState.previewKeydownHandler) {
            container.removeEventListener('keydown', this.scrubberDiffState.previewKeydownHandler);
        }
        if (this.scrubberDiffState.previewBeforeInputHandler) {
            container.removeEventListener('beforeinput', this.scrubberDiffState.previewBeforeInputHandler);
        }

        let rediffTimeout = null;
        this.scrubberDiffState.previewInputHandler = () => {
            this.setScrubberPreviewEditing(true);
            const updatedText = extractTextFromEditableDiff(container);
            const previousText = this.scrubberDiffState.previewLastText;

            // If user deleted all content, exit edit mode and focus main input
            if (updatedText === '' && previousText !== '') {
                this.app.scrubberPending = null;
                this.app.elements.messageInput.value = '';
                this.app.elements.messageInput.dispatchEvent(new Event('input', { bubbles: true }));
                this.clearScrubberPreview();
                // Focus main input after clearing
                requestAnimationFrame(() => {
                    this.app.elements.messageInput.focus();
                });
                return;
            }

            // Capture current cursor state (after the edit)
            const currentCursor = getEditableDiffSelectionState(container);
            const preEditCursor = this.scrubberDiffState.previewPreEditCursor || this.scrubberDiffState.previewLastCursor;

            if (updatedText !== previousText) {
                // Push the previous state (text + cursor at that time)
                // If previewLastCursor is null (first edit), we assume start or we can't restore perfectly.
                // But we should store the cursor state *before* this edit.
                // Since we can't get it now, we rely on previewLastCursor being set in the previous tick.
                // For the very first edit, previewLastCursor is null.
                this.scrubberDiffState.previewHistory.push({
                    text: previousText,
                    cursor: preEditCursor
                });
                this.scrubberDiffState.previewLastText = updatedText;
            }
            // Always update last cursor to current state for next undo
            this.scrubberDiffState.previewLastCursor = currentCursor;
            this.scrubberDiffState.previewPreEditCursor = null;

            if (!this.app.scrubberPending) return;
            this.app.scrubberPending = {
                ...this.app.scrubberPending,
                redacted: updatedText,
                modified: true,
                timestamp: Date.now()
            };
            this.app.elements.messageInput.value = updatedText;
            this.app.elements.messageInput.dispatchEvent(new Event('input', { bubbles: true }));
            this.setScrubberPreviewHintEdited();

            // Debounced re-diff to show updated changes vs original
            // Skip re-diff if the only change is newline addition/deletion
            const differsOnlyByNewlines = (a, b) => {
                const strip = (s) => s.replace(/\n/g, '').replace(/\u200B/g, '');
                return strip(a) === strip(b);
            };
            const shouldRediff = !differsOnlyByNewlines(previousText, updatedText);

            if (shouldRediff) {
                // Capture cursor state now so it's not lost during debounce
                const cursorForRediff = this.scrubberDiffState.previewLastCursor;
                if (rediffTimeout) clearTimeout(rediffTimeout);
                rediffTimeout = setTimeout(() => {
                    const original = this.scrubberDiffState.previewOriginalText;
                    if (original) {
                        updateEditableDiff(container, original, updatedText, cursorForRediff, { restoreFocus: true });
                    }
                }, 300);
            } else if (rediffTimeout) {
                clearTimeout(rediffTimeout);
                rediffTimeout = null;
            }
        };

        this.scrubberDiffState.previewPasteHandler = (event) => {
            handleEditableDiffPaste(event);
        };

        this.scrubberDiffState.previewKeydownHandler = (event) => {
            if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z' && !event.shiftKey) {
                event.preventDefault();
                this.undoScrubberPreviewEdit();
                return;
            }
            if (event.key !== 'Escape') return;
            event.preventDefault();
            this.forceHideScrubberPreview();
        };

        this.scrubberDiffState.previewBeforeInputHandler = (event) => {
            this.scrubberDiffState.previewPreEditCursor = getEditableDiffSelectionState(container);

            // Always intercept Enter to insert <br> + ZWSP instead of browser creating div
            if (event.inputType === 'insertParagraph' || event.inputType === 'insertLineBreak') {
                event.preventDefault();
                this.insertScrubberPreviewLineBreak();
                return;
            }

            if (event.inputType === 'deleteContentBackward' || event.inputType === 'deleteContentForward') {
                const handled = this.handleScrubberPreviewNewlineDelete(event.inputType);
                if (handled) {
                    event.preventDefault();
                    return;
                }
            }

            const deletedSpan = this.getScrubberDeletedAncestor(container);
            if (!deletedSpan) return;

            // For deletion: block if inside or at end of deleted span, allow only at front
            if (event.inputType === 'deleteContentBackward' || event.inputType === 'deleteContentForward') {
                const deletedLength = deletedSpan.textContent?.length || 0;
                const selection = window.getSelection();
                const range = selection?.getRangeAt(0);
                const relativeOffset = range ? this.getSelectionOffsetInNode(deletedSpan, range) : 0;

                // Only allow deletion if cursor is at the very front (offset 0) for backspace
                // or at the very end for forward delete to delete outside the span
                const isAtFront = relativeOffset === 0;
                const isAtEnd = relativeOffset >= deletedLength;

                if (event.inputType === 'deleteContentBackward' && !isAtFront) {
                    event.preventDefault();
                    return;
                }
                if (event.inputType === 'deleteContentForward' && !isAtEnd) {
                    event.preventDefault();
                    return;
                }
                // At front/end, move cursor outside and let browser handle deletion
                this.moveSelectionOutsideDeletedSpan(deletedSpan);
                return;
            }

            this.moveSelectionOutsideDeletedSpan(deletedSpan);
            if (event.inputType === 'insertFromPaste') return;
            if (event.inputType === 'insertText') {
                event.preventDefault();
                this.insertScrubberPreviewText(event.data || '');
                return;
            }
        };

        container.addEventListener('mousedown', () => {
            container.focus({ preventScroll: true });
            this.enableScrubberPreviewSticky(true);
        });

        container.addEventListener('keydown', (event) => {
            if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
                event.stopPropagation();
                event.stopImmediatePropagation();
            }
        });

        container.addEventListener('input', this.scrubberDiffState.previewInputHandler);
        container.addEventListener('paste', this.scrubberDiffState.previewPasteHandler);
        container.addEventListener('keydown', this.scrubberDiffState.previewKeydownHandler);
        container.addEventListener('beforeinput', this.scrubberDiffState.previewBeforeInputHandler);
    }

    repositionOriginalTooltip() {
        const tooltip = document.getElementById('scrubber-original-tooltip');
        const inputCard = this.app.elements.inputCard;
        if (!tooltip || !inputCard) return;

        const rect = inputCard.getBoundingClientRect();
        const tooltipWidth = Math.min(rect.width, 420);
        tooltip.style.width = `${tooltipWidth}px`;
        tooltip.style.maxWidth = `${tooltipWidth}px`;

        const tooltipRect = tooltip.getBoundingClientRect();
        let top = rect.top - tooltipRect.height - 8;
        if (top < 8) {
            top = rect.bottom + 8;
        }
        let left = rect.left + (rect.width - tooltipRect.width) / 2;
        if (left < 8) left = 8;
        if (left + tooltipRect.width > window.innerWidth - 8) {
            left = window.innerWidth - tooltipRect.width - 8;
        }

        Object.assign(tooltip.style, {
            top: `${top}px`,
            left: `${left}px`
        });
    }

    blurScrubberPreviewIfFocused() {
        if (this.app.elements.scrubberPreviewDiff === document.activeElement) {
            this.app.elements.scrubberPreviewDiff.blur();
        }
    }

    undoScrubberPreviewEdit() {
        const history = this.scrubberDiffState.previewHistory;
        if (!history || history.length === 0) return;
        const previousState = history.pop();
        const previousText = typeof previousState === 'string' ? previousState : previousState.text;
        const previousCursor = typeof previousState === 'string' ? null : previousState.cursor;

        this.scrubberDiffState.previewLastText = previousText;
        this.scrubberDiffState.previewLastCursor = previousCursor;

        if (!this.app.scrubberPending) return;
        const container = this.app.elements.scrubberPreviewDiff;
        this.app.scrubberPending = {
            ...this.app.scrubberPending,
            redacted: previousText,
            modified: true,
            timestamp: Date.now()
        };
        this.app.elements.messageInput.value = previousText;
        this.app.elements.messageInput.dispatchEvent(new Event('input', { bubbles: true }));
        if (container) {
            updateEditableDiff(
                container,
                this.scrubberDiffState.previewOriginalText,
                previousText,
                previousCursor,
                { restoreFocus: true }
            );
        }
    }

    insertScrubberPreviewText(text) {
        if (!text) return;
        const selection = window.getSelection();
        if (!selection || selection.rangeCount === 0) return;

        const range = selection.getRangeAt(0);
        const textNode = document.createTextNode(text);
        range.deleteContents();
        range.insertNode(textNode);

        // Move cursor after inserted text
        range.setStartAfter(textNode);
        range.collapse(true);
        selection.removeAllRanges();
        selection.addRange(range);

        // Dispatch input event manually since we modified DOM directly
        if (this.app.elements.scrubberPreviewDiff) {
            this.app.elements.scrubberPreviewDiff.dispatchEvent(new Event('input', { bubbles: true }));
        }
    }

    insertScrubberPreviewLineBreak() {
        const selection = window.getSelection();
        if (!selection || selection.rangeCount === 0) return;

        const range = selection.getRangeAt(0);
        range.deleteContents();

        // Insert <br> followed by ZWSP for cursor positioning
        const br = document.createElement('br');
        const zwsp = document.createTextNode('\u200B');
        range.insertNode(zwsp);
        range.insertNode(br);

        // Move cursor after the ZWSP (on the new line)
        range.setStartAfter(zwsp);
        range.collapse(true);
        selection.removeAllRanges();
        selection.addRange(range);

        // Dispatch input event manually since we modified DOM directly
        if (this.app.elements.scrubberPreviewDiff) {
            this.app.elements.scrubberPreviewDiff.dispatchEvent(new Event('input', { bubbles: true }));
        }
    }

    handleScrubberPreviewNewlineDelete(inputType) {
        const selection = window.getSelection();
        if (!selection || selection.rangeCount === 0) return false;

        const range = selection.getRangeAt(0);
        if (!this.app.elements.scrubberPreviewDiff?.contains(range.startContainer)) return false;

        // Only handle collapsed cursor deletes
        if (!range.collapsed) return false;

        const isBackward = inputType === 'deleteContentBackward';
        const container = this.app.elements.scrubberPreviewDiff;
        const node = range.startContainer;
        const offset = range.startOffset;

        const getSibling = (baseNode, direction) => {
            if (!baseNode) return null;
            if (direction === 'prev') return baseNode.previousSibling;
            return baseNode.nextSibling;
        };

        const removeNewlineAt = (brNode) => {
            if (!brNode || brNode.nodeName !== 'BR') return false;
            const next = brNode.nextSibling;
            const prev = brNode.previousSibling;
            brNode.remove();
            // ZWSP is after BR, remove it too
            if (next?.nodeType === Node.TEXT_NODE && next.nodeValue === '\u200B') {
                next.remove();
            } else if (prev?.nodeType === Node.TEXT_NODE && prev.nodeValue === '\u200B') {
                prev.remove();
            }
            if (container) {
                container.dispatchEvent(new Event('input', { bubbles: true }));
            }
            return true;
        };

        if (node.nodeType === Node.TEXT_NODE) {
            const text = node.nodeValue || '';
            if (isBackward && offset === 0) {
                const prev = getSibling(node, 'prev');
                if (prev?.nodeName === 'BR') return removeNewlineAt(prev);
            }
            if (!isBackward && offset === text.length) {
                const next = getSibling(node, 'next');
                if (next?.nodeName === 'BR') return removeNewlineAt(next);
            }
        }

        if (node.nodeType === Node.ELEMENT_NODE) {
            const children = Array.from(node.childNodes);
            const index = Math.min(offset, children.length - 1);
            if (isBackward && offset > 0) {
                const candidate = children[offset - 1];
                if (candidate?.nodeName === 'BR') return removeNewlineAt(candidate);
            }
            if (!isBackward && children[index]?.nodeName === 'BR') {
                return removeNewlineAt(children[index]);
            }
        }

        // If caret is directly on container, check adjacent nodes
        if (node === container) {
            const childIndex = Math.min(offset, container.childNodes.length - 1);
            if (isBackward && offset > 0) {
                const prev = container.childNodes[offset - 1];
                if (prev?.nodeName === 'BR') return removeNewlineAt(prev);
            }
            if (!isBackward && container.childNodes[childIndex]?.nodeName === 'BR') {
                return removeNewlineAt(container.childNodes[childIndex]);
            }
        }

        return false;
    }

    getScrubberDeletedAncestor(container) {
        if (!container) return null;
        const selection = window.getSelection();
        if (!selection || selection.rangeCount === 0) return null;
        const range = selection.getRangeAt(0);
        if (!container.contains(range.startContainer)) return null;
        if (range.startContainer.nodeType === Node.ELEMENT_NODE) {
            return range.startContainer.closest('.scrubber-deleted');
        }
        return range.startContainer.parentElement?.closest('.scrubber-deleted') || null;
    }

    getSelectionOffsetInNode(container, range) {
        if (!container || !range || !container.contains(range.startContainer)) return 0;
        const probe = document.createRange();
        probe.setStart(container, 0);
        try {
            probe.setEnd(range.startContainer, range.startOffset);
        } catch (error) {
            return 0;
        }
        return probe.toString().length;
    }

    moveSelectionOutsideDeletedSpan(deletedSpan) {
        const selection = window.getSelection();
        if (!selection || selection.rangeCount === 0) return;
        const nextRange = document.createRange();
        const range = selection.getRangeAt(0);
        const deletedLength = deletedSpan.textContent?.length || 0;
        const relativeOffset = this.getSelectionOffsetInNode(deletedSpan, range);
        const placeAfter = relativeOffset >= deletedLength;

        if (placeAfter) {
            let nextSibling = deletedSpan.nextSibling;
            if (nextSibling?.nodeType === Node.TEXT_NODE) {
                nextRange.setStart(nextSibling, 0);
            } else {
                const textNode = document.createTextNode('');
                deletedSpan.parentNode.insertBefore(textNode, nextSibling);
                nextRange.setStart(textNode, 0);
            }
        } else {
            let prevSibling = deletedSpan.previousSibling;
            if (prevSibling?.nodeType === Node.TEXT_NODE) {
                nextRange.setStart(prevSibling, prevSibling.nodeValue?.length || 0);
            } else {
                const textNode = document.createTextNode('');
                deletedSpan.parentNode.insertBefore(textNode, deletedSpan);
                nextRange.setStart(textNode, textNode.nodeValue?.length || 0);
            }
        }
        nextRange.collapse(true);
        selection.removeAllRanges();
        selection.addRange(nextRange);
    }

    showOriginalPromptPreview(originalText) {
        if (this.scrubberDiffState.originalTooltipVisible) return;
        if (!originalText) return;
        const inputCard = this.app.elements.inputCard;
        if (!inputCard) return;

        const escaped = this.app.escapeHtml
            ? this.app.escapeHtml(originalText)
            : originalText.replace(/</g, '&lt;').replace(/>/g, '&gt;');

        const tooltip = document.createElement('div');
        tooltip.id = 'scrubber-original-tooltip';
        tooltip.className = 'scrubber-original-tooltip';
        tooltip.innerHTML = `
            <div class="inline-flex items-center px-1.5 py-0.5 mb-2 rounded bg-muted/50 text-muted-foreground text-[10px] font-medium uppercase tracking-wide">
                Original prompt
            </div>
            <div class="text-foreground text-xs leading-relaxed" style="white-space: pre-wrap; user-select: text;">${escaped}</div>
        `;
        document.body.appendChild(tooltip);

        // Track interaction (e.g., text selection) to keep tooltip visible
        tooltip.addEventListener('mousedown', () => {
            this.enableScrubberPreviewSticky(false);
        });

        this.repositionOriginalTooltip();

        requestAnimationFrame(() => {
            tooltip.classList.add('visible');
        });

        this.scrubberDiffState.originalTooltipVisible = true;
    }

    hideOriginalPromptPreview() {
        const tooltip = document.getElementById('scrubber-original-tooltip');
        if (!tooltip) return;
        tooltip.classList.remove('visible');
        setTimeout(() => tooltip.remove(), 180);
        this.scrubberDiffState.originalTooltipVisible = false;
    }

    enableScrubberPreviewSticky(shouldMarkEditing = false) {
        this.scrubberDiffState.tooltipInteracted = true;
        if (shouldMarkEditing) {
            this.setScrubberPreviewEditing(true);
        }
        this.updateScrubberPreviewHint();
        if (!this.scrubberDiffState.tooltipClickOutsideHandler) {
            this.scrubberDiffState.tooltipClickOutsideHandler = (e) => {
                const tooltip = document.getElementById('scrubber-original-tooltip');
                const preview = this.app.elements.scrubberPreviewDiff;
                const hint = document.getElementById('scrubber-preview-hint');
                const clickedInsideTooltip = tooltip && tooltip.contains(e.target);
                const clickedInsidePreview = preview && preview.contains(e.target);
                const clickedInsideHint = hint && hint.contains(e.target);
                if (!clickedInsideTooltip && !clickedInsidePreview && !clickedInsideHint) {
                    this.forceHideScrubberPreview();
                }
            };
            setTimeout(() => {
                document.addEventListener('mousedown', this.scrubberDiffState.tooltipClickOutsideHandler, true);
            }, 0);
        }
    }

    forceHideScrubberPreview() {
        // Force hide regardless of interaction state (for click-outside)
        this.scrubberDiffState.tooltipInteracted = false;
        this.scrubberState.ctrlPinned = false;
        this.updateScrubberPreviewHint();
        if (this.scrubberDiffState.tooltipClickOutsideHandler) {
            document.removeEventListener('mousedown', this.scrubberDiffState.tooltipClickOutsideHandler, true);
            this.scrubberDiffState.tooltipClickOutsideHandler = null;
        }
        // Remove global Escape handler
        this.removeGlobalEscapeHandler();
        this.scrubberDiffState.previewVisible = false;
        if (this.app.elements.inputCard) {
            this.app.elements.inputCard.classList.remove('scrubber-preview-active');
            // Collapse expanded state when hiding (e.g., on Escape)
            this.app.elements.inputCard.classList.remove('scrubber-preview-expanded');
        }
        if (this.app.elements.scrubberPreviewDiff) {
            this.app.elements.scrubberPreviewDiff.setAttribute('contenteditable', 'false');
            this.blurScrubberPreviewIfFocused();
            this.app.elements.scrubberPreviewDiff.setAttribute('aria-hidden', 'true');
        }
        this.setScrubberPreviewEditing(false);
        this.resetScrubberPreviewHint();
        this.hideOriginalPromptPreview();
        // Trigger textarea resize to collapse back to content height
        this.app.elements.messageInput?.dispatchEvent(new Event('input', { bubbles: true }));
        // Focus main chat input after exiting edit mode
        requestAnimationFrame(() => {
            this.app.elements.messageInput?.focus();
        });
    }

    /**
     * Add global Escape key handler for expanded preview mode.
     * This allows Escape to work even when cursor is outside the diff preview.
     */
    addGlobalEscapeHandler() {
        if (this.scrubberDiffState.globalEscapeHandler) return;

        this.scrubberDiffState.globalEscapeHandler = (event) => {
            if (event.key !== 'Escape') return;
            // Only handle if preview is expanded/pinned
            if (!this.scrubberState.ctrlPinned && !this.scrubberDiffState.previewVisible) return;
            event.preventDefault();
            event.stopPropagation();
            this.forceHideScrubberPreview();
        };

        // Use capture phase to intercept before other handlers
        document.addEventListener('keydown', this.scrubberDiffState.globalEscapeHandler, true);
    }

    /**
     * Remove global Escape key handler.
     */
    removeGlobalEscapeHandler() {
        if (!this.scrubberDiffState.globalEscapeHandler) return;
        document.removeEventListener('keydown', this.scrubberDiffState.globalEscapeHandler, true);
        this.scrubberDiffState.globalEscapeHandler = null;
    }

    updateScrubberHintVisibility() {
        const hint = document.getElementById('scrubber-shortcut-hint');
        const input = this.app.elements.messageInput;
        if (!hint || !input) return;

        const len = (input.value || '').length;
        // Hide hint completely after scrubbing (when tooltip can show)
        const hasPending = this.app.scrubberPending?.redacted === input.value;
        if (hasPending) {
            hint.classList.add('hint-hidden');
            hint.classList.remove('faded');
            input.classList.remove('hint-visible');
            return;
        }
        if (len === 0) {
            // Empty input - show hint fully
            hint.classList.remove('faded', 'hint-hidden');
            input.classList.add('hint-visible');
        } else if (len < 50) {
            // Some text - fade hint
            hint.classList.add('faded');
            hint.classList.remove('hint-hidden');
            input.classList.add('hint-visible');
        } else {
            // Long text - hide hint completely
            hint.classList.add('hint-hidden');
            hint.classList.remove('faded');
            input.classList.remove('hint-visible');
        }
    }

    /**
     * Updates the visibility of the "ctrl preview" hint based on scrubber state.
     * The hint should only show when there's a valid diff to preview.
     */
    updateScrubberPreviewHintVisibility() {
        if (!this.app.elements.inputCard) return;

        const pending = this.app.scrubberPending;
        const inputValue = this.app.elements.messageInput?.value || '';

        // Show "ctrl preview" hint only when:
        // 1. There's pending scrubber data
        // 2. The input has content
        // 3. The input matches the redacted text (user hasn't typed something completely different)
        // 4. The original and redacted are actually different
        const hasMeaningfulDiff = pending &&
            inputValue.trim() &&
            pending.original?.trim() &&
            inputValue === pending.redacted &&
            pending.original.trim() !== pending.redacted.trim();

        if (hasMeaningfulDiff) {
            this.app.elements.inputCard.classList.add('has-scrubber-pending');
        } else {
            this.app.elements.inputCard.classList.remove('has-scrubber-pending');
        }
    }

    cacheScrubberPreviewHint() {
        const text = document.getElementById('scrubber-preview-hint-text');
        if (!text) return;
        if (!this.scrubberDiffState.previewHintDefault) {
            this.scrubberDiffState.previewHintDefault = text.innerHTML;
        }
    }

    cacheScrubberHintAnchor(force = false) {
        const input = this.app.elements.messageInput;
        if (!input) return;
        const row = input.closest('.scrubber-input-row');
        if (!row) return;
        if (!force && row.style.getPropertyValue('--scrubber-hint-center')) return;
        const rowRect = row.getBoundingClientRect();
        const inputRect = input.getBoundingClientRect();
        if (!rowRect.height || !inputRect.height) return;
        const center = (inputRect.top + inputRect.height / 2) - rowRect.top;
        if (!Number.isFinite(center)) return;
        row.style.setProperty('--scrubber-hint-center', `${center}px`);
    }

    resetScrubberPreviewHint() {
        const text = document.getElementById('scrubber-preview-hint-text');
        if (!text || !this.scrubberDiffState.previewHintDefault) return;
        text.innerHTML = this.scrubberDiffState.previewHintDefault;
    }

    updateScrubberPreviewHint() {
        const text = document.getElementById('scrubber-preview-hint-text');
        if (!text) return;

        let hintHtml = '';
        if (this.scrubberState.ctrlPinned) {
            hintHtml = `<span class="scrubber-shortcut-key">esc</span> <span>exit edit</span>`;
        } else if (this.scrubberState.ctrlHeld) {
            hintHtml = `<span class="scrubber-shortcut-key">⌥</span> <span>edit</span>`;
        } else {
            hintHtml = `<span class="scrubber-shortcut-key">ctrl</span> <span>preview</span> <span class="opacity-40 mx-0.5">|</span> <span class="scrubber-shortcut-key">⌥</span> <span>edit</span>`;
        }

        if (text.innerHTML !== hintHtml) {
            text.innerHTML = hintHtml;
        }
    }

    setScrubberPreviewHintEdited() {
        // When edited, we can show a different hint or just keep the dynamic one.
        // The user didn't specify special hint for edited state in the latest request,
        // but previously we showed "ctrl ctrl pin | esc exit".
        // Let's stick to the dynamic hint based on control key state.
        this.updateScrubberPreviewHint();
    }

    setScrubberPreviewEditing(isEditing) {
        this.scrubberDiffState.previewEditing = Boolean(isEditing);
        const inputCard = this.app.elements.inputCard;
        if (!inputCard) return;
        if (this.scrubberDiffState.previewEditing) {
            inputCard.classList.add('scrubber-preview-editing');
        } else {
            inputCard.classList.remove('scrubber-preview-editing');
        }
    }

    async setupScrubberControls() {
        const select = document.getElementById('scrubber-model-select');
        if (!select) return;

        select.addEventListener('click', (event) => event.stopPropagation());
        select.addEventListener('change', async (event) => {
            const modelId = event.target.value;
            if (modelId) {
                await scrubberService.setSelectedModel(modelId);
            }
        });
        this.scrubberModelSelect = select;
    }

    async ensureScrubberModelsLoaded() {
        if (this.scrubberModelsReady || !this.scrubberModelSelect) return;
        await this.populateScrubberModels(this.scrubberModelSelect);
        this.scrubberModelsReady = true;
    }

    async populateScrubberModels(selectEl) {
        selectEl.innerHTML = '<option value="" disabled selected>Loading models…</option>';
        try {
            // Model list is public - no session/key required
            const models = await scrubberService.fetchModels();
            const selected = scrubberService.getSelectedModel();
            const options = models.map(model => {
                const value = model.id || model.name;
                let label = model.name || model.id;
                // Add "slow" label for slow models
                if (scrubberService.isSlowModel(value)) {
                    label += ' (slow)';
                }
                return `<option value="${value}">${label}</option>`;
            }).join('');
            let html = options || '<option value="" disabled>No models available</option>';
            if (selected && !models.find(model => (model.id || model.name) === selected)) {
                html = `<option value="${selected}">${selected}</option>` + html;
            }
            selectEl.innerHTML = html;
            if (selected) selectEl.value = selected;
        } catch (error) {
            console.error('Failed to load scrubber models:', error);
            selectEl.innerHTML = '<option value="" disabled>Failed to load models</option>';
        }
    }

    /**
     * Sets up flat mode (display mode) toggle controls and listeners.
     * Toggles between flat (text lines) and bubble (chat bubble) display modes.
     * Uses event delegation with stopPropagation to prevent the document click
     * handler from closing the settings menu.
     */
    setupFlatModeControls() {
        const flatModeToggle = document.getElementById('flat-mode-toggle');
        if (!flatModeToggle) return;

        // Sync initial visual state with persistent preferences.
        preferencesStore.getPreference(PREF_KEYS.flatMode).then((isFlatMode) => {
            document.documentElement.classList.toggle('flat-mode', isFlatMode !== false);
            this.updateFlatModeControls();
        });

        preferencesStore.onChange((key, value) => {
            if (key !== PREF_KEYS.flatMode) return;
            document.documentElement.classList.toggle('flat-mode', value !== false);
            this.updateFlatModeControls();
        });

        flatModeToggle.addEventListener('click', (event) => {
            event.stopPropagation(); // Prevent settings menu from closing
            const btn = event.target.closest('.display-toggle-btn');
            if (btn) {
                const mode = btn.dataset.mode;
                const isFlatMode = mode === 'flat';

                // Update HTML class for CSS styling
                document.documentElement.classList.toggle('flat-mode', isFlatMode);

                // Persist preference to IndexedDB
                preferencesStore.savePreference(PREF_KEYS.flatMode, isFlatMode);

                // Update toggle visual state
                this.updateFlatModeControls();
            }
        });
    }

    /**
     * Updates the visual state of flat mode toggle based on current HTML class.
     * Syncs aria-checked attributes with actual flat-mode state.
     */
    updateFlatModeControls() {
        const flatModeToggle = document.getElementById('flat-mode-toggle');
        if (!flatModeToggle) return;

        const isFlatMode = document.documentElement.classList.contains('flat-mode');
        const activeMode = isFlatMode ? 'flat' : 'bubble';

        flatModeToggle.querySelectorAll('.display-toggle-btn').forEach(btn => {
            btn.setAttribute('aria-checked', btn.dataset.mode === activeMode ? 'true' : 'false');
        });
    }

    /**
     * Sets up font mode toggle controls and listeners.
     * Toggles between sans-serif and serif fonts in the chat area.
     */
    setupFontModeControls() {
        const fontModeToggle = document.getElementById('font-mode-toggle');
        if (!fontModeToggle) return;

        // Sync initial visual state with persistent preferences.
        preferencesStore.getPreference(PREF_KEYS.fontMode).then((fontMode) => {
            document.documentElement.classList.toggle('serif-mode', fontMode === 'serif');
            this.updateFontModeControls();
        });

        preferencesStore.onChange((key, value) => {
            if (key !== PREF_KEYS.fontMode) return;
            document.documentElement.classList.toggle('serif-mode', value === 'serif');
            this.updateFontModeControls();
        });

        fontModeToggle.addEventListener('click', (event) => {
            event.stopPropagation(); // Prevent settings menu from closing
            const btn = event.target.closest('.display-toggle-btn');
            if (btn) {
                const font = btn.dataset.font;
                const isSerifMode = font === 'serif';

                // Update HTML class for CSS styling
                document.documentElement.classList.toggle('serif-mode', isSerifMode);

                // Persist preference to IndexedDB
                preferencesStore.savePreference(PREF_KEYS.fontMode, isSerifMode ? 'serif' : 'sans');

                // Update toggle visual state
                this.updateFontModeControls();
            }
        });
    }

    /**
     * Updates the visual state of font mode toggle based on current HTML class.
     * Syncs aria-checked attributes with actual font-mode state.
     */
    updateFontModeControls() {
        const fontModeToggle = document.getElementById('font-mode-toggle');
        if (!fontModeToggle) return;

        const isSerifMode = document.documentElement.classList.contains('serif-mode');
        const activeFont = isSerifMode ? 'serif' : 'sans';

        fontModeToggle.querySelectorAll('.display-toggle-btn').forEach(btn => {
            btn.setAttribute('aria-checked', btn.dataset.font === activeFont ? 'true' : 'false');
        });
    }

    /**
     * Updates the visual state of the search toggle.
     */
    updateSearchToggleUI() {
        const toggle = this.app.elements.searchToggle;
        toggle.setAttribute('aria-pressed', this.app.searchEnabled);
        toggle.classList.toggle('search-active', this.app.searchEnabled);
    }

    /**
     * Updates the visual state of the memory toggle.
     */
    updateMemoryToggleUI() {
        const toggle = document.getElementById('memory-toggle');
        if (!toggle) return;
        toggle.setAttribute('aria-pressed', this.app.memoryEnabled);
        toggle.classList.toggle('search-active', this.app.memoryEnabled);
    }

    /**
     * Updates the visual state of the reasoning toggle.
     */
    updateReasoningToggleUI() {
        const toggle = document.getElementById('reasoning-toggle-btn');
        if (!toggle) return;
        toggle.classList.toggle('switch-active', this.app.reasoningEnabled);
        toggle.classList.toggle('switch-inactive', !this.app.reasoningEnabled);
    }

    /**
     * Sets up theme selection controls (segmented toggle) and listeners.
     * Uses event delegation on the container with stopPropagation to prevent
     * the document click handler from closing the settings menu.
     */
    setupThemeControls() {
        const themeToggle = this.app.elements.themeToggle;
        if (!themeToggle) return;

        themeToggle.addEventListener('click', (event) => {
            event.stopPropagation(); // Prevent settings menu from closing
            const btn = event.target.closest('.theme-toggle-btn');
            if (btn) {
                const preference = btn.dataset.themeOption || 'system';
                themeManager.setPreference(preference);
            }
        });
    }

    /**
     * Updates the visual state of theme toggle based on current preference.
     * @param {string} preference - Theme preference (light, dark, system)
     * @param {string} effectiveTheme - Actual theme being used
     */
    updateThemeControls(preference, effectiveTheme) {
        const themeToggle = this.app.elements.themeToggle;

        // Update the container's data-theme attribute for CSS indicator positioning
        if (themeToggle) {
            themeToggle.dataset.theme = preference;
        }

        // Update aria-checked on buttons
        if (this.app.elements.themeOptionButtons && this.app.elements.themeOptionButtons.length > 0) {
            this.app.elements.themeOptionButtons.forEach((button) => {
                const option = button.dataset.themeOption;
                button.setAttribute('aria-checked', String(option === preference));
            });
        }

        // Update effective theme label
        if (this.app.elements.themeEffectiveLabel) {
            if (preference === 'system') {
                this.app.elements.themeEffectiveLabel.textContent = `Using ${this.formatThemeName(effectiveTheme)} (system)`;
            } else {
                this.app.elements.themeEffectiveLabel.textContent = `Using ${this.formatThemeName(preference)} theme`;
            }
        }
    }

    /**
     * Formats theme name for display (capitalizes first letter).
     * @param {string} theme - Theme name
     * @returns {string} Formatted name
     */
    formatThemeName(theme) {
        if (!theme) return '';
        return theme.charAt(0).toUpperCase() + theme.slice(1);
    }

    /**
     * Copies the latest assistant message's markdown to clipboard.
     * @param {HTMLElement} buttonElement - Optional button element for visual feedback
     */
    async copyLatestMarkdown(buttonElement = null) {
        const session = this.app.getCurrentSession();
        if (!session) {
            alert('No active session');
            return;
        }

        const messages = await chatDB.getSessionMessages(session.id);
        const assistantMessages = messages.filter(m => m.role === 'assistant');

        if (assistantMessages.length === 0) {
            alert('No assistant responses to copy');
            if (buttonElement) {
                this.app.elements.settingsMenu.classList.add('hidden');
            }
            return;
        }

        // Get the latest assistant message
        const latestMessage = assistantMessages[assistantMessages.length - 1];

        try {
            await navigator.clipboard.writeText(latestMessage.content);

            // Provide visual feedback if button element is provided
            if (buttonElement) {
                const originalText = buttonElement.textContent;
                buttonElement.textContent = '✓ Copied!';
                setTimeout(() => {
                    buttonElement.textContent = originalText;
                    this.app.elements.settingsMenu.classList.add('hidden');
                }, 1500);
            }
        } catch (err) {
            console.error('Failed to copy markdown:', err);
            alert('Failed to copy to clipboard');
            if (buttonElement) {
                this.app.elements.settingsMenu.classList.add('hidden');
            }
        }
    }

    /**
     * Handles the Export All Data action.
     * Exports all user data (chats, tickets, preferences) as a JSON file.
     */
    async handleExportAllData() {
        try {
            const success = await exportAllData();
            if (success) {
                this.app.showToast?.('Data exported successfully', 'success');
            } else {
                this.app.showToast?.('Failed to export data', 'error');
            }
        } catch (error) {
            console.error('Export failed:', error);
            this.app.showToast?.('Failed to export data', 'error');
        }
    }

    /**
     * Handles the Export Chats action.
     * Exports only chat sessions and messages as a JSON file.
     */
    async handleExportChats() {
        try {
            const success = await exportChats();
            if (success) {
                this.app.showToast?.('Chats exported successfully', 'success');
            } else {
                this.app.showToast?.('Failed to export chats', 'error');
            }
        } catch (error) {
            console.error('Chat export failed:', error);
            this.app.showToast?.('Failed to export chats', 'error');
        }
    }

    /**
     * Handles the Export Tickets action.
     * Exports inference tickets as a JSON file.
     */
    async handleExportTickets() {
        try {
            const result = await exportTickets();
            if (result.cancelled) {
                // User cancelled - no toast needed
                return;
            }
            if (result.success) {
                const total = result.activeCount + result.archivedCount;
                this.app.showToast?.(`Exported ${total} ticket${total !== 1 ? 's' : ''} and cleared storage`, 'success');
            } else {
                this.app.showToast?.('Failed to export tickets', 'error');
            }
        } catch (error) {
            console.error('Ticket export failed:', error);
            this.app.showToast?.('Failed to export tickets', 'error');
        }
    }

    /**
     * Handles the Import Tickets action.
     * Opens the file picker to select a tickets JSON file.
     */
    handleImportTickets() {
        const input = document.getElementById('tickets-import-input');
        if (input) {
            input.click();
        }
        this.app.elements.settingsMenu.classList.add('hidden');
    }

    /**
     * Processes the selected tickets import file.
     * @param {File} file - The tickets JSON file
     */
    async processTicketsImportFile(file) {
        const dismissToast = this.app.showLoadingToast?.('Importing tickets...');
        try {
            const text = await file.text();
            const payload = JSON.parse(text);

            const result = await ticketClient.importTickets(payload);
            const addedActive = result.addedActive || 0;
            const addedArchived = result.addedArchived || 0;
            const totalAdded = addedActive + addedArchived;

            if (totalAdded > 0) {
                this.app.showToast?.(
                    `Imported ${totalAdded} ticket${totalAdded !== 1 ? 's' : ''} (${addedActive} active, ${addedArchived} used).`,
                    'success'
                );

                // Refresh right panel if it exists
                this.app.rightPanel?.loadNextTicket?.();
            } else {
                this.app.showToast?.('No new tickets to import', 'info');
            }
        } catch (error) {
            console.error('Ticket import failed:', error);
            this.app.showToast?.(error.message || 'Failed to import tickets', 'error');
        } finally {
            dismissToast?.();
        }
    }

    /**
     * Handles the Import Data action.
     * Opens the file picker to select a backup JSON file.
     */
    handleImportData() {
        const input = document.getElementById('global-import-input');
        if (input) {
            input.click();
        }
        this.app.elements.settingsMenu.classList.add('hidden');
    }

    /**
     * Processes the selected import file.
     * @param {File} file - The backup JSON file
     */
    async processImportFile(file) {
        const dismissToast = this.app.showLoadingToast?.('Importing data...');
        try {
            const result = await importFromFile(file);

            if (result.success) {
                const message = formatImportSummary(result.summary);
                this.app.showToast?.(message, 'success');

                // Refresh UI to reflect imported data
                if (result.summary.importedSessions > 0) {
                    if (typeof this.app.reloadSessions === 'function') {
                        try {
                            await this.app.reloadSessions();
                        } catch (error) {
                            console.warn('Failed to reload sessions after import:', error);
                        }
                    }
                }

                // Preferences are applied inline; avoid blocking UI with reload prompts.
            } else {
                this.app.showToast?.(result.error || 'Import failed', 'error');
            }
        } catch (error) {
            console.error('Import processing failed:', error);
            this.app.showToast?.('Failed to import data', 'error');
        } finally {
            dismissToast?.();
        }
    }

    /**
     * Handles mention input detection - opens memory selector when @ is typed.
     */
    handleMentionInput() {
        if (!this.app.memoryEnabled) {
            return;
        }
        const context = mentionService.checkMentionContext();

        if (!context) {
            return;
        }

        // When @ is detected, open memory selector with current input as query
        const input = this.app.elements.messageInput;
        const query = input.value.replace(/@/g, '').trim(); // Remove @ symbols for cleaner query
        
        // Remove the @ from input
        const cursorPos = input.selectionStart;
        const textBeforeCursor = input.value.substring(0, cursorPos);
        const textAfterCursor = input.value.substring(cursorPos);
        const lastAtIndex = textBeforeCursor.lastIndexOf('@');
        
        if (lastAtIndex >= 0) {
            const beforeAt = input.value.substring(0, lastAtIndex);
            const afterAt = input.value.substring(lastAtIndex + 1);
            input.value = beforeAt + afterAt;
            input.selectionStart = input.selectionEnd = lastAtIndex;
        }
        
        // Open memory selector
        this.app.memorySelector?.open(query);
    }

    /**
     * Render memory chips in the input area
     * @param {Array} memories - Array of memory objects to display as chips
     */
    renderMemoryChips(memories) {
        const container = document.getElementById('memory-chips-container');
        if (!container) return;

        if (!memories || memories.length === 0) {
            container.classList.add('hidden');
            container.innerHTML = '';
            return;
        }

        container.classList.remove('hidden');
        
        // Add show full prompt button
        const showPromptBtn = `
            <button 
                id="show-full-prompt-btn" 
                class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium transition-colors border border-border bg-muted/50 hover:bg-muted text-foreground"
                type="button"
                title="Show complete prompt with memory context"
            >
                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="w-3.5 h-3.5">
                    <path stroke-linecap="round" stroke-linejoin="round" d="M2.036 12.322a1.012 1.012 0 0 1 0-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178Z" />
                    <path stroke-linecap="round" stroke-linejoin="round" d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" />
                </svg>
                Show full prompt
            </button>
        `;
        
        const chipsHtml = memories.map((memory, index) => {
            const title = memory.title || `Memory ${index + 1}`;

            return `
                <div class="memory-chip" data-memory-index="${index}">
                    <span class="memory-chip-text">${this.escapeHtml(title)}</span>
                    <button class="memory-chip-remove" type="button" aria-label="Remove memory" data-memory-index="${index}">
                        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
                        </svg>
                    </button>
                </div>
            `;
        }).join('');
        
        container.innerHTML = `
            <div class="flex items-center gap-2 flex-wrap">
                ${chipsHtml}
                ${showPromptBtn}
            </div>
        `;

        // Add click handler for show full prompt button
        const showPromptButton = container.querySelector('#show-full-prompt-btn');
        if (showPromptButton) {
            showPromptButton.addEventListener('click', (e) => {
                e.stopPropagation();
                this.showFullPromptPreview();
            });
        }

        // Add click handlers for remove buttons
        container.querySelectorAll('.memory-chip-remove').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const index = parseInt(btn.dataset.memoryIndex);
                this.removeMemoryChip(index);
            });
        });
    }

    /**
     * Remove a memory chip by index
     * @param {number} index - Index of the memory to remove
     */
    removeMemoryChip(index) {
        if (!this.app.pendingMemoryContext || !this.app.pendingMemoryContext.memories) {
            return;
        }

        // Remove from pendingMemoryContext
        this.app.pendingMemoryContext.memories.splice(index, 1);
        this.app.pendingMemoryContext.sessionIds.splice(index, 1);

        // If no memories left, clear the context
        if (this.app.pendingMemoryContext.memories.length === 0) {
            this.app.pendingMemoryContext = null;
            this.renderMemoryChips([]);
        } else {
            // Re-render chips
            this.renderMemoryChips(this.app.pendingMemoryContext.memories);
        }
    }

    /**
     * Clear all memory chips
     */
    clearMemoryChips() {
        this.app.pendingMemoryContext = null;
        this.renderMemoryChips([]);
    }

    /**
     * Show full prompt preview modal with memory context
     */
    showFullPromptPreview() {
        if (!this.app.pendingMemoryContext || !this.app.pendingMemoryContext.memories) {
            return;
        }

        const userQuery = this.app.elements.messageInput.value.trim();
        const memories = this.app.pendingMemoryContext.memories;

        // Build the full prompt as it will be sent to the API
        const memoryContent = memories.map((m, idx) => {
            const content = m.fullContent || m.displayContent || m.content || m.summary || '';
            return `--- Retrieved Context ${idx + 1}: ${m.title || 'Untitled'} ---\n${content}`;
        }).join('\n\n');
        
        const fullPrompt = `${memoryContent}\n\n--- User Query ---\n${userQuery}`;

        // Create modal
        const modal = document.createElement('div');
        modal.className = 'full-prompt-preview-modal';
        modal.innerHTML = `
            <div class="full-prompt-preview-content">
                <div class="full-prompt-preview-header">
                    <div class="full-prompt-preview-title">
                        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="w-5 h-5">
                            <path stroke-linecap="round" stroke-linejoin="round" d="M2.036 12.322a1.012 1.012 0 0 1 0-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178Z" /><path stroke-linecap="round" stroke-linejoin="round" d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" />
                        </svg>
                        Full Prompt Preview
                    </div>
                    <button class="full-prompt-preview-close" id="close-prompt-preview-input">
                        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="w-5 h-5">
                            <path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" />
                        </svg>
                    </button>
                </div>
                <div class="full-prompt-preview-body">
                    <div class="full-prompt-section">
                        <div class="full-prompt-section-title">
                            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="w-4 h-4">
                                <path stroke-linecap="round" stroke-linejoin="round" d="M12 6.042A8.967 8.967 0 0 0 6 3.75c-1.052 0-2.062.18-3 .512v14.25A8.987 8.987 0 0 1 6 18c2.305 0 4.408.867 6 2.292m0-14.25a8.966 8.966 0 0 1 6-2.292c1.052 0 2.062.18 3 .512v14.25A8.987 8.987 0 0 0 18 18a8.967 8.967 0 0 0-6 2.292m0-14.25v14.25" />
                            </svg>
                            Retrieved Context (${memories.length} item${memories.length === 1 ? '' : 's'})
                        </div>
                        <div>
                            ${memories.map((m, idx) => {
                                const content = m.fullContent || m.displayContent || m.content || m.summary || '';
                                return `
                                    <div class="full-prompt-memory-item collapsible" data-memory-index="${idx}">
                                        <div class="full-prompt-memory-title collapsible-header">
                                            <svg class="collapsible-icon" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor">
                                                <path stroke-linecap="round" stroke-linejoin="round" d="m19.5 8.25-7.5 7.5-7.5-7.5" />
                                            </svg>
                                            <span>${idx + 1}. ${this.escapeHtml(m.title || 'Untitled')}</span>
                                        </div>
                                        <div class="full-prompt-memory-content collapsible-content">${this.escapeHtml(content)}</div>
                                    </div>
                                `;
                            }).join('')}
                        </div>
                    </div>
                    <div class="full-prompt-section">
                        <div class="full-prompt-section-title">
                            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="w-4 h-4">
                                <path stroke-linecap="round" stroke-linejoin="round" d="M15.75 6a3.75 3.75 0 1 1-7.5 0 3.75 3.75 0 0 1 7.5 0ZM4.501 20.118a7.5 7.5 0 0 1 14.998 0A17.933 17.933 0 0 1 12 21.75c-2.676 0-5.216-.584-7.499-1.632Z" />
                            </svg>
                            Your Message
                        </div>
                        <div class="full-prompt-section-content">${this.escapeHtml(userQuery)}</div>
                    </div>
                    <div class="full-prompt-section">
                        <div class="full-prompt-section-title">
                            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="w-4 h-4">
                                <path stroke-linecap="round" stroke-linejoin="round" d="M6.75 7.5l3 2.25-3 2.25m4.5 0h3m-9 8.25h13.5A2.25 2.25 0 0021 18V6a2.25 2.25 0 00-2.25-2.25H5.25A2.25 2.25 0 003 6v12a2.25 2.25 0 002.25 2.25z" />
                            </svg>
                            Complete Prompt to be Sent
                            <span class="full-prompt-edit-hint">(editable)</span>
                        </div>
                        <textarea class="full-prompt-section-editable" id="full-prompt-textarea">${this.escapeHtml(fullPrompt)}</textarea>
                    </div>
                </div>
                <div class="full-prompt-preview-footer">
                    <div class="full-prompt-hint">
                        <kbd class="inline-flex items-center justify-center rounded border border-border bg-muted px-2 py-1 text-xs font-mono">Esc</kbd>
                        <span>to close</span>
                    </div>
                    <div class="full-prompt-footer-actions">
                        <button class="full-prompt-copy-btn" id="copy-full-prompt-input">
                            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="w-4 h-4">
                                <path stroke-linecap="round" stroke-linejoin="round" d="M15.666 3.888A2.25 2.25 0 0 0 13.5 2.25h-3c-1.03 0-1.9.693-2.166 1.638m7.332 0c.055.194.084.4.084.612v0a.75.75 0 0 1-.75.75H9a.75.75 0 0 1-.75-.75v0c0-.212.03-.418.084-.612m7.332 0c.646.049 1.288.11 1.927.184 1.1.128 1.907 1.077 1.907 2.185V19.5a2.25 2.25 0 0 1-2.25 2.25H6.75A2.25 2.25 0 0 1 4.5 19.5V6.257c0-1.108.806-2.057 1.907-2.185a48.208 48.208 0 0 1 1.927-.184" />
                            </svg>
                            Copy
                        </button>
                        <button class="full-prompt-use-btn" id="use-edited-prompt-btn">
                            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="w-4 h-4">
                                <path stroke-linecap="round" stroke-linejoin="round" d="M9 12.75 11.25 15 15 9.75M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" />
                            </svg>
                            Use This Prompt
                        </button>
                    </div>
                </div>
            </div>
        `;

        document.body.appendChild(modal);

        // Add collapsible functionality for memory items
        modal.querySelectorAll('.collapsible-header').forEach(header => {
            header.addEventListener('click', (e) => {
                e.stopPropagation();
                const item = header.closest('.collapsible');
                item.classList.toggle('collapsed');
            });
        });

        // Event listeners
        const closeBtn = modal.querySelector('#close-prompt-preview-input');
        const copyBtn = modal.querySelector('#copy-full-prompt-input');
        const useBtn = modal.querySelector('#use-edited-prompt-btn');
        const promptTextarea = modal.querySelector('#full-prompt-textarea');

        const closeModal = () => {
            modal.remove();
        };

        closeBtn.addEventListener('click', closeModal);
        modal.addEventListener('click', (e) => {
            if (e.target === modal) {
                closeModal();
            }
        });

        copyBtn.addEventListener('click', async () => {
            const currentPrompt = promptTextarea.value;
            try {
                await navigator.clipboard.writeText(currentPrompt);
                copyBtn.innerHTML = `
                    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="w-4 h-4">
                        <path stroke-linecap="round" stroke-linejoin="round" d="m4.5 12.75 6 6 9-13.5" />
                    </svg>
                    Copied!
                `;
                setTimeout(() => {
                    copyBtn.innerHTML = `
                        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="w-4 h-4">
                            <path stroke-linecap="round" stroke-linejoin="round" d="M15.666 3.888A2.25 2.25 0 0 0 13.5 2.25h-3c-1.03 0-1.9.693-2.166 1.638m7.332 0c.055.194.084.4.084.612v0a.75.75 0 0 1-.75.75H9a.75.75 0 0 1-.75-.75v0c0-.212.03-.418.084-.612m7.332 0c.646.049 1.288.11 1.927.184 1.1.128 1.907 1.077 1.907 2.185V19.5a2.25 2.25 0 0 1-2.25 2.25H6.75A2.25 2.25 0 0 1 4.5 19.5V6.257c0-1.108.806-2.057 1.907-2.185a48.208 48.208 0 0 1 1.927-.184" />
                        </svg>
                        Copy
                    `;
                }, 2000);
            } catch (err) {
                console.error('Failed to copy:', err);
            }
        });

        useBtn.addEventListener('click', () => {
            const editedPrompt = promptTextarea.value.trim();
            if (editedPrompt) {
                // Set the edited prompt in the message input
                this.app.elements.messageInput.value = editedPrompt;
                
                // Clear memory context since we're using the edited full prompt
                this.app.pendingMemoryContext = null;
                this.clearMemoryChips();
                
                // Trigger input event to update UI
                this.app.elements.messageInput.dispatchEvent(new Event('input'));
                
                // Close modal
                closeModal();
                
                // Focus the input
                this.app.elements.messageInput.focus();
            }
        });

        // Keyboard handler
        const handleKeydown = (e) => {
            if (e.key === 'Escape') {
                closeModal();
                document.removeEventListener('keydown', handleKeydown);
            }
        };
        document.addEventListener('keydown', handleKeydown);

        // Clean up on close
        modal.addEventListener('remove', () => {
            document.removeEventListener('keydown', handleKeydown);
        });
    }

    /**
     * Escape HTML to prevent XSS
     * @param {string} text - Text to escape
     * @returns {string} - Escaped text
     */
    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }
}

