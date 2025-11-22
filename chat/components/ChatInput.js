/**
 * ChatInput Component
 * Manages the chat input area including textarea auto-resize,
 * send button state, search toggle UI, scrubber toggle, and settings dropdown.
 */

import themeManager from '../services/themeManager.js';
import { getExtensionFromMimeType } from '../services/fileUtils.js';
import { loadModel, unloadModel } from '../services/webllmService.js';

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

        // Handle paste events for files (images, PDFs, audio, text)
        this.app.elements.messageInput.addEventListener('paste', async (e) => {
            const items = e.clipboardData?.items;
            if (!items) return;

            // Extract file blobs SYNCHRONOUSLY before any async operations
            // (clipboard data becomes inaccessible after async operations)
            const fileBlobsData = [];
            for (let i = 0; i < items.length; i++) {
                if (items[i].kind === 'file') {
                    const blob = items[i].getAsFile();
                    if (blob) {
                        fileBlobsData.push({ blob, type: items[i].type });
                    }
                }
            }

            if (fileBlobsData.length > 0) {
                // Prevent default paste behavior immediately
                e.preventDefault();

                try {
                    // Import validation function (getExtensionFromMimeType already imported at top)
                    const { validateFile } = await import('../services/fileUtils.js');
                    const filesToUpload = [];

                    for (const { blob } of fileBlobsData) {
                        // Generate a filename if blob doesn't have one
                        let filename = blob.name;
                        if (!filename) {
                            const extension = getExtensionFromMimeType(blob.type);
                            filename = `pasted-file-${Date.now()}.${extension || 'bin'}`;
                        }

                        const file = this.app.convertBlobToFile(blob, filename);

                        // Validate the file using our smart detection
                        const validation = await validateFile(file);
                        if (validation.valid) {
                            filesToUpload.push(file);
                        } else {
                            console.warn('File validation failed:', validation.error);
                        }
                    }

                    if (filesToUpload.length > 0) {
                        await this.app.handleFileUpload(filesToUpload);
                    }
                } catch (error) {
                    console.error('Error handling pasted files in input:', error);
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

        // Tools button - open tools modal
        if (this.app.elements.toolsBtn) {
            this.app.elements.toolsBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.openToolsModal();
            });
        }

        // Search toggle functionality (in tools modal)
        if (this.app.elements.searchSwitch) {
            this.app.elements.searchSwitch.addEventListener('click', async (e) => {
                e.stopPropagation();
                this.app.searchEnabled = !this.app.searchEnabled;
                this.updateSearchToggleUI();
                this.updateToolsIndicator();
                this.app.updateInputState();
                // Persist search state globally
                await chatDB.saveSetting('searchEnabled', this.app.searchEnabled);
            });
        }

        // Scrubber toggle functionality (in tools modal)
        if (this.app.elements.scrubberSwitch) {
            this.app.elements.scrubberSwitch.addEventListener('click', async (e) => {
                e.stopPropagation();
                const wasEnabled = this.app.scrubberEnabled;
                this.app.scrubberEnabled = !this.app.scrubberEnabled;
                this.updateScrubberToggleUI();
                this.updateToolsIndicator();
                // Persist scrubber state globally
                await chatDB.saveSetting('scrubberEnabled', this.app.scrubberEnabled);
                
                // Auto-load Qwen when enabling scrubber for the first time
                if (this.app.scrubberEnabled && !wasEnabled && !this.app.currentScrubberModel) {
                    // Small delay to let UI update
                    setTimeout(async () => {
                        await this.selectScrubberModel('Qwen2.5-0.5B-Instruct-q4f16_1-MLC', 'qwen');
                    }, 100);
                }
            });
        }

        // Select Llama 3.2 1B
        if (this.app.elements.loadLlama32Inline) {
            this.app.elements.loadLlama32Inline.addEventListener('click', async (e) => {
                e.stopPropagation();
                await this.selectScrubberModel('Llama-3.2-1B-Instruct-q4f16_1-MLC', 'llama');
            });
        }

        // Select Qwen 0.6B
        if (this.app.elements.loadQwenInline) {
            this.app.elements.loadQwenInline.addEventListener('click', async (e) => {
                e.stopPropagation();
                await this.selectScrubberModel('Qwen2.5-0.5B-Instruct-q4f16_1-MLC', 'qwen');
            });
        }

        // Tools modal controls
        this.setupToolsModal();

        // Settings menu toggle
        this.app.elements.settingsBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.app.elements.settingsMenu.classList.toggle('hidden');
        });

        // Settings menu actions
        this.app.elements.settingsMenu.addEventListener('click', async (e) => {
            if (e.target.tagName === 'BUTTON') {
                const action = e.target.textContent.trim();

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
        document.addEventListener('click', () => {
            if (!this.app.elements.settingsMenu.classList.contains('hidden')) {
                this.app.elements.settingsMenu.classList.add('hidden');
            }
            // Also close session menus
            document.querySelectorAll('.session-menu').forEach(menu => {
                menu.classList.add('hidden');
            });
        });

        // Scrubber menu modal controls
        this.setupScrubberMenu();

        // Setup theme controls
        this.setupThemeControls();

        // Mark input as ready for the inline script to defer handling
        window.chatInputReady = true;
    }

    /**
     * Sets up tools modal event listeners.
     */
    setupToolsModal() {
        const closeToolsBtn = this.app.elements.closeToolsModalBtn;
        const toolsModal = this.app.elements.toolsModal;

        // Close button
        if (closeToolsBtn) {
            closeToolsBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.closeToolsModal();
            });
        }

        // Close modal when clicking backdrop
        if (toolsModal) {
            toolsModal.addEventListener('click', (e) => {
                if (e.target === toolsModal) {
                    this.closeToolsModal();
                }
            });
        }

        // Close on Escape key
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && toolsModal && !toolsModal.classList.contains('hidden')) {
                this.closeToolsModal();
            }
        });
    }

    /**
     * Opens the tools modal.
     */
    openToolsModal() {
        if (this.app.elements.toolsModal) {
            this.app.elements.toolsModal.classList.remove('hidden');
        }
    }

    /**
     * Closes the tools modal.
     */
    closeToolsModal() {
        if (this.app.elements.toolsModal) {
            this.app.elements.toolsModal.classList.add('hidden');
        }
    }

    /**
     * Updates the visual state of the search toggle switch.
     */
    updateSearchToggleUI() {
        if (!this.app.elements.searchSwitch) return;
        
        this.app.elements.searchSwitch.setAttribute('aria-checked', this.app.searchEnabled);

        const thumb = this.app.elements.searchSwitch.querySelector('.search-switch-thumb');
        if (!thumb) return;
        
        if (this.app.searchEnabled) {
            this.app.elements.searchSwitch.classList.remove('bg-muted', 'hover:bg-muted/80');
            this.app.elements.searchSwitch.classList.add('search-switch-active');
            thumb.classList.remove('translate-x-[2px]', 'bg-background/80');
            thumb.classList.add('translate-x-[22px]', 'search-switch-thumb-active');
        } else {
            this.app.elements.searchSwitch.classList.remove('search-switch-active');
            this.app.elements.searchSwitch.classList.add('bg-muted', 'hover:bg-muted/80');
            thumb.classList.remove('translate-x-[22px]', 'search-switch-thumb-active');
            thumb.classList.add('translate-x-[2px]', 'bg-background/80');
        }
    }

    /**
     * Updates the visual state of the scrubber toggle switch.
     */
    updateScrubberToggleUI() {
        if (!this.app.elements.scrubberSwitch) return;
        
        this.app.elements.scrubberSwitch.setAttribute('aria-checked', this.app.scrubberEnabled);

        const thumb = this.app.elements.scrubberSwitch.querySelector('.scrubber-switch-thumb');
        if (!thumb) return;
        
        if (this.app.scrubberEnabled) {
            this.app.elements.scrubberSwitch.classList.remove('bg-muted', 'hover:bg-muted/80');
            this.app.elements.scrubberSwitch.classList.add('scrubber-switch-active');
            thumb.classList.remove('translate-x-[2px]', 'bg-background/80');
            thumb.classList.add('translate-x-[22px]', 'scrubber-switch-thumb-active');
            
            // Show scrubber models section
            if (this.app.elements.scrubberModelsSection) {
                this.app.elements.scrubberModelsSection.classList.remove('hidden');
                // Update model status
                this.updateScrubberModelStatus();
            }
        } else {
            this.app.elements.scrubberSwitch.classList.remove('scrubber-switch-active');
            this.app.elements.scrubberSwitch.classList.add('bg-muted', 'hover:bg-muted/80');
            thumb.classList.remove('translate-x-[22px]', 'scrubber-switch-thumb-active');
            thumb.classList.add('translate-x-[2px]', 'bg-background/80');
            
            // Hide scrubber models section
            if (this.app.elements.scrubberModelsSection) {
                this.app.elements.scrubberModelsSection.classList.add('hidden');
            }
        }
    }

    /**
     * Updates the tools button active indicator.
     */
    updateToolsIndicator() {
        if (!this.app.elements.toolsActiveIndicator) return;
        
        // Show indicator if any tool is enabled
        if (this.app.searchEnabled || this.app.scrubberEnabled) {
            this.app.elements.toolsActiveIndicator.classList.remove('hidden');
        } else {
            this.app.elements.toolsActiveIndicator.classList.add('hidden');
        }
    }

    /**
     * Opens the scrubber menu modal.
     */
    openScrubberMenu() {
        const modal = document.getElementById('scrubber-menu-modal');
        if (modal) {
            modal.classList.remove('hidden');
            this.updateScrubberModelStatus();
        }
    }

    /**
     * Closes the scrubber menu modal.
     */
    closeScrubberMenu() {
        const modal = document.getElementById('scrubber-menu-modal');
        if (modal) {
            modal.classList.add('hidden');
        }
    }

    /**
     * Updates the visual selection state of scrubber models.
     */
    updateScrubberModelStatus() {
        const llamaBtn = this.app.elements.loadLlama32Inline;
        const qwenBtn = this.app.elements.loadQwenInline;
        const llamaCheck = this.app.elements.llamaCheckInline;
        const qwenCheck = this.app.elements.qwenCheckInline;

        // Clear all selections first
        if (llamaBtn) {
            llamaBtn.classList.remove('selected');
        }
        if (qwenBtn) {
            qwenBtn.classList.remove('selected');
        }
        if (llamaCheck) {
            llamaCheck.classList.add('hidden');
        }
        if (qwenCheck) {
            qwenCheck.classList.add('hidden');
        }

        // Show selection for current model
        if (this.app.currentScrubberModel === 'Llama-3.2-1B-Instruct-q4f16_1-MLC') {
            if (llamaBtn) llamaBtn.classList.add('selected');
            if (llamaCheck) llamaCheck.classList.remove('hidden');
        } else if (this.app.currentScrubberModel === 'Qwen2.5-0.5B-Instruct-q4f16_1-MLC') {
            if (qwenBtn) qwenBtn.classList.add('selected');
            if (qwenCheck) qwenCheck.classList.remove('hidden');
        }
    }

    /**
     * Selects a scrubber model, automatically unloading the previous one if needed.
     * @param {string} modelName - Name of the model to load
     * @param {string} modelId - ID of the model (llama or qwen)
     */
    async selectScrubberModel(modelName, modelId) {
        // If clicking the same model, do nothing
        if (this.app.currentScrubberModel === modelName) {
            return;
        }

        const progressDiv = this.app.elements.scrubberLoadingProgressInline;
        const progressBar = this.app.elements.scrubberProgressBarInline;
        const llamaBtn = this.app.elements.loadLlama32Inline;
        const qwenBtn = this.app.elements.loadQwenInline;

        if (!progressDiv || !progressBar) return;

        // Add loading state to ALL model buttons
        if (llamaBtn) llamaBtn.classList.add('loading');
        if (qwenBtn) qwenBtn.classList.add('loading');

        // Unload previous model if exists
        if (this.app.currentScrubberModel) {
            console.log(`Unloading previous model: ${this.app.currentScrubberModel}`);
            unloadModel(this.app.currentScrubberModel);
        }

        // Show progress bar
        progressDiv.classList.remove('hidden');
        progressBar.style.width = '0%';
        progressBar.style.backgroundColor = 'rgb(147, 51, 234)'; // purple-600

        try {
            await loadModel(modelName, (progressInfo) => {
                const percentValue = progressInfo.progress ? (progressInfo.progress * 100) : 0;
                progressBar.style.width = `${percentValue}%`;
            });

            // Success - set as current model
            this.app.currentScrubberModel = modelName;
            progressBar.style.width = '100%';

            // Persist the selected model
            await chatDB.saveSetting('currentScrubberModel', modelName);

            // Update visual selection
            this.updateScrubberModelStatus();

            // Hide progress after 1 second
            setTimeout(() => {
                progressDiv.classList.add('hidden');
                progressBar.style.width = '0%';
            }, 1000);

            console.log(`Scrubber model ${modelName} loaded successfully`);
        } catch (error) {
            console.error('Failed to load scrubber model:', error);
            progressBar.style.backgroundColor = '#ef4444'; // red on error

            // Hide progress after 2 seconds
            setTimeout(() => {
                progressDiv.classList.add('hidden');
                progressBar.style.width = '0%';
                progressBar.style.backgroundColor = 'rgb(147, 51, 234)';
            }, 2000);
        } finally {
            // Remove loading state from ALL buttons
            if (llamaBtn) llamaBtn.classList.remove('loading');
            if (qwenBtn) qwenBtn.classList.remove('loading');
        }
    }


    /**
     * Sets up scrubber menu event listeners.
     */
    setupScrubberMenu() {
        const closeScrubberBtn = document.getElementById('close-scrubber-modal-btn');
        const scrubberModal = document.getElementById('scrubber-menu-modal');
        const loadLlamaBtn = document.getElementById('load-llama-3-2-1b');
        const loadQwenBtn = document.getElementById('load-qwen-0-6b');

        // Close button
        if (closeScrubberBtn) {
            closeScrubberBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.closeScrubberMenu();
            });
        }

        // Close modal when clicking backdrop
        if (scrubberModal) {
            scrubberModal.addEventListener('click', (e) => {
                if (e.target === scrubberModal) {
                    this.closeScrubberMenu();
                }
            });
        }

        // Load Llama 3.2 1B
        if (loadLlamaBtn) {
            loadLlamaBtn.addEventListener('click', async () => {
                await this.loadScrubberModel('Llama-3.2-1B-Instruct-q4f16_1-MLC', 'llama-status');
            });
        }

        // Load Qwen 0.6B
        if (loadQwenBtn) {
            loadQwenBtn.addEventListener('click', async () => {
                await this.loadScrubberModel('Qwen2.5-0.5B-Instruct-q4f16_1-MLC', 'qwen-status');
            });
        }
    }

    /**
     * Loads a scrubber model with progress feedback.
     * @param {string} modelName - Name of the model to load
     * @param {string} statusElementId - ID of the status element to update
     */
    async loadScrubberModel(modelName, statusElementId) {
        const statusElement = document.getElementById(statusElementId);
        const progressDiv = document.getElementById('scrubber-loading-progress');
        const progressText = document.getElementById('scrubber-progress-text');
        const progressBar = document.getElementById('scrubber-progress-bar');

        if (!progressDiv || !progressText || !progressBar) return;

        // Show progress
        progressDiv.classList.remove('hidden');
        progressText.textContent = 'Initializing...';
        progressBar.style.width = '0%';

        if (statusElement) {
            statusElement.textContent = 'Loading...';
        }

        try {
            await loadModel(modelName, (progressInfo) => {
                const text = progressInfo.text || 'Loading model...';
                const percentValue = progressInfo.progress ? (progressInfo.progress * 100) : 0;
                
                progressText.textContent = text;
                progressBar.style.width = `${percentValue}%`;
            });

            // Success
            progressText.textContent = '✓ Model loaded successfully!';
            progressBar.style.width = '100%';
            
            if (statusElement) {
                statusElement.textContent = '✓ Loaded';
            }

            // Hide progress after 2 seconds
            setTimeout(() => {
                progressDiv.classList.add('hidden');
            }, 2000);

            console.log(`Scrubber model ${modelName} loaded successfully`);
        } catch (error) {
            console.error('Failed to load scrubber model:', error);
            progressText.textContent = `✗ Error: ${error.message}`;
            
            if (statusElement) {
                statusElement.textContent = 'Failed';
            }

            // Hide progress after 3 seconds
            setTimeout(() => {
                progressDiv.classList.add('hidden');
            }, 3000);
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

