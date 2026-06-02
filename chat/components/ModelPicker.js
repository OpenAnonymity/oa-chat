/**
 * ModelPicker Component
 * Manages the model selection modal including search, filtering,
 * and model selection interactions.
 *
 * CONFIGURATION:
 * Model defaults + availability (pinned/disabled) are sourced from services/modelConfig.js.
 */

import { getProviderIcon } from '../services/providerIcons.js';
import { resolveProvider, resolveProviderFromModelReference } from '../services/providerRegistry.js';
import { getDefaultModelConfig, onPinnedModelsUpdate } from '../services/modelConfig.js';
import { getTicketCost, onModelTiersUpdate } from '../services/modelTiers.js';

export default class ModelPicker {
    /**
     * @param {Object} app - Reference to the main ChatApp instance
     */
    constructor(app) {
        this.app = app;

        // Load defaults synchronously for immediate use
        const defaults = getDefaultModelConfig();
        this.pinnedModels = defaults.pinnedModels;
        this.disabledModels = new Set(defaults.disabledModels || []);
        this.defaultModelName = defaults.defaultModelName;

        // Keyboard navigation state
        this.highlightedIndex = -1;

        // Scroll position state
        this.savedScrollTop = 0;
        this.modelsListClickBound = false;
        this.lastRenderSignature = null;
        this.hasRenderedOnce = false;
        this.modelConfigVersion = 0;
        this.searchDebounceTimer = null;
        this.selectionMode = 'primary';

        // Listen for pinned/disabled updates (API fetch completed)
        onPinnedModelsUpdate(() => this._onConfigUpdate());

        // Listen for model tiers updates (for ticket cost display)
        onModelTiersUpdate(() => this._onConfigUpdate());
    }

    /**
     * Handle config update from API (pinned models or tiers changed).
     * Re-renders if modal is open.
     */
    _onConfigUpdate() {
        const defaults = getDefaultModelConfig();
        this.pinnedModels = defaults.pinnedModels;
        this.disabledModels = new Set(defaults.disabledModels || []);
        this.defaultModelName = defaults.defaultModelName;
        this.modelConfigVersion += 1;

        // Re-render if modal is currently visible
        if (!this.app.elements.modelPickerModal.classList.contains('hidden')) {
            const searchTerm = this.app.elements.modelSearch?.value || '';
            this.renderModels(searchTerm, true);
        }
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

        // Search input with debouncing to reduce re-renders during fast typing
        this.app.elements.modelSearch.addEventListener('input', (e) => {
            const searchTerm = e.target.value;
            clearTimeout(this.searchDebounceTimer);
            this.searchDebounceTimer = setTimeout(() => {
                this.renderModels(searchTerm);
            }, 80);
        });

        // Keyboard navigation
        this.app.elements.modelSearch.addEventListener('keydown', (e) => {
            this.handleKeyboardNavigation(e);
        });

        if (!this.modelsListClickBound && this.app.elements.modelsList) {
            this.modelsListClickBound = true;
            this.app.elements.modelsList.addEventListener('click', (event) => {
                const option = event.target.closest('.model-option');
                if (!option || !this.app.elements.modelsList.contains(option)) {
                    return;
                }
                this.selectModel(option.dataset.modelName);
            });
        }
    }

    /**
     * Opens the model picker modal and focuses the search input.
     */
    open(options = {}) {
        this.selectionMode = options.selectionMode || options.mode || 'primary';
        const modal = this.app.elements.modelPickerModal;
        modal.classList.remove('hidden');
        modal.dataset.selectionMode = this.selectionMode;
        if (this.app.elements.modelSearch) {
            this.app.elements.modelSearch.placeholder = this.isSecondarySelectionMode()
                ? 'Search second model...'
                : this.isSynthesisSelectionMode()
                    ? 'Search council model...'
                    : 'Search models...';
        }
        this.highlightedIndex = -1;
        const shouldRestoreScroll = this.savedScrollTop > 0;
        this.renderModels('', shouldRestoreScroll, true);
        // Restore scroll position after browser renders the content
        requestAnimationFrame(() => {
            if (shouldRestoreScroll) {
                this.app.elements.modelListScrollArea.scrollTop = this.savedScrollTop;
            }
            this.app.elements.modelSearch.focus();
        });
    }

    /**
     * Closes the model picker modal and clears the search.
     */
    close() {
        // Save scroll position before hiding (from the scroll container, not inner list)
        this.savedScrollTop = this.app.elements.modelListScrollArea.scrollTop;
        this.app.elements.modelPickerModal.classList.add('hidden');
        delete this.app.elements.modelPickerModal.dataset.selectionMode;
        // Clear search
        this.app.elements.modelSearch.value = '';
        this.app.elements.modelSearch.placeholder = 'Search models...';
        this.selectionMode = 'primary';
        // Focus input after closing modal
        requestAnimationFrame(() => {
            if (this.app.elements.messageInput) {
                this.app.elements.messageInput.focus();
            }
        });
    }

    /**
     * Toggles the model picker modal open/closed.
     */
    toggle(options = {}) {
        const requestedMode = options.selectionMode || options.mode || 'primary';
        if (this.app.elements.modelPickerModal.classList.contains('hidden')) {
            this.open({ selectionMode: requestedMode });
        } else if (this.selectionMode !== requestedMode) {
            this.open({ selectionMode: requestedMode });
        } else {
            this.close();
        }
    }

    isSecondarySelectionMode() {
        return this.selectionMode === 'council-secondary';
    }

    isSynthesisSelectionMode() {
        return this.selectionMode === 'council-synthesis';
    }

    /**
     * Filters models based on search term using multi-word substring matching.
     * Space-separated words are matched independently (AND logic).
     * Also excludes disabled models from the list.
     * @param {string} searchTerm - Search query (space-separated words)
     * @returns {Array} Filtered models
     */
    filterModels(searchTerm = '') {
        // First filter out disabled models
        let allowedModels = this.app.state.models.filter(model =>
            !this.disabledModels.has(model.id)
        );
        if (this.isSecondarySelectionMode()) {
            const primaryModelName = this.app.getPrimaryModelName?.() || null;
            allowedModels = allowedModels.filter(model => model.name !== primaryModelName);
        }

        // Split into non-empty lowercase terms
        const terms = searchTerm.toLowerCase().split(' ').filter(Boolean);
        if (terms.length === 0) return allowedModels;

        // Single term optimization - avoid extra string concat
        if (terms.length === 1) {
            const term = terms[0];
            return allowedModels.filter(model =>
                model.name.toLowerCase().includes(term) ||
                model.provider.toLowerCase().includes(term) ||
                model.category.toLowerCase().includes(term)
            );
        }

        // Multi-term: combine fields once, check all terms
        return allowedModels.filter(model => {
            const haystack = `${model.name} ${model.provider} ${model.category}`.toLowerCase();
            for (let i = 0; i < terms.length; i++) {
                if (!haystack.includes(terms[i])) return false;
            }
            return true;
        });
    }

    getCurrentModelName() {
        if (this.isSecondarySelectionMode()) {
            return this.app.getCouncilSecondaryModelName?.() || '';
        }
        if (this.isSynthesisSelectionMode()) {
            return this.app.getCouncilSynthesisModelName?.() || '';
        }
        return this.getPrimaryCurrentModelName();
    }

    getPrimaryCurrentModelName() {
        const resolvedPrimaryModelName = this.app.getPrimaryModelName?.();
        if (resolvedPrimaryModelName) {
            return resolvedPrimaryModelName;
        }
        const session = this.app.getCurrentSession();
        const rawModelName = (session && session.model) || this.app.state.pendingModelName || null;
        const modelsLoaded = this.app.state.models && this.app.state.models.length > 0;
        const defaultModelName = this.getDefaultModelName();
        return rawModelName
            ? (modelsLoaded && !this.isModelAvailable(rawModelName) ? defaultModelName : rawModelName)
            : defaultModelName;
    }

    getDefaultModelName() {
        return typeof this.app.getDefaultModelName === 'function'
            ? this.app.getDefaultModelName()
            : this.defaultModelName;
    }

    getRenderSignature(searchTerm) {
        const modelsVersion = this.app.state.modelsVersion || 0;
        const modelsLength = this.app.state.models?.length || 0;
        const reasoningFlag = this.app.reasoningEnabled ? '1' : '0';
        const loadingFlag = this.app.state.modelsLoading ? '1' : '0';
        const primaryModelName = this.app.getPrimaryModelName?.() || '';
        return [
            this.selectionMode,
            searchTerm,
            this.getCurrentModelName(),
            primaryModelName,
            modelsVersion,
            modelsLength,
            this.modelConfigVersion,
            reasoningFlag,
            loadingFlag
        ].join('|');
    }

    /**
     * Renders the models list grouped by category.
     * @param {string} searchTerm - Optional search term to filter
     * @param {boolean} skipAutoScroll - Skip auto-scroll when restoring scroll position
     * @param {boolean} force - Force render even if unchanged
     */
    renderModels(searchTerm = '', skipAutoScroll = false, force = false) {
        const renderSignature = this.getRenderSignature(searchTerm);
        if (!force && this.hasRenderedOnce && renderSignature === this.lastRenderSignature) {
            this.highlightedIndex = -1;
            const modelOptions = this.getModelOptions();
            if (modelOptions.length > 0) {
                this.highlightedIndex = 0;
                this.updateHighlight(modelOptions, skipAutoScroll);
            }
            return;
        }

        this.lastRenderSignature = renderSignature;
        this.hasRenderedOnce = true;

        // Show loading state if models are still being fetched
        if (this.app.state.modelsLoading || this.app.state.models.length === 0) {
            this.app.elements.modelsList.innerHTML = `
                <div class="flex items-center justify-center py-8 text-muted-foreground">
                    <style>@keyframes modelpicker-spin { to { transform: rotate(360deg); } }</style>
                    <div style="width: 14px; height: 14px; border: 2px solid #9ca3af; border-top-color: #3b82f6; border-radius: 50%; animation: modelpicker-spin 0.6s linear infinite;"></div>
                    <span class="text-sm ml-2">Loading models...</span>
                </div>
            `;
            return;
        }

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

        // Render all unpinned models sorted alphabetically by display name
        const sortedModels = [...unpinnedModels].sort((a, b) =>
            a.name.localeCompare(b.name)
        );
        if (sortedModels.length > 0) {
            html += `
                <div class="mb-3">
                    <div class="model-category-header px-2 py-1 text-xs font-medium text-muted-foreground">All Models</div>
                    <div class="space-y-0">
                        ${sortedModels.map(model => this.buildModelOptionHTML(model)).join('')}
                    </div>
                </div>
            `;
        }

        this.app.elements.modelsList.innerHTML = html;

        // Auto-highlight first item so user can immediately press Enter
        const modelOptions = this.getModelOptions();
        if (modelOptions.length > 0) {
            this.highlightedIndex = 0;
            this.updateHighlight(modelOptions, skipAutoScroll);
        }
    }

    warmRender() {
        if (this.app.state.modelsLoading || this.app.state.models.length === 0) {
            return;
        }
        const renderSignature = this.getRenderSignature('');
        if (this.hasRenderedOnce && renderSignature === this.lastRenderSignature) {
            return;
        }
        const schedule = typeof requestIdleCallback === 'function'
            ? (callback) => requestIdleCallback(callback, { timeout: 500 })
            : (callback) => setTimeout(callback, 0);
        schedule(() => {
            if (this.app.elements.modelPickerModal.classList.contains('hidden')) {
                this.renderModels('', true);
            }
        });
    }

    /**
     * Builds HTML for a single model option.
     * @param {Object} model - Model object
     * @returns {string} HTML string
     */
    buildModelOptionHTML(model) {
        const session = this.app.getCurrentSession();
        const currentModel = this.isSecondarySelectionMode() || this.isSynthesisSelectionMode()
            ? this.getCurrentModelName()
            : (session?.model || this.app.state.pendingModelName);
        const isSelected = currentModel === model.name;
        const iconData = getProviderIcon(model.provider, 'w-3.5 h-3.5');
        const bgClass = iconData.hasIcon ? 'bg-white' : 'bg-muted';

        // Get ticket cost for this model (use current reasoning state from app)
        const reasoningEnabled = this.app.reasoningEnabled ?? true;
        const ticketCost = getTicketCost(model.id, reasoningEnabled);

        // Checkmark slot - always reserve space for consistent alignment
        const checkmarkSlot = isSelected
            ? '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" class="w-4 h-4 text-primary flex-shrink-0"><path fill-rule="evenodd" d="M19.916 4.626a.75.75 0 0 1 .208 1.04l-9 13.5a.75.75 0 0 1-1.154.114l-6-6a.75.75 0 0 1 1.06-1.06l5.353 5.353 8.493-12.74a.75.75 0 0 1 1.04-.207Z" clip-rule="evenodd" /></svg>'
            : '<span class="w-4 h-4 flex-shrink-0"></span>';

        // Build ticket badge - always show for all models
        const ticketBadge = `
            <span class="text-xs px-2 py-1 rounded bg-muted text-muted-foreground font-medium flex-shrink-0 min-w-[34px] inline-flex items-center justify-center gap-1.5" title="${ticketCost} ticket${ticketCost > 1 ? 's' : ''}">
                <svg class="w-3.5 h-3.5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 5v2m0 4v2m0 4v2M5 5a2 2 0 00-2 2v3a2 2 0 110 4v3a2 2 0 002 2h14a2 2 0 002-2v-3a2 2 0 110-4V7a2 2 0 00-2-2H5z"></path>
                </svg>
                <span>${ticketCost}</span>
            </span>
        `;

        return `
            <div class="model-option px-2 py-1.5 rounded-sm cursor-pointer transition-colors hover:bg-accent ${isSelected ? 'bg-accent' : ''}" data-model-name="${model.name}">
                <div class="flex items-center gap-2">
                    <div class="flex items-center justify-center w-6 h-6 flex-shrink-0 rounded-full border border-border/50 ${bgClass}">
                        ${iconData.html}
                    </div>
                    <div class="flex-1 min-w-0">
                        <div class="font-medium text-sm text-foreground truncate">${model.name}</div>
                    </div>
                    ${checkmarkSlot}
                    ${ticketBadge}
                </div>
            </div>
        `;
    }

    /**
     * Selects a model by name and updates the session or stores as pending.
     * @param {string} modelName - Display name chosen by the user
     */
    async selectModel(modelName) {
        if (this.isSecondarySelectionMode() && this.app.actions.selectCouncilSecondaryModel) {
            await this.app.actions.selectCouncilSecondaryModel(modelName);
        } else if (this.isSynthesisSelectionMode() && this.app.actions.selectCouncilSynthesisModel) {
            await this.app.actions.selectCouncilSynthesisModel(modelName);
        } else {
            await this.app.actions.selectModel(modelName);
        }
        this.close(); // close() handles input focus
    }

    /**
     * Checks if a model name/id exists in the available models list.
     * @param {string} modelName - Model name or ID to check
     * @returns {boolean} True if model exists in available models
     */
    isModelAvailable(modelName) {
        if (!modelName || !Array.isArray(this.app.state.models) || this.app.state.models.length === 0) {
            return false;
        }
        // Check by name or id (imported chats may have model slugs or IDs)
        return this.app.state.models.some(
            m => (m.name === modelName || m.id === modelName) && !this.disabledModels.has(m.id)
        );
    }

    /**
     * Renders the current model display in the input area.
     */
    renderCurrentModel() {
        const currentModelName = this.getPrimaryCurrentModelName();

        // Guard against elements not being available
        if (!this.app.elements.modelPickerBtn) {
            return;
        }

        // Always show shortcut HTML
        const shortcutHtml = `
            <div class="flex items-center gap-0.5 ml-2 pointer-events-none text-muted-foreground text-xs">
                <span class="opacity-60">⌘</span>
                <span class="opacity-60">K</span>
            </div>
        `;

        // Prefer catalog metadata; persisted IDs and explicit provider prefixes are
        // resolved centrally without guessing a company from model-family keywords.
        const matchesCurrentModel = (model) => model.name === currentModelName || model.id === currentModelName;
        const model = this.app.state.models.find(matchesCurrentModel)
            || this.app.cachedModelDisplayMetadata.find(matchesCurrentModel);
        const provider = model?.provider
            ? resolveProvider(model.provider).displayName
            : resolveProviderFromModelReference(currentModelName).displayName;
        // getProviderIcon returns first letter fallback when no icon configured
        const iconData = getProviderIcon(provider, 'w-3 h-3');

        // Use icon HTML directly - getProviderIcon already provides first letter fallback
        // Only show spinner if provider is completely unknown (very rare)
        const iconContent = iconData.html || `<span class="text-[10px] font-semibold">?</span>`;
        const bgClass = iconData.hasIcon ? 'bg-white' : 'bg-muted';

        // Extract short model name (without provider prefix) for compact display
        // Format: "Provider: Model" -> "Model"
        let shortModelName = currentModelName;
        if (currentModelName && currentModelName.includes(': ')) {
            shortModelName = currentModelName.split(': ').slice(1).join(': ');
        }

        this.app.elements.modelPickerBtn.innerHTML = `
            <div class="flex items-center justify-center w-5 h-5 flex-shrink-0 rounded-full border border-border/50 ${bgClass}">
                ${iconContent}
            </div>
            <span class="model-name-container min-w-0 truncate">${shortModelName}</span>
            ${shortcutHtml}
        `;
        this.app.elements.modelPickerBtn.classList.add('gap-1.5');

        // Also update the edit form model picker button if it exists (keeps it in sync)
        const editModelPickerBtn = document.getElementById('edit-model-picker-btn');
        if (editModelPickerBtn) {
            editModelPickerBtn.innerHTML = `
                <div class="flex items-center justify-center w-5 h-5 flex-shrink-0 rounded-full border border-border/50 ${bgClass}">
                    ${iconContent}
                </div>
                <span class="model-name-container min-w-0 truncate">${shortModelName}</span>
            `;
        }
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
                e.preventDefault();
                // Select highlighted item, or first item if none highlighted
                const indexToSelect = this.highlightedIndex >= 0 ? this.highlightedIndex : 0;
                if (indexToSelect < modelOptions.length) {
                    const selectedModel = modelOptions[indexToSelect].dataset.modelName;
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
        if (!this.app.elements.modelsList) {
            return [];
        }
        return Array.from(this.app.elements.modelsList.querySelectorAll('.model-option'));
    }

    /**
     * Updates the visual highlight for keyboard navigation.
     * @param {Array} modelOptions - Array of model option elements
     * @param {boolean} skipScroll - Skip scrollIntoView (used when restoring scroll position)
     */
    updateHighlight(modelOptions, skipScroll = false) {
        // Remove keyboard highlight from all options
        modelOptions.forEach(el => {
            el.classList.remove('keyboard-highlight');
        });

        // Add keyboard highlight to current option
        if (this.highlightedIndex >= 0 && this.highlightedIndex < modelOptions.length) {
            const currentOption = modelOptions[this.highlightedIndex];
            currentOption.classList.add('keyboard-highlight');
            // Scroll into view (unless restoring saved scroll position)
            if (!skipScroll) {
                currentOption.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
            }
        }
    }
}
