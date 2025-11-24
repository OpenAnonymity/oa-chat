/**
 * ChatInput Component
 * Manages the chat input area including textarea auto-resize,
 * send button state, search toggle UI, scrubber toggle, and settings dropdown.
 */

import themeManager from '../services/themeManager.js';
import { getExtensionFromMimeType } from '../services/fileUtils.js';
import { loadModel, unloadModel, generateStream } from '../services/webllmService.js';

// Scrubber model configuration
export const SCRUBBER_MODELS = [
    {
        id: 'qwen',
        name: 'Qwen 0.6B',
        modelName: 'Qwen2.5-0.5B-Instruct-q4f16_1-MLC',
        description: 'Ultra lightweight',
        icon: 'qwen.svg',
        default: true
    },
    {
        id: 'llama-1b',
        name: 'Llama 3.2 1B',
        modelName: 'Llama-3.2-1B-Instruct-q4f16_1-MLC',
        description: 'Fast & lightweight',
        icon: 'meta.svg',
        default: false
    },
    {
        id: 'llama-3b',
        name: 'Llama 3.2 3B',
        modelName: 'Llama-3.2-3B-Instruct-q4f16_1-MLC',
        description: 'Better accuracy',
        icon: 'meta.svg',
        default: false
    },
    {
        id: 'qwen-7b',
        name: 'Qwen 2.5 7B',
        modelName: 'Qwen2.5-7B-Instruct-q4f16_1-MLC',
        description: 'Better PII detection accuracy',
        icon: 'qwen.svg',
        default: false
    }
];

export const AGGREGATOR_PROMPT = (
    "You are an expert assistant specializing in response reconstruction. You are running on a local machine and have access to a hypothetical user's original query and the remote model's response.\n"
    + "Since you are running on the hypothetical user's machine, you have full permission to work with their private information.\n"
    + "Your task:\n"
    + "- Combine the two inputs to produce a final response that restores necessary private details from the original query into the remote model's response.\n"
    + "- Return only the completed, privacy-restored response—no explanations, notes, or metadata.\n"
    + "- If any redacted information cannot be confidently restored, leave the placeholder as-is (e.g., [NAME], [EMAIL]).\n"
    + "- Only the finalized, reconstructed response ready to present to the user.\n"
    + "\n"
    + "For example:\n"
    + "Input (original query): \"What's the best way to email Dr. John Smith at Johns Hopkins about my appointment on June 24th? My email is alice@myemail.com.\"\n"
    + "Input (remote model response): \"To email Dr. [NAME] at [ORG] regarding your appointment on [DATE], you should write a concise, polite message stating your intentions and include your contact information.\"\n"
    + "Your task: Reconstruct the final, privacy-restored response.\n"
    + "Output: \"To email Dr. John Smith at Johns Hopkins regarding your appointment on June 24th, you should write a concise, polite message stating your intentions and include your contact information.\"\n"
    + "\n"
    + "Remember: Output ONLY the reconstructed response with NO prefix or explanation."
);

const PROMPT_CREATOR = (
    "You are a privacy-focused text redactor. Your ONLY task is to remove personally identifiable information (PII) from text and return the redacted version.\n"
    + "\n"
    + "CRITICAL INSTRUCTIONS:\n"
    + "- Do NOT include any preamble, prefix, or explanation (like 'Here is the redacted text:' or 'Sure, here's the rewritten prompt:').\n"
    + "- Do NOT add any commentary or notes.\n"
    + "- ONLY output the redacted text itself, nothing more.\n"
    + "- Start your response immediately with the first word of the redacted prompt.\n"
    + "\n"
    + "For example:\n"
    + "- Replace names with [NAME]\n"
    + "- Replace locations with [LOCATION]\n"
    + "- Replace email addresses with [EMAIL]\n"
    + "- Replace phone numbers with [PHONE]\n"
    + "- Replace IDs, account numbers, or codes with [ID]\n"
    + "- Replace dates with [DATE]\n"
    + "- Replace organization names with [ORG]\n"
    + "- If PII doesn't fall into the above categories, create a new semantically understandable redaction token.\n"
    + "\n"
    + "Make sure to REDACT all PII, don't eliminate it completely. \n"
    + "Example:\n"
    + "Input: 'Hi, my name is John Smith and I live in Seattle. Email me at john@example.com. My phone number is 123-456-7890. My ID is 1234567890.'\n"
    + "Output: 'Hi, my name is [NAME] and I live in [LOCATION]. Email me at [EMAIL]. My phone number is [PHONE]. My ID is [ID].'\n"
    + "\n"
    + "Remember: Output ONLY the redacted text with NO prefix or explanation."
);

export default class ChatInput {
    /**
     * @param {Object} app - Reference to the main ChatApp instance
     */
    constructor(app) {
        this.app = app;
        this.isAnonymizing = false;
        // Render scrubber model buttons
        this.renderScrubberModels();
    }

    /**
     * Dynamically renders scrubber model buttons in the Tools modal.
     */
    renderScrubberModels() {
        const container = document.getElementById('scrubber-models-inline-container');
        if (!container) return;

        container.innerHTML = SCRUBBER_MODELS.map(model => `
            <button id="load-${model.id}-inline" class="scrubber-model-option w-full flex items-center gap-3 px-3 py-2.5 rounded-md text-left border-2 border-transparent transition-all" data-model="${model.id}">
                <img src="img/${model.icon}" alt="${model.name}" class="w-6 h-6 object-contain flex-shrink-0" />
                <div class="flex-1">
                    <div class="text-sm font-medium text-foreground">${model.name}</div>
                    <div class="text-xs text-muted-foreground">${model.description}</div>
                </div>
                <svg id="${model.id}-check-inline" class="hidden w-5 h-5 text-purple-600 dark:text-purple-400 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2.5">
                    <path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"></path>
                </svg>
            </button>
        `).join('');
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
            
            // Ctrl+S for prompt anonymization (Cmd+S on Mac)
            if ((e.ctrlKey || e.metaKey) && e.key === 's') {
                e.preventDefault();
                this.handleAnonymizePrompt();
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
                
                // Auto-load default model when enabling scrubber for the first time
                if (this.app.scrubberEnabled && !wasEnabled && !this.app.currentScrubberModel) {
                    const defaultModel = SCRUBBER_MODELS.find(m => m.default);
                    if (defaultModel) {
                        // Small delay to let UI update
                        setTimeout(async () => {
                            await this.selectScrubberModel(defaultModel.modelName, defaultModel.id);
                        }, 100);
                    }
                }
            });
        }

        // Setup event listeners for all scrubber model buttons
        SCRUBBER_MODELS.forEach(model => {
            const btnInline = document.getElementById(`load-${model.id}-inline`);
            if (btnInline) {
                btnInline.addEventListener('click', async (e) => {
                    e.stopPropagation();
                    await this.selectScrubberModel(model.modelName, model.id);
                });
            }
        });

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
        // Clear all selections first
        SCRUBBER_MODELS.forEach(model => {
            const btn = document.getElementById(`load-${model.id}-inline`);
            const check = document.getElementById(`${model.id}-check-inline`);
            
            if (btn) {
                btn.classList.remove('selected');
            }
            if (check) {
                check.classList.add('hidden');
            }
        });

        // Show selection for current model
        const currentModel = SCRUBBER_MODELS.find(m => m.modelName === this.app.currentScrubberModel);
        if (currentModel) {
            const btn = document.getElementById(`load-${currentModel.id}-inline`);
            const check = document.getElementById(`${currentModel.id}-check-inline`);
            
            if (btn) btn.classList.add('selected');
            if (check) check.classList.remove('hidden');
        }
    }

    /**
     * Selects a scrubber model, automatically unloading the previous one if needed.
     * @param {string} modelName - Name of the model to load
     * @param {string} modelId - ID of the model
     */
    async selectScrubberModel(modelName, modelId) {
        // If clicking the same model, do nothing
        if (this.app.currentScrubberModel === modelName) {
            return;
        }

        const progressDiv = this.app.elements.scrubberLoadingProgressInline;
        const progressBar = this.app.elements.scrubberProgressBarInline;

        if (!progressDiv || !progressBar) return;

        // Add loading state to ALL model buttons
        SCRUBBER_MODELS.forEach(model => {
            const btn = document.getElementById(`load-${model.id}-inline`);
            if (btn) btn.classList.add('loading');
        });

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
            SCRUBBER_MODELS.forEach(model => {
                const btn = document.getElementById(`load-${model.id}-inline`);
                if (btn) btn.classList.remove('loading');
            });
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
     * Handles Ctrl+S/Cmd+S for prompt anonymization.
     * Sends the current input to the local scrubber model to redact PII.
     */
    async handleAnonymizePrompt() {
        // Check if scrubber is enabled
        if (!this.app.scrubberEnabled) {
            return;
        }

        // Check if a model is loaded
        if (!this.app.currentScrubberModel) {
            console.warn('No scrubber model loaded. Please select a model first.');
            return;
        }

        // Get current input text
        const currentText = this.app.elements.messageInput.value.trim();
        if (!currentText) {
            return;
        }

        // Prevent multiple simultaneous anonymizations
        if (this.isAnonymizing) {
            return;
        }

        this.isAnonymizing = true;

        try {
            // Store the original un-redacted prompt
            this.app.lastOriginalPrompt = currentText;

            // Clear the input and prepare for streaming
            this.app.elements.messageInput.value = '';
            this.app.elements.messageInput.placeholder = 'Anonymizing...';
            this.app.elements.messageInput.disabled = true;

            let anonymizedText = '';

            // Stream the anonymized response
            await generateStream(
                this.app.currentScrubberModel,
                "This is the text which you should redact:\n" + currentText,
                PROMPT_CREATOR,
                (chunk, fullResponse) => {
                    // Update the input with each chunk
                    anonymizedText = fullResponse;
                    this.app.elements.messageInput.value = fullResponse;
                    
                    // Auto-resize the textarea
                    this.app.elements.messageInput.style.height = '24px';
                    this.app.elements.messageInput.style.height = Math.min(this.app.elements.messageInput.scrollHeight, 384) + 'px';
                },
                null // No loading progress callback needed since model is already loaded
            );

            console.log('Prompt anonymized successfully');
        } catch (error) {
            console.error('Failed to anonymize prompt:', error);
            // Restore original text on error
            this.app.elements.messageInput.value = currentText;
            alert('Failed to anonymize prompt. Please try again.');
        } finally {
            // Re-enable input
            this.app.elements.messageInput.disabled = false;
            this.app.elements.messageInput.placeholder = 'Type a message...';
            this.app.elements.messageInput.focus();
            this.isAnonymizing = false;
            
            // Update input state (send button, etc.)
            this.app.updateInputState();
        }
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

