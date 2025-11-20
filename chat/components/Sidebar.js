/**
 * Sidebar Component
 * Manages the left sidebar including session list rendering and session controls.
 * Delegates all state changes to the main app.
 */

export default class Sidebar {
    /**
     * @param {Object} app - Reference to the main ChatApp instance
     */
    constructor(app) {
        this.app = app;
    }

    /**
     * Scrolls the sessions list to the top.
     */
    scrollToTop() {
        if (this.app.elements.sessionsScrollArea) {
            this.app.elements.sessionsScrollArea.scrollTop = 0;
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

        if (diffDays === 0) return 'TODAY';
        if (diffDays === 1) return 'YESTERDAY';
        if (diffDays <= 7) return 'PREVIOUS 7 DAYS';
        if (diffDays <= 30) return 'PREVIOUS 30 DAYS';
        return 'OLDER';
    }

    /**
     * Renders the sessions list grouped by date.
     * Wires up event listeners for session clicks, menu toggles, and delete actions.
     */
    render() {
        // Get filtered sessions based on search query
        const sessionsToRender = this.app.getFilteredSessions();

        // Group sessions by date (using updatedAt so active sessions move to TODAY)
        const grouped = {};
        const groupOrder = ['TODAY', 'YESTERDAY', 'PREVIOUS 7 DAYS', 'PREVIOUS 30 DAYS', 'OLDER'];

        sessionsToRender.forEach(session => {
            // Use updatedAt if available, otherwise fall back to createdAt
            const timestamp = session.updatedAt || session.createdAt;
            const group = this.getSessionDateGroup(timestamp);
            if (!grouped[group]) {
                grouped[group] = [];
            }
            grouped[group].push(session);
        });

        // Sort sessions within each group by updatedAt (most recent first)
        Object.keys(grouped).forEach(groupName => {
            grouped[groupName].sort((a, b) => (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt));
        });

        // Build HTML for grouped sessions
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

        this.app.elements.sessionsList.innerHTML = html;

        // Wire up event listeners
        this.attachEventListeners();
    }

    /**
     * Builds HTML for a single session item.
     * @param {Object} session - Session object
     * @returns {string} HTML string
     */
    buildSessionHTML(session) {
        const isActive = session.id === this.app.state.currentSessionId;
        const titleClass = session.title === 'New Chat' ? 'italic text-muted-foreground' : '';

        return `
            <div class="group relative flex h-9 items-center rounded-lg ${isActive ? 'chat-session active' : 'hover-highlight'} transition-colors pl-3 chat-session" data-session-id="${session.id}">
                <a class="flex flex-1 items-center justify-between h-full min-w-0 text-foreground hover:text-foreground cursor-pointer">
                    <div class="flex min-w-0 flex-1 items-center">
                        <input class="w-full cursor-pointer truncate bg-transparent text-sm leading-5 focus:outline-none text-foreground ${titleClass}" placeholder="Untitled Chat" readonly value="${this.escapeHtml(session.title)}">
                    </div>
                </a>
                <div class="flex shrink-0 items-center relative">
                    <button class="session-menu-btn inline-flex items-center justify-center whitespace-nowrap rounded-md font-medium transition-colors focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50 gap-2 leading-6 text-muted-foreground hover:bg-accent hover:text-accent-foreground border border-transparent h-9 w-9 group-hover:opacity-100 md:opacity-0" aria-label="Session options" data-session-id="${session.id}">
                        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="w-5 h-5">
                            <path stroke-linecap="round" stroke-linejoin="round" d="M12 6.75a.75.75 0 1 1 0-1.5.75.75 0 0 1 0 1.5ZM12 12.75a.75.75 0 1 1 0-1.5.75.75 0 0 1 0 1.5ZM12 18.75a.75.75 0 1 1 0-1.5.75.75 0 0 1 0 1.5Z" />
                        </svg>
                    </button>
                    <div class="session-menu hidden absolute right-0 top-10 z-[100] rounded-lg border border-border bg-popover shadow-lg p-1 min-w-[140px]" data-session-id="${session.id}">
                        <button class="delete-session-action w-full text-left px-3 py-2 text-sm text-popover-foreground hover-highlight hover:text-accent-foreground rounded-md transition-colors" data-session-id="${session.id}">Delete</button>
                    </div>
                </div>
            </div>
        `;
    }

    /**
     * Attaches event listeners to session elements.
     * Handles session switching, menu toggle, and delete actions.
     */
    attachEventListeners() {
        // Session click to switch
        document.querySelectorAll('.chat-session').forEach(el => {
            el.addEventListener('click', (e) => {
                if (!e.target.closest('.session-menu-btn') && !e.target.closest('.session-menu')) {
                    this.app.switchSession(el.dataset.sessionId);
                }
            });
        });

        // Session menu toggle
        document.querySelectorAll('.session-menu-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const sessionId = btn.dataset.sessionId;
                const menu = document.querySelector(`.session-menu[data-session-id="${sessionId}"]`);

                // Close all other session menus
                document.querySelectorAll('.session-menu').forEach(m => {
                    if (m !== menu) m.classList.add('hidden');
                });

                menu.classList.toggle('hidden');
            });
        });

        // Delete session action
        document.querySelectorAll('.delete-session-action').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const sessionId = btn.dataset.sessionId;
                this.app.deleteSession(sessionId);
                // Menu will be removed when sessions are re-rendered
            });
        });
    }
}

