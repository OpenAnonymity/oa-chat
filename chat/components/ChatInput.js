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
import { chatDB } from '../db.js';

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
            tooltipVisible: false
        };
        this.scrubberModelsReady = false;
        this.scrubberModelSelect = null;
    }

    /**
     * Sets up all event listeners for the input area controls.
     */
    setupEventListeners() {
        // Auto-resize textarea and clear file undo stack on text input
        this.app.elements.messageInput.addEventListener('input', () => {
            const input = this.app.elements.messageInput;
            this.app.resetMessageInputLayout();
            input.style.height = Math.min(input.scrollHeight, 384) + 'px';
            this.app.updateInputState();
            // Clear file undo stack - text input should take undo precedence
            this.app.fileUndoStack = [];
            this.updateScrubberHintVisibility();
            if (this.app.scrubberPending && this.app.scrubberPending.redacted !== this.app.elements.messageInput.value) {
                this.app.scrubberPending = null;
                this.hideScrubberHover();
            }
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
                        this.app.sendMessage();
                    }
                }
            }
        });

        // Scrubber shortcut: Tab Tab
        this.app.elements.messageInput.addEventListener('keydown', (e) => {
            if (e.key !== 'Tab' || e.shiftKey || e.ctrlKey || e.metaKey || e.altKey || e.isComposing) {
                return;
            }
            e.preventDefault();
            this.handleScrubberShortcut();
        });

        // Note: Paste events (files + text) are handled globally in app.js

        // Send button click - handles both send and stop
        this.app.elements.sendBtn.addEventListener('click', () => {
            if (this.app.isCurrentSessionStreaming()) {
                this.app.stopCurrentSessionStreaming();
            } else {
                this.app.sendMessage();
            }
        });

        this.app.elements.messageInput.addEventListener('mouseenter', () => {
            this.showScrubberHover();
        });

        this.app.elements.messageInput.addEventListener('mouseleave', () => {
            this.hideScrubberHover();
        });

        // Search toggle functionality
        this.app.elements.searchToggle.addEventListener('click', async () => {
            this.app.searchEnabled = !this.app.searchEnabled;
            this.updateSearchToggleUI();
            this.app.updateInputState();
            // Persist search state globally
            await chatDB.saveSetting('searchEnabled', this.app.searchEnabled);
        });

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

        // Mark input as ready for the inline script to defer handling
        window.chatInputReady = true;
    }

    async handleScrubberShortcut() {
        const now = Date.now();
        const withinWindow = now - this.scrubberState.lastTabAt < 420;
        this.scrubberState.lastTabAt = now;
        if (this.scrubberState.timer) {
            clearTimeout(this.scrubberState.timer);
        }
        this.scrubberState.timer = setTimeout(() => {
            this.scrubberState.lastTabAt = 0;
        }, 420);

        if (!withinWindow || this.scrubberState.isRunning) {
            if (!withinWindow) {
                this.app.showToast('Press Tab again to scrub PII', 'success');
            }
            return;
        }

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
                this.app.elements.messageInput.value = result.text;
                this.app.elements.messageInput.dispatchEvent(new Event('input', { bubbles: true }));
                this.app.scrubberPending = {
                    original: text,
                    redacted: result.text,
                    timestamp: Date.now()
                };
                this.updateScrubberHintVisibility();
                if (typeof stopToast === 'function') {
                    stopToast();
                }
                if (this.app.elements.inputCard) {
                    this.app.elements.inputCard.classList.remove('scrubbing');
                }
                this.app.showToast('PII removed', 'success');
            } else {
                if (typeof stopToast === 'function') {
                    stopToast();
                }
                if (this.app.elements.inputCard) {
                    this.app.elements.inputCard.classList.remove('scrubbing');
                }
                this.app.showToast('Scrubber failed', 'error');
            }
        } catch (error) {
            console.error('Scrubber shortcut failed:', error);
            if (typeof stopToast === 'function') {
                stopToast();
            }
            if (this.app.elements.inputCard) {
                this.app.elements.inputCard.classList.remove('scrubbing');
            }
            this.app.showToast('Scrubber failed', 'error');
        } finally {
            this.scrubberState.isRunning = false;
        }
    }

    showScrubberHover() {
        if (this.scrubberState.tooltipVisible) return;
        const pending = this.app.scrubberPending;
        if (!pending || pending.redacted !== this.app.elements.messageInput.value) return;
        const original = (pending.original || '').trim();
        if (!original) return;
        const escaped = this.app.escapeHtml ? this.app.escapeHtml(original) : original.replace(/</g, '&lt;').replace(/>/g, '&gt;');
        const html = `
            <div class="inline-flex items-center px-1.5 py-0.5 mb-2 rounded bg-muted/50 text-muted-foreground text-[10px] font-medium uppercase tracking-wide">
                Original prompt
            </div>
            <div class="text-foreground text-xs leading-relaxed" style="white-space: pre-wrap;">${escaped}</div>
        `;
        this.showHoverTooltip(this.app.elements.messageInput, html);
        this.scrubberState.tooltipVisible = true;
    }

    hideScrubberHover() {
        if (!this.scrubberState.tooltipVisible) return;
        this.hideHoverTooltip();
        this.scrubberState.tooltipVisible = false;
    }

    showHoverTooltip(targetEl, htmlContent) {
        if (!targetEl || !htmlContent) return;
        this.hideHoverTooltip();

        const tooltip = document.createElement('div');
        tooltip.id = 'app-hover-tooltip';
        tooltip.className = 'pointer-events-none';
        Object.assign(tooltip.style, {
            position: 'fixed',
            zIndex: '99999',
            minWidth: '200px',
            padding: '12px 14px',
            borderRadius: '14px',
            background: 'hsl(var(--color-card) / 0.85)',
            backdropFilter: 'blur(20px) saturate(150%)',
            WebkitBackdropFilter: 'blur(20px) saturate(150%)',
            color: 'hsl(var(--color-foreground))',
            border: '1px solid hsl(var(--color-border) / 0.5)',
            boxShadow: '0 8px 32px rgba(0, 0, 0, 0.12), 0 2px 8px rgba(0, 0, 0, 0.06)',
            fontSize: '12px',
            lineHeight: '1.5',
            opacity: '0',
            transform: 'translateY(4px)',
            transition: 'opacity 180ms ease-out, transform 180ms ease-out'
        });
        tooltip.innerHTML = htmlContent;
        document.body.appendChild(tooltip);

        const inputCard = document.getElementById('input-card');
        const refEl = inputCard || targetEl;
        const rect = refEl.getBoundingClientRect();

        const tooltipWidth = Math.min(rect.width, 480);
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

        requestAnimationFrame(() => {
            tooltip.style.opacity = '1';
            tooltip.style.transform = 'translateY(0)';
        });
    }

    hideHoverTooltip() {
        const tooltip = document.getElementById('app-hover-tooltip');
        if (!tooltip) return;
        tooltip.style.opacity = '0';
        tooltip.style.transform = 'translateY(4px)';
        setTimeout(() => tooltip.remove(), 200);
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
                const label = model.name || model.id;
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
            const success = await exportTickets();
            if (success) {
                this.app.showToast?.('Tickets exported successfully', 'success');
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
}
