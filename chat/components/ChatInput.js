/**
 * ChatInput Component
 * Manages the chat input area including textarea auto-resize,
 * send button state, search toggle UI, and settings dropdown.
 */

import themeManager from '../services/themeManager.js';
import preferencesStore, { PREF_KEYS } from '../services/preferencesStore.js';
import { exportAllData, exportChats, exportTickets } from '../services/globalExport.js';
import { importFromFile, formatImportSummary } from '../services/globalImport.js';
import scrubberService from '../services/scrubberService.js';
import {
    renderEditableDiff,
    extractTextFromEditableDiff,
    handleEditableDiffPaste,
    updateEditableDiff,
    getEditableDiffSelectionState
} from '../services/editableDiffRenderer.js';
import { normalizeReasoningEffort } from '../services/reasoningConfig.js';
import { getProviderIcon } from '../services/providerIcons.js';
import { onModelTiersUpdate } from '../services/modelTiers.js';
import {
    RESPONSE_MODE_COUNCIL,
    COUNCIL_OUTPUT_PARALLEL,
    COUNCIL_OUTPUT_SYNTHESIS
} from '../domain/councilConfig.js';
import {
    findModelByNameOrId,
    getComposerModelDisplayName,
    getProviderlessModelDisplayName,
    getConfiguredSecondaryModelNameForModels,
    getDefaultSecondaryModelNameForModels,
    resolvePrimaryModelNameForModels,
    resolveSecondaryModelNameForModels,
    resolveSynthesisModelNameForModels
} from '../domain/modelSelection.js';

const MESSAGE_INPUT_MAX_HEIGHT_PX = 300;
const MESSAGE_INPUT_PREVIEW_EXPANDED_MIN_HEIGHT_PX = 384;
const SETTINGS_MENU_WIDTH_PX = 260;

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
        this.memoryAgentModelSelect = null;
        this.multiModelSecondarySelect = null;
        this.multiModelSecondaryInlineSelect = null;
        this.multiModelSecondaryInlineButton = null;
        this.multiModelSynthesisSelect = null;
        this.multiModelModeSelect = null;
        this.councilSynthesisInlineSelect = null;
        this.councilSynthesisInlineButton = null;
        this.councilReviewToggle = null;
        this.councilReviewModelSelect = null;
        onModelTiersUpdate(() => this.refreshMultiModelSettingsUI());
        this.applyComposerLayout();
        // Store undone scrubber state for redo functionality
        this.scrubberUndoState = null;
    }

    getComposerToolElements() {
        return {
            toolsContainer: document.getElementById('composer-more-menu'),
            fileAction: document.getElementById('composer-file-action'),
            settingsControl: document.getElementById('composer-settings-control'),
            settingsActions: document.getElementById('composer-settings-actions'),
            searchToggle: document.getElementById('search-toggle')
        };
    }

    placeComposerToolControls() {
        if (typeof document === 'undefined') return;
        const {
            toolsContainer,
            fileAction,
            settingsControl,
            settingsActions,
            searchToggle
        } = this.getComposerToolElements();
        if (!toolsContainer || !fileAction || !settingsControl || !settingsActions || !searchToggle) return;

        toolsContainer.append(fileAction, settingsControl);
        settingsActions.append(searchToggle);
    }

    applyComposerLayout() {
        if (typeof document === 'undefined') return;
        if (!document.documentElement.dataset.composerMode) {
            document.documentElement.dataset.composerMode = 'chat';
        }
        this.placeComposerToolControls();
    }

    setComposerModeDataset(isCouncilEnabled) {
        const mode = isCouncilEnabled ? 'parallel' : 'chat';
        if (typeof document !== 'undefined') {
            document.documentElement.dataset.composerMode = mode;
        }
        return mode;
    }


    /**
     * Sets up all event listeners for the input area controls.
     */
    setupEventListeners() {
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
            this.syncScrubberPreviewHeight();
            this.app.updateInputState();
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
            await this.app.data.saveSetting('searchEnabled', this.app.searchEnabled);
        });

        if (this.app.elements.memoryToggle) {
            this.app.elements.memoryToggle.addEventListener('click', async (e) => {
                const button = e.target.closest('.chat-mode-toggle-btn');
                if (!button) return;

                const mode = button.dataset.modeOption || 'chat';
                const isParallel = mode === 'parallel';
                const container = this.app.elements.memoryToggle;
                container.classList.add('sliding');
                setTimeout(() => container.classList.remove('sliding'), 250);

                if (isParallel) {
                    await this.setCouncilModeFromComposer(true);
                } else {
                    await this.setCouncilModeFromComposer(false);
                }

                this.updateMemoryToggleUI();
                this.refreshMultiModelSettingsUI();
            });
        }

        if (this.app.elements.memoryContextToggle) {
            this.app.elements.memoryContextToggle.addEventListener('click', (event) => {
                this.handleMemoryContextToggleClick(event);
            });
        }

        // Reasoning effort control (extended-thinking toggle removed from UI;
        // reasoning is kept enabled in app state for backward-compatible behavior)
        const reasoningEffortToggle = document.getElementById('reasoning-effort-toggle');
        if (reasoningEffortToggle) {
            reasoningEffortToggle.addEventListener('click', async (e) => {
                e.stopPropagation();
                const btn = e.target.closest('.reasoning-effort-btn');
                if (!btn || btn.disabled) return;

                const nextEffort = normalizeReasoningEffort(btn.dataset.reasoningEffort);
                this.app.reasoningEffort = nextEffort;
                this.updateReasoningEffortUI();
                await this.app.data.saveSetting('reasoningEffort', nextEffort);
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
                const btnRect = btn.getBoundingClientRect();
                // Move menu to body for backdrop-filter to work (escapes input-card stacking context)
                document.body.appendChild(menu);
                menu.classList.remove('hidden');
                btn.classList.add('tooltip-disabled'); // Hide tooltip while menu is open

                // Position relative to settings button
                menu.style.left = `${btnRect.left}px`;
                menu.style.bottom = `${window.innerHeight - btnRect.top + 8}px`;
                menu.style.width = `${SETTINGS_MENU_WIDTH_PX}px`;
                menu.style.minWidth = `${SETTINGS_MENU_WIDTH_PX}px`;
                menu.style.maxWidth = `${SETTINGS_MENU_WIDTH_PX}px`;

                this.ensureScrubberModelsLoaded();
                this.refreshMemorySettingsUI();
                this.refreshMultiModelSettingsUI();
            } else {
                menu.classList.add('hidden');
                btn.classList.remove('tooltip-disabled');
            }
        });

        const secondarySelect = document.getElementById('multi-model-secondary-select');
        if (secondarySelect) {
            this.multiModelSecondarySelect = secondarySelect;
            secondarySelect.addEventListener('click', (event) => event.stopPropagation());
            secondarySelect.addEventListener('change', async (event) => {
                event.stopPropagation();
                if (this.multiModelSecondaryInlineSelect) {
                    this.multiModelSecondaryInlineSelect.value = event.target.value;
                }
                await this.persistCouncilSelectionFromControls();
            });
        }

        const secondaryInlineSelect = document.getElementById('council-secondary-inline-select');
        if (secondaryInlineSelect) {
            this.multiModelSecondaryInlineSelect = secondaryInlineSelect;
            secondaryInlineSelect.addEventListener('click', (event) => event.stopPropagation());
            secondaryInlineSelect.addEventListener('change', async (event) => {
                event.stopPropagation();
                if (this.multiModelSecondarySelect) {
                    this.multiModelSecondarySelect.value = event.target.value;
                }
                await this.persistCouncilSelectionFromControls();
            });
        }

        const secondaryInlineButton = document.getElementById('council-secondary-model-btn');
        if (secondaryInlineButton) {
            this.multiModelSecondaryInlineButton = secondaryInlineButton;
            secondaryInlineButton.addEventListener('click', (event) => {
                event.stopPropagation();
                this.openCouncilSecondaryModelPicker();
            });
            secondaryInlineButton.addEventListener('keydown', (event) => {
                if (event.key !== 'ArrowDown' && event.key !== 'Enter' && event.key !== ' ') return;
                event.preventDefault();
                event.stopPropagation();
                this.openCouncilSecondaryModelPicker();
            });
        }

        const synthesisInlineSelect = document.getElementById('council-synthesis-inline-select');
        if (synthesisInlineSelect) {
            this.councilSynthesisInlineSelect = synthesisInlineSelect;
            synthesisInlineSelect.addEventListener('click', (event) => event.stopPropagation());
            synthesisInlineSelect.addEventListener('change', async (event) => {
                event.stopPropagation();
                if (this.councilReviewModelSelect) {
                    this.councilReviewModelSelect.value = event.target.value;
                }
                if (this.multiModelSynthesisSelect) {
                    this.multiModelSynthesisSelect.value = event.target.value;
                }
                await this.persistCouncilSelectionFromControls();
            });
        }

        const councilReviewToggle = document.getElementById('council-review-toggle');
        if (councilReviewToggle) {
            this.councilReviewToggle = councilReviewToggle;
            councilReviewToggle.addEventListener('click', async (event) => {
                event.preventDefault();
                event.stopPropagation();
                const enabled = councilReviewToggle.getAttribute('aria-checked') !== 'true';
                await this.setCouncilReviewEnabledFromSettings(enabled);
            });
        }

        const councilReviewModelSelect = document.getElementById('council-review-model-select');
        if (councilReviewModelSelect) {
            this.councilReviewModelSelect = councilReviewModelSelect;
            councilReviewModelSelect.addEventListener('click', (event) => event.stopPropagation());
            councilReviewModelSelect.addEventListener('change', async (event) => {
                event.stopPropagation();
                if (this.councilSynthesisInlineSelect) {
                    this.councilSynthesisInlineSelect.value = event.target.value;
                }
                if (this.multiModelSynthesisSelect) {
                    this.multiModelSynthesisSelect.value = event.target.value;
                }
                await this.persistCouncilSelectionFromControls();
            });
        }

        const modeSelect = document.getElementById('multi-model-mode-select');
        if (modeSelect) {
            this.multiModelModeSelect = modeSelect;
            modeSelect.addEventListener('click', (event) => event.stopPropagation());
            modeSelect.addEventListener('change', async (event) => {
                event.stopPropagation();
                const session = this.app.getCurrentSession();
                const members = this.getMultiModelMembersForSelection();
                const synthesisModel = this.getCouncilSynthesisModelForSelection();
                const outputMode = this.getMultiModelOutputModeForSelection();
                const enabled = session
                    ? session.responseMode === RESPONSE_MODE_COUNCIL && session.councilConfig?.enabled === true
                    : this.app.getPendingCouncilConfig?.()?.enabled === true;
                await this.persistParallelDefaults({
                    enabled,
                    members,
                    synthesisModel,
                    outputMode
                });
                if (!session) {
                    const pendingCouncilConfig = this.app.getPendingCouncilConfig?.();
                    this.app.setPendingCouncilConfig?.({
                        enabled: pendingCouncilConfig?.enabled === true,
                        members,
                        synthesisModel,
                        outputMode,
                        reviewEnabled: false
                    });
                    this.refreshMultiModelSettingsUI();
                    return;
                }
                await this.app.setCouncilModeForCurrentSession({
                    enabled,
                    members,
                    synthesisModel,
                    outputMode
                });
                this.refreshMultiModelSettingsUI();
            });
        }

        const synthesisSelect = document.getElementById('multi-model-synthesis-select');
        if (synthesisSelect) {
            this.multiModelSynthesisSelect = synthesisSelect;
            synthesisSelect.addEventListener('click', (event) => event.stopPropagation());
            synthesisSelect.addEventListener('change', async (event) => {
                event.stopPropagation();
                if (this.councilReviewModelSelect) {
                    this.councilReviewModelSelect.value = event.target.value;
                }
                if (this.councilSynthesisInlineSelect) {
                    this.councilSynthesisInlineSelect.value = event.target.value;
                }
                const session = this.app.getCurrentSession();
                const members = this.getMultiModelMembersForSelection();
                const synthesisModel = this.getCouncilSynthesisModelForSelection();
                const outputMode = this.getMultiModelOutputModeForSelection();
                const enabled = session
                    ? session.responseMode === RESPONSE_MODE_COUNCIL && session.councilConfig?.enabled === true
                    : this.app.getPendingCouncilConfig?.()?.enabled === true;
                await this.persistParallelDefaults({
                    enabled,
                    members,
                    synthesisModel,
                    outputMode
                });
                if (!session) {
                    const pendingCouncilConfig = this.app.getPendingCouncilConfig?.();
                    this.app.setPendingCouncilConfig?.({
                        enabled: pendingCouncilConfig?.enabled === true,
                        members,
                        synthesisModel,
                        outputMode,
                        reviewEnabled: false
                    });
                    this.refreshMultiModelSettingsUI();
                    return;
                }
                await this.app.setCouncilModeForCurrentSession({
                    enabled,
                    members,
                    synthesisModel,
                    outputMode
                });
                this.refreshMultiModelSettingsUI();
            });
        }

        // Settings menu actions
        // Stop propagation for all clicks inside the menu to prevent document click handler from closing it
        this.app.elements.settingsMenu.addEventListener('click', async (e) => {
            e.stopPropagation();
            if (e.target.closest('#file-upload-btn, #search-toggle')) {
                return;
            }
            // Skip toggle buttons - they have their own handlers
            if (e.target.closest('.display-toggle-container') || e.target.closest('.theme-toggle-container')) {
                return;
            }
            if (e.target.tagName === 'BUTTON') {
                const action = e.target.dataset.action || e.target.textContent.trim();

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
                } else if (action === 'export-memory') {
                    await this.handleExportMemory();
                } else if (action === 'import-memory') {
                    this.handleImportMemory();
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

        const memoryImportInput = document.getElementById('memory-import-input');
        if (memoryImportInput) {
            memoryImportInput.addEventListener('change', async (e) => {
                const file = e.target.files?.[0];
                if (file) {
                    await this.processMemoryImportFile(file);
                }
                e.target.value = '';
            });
        }

        // Clear chat functionality (temporarily disabled)
        // this.app.elements.clearChatBtn.addEventListener('click', async () => {
        //     const session = this.app.getCurrentSession();
        //     if (session) {
        //         await this.app.data.deleteSessionMessages(session.id);
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
        this.setupMemoryFeatureToggle();
        this.setupMemoryAutoIncludeToggle();
        this.refreshMemorySettingsUI();

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
        this.syncScrubberPreviewHeight();

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
        this.syncScrubberPreviewHeight();

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
        this.resetScrubberPreviewHeight();
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
        this.resetScrubberPreviewHeight();
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
        this.resetScrubberPreviewHeight();
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

    syncScrubberPreviewHeight() {
        const previewDiff = this.app.elements.scrubberPreviewDiff;
        if (!previewDiff) return;

        const isExpanded = this.app.elements.inputCard?.classList.contains('scrubber-preview-expanded');
        const expandedMax = Math.floor(window.innerHeight * 0.55);
        const maxHeight = isExpanded
            ? Math.max(MESSAGE_INPUT_PREVIEW_EXPANDED_MIN_HEIGHT_PX, expandedMax)
            : MESSAGE_INPUT_MAX_HEIGHT_PX;

        previewDiff.style.maxHeight = `${maxHeight}px`;
    }

    resetScrubberPreviewHeight() {
        const previewDiff = this.app.elements.scrubberPreviewDiff;
        if (!previewDiff) return;
        previewDiff.style.removeProperty('max-height');
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
        const scrubberSelect = document.getElementById('scrubber-model-select');
        if (scrubberSelect) {
            scrubberSelect.addEventListener('click', (event) => event.stopPropagation());
            scrubberSelect.addEventListener('change', async (event) => {
                const modelId = event.target.value;
                if (modelId) {
                    await scrubberService.setSelectedModel(modelId);
                    this.refreshMemorySettingsUI();
                }
            });
        }
        this.scrubberModelSelect = scrubberSelect;

        const memoryAgentSelect = document.getElementById('memory-agent-model-select');
        if (memoryAgentSelect) {
            memoryAgentSelect.addEventListener('click', (event) => event.stopPropagation());
            memoryAgentSelect.addEventListener('change', async (event) => {
                const modelId = event.target.value;
                if (modelId) {
                    await this.app.setMemoryAgentModel(modelId);
                    this.refreshMemorySettingsUI();
                }
            });
        }
        this.memoryAgentModelSelect = memoryAgentSelect;
    }

    setupMemoryFeatureToggle() {
        const toggle = document.getElementById('memory-feature-toggle');
        if (!toggle) return;

        toggle.addEventListener('click', async (event) => {
            event.stopPropagation();
            const nextValue = this.app.memoryFeatureEnabled === false;
            await this.app.setMemoryFeatureEnabled(nextValue);
            this.refreshMemorySettingsUI();
            this.updateMemoryToggleUI();
        });
    }

    async ensureScrubberModelsLoaded() {
        if (this.scrubberModelsReady) {
            this.refreshMemorySettingsUI();
            return;
        }

        const selects = [this.scrubberModelSelect, this.memoryAgentModelSelect].filter(Boolean);
        if (!selects.length) return;

        try {
            const models = await scrubberService.fetchModels();
            this.populateConfidentialModels(this.scrubberModelSelect, models, scrubberService.getSelectedModel());
            this.populateConfidentialModels(this.memoryAgentModelSelect, models, this.app.memoryAgentModel);
            this.scrubberModelsReady = true;
        } catch (error) {
            console.error('Failed to load confidential models:', error);
            this.setModelSelectError(this.scrubberModelSelect);
            this.setModelSelectError(this.memoryAgentModelSelect);
        }
        this.refreshMemorySettingsUI();
    }

    populateConfidentialModels(selectEl, models, selected) {
        if (!selectEl) return;
        const options = models.map(model => {
            const value = model.id || model.name;
            let label = model.name || model.id;
            if (scrubberService.isSlowModel(value)) {
                label += ' (slow)';
            }
            return `<option value="${value}">${label}</option>`;
        }).join('');
        let html = options || '<option value="" disabled>No models available</option>';
        if (selected && !models.find(model => (model.id || model.name) === selected)) {
            html = `<option value="${selected}">${selected}</option>${html}`;
        }
        selectEl.innerHTML = html;
        if (selected) {
            selectEl.value = selected;
        }
    }

    setModelSelectError(selectEl) {
        if (!selectEl) return;
        selectEl.innerHTML = '<option value="" disabled>Failed to load models</option>';
    }

    setupMemoryAutoIncludeToggle() {
        const toggle = document.getElementById('memory-auto-include-toggle');
        if (!toggle) return;

        toggle.addEventListener('click', async (event) => {
            event.stopPropagation();
            if (this.app.memoryFeatureEnabled === false) {
                this.refreshMemorySettingsUI();
                return;
            }
            const nextValue = !this.app.memoryAutoInclude;
            await this.app.setMemoryAutoInclude(nextValue);
            this.refreshMemorySettingsUI();
        });
    }

    updateSwitchToggleUI(toggle, enabled, enabledTitle, disabledTitle) {
        if (!toggle) return;
        toggle.setAttribute('aria-checked', enabled ? 'true' : 'false');
        toggle.classList.toggle('switch-active', enabled);
        toggle.classList.toggle('switch-inactive', !enabled);
        toggle.title = enabled ? enabledTitle : disabledTitle;
        toggle.dataset.tooltip = enabled ? enabledTitle : disabledTitle;
    }

    refreshMemorySettingsUI() {
        const memoryFeatureEnabled = this.app.memoryFeatureEnabled !== false;
        this.updateSwitchToggleUI(
            document.getElementById('memory-feature-toggle'),
            memoryFeatureEnabled,
            'Memory feature is on',
            'Memory feature is off'
        );

        const memoryAutoIncludeToggle = document.getElementById('memory-auto-include-toggle');
        const effectiveMemoryAutoInclude = memoryFeatureEnabled && this.app.memoryAutoInclude;
        this.updateSwitchToggleUI(
            memoryAutoIncludeToggle,
            effectiveMemoryAutoInclude,
            'Always attach retrieval is on',
            memoryFeatureEnabled ? 'Always attach retrieval is off' : 'Memory is off in settings'
        );
        if (memoryAutoIncludeToggle) {
            memoryAutoIncludeToggle.disabled = !memoryFeatureEnabled;
            memoryAutoIncludeToggle.setAttribute('aria-disabled', String(!memoryFeatureEnabled));
        }

        if (this.scrubberModelSelect) {
            const selectedScrubberModel = scrubberService.getSelectedModel();
            if (selectedScrubberModel) {
                this.scrubberModelSelect.value = selectedScrubberModel;
            }
        }

        if (this.memoryAgentModelSelect && this.app.memoryAgentModel) {
            this.memoryAgentModelSelect.value = this.app.memoryAgentModel;
        }
        if (this.memoryAgentModelSelect) {
            this.memoryAgentModelSelect.disabled = !memoryFeatureEnabled;
            this.memoryAgentModelSelect.title = memoryFeatureEnabled
                ? 'Memory agent model'
                : 'Memory is off in settings';
        }

        document.querySelectorAll('[data-memory-requires-feature]').forEach((element) => {
            element.disabled = !memoryFeatureEnabled;
            element.setAttribute('aria-disabled', String(!memoryFeatureEnabled));
            element.title = memoryFeatureEnabled
                ? (element.dataset.enabledTitle || '')
                : 'Memory is off in settings';
        });
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
        toggle.setAttribute('aria-checked', this.app.searchEnabled ? 'true' : 'false');
        toggle.classList.toggle('search-active', this.app.searchEnabled);
        const stateLabel = toggle.querySelector('.composer-menu-state');
        if (stateLabel) {
            stateLabel.textContent = this.app.searchEnabled ? 'On' : 'Off';
        }
    }

    closeSettingsMenu() {
        const menu = this.app.elements.settingsMenu;
        const button = this.app.elements.settingsBtn;
        if (!menu) return;
        menu.classList.add('hidden');
        button?.classList.remove('tooltip-disabled');
    }

    async setMemoryContextEnabled(enabled) {
        if (enabled === true && this.app.memoryFeatureEnabled === false) {
            this.app.memoryMode = false;
            this.updateMemoryToggleUI();
            await this.app.data.saveSetting('memoryMode', false);
            return;
        }
        this.app.memoryMode = enabled === true;
        this.updateMemoryToggleUI();
        await this.app.data.saveSetting('memoryMode', this.app.memoryMode);
    }

    async openMemoryContextPanel() {
        if (this.app.memoryFeatureEnabled === false) {
            this.updateMemoryToggleUI();
            this.app.showToast?.('Memory is off in settings.', 'info', 3000);
            return;
        }
        await this.setMemoryContextEnabled(true);
        this.app.memoryEditor?.open?.();
    }

    handleMemoryContextToggleClick(event) {
        event.preventDefault();
        event.stopPropagation();

        if (this.app.memoryFeatureEnabled === false) {
            this.updateMemoryToggleUI();
            this.app.showToast?.('Memory is off in settings.', 'info', 3000);
            return;
        }

        if (event.detail >= 2) {
            this.openMemoryContextPanel().catch(error => {
                console.error('Failed to open memory panel:', error);
            });
            return;
        }

        this.setMemoryContextEnabled(!this.app.memoryMode).catch(error => {
            console.error('Failed to toggle memory context:', error);
        });
    }

    updateMemoryToggleUI() {
        const container = this.app.elements.memoryToggle;
        if (!container) return;

        const memoryFeatureEnabled = this.app.memoryFeatureEnabled !== false;
        const session = this.app.getCurrentSession();
        const pendingCouncilConfig = this.app.getPendingCouncilConfig?.();
        const isCouncilEnabled = session
            ? session.responseMode === RESPONSE_MODE_COUNCIL && session.councilConfig?.enabled === true
            : pendingCouncilConfig?.enabled === true;
        const mode = this.setComposerModeDataset(isCouncilEnabled);
        const isFirstRender = container.style.visibility === 'hidden';
        if (isFirstRender) {
            const indicator = container.querySelector('.chat-mode-toggle-indicator');
            if (indicator) indicator.style.transition = 'none';
            container.dataset.mode = mode;
            container.style.visibility = '';
            if (indicator) requestAnimationFrame(() => { indicator.style.transition = ''; });
        } else {
            container.dataset.mode = mode;
        }
        container.removeAttribute('aria-disabled');
        container.classList.remove('is-disabled');

        container.querySelectorAll('.chat-mode-toggle-btn').forEach((button) => {
            button.setAttribute('aria-checked', String(button.dataset.modeOption === mode));
            button.setAttribute('aria-disabled', 'false');
            button.tabIndex = 0;
        });

        const memoryButton = this.app.elements.memoryContextToggle;
        if (memoryButton) {
            const memoryEnabled = memoryFeatureEnabled && this.app.memoryMode === true;
            memoryButton.setAttribute('aria-checked', String(memoryEnabled));
            memoryButton.setAttribute('aria-disabled', String(!memoryFeatureEnabled));
            memoryButton.classList.toggle('memory-active', memoryEnabled);
            memoryButton.classList.toggle('memory-disabled', !memoryFeatureEnabled);
            memoryButton.title = memoryFeatureEnabled
                ? (memoryEnabled
                    ? 'Auto-attach memory is on. Double-click to open memory.'
                    : 'Auto-attach memory is off. Double-click to open memory.')
                : 'Memory is off in settings.';

            const tooltipText = memoryButton.querySelector('[data-memory-tooltip-text]');
            const tooltipDetail = memoryButton.querySelector('[data-memory-tooltip-detail]');
            const tooltipBeta = memoryButton.querySelector('[data-memory-tooltip-beta]');
            if (tooltipText) {
                tooltipText.textContent = memoryFeatureEnabled
                    ? 'Auto-attach relevant context'
                    : 'Memory is off in settings';
            }
            if (tooltipDetail) {
                tooltipDetail.classList.toggle('hidden', !memoryFeatureEnabled);
            }
            if (tooltipBeta) {
                tooltipBeta.classList.toggle('hidden', !memoryFeatureEnabled);
            }
        }
    }

    async setCouncilModeFromComposer(enabled, options = {}) {
        const members = this.getMultiModelMembersForSelection({ preferControlSelection: false });
        const synthesisModel = this.getCouncilSynthesisModelForSelection();
        const outputMode = enabled
            ? (options.outputMode || this.getMultiModelOutputModeForSelection())
            : COUNCIL_OUTPUT_PARALLEL;
        const session = this.app.getCurrentSession();
        await this.persistParallelDefaults({
            enabled,
            members,
            synthesisModel,
            outputMode
        });

        if (!session) {
            this.app.setPendingCouncilConfig?.({
                enabled,
                members,
                synthesisModel,
                outputMode,
                reviewEnabled: false
            });
            return null;
        }

        return this.app.setCouncilModeForCurrentSession({
            enabled,
            members,
            synthesisModel,
            outputMode
        });
    }

    async persistParallelDefaults(options = {}) {
        const enabled = options.enabled === true;
        const members = Array.isArray(options.members) ? options.members : this.getMultiModelMembersForSelection();
        const secondaryModel = typeof members[1] === 'string' && members[1].trim()
            ? members[1].trim()
            : null;
        const synthesisModel = typeof options.synthesisModel === 'string' && options.synthesisModel.trim()
            ? options.synthesisModel.trim()
            : null;
        const outputMode = options.outputMode === COUNCIL_OUTPUT_SYNTHESIS
            ? COUNCIL_OUTPUT_SYNTHESIS
            : COUNCIL_OUTPUT_PARALLEL;

        this.app.setParallelDefaults?.({
            enabled,
            secondaryModel,
            synthesisModel,
            outputMode
        });

        await Promise.all([
            this.app.data.saveSetting('parallelModeEnabled', enabled),
            this.app.data.saveSetting('parallelSecondaryModel', secondaryModel),
            this.app.data.saveSetting('parallelSynthesisModel', synthesisModel),
            this.app.data.saveSetting('parallelOutputMode', outputMode)
        ]);
    }

    async setCouncilReviewEnabledFromSettings(enabled) {
        const session = this.app.getCurrentSession();
        const pendingCouncilConfig = this.app.getPendingCouncilConfig?.();
        const currentlyMultiModelEnabled = session
            ? session.responseMode === RESPONSE_MODE_COUNCIL && session.councilConfig?.enabled === true
            : pendingCouncilConfig?.enabled === true;
        const nextMultiModelEnabled = enabled || currentlyMultiModelEnabled;
        const members = this.getMultiModelMembersForSelection();
        const synthesisModel = this.getCouncilSynthesisModelForSelection();
        const outputMode = enabled ? COUNCIL_OUTPUT_SYNTHESIS : COUNCIL_OUTPUT_PARALLEL;
        await this.persistParallelDefaults({
            enabled: nextMultiModelEnabled,
            members,
            synthesisModel,
            outputMode
        });

        if (!session) {
            this.app.setPendingCouncilConfig?.({
                enabled: nextMultiModelEnabled,
                members,
                synthesisModel,
                outputMode,
                reviewEnabled: false
            });
            this.refreshMultiModelSettingsUI();
            this.updateMemoryToggleUI();
            return;
        }

        await this.app.setCouncilModeForCurrentSession({
            enabled: nextMultiModelEnabled,
            members,
            synthesisModel,
            outputMode
        });
        this.refreshMultiModelSettingsUI();
        this.updateMemoryToggleUI();
    }

    async persistCouncilSelectionFromControls() {
        const session = this.app.getCurrentSession();
        const members = this.getMultiModelMembersForSelection();
        const synthesisModel = this.getCouncilSynthesisModelForSelection();
        const outputMode = this.getMultiModelOutputModeForSelection();
        const currentEnabled = session
            ? session.responseMode === RESPONSE_MODE_COUNCIL && session.councilConfig?.enabled === true
            : this.app.getPendingCouncilConfig?.()?.enabled === true;
        await this.persistParallelDefaults({
            enabled: currentEnabled,
            members,
            synthesisModel,
            outputMode
        });

        if (!session) {
            const pendingCouncilConfig = this.app.getPendingCouncilConfig?.();
            this.app.setPendingCouncilConfig?.({
                enabled: pendingCouncilConfig?.enabled === true,
                members,
                synthesisModel,
                outputMode,
                reviewEnabled: false
            });
            this.refreshMultiModelSettingsUI();
            return;
        }

        const enabled = session.responseMode === RESPONSE_MODE_COUNCIL && session.councilConfig?.enabled === true;
        await this.app.setCouncilModeForCurrentSession({
            enabled,
            members,
            synthesisModel,
            outputMode
        });
        this.refreshMultiModelSettingsUI();
    }

    async selectCouncilSecondaryModel(modelName) {
        if (!modelName) return;
        if (this.multiModelSecondaryInlineSelect) {
            this.multiModelSecondaryInlineSelect.value = modelName;
        }
        if (this.multiModelSecondarySelect) {
            this.multiModelSecondarySelect.value = modelName;
        }
        await this.persistCouncilSelectionFromControls();
    }

    async selectCouncilSynthesisModel(modelName) {
        if (!modelName) return;
        if (this.councilReviewModelSelect) {
            this.councilReviewModelSelect.value = modelName;
        }
        if (this.councilSynthesisInlineSelect) {
            this.councilSynthesisInlineSelect.value = modelName;
        }
        if (this.multiModelSynthesisSelect) {
            this.multiModelSynthesisSelect.value = modelName;
        }
        await this.persistCouncilSelectionFromControls();
    }

    openCouncilSecondaryModelPicker() {
        if (!this.app.modelPicker?.open) return;
        this.app.modelPicker.open({ selectionMode: 'council-secondary' });
    }

    closeSettingsMenu() {
        if (!this.app.elements.settingsMenu) return;
        this.app.elements.settingsMenu.classList.add('hidden');
        this.app.elements.settingsBtn?.classList.remove('tooltip-disabled');
    }

    openCouncilSynthesisModelPicker(options = {}) {
        if (!this.app.modelPicker?.open) return;
        if (options.closeSettings) {
            this.closeSettingsMenu();
        }
        this.app.modelPicker.open({ selectionMode: 'council-synthesis' });
    }

    /**
     * Legacy hook: extended-thinking toggle was removed from settings.
     * Keep reasoning enabled and update the effort control only.
     */
    updateReasoningToggleUI() {
        this.app.reasoningEnabled = true;
        this.updateReasoningEffortUI();
    }

    /**
     * Updates the visual state of the reasoning effort selector.
     */
    updateReasoningEffortUI() {
        const container = document.getElementById('reasoning-effort-toggle');
        if (!container) return;

        const normalizedEffort = normalizeReasoningEffort(this.app.reasoningEffort);
        this.app.reasoningEffort = normalizedEffort;
        container.dataset.effort = normalizedEffort;
        container.setAttribute('aria-disabled', 'false');
        container.classList.remove('is-disabled');

        const buttons = container.querySelectorAll('.reasoning-effort-btn');
        buttons.forEach((button) => {
            const isActive = button.dataset.reasoningEffort === normalizedEffort;
            button.setAttribute('aria-checked', String(isActive));
            button.disabled = false;
        });
    }

    getPrimaryModelName() {
        const session = this.app.getCurrentSession();
        const preferredModelName = this.app.normalizeModelName(session?.model)
            || session?.model
            || this.app.state.pendingModelName
            || '';
        const fallbackModelName = this.app.getFallbackModelEntry?.(session)?.name
            || this.app.getDefaultModelName?.()
            || '';
        return resolvePrimaryModelNameForModels({
            models: this.app.state.models,
            preferredModelName,
            fallbackModelName,
            normalizeModelName: (modelName) => this.app.normalizeModelName?.(modelName)
        });
    }

    getMultiModelMembersForSelection(options = {}) {
        const { preferControlSelection = true } = options;
        const primary = this.getPrimaryModelName();
        const secondary = this.getSelectedCouncilSecondaryModelName(primary, { preferControlSelection });
        return [primary, secondary].filter(Boolean);
    }

    getSelectedCouncilSecondaryModelName(primaryModelName = this.getPrimaryModelName(), options = {}) {
        const { preferControlSelection = true } = options;
        const configuredSecondary = this.getConfiguredSecondaryModelName(primaryModelName);
        const controlSecondary = preferControlSelection
            ? (this.multiModelSecondaryInlineSelect?.value || this.multiModelSecondarySelect?.value || '')
            : '';
        return this.resolveSecondaryModelName(primaryModelName, controlSecondary || configuredSecondary);
    }

    getConfiguredSecondaryModelName(primaryModelName) {
        const session = this.app.getCurrentSession();
        const pendingCouncilConfig = this.app.getPendingCouncilConfig?.();
        const councilMembers = session?.councilConfig?.members || pendingCouncilConfig?.members || [];
        return getConfiguredSecondaryModelNameForModels({
            models: this.app.state.models,
            councilMembers,
            primaryModelName,
            normalizeModelName: (modelName) => this.app.normalizeModelName?.(modelName)
        });
    }

    getDefaultSecondaryModelName(primaryModelName) {
        return getDefaultSecondaryModelNameForModels({
            models: this.app.state.models,
            primaryModelName,
            normalizeModelName: (modelName) => this.app.normalizeModelName?.(modelName)
        });
    }

    resolveSecondaryModelName(primaryModelName, preferredModelName = '') {
        return resolveSecondaryModelNameForModels({
            models: this.app.state.models,
            primaryModelName,
            preferredModelName,
            normalizeModelName: (modelName) => this.app.normalizeModelName?.(modelName)
        });
    }

    resolveCouncilSynthesisModelName(preferredModelName = '', fallbackModelName = this.getPrimaryModelName()) {
        return resolveSynthesisModelNameForModels({
            models: this.app.state.models,
            preferredModelName,
            fallbackModelName,
            normalizeModelName: (modelName) => this.app.normalizeModelName?.(modelName)
        });
    }

    getModelEntryByName(modelName) {
        return findModelByNameOrId(
            this.app.state.models,
            modelName,
            (candidate) => this.app.normalizeModelName?.(candidate)
        );
    }

    inferProviderFromModelName(modelName) {
        if (!modelName) return null;
        if (modelName.includes(': ')) return modelName.split(': ')[0];
        const lowerName = modelName.toLowerCase();
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

    getShortModelName(modelName) {
        return getComposerModelDisplayName(modelName);
    }

    getFullModelHoverName(modelName) {
        return getProviderlessModelDisplayName(modelName) || 'Select model';
    }

    buildModelIconHtml(modelName, sizeClass = 'w-3 h-3') {
        const model = this.getModelEntryByName(modelName);
        const provider = model?.provider || this.inferProviderFromModelName(modelName);
        const iconData = provider ? getProviderIcon(provider, sizeClass) : { html: '', hasIcon: false };
        const shortName = this.getShortModelName(modelName);
        const iconHtml = iconData.html || `<span class="text-[10px] font-semibold">${this.escapeOptionText((shortName || '?').charAt(0).toUpperCase())}</span>`;
        return {
            html: iconHtml,
            bgClass: iconData.hasIcon ? 'bg-white' : 'bg-muted'
        };
    }

    getCouncilSynthesisModelForSelection() {
        const session = this.app.getCurrentSession();
        const pendingCouncilConfig = this.app.getPendingCouncilConfig?.();
        const preferredModelName = this.councilReviewModelSelect?.value
            || this.councilSynthesisInlineSelect?.value
            || this.multiModelSynthesisSelect?.value
            || session?.councilConfig?.synthesisModel
            || session?.councilConfig?.chairmanModel
            || pendingCouncilConfig?.synthesisModel
            || pendingCouncilConfig?.chairmanModel
            || this.getPrimaryModelName()
            || '';
        return this.resolveCouncilSynthesisModelName(preferredModelName, this.getPrimaryModelName());
    }

    getMultiModelOutputModeForSelection() {
        if (this.councilReviewToggle) {
            return this.councilReviewToggle.getAttribute('aria-checked') === 'true'
                ? COUNCIL_OUTPUT_SYNTHESIS
                : COUNCIL_OUTPUT_PARALLEL;
        }
        if (this.multiModelModeSelect) {
            return this.multiModelModeSelect?.value === COUNCIL_OUTPUT_PARALLEL
                ? COUNCIL_OUTPUT_PARALLEL
                : COUNCIL_OUTPUT_SYNTHESIS;
        }

        const session = this.app.getCurrentSession();
        const pendingCouncilConfig = this.app.getPendingCouncilConfig?.();
        return session?.councilConfig?.outputMode
            || pendingCouncilConfig?.outputMode
            || COUNCIL_OUTPUT_PARALLEL;
    }

    refreshMultiModelSettingsUI() {
        const session = this.app.getCurrentSession();
        const select = document.getElementById('multi-model-secondary-select');
        const inlineContainer = document.getElementById('council-inline-models');
        const inlineSelect = document.getElementById('council-secondary-inline-select');
        const inlineButton = document.getElementById('council-secondary-model-btn');
        const synthesisInlineSelect = document.getElementById('council-synthesis-inline-select');
        const councilReviewToggle = document.getElementById('council-review-toggle');
        const councilReviewModelRow = document.getElementById('council-review-model-row');
        const councilReviewModelSelect = document.getElementById('council-review-model-select');
        const modeSelect = document.getElementById('multi-model-mode-select');
        const synthesisSelect = document.getElementById('multi-model-synthesis-select');

        const pendingCouncilConfig = this.app.getPendingCouncilConfig?.();
        const isEnabled = session
            ? session.responseMode === RESPONSE_MODE_COUNCIL && session.councilConfig?.enabled === true
            : pendingCouncilConfig?.enabled === true;
        this.setComposerModeDataset(isEnabled);
        if (inlineContainer) {
            inlineContainer.classList.toggle('hidden', !isEnabled);
            inlineContainer.classList.toggle('flex', isEnabled);
            inlineContainer.setAttribute('aria-hidden', isEnabled ? 'false' : 'true');
        }
        const primaryModelButton = this.app.elements.modelPickerBtn || document.getElementById('model-picker-btn');
        if (primaryModelButton) {
            const primaryModelName = this.getPrimaryModelName();
            const primaryHoverName = this.getFullModelHoverName(primaryModelName);
            primaryModelButton.setAttribute('data-tooltip', primaryHoverName);
            primaryModelButton.setAttribute('data-tooltip-position', 'top');
            primaryModelButton.setAttribute('aria-label', `Primary model: ${primaryHoverName}`);
            primaryModelButton.title = primaryHoverName;
            primaryModelButton.classList.remove('model-picker-icon-only');
            primaryModelButton.classList.add('composer-model-chip');
        }

        const primary = this.getPrimaryModelName();
        const requestedCouncilSynthesisModel = session?.councilConfig?.synthesisModel
            || session?.councilConfig?.chairmanModel
            || pendingCouncilConfig?.synthesisModel
            || pendingCouncilConfig?.chairmanModel
            || primary
            || '';
        const storedOutputMode = session?.councilConfig?.outputMode
            || pendingCouncilConfig?.outputMode
            || COUNCIL_OUTPUT_PARALLEL;
        const outputMode = isEnabled ? storedOutputMode : COUNCIL_OUTPUT_PARALLEL;
        const isCouncilReviewEnabled = outputMode === COUNCIL_OUTPUT_SYNTHESIS;
        this.app.updateCouncilLayoutMode?.(session);
        const models = Array.isArray(this.app.state.models) ? this.app.state.models : [];
        const availableModels = models.filter((model) => model?.name);
        const allSelectableModels = models.filter((model) => model?.name);
        const modelsLoaded = allSelectableModels.length > 0;
        const councilSynthesisModel = this.resolveCouncilSynthesisModelName(requestedCouncilSynthesisModel, primary);
        const configuredSecondary = this.getConfiguredSecondaryModelName(primary);
        const selectedSecondary = this.resolveSecondaryModelName(primary, configuredSecondary);

        if (modeSelect) {
            this.multiModelModeSelect = modeSelect;
            modeSelect.value = outputMode === COUNCIL_OUTPUT_PARALLEL
                ? COUNCIL_OUTPUT_PARALLEL
                : COUNCIL_OUTPUT_SYNTHESIS;
        }

        const renderSecondaryOptions = () => availableModels.map((model, index) => {
            const value = model.name;
            const selected = selectedSecondary
                ? value === selectedSecondary
                : index === 0;
            return `<option value="${this.escapeOptionValue(value)}"${selected ? ' selected' : ''}>${this.escapeOptionText(value)}</option>`;
        }).join('');

        if (select) {
            if (availableModels.length === 0) {
                select.innerHTML = '<option value="" disabled selected>No second model</option>';
                select.disabled = true;
            } else {
                select.disabled = false;
                select.innerHTML = renderSecondaryOptions();
            }
        }

        if (inlineSelect) {
            this.multiModelSecondaryInlineSelect = inlineSelect;
            if (availableModels.length === 0) {
                inlineSelect.innerHTML = '<option value="" disabled selected>No second model</option>';
                inlineSelect.disabled = true;
            } else {
                inlineSelect.disabled = false;
                inlineSelect.innerHTML = renderSecondaryOptions();
            }
        }

        if (inlineButton) {
            this.multiModelSecondaryInlineButton = inlineButton;
            inlineButton.disabled = !isEnabled || availableModels.length === 0;
            inlineButton.setAttribute('data-tooltip-position', 'top');
            inlineButton.classList.remove('council-model-icon-only');
            inlineButton.classList.add('composer-model-chip');
            inlineButton.setAttribute('aria-hidden', isEnabled ? 'false' : 'true');
            if (isEnabled) {
                inlineButton.removeAttribute('tabindex');
            } else {
                inlineButton.setAttribute('tabindex', '-1');
            }
            const selectedModel = findModelByNameOrId(
                availableModels,
                selectedSecondary,
                (modelName) => this.app.normalizeModelName?.(modelName)
            ) || availableModels[0] || null;
            if (!selectedModel) {
                inlineButton.setAttribute('aria-label', 'Secondary model unavailable');
                inlineButton.setAttribute('data-tooltip', 'No model available');
                inlineButton.title = 'No model available';
                inlineButton.innerHTML = '<span class="model-name-container min-w-0 truncate">No second model</span>';
            } else {
                const secondaryHoverName = this.getFullModelHoverName(selectedModel.name);
                inlineButton.setAttribute('aria-label', `Secondary model: ${secondaryHoverName}`);
                inlineButton.setAttribute('data-tooltip', secondaryHoverName);
                inlineButton.title = secondaryHoverName;
                const icon = this.buildModelIconHtml(selectedModel.name, 'w-3 h-3');
                inlineButton.innerHTML = `
                    <div class="flex items-center justify-center w-5 h-5 flex-shrink-0 rounded-full border border-border/50 ${icon.bgClass}">
                        ${icon.html}
                    </div>
                    <span class="model-name-container min-w-0">${this.escapeOptionText(this.getShortModelName(selectedModel.name))}</span>
                    <div class="model-shortcut flex items-center gap-0.5 ml-2 pointer-events-none text-muted-foreground text-xs">
                        <span class="opacity-60">⌘</span>
                        <span class="opacity-60">J</span>
                    </div>
                `;
            }
        }

        const renderSynthesisOptions = () => {
            const options = [...allSelectableModels];
            if (!modelsLoaded && councilSynthesisModel && !options.some((model) => model.name === councilSynthesisModel)) {
                options.unshift({ name: councilSynthesisModel });
            }
            return options.map((model, index) => {
                const value = model.name;
                const label = this.getFullModelHoverName(value);
                const selected = councilSynthesisModel
                    ? value === councilSynthesisModel
                    : index === 0;
                return `<option value="${this.escapeOptionValue(value)}"${selected ? ' selected' : ''}>${this.escapeOptionText(label)}</option>`;
            }).join('');
        };

        if (councilReviewToggle) {
            this.councilReviewToggle = councilReviewToggle;
            councilReviewToggle.setAttribute('aria-checked', String(isCouncilReviewEnabled));
            councilReviewToggle.classList.toggle('switch-active', isCouncilReviewEnabled);
            councilReviewToggle.classList.toggle('switch-inactive', !isCouncilReviewEnabled);
            councilReviewToggle.title = isCouncilReviewEnabled
                ? 'Council review is on'
                : 'Council review is off';
        }

        if (councilReviewModelRow) {
            councilReviewModelRow.classList.toggle('hidden', !isCouncilReviewEnabled);
        }

        if (councilReviewModelSelect) {
            this.councilReviewModelSelect = councilReviewModelSelect;
            const councilHoverName = councilSynthesisModel
                ? this.getFullModelHoverName(councilSynthesisModel)
                : 'No model available';
            councilReviewModelSelect.setAttribute('aria-label', `Council model: ${councilHoverName}`);
            councilReviewModelSelect.title = councilHoverName;
            if (allSelectableModels.length === 0 && !councilSynthesisModel) {
                councilReviewModelSelect.innerHTML = '<option value="" disabled selected>No council model</option>';
                councilReviewModelSelect.disabled = true;
            } else {
                councilReviewModelSelect.disabled = !isCouncilReviewEnabled;
                councilReviewModelSelect.innerHTML = renderSynthesisOptions();
                if (councilSynthesisModel) {
                    councilReviewModelSelect.value = councilSynthesisModel;
                }
            }
        }

        if (synthesisInlineSelect) {
            this.councilSynthesisInlineSelect = synthesisInlineSelect;
            if (allSelectableModels.length === 0 && !councilSynthesisModel) {
                synthesisInlineSelect.innerHTML = '<option value="" disabled selected>No council model</option>';
                synthesisInlineSelect.disabled = true;
            } else {
                synthesisInlineSelect.disabled = !isCouncilReviewEnabled;
                synthesisInlineSelect.innerHTML = renderSynthesisOptions();
            }
        }

        if (synthesisSelect) {
            this.multiModelSynthesisSelect = synthesisSelect;
            if (allSelectableModels.length === 0 && !councilSynthesisModel) {
                synthesisSelect.innerHTML = '<option value="" disabled selected>No council model</option>';
                synthesisSelect.disabled = true;
            } else {
                synthesisSelect.disabled = !isCouncilReviewEnabled;
                synthesisSelect.innerHTML = renderSynthesisOptions();
            }
        }
    }

    escapeOptionValue(value) {
        return String(value)
            .replace(/&/g, '&amp;')
            .replace(/"/g, '&quot;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
    }

    escapeOptionText(value) {
        return String(value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
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

        const messages = await this.app.data.getSessionMessages(session.id);
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

    async handleExportMemory() {
        if (this.app.memoryFeatureEnabled === false) {
            this.app.showToast?.('Memory is off in settings.', 'info', 3000);
            return;
        }
        if (!this.app.memoryEditor?.exportMemories) {
            this.app.showToast?.('Memory export unavailable', 'error');
            return;
        }
        await this.app.memoryEditor.exportMemories();
    }

    handleImportMemory() {
        if (this.app.memoryFeatureEnabled === false) {
            this.app.showToast?.('Memory is off in settings.', 'info', 3000);
            return;
        }
        const input = document.getElementById('memory-import-input');
        if (input) {
            input.click();
        }
        this.app.elements.settingsMenu.classList.add('hidden');
    }

    async applyImportedRuntimePreferences(appliedPreferences = []) {
        if (!Array.isArray(appliedPreferences) || appliedPreferences.length === 0) return;
        const applied = new Set(appliedPreferences);

        if (applied.has('memoryFeatureEnabled') || applied.has('memoryMode')) {
            const storedMemoryFeatureEnabled = await this.app.data.getSetting('memoryFeatureEnabled');
            const storedMemoryMode = await this.app.data.getSetting('memoryMode');
            await this.app.setMemoryFeatureEnabled(storedMemoryFeatureEnabled !== false, { persist: false });
            this.app.memoryMode = this.app.memoryFeatureEnabled !== false && storedMemoryMode === true;
            this.updateMemoryToggleUI();
        }

        if (applied.has('memoryAutoInclude')) {
            const storedMemoryAutoInclude = await this.app.data.getSetting('memoryAutoInclude');
            await this.app.setMemoryAutoInclude(storedMemoryAutoInclude === true, { persist: false });
        }

        if (applied.has('memoryAgentModel')) {
            const storedMemoryAgentModel = await this.app.data.getSetting('memoryAgentModel');
            await this.app.setMemoryAgentModel(storedMemoryAgentModel, { persist: false });
        }

        this.refreshMemorySettingsUI();
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

            const result = await this.app.services.tickets.importTickets(payload);
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
                await this.applyImportedRuntimePreferences(result.summary?.appliedPreferences);

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

    async processMemoryImportFile(file) {
        try {
            if (this.app.memoryFeatureEnabled === false) {
                this.app.showToast?.('Memory is off in settings.', 'info', 3000);
                return;
            }
            if (!this.app.memoryEditor?.importMemoryFile) {
                throw new Error('Memory editor is not available.');
            }
            await this.app.memoryEditor.importMemoryFile(file);
        } catch (error) {
            console.error('Memory import failed:', error);
            this.app.showToast?.(error.message || 'Failed to import memory', 'error');
        }
    }
}
