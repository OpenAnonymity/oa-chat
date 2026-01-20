/**
 * ChatInput Component
 * Manages the chat input area including textarea auto-resize,
 * send button state, search toggle UI, and settings dropdown.
 */

import themeManager from '../services/themeManager.js';
import MigrationModal from './MigrationModal.js';

export default class ChatInput {
    /**
     * @param {Object} app - Reference to the main ChatApp instance
     */
    constructor(app) {
        this.app = app;
    }

    /**
     * Sets up all event listeners for the input area controls.
     */
    setupEventListeners() {
        // Auto-resize textarea and clear file undo stack on text input
        this.app.elements.messageInput.addEventListener('input', () => {
            this.app.elements.messageInput.style.height = '24px';
            this.app.elements.messageInput.style.height = Math.min(this.app.elements.messageInput.scrollHeight, 384) + 'px';
            this.app.updateInputState();
            // Clear file undo stack - text input should take undo precedence
            this.app.fileUndoStack = [];
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

        // Note: Paste events (files + text) are handled globally in app.js

        // Send button click - handles both send and stop
        this.app.elements.sendBtn.addEventListener('click', () => {
            if (this.app.isCurrentSessionStreaming()) {
                this.app.stopCurrentSessionStreaming();
            } else {
                this.app.sendMessage();
            }
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
            } else {
                menu.classList.add('hidden');
                btn.classList.remove('tooltip-disabled');
            }
        });

        // Settings menu actions
        this.app.elements.settingsMenu.addEventListener('click', async (e) => {
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

                // Export all data for migration
                if (action === 'export-all-data') {
                    await this.handleExportAllData();
                }

                this.app.elements.settingsMenu.classList.add('hidden');
            }
        });

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

        // Initialize migration modal
        this.migrationModal = new MigrationModal();
        this.migrationModal.init();

        // Mark input as ready for the inline script to defer handling
        window.chatInputReady = true;
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

        // Sync initial visual state with localStorage (HTML may have stale defaults)
        this.updateFlatModeControls();

        flatModeToggle.addEventListener('click', (event) => {
            event.stopPropagation(); // Prevent settings menu from closing
            const btn = event.target.closest('.display-toggle-btn');
            if (btn) {
                const mode = btn.dataset.mode;
                const isFlatMode = mode === 'flat';

                // Update HTML class for CSS styling
                document.documentElement.classList.toggle('flat-mode', isFlatMode);

                // Persist preference to localStorage
                localStorage.setItem('oa-flat-mode', isFlatMode ? 'true' : 'false');

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
     * Exports all user data for migration to beta.
     */
    async handleExportAllData() {
        try {
            const { exportAllData } = await import('../services/globalExport.js');
            const success = await exportAllData();
            if (success) {
                this.app.showToast?.('Data exported successfully', 'success');
            } else {
                this.app.showToast?.('Failed to export data', 'error');
            }
        } catch (error) {
            console.error('Export error:', error);
            this.app.showToast?.('Export failed', 'error');
        }
    }
}

