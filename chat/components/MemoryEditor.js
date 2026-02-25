/**
 * MemoryEditor — Modal UI for browsing and editing memory files.
 *
 * File tree on left, markdown editor on right.
 * Follows AccountModal pattern: innerHTML + event delegation.
 */
import memoryFileSystem from '../services/memoryFileSystem.js';

const MODAL_CLASSES = 'w-full max-w-xl rounded-xl border border-border bg-background shadow-2xl mx-4 flex flex-col overflow-hidden';

class MemoryEditor {
    constructor(app) {
        this.app = app;
        this.isOpen = false;
        this.overlay = document.getElementById('memory-editor-modal');

        // State
        this.files = [];
        this.selectedPath = null;
        this.editorContent = '';
        this.isDirty = false;
        this.expandedDirs = new Set(['personal', 'projects']);

        // UI state
        this.returnFocusEl = null;
        this.escapeHandler = null;
        this.isCreatingFile = false;
        this.newFilePath = '';
    }

    async open() {
        if (this.isOpen || !this.overlay) return;
        this.isOpen = true;
        this.returnFocusEl = document.activeElement;
        this.isCreatingFile = false;
        this.newFilePath = '';

        await memoryFileSystem.init();
        await this._loadFileTree();

        this.render();
        this.overlay.classList.remove('hidden');

        this.overlay.onclick = (e) => {
            if (e.target === this.overlay) this.close();
        };
        this.escapeHandler = (e) => {
            if (e.key === 'Escape') this.close();
        };
        document.addEventListener('keydown', this.escapeHandler);
    }

    close() {
        if (!this.isOpen || !this.overlay) return;
        this.isOpen = false;
        this.overlay.classList.add('hidden');
        this.overlay.innerHTML = '';
        this.selectedPath = null;
        this.isDirty = false;

        if (this.escapeHandler) {
            document.removeEventListener('keydown', this.escapeHandler);
            this.escapeHandler = null;
        }
        if (this.returnFocusEl?.focus) this.returnFocusEl.focus();
        this.returnFocusEl = null;
    }

    async _loadFileTree() {
        const all = await memoryFileSystem.exportAll();
        this.files = all
            .filter(f => !f.path.endsWith('_index.md'))
            .map(f => ({ path: f.path, l0: f.l0 }))
            .sort((a, b) => a.path.localeCompare(b.path));
    }

    _getDirectoryStructure() {
        const dirs = {};
        const rootFiles = [];

        for (const file of this.files) {
            const slashIdx = file.path.indexOf('/');
            if (slashIdx === -1) {
                rootFiles.push(file);
            } else {
                const dir = file.path.slice(0, slashIdx);
                if (!dirs[dir]) dirs[dir] = [];
                dirs[dir].push(file);
            }
        }

        return { dirs, rootFiles };
    }

    // ─── Rendering ───────────────────────────────────────────────

    render() {
        if (!this.overlay) return;
        this.overlay.innerHTML = this._renderModal();
        this._attachEventListeners();
    }

    _renderModal() {
        return `
            <div role="dialog" aria-modal="true" class="${MODAL_CLASSES}" style="height: 92vh">
                ${this._renderHeader()}
                <div class="flex flex-1 min-h-0">
                    ${this._renderFileTree()}
                    ${this._renderEditor()}
                </div>
            </div>
        `;
    }

    _renderHeader() {
        return `
            <div class="flex items-center justify-between px-4 py-3 border-b border-border flex-shrink-0">
                <h3 class="text-base font-medium text-foreground">Memory</h3>
                <div class="flex items-center gap-2">
                    <button id="memory-new-file-btn" class="text-xs px-2.5 py-1 rounded-md border border-border text-muted-foreground hover:text-foreground hover:bg-accent transition-colors">
                        New File
                    </button>
                    <button id="memory-close-btn" class="text-muted-foreground hover:text-foreground transition-colors p-1 -mr-1 rounded-lg hover:bg-accent" aria-label="Close">
                        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5">
                            <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"></path>
                        </svg>
                    </button>
                </div>
            </div>
        `;
    }

    _renderFileTree() {
        const { dirs, rootFiles } = this._getDirectoryStructure();
        const sortedDirs = Object.keys(dirs).sort();

        let treeHtml = '';

        // Directories
        for (const dir of sortedDirs) {
            const isExpanded = this.expandedDirs.has(dir);
            const chevron = isExpanded
                ? '<svg class="w-3 h-3 text-muted-foreground" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M19 9l-7 7-7-7"></path></svg>'
                : '<svg class="w-3 h-3 text-muted-foreground" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7"></path></svg>';

            treeHtml += `
                <div class="memory-dir-toggle flex items-center gap-1.5 px-2 py-1 cursor-pointer hover:bg-accent rounded text-sm text-foreground" data-dir="${this._escapeHtml(dir)}">
                    ${chevron}
                    <span class="font-medium">${this._escapeHtml(dir)}/</span>
                </div>
            `;

            if (isExpanded) {
                for (const file of dirs[dir]) {
                    const fileName = file.path.slice(dir.length + 1);
                    const isSelected = file.path === this.selectedPath;
                    treeHtml += `
                        <div class="memory-file-item flex items-center gap-1.5 pl-6 pr-2 py-1 cursor-pointer rounded text-sm truncate ${isSelected ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-accent hover:text-foreground'}" data-path="${this._escapeHtml(file.path)}" title="${this._escapeHtml(file.l0)}">
                            <svg class="w-3 h-3 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z"></path></svg>
                            <span class="truncate">${this._escapeHtml(fileName)}</span>
                        </div>
                    `;
                }
            }
        }

        // Root-level files
        for (const file of rootFiles) {
            const isSelected = file.path === this.selectedPath;
            treeHtml += `
                <div class="memory-file-item flex items-center gap-1.5 px-2 py-1 cursor-pointer rounded text-sm truncate ${isSelected ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-accent hover:text-foreground'}" data-path="${this._escapeHtml(file.path)}" title="${this._escapeHtml(file.l0)}">
                    <svg class="w-3 h-3 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z"></path></svg>
                    <span class="truncate">${this._escapeHtml(file.path)}</span>
                </div>
            `;
        }

        // New file input
        if (this.isCreatingFile) {
            treeHtml += `
                <div class="px-2 py-1">
                    <input id="memory-new-file-input" type="text" placeholder="path/file.md" value="${this._escapeHtml(this.newFilePath)}"
                        class="w-full text-xs px-2 py-1 rounded border border-border bg-background text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring" />
                </div>
            `;
        }

        if (this.files.length === 0 && !this.isCreatingFile) {
            treeHtml = '<div class="px-2 py-4 text-xs text-muted-foreground text-center">No memory files yet</div>';
        }

        return `
            <div class="w-48 flex-shrink-0 border-r border-border overflow-y-auto p-2">
                ${treeHtml}
            </div>
        `;
    }

    _renderEditor() {
        if (!this.selectedPath) {
            return `
                <div class="flex-1 flex items-center justify-center text-sm text-muted-foreground p-4">
                    Select a file to edit, or create a new one.
                </div>
            `;
        }

        const isIndex = this.selectedPath.endsWith('_index.md');

        return `
            <div class="flex-1 flex flex-col min-w-0">
                <div class="flex items-center justify-between px-3 py-2 border-b border-border flex-shrink-0">
                    <span class="text-xs text-muted-foreground font-mono truncate">${this._escapeHtml(this.selectedPath)}</span>
                    <div class="flex items-center gap-2 flex-shrink-0">
                        ${this.isDirty ? '<span class="text-xs text-amber-500">Unsaved</span>' : ''}
                        <button id="memory-save-btn" class="text-xs px-2 py-0.5 rounded border border-border text-muted-foreground hover:text-foreground hover:bg-accent transition-colors ${this.isDirty ? '' : 'opacity-50 cursor-default'}">
                            Save
                        </button>
                        ${!isIndex ? `
                            <button id="memory-delete-btn" class="text-xs px-2 py-0.5 rounded border border-red-500/30 text-red-500 hover:bg-red-500/10 transition-colors">
                                Delete
                            </button>
                        ` : ''}
                    </div>
                </div>
                <textarea id="memory-editor-textarea"
                    class="flex-1 w-full p-3 text-sm font-mono bg-background text-foreground resize-none focus:outline-none"
                    spellcheck="false"
                    ${isIndex ? 'readonly' : ''}
                >${this._escapeHtml(this.editorContent)}</textarea>
            </div>
        `;
    }

    // ─── Event Handling ──────────────────────────────────────────

    _attachEventListeners() {
        if (!this.overlay) return;

        // Close button
        const closeBtn = this.overlay.querySelector('#memory-close-btn');
        if (closeBtn) closeBtn.onclick = () => this.close();

        // New file button
        const newBtn = this.overlay.querySelector('#memory-new-file-btn');
        if (newBtn) newBtn.onclick = () => this._startNewFile();

        // New file input
        const newInput = this.overlay.querySelector('#memory-new-file-input');
        if (newInput) {
            newInput.focus();
            newInput.onkeydown = (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    this._createNewFile(newInput.value.trim());
                } else if (e.key === 'Escape') {
                    this.isCreatingFile = false;
                    this.render();
                }
            };
        }

        // Directory toggles
        this.overlay.querySelectorAll('.memory-dir-toggle').forEach(el => {
            el.onclick = () => {
                const dir = el.dataset.dir;
                if (this.expandedDirs.has(dir)) {
                    this.expandedDirs.delete(dir);
                } else {
                    this.expandedDirs.add(dir);
                }
                this.render();
            };
        });

        // File selection
        this.overlay.querySelectorAll('.memory-file-item').forEach(el => {
            el.onclick = () => this._selectFile(el.dataset.path);
        });

        // Save button
        const saveBtn = this.overlay.querySelector('#memory-save-btn');
        if (saveBtn) saveBtn.onclick = () => this._saveFile();

        // Delete button
        const deleteBtn = this.overlay.querySelector('#memory-delete-btn');
        if (deleteBtn) deleteBtn.onclick = () => this._deleteFile();

        // Textarea change tracking
        const textarea = this.overlay.querySelector('#memory-editor-textarea');
        if (textarea) {
            textarea.oninput = () => {
                this.editorContent = textarea.value;
                this.isDirty = true;
                // Update unsaved indicator without full re-render
                const indicator = this.overlay.querySelector('#memory-save-btn');
                if (indicator) {
                    indicator.classList.remove('opacity-50', 'cursor-default');
                }
                const unsavedLabel = indicator?.previousElementSibling;
                if (unsavedLabel && !unsavedLabel.classList.contains('text-amber-500')) {
                    // Will show on next full render
                }
            };
            // Ctrl/Cmd+S to save
            textarea.onkeydown = (e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === 's') {
                    e.preventDefault();
                    e.stopPropagation();
                    this._saveFile();
                }
            };
        }
    }

    // ─── Actions ─────────────────────────────────────────────────

    async _selectFile(path) {
        if (!path) return;
        this.selectedPath = path;
        this.editorContent = await memoryFileSystem.read(path) || '';
        this.isDirty = false;
        this.render();
    }

    _startNewFile() {
        this.isCreatingFile = true;
        this.newFilePath = 'personal/';
        this.render();
    }

    async _createNewFile(path) {
        if (!path) return;
        if (!path.endsWith('.md')) path += '.md';

        this.isCreatingFile = false;
        await memoryFileSystem.write(path, `# ${path.split('/').pop().replace('.md', '')}\n\n`);
        await this._loadFileTree();

        // Expand parent directory
        const slashIdx = path.indexOf('/');
        if (slashIdx !== -1) {
            this.expandedDirs.add(path.slice(0, slashIdx));
        }

        this.selectedPath = path;
        this.editorContent = await memoryFileSystem.read(path) || '';
        this.isDirty = false;
        this.render();
    }

    async _saveFile() {
        if (!this.selectedPath || !this.isDirty) return;
        await memoryFileSystem.write(this.selectedPath, this.editorContent);
        this.isDirty = false;
        await this._loadFileTree();
        this.render();
        this.app?.showToast?.('Memory file saved', 'success');
    }

    async _deleteFile() {
        if (!this.selectedPath || this.selectedPath.endsWith('_index.md')) return;

        await memoryFileSystem.delete(this.selectedPath);
        this.selectedPath = null;
        this.editorContent = '';
        this.isDirty = false;
        await this._loadFileTree();
        this.render();
        this.app?.showToast?.('Memory file deleted', 'success');
    }

    // ─── Helpers ─────────────────────────────────────────────────

    _escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text || '';
        return div.innerHTML;
    }
}

export default MemoryEditor;
