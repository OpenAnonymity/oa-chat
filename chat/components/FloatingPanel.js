/**
 * Floating Panel Component
 * A lightweight floating panel for showing network activity
 */

import { renderNetworkLog } from '../services/networkLogRenderer.js';

class FloatingPanel {
    constructor(app) {
        this.app = app;
        this.isVisible = false;
        this.isExpanded = false;
        this.currentLog = null;
        this.message = null; // To hold status messages

        // Position will be calculated dynamically

        // Show the panel on initialization
        setTimeout(() => this.show(), 100);
    }

    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text == null ? '' : String(text);
        return div.innerHTML;
    }

    show() {
        if (this.isVisible) return;

        this.isVisible = true;
        this.createElement();
        this.render();
    }

    hide() {
        if (!this.isVisible) return;

        this.isVisible = false;
        const panel = document.getElementById('floating-panel');
        if (panel) {
            panel.remove();
        }
    }

    toggle() {
        if (this.isVisible) {
            this.hide();
        } else {
            this.show();
        }
    }

    createElement() {
        // Remove existing panel if any
        const existing = document.getElementById('floating-panel');
        if (existing) {
            existing.remove();
        }

        // Create floating panel container
        const floatingPanel = document.createElement('div');
        floatingPanel.id = 'floating-panel';
        floatingPanel.className = 'fixed bg-background border border-border shadow-lg rounded-lg z-50 transition-all duration-300';

        // Dynamically calculate position based on the status dot
        const statusDotBtn = document.getElementById('status-dot-btn');
        if (statusDotBtn) {
            const rect = statusDotBtn.getBoundingClientRect();
            const panelLeft = rect.right + 8; // 8px gap
            // The breathing animation expands the dot with a 6px box-shadow.
            // We adjust the top position to align with the top of the animation's outer edge.
            const panelTop = rect.top - 12; // Nudge up by 11px (6px for shadow + 5px extra)

            floatingPanel.style.top = `${panelTop}px`;
            floatingPanel.style.left = `${panelLeft}px`;
        } else {
            // Fallback to a default position if the dot isn't found
            floatingPanel.style.top = '1rem';
            floatingPanel.style.left = '1.875rem';
        }

        floatingPanel.style.width = '280px';
        floatingPanel.style.maxWidth = 'calc(100vw - 2.5rem)';

        // Add content container
        const content = document.createElement('div');
        content.id = 'floating-panel-content';
        content.className = 'bg-background rounded-lg flex flex-col';
        content.style.height = 'auto';

        floatingPanel.appendChild(content);
        document.body.appendChild(floatingPanel);
    }

    updateWithLog(log) {
        this.currentLog = log;
        if (this.isVisible) {
            this.render();
        }
    }

    showMessage(text, type = 'info', duration = 0) {
        this.message = { text, type };
        if (!this.isVisible) {
            this.show();
        } else {
            this.render();
        }
        if (duration > 0) {
            setTimeout(() => this.clearMessage(), duration);
        }
    }

    clearMessage() {
        this.message = null;
        if (this.isVisible) {
            this.render();
        }
    }

    render() {
        const content = document.getElementById('floating-panel-content');
        if (!content) return;

        if (this.message) {
            let icon = '';
            let colorClass = '';
            switch (this.message.type) {
                case 'error':
                    colorClass = 'text-red-500';
                    icon = `<svg class="w-4 h-4 mr-2 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20"><path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clip-rule="evenodd"></path></svg>`;
                    break;
                case 'success':
                    colorClass = 'text-green-500';
                    icon = `<svg class="w-4 h-4 mr-2 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20"><path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clip-rule="evenodd"></path></svg>`;
                    break;
                case 'plain':
                    colorClass = 'text-muted-foreground';
                    icon = '';
                    break;
                default:
                    colorClass = 'text-foreground';
                    icon = `<div class="w-2 h-2 bg-muted-foreground rounded-full animate-pulse mr-2"></div>`;
                    break;
            }

            content.innerHTML = `
                <div class="p-3 text-xs">
                    <div class="flex items-center ${colorClass}">
                        ${icon}
                        <span>${this.escapeHtml(this.message.text)}</span>
                    </div>
                </div>
            `;
            return;
        }

        const session = this.app.getCurrentSession();
        // expiresAt is Unix timestamp in seconds
        const hasActiveKey = session && session.apiKey && session.expiresAt && (new Date(session.expiresAt) > new Date());

        if (hasActiveKey) {
            if (this.currentLog) {
                content.innerHTML = `
                    <div id="minimal-log-container" class="cursor-pointer">
                        ${renderNetworkLog(this.currentLog, this.isExpanded, true)}
                    </div>
                `;

                // Attach event handlers
                const logContainer = document.getElementById('minimal-log-container');
                if (logContainer) {
                    logContainer.onclick = (e) => {
                        // Don't toggle if clicking the close button
                        if (e.target.closest('#close-floating-btn')) return;
                        this.isExpanded = !this.isExpanded;
                        this.render();
                    };
                }

                // Attach close handler
                const closeBtn = document.getElementById('close-floating-btn');
                if (closeBtn) {
                    closeBtn.onclick = (e) => {
                        e.stopPropagation();
                        this.hide();
                    };
                }
            } else {
                // FEATURE DISABLED: "No activity yet" banner - uncomment to re-enable
                /*
                content.innerHTML = `
                    <div class="p-2 flex items-center justify-between text-xs">
                        <div class="flex items-center gap-2">
                            <span class="text-muted-foreground">No activity yet</span>
                        </div>
                        <button id="close-floating-btn" class="text-muted-foreground hover:text-foreground p-0.5">
                            <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path>
                            </svg>
                        </button>
                    </div>
                `;

                // Attach close handler
                const closeBtn = document.getElementById('close-floating-btn');
                if (closeBtn) {
                    closeBtn.onclick = () => this.hide();
                }
                */
            }
        } else {
            // No active key, render the prompt message.
            content.innerHTML = `
                <div class="p-3 text-xs">
                    <div class="flex justify-between items-start">
                        <div>
                            <p class="font-semibold text-foreground mb-1">No Active API Key</p>
                            <p class="text-muted-foreground">Open the right panel to manage tickets or start chatting to get a key automatically.</p>
                        </div>
                        <button id="close-floating-btn" class="text-muted-foreground hover:text-foreground p-0.5 ml-2 flex-shrink-0">
                            <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path>
                            </svg>
                        </button>
                    </div>
                </div>
            `;

            // Attach close handler
            const closeBtn = document.getElementById('close-floating-btn');
            if (closeBtn) {
                closeBtn.onclick = () => this.hide();
            }
        }
    }

    destroy() {
        this.hide();
    }
}

export default FloatingPanel;
