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
                        placeholder="Search memories..."
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
                    <div id="memory-list" class="space-y-2 p-3">
                        <div class="flex items-center justify-center h-32 text-muted-foreground">
                            <div class="flex flex-col items-center gap-2">
                                <div class="link-preview-spinner"></div>
                                <span class="text-sm">Retrieving memories...</span>
                            </div>
                        </div>
                    </div>
                </div>

                <!-- Footer with Actions -->
                <div class="border-t border-border px-4 py-3 bg-muted/20 flex justify-end gap-2">
                    <button id="memory-cancel-btn" class="btn-ghost-hover inline-flex items-center justify-center rounded-md border border-border bg-background px-4 py-2 text-sm font-medium text-foreground shadow-sm transition-all duration-200 hover:shadow-sm">
                        Cancel
                    </button>
                    <button id="memory-insert-btn" class="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground shadow-sm transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-primary disabled:opacity-50 disabled:pointer-events-none">
                        Insert Selected
                    </button>
                </div>
            </div>
        `;

        // Setup event listeners
        const closeBtn = this.container.querySelector('#close-memory-modal-btn');
        const cancelBtn = this.container.querySelector('#memory-cancel-btn');
        const insertBtn = this.container.querySelector('#memory-insert-btn');
        const searchInput = this.container.querySelector('#memory-search');

        closeBtn.addEventListener('click', () => this.close());
        cancelBtn.addEventListener('click', () => this.close());
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
                        placeholder="Search memories..."
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
                                <span class="text-sm">Retrieving memories...</span>
                            </div>
                        </div>
                    </div>
                </div>

                <!-- Footer with Actions -->
                <div class="border-t border-border px-3 py-2 bg-muted/20 flex justify-end gap-2">
                    <button id="memory-insert-btn" class="inline-flex items-center justify-center rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground shadow-sm transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-primary disabled:opacity-50 disabled:pointer-events-none">
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
     * Render memories in the list
     */
    renderMemories() {
        const list = this.container?.querySelector('#memory-list');
        if (!list) return;

        if (this.memories.length === 0) {
            list.innerHTML = `
                <div class="p-4 text-center text-muted-foreground">
                    <p class="text-sm">No memories found</p>
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
                    <p class="text-sm">No memories match your search</p>
                </div>
            `;
            return;
        }

        list.innerHTML = filtered.map(({ memory, originalIdx }) => {
            const isSelected = this.selectedIndices.has(originalIdx);
            const checkmarkSlot = isSelected
                ? '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" class="w-4 h-4 text-primary flex-shrink-0"><path fill-rule="evenodd" d="M19.916 4.626a.75.75 0 0 1 .208 1.04l-9 13.5a.75.75 0 0 1-1.154.114l-6-6a.75.75 0 0 1 1.06-1.06l5.353 5.353 8.493-12.74a.75.75 0 0 1 1.04-.207Z" clip-rule="evenodd" /></svg>'
                : '<span class="w-4 h-4 flex-shrink-0"></span>';

            return `
                <div class="model-option px-2 py-1.5 rounded-sm cursor-pointer transition-colors hover:bg-accent ${isSelected ? 'bg-accent' : ''}" data-index="${originalIdx}" role="option" aria-selected="${isSelected}">
                    <div class="flex items-start gap-2">
                        <div class="flex items-center justify-center w-6 h-6 flex-shrink-0 rounded-full border border-border/50 bg-muted text-muted-foreground">
                            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" class="w-3.5 h-3.5">
                                <path d="M3.75 4.5a.75.75 0 0 1 .75-.75h11.5a2.5 2.5 0 0 1 2.5 2.5v10.5a.75.75 0 0 1-1.5 0V6.25a1 1 0 0 0-1-1H4.5a.75.75 0 0 1-.75-.75Z" />
                                <path d="M5.25 6A2.25 2.25 0 0 1 7.5 3.75h8.25A2.25 2.25 0 0 1 18 6v12A2.25 2.25 0 0 1 15.75 20.25H7.5A2.25 2.25 0 0 1 5.25 18V6Z" />
                            </svg>
                        </div>
                        <div class="flex-1 min-w-0">
                            <div class="font-medium text-sm text-foreground truncate">${memory.title || 'Untitled'}</div>
                            <div class="text-xs text-muted-foreground line-clamp-3">${memory.displayContent || memory.content || memory.summary || ''}</div>
                            ${memory.timestamp ? `<div class="text-[10px] text-muted-foreground/70 mt-1">${new Date(memory.timestamp).toLocaleString()}</div>` : ''}
                        </div>
                        ${checkmarkSlot}
                    </div>
                </div>
            `;
        }).join('');

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

        // Store memory metadata for the next message
        this.app.pendingMemoryContext = {
            sessionIds: sessionIds,
            memories: selected,
            timestamp: Date.now()
        };

        console.log('[MemorySelector] Set pendingMemoryContext:', this.app.pendingMemoryContext);

        // Insert @memory_N markers into the textarea
        const input = this.app.elements?.messageInput;
        if (input) {
            // Remove any existing @ that triggered the memory selector
            let currentText = input.value;
            const lastAtIndex = currentText.lastIndexOf('@');
            if (lastAtIndex >= 0 && lastAtIndex === currentText.length - 1) {
                // Remove trailing @
                currentText = currentText.substring(0, lastAtIndex);
            }
            
            const cursorPos = currentText.length;
            
            // Generate @memory_1 @memory_2 etc.
            const memoryMarkers = selected.map((_, idx) => `@memory_${idx + 1}`).join(' ');
            const needsSpace = currentText && !currentText.endsWith(' ');
            const newText = currentText + (needsSpace ? ' ' : '') + memoryMarkers + ' ';
            
            input.value = newText;
            
            // Update cursor position to end
            const newCursorPos = newText.length;
            input.selectionStart = newCursorPos;
            input.selectionEnd = newCursorPos;
            
            // Trigger input event to update height and render chips
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.focus();
        }

        // Render visual memory chips as overlay
        this.app.chatInput?.renderMemoryChips(selected);

        this.close();
        this.app.showToast?.(`Attached ${this.selectedIndices.size} memor${this.selectedIndices.size === 1 ? 'y' : 'ies'}`, 'success');
    }
}
