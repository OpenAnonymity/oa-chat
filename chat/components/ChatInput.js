/**
 * ChatInput Component
 * Manages the chat input area including textarea auto-resize,
 * send button state, search toggle UI, and settings dropdown.
 */

import themeManager from '../services/themeManager.js';

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
        // Auto-resize textarea
        this.app.elements.messageInput.addEventListener('input', () => {
            this.app.elements.messageInput.style.height = '24px';
            this.app.elements.messageInput.style.height = Math.min(this.app.elements.messageInput.scrollHeight, 384) + 'px';
            this.app.updateInputState();
        });

        // Send on Enter (not Shift+Enter)
        this.app.elements.messageInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
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

        // Settings menu toggle
        this.app.elements.settingsBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.app.elements.settingsMenu.classList.toggle('hidden');
        });

        // Settings menu actions
        this.app.elements.settingsMenu.addEventListener('click', async (e) => {
            if (e.target.tagName === 'BUTTON') {
                const action = e.target.textContent.trim();

                // Copy Markdown functionality
                if (action === 'Copy Markdown') {
                    await this.copyLatestMarkdown(e.target);
                    return; // Don't close menu immediately
                }

                // TODO: Re-enable when implementing Clear Models functionality
                // if (action === 'Clear Models') {
                //     const session = this.app.getCurrentSession();
                //     if (session) {
                //         session.model = null;
                //         await chatDB.saveSession(session);
                //         this.app.renderCurrentModel();
                //     }
                // }
                this.app.elements.settingsMenu.classList.add('hidden');
            }
        });

        // Clear chat functionality
        this.app.elements.clearChatBtn.addEventListener('click', async () => {
            const session = this.app.getCurrentSession();
            if (session) {
                await chatDB.deleteSessionMessages(session.id);
                this.app.renderMessages();
                this.app.elements.settingsMenu.classList.add('hidden');
            }
        });

        // Keyboard shortcut for Copy Markdown (Cmd+Shift+C)
        document.addEventListener('keydown', async (e) => {
            if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === 'c') {
                e.preventDefault();
                await this.copyLatestMarkdown();
            }
        });

        // Close settings menu when clicking outside
        document.addEventListener('click', () => {
            if (!this.app.elements.settingsMenu.classList.contains('hidden')) {
                this.app.elements.settingsMenu.classList.add('hidden');
            }
            // Also close session menus
            document.querySelectorAll('.session-menu').forEach(menu => {
                menu.classList.add('hidden');
            });
        });

        // Setup theme controls
        this.setupThemeControls();
    }

    /**
     * Updates the visual state of the search toggle switch.
     */
    updateSearchToggleUI() {
        this.app.elements.searchSwitch.setAttribute('aria-checked', this.app.searchEnabled);

        const thumb = this.app.elements.searchSwitch.querySelector('.search-switch-thumb');
        if (this.app.searchEnabled) {
            this.app.elements.searchSwitch.style.backgroundColor = 'hsl(217.2 91.2% 59.8%)';
            this.app.elements.searchSwitch.classList.remove('bg-muted', 'hover:bg-muted/80');
            thumb.classList.remove('translate-x-[2px]', 'bg-background/80');
            thumb.classList.add('translate-x-[19px]');
            thumb.style.backgroundColor = 'white';
        } else {
            this.app.elements.searchSwitch.style.backgroundColor = '';
            this.app.elements.searchSwitch.classList.add('bg-muted', 'hover:bg-muted/80');
            thumb.classList.remove('translate-x-[19px]');
            thumb.classList.add('translate-x-[2px]', 'bg-background/80');
            thumb.style.backgroundColor = '';
        }
    }

    /**
     * Sets up theme selection controls and listeners.
     */
    setupThemeControls() {
        if (!this.app.elements.themeOptionButtons || this.app.elements.themeOptionButtons.length === 0) {
            return;
        }

        this.app.elements.themeOptionButtons.forEach((button) => {
            button.addEventListener('click', (event) => {
                event.preventDefault();
                event.stopPropagation();

                const preference = button.dataset.themeOption || 'system';
                themeManager.setPreference(preference);

                if (this.app.elements.settingsMenu) {
                    this.app.elements.settingsMenu.classList.add('hidden');
                }
                document.querySelectorAll('.session-menu').forEach(menu => {
                    menu.classList.add('hidden');
                });
            });
        });
    }

    /**
     * Updates the visual state of theme controls based on current preference.
     * @param {string} preference - Theme preference (light, dark, system)
     * @param {string} effectiveTheme - Actual theme being used
     */
    updateThemeControls(preference, effectiveTheme) {
        if (this.app.elements.themeOptionButtons && this.app.elements.themeOptionButtons.length > 0) {
            this.app.elements.themeOptionButtons.forEach((button) => {
                const option = button.dataset.themeOption;
                const isActive = option === preference;

                button.classList.toggle('theme-option-active', isActive);
                button.setAttribute('aria-checked', String(isActive));

                const checkIcon = button.querySelector('.theme-option-check');
                if (checkIcon) {
                    checkIcon.classList.toggle('opacity-100', isActive);
                    checkIcon.classList.toggle('opacity-0', !isActive);
                }
            });
        }

        if (this.app.elements.themeEffectiveLabel) {
            if (preference === 'system') {
                this.app.elements.themeEffectiveLabel.textContent = `Follows system appearance (${this.formatThemeName(effectiveTheme)})`;
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
}

