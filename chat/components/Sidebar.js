/**
 * Sidebar Component
 * Manages the left sidebar including session list rendering and session controls.
 * Delegates all state changes to the main app.
 */

const SESSION_ROW_HEIGHT = 36;
const HEADER_ROW_HEIGHT = 36;
const GROUP_SPACER_HEIGHT = 12;
const FOOTER_ROW_HEIGHT = 32;
const VIRTUALIZE_THRESHOLD = 400;
const VIRTUAL_OVERSCAN = 8;

export default class Sidebar {
    /**
     * @param {Object} app - Reference to the main ChatApp instance
     */
    constructor(app) {
        this.app = app;
        this.virtualState = {
            enabled: false,
            items: [],
            offsets: [],
            totalHeight: 0,
            lastRange: null
        };
        this.virtualScrollRaf = null;
        this.listenersAttached = false;
    }

    /**
     * Scrolls the sessions list to the top.
     */
    scrollToTop() {
        if (this.app.elements.sessionsScrollArea) {
            this.app.elements.sessionsScrollArea.scrollTop = 0;
            this.handleScroll(true);
        }
    }

    /**
     * Escapes HTML special characters in text.
     * @param {string} text - The text to escape
     * @returns {string} HTML-safe text
     */
    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    /**
     * Determines the date group for a session based on its timestamp.
     * @param {number} timestamp - Unix timestamp
     * @returns {string} Group label (TODAY, YESTERDAY, etc.)
     */
    getSessionDateGroup(timestamp) {
        const now = new Date();
        const sessionDate = new Date(timestamp);

        const nowDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const sessionDay = new Date(sessionDate.getFullYear(), sessionDate.getMonth(), sessionDate.getDate());
        const diffDays = Math.floor((nowDay - sessionDay) / (1000 * 60 * 60 * 24));

        if (diffDays === 0) return 'Today';
        if (diffDays === 1) return 'Yesterday';
        if (diffDays <= 7) return 'Previous 7 Days';
        if (diffDays <= 30) return 'Previous 30 Days';
        return 'Older';
    }

    /**
     * Renders the sessions list grouped by date.
     */
    render() {
        const sessionsToRender = this.app.getFilteredSessions();
        this.ensureEventListeners();

        const shouldVirtualize = this.shouldVirtualize(sessionsToRender);
        this.virtualState.enabled = shouldVirtualize;
        this.toggleVirtualizedClass(shouldVirtualize);

        if (shouldVirtualize) {
            this.prepareVirtualItems(sessionsToRender);
            this.renderVirtualRange(true);
            return;
        }

        this.renderFullList(sessionsToRender);
    }

    /**
     * Builds HTML for a single session item.
     * @param {Object} session - Session object
     * @returns {string} HTML string
     */
    buildSessionHTML(session) {
        const isActive = session.id === this.app.state.currentSessionId;
        // Use summary if available, otherwise fall back to title
        const displayTitle = session.summary || session.title;
        const titleClass = displayTitle === 'New Chat' ? 'italic text-muted-foreground' : '';
        const isShared = !!session.shareInfo?.shareId;
        // Show imported indicator for pure imports and forked imports (not local forks)
        // forkedFrom alone (without importedMessageCount) indicates a LOCAL fork, not an import
        const isImported = !!(session.importedFrom || session.importedSource ||
            (session.forkedFrom && (session.importedMessageCount || 0) > 0));
        const hasKeywords = Array.isArray(session.keywords) && session.keywords.length > 0;
        const hasEmbedding = Number.isFinite(session.lastEmbeddedAt) && session.lastEmbeddedAt > 0;
        const embedActionLabel = (hasKeywords && hasEmbedding) ? 'Re-embed Session' : 'Generate Embeddings';
        const shareLabel = isShared ? 'Update Share' : 'Share';

        // Build indicator icons
        let indicatorHtml = '';
        if (isShared) {
            // Arrow up from box (opposite of import's arrow down to box)
            indicatorHtml += `<span class="text-primary flex-shrink-0 ml-1" title="Shared">
                <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
                    <path stroke-linecap="round" stroke-linejoin="round" d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5m-13.5-9L12 3m0 0 4.5 4.5M12 3v13.5" />
                </svg>
            </span>`;
        }
        if (isImported) {
            // Arrow down to box
            indicatorHtml += `<span class="text-muted-foreground flex-shrink-0 ml-1" title="Imported">
                <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
                    <path stroke-linecap="round" stroke-linejoin="round" d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5M16.5 12 12 16.5m0 0L7.5 12m4.5 4.5V3" />
                </svg>
            </span>`;
        }

        return `
            <div class="group relative flex h-9 items-center rounded-lg ${isActive ? 'chat-session active' : 'hover-highlight'} transition-colors pl-3 chat-session" data-session-id="${session.id}">
                <a class="flex flex-1 items-center justify-between h-full min-w-0 text-foreground hover:text-foreground cursor-pointer">
                    <div class="flex min-w-0 flex-1 items-center">
                        <input class="session-title-input w-full cursor-pointer truncate bg-transparent text-sm leading-5 focus:outline-none text-foreground ${titleClass}" placeholder="Untitled Chat" readonly data-session-id="${session.id}" value="${this.escapeHtml(displayTitle)}">
                        ${indicatorHtml}
                    </div>
                </a>
                <div class="flex shrink-0 items-center relative">
                    <button class="session-menu-btn inline-flex items-center justify-center whitespace-nowrap rounded-md font-medium transition-colors focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50 gap-2 leading-6 text-muted-foreground border border-transparent h-9 w-9 opacity-0 group-hover:opacity-100" aria-label="Session options" data-session-id="${session.id}">
                        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor" class="w-5 h-5">
                            <path stroke-linecap="round" stroke-linejoin="round" d="M6.75 12a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0ZM12.75 12a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0ZM18.75 12a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0Z" />
                        </svg>
                    </button>
                    <div class="session-menu hidden absolute right-0 top-10 z-[100] rounded-lg border border-border bg-popover shadow-lg p-1 min-w-[140px]" data-session-id="${session.id}">
                        <button class="rename-session-action w-full text-left px-3 py-2 text-sm text-popover-foreground hover-highlight hover:text-accent-foreground rounded-md transition-colors" data-session-id="${session.id}">Rename</button>
                        <button class="copy-link-action w-full text-left px-3 py-2 text-sm text-popover-foreground hover-highlight hover:text-accent-foreground rounded-md transition-colors" data-session-id="${session.id}">Copy Link</button>
                        <button class="share-session-action w-full text-left px-3 py-2 text-sm text-popover-foreground hover-highlight hover:text-accent-foreground rounded-md transition-colors" data-session-id="${session.id}">${shareLabel}</button>
                        ${isShared ? `<button class="delete-share-action w-full text-left px-3 py-2 text-sm text-popover-foreground hover-highlight hover:text-accent-foreground rounded-md transition-colors" data-session-id="${session.id}">Delete Share</button>` : ''}
                        ${isImported ? `<button class="embed-session-action w-full text-left px-3 py-2 text-sm text-popover-foreground hover-highlight hover:text-accent-foreground rounded-md transition-colors" data-session-id="${session.id}">${embedActionLabel}</button>` : ''}
                        <button class="export-pdf-action w-full text-left px-3 py-2 text-sm text-popover-foreground hover-highlight hover:text-accent-foreground rounded-md transition-colors" data-session-id="${session.id}">Export as PDF</button>
                        <button class="delete-session-action w-full text-left px-3 py-2 text-sm text-popover-foreground hover-highlight hover:text-accent-foreground rounded-md transition-colors" data-session-id="${session.id}">Delete</button>
                    </div>
                </div>
            </div>
        `;
    }

    /**
     * Ensures session list event listeners are attached once.
     */
    ensureEventListeners() {
        if (this.listenersAttached) return;
        const list = this.app.elements.sessionsList;
        if (!list) return;

        this.listenersAttached = true;

        list.addEventListener('click', async (e) => {
            const renameAction = e.target.closest('.rename-session-action');
            if (renameAction) {
                e.stopPropagation();
                const sessionId = renameAction.dataset.sessionId;
                this.closeAllMenus();
                this.startInlineEdit(sessionId);
                return;
            }

            const deleteAction = e.target.closest('.delete-session-action');
            if (deleteAction) {
                e.stopPropagation();
                const sessionId = deleteAction.dataset.sessionId;
                this.closeAllMenus();
                this.app.deleteSession(sessionId);
                return;
            }

            const shareAction = e.target.closest('.share-session-action');
            if (shareAction) {
                e.stopPropagation();
                const sessionId = shareAction.dataset.sessionId;
                this.closeAllMenus();
                if (sessionId !== this.app.state.currentSessionId) {
                    await this.app.switchSession(sessionId);
                }
                await this.app.shareCurrentSession();
                return;
            }

            const copyAction = e.target.closest('.copy-link-action');
            if (copyAction) {
                e.stopPropagation();
                const sessionId = copyAction.dataset.sessionId;
                this.closeAllMenus();
                if (sessionId !== this.app.state.currentSessionId) {
                    await this.app.switchSession(sessionId);
                }
                await this.app.copySessionLink();
                return;
            }

            const deleteShareAction = e.target.closest('.delete-share-action');
            if (deleteShareAction) {
                e.stopPropagation();
                const sessionId = deleteShareAction.dataset.sessionId;
                this.closeAllMenus();
                if (sessionId !== this.app.state.currentSessionId) {
                    await this.app.switchSession(sessionId);
                }
                await this.app.deleteCurrentSessionShare();
                return;
            }

            const exportAction = e.target.closest('.export-pdf-action');
            if (exportAction) {
                e.stopPropagation();
                const sessionId = exportAction.dataset.sessionId;
                this.closeAllMenus();
                if (sessionId !== this.app.state.currentSessionId) {
                    await this.app.switchSession(sessionId);
                }
                await this.app.exportChatToPdf();
                return;
            }

            const embedAction = e.target.closest('.embed-session-action');
            if (embedAction) {
                e.stopPropagation();
                const sessionId = embedAction.dataset.sessionId;
                this.closeAllMenus();
                await this.app.generateSessionEmbeddings(sessionId);
                return;
            }

            const menuBtn = e.target.closest('.session-menu-btn');
            if (menuBtn) {
                e.stopPropagation();
                const sessionId = menuBtn.dataset.sessionId;
                const menu = list.querySelector(`.session-menu[data-session-id="${sessionId}"]`);
                this.closeAllMenus(menu);
                if (menu) {
                    menu.classList.toggle('hidden');
                }
                return;
            }

            if (e.target.closest('.session-menu')) {
                return;
            }

            const sessionEl = e.target.closest('.chat-session');
            if (sessionEl) {
                const sessionId = sessionEl.dataset.sessionId;
                this.closeAllMenus();
                this.app.switchSession(sessionId);
            }
        });

        list.addEventListener('keydown', (e) => {
            const input = e.target.closest('.session-title-input');
            if (!input || input.readOnly) return;
            if (e.key === 'Enter') {
                e.preventDefault();
                e.stopPropagation();
                input.blur();
            } else if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                this.cancelInlineEdit(input);
            }
        });

        list.addEventListener('blur', (e) => {
            const input = e.target.closest('.session-title-input');
            if (!input || input.readOnly) return;
            this.finishInlineEdit(input);
        }, true);
    }

    /**
     * Starts inline editing for a session title.
     * @param {string} sessionId - Session ID to edit
     */
    startInlineEdit(sessionId) {
        const input = document.querySelector(`.session-title-input[data-session-id="${sessionId}"]`);
        if (!input) return;

        // Store original value for cancel
        input.dataset.originalValue = input.value;

        // Enable editing
        input.readOnly = false;
        input.classList.remove('cursor-pointer');
        input.classList.add('cursor-text', 'bg-accent', 'rounded', 'px-1');

        // Select all text and focus
        input.select();
        input.focus();
    }

    /**
     * Finishes inline editing and saves the new title.
     * @param {HTMLInputElement} input - The input element
     */
    async finishInlineEdit(input) {
        const sessionId = input.dataset.sessionId;
        const newTitle = input.value.trim();
        const originalValue = input.dataset.originalValue;

        // Reset input styling
        input.readOnly = true;
        input.classList.add('cursor-pointer');
        input.classList.remove('cursor-text', 'bg-accent', 'rounded', 'px-1');

        // Only save if title changed and is not empty
        if (newTitle && newTitle !== originalValue) {
            await this.app.updateSessionTitle(sessionId, newTitle);
        } else {
            // Restore original value if empty or unchanged
            input.value = originalValue;
        }

        delete input.dataset.originalValue;
    }

    /**
     * Cancels inline editing and restores the original title.
     * @param {HTMLInputElement} input - The input element
     */
    cancelInlineEdit(input) {
        // Restore original value
        input.value = input.dataset.originalValue || input.value;

        // Reset input styling
        input.readOnly = true;
        input.classList.add('cursor-pointer');
        input.classList.remove('cursor-text', 'bg-accent', 'rounded', 'px-1');

        delete input.dataset.originalValue;
        input.blur();
    }

    closeAllMenus(exceptMenu = null) {
        const list = this.app.elements.sessionsList;
        if (!list) return;
        list.querySelectorAll('.session-menu').forEach(menu => {
            if (menu !== exceptMenu) {
                menu.classList.add('hidden');
            }
        });
    }

    shouldVirtualize(sessions) {
        return Array.isArray(sessions) && sessions.length >= VIRTUALIZE_THRESHOLD;
    }

    toggleVirtualizedClass(enabled) {
        const list = this.app.elements.sessionsList;
        if (!list) return;
        list.classList.toggle('sessions-virtualized', enabled);
    }

    getFooterText() {
        if (this.app.sessionSearchQuery.trim()) {
            if (this.app.state.sessionSearchPending) {
                return 'Searching...';
            }
            return '';
        }
        if (this.app.state.hasMoreSessions) {
            return this.app.state.isLoadingSessions ? 'Loading more...' : 'Scroll to load more';
        }
        return '';
    }

    groupSessionsByDate(sessions) {
        const grouped = {};
        sessions.forEach(session => {
            const timestamp = session.updatedAt || session.createdAt;
            const group = this.getSessionDateGroup(timestamp);
            if (!grouped[group]) {
                grouped[group] = [];
            }
            grouped[group].push(session);
        });

        Object.keys(grouped).forEach(groupName => {
            grouped[groupName].sort((a, b) => (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt));
        });

        return grouped;
    }

    renderFullList(sessionsToRender) {
        const list = this.app.elements.sessionsList;
        if (!list) return;

        const grouped = this.groupSessionsByDate(sessionsToRender);
        const groupOrder = ['Today', 'Yesterday', 'Previous 7 Days', 'Previous 30 Days', 'Older'];

        const html = groupOrder.map(groupName => {
            const sessions = grouped[groupName];
            if (!sessions || sessions.length === 0) return '';

            return `
                <div class="mb-3">
                    <div class="model-category-header px-3 flex items-center h-9">${groupName}</div>
                    ${sessions.map(session => this.buildSessionHTML(session)).join('')}
                </div>
            `;
        }).join('');

        const footerText = this.getFooterText();
        const footerHtml = footerText
            ? `<div class="px-3 py-2 text-xs text-muted-foreground">${footerText}</div>`
            : '';

        list.innerHTML = html + footerHtml;
    }

    prepareVirtualItems(sessionsToRender) {
        const grouped = this.groupSessionsByDate(sessionsToRender);
        const groupOrder = ['Today', 'Yesterday', 'Previous 7 Days', 'Previous 30 Days', 'Older'];
        const items = [];

        groupOrder.forEach(groupName => {
            const sessions = grouped[groupName];
            if (!sessions || sessions.length === 0) return;
            if (items.length) {
                items.push({ type: 'spacer' });
            }
            items.push({ type: 'header', label: groupName });
            sessions.forEach(session => {
                items.push({ type: 'session', session });
            });
        });

        const footerText = this.getFooterText();
        if (footerText) {
            items.push({ type: 'footer', text: footerText });
        }

        const offsets = [];
        let totalHeight = 0;
        items.forEach(item => {
            offsets.push(totalHeight);
            totalHeight += this.getItemHeight(item);
        });

        this.virtualState.items = items;
        this.virtualState.offsets = offsets;
        this.virtualState.totalHeight = totalHeight;
        this.virtualState.lastRange = null;
    }

    getItemHeight(item) {
        if (!item) return SESSION_ROW_HEIGHT;
        switch (item.type) {
            case 'header':
                return HEADER_ROW_HEIGHT;
            case 'spacer':
                return GROUP_SPACER_HEIGHT;
            case 'footer':
                return FOOTER_ROW_HEIGHT;
            default:
                return SESSION_ROW_HEIGHT;
        }
    }

    findIndexForOffset(offset) {
        const offsets = this.virtualState.offsets;
        let low = 0;
        let high = offsets.length - 1;
        let mid = 0;

        while (low <= high) {
            mid = Math.floor((low + high) / 2);
            if (offsets[mid] === offset) {
                return mid;
            }
            if (offsets[mid] < offset) {
                low = mid + 1;
            } else {
                high = mid - 1;
            }
        }

        return Math.max(0, low - 1);
    }

    handleScroll(force = false) {
        if (!this.virtualState.enabled) return;
        if (!force) {
            const editingInput = this.app.elements.sessionsList?.querySelector('.session-title-input:not([readonly])');
            if (editingInput) {
                this.finishInlineEdit(editingInput).catch(() => {});
                return;
            }
        }
        if (force) {
            this.renderVirtualRange(true);
            return;
        }
        if (this.virtualScrollRaf) return;
        this.virtualScrollRaf = requestAnimationFrame(() => {
            this.virtualScrollRaf = null;
            this.renderVirtualRange();
        });
    }

    renderVirtualRange(force = false) {
        const list = this.app.elements.sessionsList;
        const scrollArea = this.app.elements.sessionsScrollArea;
        if (!list || !scrollArea) return;

        const items = this.virtualState.items;
        if (!items || items.length === 0) {
            list.innerHTML = '';
            return;
        }

        const viewHeight = scrollArea.clientHeight || 0;
        const maxScrollTop = Math.max(0, this.virtualState.totalHeight - viewHeight);
        if (scrollArea.scrollTop > maxScrollTop) {
            scrollArea.scrollTop = maxScrollTop;
        }

        const scrollTop = scrollArea.scrollTop || 0;
        const startIndex = Math.max(0, this.findIndexForOffset(scrollTop) - VIRTUAL_OVERSCAN);
        const endIndex = Math.min(
            items.length - 1,
            this.findIndexForOffset(scrollTop + viewHeight) + VIRTUAL_OVERSCAN
        );

        if (!force && this.virtualState.lastRange &&
            this.virtualState.lastRange.start === startIndex &&
            this.virtualState.lastRange.end === endIndex) {
            return;
        }

        const startOffset = this.virtualState.offsets[startIndex] || 0;
        const endOffset = endIndex + 1 < items.length
            ? this.virtualState.offsets[endIndex + 1]
            : this.virtualState.totalHeight;

        const topSpacer = startOffset > 0
            ? `<div class="session-virtual-spacer" style="height:${startOffset}px;"></div>`
            : '';
        const bottomSpacerHeight = Math.max(0, this.virtualState.totalHeight - endOffset);
        const bottomSpacer = bottomSpacerHeight > 0
            ? `<div class="session-virtual-spacer" style="height:${bottomSpacerHeight}px;"></div>`
            : '';

        const visibleHtml = items
            .slice(startIndex, endIndex + 1)
            .map(item => this.buildVirtualItemHTML(item))
            .join('');

        list.innerHTML = topSpacer + visibleHtml + bottomSpacer;
        this.virtualState.lastRange = { start: startIndex, end: endIndex };
    }

    buildVirtualItemHTML(item) {
        if (!item) return '';
        if (item.type === 'header') {
            return `<div class="model-category-header px-3 flex items-center h-9">${item.label}</div>`;
        }
        if (item.type === 'spacer') {
            return '<div class="session-group-spacer"></div>';
        }
        if (item.type === 'footer') {
            return `<div class="px-3 py-2 text-xs text-muted-foreground">${item.text}</div>`;
        }
        return this.buildSessionHTML(item.session);
    }

    scrollToSession(sessionId) {
        if (!sessionId) return;
        const scrollArea = this.app.elements.sessionsScrollArea;
        const list = this.app.elements.sessionsList;
        if (!scrollArea || !list) return;

        if (this.virtualState.enabled) {
            const index = this.virtualState.items.findIndex(item =>
                item?.type === 'session' && item.session?.id === sessionId
            );
            if (index === -1) return;
            const itemTop = this.virtualState.offsets[index] || 0;
            const itemHeight = this.getItemHeight(this.virtualState.items[index]);
            const viewHeight = scrollArea.clientHeight || 0;
            const viewTop = scrollArea.scrollTop || 0;
            const viewBottom = viewTop + viewHeight;
            const itemBottom = itemTop + itemHeight;
            if (itemTop >= viewTop && itemBottom <= viewBottom) {
                return;
            }

            const targetTop = Math.max(0, itemTop - Math.max(0, (viewHeight - itemHeight) / 2));
            scrollArea.scrollTop = targetTop;
            this.handleScroll(true);
            return;
        }

        const sessionEl = list.querySelector(`.chat-session[data-session-id="${sessionId}"]`);
        if (!sessionEl) return;
        const itemRect = sessionEl.getBoundingClientRect();
        const viewRect = scrollArea.getBoundingClientRect();
        if (itemRect.top < viewRect.top || itemRect.bottom > viewRect.bottom) {
            sessionEl.scrollIntoView({ block: 'nearest' });
        }
    }

    /**
     * Gets sessions in their display order (flattened from grouped structure).
     * @returns {Array} Array of sessions in display order
     */
    getSessionsInDisplayOrder() {
        const sessionsToRender = this.app.getFilteredSessions();
        const grouped = this.groupSessionsByDate(sessionsToRender);
        const groupOrder = ['Today', 'Yesterday', 'Previous 7 Days', 'Previous 30 Days', 'Older'];

        const orderedSessions = [];
        groupOrder.forEach(groupName => {
            const sessions = grouped[groupName];
            if (sessions && sessions.length > 0) {
                orderedSessions.push(...sessions);
            }
        });

        return orderedSessions;
    }

    /**
     * Navigates to the neighboring session based on direction.
     * @param {'up' | 'down'} direction - Direction to navigate
     * @returns {boolean} True if navigation occurred
     */
    navigateSession(direction) {
        const orderedSessions = this.getSessionsInDisplayOrder();
        if (orderedSessions.length === 0) return false;

        const currentId = this.app.state.currentSessionId;
        const currentIndex = orderedSessions.findIndex(s => s.id === currentId);

        let targetIndex;
        if (direction === 'up') {
            // If no current session or at the top, don't move
            if (currentIndex <= 0) return false;
            targetIndex = currentIndex - 1;
        } else {
            // 'down'
            // If no current session, go to first; otherwise go to next
            if (currentIndex === -1) {
                targetIndex = 0;
            } else if (currentIndex >= orderedSessions.length - 1) {
                return false; // Already at bottom
            } else {
                targetIndex = currentIndex + 1;
            }
        }

        const targetSession = orderedSessions[targetIndex];
        if (targetSession) {
            this.app.switchSession(targetSession.id);
            return true;
        }
        return false;
    }
}
