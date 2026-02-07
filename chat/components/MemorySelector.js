/**
 * Memory Selector Component
 * Modal for selecting and retrieving memories from the event store
 * Triggered with @ or Ctrl+Ctrl
 */

import { memoryRetrievalService } from '../services/memoryRetrievalService.js';

export default class MemorySelector {
    constructor(app) {
        this.app = app;
        this.container = null;
        this.mode = 'inline';
        this.isOpen = false;
        this.isLoading = false;
        this.memories = [];
        this.selectedIndices = new Set();
        this.searchQuery = '';
        this.lastQuery = '';
        this.boundHandleOutsideClick = this.handleOutsideClick.bind(this);
        this.boundRepositionInlinePopup = this.repositionInlinePopup.bind(this);
    }

    /**
     * Open the memory selector modal and start retrieval
     * @param {string} query - Optional query to retrieve memories for
     */
    async open(query = '', options = {}) {
        if (this.isOpen) {
            this.close();
            if (!options.forceOpen) {
                return;
            }
        }

        const {
            mode = 'inline',
            preserveSelection = false,
            preserveSearch = false
        } = options;

        this.isOpen = true;
        this.mode = mode;
        this.lastQuery = query;
        this.searchQuery = preserveSearch ? this.searchQuery : '';
        if (!preserveSelection) {
            this.selectedIndices.clear();
            this.memories = [];
        }
        this.isLoading = true;

        if (this.mode === 'modal') {
            this.createModal();
        } else {
            this.createInlinePopup();
        }

        // Start retrieval immediately with the provided query
        await this.retrieveMemories(query);
    }

    close() {
        if (this.container) {
            this.container.remove();
        }
        document.removeEventListener('mousedown', this.boundHandleOutsideClick, true);
        window.removeEventListener('resize', this.boundRepositionInlinePopup);
        this.container = null;
        this.isOpen = false;
        this.isLoading = false;
    }

    createModal() {
        this.container = document.createElement('div');
        this.container.className = 'fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4';
        this.container.id = 'memory-selector-modal';

        this.container.innerHTML = `
            <div role="dialog" aria-modal="true" class="cursor-default relative w-full max-w-2xl border border-border bg-background shadow-lg rounded-lg overflow-hidden flex flex-col max-h-[80vh]">
                <!-- Header with Search -->
                <div class="flex items-center border-b border-border px-4 py-3 bg-muted/30">
                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" class="w-4 h-4 text-muted-foreground mr-2 flex-shrink-0">
                        <path fill-rule="evenodd" d="M10.5 3.75a6.75 6.75 0 1 0 0 13.5 6.75 6.75 0 0 0 0-13.5ZM2.25 10.5a8.25 8.25 0 1 1 14.59 5.28l4.69 4.69a.75.75 0 1 1-1.06 1.06l-4.69-4.69A8.25 8.25 0 0 1 2.25 10.5Z" clip-rule="evenodd"></path>
                    </svg>
                    <input
                        id="memory-search"
                        type="text"
                        placeholder="Search context..."
                        class="flex-1 bg-transparent outline-none text-sm py-2 text-foreground placeholder:text-muted-foreground"
                        value=""
                    />
                    <button id="close-memory-modal-btn" class="ml-2 text-muted-foreground hover:text-foreground transition-colors p-1">
                        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5">
                            <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"></path>
                        </svg>
                    </button>
                </div>

                <!-- Memory List -->
                <div id="memory-list-scroll" class="overflow-y-auto flex-1" style="height: 350px;">
                    <div id="memory-list" class="space-y-1.5 p-2">
                        <div class="flex items-center justify-center h-32 text-muted-foreground">
                            <div class="flex flex-col items-center gap-2">
                                <div class="link-preview-spinner"></div>
                                <span class="text-sm">Retrieving memories...</span>
                            </div>
                        </div>
                    </div>
                </div>
                <div class="memory-insert-float">
                    <button id="memory-insert-btn" class="memory-insert-btn inline-flex items-center justify-center rounded-full px-4 py-2 text-sm font-semibold text-foreground shadow-sm transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-primary disabled:opacity-50 disabled:pointer-events-none">
                        Insert Selected
                    </button>
                </div>
            </div>
        `;

        // Setup event listeners
        const closeBtn = this.container.querySelector('#close-memory-modal-btn');
        const insertBtn = this.container.querySelector('#memory-insert-btn');
        const searchInput = this.container.querySelector('#memory-search');

        closeBtn.addEventListener('click', () => this.close());
        insertBtn.addEventListener('click', () => this.insertSelectedMemories());

        searchInput.addEventListener('input', (e) => {
            this.searchQuery = e.target.value;
            this.renderMemories();
        });

        // Close on backdrop click
        this.container.addEventListener('click', (e) => {
            if (e.target === this.container) {
                this.close();
            }
        });

        // Close on Escape
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && this.isOpen) {
                this.close();
            }
        }, { once: true });

        document.body.appendChild(this.container);
    }

    createInlinePopup() {
        this.container = document.createElement('div');
        this.container.className = 'memory-inline-popup z-50';
        this.container.id = 'memory-inline-popup';
        this.container.style.position = 'absolute';

        this.container.innerHTML = `
            <div role="dialog" aria-modal="false" class="cursor-default relative w-full border border-border bg-background shadow-lg rounded-lg overflow-hidden flex flex-col max-h-[60vh]">
                <!-- Header with Search -->
                <div class="flex items-center border-b border-border px-3 py-2 bg-muted/30">
                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" class="w-4 h-4 text-muted-foreground mr-2 flex-shrink-0">
                        <path fill-rule="evenodd" d="M10.5 3.75a6.75 6.75 0 1 0 0 13.5 6.75 6.75 0 0 0 0-13.5ZM2.25 10.5a8.25 8.25 0 1 1 14.59 5.28l4.69 4.69a.75.75 0 1 1-1.06 1.06l-4.69-4.69A8.25 8.25 0 0 1 2.25 10.5Z" clip-rule="evenodd"></path>
                    </svg>
                    <input
                        id="memory-search"
                        type="text"
                        placeholder="Search context..."
                        class="flex-1 bg-transparent outline-none text-sm py-1 text-foreground placeholder:text-muted-foreground"
                        value=""
                    />
                    <button id="memory-expand-btn" class="ml-2 text-xs text-muted-foreground hover:text-foreground transition-colors px-2 py-1 rounded border border-border/60">
                        Open full
                    </button>
                    <button id="close-memory-modal-btn" class="ml-1 text-muted-foreground hover:text-foreground transition-colors p-1">
                        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5">
                            <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"></path>
                        </svg>
                    </button>
                </div>

                <!-- Memory List -->
                <div id="memory-list-scroll" class="overflow-y-auto flex-1" style="max-height: 320px;">
                    <div id="memory-list" class="space-y-1.5 p-2">
                        <div class="flex items-center justify-center h-24 text-muted-foreground">
                            <div class="flex flex-col items-center gap-2">
                                <div class="link-preview-spinner"></div>
                                <span class="text-sm">Retrieving context...</span>
                            </div>
                        </div>
                    </div>
                </div>
                <div class="memory-insert-float">
                    <button id="memory-insert-btn" class="memory-insert-btn inline-flex items-center justify-center rounded-full px-3 py-1.5 text-xs font-semibold text-foreground shadow-sm transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-primary disabled:opacity-50 disabled:pointer-events-none">
                        Insert Selected
                    </button>
                </div>
            </div>
        `;

        document.body.appendChild(this.container);
        this.repositionInlinePopup();
        window.addEventListener('resize', this.boundRepositionInlinePopup);
        document.addEventListener('mousedown', this.boundHandleOutsideClick, true);

        const closeBtn = this.container.querySelector('#close-memory-modal-btn');
        const insertBtn = this.container.querySelector('#memory-insert-btn');
        const searchInput = this.container.querySelector('#memory-search');
        const expandBtn = this.container.querySelector('#memory-expand-btn');

        closeBtn.addEventListener('click', () => this.close());
        insertBtn.addEventListener('click', () => this.insertSelectedMemories());

        searchInput.addEventListener('input', (e) => {
            this.searchQuery = e.target.value;
            this.renderMemories();
        });

        expandBtn.addEventListener('click', () => {
            const currentQuery = this.searchQuery;
            this.close();
            this.open(this.lastQuery, {
                mode: 'modal',
                preserveSelection: true,
                preserveSearch: true,
                forceOpen: true
            });
            this.searchQuery = currentQuery;
        });
    }

    repositionInlinePopup() {
        if (!this.container || this.mode !== 'inline') return;

        const inputCard = document.getElementById('input-card');
        if (!inputCard) return;

        const rect = inputCard.getBoundingClientRect();
        const maxWidth = Math.min(560, rect.width);
        this.container.style.width = `${maxWidth}px`;
        this.container.style.left = `${rect.left}px`;
        this.container.style.bottom = `${window.innerHeight - rect.top + 8}px`;
    }

    handleOutsideClick(event) {
        if (!this.container) return;
        const inputCard = document.getElementById('input-card');
        if (this.container.contains(event.target) || (inputCard && inputCard.contains(event.target))) {
            return;
        }
        this.close();
    }

    /**
     * Retrieve memories from the server
     * @param {string} query - Query to retrieve memories for
     */
    async retrieveMemories(query) {
        try {
            const result = await memoryRetrievalService.retrieveMemory(query, (progress) => {
                const list = this.container?.querySelector('#memory-list');
                if (list) {
                    list.innerHTML = `
                        <div class="flex items-center justify-center h-32 text-muted-foreground">
                            <div class="flex flex-col items-center gap-2">
                                <div class="link-preview-spinner"></div>
                                <span class="text-sm">${progress}</span>
                            </div>
                        </div>
                    `;
                }
            });

            // Extract memories from result (new format returns memories directly)
            if (Array.isArray(result.memories)) {
                this.memories = result.memories;
            } else {
                this.memories = [];
            }

            this.isLoading = false;
            this.renderMemories();
        } catch (error) {
            console.error('Failed to retrieve memories:', error);
            const list = this.container?.querySelector('#memory-list');
            if (list) {
                list.innerHTML = `
                    <div class="p-4 text-center text-destructive">
                        <p class="text-sm font-medium">${error.message || 'Failed to retrieve memories'}</p>
                    </div>
                `;
            }
            this.isLoading = false;
        }
    }

    /**
     * Render memories in the list, grouped by keywords
     */
    renderMemories() {
        const list = this.container?.querySelector('#memory-list');
        if (!list) return;

        if (this.memories.length === 0) {
            list.innerHTML = `
                <div class="p-4 text-center text-muted-foreground">
                    <p class="text-sm">No context found</p>
                </div>
            `;
            return;
        }

        // Filter memories by search query
        const filtered = this.memories.map((memory, originalIdx) => ({
            memory,
            originalIdx
        })).filter(({ memory }) => {
            const text = `${memory.title || ''} ${memory.summary || ''}`.toLowerCase();
            return text.includes(this.searchQuery.toLowerCase());
        });

        if (filtered.length === 0) {
            list.innerHTML = `
                <div class="p-4 text-center text-muted-foreground">
                    <p class="text-sm">No context matches your search</p>
                </div>
            `;
            return;
        }

        // Group memories by keywords
        const keywordGroups = this.groupMemoriesByKeywords(filtered);

        // Build HTML with keyword groups
        let html = '';
        for (const [keyword, items] of Object.entries(keywordGroups)) {
            if (items.length === 0) continue;

            // Only show keyword header if there are memories with this keyword
            if (keyword !== '_no_keywords_') {
                html += `
                    <div class="px-2 py-1 text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
                        ${this.escapeHtml(keyword)}
                    </div>
                `;
            }

            // Render memories in this group
            html += items.map(({ memory, originalIdx }) => {
                return this.buildMemoryItemHtml(memory, originalIdx);
            }).join('');
        }

        list.innerHTML = html;

        list.querySelectorAll('.model-option').forEach(option => {
            option.addEventListener('click', (e) => {
                const idx = parseInt(option.dataset.index);
                if (Number.isNaN(idx)) return;
                if (this.selectedIndices.has(idx)) {
                    this.selectedIndices.delete(idx);
                } else {
                    this.selectedIndices.add(idx);
                }
                this.renderMemories();
                this.updateInsertButtonState();
            });
        });

        this.updateInsertButtonState();
    }

    /**
     * Group memories by their keywords
     * Each memory appears only once under its primary (first) keyword
     * @param {Array} filtered - Filtered memories with originalIdx
     * @returns {Object} - Map of keyword to memories
     */
    groupMemoriesByKeywords(filtered) {
        const groups = {};

        for (const item of filtered) {
            const keywords = item.memory.keywords || [];
            
            if (keywords.length === 0) {
                // No keywords - add to ungrouped
                if (!groups['_no_keywords_']) {
                    groups['_no_keywords_'] = [];
                }
                groups['_no_keywords_'].push(item);
            } else {
                // Add to FIRST keyword group only (primary keyword)
                const primaryKeyword = keywords[0].toLowerCase();
                if (!groups[primaryKeyword]) {
                    groups[primaryKeyword] = [];
                }
                groups[primaryKeyword].push(item);
            }
        }

        // Sort groups: keywords with most memories first, then alphabetically
        const sorted = Object.entries(groups)
            .sort(([keyA, itemsA], [keyB, itemsB]) => {
                // Put _no_keywords_ last
                if (keyA === '_no_keywords_') return 1;
                if (keyB === '_no_keywords_') return -1;
                // Sort by count descending, then alphabetically
                if (itemsA.length !== itemsB.length) {
                    return itemsB.length - itemsA.length;
                }
                return keyA.localeCompare(keyB);
            });

        return Object.fromEntries(sorted);
    }

    /**
     * Build HTML for a single memory item
     * @param {Object} memory - Memory object
     * @param {number} originalIdx - Original index in memories array
     * @returns {string} - HTML string
     */
    buildMemoryItemHtml(memory, originalIdx) {
        const isSelected = this.selectedIndices.has(originalIdx);
        const checkmarkSlot = isSelected
            ? '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" class="w-4 h-4 text-primary flex-shrink-0"><path fill-rule="evenodd" d="M19.916 4.626a.75.75 0 0 1 .208 1.04l-9 13.5a.75.75 0 0 1-1.154.114l-6-6a.75.75 0 0 1 1.06-1.06l5.353 5.353 8.493-12.74a.75.75 0 0 1 1.04-.207Z" clip-rule="evenodd" /></svg>'
            : '<span class="w-4 h-4 flex-shrink-0"></span>';

        const bookIcon = `
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="w-4 h-4">
                <path stroke-linecap="round" stroke-linejoin="round" d="M12 6.042A8.967 8.967 0 0 0 6 3.75c-1.052 0-2.062.18-3 .512v14.25A8.987 8.987 0 0 1 6 18c2.305 0 4.408.867 6 2.292m0-14.25a8.966 8.966 0 0 1 6-2.292c1.052 0 2.062.18 3 .512v14.25A8.987 8.987 0 0 0 18 18a8.967 8.967 0 0 0-6 2.292m0-14.25v14.25" />
            </svg>
        `;

        const previewSource = memory.displayContent || memory.content || memory.summary || '';
        const previewHtml = this.getMemoryPreviewHtml(previewSource);

        return `
            <div class="model-option px-2 py-1 rounded-sm cursor-pointer transition-colors hover:bg-accent ${isSelected ? 'bg-accent' : ''}" data-index="${originalIdx}" role="option" aria-selected="${isSelected}">
                <div class="flex items-start gap-2">
                    <div class="flex items-center justify-center w-5 h-5 flex-shrink-0 rounded-full border border-border/50 bg-muted text-muted-foreground">
                        ${bookIcon}
                    </div>
                    <div class="flex-1 min-w-0">
                        <div class="font-medium text-[12px] text-foreground truncate">${this.escapeHtml(memory.title || 'Untitled')}</div>
                        <div class="memory-preview-content message-content prose prose-sm">${previewHtml}</div>
                        ${memory.timestamp ? `<div class="text-[10px] text-muted-foreground/70 mt-1">${new Date(memory.timestamp).toLocaleString()}</div>` : ''}
                    </div>
                    ${checkmarkSlot}
                </div>
            </div>
        `;
    }

    /**
     * Escape HTML special characters
     * @param {string} text - Text to escape
     * @returns {string} - Escaped text
     */
    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    /**
     * Update insert button state based on selection
     */
    updateInsertButtonState() {
        const insertBtn = this.container?.querySelector('#memory-insert-btn');
        if (insertBtn) {
            insertBtn.disabled = this.selectedIndices.size === 0;
        }
    }

    getMemoryPreviewHtml(content) {
        if (!content) return '';
        if (this.app && typeof this.app.processContentWithLatex === 'function') {
            return this.app.processContentWithLatex(content);
        }
        const safe = document.createElement('div');
        safe.textContent = content;
        return safe.innerHTML;
    }

    /**
     * Insert selected memories into the chat input (invisibly - only stores context)
     */
    insertSelectedMemories() {
        if (this.selectedIndices.size === 0) return;

        // Collect selected memories with session IDs
        const selected = Array.from(this.selectedIndices).map(idx => this.memories[idx]);
        const sessionIds = selected
            .map(m => m.session_id || m.sessionId)
            .filter(id => id);

        // Store memory metadata for the next message (invisible attachment)
        // The memory context won't be shown in the input, but will be attached to the message
        // User can see it by hovering over the sent message
        this.app.pendingMemoryContext = {
            sessionIds: sessionIds,
            memories: selected,
            timestamp: Date.now()
        };

        console.log('[MemorySelector] Set pendingMemoryContext:', this.app.pendingMemoryContext);

        // Render visual memory chips in the input area
        this.app.chatInput?.renderMemoryChips(selected);

        this.close();
        this.app.showToast?.(`Added ${this.selectedIndices.size} context item${this.selectedIndices.size === 1 ? '' : 's'}`, 'success');
    }
}
