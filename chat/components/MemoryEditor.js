/**
 * MemoryEditor — Modal UI for browsing and editing memory files.
 *
 * The shell intentionally matches memory-chat's memory filesystem panel while
 * staying backed by the root app's nanomem storage adapter.
 */
import memoryFileSystem from '../services/memoryInstances.js';
import ticketClient from '../services/ticketClient.js';
import { chatDB } from '../db.js';
import { exportMemoriesAsOmf } from '../services/omfExporter.js';
import { readOmfFile, validateOmf, previewOmfImport, importOmf } from '../services/omfImporter.js';
import { normalizeMessagesForMemory } from '../services/memoryMessageNormalization.js';
import {
    ensureMemoryKey,
    importData as importMemoryData,
    invalidateMemoryKey,
    isMemoryAuthError
} from '../services/memoryBridge.js';

class MemoryEditor {
    constructor(app) {
        this.app = app;
        this.isOpen = false;
        this.overlay = document.getElementById('memory-editor-modal');

        this.files = [];
        this.selectedPath = null;
        this.editorContent = '';
        this.isDirty = false;
        this.isEditing = false;
        this.expandedDirs = new Set(['personal', 'projects']);

        this.returnFocusEl = null;
        this.escapeHandler = null;
        this.isCreatingFile = false;
        this.isCreatingFolder = false;
        this.newFilePath = '';
        this.newFolderName = '';
        this.openDirMenu = null;
        this.renamingDir = null;
        this.renamingDirValue = '';
        // Tracks the folder the user is "in" — set on expand or file-select,
        // cleared on collapse-of-focused / root-file-select / blank sidebar click.
        // Used by New File to decide insertion target and by the sidebar to
        // render an accent stripe on the active folder.
        this.focusedDir = null;

        this.importState = null;
        this.importPreview = null;
        this.importDoc = null;
        this.importResult = null;

        this.backfillState = null;
        this.backfillProgress = this._getInitialBackfillProgress();
        this.backfillAbortController = null;
    }

    async openToFile(path) {
        if (!path) return;
        const dir = path.indexOf('/') !== -1 ? path.slice(0, path.indexOf('/')) : null;
        if (dir) this.expandedDirs.add(dir);
        await this.open();
        await this._selectFile(path);
    }

    async open() {
        if (this.isOpen || !this.overlay) return;
        this.isOpen = true;
        this.returnFocusEl = document.activeElement;
        this.isCreatingFile = false;
        this.isCreatingFolder = false;
        this.newFilePath = '';
        this.newFolderName = '';
        this.focusedDir = null;
        this.importState = null;
        this.importPreview = null;
        this.importDoc = null;
        this.importResult = null;

        await memoryFileSystem.init();
        await this._loadFileTree();

        this.render();
        this.overlay.classList.remove('hidden');

        this.overlay.onclick = (event) => {
            if (event.target === this.overlay) {
                this.close();
            }
        };
        this.escapeHandler = (event) => {
            if (event.key === 'Escape') {
                this.close();
            }
        };
        document.addEventListener('keydown', this.escapeHandler);
    }

    close() {
        if (!this.isOpen || !this.overlay) return;
        const keepBackfillRunning = this._isBackfillActive();
        this.isOpen = false;
        this.overlay.classList.add('hidden');
        this.overlay.innerHTML = '';
        this.selectedPath = null;
        this.editorContent = '';
        this.isDirty = false;
        this.isEditing = false;
        this.focusedDir = null;
        this.isCreatingFile = false;
        this.isCreatingFolder = false;
        this.importState = null;
        this.importPreview = null;
        this.importDoc = null;
        this.importResult = null;
        if (!keepBackfillRunning) {
            this.backfillState = null;
            this.backfillProgress = this._getInitialBackfillProgress();
            this.backfillAbortController = null;
        }

        if (this.escapeHandler) {
            document.removeEventListener('keydown', this.escapeHandler);
            this.escapeHandler = null;
        }
        if (this.returnFocusEl?.focus) {
            this.returnFocusEl.focus();
        }
        this.returnFocusEl = null;

        if (keepBackfillRunning) {
            this.app?.showToast?.('Backfill continues in background.', 'info', 3000);
        }
    }

    async _loadFileTree() {
        const all = await memoryFileSystem.exportAll();
        this.files = all
            .filter((file) => !file.path.endsWith('_tree.md'))
            .map((file) => ({ path: file.path, l0: file.l0 || file.oneLiner || '' }))
            .sort((a, b) => a.path.localeCompare(b.path));
        // Mirror tree changes into the right-panel Memory section so highlighted
        // files / new files appear without needing a session switch.
        this.app?.rightPanel?.refreshMemorySection?.({ reloadFiles: true })?.catch?.(() => {});
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
                if (!dirs[dir]) {
                    dirs[dir] = [];
                }
                dirs[dir].push(file);
            }
        }

        return { dirs, rootFiles };
    }

    render() {
        if (!this.overlay) return;
        this.overlay.innerHTML = this._renderModal();
        this._attachEventListeners();
    }

    _renderModal() {
        return `
            <div role="dialog" aria-modal="true"
                 class="memory-editor-dialog border rounded-2xl w-full mx-4 overflow-hidden flex flex-col"
                 style="max-width: 760px; height: min(88vh, 780px)">
                ${this._renderHeader()}
                ${this.importState ? this._renderImportProgress() : ''}
                <div class="flex flex-1 min-h-0">
                    ${this._renderSidebar()}
                    <div id="memory-editor-pane" class="flex-1 flex flex-col min-w-0">
                        ${this._renderEditorContent()}
                    </div>
                </div>
            </div>
        `;
    }

    _renderHeader() {
        const fileCount = this.files.length;
        const backfillButtonState = this._getBackfillButtonState();
        return `
            <div class="flex items-center justify-between px-3 py-1.5 shrink-0" style="border-bottom: 1px solid var(--mem-divider)">
                <div class="flex items-center gap-2">
                    <div class="flex h-6 w-6 items-center justify-center rounded-md" style="background: hsl(var(--color-muted) / 0.3)">
                        <svg class="w-3 h-3 text-muted-foreground" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5">
                            <path stroke-linecap="round" stroke-linejoin="round" d="M20.25 6.375c0 2.278-3.694 4.125-8.25 4.125S3.75 8.653 3.75 6.375m16.5 0c0-2.278-3.694-4.125-8.25-4.125S3.75 4.097 3.75 6.375m16.5 0v11.25c0 2.278-3.694 4.125-8.25 4.125s-8.25-1.847-8.25-4.125V6.375m16.5 0v3.75m-16.5-3.75v3.75m16.5 0v3.75C20.25 16.153 16.556 18 12 18s-8.25-1.847-8.25-4.125v-3.75m16.5 0c0 2.278-3.694 4.125-8.25 4.125s-8.25-1.847-8.25-4.125" />
                        </svg>
                    </div>
                    <h2 class="text-sm font-semibold text-foreground">Memory</h2>
                    ${fileCount > 0 ? `<span class="text-[11px] text-muted-foreground/50">${fileCount} file${fileCount === 1 ? '' : 's'}</span>` : ''}
                </div>
                <div class="flex items-center gap-1.5">
                    <div class="mem-toolbar-group">
                        <button id="memory-new-file-btn" class="mem-header-btn" title="Create new memory file">New File</button>
                        <button id="memory-new-folder-btn" class="mem-header-btn" title="Create new folder">New Folder</button>
                    </div>
                    <div class="mem-toolbar-group">
                        <button id="memory-export-btn" class="mem-header-btn" title="Export memories as OMF JSON">Export</button>
                        <button id="memory-import-btn" class="mem-header-btn" title="Import memories from OMF JSON">Import</button>
                        <input id="memory-import-file" type="file" accept=".json" class="hidden" />
                        <button id="memory-backfill-btn" class="mem-header-btn" title="${this._escapeHtml(backfillButtonState.title)}" ${backfillButtonState.disabled ? 'disabled' : ''} ${backfillButtonState.busy ? 'aria-busy="true"' : ''}>${this._escapeHtml(backfillButtonState.label)}</button>
                    </div>
                    <div class="w-px h-4 mx-0.5" style="background: var(--mem-divider)"></div>
                    <button id="memory-close-btn" class="text-muted-foreground hover:text-foreground transition-colors p-1 rounded-md hover:bg-muted/40" aria-label="Close">
                        <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5">
                            <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"></path>
                        </svg>
                    </button>
                </div>
            </div>
        `;
    }

    _renderSidebar() {
        const { dirs, rootFiles } = this._getDirectoryStructure();
        // Phantom dir: when the user just typed a new folder name + Enter,
        // focusedDir is set but no file exists in it yet. Surface it as an empty
        // dir so the new-file input has a children container to nest into.
        if (this.focusedDir && !dirs[this.focusedDir]) {
            dirs[this.focusedDir] = [];
        }
        const sortedDirs = Object.keys(dirs).sort();

        let html = '<div class="px-2.5 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-wider" style="color: hsl(var(--color-muted-foreground) / 0.4)">Files</div>';

        for (const dir of sortedDirs) {
            const isExpanded = this.expandedDirs.has(dir);
            const isRenaming = this.renamingDir === dir;
            const fileCount = dirs[dir].length;
            const focusedStyle = this.focusedDir === dir
                ? '; box-shadow: inset 3px 0 0 hsl(var(--color-accent-primary) / 0.7)'
                : '';

            if (isRenaming) {
                html += `
                    <div class="mem-tree-row" style="padding-left: 8px${focusedStyle}">
                        <svg class="mem-chevron ${isExpanded ? 'is-expanded' : ''}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7"></path></svg>
                        <svg class="w-3 h-3 text-amber-500/60 dark:text-amber-400/50 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M2.25 12.75V12A2.25 2.25 0 014.5 9.75h15A2.25 2.25 0 0121.75 12v.75m-8.69-6.44l-2.12-2.12a1.5 1.5 0 00-1.061-.44H4.5A2.25 2.25 0 002.25 6v12a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9a2.25 2.25 0 00-2.25-2.25h-5.379a1.5 1.5 0 01-1.06-.44z"></path></svg>
                        <input id="memory-rename-dir-input" type="text" value="${this._escapeHtml(this.renamingDirValue)}"
                            class="flex-1 min-w-0 text-[13px] px-1.5 py-0.5 rounded border border-border bg-background text-foreground font-medium focus:outline-none focus:ring-1 focus:ring-ring" />
                    </div>
                `;
            } else {
                html += `
                    <div class="group mem-tree-row mem-dir-row" data-dir="${this._escapeHtml(dir)}" style="padding-left: 8px${focusedStyle}">
                        <svg class="mem-chevron ${isExpanded ? 'is-expanded' : ''}" data-dir-chevron="${this._escapeHtml(dir)}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7"></path></svg>
                        <svg class="w-3 h-3 text-amber-500/60 dark:text-amber-400/50 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M2.25 12.75V12A2.25 2.25 0 014.5 9.75h15A2.25 2.25 0 0121.75 12v.75m-8.69-6.44l-2.12-2.12a1.5 1.5 0 00-1.061-.44H4.5A2.25 2.25 0 002.25 6v12a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9a2.25 2.25 0 00-2.25-2.25h-5.379a1.5 1.5 0 01-1.06-.44z"></path></svg>
                        <span class="mem-tree-label font-medium truncate flex-1">${this._escapeHtml(dir)}</span>
                        <span class="mem-tree-count">${fileCount}</span>
                        <button class="memory-dir-menu-btn opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-muted/60 text-muted-foreground flex-shrink-0 transition-opacity" data-dir="${this._escapeHtml(dir)}">
                            <svg class="w-3 h-3" fill="currentColor" viewBox="0 0 20 20"><path d="M10 6a2 2 0 110-4 2 2 0 010 4zm0 6a2 2 0 110-4 2 2 0 010 4zm0 6a2 2 0 110-4 2 2 0 010 4z"></path></svg>
                        </button>
                    </div>
                `;
                const menuOpen = this.openDirMenu === dir;
                html += `
                    <div class="mem-dir-context-menu ${menuOpen ? '' : 'hidden'} ml-7 mr-2 mb-0.5 rounded-lg border border-border/50 shadow-lg overflow-hidden" style="background: hsl(var(--color-popover) / 0.7); backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px)" data-dir-menu="${this._escapeHtml(dir)}">
                        <button class="memory-dir-rename-btn w-full text-left text-xs px-3 py-1.5 hover:bg-muted/40 text-foreground transition-colors" data-dir="${this._escapeHtml(dir)}">Rename</button>
                        <button class="memory-dir-delete-btn w-full text-left text-xs px-3 py-1.5 hover:bg-muted/40 text-red-500 transition-colors" data-dir="${this._escapeHtml(dir)}">Delete</button>
                    </div>
                `;
            }

            html += `<div class="mem-dir-children ${isExpanded ? '' : 'hidden'}" data-dir-children="${this._escapeHtml(dir)}">`;
            for (const file of dirs[dir]) {
                const fileName = file.path.slice(dir.length + 1);
                const isSelected = file.path === this.selectedPath;
                html += this._renderFileItem(file.path, fileName, file.l0, isSelected, true);
            }
            // Inject new-file input nested inside the focused dir's children
            if (this.isCreatingFile && this.focusedDir === dir) {
                html += this._renderInlineCreateInput('file', true);
            }
            html += '</div>';
        }

        for (const file of rootFiles) {
            const isSelected = file.path === this.selectedPath;
            html += this._renderFileItem(file.path, file.path, file.l0, isSelected, false);
        }

        // Folders are flat top-level; new-folder input always at root
        if (this.isCreatingFolder) {
            html += this._renderInlineCreateInput('folder', false);
        }
        // New-file input at root only if no folder is focused
        if (this.isCreatingFile && !this.focusedDir) {
            html += this._renderInlineCreateInput('file', false);
        }

        if (this.files.length === 0 && !this.isCreatingFile && !this.isCreatingFolder) {
            html = `
                <div class="flex flex-col items-center justify-center py-10 px-4 text-center gap-3">
                    <svg class="w-8 h-8 text-muted-foreground/10" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1">
                        <path stroke-linecap="round" stroke-linejoin="round" d="M2.25 12.75V12A2.25 2.25 0 014.5 9.75h15A2.25 2.25 0 0121.75 12v.75m-8.69-6.44l-2.12-2.12a1.5 1.5 0 00-1.061-.44H4.5A2.25 2.25 0 002.25 6v12a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9a2.25 2.25 0 00-2.25-2.25h-5.379a1.5 1.5 0 01-1.06-.44z"></path>
                    </svg>
                    <span class="text-xs text-muted-foreground/40">No memory files yet</span>
                    <button id="memory-empty-new-file-btn" class="text-xs font-medium transition-colors" style="color: hsl(var(--color-accent-primary) / 0.7)">Create your first file</button>
                </div>
            `;
        }

        return `
            <div id="memory-sidebar" class="mem-sidebar w-56 flex-shrink-0 overflow-y-auto p-1.5"
                 style="min-width: 14rem; max-width: 14rem; overflow-x: hidden">
                ${html}
            </div>
        `;
    }

    _renderInlineCreateInput(kind, indent) {
        const wrapperStyle = indent ? 'padding: 4px 8px 4px 24px' : 'padding: 4px 8px';
        if (kind === 'folder') {
            return `
                <div data-role="inline-create-input" style="${wrapperStyle}">
                    <input id="memory-new-folder-input" type="text" placeholder="folder-name" value="${this._escapeHtml(this.newFolderName)}"
                        class="w-full min-w-0 text-xs px-2 py-1 rounded border border-border/50 bg-background/50 text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-ring" />
                </div>
            `;
        }
        const placeholder = this.focusedDir ? 'filename.md' : 'path/file.md';
        return `
            <div data-role="inline-create-input" style="${wrapperStyle}">
                <input id="memory-new-file-input" type="text" placeholder="${placeholder}" value="${this._escapeHtml(this.newFilePath)}"
                    class="w-full min-w-0 text-xs px-2 py-1 rounded border border-border/50 bg-background/50 text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-ring" />
            </div>
        `;
    }

    _renderFileItem(path, displayName, tooltip, isSelected, isNested) {
        const paddingLeft = isNested ? 24 : 8;
        const selectedClass = isSelected ? 'is-selected' : '';
        return `
            <div class="mem-tree-row mem-tree-file memory-file-item ${selectedClass}" data-path="${this._escapeHtml(path)}" title="${this._escapeHtml(tooltip || '')}" style="padding-left: ${paddingLeft}px">
                <svg class="w-3 h-3 flex-shrink-0 opacity-30" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z"></path></svg>
                <span class="mem-tree-label truncate">${this._escapeHtml(displayName)}</span>
            </div>
        `;
    }

    _renderEditorContent() {
        if (!this.selectedPath) {
            const { dirs } = this._getDirectoryStructure();
            const folderCount = Object.keys(dirs).length;
            const fileCount = this.files.length;
            return `
                <div class="flex-1 flex flex-col items-center justify-center text-center p-8 gap-3">
                    <svg class="w-10 h-10 text-muted-foreground/8" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="0.8">
                        <path stroke-linecap="round" stroke-linejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z"></path>
                    </svg>
                    <p class="text-[13px] text-muted-foreground/40">Select a file to view or edit</p>
                    ${fileCount > 0 ? `<p class="text-[11px] text-muted-foreground/25">${fileCount} file${fileCount === 1 ? '' : 's'} in ${folderCount} folder${folderCount === 1 ? '' : 's'}</p>` : ''}
                    <p class="text-[10px] text-muted-foreground/20 mt-2">${navigator.platform?.includes('Mac') ? '\u2318' : 'Ctrl+'}S to save</p>
                </div>
            `;
        }

        const pathBreadcrumb = this._renderBreadcrumb(this.selectedPath);

        const headerButtons = this.isEditing
            ? `${this.isDirty ? '<span class="text-[10px] text-amber-500/80 font-medium">Unsaved</span>' : ''}
               <button id="memory-toggle-edit-btn" class="mem-header-btn">Preview</button>
               <button id="memory-save-btn" class="mem-header-btn ${this.isDirty ? '' : 'opacity-30 pointer-events-none'}">Save</button>
               <button id="memory-delete-btn" class="mem-header-btn mem-header-btn-danger">Delete</button>`
            : `<button id="memory-toggle-edit-btn" class="mem-header-btn">Edit</button>
               <button id="memory-delete-btn" class="mem-header-btn mem-header-btn-danger">Delete</button>`;

        const contentArea = this.isEditing
            ? `<textarea id="memory-editor-textarea"
                class="mem-textarea flex-1 w-full p-4 text-sm bg-transparent text-foreground resize-none focus:outline-none leading-relaxed"
                spellcheck="false"
                placeholder="Start typing..."
              >${this._escapeHtml(this.editorContent)}</textarea>`
            : `<div id="memory-preview" class="mem-preview prose flex-1 w-full p-4 text-sm text-foreground overflow-y-auto leading-relaxed">${this._renderMarkdownPreview(this.editorContent)}</div>`;

        return `
            <div class="flex items-center justify-between px-3 py-1.5 shrink-0" style="border-bottom: 1px solid var(--mem-divider)">
                ${pathBreadcrumb}
                <div class="flex items-center gap-1.5 flex-shrink-0">
                    ${headerButtons}
                </div>
            </div>
            ${contentArea}
        `;
    }

    _renderBreadcrumb(path) {
        const parts = path.split('/');
        if (parts.length === 1) {
            return `<span class="text-xs text-foreground/70 font-mono font-medium truncate">${this._escapeHtml(path)}</span>`;
        }
        const segments = parts.map((part, index) => {
            const isLast = index === parts.length - 1;
            if (isLast) {
                return `<span class="text-foreground/70 font-medium">${this._escapeHtml(part)}</span>`;
            }
            return `<span class="text-muted-foreground/40">${this._escapeHtml(part)}</span><span class="text-muted-foreground/20">/</span>`;
        });
        return `<div class="flex items-center gap-0.5 text-xs font-mono truncate">${segments.join('')}</div>`;
    }

    _renderMarkdownPreview(content) {
        if (!content || !content.trim()) {
            return '<p class="text-muted-foreground/40 italic">Empty file</p>';
        }
        // Strip optional YAML frontmatter and leading heading (redundant with breadcrumb)
        let cleaned = content.replace(/^---\n[\s\S]*?\n---\n?/, '');
        cleaned = cleaned.replace(/^\s*#[^\n]*\n?/, '');
        if (!cleaned.trim()) {
            return '<p class="text-muted-foreground/40 italic">Empty file</p>';
        }
        let html = this.app.processContentWithLatex(cleaned);
        return this._formatMemoryMeta(html);
    }

    _formatMemoryMeta(html) {
        // Match lines with pipe-delimited metadata (signaled by | topic=)
        return html.replace(
            /([^<>\n]+?\s*\|[^<>\n]*topic=[^<>\n]*)/g,
            (match) => {
                const parts = match.split(/\s*\|\s*/);
                const fact = parts[0].trim();
                const meta = {};
                for (let i = 1; i < parts.length; i++) {
                    const eqIdx = parts[i].indexOf('=');
                    if (eqIdx > 0) {
                        meta[parts[i].slice(0, eqIdx).trim()] = parts[i].slice(eqIdx + 1).trim();
                    }
                }

                let result = fact;
                const tags = [];
                if (meta.topic) {
                    tags.push(`<span class="mem-topic">${meta.topic.replace(/-/g, ' ')}</span>`);
                }
                if (meta.confidence) {
                    tags.push(`<span class="mem-confidence-group"><span class="mem-confidence-label">confidence:</span>${this._renderConfidenceBars(meta.confidence)}</span>`);
                }
                if (meta.updated_at) {
                    const d = new Date(meta.updated_at + 'T00:00:00');
                    const formatted = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
                    tags.push(`<span class="mem-date">${formatted}</span>`);
                }
                if (tags.length) {
                    result += `<span class="mem-meta">${tags.join('')}</span>`;
                }
                return result;
            }
        );
    }

    _renderConfidenceBars(level) {
        const levels = { low: 1, medium: 2, high: 3 };
        const active = levels[level] || 2;
        const bars = [
            `<path d="M3 16.5V12.5"${active < 1 ? ' class="effort-muted"' : ''} />`,
            `<path d="M7.7 16.5V10"${active < 2 ? ' class="effort-muted"' : ''} />`,
            `<path d="M12.3 16.5V7.5"${active < 3 ? ' class="effort-muted"' : ''} />`,
            `<path d="M17 16.5V5" class="effort-muted" />`,
        ];
        return `<span class="mem-confidence" title="Confidence: ${level}"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">${bars.join('')}</svg></span>`;
    }

    _attachEventListeners() {
        if (!this.overlay) return;

        this.overlay.querySelector('#memory-close-btn')?.addEventListener('click', () => this.close());
        this.overlay.querySelector('#memory-new-folder-btn')?.addEventListener('click', () => this._startNewFolder());
        this.overlay.querySelector('#memory-new-file-btn')?.addEventListener('click', () => this._startNewFile());
        this.overlay.querySelector('#memory-empty-new-file-btn')?.addEventListener('click', () => this._startNewFile());
        this.overlay.querySelector('#memory-export-btn')?.addEventListener('click', () => this._handleExport());
        this.overlay.querySelector('#memory-import-btn')?.addEventListener('click', () => {
            this.overlay.querySelector('#memory-import-file')?.click();
        });
        this.overlay.querySelector('#memory-import-file')?.addEventListener('change', (event) => {
            void this._handleImportFileSelected(event);
        });
        this.overlay.querySelector('#import-confirm-btn')?.addEventListener('click', () => {
            void this._confirmImport();
        });
        this.overlay.querySelector('#import-cancel-btn')?.addEventListener('click', () => this._dismissImport());
        this.overlay.querySelector('#memory-backfill-btn')?.addEventListener('click', () => this._handleBackfillButtonClick());

        const sidebar = this.overlay.querySelector('#memory-sidebar');
        if (sidebar) {
            sidebar.addEventListener('click', (event) => this._handleSidebarClick(event));
        }

        this._attachInputListeners();
        this._attachRenameListener();
        this._attachEditorListeners();
    }

    _handleSidebarClick(event) {
        const fileItem = event.target.closest('.memory-file-item');
        if (fileItem) {
            void this._selectFile(fileItem.dataset.path);
            return;
        }

        const menuBtn = event.target.closest('.memory-dir-menu-btn');
        if (menuBtn) {
            event.stopPropagation();
            this._toggleDirMenu(menuBtn.dataset.dir);
            return;
        }

        const dirRow = event.target.closest('.mem-dir-row');
        if (dirRow) {
            this._toggleDir(dirRow.dataset.dir);
            return;
        }

        const renameBtn = event.target.closest('.memory-dir-rename-btn');
        if (renameBtn) {
            event.stopPropagation();
            this.openDirMenu = null;
            this.renamingDir = renameBtn.dataset.dir;
            this.renamingDirValue = renameBtn.dataset.dir;
            this.render();
            return;
        }

        const deleteBtn = event.target.closest('.memory-dir-delete-btn');
        if (deleteBtn) {
            event.stopPropagation();
            this.openDirMenu = null;
            void this._deleteFolder(deleteBtn.dataset.dir);
            return;
        }

        // Click landed on the inline new-file/folder input — keep focus state.
        if (event.target.closest('[data-role="inline-create-input"]')) {
            return;
        }

        // Blank sidebar area: clear the focused-folder marker.
        this._setFocusedDir(null);

        if (this.openDirMenu) {
            this._closeAllMenus();
        }
    }

    _attachInputListeners() {
        const newFolderInput = this.overlay.querySelector('#memory-new-folder-input');
        if (newFolderInput) this._wireCreateInput(newFolderInput, 'folder');

        const newFileInput = this.overlay.querySelector('#memory-new-file-input');
        if (newFileInput) this._wireCreateInput(newFileInput, 'file');
    }

    _wireCreateInput(input, kind) {
        input.focus();
        input.setSelectionRange(input.value.length, input.value.length);
        input.onkeydown = (event) => {
            if (event.key === 'Enter') {
                event.preventDefault();
                const value = input.value.trim();
                if (kind === 'file') {
                    void this._createNewFile(value);
                } else {
                    void this._createNewFolder(value);
                }
            } else if (event.key === 'Escape') {
                this._removeInlineCreateInput();
            }
        };
        // Defer so a click on a sibling button (e.g. New Folder while typing in
        // New File) can reach its own click handler before we tear down the
        // wrapper. The isConnected guard no-ops the cancel if the other handler
        // already replaced the input via render() or surgical inject.
        input.onblur = () => {
            setTimeout(() => {
                if (!input.isConnected) return;
                if (kind === 'file' && !this.isCreatingFile) return;
                if (kind === 'folder' && !this.isCreatingFolder) return;
                this._removeInlineCreateInput();
            }, 0);
        };
    }

    _injectCreateInputDom(kind) {
        if (!this.overlay) return;
        const sidebar = this.overlay.querySelector('#memory-sidebar');
        if (!sidebar) return;

        // Tear down any existing inline-create wrapper first.
        const existing = this.overlay.querySelector('[data-role="inline-create-input"]');
        if (existing) existing.remove();

        let target = sidebar;
        let indent = false;
        if (kind === 'file' && this.focusedDir) {
            const childrenContainer = sidebar.querySelector(
                `[data-dir-children="${CSS.escape(this.focusedDir)}"]`
            );
            if (childrenContainer) {
                target = childrenContainer;
                indent = true;
                // Make sure the focused folder is expanded so the input is visible.
                this.expandedDirs.add(this.focusedDir);
                childrenContainer.classList.remove('hidden');
                const chevron = sidebar.querySelector(
                    `[data-dir-chevron="${CSS.escape(this.focusedDir)}"]`
                );
                chevron?.classList.add('is-expanded');
            }
        }

        const tmpl = document.createElement('template');
        tmpl.innerHTML = this._renderInlineCreateInput(kind, indent).trim();
        const wrapper = tmpl.content.firstElementChild;
        if (!wrapper) return;
        target.appendChild(wrapper);

        const input = wrapper.querySelector('input');
        if (input) this._wireCreateInput(input, kind);
    }

    _removeInlineCreateInput() {
        if (!this.overlay) return;
        const wrapper = this.overlay.querySelector('[data-role="inline-create-input"]');
        if (wrapper) wrapper.remove();
        this.isCreatingFile = false;
        this.isCreatingFolder = false;
        this.newFilePath = '';
        this.newFolderName = '';
    }

    _setFocusedDir(dir) {
        if (this.focusedDir === dir) return;
        const accent = 'inset 3px 0 0 hsl(var(--color-accent-primary) / 0.7)';
        if (this.focusedDir && this.overlay) {
            const prev = this.overlay.querySelector(
                `.mem-dir-row[data-dir="${CSS.escape(this.focusedDir)}"]`
            );
            if (prev) prev.style.boxShadow = '';
        }
        this.focusedDir = dir;
        if (dir && this.overlay) {
            const next = this.overlay.querySelector(
                `.mem-dir-row[data-dir="${CSS.escape(dir)}"]`
            );
            if (next) next.style.boxShadow = accent;
        }
    }

    _attachRenameListener() {
        const renameDirInput = this.overlay.querySelector('#memory-rename-dir-input');
        if (renameDirInput) {
            renameDirInput.focus();
            renameDirInput.select();
            renameDirInput.onkeydown = (event) => {
                if (event.key === 'Enter') {
                    event.preventDefault();
                    void this._renameFolder(this.renamingDir, renameDirInput.value.trim());
                } else if (event.key === 'Escape') {
                    this.renamingDir = null;
                    this.render();
                }
            };
            renameDirInput.onblur = () => {
                if (!this.renamingDir) return;
                const value = renameDirInput.value.trim();
                if (value && value !== this.renamingDir) {
                    void this._renameFolder(this.renamingDir, value);
                } else {
                    this.renamingDir = null;
                    this.render();
                }
            };
        }
    }

    _attachEditorListeners() {
        // Toggle button (present in both modes)
        this.overlay.querySelector('#memory-toggle-edit-btn')?.addEventListener('click', () => {
            this.isEditing = !this.isEditing;
            this._updateEditorPane();
        });

        // Delete button (present in both modes)
        this.overlay.querySelector('#memory-delete-btn')?.addEventListener('click', () => {
            void this._deleteFile();
        });

        // Edit mode only: textarea and save
        if (this.isEditing) {
            const textarea = this.overlay.querySelector('#memory-editor-textarea');
            if (!textarea) return;

            textarea.oninput = () => {
                this.editorContent = textarea.value;
                if (!this.isDirty) {
                    this.isDirty = true;
                    const saveBtn = this.overlay.querySelector('#memory-save-btn');
                    if (saveBtn) {
                        saveBtn.classList.remove('opacity-30', 'pointer-events-none');
                    }
                    const toolbar = saveBtn?.parentElement;
                    if (toolbar && !toolbar.querySelector('[data-memory-unsaved="true"]')) {
                        const span = document.createElement('span');
                        span.className = 'text-[10px] text-amber-500/80 font-medium';
                        span.dataset.memoryUnsaved = 'true';
                        span.textContent = 'Unsaved';
                        toolbar.prepend(span);
                    }
                }
            };

            textarea.onkeydown = (event) => {
                if ((event.metaKey || event.ctrlKey) && event.key === 's') {
                    event.preventDefault();
                    event.stopPropagation();
                    void this._saveFile();
                }
            };

            this.overlay.querySelector('#memory-save-btn')?.addEventListener('click', () => {
                void this._saveFile();
            });
        }
    }

    async _selectFile(path) {
        if (!path) return;

        this.overlay.querySelectorAll('.memory-file-item.is-selected').forEach((el) => {
            el.classList.remove('is-selected');
        });
        const newEl = this.overlay.querySelector(`.memory-file-item[data-path="${CSS.escape(path)}"]`);
        if (newEl) {
            newEl.classList.add('is-selected');
        }

        this.selectedPath = path;
        const slashIdx = path.indexOf('/');
        this._setFocusedDir(slashIdx === -1 ? null : path.slice(0, slashIdx));
        this.editorContent = await memoryFileSystem.read(path) || '';
        this.isDirty = false;
        this.isEditing = false;
        this._updateEditorPane();
    }

    _updateEditorPane() {
        const pane = this.overlay.querySelector('#memory-editor-pane');
        if (!pane) return;
        pane.innerHTML = this._renderEditorContent();
        this._attachEditorListeners();
    }

    _toggleDir(dir) {
        const children = this.overlay.querySelector(`[data-dir-children="${CSS.escape(dir)}"]`);
        const chevron = this.overlay.querySelector(`[data-dir-chevron="${CSS.escape(dir)}"]`);

        if (this.expandedDirs.has(dir)) {
            this.expandedDirs.delete(dir);
            children?.classList.add('hidden');
            chevron?.classList.remove('is-expanded');
            // Collapsing the focused folder also clears focus.
            if (this.focusedDir === dir) {
                this._setFocusedDir(null);
            }
        } else {
            this.expandedDirs.add(dir);
            children?.classList.remove('hidden');
            chevron?.classList.add('is-expanded');
            this._setFocusedDir(dir);
        }

        this._closeAllMenus();
    }

    _toggleDirMenu(dir) {
        this.overlay.querySelectorAll('.mem-dir-context-menu').forEach((el) => {
            if (el.dataset.dirMenu !== dir) {
                el.classList.add('hidden');
            }
        });

        const menu = this.overlay.querySelector(`[data-dir-menu="${CSS.escape(dir)}"]`);
        if (menu) {
            const isHidden = menu.classList.toggle('hidden');
            this.openDirMenu = isHidden ? null : dir;
        }
    }

    _closeAllMenus() {
        this.overlay.querySelectorAll('.mem-dir-context-menu:not(.hidden)').forEach((el) => {
            el.classList.add('hidden');
        });
        this.openDirMenu = null;
    }

    _startNewFolder() {
        // Cancel any in-flight file creation; folders are top-level so the
        // input belongs at root, not nested.
        if (this.isCreatingFile) this._removeInlineCreateInput();
        if (this.isCreatingFolder) {
            this.overlay?.querySelector('#memory-new-folder-input')?.focus();
            return;
        }
        this.isCreatingFolder = true;
        this.newFolderName = '';

        // Empty-state placeholder occupies the sidebar when files.length === 0;
        // we need a full render to swap to the normal sidebar shell. Otherwise
        // the input wrapper would just append after the empty-state text.
        if (this.files.length === 0 || !this.overlay?.querySelector('#memory-sidebar')) {
            this.render();
            return;
        }
        this._injectCreateInputDom('folder');
    }

    async _createNewFolder(name) {
        if (!name) return;
        name = name.replace(/[\/\\]/g, '').replace(/\.md$/i, '');
        if (!name) return;

        this.isCreatingFolder = false;
        this.expandedDirs.add(name);
        this.isCreatingFile = true;
        this.newFilePath = '';
        // Set focus to the new folder so the file step lands inside it. The
        // phantom-folder logic in _renderSidebar surfaces it even though no
        // file exists yet.
        this.focusedDir = name;
        this.render();
    }

    _startNewFile() {
        if (this.isCreatingFolder) this._removeInlineCreateInput();
        if (this.isCreatingFile) {
            this.overlay?.querySelector('#memory-new-file-input')?.focus();
            return;
        }
        this.isCreatingFile = true;
        this.newFilePath = '';

        if (this.files.length === 0 || !this.overlay?.querySelector('#memory-sidebar')) {
            this.render();
            return;
        }
        this._injectCreateInputDom('file');
    }

    async _createNewFile(path) {
        if (!path) return;
        path = path.replace(/^\/+/, '');
        // When typed into a focused-folder input, only the filename is in `path`;
        // prepend the focused folder so the write lands in the right place.
        if (this.focusedDir && !path.startsWith(`${this.focusedDir}/`)) {
            path = `${this.focusedDir}/${path}`;
        }
        if (!path.endsWith('.md')) {
            path += '.md';
        }
        // Guard against trailing-slash or empty-name cases producing `.md` files.
        const baseName = path.split('/').pop().replace(/\.md$/i, '');
        if (!baseName) return;

        this.isCreatingFile = false;
        await memoryFileSystem.write(path, `# ${baseName}\n\n`);
        await this._loadFileTree();

        const slashIdx = path.indexOf('/');
        if (slashIdx !== -1) {
            const parentDir = path.slice(0, slashIdx);
            this.expandedDirs.add(parentDir);
            this.focusedDir = parentDir;
        } else {
            this.focusedDir = null;
        }

        this.selectedPath = path;
        this.editorContent = await memoryFileSystem.read(path) || '';
        this.isDirty = false;
        this.isEditing = true;
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
        if (!this.selectedPath) return;

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
        const prefix = `${dir}/`;
        const toDelete = this.files.filter((file) => file.path.startsWith(prefix));
        for (const file of toDelete) {
            await memoryFileSystem.delete(file.path);
        }
        if (this.selectedPath?.startsWith(prefix)) {
            this.selectedPath = null;
            this.editorContent = '';
            this.isDirty = false;
        }
        this.expandedDirs.delete(dir);
        if (this.focusedDir === dir) this.focusedDir = null;
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

        newDir = newDir.replace(/[\/\\]/g, '');
        if (!newDir) {
            this.render();
            return;
        }

        const prefix = `${oldDir}/`;
        const filesToMove = this.files.filter((file) => file.path.startsWith(prefix));
        for (const file of filesToMove) {
            const content = await memoryFileSystem.read(file.path);
            const newPath = `${newDir}/${file.path.slice(prefix.length)}`;
            await memoryFileSystem.write(newPath, content || '');
            await memoryFileSystem.delete(file.path);
        }

        if (this.selectedPath?.startsWith(prefix)) {
            this.selectedPath = `${newDir}/${this.selectedPath.slice(prefix.length)}`;
            this.editorContent = await memoryFileSystem.read(this.selectedPath) || '';
        }

        this.expandedDirs.delete(oldDir);
        this.expandedDirs.add(newDir);
        if (this.focusedDir === oldDir) this.focusedDir = newDir;
        await this._loadFileTree();
        this.render();
        this.app?.showToast?.(`Folder renamed to "${newDir}"`, 'success');
    }

    async _handleExport() {
        try {
            const result = await exportMemoriesAsOmf();
            if (result.saved) {
                this.app?.showToast?.('Memories exported (OMF)', 'success');
            }
        } catch (err) {
            console.error('[MemoryEditor] Export error:', err);
            this.app?.showToast?.('Failed to export memories', 'error');
        }
    }

    async exportMemories() {
        await this._handleExport();
    }

    async _handleImportFileSelected(event) {
        const file = event.target.files?.[0];
        event.target.value = '';
        if (!file) return;

        await this.importMemoryFile(file);
    }

    async importMemoryFile(file) {
        if (!file) return;

        if (!this.isOpen) {
            await this.open();
        }

        try {
            const doc = await readOmfFile(file);
            const validation = validateOmf(doc);
            if (!validation.valid) {
                this.app?.showToast?.(validation.error, 'error');
                return;
            }

            this.importDoc = doc;
            this.importPreview = await previewOmfImport(doc);
            this.importState = 'preview';
            this.render();
        } catch (err) {
            console.error('[MemoryEditor] Import parse error:', err);
            this.app?.showToast?.('Failed to read file. Is it valid JSON?', 'error');
        }
    }

    async _confirmImport() {
        if (!this.importDoc || this.importState !== 'preview') return;

        this.importState = 'importing';
        this.render();

        try {
            const includeArchived = this.overlay.querySelector('#import-include-archived')?.checked ?? true;
            const result = await importOmf(this.importDoc, { includeArchived });
            this.importResult = result;
            this.importState = 'complete';
            await this._loadFileTree();
            this.render();
        } catch (err) {
            console.error('[MemoryEditor] Import error:', err);
            this.importState = null;
            this.app?.showToast?.(`Import failed: ${err.message}`, 'error');
            this.render();
        }
    }

    _dismissImport() {
        this.importState = null;
        this.importDoc = null;
        this.importPreview = null;
        this.importResult = null;
        this.render();
    }

    _renderImportProgress() {
        if (this.importState === 'preview' && this.importPreview) {
            const preview = this.importPreview;
            return `
                <div class="px-4 py-3 bg-muted/20 flex-shrink-0" style="border-bottom: 1px solid hsl(var(--color-border) / 0.4)">
                    <div class="text-sm text-foreground mb-1.5">
                        Found <span class="font-semibold">${preview.total}</span> memor${preview.total === 1 ? 'y' : 'ies'}
                        — <span class="font-semibold">${preview.toImport}</span> new, <span class="font-semibold">${preview.duplicates}</span> duplicate${preview.duplicates === 1 ? '' : 's'}
                    </div>
                    <div class="text-xs text-muted-foreground mb-3">
                        ${preview.newFiles} new file${preview.newFiles === 1 ? '' : 's'}, ${preview.existingFiles} existing file${preview.existingFiles === 1 ? '' : 's'} to merge into.
                    </div>
                    <div class="flex items-center justify-between">
                        <label class="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer">
                            <input id="import-include-archived" type="checkbox" checked class="rounded border-border" />
                            Include archived memories
                        </label>
                        <div class="flex items-center gap-2">
                            <button id="import-cancel-btn" class="mem-header-btn">Cancel</button>
                            <button id="import-confirm-btn" class="px-3 py-1 text-xs font-medium rounded-md bg-primary text-primary-foreground hover:bg-primary/90 transition-all duration-200">
                                Import
                            </button>
                        </div>
                    </div>
                </div>
            `;
        }

        if (this.importState === 'importing') {
            return `
                <div class="px-4 py-3 bg-muted/20 flex-shrink-0" style="border-bottom: 1px solid hsl(var(--color-border) / 0.4)">
                    <div class="text-sm text-foreground">Importing memories...</div>
                    <div class="w-full h-1 bg-muted rounded-full overflow-hidden mt-2">
                        <div class="h-full rounded-full animate-pulse" style="width: 100%; background: hsl(var(--color-accent-primary))"></div>
                    </div>
                </div>
            `;
        }

        if (this.importState === 'complete' && this.importResult) {
            const result = this.importResult;
            const hasErrors = result.errors.length > 0;
            return `
                <div class="px-4 py-3 bg-muted/20 flex-shrink-0" style="border-bottom: 1px solid hsl(var(--color-border) / 0.4)">
                    <div class="flex items-center justify-between mb-1">
                        <span class="text-sm font-medium ${hasErrors ? 'text-amber-500' : 'text-green-500'}">
                            ${hasErrors ? 'Import completed with errors' : 'Import complete'}
                        </span>
                        <button id="import-cancel-btn" class="mem-header-btn">Dismiss</button>
                    </div>
                    <div class="text-xs text-muted-foreground">
                        ${result.imported} imported, ${result.duplicates} duplicate${result.duplicates === 1 ? '' : 's'} skipped, ${result.filesWritten} file${result.filesWritten === 1 ? '' : 's'} written
                        ${result.skipped > 0 ? `, ${result.skipped} filtered` : ''}
                        ${hasErrors ? `<span class="text-red-500"> — ${result.errors.length} error${result.errors.length === 1 ? '' : 's'}</span>` : ''}
                    </div>
                </div>
            `;
        }

        return '';
    }

    _getInitialBackfillProgress() {
        return {
            total: 0,
            processed: 0,
            imported: 0,
            skipped: 0,
            errors: 0,
            currentLabel: ''
        };
    }

    _isBackfillActive() {
        return this.backfillState === 'running' || this.backfillState === 'stopping';
    }

    _getBackfillButtonState() {
        const total = Math.max(0, Number(this.backfillProgress.total || 0));
        const processed = Math.min(Math.max(0, Number(this.backfillProgress.processed || 0)), total);
        const currentLabel = this.backfillProgress.currentLabel || 'local chats';

        if (this.backfillState === 'stopping') {
            return {
                label: 'Stopping...',
                title: `Stopping backfill after current in-flight work. ${processed}/${total} processed. Current: ${currentLabel}`,
                disabled: true,
                busy: true
            };
        }

        if (this.backfillState === 'running') {
            return {
                label: total > 0 ? `Stop ${processed}/${total}` : 'Stop',
                title: `Stop backfill. ${processed}/${total} processed. Current: ${currentLabel}`,
                disabled: false,
                busy: true
            };
        }

        return {
            label: 'Backfill',
            title: 'Process local chats into memory with nanomem import',
            disabled: false,
            busy: false
        };
    }

    _handleBackfillButtonClick() {
        if (this.backfillState === 'running') {
            this._requestBackfillStop();
            return;
        }
        if (this.backfillState === 'stopping') {
            return;
        }
        void this._startBackfill();
    }

    _requestBackfillStop(toastMessage = 'Stopping backfill...') {
        if (this.backfillState !== 'running') {
            return;
        }
        this.backfillState = 'stopping';
        this.backfillAbortController?.abort();
        this._syncBackfillButton();
        this.app?.showToast?.(toastMessage, 'info', 4000);
    }

    async _startBackfill() {
        if (this._isBackfillActive()) {
            return;
        }

        const activeSession = this.app?.getCurrentSession?.() || null;
        const keySession = activeSession || { memoryKey: null, memoryKeyInfo: null };
        let shouldRefreshFiles = false;
        const completedSessionSavePromises = [];
        const BACKFILL_AUTH_RETRY_LIMIT = 1;
        const persistCompletedCandidate = (candidate) => {
            if (!candidate || candidate.didPersistBackfillProgress) {
                return;
            }
            candidate.didPersistBackfillProgress = true;
            candidate.session.memoryProcessedAt = Date.now();
            const savePromise = chatDB.saveSession(candidate.session).catch((error) => {
                candidate.didPersistBackfillProgress = false;
                console.error('[MemoryEditor] Failed to save backfill progress:', error);
                throw error;
            });
            completedSessionSavePromises.push(savePromise);
        };
        const persistActiveSessionIfChanged = async (previousKey) => {
            if (!activeSession) {
                return;
            }
            if (keySession.memoryKey !== previousKey) {
                await chatDB.saveSession(activeSession);
            }
        };
        const invalidateActiveMemoryKey = async () => {
            invalidateMemoryKey(keySession);
            if (activeSession) {
                await chatDB.saveSession(activeSession);
            }
        };
        const updateBackfillProgressForResult = (candidate, itemResult) => {
            this.backfillProgress.processed += 1;
            this.backfillProgress.currentLabel = candidate?.input?.title || '';
            if (itemResult?.status === 'processed') {
                this.backfillProgress.imported += 1;
            } else if (itemResult?.status === 'skipped') {
                this.backfillProgress.skipped += 1;
            } else if (itemResult?.status === 'error') {
                this.backfillProgress.errors += 1;
            }
            if (itemResult?.status !== 'error') {
                persistCompletedCandidate(candidate);
            }
            this._syncBackfillButton();
        };

        try {
            const candidates = await this._collectBackfillCandidates();
            if (candidates.length === 0) {
                this.app?.showToast?.('All local chats are already backfilled.', 'success');
                return;
            }

            this.backfillAbortController = new AbortController();
            this.backfillState = 'running';
            this.backfillProgress = {
                total: candidates.length,
                processed: 0,
                imported: 0,
                skipped: 0,
                errors: 0,
                currentLabel: ''
            };
            this._syncBackfillButton();

            let stopReason = null;

            for (const candidate of candidates) {
                if (this.backfillAbortController.signal.aborted) {
                    stopReason = 'aborted';
                    break;
                }
                this.backfillProgress.currentLabel = candidate?.input?.title || '';
                this._syncBackfillButton();

                let authRetryCount = 0;
                let itemFinished = false;

                while (!itemFinished) {
                    const previousKey = keySession.memoryKey || null;
                    const memoryKey = await ensureMemoryKey(keySession, ticketClient);
                    await persistActiveSessionIfChanged(previousKey);

                    if (!memoryKey) {
                        stopReason = (authRetryCount > 0 || this.backfillProgress.processed > 0)
                            ? 'key_expired_no_tickets'
                            : 'insufficient_tickets';
                        break;
                    }

                    const result = await importMemoryData({
                        input: candidate.input,
                        apiKey: memoryKey,
                        model: this.app?.memoryAgentModel,
                        options: {
                            format: 'normalized',
                            signal: this.backfillAbortController.signal
                        }
                    });

                    if (result.aborted) {
                        stopReason = 'aborted';
                        break;
                    }

                    if (result.authError) {
                        await invalidateActiveMemoryKey();
                        authRetryCount += 1;
                        if (authRetryCount > BACKFILL_AUTH_RETRY_LIMIT) {
                            stopReason = 'auth_refresh_failed';
                            break;
                        }
                        continue;
                    }

                    const itemResult = result.results[0] || {
                        title: candidate?.input?.title || null,
                        updatedAt: candidate?.input?.updatedAt || null,
                        status: 'skipped',
                        writeCalls: 0
                    };
                    if (itemResult.status === 'processed') {
                        shouldRefreshFiles = true;
                    }
                    updateBackfillProgressForResult(candidate, itemResult);
                    itemFinished = true;
                }

                if (stopReason) {
                    break;
                }
            }

            await Promise.allSettled(completedSessionSavePromises);

            if (stopReason === 'insufficient_tickets') {
                this.app?.showToast?.('Backfill needs 2 available inference tickets for confidential memory import.', 'info');
            } else if (stopReason === 'key_expired_no_tickets') {
                this.app?.showToast?.(
                    'Backfill stopped: no tickets left to renew the confidential key.',
                    'error',
                    5000
                );
            } else if (stopReason === 'auth_refresh_failed') {
                this.app?.showToast?.(
                    'Backfill stopped: failed to refresh the confidential key.',
                    'error',
                    5000
                );
            } else if (stopReason === 'aborted') {
                if (this.backfillProgress.processed > 0) {
                    this.app?.showToast?.(
                        `Backfill stopped after ${this.backfillProgress.processed} chat${this.backfillProgress.processed === 1 ? '' : 's'}. Click Backfill again to continue.`,
                        'info',
                        5000
                    );
                } else {
                    this.app?.showToast?.('Backfill stopped. Click Backfill again to continue.', 'info', 4000);
                }
            } else if (this.backfillProgress.errors > 0) {
                this.app?.showToast?.(
                    `Backfill finished: ${this.backfillProgress.imported} imported, ${this.backfillProgress.skipped} skipped, ${this.backfillProgress.errors} error${this.backfillProgress.errors === 1 ? '' : 's'}.`,
                    'info',
                    5000
                );
            } else {
                this.app?.showToast?.(
                    `Backfill finished: ${this.backfillProgress.imported} chat${this.backfillProgress.imported === 1 ? '' : 's'} imported into memory.`,
                    'success',
                    4000
                );
            }
        } catch (error) {
            console.error('[MemoryEditor] Backfill error:', error);
            if (isMemoryAuthError(error)) {
                invalidateMemoryKey(keySession);
                if (activeSession) {
                    await chatDB.saveSession(activeSession);
                }
            }
            this.app?.showToast?.(error?.message || 'Failed to backfill chats into memory.', 'error');
        } finally {
            this.backfillAbortController = null;
            this.backfillState = null;
            this.backfillProgress = this._getInitialBackfillProgress();
            if (shouldRefreshFiles) {
                await this._loadFileTree();
                if (this.isOpen) {
                    this.render();
                }
            } else if (this.isOpen) {
                this._syncBackfillButton();
            }
        }
    }

    async _collectBackfillCandidates() {
        const sessions = await chatDB.getAllSessions();
        const sortedSessions = [...sessions].sort((a, b) => {
            const left = Number(a?.updatedAt || a?.createdAt || 0);
            const right = Number(b?.updatedAt || b?.createdAt || 0);
            if (left !== right) return right - left;
            return String(b?.id || '').localeCompare(String(a?.id || ''));
        });

        /** @type {Array<{ session: any, input: { title: string | null, messages: Array<{ role: 'user' | 'assistant', content: string }>, updatedAt: number | null, mode: 'conversation' } }>} */
        const candidates = [];
        for (const session of sortedSessions) {
            if (!this._sessionNeedsBackfill(session)) {
                continue;
            }
            if (this.app?.getSessionStreamingState?.(session.id)?.isStreaming) {
                continue;
            }

            const messages = await chatDB.getSessionMessages(session.id);
            candidates.push({
                session,
                input: {
                    title: typeof session?.title === 'string' && session.title.trim() ? session.title.trim() : null,
                    messages: this._normalizeBackfillMessages(messages),
                    updatedAt: session?.updatedAt || session?.createdAt || null,
                    mode: 'conversation'
                }
            });
        }
        return candidates;
    }

    _sessionNeedsBackfill(session) {
        const updatedAt = Number(session?.updatedAt || session?.createdAt || 0);
        const processedAt = Number(session?.memoryProcessedAt || 0);
        return !processedAt || updatedAt > processedAt;
    }

    _normalizeBackfillMessages(messages) {
        return normalizeMessagesForMemory(messages, {
            getMessageTextContent: (content) => this.app?.getMessageTextContent?.(content) ?? '',
            getScrubberMessageContent: (message, mode) => this.app?.getScrubberMessageContent?.(message, mode) ?? message?.content ?? ''
        });
    }

    _syncBackfillButton() {
        if (!this.overlay) return;
        const button = this.overlay.querySelector('#memory-backfill-btn');
        if (!button) return;

        const backfillButtonState = this._getBackfillButtonState();
        button.textContent = backfillButtonState.label;
        button.title = backfillButtonState.title;

        if (backfillButtonState.disabled) {
            button.setAttribute('disabled', 'disabled');
        } else {
            button.removeAttribute('disabled');
        }

        if (backfillButtonState.busy) {
            button.setAttribute('aria-busy', 'true');
        } else {
            button.removeAttribute('aria-busy');
        }
    }

    _escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text || '';
        return div.innerHTML;
    }
}

export default MemoryEditor;
