/**
 * Memory Selector Component
 * Modal for selecting and retrieving memories from the event store
 * Triggered with @ or Ctrl+Ctrl
 */

import { memoryRetrievalService } from '../services/memoryRetrievalService.js';

export default class MemorySelector {
    constructor(app) {
        this.app = app;
        this.modal = null;
        this.isOpen = false;
        this.isLoading = false;
        this.memories = [];
        this.selectedIndices = new Set();
        this.searchQuery = '';
    }

    /**
     * Open the memory selector modal and start retrieval
     * @param {string} query - Optional query to retrieve memories for
     */
    async open(query = '') {
        if (this.isOpen) {
            this.close();
            return;
        }

        this.isOpen = true;
        this.searchQuery = ''; // Empty search filter initially
        this.selectedIndices.clear();
        this.memories = [];
        this.isLoading = true;

        // Create modal HTML
        this.createModal();
        document.body.appendChild(this.modal);

        // Start retrieval immediately with the provided query
        await this.retrieveMemories(query);
    }

    close() {
        if (this.modal) {
            this.modal.remove();
        }
        this.isOpen = false;
        this.isLoading = false;
    }

    createModal() {
        this.modal = document.createElement('div');
        this.modal.className = 'fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4';
        this.modal.id = 'memory-selector-modal';

        this.modal.innerHTML = `
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
        const closeBtn = this.modal.querySelector('#close-memory-modal-btn');
        const cancelBtn = this.modal.querySelector('#memory-cancel-btn');
        const insertBtn = this.modal.querySelector('#memory-insert-btn');
        const searchInput = this.modal.querySelector('#memory-search');

        closeBtn.addEventListener('click', () => this.close());
        cancelBtn.addEventListener('click', () => this.close());
        insertBtn.addEventListener('click', () => this.insertSelectedMemories());

        searchInput.addEventListener('input', (e) => {
            this.searchQuery = e.target.value;
            this.renderMemories();
        });

        // Close on backdrop click
        this.modal.addEventListener('click', (e) => {
            if (e.target === this.modal) {
                this.close();
            }
        });

        // Close on Escape
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && this.isOpen) {
                this.close();
            }
        }, { once: true });
    }

    /**
     * Retrieve memories from the server
     * @param {string} query - Query to retrieve memories for
     */
    async retrieveMemories(query) {
        try {
            const result = await memoryRetrievalService.retrieveMemory(query, (progress) => {
                const list = this.modal?.querySelector('#memory-list');
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
            const list = this.modal?.querySelector('#memory-list');
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
        const list = this.modal?.querySelector('#memory-list');
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

        list.innerHTML = filtered.map(({ memory, originalIdx }) => `
            <div class="flex items-start gap-2 p-2 rounded-lg border border-border/50 bg-muted/20 hover:bg-muted/40 transition-colors">
                <input 
                    type="checkbox" 
                    class="memory-checkbox mt-1 rounded border-border cursor-pointer"
                    data-index="${originalIdx}"
                    ${this.selectedIndices.has(originalIdx) ? 'checked' : ''}
                />
                <div class="flex-1 min-w-0">
                    <p class="text-sm font-medium text-foreground truncate">${memory.title || 'Untitled'}</p>
                    <p class="text-xs text-muted-foreground line-clamp-3">${memory.displayContent || memory.content || memory.summary || ''}</p>
                    ${memory.timestamp ? `<p class="text-xs text-muted-foreground/70 mt-1">${new Date(memory.timestamp).toLocaleString()}</p>` : ''}
                </div>
            </div>
        `).join('');

        // Setup checkbox listeners
        list.querySelectorAll('.memory-checkbox').forEach(checkbox => {
            checkbox.addEventListener('change', (e) => {
                const idx = parseInt(e.target.dataset.index);
                if (e.target.checked) {
                    this.selectedIndices.add(idx);
                } else {
                    this.selectedIndices.delete(idx);
                }
                this.updateInsertButtonState();
            });
        });
    }

    /**
     * Update insert button state based on selection
     */
    updateInsertButtonState() {
        const insertBtn = this.modal?.querySelector('#memory-insert-btn');
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

        // Store memory metadata for the next message (invisible attachment)
        // The memory context won't be shown in the input, but will be attached to the message
        // User can see it by hovering over the sent message
        this.app.pendingMemoryContext = {
            sessionIds: sessionIds,
            memories: selected,
            timestamp: Date.now()
        };

        console.log('[MemorySelector] Set pendingMemoryContext:', this.app.pendingMemoryContext);

        this.close();
        this.app.showToast?.(`Attached ${this.selectedIndices.size} memor${this.selectedIndices.size === 1 ? 'y' : 'ies'}`, 'success');
    }
}
