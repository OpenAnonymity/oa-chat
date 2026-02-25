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
        this.isCreatingFolder = false;
        this.newFilePath = '';
        this.newFolderName = '';
        this.openDirMenu = null;       // which dir has its 3-dot menu open
        this.renamingDir = null;        // which dir is being renamed inline
        this.renamingDirValue = '';
    }

    async open() {
        if (this.isOpen || !this.overlay) return;
        this.isOpen = true;
        this.returnFocusEl = document.activeElement;
        this.isCreatingFile = false;
        this.isCreatingFolder = false;
        this.newFilePath = '';
        this.newFolderName = '';

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
                    <button id="memory-new-folder-btn" class="text-xs px-2.5 py-1 rounded-md border border-border text-muted-foreground hover:text-foreground hover:bg-accent transition-colors">
                        New Folder
                    </button>
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
                ? '<svg class="w-3 h-3 text-muted-foreground flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M19 9l-7 7-7-7"></path></svg>'
                : '<svg class="w-3 h-3 text-muted-foreground flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7"></path></svg>';
            const isMenuOpen = this.openDirMenu === dir;
            const isRenaming = this.renamingDir === dir;

            if (isRenaming) {
                treeHtml += `
                    <div class="flex items-center gap-1.5 px-2 py-1">
                        ${chevron}
                        <input id="memory-rename-dir-input" type="text" value="${this._escapeHtml(this.renamingDirValue)}"
                            class="flex-1 min-w-0 text-sm px-1 py-0 rounded border border-border bg-background text-foreground font-medium focus:outline-none focus:ring-1 focus:ring-ring" />
                    </div>
                `;
            } else {
                treeHtml += `
                    <div class="group memory-dir-row flex items-center px-2 py-1 hover:bg-accent rounded text-sm text-foreground" data-dir="${this._escapeHtml(dir)}">
                        <div class="memory-dir-toggle flex items-center gap-1.5 flex-1 min-w-0 cursor-pointer" data-dir="${this._escapeHtml(dir)}">
                            ${chevron}
                            <span class="font-medium truncate">${this._escapeHtml(dir)}/</span>
                        </div>
                        <button class="memory-dir-menu-btn opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-background/50 text-muted-foreground flex-shrink-0" data-dir="${this._escapeHtml(dir)}">
                            <svg class="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 20 20"><path d="M10 6a2 2 0 110-4 2 2 0 010 4zm0 6a2 2 0 110-4 2 2 0 010 4zm0 6a2 2 0 110-4 2 2 0 010 4z"></path></svg>
                        </button>
                    </div>
                `;
                if (isMenuOpen) {
                    treeHtml += `
                        <div class="memory-dir-context-menu ml-6 mr-2 mb-1 rounded border border-border bg-background shadow-lg overflow-hidden" data-dir="${this._escapeHtml(dir)}">
                            <button class="memory-dir-rename-btn w-full text-left text-xs px-3 py-1.5 hover:bg-accent text-foreground" data-dir="${this._escapeHtml(dir)}">Rename</button>
                            <button class="memory-dir-delete-btn w-full text-left text-xs px-3 py-1.5 hover:bg-accent text-red-500" data-dir="${this._escapeHtml(dir)}">Delete</button>
                        </div>
                    `;
                }
            }

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

        // New folder input
        if (this.isCreatingFolder) {
            treeHtml += `
                <div class="px-2 py-1">
                    <input id="memory-new-folder-input" type="text" placeholder="folder-name" value="${this._escapeHtml(this.newFolderName)}"
                        class="w-full text-xs px-2 py-1 rounded border border-border bg-background text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring" />
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

        if (this.files.length === 0 && !this.isCreatingFile && !this.isCreatingFolder) {
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

        // Dismiss dir menu when clicking outside it
        this.overlay.querySelector('[role="dialog"]')?.addEventListener('click', (e) => {
            if (this.openDirMenu && !e.target.closest('.memory-dir-menu-btn') && !e.target.closest('.memory-dir-context-menu')) {
                this.openDirMenu = null;
                this.render();
            }
        });

        // Close button
        const closeBtn = this.overlay.querySelector('#memory-close-btn');
        if (closeBtn) closeBtn.onclick = () => this.close();

        // New folder button
        const newFolderBtn = this.overlay.querySelector('#memory-new-folder-btn');
        if (newFolderBtn) newFolderBtn.onclick = () => this._startNewFolder();

        // New file button
        const newBtn = this.overlay.querySelector('#memory-new-file-btn');
        if (newBtn) newBtn.onclick = () => this._startNewFile();

        // New folder input
        const newFolderInput = this.overlay.querySelector('#memory-new-folder-input');
        if (newFolderInput) {
            newFolderInput.focus();
            newFolderInput.onkeydown = (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    this._createNewFolder(newFolderInput.value.trim());
                } else if (e.key === 'Escape') {
                    this.isCreatingFolder = false;
                    this.render();
                }
            };
        }

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

        // Directory toggles (expand/collapse)
        this.overlay.querySelectorAll('.memory-dir-toggle').forEach(el => {
            el.onclick = (e) => {
                e.stopPropagation();
                const dir = el.dataset.dir;
                this.openDirMenu = null;
                if (this.expandedDirs.has(dir)) {
                    this.expandedDirs.delete(dir);
                } else {
                    this.expandedDirs.add(dir);
                }
                this.render();
            };
        });

        // Directory three-dot menu buttons
        this.overlay.querySelectorAll('.memory-dir-menu-btn').forEach(el => {
            el.onclick = (e) => {
                e.stopPropagation();
                const dir = el.dataset.dir;
                this.openDirMenu = this.openDirMenu === dir ? null : dir;
                this.render();
            };
        });

        // Directory rename buttons
        this.overlay.querySelectorAll('.memory-dir-rename-btn').forEach(el => {
            el.onclick = (e) => {
                e.stopPropagation();
                const dir = el.dataset.dir;
                this.openDirMenu = null;
                this.renamingDir = dir;
                this.renamingDirValue = dir;
                this.render();
            };
        });

        // Directory delete buttons
        this.overlay.querySelectorAll('.memory-dir-delete-btn').forEach(el => {
            el.onclick = (e) => {
                e.stopPropagation();
                const dir = el.dataset.dir;
                this.openDirMenu = null;
                this._deleteFolder(dir);
            };
        });

        // Rename dir input
        const renameDirInput = this.overlay.querySelector('#memory-rename-dir-input');
        if (renameDirInput) {
            renameDirInput.focus();
            renameDirInput.select();
            renameDirInput.onkeydown = (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    this._renameFolder(this.renamingDir, renameDirInput.value.trim());
                } else if (e.key === 'Escape') {
                    this.renamingDir = null;
                    this.render();
                }
            };
            renameDirInput.onblur = () => {
                // Commit on blur if value changed
                if (this.renamingDir) {
                    const val = renameDirInput.value.trim();
                    if (val && val !== this.renamingDir) {
                        this._renameFolder(this.renamingDir, val);
                    } else {
                        this.renamingDir = null;
                        this.render();
                    }
                }
            };
        }

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

    _startNewFolder() {
        this.isCreatingFolder = true;
        this.isCreatingFile = false;
        this.newFolderName = '';
        this.render();
    }

    async _createNewFolder(name) {
        if (!name) return;
        // Sanitize: no slashes, no .md extension
        name = name.replace(/[\/\\]/g, '').replace(/\.md$/i, '');
        if (!name) return;

        this.isCreatingFolder = false;
        this.expandedDirs.add(name);
        // Pre-fill new file creation inside this folder
        this.isCreatingFile = true;
        this.newFilePath = name + '/';
        this.render();
    }

    _startNewFile() {
        this.isCreatingFile = true;
        this.isCreatingFolder = false;
        this.newFilePath = '';
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

    async _deleteFolder(dir) {
        if (!dir) return;
        const prefix = dir + '/';
        const toDelete = this.files.filter(f => f.path.startsWith(prefix));
        for (const f of toDelete) {
            await memoryFileSystem.delete(f.path);
        }
        // Clear selection if it was inside this folder
        if (this.selectedPath?.startsWith(prefix)) {
            this.selectedPath = null;
            this.editorContent = '';
            this.isDirty = false;
        }
        this.expandedDirs.delete(dir);
        await this._loadFileTree();
        this.render();
        this.app?.showToast?.(`Folder "${dir}" deleted`, 'success');
    }

    async _renameFolder(oldDir, newDir) {
        this.renamingDir = null;
        if (!oldDir || !newDir || oldDir === newDir) {
            this.render();
            return;
        }
        // Sanitize
        newDir = newDir.replace(/[\/\\]/g, '');
        if (!newDir) { this.render(); return; }

        const prefix = oldDir + '/';
        const filesToMove = this.files.filter(f => f.path.startsWith(prefix));
        for (const f of filesToMove) {
            const content = await memoryFileSystem.read(f.path);
            const newPath = newDir + '/' + f.path.slice(prefix.length);
            await memoryFileSystem.write(newPath, content || '');
            await memoryFileSystem.delete(f.path);
        }
        // Update selection if it was inside old folder
        if (this.selectedPath?.startsWith(prefix)) {
            this.selectedPath = newDir + '/' + this.selectedPath.slice(prefix.length);
            this.editorContent = await memoryFileSystem.read(this.selectedPath) || '';
        }
        this.expandedDirs.delete(oldDir);
        this.expandedDirs.add(newDir);
        await this._loadFileTree();
        this.render();
        this.app?.showToast?.(`Folder renamed to "${newDir}"`, 'success');
    }

    // ─── Helpers ─────────────────────────────────────────────────

    _escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text || '';
        return div.innerHTML;
    }
}

export default MemoryEditor;
