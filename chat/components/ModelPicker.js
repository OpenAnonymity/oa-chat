/**
 * ModelPicker Component
 * Manages the model selection modal including search, filtering,
 * and model selection interactions.
 *
 * CONFIGURATION:
 * To pin specific models to the top of the list, edit the pinnedModels array in the constructor.
 * Add model IDs (e.g., 'openai/gpt-4o', 'anthropic/claude-3.5-sonnet') in the order you want them to appear.
 * Pinned models will appear in a separate "Pinned" section at the top.
 */

import { getProviderIcon } from '../services/providerIcons.js';

export default class ModelPicker {
    /**
     * @param {Object} app - Reference to the main ChatApp instance
     */
    constructor(app) {
        this.app = app;

        // Configuration: Pin specific models to the top
        // Add model IDs here to always show them first
        this.pinnedModels = [
            // Example: Uncomment to pin specific models
            'openai/gpt-5-chat',
            'openai/gpt-5',
            'anthropic/claude-sonnet-4.5',
            'anthropic/claude-opus-4.1',
            'google/gemini-2.5-pro',
            'google/gemini-2.5-flash-image-preview', // Nano Banana
        ];

        // Default model to show when no model is selected
        this.defaultModelName = 'OpenAI: GPT-5 Chat';

        // Keyboard navigation state
        this.highlightedIndex = -1;
    }

    /**
     * Sets up event listeners for the model picker interactions.
     */
    setupEventListeners() {
        // Open model picker button
        this.app.elements.modelPickerBtn.addEventListener('click', () => {
            this.open();
        });

        // Close button
        this.app.elements.closeModalBtn.addEventListener('click', () => {
            this.close();
        });

        // Close on backdrop click
        this.app.elements.modelPickerModal.addEventListener('click', (e) => {
            if (e.target === this.app.elements.modelPickerModal) {
                this.close();
            }
        });

        // Search input
        this.app.elements.modelSearch.addEventListener('input', (e) => {
            this.renderModels(e.target.value);
        });

        // Keyboard navigation
        this.app.elements.modelSearch.addEventListener('keydown', (e) => {
            this.handleKeyboardNavigation(e);
        });
    }

    /**
     * Opens the model picker modal and focuses the search input.
     */
    open() {
        this.app.elements.modelPickerModal.classList.remove('hidden');
        this.highlightedIndex = -1;
        this.renderModels();
        // Focus search input after a brief delay to ensure modal is visible
        setTimeout(() => {
            this.app.elements.modelSearch.focus();
        }, 100);
    }

    /**
     * Closes the model picker modal and clears the search.
     */
    close() {
        this.app.elements.modelPickerModal.classList.add('hidden');
        // Clear search
        this.app.elements.modelSearch.value = '';
    }

    /**
     * Filters models based on search term using fuzzy matching.
     * @param {string} searchTerm - Search query
     * @returns {Array} Filtered models
     */
    filterModels(searchTerm = '') {
        const term = searchTerm.toLowerCase();
        if (!term) return this.app.state.models;

        return this.app.state.models.filter(model =>
            this.app.fuzzyMatch(term, model.name.toLowerCase()) ||
            this.app.fuzzyMatch(term, model.provider.toLowerCase()) ||
            this.app.fuzzyMatch(term, model.category.toLowerCase())
        );
    }

    /**
     * Renders the models list grouped by category.
     * @param {string} searchTerm - Optional search term to filter
     */
    renderModels(searchTerm = '') {
        const filteredModels = this.filterModels(searchTerm);

        // Reset keyboard highlight when rendering
        this.highlightedIndex = -1;

        // Separate pinned models from the rest
        const pinnedModelsList = [];
        const unpinnedModels = [];

        filteredModels.forEach(model => {
            if (this.pinnedModels.includes(model.id)) {
                pinnedModelsList.push(model);
            } else {
                unpinnedModels.push(model);
            }
        });

        // Sort pinned models according to the pinnedModels array order
        pinnedModelsList.sort((a, b) => {
            return this.pinnedModels.indexOf(a.id) - this.pinnedModels.indexOf(b.id);
        });

        let html = '';

        // Render pinned models section if there are any
        if (pinnedModelsList.length > 0) {
            html += `
                <div class="mb-3">
                    <div class="model-category-header px-2 py-1 text-xs font-medium text-muted-foreground">Pinned</div>
                    <div class="space-y-0">
                        ${pinnedModelsList
                            .map(model => this.buildModelOptionHTML(model))
                            .join('')}
                    </div>
                </div>
            `;
        }

        // Render categories for unpinned models
        const categories = [...new Set(unpinnedModels.map(m => m.category))];
        html += categories.map(category => `
            <div class="mb-3">
                <div class="model-category-header px-2 py-1 text-xs font-medium text-muted-foreground">${category}</div>
                <div class="space-y-0">
                    ${unpinnedModels
                        .filter(m => m.category === category)
                        .map(model => this.buildModelOptionHTML(model))
                        .join('')}
                </div>
            </div>
        `).join('');

        this.app.elements.modelsList.innerHTML = html;

        // Wire up click handlers
        this.attachModelClickListeners();
    }

    /**
     * Builds HTML for a single model option.
     * @param {Object} model - Model object
     * @returns {string} HTML string
     */
    buildModelOptionHTML(model) {
        const session = this.app.getCurrentSession();
        const isSelected = session && session.model === model.name;
        const iconData = getProviderIcon(model.provider, 'w-3.5 h-3.5');
        const bgClass = iconData.hasIcon ? 'bg-white' : 'bg-muted';

        return `
            <div class="model-option px-2 py-1.5 rounded-sm cursor-pointer transition-colors hover:bg-accent ${isSelected ? 'bg-accent' : ''}" data-model="${model.name}">
                <div class="flex items-center gap-2">
                    <div class="flex items-center justify-center w-6 h-6 flex-shrink-0 rounded-full border border-border/50 ${bgClass}">
                        ${iconData.html}
                    </div>
                    <div class="flex-1 min-w-0">
                        <div class="font-medium text-sm text-foreground truncate">${model.name}</div>
                    </div>
                    ${isSelected ? '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" class="w-4 h-4 text-primary flex-shrink-0"><path fill-rule="evenodd" d="M19.916 4.626a.75.75 0 0 1 .208 1.04l-9 13.5a.75.75 0 0 1-1.154.114l-6-6a.75.75 0 0 1 1.06-1.06l5.353 5.353 8.493-12.74a.75.75 0 0 1 1.04-.207Z" clip-rule="evenodd" /></svg>' : ''}
                </div>
            </div>
        `;
    }

    /**
     * Attaches click listeners to model options.
     */
    attachModelClickListeners() {
        document.querySelectorAll('.model-option').forEach(el => {
            el.addEventListener('click', () => {
                this.selectModel(el.dataset.model);
            });
        });
    }

    /**
     * Selects a model and updates the session or stores as pending.
     * @param {string} modelName - Name of the model to select
     */
    async selectModel(modelName) {
        const session = this.app.getCurrentSession();

        // Always save as selected model for future sessions
        await chatDB.saveSetting('selectedModel', modelName);

        if (!session) {
            // No session exists - store as pending model
            // Will be used when session is created (e.g., when first message is sent)
            this.app.state.pendingModel = modelName;
            this.app.renderCurrentModel();
            this.close();
            return;
        }

        // Update existing session
        session.model = modelName;
        await chatDB.saveSession(session);
        this.app.renderCurrentModel();
        this.close();
    }

    /**
     * Renders the current model display in the input area.
     */
    renderCurrentModel() {
        const session = this.app.getCurrentSession();
        // Show model from session if exists and not null, otherwise show pending model or default
        const modelName = (session && session.model) || this.app.state.pendingModel || this.defaultModelName;

        // Guard against elements not being available
        if (!this.app.elements.modelPickerBtn) {
            return;
        }

        // Always show shortcut HTML
        const shortcutHtml = `
            <div class="flex items-center gap-0.5 ml-2">
                <kbd class="flex items-center justify-center h-4 w-4 p-1 rounded-sm bg-muted border border-border text-foreground text-xs">⌘</kbd>
                <kbd class="flex items-center justify-center h-4 w-4 p-1 rounded-sm bg-muted border border-border text-foreground text-xs">K</kbd>
            </div>
        `;

        const model = this.app.state.models.find(m => m.name === modelName);
        const iconData = model ? getProviderIcon(model.provider, 'w-3 h-3') : { html: '', hasIcon: false };
        const bgClass = iconData.hasIcon ? 'bg-white' : 'bg-muted';

        this.app.elements.modelPickerBtn.innerHTML = `
            <div class="flex items-center justify-center w-5 h-5 flex-shrink-0 rounded-full border border-border/50 ${bgClass}">
                ${iconData.html}
            </div>
            <span class="truncate">${modelName}</span>
            ${shortcutHtml}
        `;
        this.app.elements.modelPickerBtn.classList.add('gap-1.5');
    }

    /**
     * Handles keyboard navigation within the model picker.
     * @param {KeyboardEvent} e - Keyboard event
     */
    handleKeyboardNavigation(e) {
        const modelOptions = this.getModelOptions();
        if (modelOptions.length === 0) return;

        switch (e.key) {
            case 'ArrowDown':
                e.preventDefault();
                this.highlightedIndex = Math.min(this.highlightedIndex + 1, modelOptions.length - 1);
                this.updateHighlight(modelOptions);
                break;

            case 'ArrowUp':
                e.preventDefault();
                this.highlightedIndex = Math.max(this.highlightedIndex - 1, -1);
                this.updateHighlight(modelOptions);
                break;

            case 'Enter':
                if (this.highlightedIndex >= 0 && this.highlightedIndex < modelOptions.length) {
                    e.preventDefault();
                    const selectedModel = modelOptions[this.highlightedIndex].dataset.model;
                    this.selectModel(selectedModel);
                }
                break;
        }
    }

    /**
     * Gets all visible model option elements.
     * @returns {Array} Array of model option elements
     */
    getModelOptions() {
        return Array.from(document.querySelectorAll('.model-option'));
    }

    /**
     * Updates the visual highlight for keyboard navigation.
     * @param {Array} modelOptions - Array of model option elements
     */
    updateHighlight(modelOptions) {
        // Remove keyboard highlight from all options
        modelOptions.forEach(el => {
            el.classList.remove('keyboard-highlight');
        });

        // Add keyboard highlight to current option
        if (this.highlightedIndex >= 0 && this.highlightedIndex < modelOptions.length) {
            const currentOption = modelOptions[this.highlightedIndex];
            currentOption.classList.add('keyboard-highlight');
            // Scroll into view
            currentOption.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        }
    }
}

