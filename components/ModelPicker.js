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
        ];
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
    }

    /**
     * Opens the model picker modal and focuses the search input.
     */
    open() {
        this.app.elements.modelPickerModal.classList.remove('hidden');
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
     * Filters models based on search term.
     * @param {string} searchTerm - Search query
     * @returns {Array} Filtered models
     */
    filterModels(searchTerm = '') {
        const term = searchTerm.toLowerCase();
        if (!term) return this.app.state.models;

        return this.app.state.models.filter(model =>
            model.name.toLowerCase().includes(term) ||
            model.provider.toLowerCase().includes(term) ||
            model.category.toLowerCase().includes(term)
        );
    }

    /**
     * Renders the models list grouped by category.
     * @param {string} searchTerm - Optional search term to filter
     */
    renderModels(searchTerm = '') {
        const filteredModels = this.filterModels(searchTerm);

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
     * Selects a model and updates the session.
     * @param {string} modelName - Name of the model to select
     */
    async selectModel(modelName) {
        const session = this.app.getCurrentSession();
        if (session) {
            session.model = modelName;
            await chatDB.saveSession(session);
            this.app.renderCurrentModel();
            this.close();
        }
    }

    /**
     * Renders the current model display in the input area.
     */
    renderCurrentModel() {
        const session = this.app.getCurrentSession();
        const modelName = session ? session.model : null;

        // Guard against elements not being available
        if (!this.app.elements.modelPickerBtn) {
            return;
        }

        if (modelName) {
            const model = this.app.state.models.find(m => m.name === modelName);
            const iconData = model ? getProviderIcon(model.provider, 'w-3 h-3') : { html: '', hasIcon: false };
            const bgClass = iconData.hasIcon ? 'bg-white' : 'bg-muted';
            this.app.elements.modelPickerBtn.innerHTML = `
                <div class="flex items-center justify-center w-5 h-5 flex-shrink-0 rounded-full border border-border/50 ${bgClass}">
                    ${iconData.html}
                </div>
                <span class="truncate">${modelName}</span>
            `;
            this.app.elements.modelPickerBtn.classList.add('gap-1.5');
        } else {
            const shortcutHtml = `
                <div class="flex items-center gap-0.5 ml-2">
                    <kbd class="flex items-center justify-center h-4 w-4 p-1 rounded-sm bg-muted border border-border text-foreground text-xs">⌘</kbd>
                    <kbd class="flex items-center justify-center h-4 w-4 p-1 rounded-sm bg-muted border border-border text-foreground text-xs">K</kbd>
                </div>
            `;
            this.app.elements.modelPickerBtn.innerHTML = `
                <span>Select Model</span>
                ${shortcutHtml}
            `;
            this.app.elements.modelPickerBtn.classList.remove('gap-1.5');
        }
    }
}

