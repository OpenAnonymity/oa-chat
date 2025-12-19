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

        if (diffDays === 0) return 'Today';
        if (diffDays === 1) return 'Yesterday';
        if (diffDays <= 7) return 'Previous 7 Days';
        if (diffDays <= 30) return 'Previous 30 Days';
        return 'Older';
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
        const groupOrder = ['Today', 'Yesterday', 'Previous 7 Days', 'Previous 30 Days', 'Older'];

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
                        <input class="session-title-input w-full cursor-pointer truncate bg-transparent text-sm leading-5 focus:outline-none text-foreground ${titleClass}" placeholder="Untitled Chat" readonly data-session-id="${session.id}" value="${this.escapeHtml(session.title)}">
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

        // Rename session action - enable inline editing
        document.querySelectorAll('.rename-session-action').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const sessionId = btn.dataset.sessionId;
                // Close the menu
                document.querySelectorAll('.session-menu').forEach(m => m.classList.add('hidden'));
                // Enable inline editing on the title input
                this.startInlineEdit(sessionId);
            });
        });

        // Title input blur/keydown handlers for inline editing
        document.querySelectorAll('.session-title-input').forEach(input => {
            input.addEventListener('blur', (e) => {
                if (!input.readOnly) {
                    this.finishInlineEdit(input);
                }
            });
            input.addEventListener('keydown', (e) => {
                if (!input.readOnly) {
                    if (e.key === 'Enter') {
                        e.preventDefault();
                        e.stopPropagation();
                        input.blur();
                    } else if (e.key === 'Escape') {
                        e.preventDefault();
                        e.stopPropagation();
                        this.cancelInlineEdit(input);
                    }
                }
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
}

