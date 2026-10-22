import { showSurface, hideSurface, motionDuration } from '../ui/uiMotion.js';
/**
 * Sidebar Component
 * Manages the left sidebar including session list rendering and session controls.
 * Delegates all state changes to the main app.
 */
import preferencesStore, { PREF_KEYS } from '../services/preferencesStore.js';

const SESSION_ROW_HEIGHT = 36;
const HEADER_ROW_HEIGHT = 36;
const GROUP_SPACER_HEIGHT = 12;
const FOOTER_ROW_HEIGHT = 32;
const END_SPACER_HEIGHT = 8;
const VIRTUALIZE_THRESHOLD = 400;
const VIRTUAL_OVERSCAN = 8;
const SIDEBAR_DEFAULT_WIDTH = 220;
const SIDEBAR_MIN_WIDTH = 220;
const SIDEBAR_MAX_WIDTH = 420;
const SIDEBAR_SNAPSHOT_KEY = 'oa-left-sidebar-width';
const SESSION_MENU_GAP = 4;
const SESSION_MENU_MARGIN = 8;
const SESSION_GROUP_ORDER = ['Today', 'Yesterday', 'Previous 7 Days', 'Previous 30 Days', 'Older'];
// Row fitting may nudge each row by at most this share of its height.
const ROW_FIT_MIN_SCALE = 0.9;
const ROW_FIT_MAX_SCALE = 1.1;
const HOVER_CARD_DELAY_MS = 500;
const HOVER_CARD_GAP = 8;

/**
 * Picks a row height so the first screen of history ends exactly on a row
 * boundary: no row is cut by the footer on load. Header and chat rows scale
 * together; spacers keep their size. Chooses the boundary closest to the
 * available height (above or below), so rows change by well under a pixel at
 * normal window heights. Returns the base height when nothing would be cut
 * or when fitting would need more than a ±10% change.
 */
export function fitSessionRowHeight(items, available, {
    base = SESSION_ROW_HEIGHT,
    fixedHeight = type => (type === 'spacer' ? GROUP_SPACER_HEIGHT : type === 'footer' ? FOOTER_ROW_HEIGHT : 0),
    minScale = ROW_FIT_MIN_SCALE,
    maxScale = ROW_FIT_MAX_SCALE
} = {}) {
    if (!Array.isArray(items) || !(available > 0) || !(base > 0)) return base;
    let rows = 0;
    let fixed = 0;
    let best = null;
    for (const item of items) {
        const type = item?.type;
        if (type === 'end-spacer') break;
        if (type === 'header' || type === 'session') {
            rows += 1;
            const natural = rows * base + fixed;
            if (!best || Math.abs(natural - available) < Math.abs(best.natural - available)) {
                best = { natural, rows, fixed };
            }
            if (natural > available) break;
        } else {
            const before = rows * base + fixed;
            fixed += fixedHeight(type);
            // The edge falls inside a gap between groups: nothing is cut.
            if (before <= available && rows * base + fixed >= available) return base;
        }
    }
    if (!best) return base;
    const total = rows * base + fixed;
    // Everything fits without a cut: leave rows alone.
    if (total <= available && best.rows === rows) return base;
    const height = (available - best.fixed) / best.rows;
    const scale = height / base;
    if (scale < minScale || scale > maxScale) return base;
    return height;
}

/**
 * Places a chat row's menu against its ··· button, in viewport coordinates.
 * It opens below the button and flips above only when it does not fit below
 * but fits (or has more room) above; when neither side fits it takes the
 * roomier side and reports a maxHeight so the menu scrolls instead of clipping.
 */
export function placeSessionMenu(anchor, size, viewport, { gap = SESSION_MENU_GAP, margin = SESSION_MENU_MARGIN } = {}) {
    const below = viewport.height - anchor.bottom - gap - margin;
    const above = anchor.top - gap - margin;
    const side = size.height <= below || below >= above ? 'bottom' : 'top';
    const room = Math.max(0, side === 'bottom' ? below : above);
    const height = Math.min(size.height, room);
    const top = side === 'bottom' ? anchor.bottom + gap : anchor.top - gap - height;
    const maxLeft = viewport.width - margin - size.width;
    const left = Math.max(margin, Math.min(anchor.right - size.width, maxLeft));
    return {
        side,
        top: Math.round(top),
        left: Math.round(left),
        maxHeight: height < size.height ? Math.floor(height) : null
    };
}

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
        this.deletingSessionIds = new Set();
        this.floatingMenu = null;
        this.floatingMenuSessionId = null;
        this.requestAnimationFrame = globalThis.requestAnimationFrame?.bind(globalThis) ||
            (callback => globalThis.setTimeout?.(callback, 0));
        this.initialViewportSettled = false;
        this.initialViewportUserControlled = false;
        this.initialViewportFrame = null;
        this.rowHeight = SESSION_ROW_HEIGHT;
        this.rowFitDone = false;
        this.listItems = [];
        this.hoverCard = null;
        this.hoverCardTimer = null;
        this.hoverCardRow = null;
        this.isResizing = false;
        this.resizeStartX = 0;
        this.resizeStartWidth = 0;
        this.boundHandleResizeMove = this.handleResizeMove.bind(this);
        this.boundHandleResizeEnd = this.handleResizeEnd.bind(this);
        this.initResizableSidebar();
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

    escapeHtmlAttribute(text) {
        return String(text ?? '')
            .replace(/&/g, '&amp;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
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

    getStarIconSvg(filled = false) {
        return filled
            ? `<svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                    <path d="M11.48 3.5a.58.58 0 0 1 1.04 0l2.2 4.46c.08.17.24.29.43.32l4.92.72a.58.58 0 0 1 .32.99l-3.56 3.47a.58.58 0 0 0-.17.51l.84 4.9a.58.58 0 0 1-.84.61l-4.4-2.31a.58.58 0 0 0-.54 0l-4.4 2.31a.58.58 0 0 1-.84-.61l.84-4.9a.58.58 0 0 0-.17-.51L3.61 9.99A.58.58 0 0 1 3.93 9l4.92-.72a.58.58 0 0 0 .43-.32l2.2-4.46Z" />
                </svg>`
            : `<svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <path d="M11.48 3.5a.58.58 0 0 1 1.04 0l2.2 4.46c.08.17.24.29.43.32l4.92.72a.58.58 0 0 1 .32.99l-3.56 3.47a.58.58 0 0 0-.17.51l.84 4.9a.58.58 0 0 1-.84.61l-4.4-2.31a.58.58 0 0 0-.54 0l-4.4 2.31a.58.58 0 0 1-.84-.61l.84-4.9a.58.58 0 0 0-.17-.51L3.61 9.99A.58.58 0 0 1 3.93 9l4.92-.72a.58.58 0 0 0 .43-.32l2.2-4.46Z" />
                </svg>`;
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

        this.listItems = this.buildListItems(sessionsToRender);
        this.applyRowFit({ rerender: false });
        if (shouldVirtualize) {
            this.prepareVirtualItems(sessionsToRender);
            this.renderVirtualRange(true);
        } else {
            this.renderFullList(sessionsToRender);
        }
        this.scheduleInitialViewportSettlement(sessionsToRender.length > 0);
        this.updateScrollFade();
    }

    /**
     * Flat list of what the sidebar shows, top to bottom. Shared by the full
     * and virtualized renderers and by row fitting.
     */
    buildListItems(sessionsToRender) {
        const grouped = this.groupSessionsByDate(sessionsToRender);
        const items = [];
        SESSION_GROUP_ORDER.forEach(groupName => {
            const sessions = grouped[groupName];
            if (!sessions || sessions.length === 0) return;
            if (items.length) items.push({ type: 'spacer' });
            items.push({ type: 'header', label: groupName });
            sessions.forEach(session => items.push({ type: 'session', session }));
        });
        const footerText = this.getFooterText();
        if (footerText) items.push({ type: 'footer', text: footerText });
        if (items.length) items.push({ type: 'end-spacer' });
        return items;
    }

    /**
     * Sizes rows once, when history first appears, so the opening screen ends
     * on a whole row (see fitSessionRowHeight). The height then stays fixed:
     * resizing the window or adding chats never re-fits, so rows don't shift
     * while someone is looking at them. A later visit fits again.
     */
    applyRowFit({ rerender = true } = {}) {
        if (this.rowFitDone) return;
        const list = this.app.elements.sessionsList;
        const scrollArea = this.app.elements.sessionsScrollArea;
        if (!list || !scrollArea) return;
        const available = scrollArea.clientHeight || 0;
        // Wait for real history in a visible list (e.g. a collapsed sidebar).
        if (!available || !this.listItems.some(item => item.type === 'session')) return;
        this.rowFitDone = true;
        this.rowFitObserver?.disconnect?.();
        const height = fitSessionRowHeight(this.listItems, available);
        if (height === this.rowHeight) return;
        this.rowHeight = height;
        list.style?.setProperty?.('--session-row-h', `${height}px`);
        if (rerender && this.virtualState.enabled) {
            this.recomputeVirtualOffsets();
            this.renderVirtualRange(true);
        }
        this.updateScrollFade();
    }

    getSessionTitleActivity(session) {
        const responding = !this.deletingSessionIds.has(session.id)
            && session.id !== this.app.state.currentSessionId
            && this.app.isSessionStreaming?.(session.id) === true;
        return {
            responding,
            generating: responding || Boolean(session.titleGenerationPending && session.titleSource === 'local')
        };
    }

    // Patch the existing title nodes so completion cannot disrupt a rename,
    // reset a glimmer on another row, or rebuild a virtualized session list.
    updateSessionActivity(sessionId = null) {
        const inputs = this.app.elements.sessionsList?.querySelectorAll('.session-title-input') || [];
        for (const input of inputs) {
            const id = input.dataset.sessionId;
            if (sessionId && id !== sessionId) continue;
            const session = this.app.state.sessionsById?.get(id);
            if (!session) continue;
            const { generating, responding } = this.getSessionTitleActivity(session);
            input.classList.toggle('session-title-generating', generating);
            if (responding) input.setAttribute('aria-description', 'Response in progress');
            else input.removeAttribute('aria-description');
        }
    }

    /**
     * Builds HTML for a single session item.
     * @param {Object} session - Session object
     * @returns {string} HTML string
     */
    buildSessionHTML(session) {
        const isActive = session.id === this.app.state.currentSessionId;
        const isDeleting = this.deletingSessionIds.has(session.id);
        const titleClasses = [];
        if (session.title === 'New Chat') {
            titleClasses.push('italic', 'text-muted-foreground');
        }
        const { generating, responding } = this.getSessionTitleActivity(session);
        if (generating) {
            titleClasses.push('session-title-generating');
        }
        const titleClass = titleClasses.join(' ');
        const isShared = !!session.shareInfo?.shareId;
        const isStarred = !!session.starred;
        // Show imported indicator for pure imports and forked imports (not local forks)
        // forkedFrom alone (without importedMessageCount) indicates a LOCAL fork, not an import
        const isImported = !!(session.importedFrom || session.importedSource ||
            (session.forkedFrom && (session.importedMessageCount || 0) > 0));
        const shareLabel = isShared ? 'Update Share' : 'Share';

        // Build indicator icons
        let indicatorHtml = `<span class="session-delete-progress session-operation-status ${isDeleting ? '' : 'hidden'} ml-1 flex-shrink-0" data-tone="working" aria-hidden="true"><span></span></span>`;
        const status = this.app.presentation?.getSessionStatus?.(session);
        if (status?.label) {
            const tone = ['working', 'waiting', 'success', 'error'].includes(status.tone) ? status.tone : 'working';
            const label = this.escapeHtmlAttribute(status.label);
            indicatorHtml += `<span class="session-operation-status ml-1 flex-shrink-0" data-tone="${tone}" title="${label}" aria-label="${label}"><span aria-hidden="true">${tone === 'success' ? '✓' : tone === 'error' ? '!' : ''}</span></span>`;
        }
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
            <div class="group relative flex h-9 items-center rounded-lg ${isActive ? 'chat-session active' : 'hover-highlight'} transition-colors pl-3 pr-2 chat-session" data-session-id="${session.id}" data-deleting="${isDeleting}" aria-busy="${isDeleting}">
                <a class="flex flex-1 items-center justify-between h-full min-w-0 text-foreground hover:text-foreground cursor-pointer">
                    <div class="session-title-wrap flex min-w-0 flex-1 items-center">
                        <input class="session-title-input w-full cursor-pointer truncate bg-transparent text-sm leading-5 focus:outline-none text-foreground ${titleClass}" placeholder="Untitled Chat" readonly ${responding ? 'aria-description="Response in progress"' : ''} data-session-id="${this.escapeHtmlAttribute(session.id)}" value="${this.escapeHtmlAttribute(session.title)}">
                        ${indicatorHtml}
                    </div>
                </a>
                <div class="session-row-actions">
                    <button class="session-star-btn${isStarred ? ' session-star-btn--starred' : ''} rounded-md" aria-label="${isStarred ? 'Unstar chat' : 'Star chat'}" title="${isStarred ? 'Unstar' : 'Star'}" aria-pressed="${isStarred ? 'true' : 'false'}" data-session-id="${this.escapeHtmlAttribute(session.id)}">
                        ${this.getStarIconSvg(isStarred)}
                    </button>
                    <button class="session-menu-btn inline-flex items-center justify-center whitespace-nowrap rounded-md font-medium transition-colors focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50 gap-2 leading-6 text-muted-foreground border border-transparent h-7 w-7" aria-label="Session options" aria-haspopup="menu" aria-expanded="false" data-session-id="${session.id}">
                        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor" class="w-5 h-5">
                            <path stroke-linecap="round" stroke-linejoin="round" d="M6.75 12a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0ZM12.75 12a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0ZM18.75 12a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0Z" />
                        </svg>
                    </button>
                    <div class="session-menu hidden absolute right-0 top-10 z-[100] rounded-lg border border-border bg-popover shadow-lg p-1 min-w-[175px]" data-session-id="${session.id}">
                        <button class="rename-session-action w-full text-left px-3 py-2 text-sm text-popover-foreground hover-highlight hover:text-accent-foreground rounded-md transition-colors" data-session-id="${session.id}">Rename</button>
                        <button class="toggle-star-session-action w-full text-left px-3 py-2 text-sm text-popover-foreground hover-highlight hover:text-accent-foreground rounded-md transition-colors" data-session-id="${session.id}">${isStarred ? 'Unstar' : 'Star'}</button>
                        <button class="copy-link-action w-full text-left px-3 py-2 text-sm text-popover-foreground hover-highlight hover:text-accent-foreground rounded-md transition-colors" data-session-id="${session.id}">Copy Link</button>
                        <button class="share-session-action w-full text-left px-3 py-2 text-sm text-popover-foreground hover-highlight hover:text-accent-foreground rounded-md transition-colors" data-session-id="${session.id}">${shareLabel}</button>
                        ${isShared ? `<button class="delete-share-action w-full text-left px-3 py-2 text-sm text-popover-foreground hover-highlight hover:text-accent-foreground rounded-md transition-colors" data-session-id="${session.id}">Delete Share</button>` : ''}
                        <button class="export-pdf-action w-full text-left px-3 py-2 text-sm text-popover-foreground hover-highlight hover:text-accent-foreground rounded-md transition-colors" data-session-id="${session.id}">Export as PDF</button>
                        <button class="export-markdown-action w-full text-left px-3 py-2 text-sm text-popover-foreground hover-highlight hover:text-accent-foreground rounded-md transition-colors" data-session-id="${session.id}">Export as Markdown</button>
                        <div class="session-menu-separator" role="separator"></div>
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

        const scrollArea = this.app.elements.sessionsScrollArea;
        const releaseInitialViewport = () => this.releaseInitialViewportSettlement();
        scrollArea?.addEventListener('wheel', releaseInitialViewport, { passive: true });
        scrollArea?.addEventListener('touchstart', releaseInitialViewport, { passive: true });
        scrollArea?.addEventListener('pointerdown', releaseInitialViewport, { passive: true });
        scrollArea?.addEventListener('keydown', releaseInitialViewport);

        const handleClick = async (e) => {
            this.releaseInitialViewportSettlement();
            const starBtn = e.target.closest('.session-star-btn');
            if (starBtn) {
                e.preventDefault();
                e.stopPropagation();
                this.closeAllMenus();
                this.hideHoverCard();
                await this.app.toggleSessionStar(starBtn.dataset.sessionId);
                return;
            }

            const starAction = e.target.closest('.toggle-star-session-action');
            if (starAction) {
                e.stopPropagation();
                const sessionId = starAction.dataset.sessionId;
                this.closeAllMenus();
                await this.app.toggleSessionStar(sessionId);
                return;
            }

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
                if (this.deletingSessionIds.has(sessionId)) return;
                this.deletingSessionIds.add(sessionId);
                this.setSessionDeletionBusy(sessionId, true, deleteAction);
                this.closeAllMenus();
                try {
                    await this.app.deleteSession(sessionId);
                } finally {
                    this.deletingSessionIds.delete(sessionId);
                    this.setSessionDeletionBusy(sessionId, false, deleteAction);
                }
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

            const exportMarkdownAction = e.target.closest('.export-markdown-action');
            if (exportMarkdownAction) {
                e.stopPropagation();
                const sessionId = exportMarkdownAction.dataset.sessionId;
                this.closeAllMenus();
                await this.app.exportChatAsMarkdown(sessionId);
                return;
            }

            const menuBtn = e.target.closest('.session-menu-btn');
            if (menuBtn) {
                e.stopPropagation();
                this.toggleSessionMenu(menuBtn, { focusMenu: e.detail === 0 });
                return;
            }

            if (e.target.closest('.session-menu')) {
                return;
            }

            const sessionEl = e.target.closest('.chat-session');
            if (sessionEl) {
                const sessionId = sessionEl.dataset.sessionId;
                if (this.deletingSessionIds.has(sessionId)) return;
                this.closeAllMenus();
                this.app.switchSession(sessionId);
            }
        };
        this.handleSessionListClick = handleClick;
        list.addEventListener('click', handleClick);

        const view = list.ownerDocument?.defaultView;
        // Only until the first fit: covers history that loads while the
        // sidebar is collapsed or not yet laid out.
        if (scrollArea && view?.ResizeObserver) {
            this.rowFitObserver = new view.ResizeObserver(() => this.applyRowFit());
            this.rowFitObserver.observe(scrollArea);
        }
        this.attachHoverCard(list);

        // The open menu lives at body level (see openSessionMenu), so it
        // needs its own outside-click, Escape and resize handling.
        const doc = list.ownerDocument;
        doc?.addEventListener?.('click', (e) => {
            if (this.floatingMenu && !this.floatingMenu.contains(e.target)) this.closeFloatingMenu();
        });
        doc?.addEventListener?.('keydown', (e) => {
            if (e.key === 'Escape' && this.floatingMenu) this.closeFloatingMenu({ restoreFocus: true });
            else if ((e.metaKey || e.ctrlKey) && this.floatingMenu) this.closeFloatingMenu();
        });
        doc?.addEventListener?.('focusin', (e) => {
            if (!this.floatingMenu || this.floatingMenu.contains(e.target)) return;
            const anchor = this.findSessionRow(this.floatingMenuSessionId)?.querySelector('.session-menu-btn');
            if (e.target !== anchor) this.closeFloatingMenu();
        });
        doc?.defaultView?.addEventListener?.('resize', () => {
            if (this.floatingMenu) this.closeFloatingMenu();
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

    initResizableSidebar() {
        const sidebar = this.app.elements.sidebar;
        if (!sidebar) return;

        const snapshotWidth = this.getSnapshotSidebarWidth();
        if (snapshotWidth !== null) {
            this.applySidebarWidth(snapshotWidth, { persist: false });
        }
        void this.restoreSidebarWidthPreference();

        if (!sidebar.querySelector('.sidebar-resize-handle')) {
            const handle = document.createElement('div');
            handle.className = 'sidebar-resize-handle';
            handle.setAttribute('role', 'separator');
            handle.setAttribute('aria-label', 'Resize sidebar');
            handle.setAttribute('aria-orientation', 'vertical');
            handle.addEventListener('mousedown', (e) => {
                e.preventDefault();
                this.startResize(e.clientX);
            });
            handle.addEventListener('touchstart', (e) => {
                const touch = e.touches?.[0];
                if (!touch) return;
                e.preventDefault();
                this.startResize(touch.clientX);
            }, { passive: false });
            sidebar.appendChild(handle);
        }

        window.addEventListener('resize', () => {
            // A narrow viewport changes presentation, never the saved desktop width.
            this.applySidebarWidth(this.preferredSidebarWidth || SIDEBAR_DEFAULT_WIDTH, {
                persist: false, layoutOnly: true
            });
        });
    }

    getSnapshotSidebarWidth() {
        try {
            const raw = localStorage.getItem(SIDEBAR_SNAPSHOT_KEY);
            const parsed = parseInt(raw, 10);
            if (!Number.isFinite(parsed)) return null;
            return Math.max(SIDEBAR_MIN_WIDTH, Math.min(SIDEBAR_MAX_WIDTH, parsed));
        } catch (error) {
            return null;
        }
    }

    async restoreSidebarWidthPreference() {
        try {
            const storedWidth = await preferencesStore.getPreference(PREF_KEYS.leftSidebarWidth, {
                defaultValue: SIDEBAR_DEFAULT_WIDTH
            });
            if (!Number.isFinite(storedWidth) || storedWidth <= 0) return;
            this.applySidebarWidth(storedWidth, { persist: false });
        } catch (error) {
            // Keep current width if preferences are unavailable.
        }
    }

    clampSidebarWidth(width) {
        const layoutMaxWidth = window.innerWidth < 1100 ? SIDEBAR_MAX_WIDTH
            : Math.max(SIDEBAR_MIN_WIDTH, window.innerWidth - 848);
        const maxWidth = Math.max(SIDEBAR_MIN_WIDTH, Math.min(SIDEBAR_MAX_WIDTH, layoutMaxWidth));
        return Math.max(SIDEBAR_MIN_WIDTH, Math.min(maxWidth, Math.round(width)));
    }

    applySidebarWidth(width, options = {}) {
        const { persist = true, layoutOnly = false } = options;
        const sidebar = this.app.elements.sidebar;
        if (!sidebar) return;

        if (!layoutOnly) this.preferredSidebarWidth = Math.max(SIDEBAR_MIN_WIDTH, Math.min(SIDEBAR_MAX_WIDTH, width));
        const clampedWidth = this.clampSidebarWidth(width);
        sidebar.style.width = `${clampedWidth}px`;
        document.documentElement.style.setProperty('--oa-left-sidebar-width', `${clampedWidth}px`);

        if (persist) {
            void preferencesStore.savePreference(PREF_KEYS.leftSidebarWidth, clampedWidth);
        }
    }

    startResize(clientX) {
        if (window.innerWidth < 1100) return;
        const sidebar = this.app.elements.sidebar;
        if (!sidebar || sidebar.classList.contains('sidebar-hidden')) return;

        this.isResizing = true;
        this.resizeStartX = clientX;
        this.resizeStartWidth = sidebar.getBoundingClientRect().width || SIDEBAR_DEFAULT_WIDTH;

        document.body.classList.add('sidebar-resizing');
        window.addEventListener('mousemove', this.boundHandleResizeMove);
        window.addEventListener('mouseup', this.boundHandleResizeEnd);
        window.addEventListener('touchmove', this.boundHandleResizeMove, { passive: false });
        window.addEventListener('touchend', this.boundHandleResizeEnd);
    }

    handleResizeMove(e) {
        if (!this.isResizing) return;

        const isTouch = e.type === 'touchmove';
        const clientX = isTouch ? e.touches?.[0]?.clientX : e.clientX;
        if (!Number.isFinite(clientX)) return;
        if (isTouch) {
            e.preventDefault();
        }

        const delta = clientX - this.resizeStartX;
        const nextWidth = this.resizeStartWidth + delta;
        this.applySidebarWidth(nextWidth, { persist: false });
    }

    handleResizeEnd() {
        if (!this.isResizing) return;
        this.isResizing = false;

        const sidebar = this.app.elements.sidebar;
        if (sidebar) {
            const finalWidth = parseFloat(sidebar.style.width) || SIDEBAR_DEFAULT_WIDTH;
            this.applySidebarWidth(finalWidth, { persist: true });
        }

        document.body.classList.remove('sidebar-resizing');
        window.removeEventListener('mousemove', this.boundHandleResizeMove);
        window.removeEventListener('mouseup', this.boundHandleResizeEnd);
        window.removeEventListener('touchmove', this.boundHandleResizeMove);
        window.removeEventListener('touchend', this.boundHandleResizeEnd);
        this.app.updateToolbarDivider();
    }

    /**
     * Opens or closes a chat row's menu from its ··· button.
     * @param {HTMLElement} button
     */
    toggleSessionMenu(button, options = {}) {
        const wasOpen = this.isFloatingMenuOpen(button?.dataset?.sessionId);
        this.closeAllMenus();
        if (!wasOpen) this.openSessionMenu(button, options);
    }

    isFloatingMenuOpen(sessionId = null) {
        const menu = this.floatingMenu;
        if (!menu?.isConnected || menu.classList.contains('hidden')) return false;
        return sessionId == null || this.floatingMenuSessionId === sessionId;
    }

    /**
     * The row's menu markup is a template: a copy is shown at body level so
     * the scrolling list (overflow) can never clip it, placed by
     * placeSessionMenu against the button.
     * @param {HTMLElement} button
     */
    openSessionMenu(button, { focusMenu = false } = {}) {
        const row = button?.closest?.('.chat-session');
        const template = row?.querySelector('.session-menu');
        const doc = button?.ownerDocument;
        if (!template || !doc?.body) return;

        doc.querySelectorAll('.session-menu--floating').forEach(stale => stale.remove());
        const menu = template.cloneNode(true);
        menu.classList.add('session-menu--floating');
        menu.addEventListener('click', (e) => {
            e.stopPropagation();
            this.handleSessionListClick?.(e);
        });
        doc.body.appendChild(menu);
        this.floatingMenu = menu;
        this.floatingMenuSessionId = button.dataset.sessionId;
        this.positionFloatingMenu(button);
        this.setSessionMenuAnchorState(row, button, true);
        showSurface(menu, 'dropdown');
        if (focusMenu) menu.querySelector('button:not(:disabled)')?.focus?.({ preventScroll: true });
    }

    positionFloatingMenu(button) {
        const menu = this.floatingMenu;
        if (!menu || !button?.getBoundingClientRect) return;
        const doc = menu.ownerDocument;
        const view = doc.defaultView;
        const wasHidden = menu.classList.contains('hidden');
        menu.style.maxHeight = '';
        // Measured in the same task it is shown in, so the hidden state never paints.
        if (wasHidden) menu.classList.remove('hidden');
        const size = { width: menu.offsetWidth, height: menu.offsetHeight };
        if (wasHidden) menu.classList.add('hidden');
        const viewport = {
            width: doc.documentElement?.clientWidth || view?.innerWidth || 0,
            height: view?.innerHeight || doc.documentElement?.clientHeight || 0
        };
        const place = placeSessionMenu(button.getBoundingClientRect(), size, viewport);
        menu.style.top = `${place.top}px`;
        menu.style.left = `${place.left}px`;
        menu.style.maxHeight = place.maxHeight !== null ? `${place.maxHeight}px` : '';
        menu.dataset.side = place.side;
        menu.dataset.origin = place.side === 'top' ? 'bottom-right' : 'top-right';
    }

    findSessionRow(sessionId) {
        const list = this.app.elements.sessionsList;
        if (!list || sessionId == null) return null;
        return [...list.querySelectorAll('.chat-session')]
            .find(row => row.dataset.sessionId === sessionId) || null;
    }

    setSessionMenuAnchorState(row, button, open) {
        row?.toggleAttribute?.('data-menu-open', open);
        button?.setAttribute?.('aria-expanded', open ? 'true' : 'false');
    }

    closeFloatingMenu({ restoreFocus = false } = {}) {
        const menu = this.floatingMenu;
        if (!menu) return;
        const row = this.findSessionRow(this.floatingMenuSessionId);
        const button = row?.querySelector('.session-menu-btn');
        this.floatingMenu = null;
        this.floatingMenuSessionId = null;
        this.setSessionMenuAnchorState(row, button, false);
        if (restoreFocus) button?.focus?.({ preventScroll: true });
        hideSurface(menu, { remove: true });
        // The app's global Escape/outside-click handlers may have started the
        // exit already (without removal); drop the copy once it has faded.
        const view = menu.ownerDocument?.defaultView;
        view?.setTimeout?.(() => {
            if (menu !== this.floatingMenu && menu.classList.contains('hidden')) menu.remove();
        }, motionDuration(menu, '--dropdown-close-dur') + 50);
    }

    /**
     * Keeps an open menu attached across list re-renders: re-anchors it to
     * the new row's button, or closes it when that row is gone.
     */
    syncFloatingMenu() {
        if (!this.floatingMenu) return;
        if (!this.isFloatingMenuOpen()) {
            this.closeFloatingMenu();
            return;
        }
        const row = this.findSessionRow(this.floatingMenuSessionId);
        const button = row?.querySelector('.session-menu-btn');
        if (!button) {
            this.closeFloatingMenu();
            return;
        }
        this.setSessionMenuAnchorState(row, button, true);
        this.positionFloatingMenu(button);
    }

    closeAllMenus(exceptMenu = null) {
        if (this.floatingMenu && this.floatingMenu !== exceptMenu) this.closeFloatingMenu();
        const list = this.app.elements.sessionsList;
        if (!list) return;
        list.querySelectorAll('.session-menu').forEach(menu => {
            if (menu !== exceptMenu) {
                hideSurface(menu);
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
        if (this.app.hasActiveSessionListCriteria()) {
            if (this.app.state.sessionSearchPending) {
                return this.app.sessionSearchQuery.trim() ? 'Searching...' : 'Filtering...';
            }
            return '';
        }
        if (this.app.state.hasMoreSessions) {
            return this.app.state.isLoadingSessions ? 'Loading more...' : 'Scroll to load more';
        }
        return '';
    }

    setSessionDeletionBusy(sessionId, busy, action = null) {
        const list = this.app.elements.sessionsList;
        if (!list) return;
        const row = [...list.querySelectorAll('.chat-session')]
            .find(element => element.dataset.sessionId === sessionId);
        if (!row) return;
        row.dataset.deleting = busy ? 'true' : 'false';
        row.setAttribute('aria-busy', busy ? 'true' : 'false');
        row.querySelector('.session-delete-progress')?.classList.toggle('hidden', !busy);
        row.querySelectorAll('.session-star-btn, .session-menu-btn').forEach(button => { button.disabled = busy; });
        const deleteAction = action?.isConnected ? action : row.querySelector('.delete-session-action');
        if (deleteAction) {
            deleteAction.disabled = busy;
            deleteAction.setAttribute('aria-busy', busy ? 'true' : 'false');
        }
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
        const groupOrder = SESSION_GROUP_ORDER;

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

        const emptyHtml = !html && !footerHtml
            ? `<div class="px-3 py-3 text-xs text-muted-foreground">${this.escapeHtml(this.app.getSessionListEmptyText())}</div>`
            : '';
        const endSpacerHtml = html || footerHtml
            ? '<div class="session-list-end-spacer" aria-hidden="true"></div>'
            : '';

        list.innerHTML = html + footerHtml + emptyHtml + endSpacerHtml;
        this.syncFloatingMenu();
    }

    prepareVirtualItems(sessionsToRender) {
        const items = this.listItems?.length ? this.listItems : this.buildListItems(sessionsToRender);
        this.virtualState.items = items;
        this.recomputeVirtualOffsets();
        this.virtualState.lastRange = null;
    }

    recomputeVirtualOffsets() {
        const offsets = [];
        let totalHeight = 0;
        this.virtualState.items.forEach(item => {
            offsets.push(totalHeight);
            totalHeight += this.getItemHeight(item);
        });
        this.virtualState.offsets = offsets;
        this.virtualState.totalHeight = totalHeight;
    }

    getItemHeight(item) {
        if (!item) return SESSION_ROW_HEIGHT;
        switch (item.type) {
            case 'header':
                return this.rowHeight ?? HEADER_ROW_HEIGHT;
            case 'spacer':
                return GROUP_SPACER_HEIGHT;
            case 'footer':
                return FOOTER_ROW_HEIGHT;
            case 'end-spacer':
                return END_SPACER_HEIGHT;
            default:
                return this.rowHeight ?? SESSION_ROW_HEIGHT;
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
        // The menu is fixed to the viewport; scrolling the list would leave it behind.
        if (this.floatingMenu) this.closeFloatingMenu();
        if (this.hoverCard && !this.hoverCard.hidden) this.hideHoverCard();
        this.updateScrollFade();
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
            this.updateScrollFade();
        });
    }

    scheduleInitialViewportSettlement(hasSessions) {
        if (
            !hasSessions ||
            this.initialViewportSettled ||
            this.initialViewportUserControlled ||
            this.initialViewportFrame != null
        ) return;

        this.initialViewportFrame = this.requestAnimationFrame(() => {
            this.initialViewportFrame = null;
            if (this.initialViewportUserControlled) return;
            const scrollArea = this.app.elements.sessionsScrollArea;
            if (!scrollArea) return;

            // Browser scroll restoration can leave the first painted history
            // at a fractional offset. Normalize only this initial paint;
            // afterward the user can scroll freely.
            scrollArea.scrollTop = 0;
            if (this.virtualState.enabled) this.renderVirtualRange(true);
            this.initialViewportSettled = true;
            this.updateScrollFade();
        });
    }

    releaseInitialViewportSettlement() {
        this.initialViewportUserControlled = true;
        this.initialViewportSettled = true;
    }

    updateScrollFade() {
        const scrollArea = this.app.elements.sessionsScrollArea;
        const shell = scrollArea?.closest?.('.session-scroll-shell');
        if (!scrollArea || !shell) return;
        const hasMoreBelow = scrollArea.scrollHeight - scrollArea.scrollTop - scrollArea.clientHeight > 1;
        shell.classList.toggle('has-more-below', hasMoreBelow);
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
        this.syncFloatingMenu();
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
        if (item.type === 'end-spacer') {
            return '<div class="session-list-end-spacer" aria-hidden="true"></div>';
        }
        return this.buildSessionHTML(item.session);
    }

    /**
     * Full-title card beside the sidebar for chats whose title is cut off.
     * Pointer devices only; appears after a short rest, then follows the
     * pointer row to row without waiting again.
     */
    attachHoverCard(list) {
        const view = list.ownerDocument?.defaultView;
        if (!view?.matchMedia?.('(hover: hover) and (pointer: fine)')?.matches) return;
        list.addEventListener('pointerover', (e) => {
            const row = e.target.closest?.('.chat-session');
            if (!row || row === this.hoverCardRow) return;
            this.hoverCardRow = row;
            view.clearTimeout(this.hoverCardTimer);
            if (this.hoverCard && !this.hoverCard.hidden) {
                this.showHoverCard(row);
            } else {
                this.hoverCardTimer = view.setTimeout(() => this.showHoverCard(row), HOVER_CARD_DELAY_MS);
            }
        });
        list.addEventListener('pointerleave', () => this.hideHoverCard());
        list.addEventListener('pointerdown', () => this.hideHoverCard());
        this.app.elements.sessionsScrollArea?.addEventListener('scroll', () => this.hideHoverCard(), { passive: true });
        view.addEventListener('blur', () => this.hideHoverCard());
    }

    showHoverCard(row) {
        if (!row?.isConnected || row !== this.hoverCardRow || this.floatingMenu) return this.hideHoverCard({ keepRow: true });
        const input = row.querySelector('.session-title-input');
        if (!input || !input.readOnly || input.scrollWidth <= input.clientWidth + 1) {
            return this.hideHoverCard({ keepRow: true });
        }
        const sessionId = row.dataset.sessionId;
        const session = this.app.state.sessionsById?.get?.(sessionId)
            || this.app.state.sessions?.find?.(s => s.id === sessionId);
        const doc = row.ownerDocument;
        if (!this.hoverCard) {
            this.hoverCard = doc.createElement('div');
            this.hoverCard.className = 'session-hover-card';
            this.hoverCard.setAttribute('aria-hidden', 'true');
            this.hoverCard.hidden = true;
            doc.body.appendChild(this.hoverCard);
        }
        const time = this.formatTimeAgo(session?.updatedAt || session?.createdAt);
        this.hoverCard.innerHTML = `<div class="session-hover-card-title">${this.escapeHtml(input.value)}</div>`
            + (time ? `<div class="session-hover-card-time">${time}</div>` : '');
        this.hoverCard.hidden = false;
        const rowRect = row.getBoundingClientRect();
        const sidebarRect = (this.app.elements.sidebar || row.closest('aside'))?.getBoundingClientRect?.() || rowRect;
        const cardHeight = this.hoverCard.offsetHeight;
        const viewHeight = doc.defaultView?.innerHeight || 0;
        const top = Math.max(8, Math.min(rowRect.top + rowRect.height / 2 - cardHeight / 2, viewHeight - cardHeight - 8));
        this.hoverCard.style.top = `${Math.round(top)}px`;
        this.hoverCard.style.left = `${Math.round(sidebarRect.right + HOVER_CARD_GAP)}px`;
    }

    hideHoverCard({ keepRow = false } = {}) {
        globalThis.clearTimeout?.(this.hoverCardTimer);
        this.hoverCardTimer = null;
        if (!keepRow) this.hoverCardRow = null;
        if (this.hoverCard) this.hoverCard.hidden = true;
    }

    formatTimeAgo(timestamp) {
        if (!timestamp) return '';
        const minutes = Math.floor((Date.now() - timestamp) / 60000);
        if (minutes < 1) return 'just now';
        if (minutes < 60) return `${minutes}m ago`;
        const hours = Math.floor(minutes / 60);
        if (hours < 24) return `${hours}h ago`;
        const days = Math.floor(hours / 24);
        if (days < 30) return `${days}d ago`;
        const months = Math.floor(days / 30);
        if (months < 12) return `${months}mo ago`;
        return `${Math.floor(days / 365)}y ago`;
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
        const groupOrder = SESSION_GROUP_ORDER;

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
