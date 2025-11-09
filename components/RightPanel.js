/**
 * Right Panel Component
 * Manages the ticket system UI panel
 */

import stationClient from '../services/station.js';
import networkLogger from '../services/networkLogger.js';
import { getActivityDescription, getActivityIcon, getStatusDotClass, formatTimestamp } from '../services/networkLogRenderer.js';

class RightPanel {
    constructor(app) {
        this.app = app; // Reference to main app
        this.currentSession = null;

        // Responsive behavior
        this.isDesktop = window.innerWidth >= 1024;

        // Load saved panel state from localStorage
        const savedState = localStorage.getItem('oa-right-panel-visible');
        if (savedState !== null) {
            this.isVisible = savedState === 'true';
        } else {
            this.isVisible = this.isDesktop; // Show by default on desktop
        }

        this.ticketCount = 0;
        this.apiKey = null;
        this.apiKeyInfo = null;
        this.expiresAt = null;
        this.timeRemaining = null;
        this.isExpired = false;
        this.isRegistering = false;
        this.isRequestingKey = false;
        this.registrationProgress = null;
        this.registrationError = null;
        this.timerInterval = null;

        // Ticket animation state
        this.currentTicket = null;
        this.ticketIndex = 0;
        this.showFinalized = false;
        this.isTransitioning = false;

        // Network logs state
        this.networkLogs = [];
        this.expandedLogIds = new Set();
        this.previousLogCount = 0;

        // Invitation code dropdown state
        this.showInvitationForm = false;

        this.initializeState();
        this.setupEventListeners();
        this.setupResponsive();
    }

    initializeState() {
        // Load initial ticket count
        this.ticketCount = stationClient.getTicketCount();

        // Load current ticket for animation
        this.loadNextTicket();

        // Get current session from app
        if (this.app) {
            this.currentSession = this.app.getCurrentSession();
            this.loadSessionData();
        }
    }

    loadSessionData() {
        if (!this.currentSession) return;

        // Load API key from current session
        this.apiKey = this.currentSession.apiKey || null;
        this.apiKeyInfo = this.currentSession.apiKeyInfo || null;
        this.expiresAt = this.currentSession.expiresAt || null;

        // Load ALL network logs globally (not just for this session)
        this.networkLogs = networkLogger.getAllLogs();
        this.previousLogCount = this.networkLogs.length;

        // Only update the top section (API key/tickets) without re-rendering logs
        this.renderTopSectionOnly();
        this.startExpirationTimer();

        // Ensure scroll is at bottom when switching sessions
        requestAnimationFrame(() => {
            this.scrollToBottomInstant();
        });
    }

    onSessionChange(session) {
        this.currentSession = session;
        this.loadSessionData();
        this.updateStatusIndicator();
    }

    loadNextTicket() {
        const tickets = stationClient.tickets;
        if (tickets && tickets.length > 0) {
            const nextUnused = tickets.findIndex(t => !t.used);
            if (nextUnused !== -1) {
                this.currentTicket = tickets[nextUnused];
                this.ticketIndex = nextUnused;
            } else {
                this.currentTicket = null;
            }
        }
        // Reset animation state
        this.showFinalized = false;
        this.isTransitioning = false;
    }

    formatTicketData(data) {
        if (!data) return '';
        // Show first and last 12 characters with ellipsis
        if (data.length > 28) {
            const truncated = `${data.substring(0, 12)}...${data.substring(data.length - 12)}`;
            return truncated;
        }
        return data;
    }

    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    setupEventListeners() {
        // Listen for ticket updates
        window.addEventListener('tickets-updated', () => {
            this.ticketCount = stationClient.getTicketCount();
            this.loadNextTicket();
            this.renderTopSectionOnly(); // Only update top section, not logs
            this.updateStatusIndicator();
        });

        // Subscribe to network logger
        networkLogger.subscribe(() => {
            // Reload ALL logs globally
            // DON'T clear expandedLogIds - preserve expansion state
            const previousCount = this.previousLogCount;
            this.networkLogs = networkLogger.getAllLogs();
            this.previousLogCount = this.networkLogs.length;

            // Use incremental update to preserve scroll and expansion state
            this.renderLogsOnly(false, previousCount); // Don't preserve scroll - we'll scroll to bottom

            // Auto-scroll to bottom to show newest activity (instant for immediate feedback)
            this.scrollToBottomInstant();

            // Notify app about new log for floating panel
            if (this.app.floatingPanel && this.networkLogs.length > 0) {
                const latestLog = this.networkLogs[0];
                this.app.floatingPanel.updateWithLog(latestLog);
            }
        });
    }

    setupResponsive() {
        // Handle window resize
        window.addEventListener('resize', () => {
            const wasDesktop = this.isDesktop;
            this.isDesktop = window.innerWidth >= 1024;

            if (wasDesktop !== this.isDesktop) {
                if (this.isDesktop) {
                    // Switched to desktop - restore saved state
                    const savedState = localStorage.getItem('oa-right-panel-visible');
                    this.isVisible = savedState !== null ? savedState === 'true' : true;
                } else {
                    // Switched to mobile - hide panel
                    this.isVisible = false;
                    localStorage.setItem('oa-right-panel-visible', 'false');
                }
                this.updatePanelVisibility();
                this.updateStatusIndicator();
            }
        });

        // Initial status update
        this.updateStatusIndicator();
    }



    updateStatusIndicator() {
        const dot = document.getElementById('breathing-dot');

        if (!dot) return;

        const hasActiveKey = this.apiKey && !this.isExpired;

        if (hasActiveKey) {
            dot.classList.add('status-active');
            dot.classList.remove('status-inactive');
        } else {
            dot.classList.add('status-inactive');
            dot.classList.remove('status-active');
        }

        // Notify floating panel about status change
        if (this.app.floatingPanel && !hasActiveKey) {
            // If no API key, floating panel might want to show ticket info
            this.app.floatingPanel.updateWithLog(null);
        }
    }

    startExpirationTimer() {
        // Clear existing timer
        if (this.timerInterval) {
            clearInterval(this.timerInterval);
            this.timerInterval = null;
        }

        if (!this.expiresAt) {
            this.timeRemaining = null;
            this.isExpired = false;
            return;
        }

        const updateTimeRemaining = () => {
            const expiryDate = new Date(this.expiresAt);
            const now = new Date();
            const diff = expiryDate - now;

            if (diff <= 0) {
                this.isExpired = true;
                this.timeRemaining = 'Expired';
                if (this.timerInterval) {
                    clearInterval(this.timerInterval);
                    this.timerInterval = null;
                }
                this.updateStatusIndicator();
            } else {
                this.isExpired = false;
                const hours = Math.floor(diff / 3600000);
                const minutes = Math.floor((diff % 3600000) / 60000);
                const seconds = Math.floor((diff % 60000) / 1000);

                if (hours > 0) {
                    this.timeRemaining = `${hours}h ${minutes}m`;
                } else if (minutes > 0) {
                    this.timeRemaining = `${minutes}m ${seconds}s`;
                } else {
                    this.timeRemaining = `${seconds}s`;
                }
            }

            // Update the UI
            const timeRemainingEl = document.getElementById('api-key-expiry');
            if (timeRemainingEl) {
                timeRemainingEl.textContent = this.timeRemaining || 'Loading...';
                timeRemainingEl.className = `font-medium px-2 py-0.5 rounded-full text-[10px] ${
                    this.isExpired ? 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400' : 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'
                }`;
            }
        };

        updateTimeRemaining();
        this.timerInterval = setInterval(updateTimeRemaining, 1000);
    }

    show() {
        this.isVisible = true;
        localStorage.setItem('oa-right-panel-visible', 'true');
        this.updatePanelVisibility();
    }

    toggle() {
        // Toggle the right panel visibility
        this.isVisible = !this.isVisible;
        localStorage.setItem('oa-right-panel-visible', this.isVisible.toString());
        this.updatePanelVisibility();
    }

    closeRightPanel() {
        // Close the right panel (works in both desktop and mobile)
        this.isVisible = false;
        localStorage.setItem('oa-right-panel-visible', 'false');
        this.updatePanelVisibility();
    }

    updatePanelVisibility() {
        const panel = document.getElementById('right-panel');
        const showBtn = document.getElementById('show-right-panel-btn');
        const appContainer = document.getElementById('app');
        if (!panel) return;

        // Update data attribute to control CSS-based hiding
        if (this.isVisible) {
            document.documentElement.removeAttribute('data-right-panel-hidden');
        } else {
            document.documentElement.setAttribute('data-right-panel-hidden', 'true');
        }

        if (this.isDesktop) {
            // Desktop mode: clear transform and use width for show/hide
            panel.style.transform = '';
            if (this.isVisible) {
                panel.style.width = '18rem';
                panel.style.borderLeftWidth = '1px';
                if (showBtn) showBtn.classList.add('hidden');
                if (appContainer) appContainer.classList.add('right-panel-open');
            } else {
                panel.style.width = '0';
                panel.style.borderLeftWidth = '0';
                if (showBtn) showBtn.classList.remove('hidden');
                if (appContainer) appContainer.classList.remove('right-panel-open');
            }
        } else {
            // Mobile mode: use transform to slide panel in/out as overlay
            panel.style.width = '';
            panel.style.borderLeftWidth = '';
            if (this.isVisible) {
                panel.style.transform = 'translateX(0)';
                if (showBtn) showBtn.classList.add('hidden');
            } else {
                panel.style.transform = 'translateX(100%)';
                if (showBtn) showBtn.classList.remove('hidden');
            }
            if (appContainer) appContainer.classList.remove('right-panel-open');
        }
    }

    async handleRegister(invitationCode) {
        if (!invitationCode || invitationCode.length !== 24) {
            this.registrationError = 'Invalid invitation code (must be 24 characters)';
            this.renderTopSectionOnly();
            return;
        }

        this.isRegistering = true;
        this.registrationError = null;
        this.registrationProgress = { message: 'Starting...', percent: 0 };
        this.renderTopSectionOnly();

        // Set current session for network logging
        if (this.currentSession && window.networkLogger) {
            window.networkLogger.setCurrentSession(this.currentSession.id);
        }

        try {
            await stationClient.alphaRegister(invitationCode, (message, percent) => {
                this.registrationProgress = { message, percent };
                this.renderTopSectionOnly();
            });

            this.ticketCount = stationClient.getTicketCount();

            // Clear form
            const input = document.getElementById('invitation-code-input');
            if (input) input.value = '';

            // Auto-close progress after success
            setTimeout(() => {
                this.registrationProgress = null;
                this.renderTopSectionOnly();
            }, 2000);
        } catch (error) {
            this.registrationError = error.message;
        } finally {
            this.isRegistering = false;
            this.renderTopSectionOnly();
        }
    }

    async handleRequestApiKey() {
        if (!this.currentTicket || this.isRequestingKey || !this.currentSession) return;

        try {
            // Set current session for network logging
            if (this.currentSession && window.networkLogger) {
                window.networkLogger.setCurrentSession(this.currentSession.id);
            }

            // Start the animation
            this.isTransitioning = true;
            this.renderTopSectionOnly();

            // Wait a bit for the animation to start
            await new Promise(resolve => setTimeout(resolve, 500));

            // Show the finalized version
            this.showFinalized = true;
            this.renderTopSectionOnly();

            // Wait for the transformation animation
            await new Promise(resolve => setTimeout(resolve, 1000));

            // Actually request the API key
            this.isRequestingKey = true;
            this.renderTopSectionOnly();

            const result = await stationClient.requestApiKey();

            // Store API key in current session
            this.currentSession.apiKey = result.key;
            this.currentSession.apiKeyInfo = result;
            this.currentSession.expiresAt = result.expires_at;

            // Save session to DB
            await chatDB.saveSession(this.currentSession);

            // Update local state
            this.apiKey = result.key;
            this.apiKeyInfo = result;
            this.expiresAt = result.expires_at;

            // Success - reset for next ticket
            setTimeout(() => {
                this.loadNextTicket();
                this.renderTopSectionOnly();
                this.startExpirationTimer();
                this.updateStatusIndicator();

                // Update floating panel with new status
                if (this.app.floatingPanel) {
                    this.app.floatingPanel.render();
                }
            }, 500);
        } catch (error) {
            console.error('Error requesting API key:', error);
            alert(`Failed to request API key: ${error.message}`);

            // Reset state even on error
            setTimeout(() => {
                this.loadNextTicket();
                this.renderTopSectionOnly();
            }, 500);
        } finally {
            this.isRequestingKey = false;
            this.isTransitioning = false;
            this.showFinalized = false;
        }
    }

    async handleVerifyApiKey() {
        if (!this.apiKey || !this.currentSession) {
            alert('No API key available to verify');
            return;
        }

        const verifyBtn = document.getElementById('verify-key-btn');
        if (verifyBtn) {
            verifyBtn.disabled = true;
            verifyBtn.textContent = 'Verifying...';
        }

        try {
            // Tag this request with session ID
            networkLogger.setCurrentSession(this.currentSession.id);

            const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${this.apiKey}`,
                    'HTTP-Referer': window.location.origin,
                    'X-Title': 'OA-WebApp',
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    model: 'openai/gpt-3.5-turbo',
                    messages: [{ role: 'user', content: 'Hello' }],
                    max_tokens: 10
                })
            });

            if (response.ok) {
                const data = await response.json();
                alert(`✓ API Key Valid\nResponse: ${data.choices[0].message.content}`);
            } else {
                const error = await response.json();
                alert(`✗ Verification Failed\n${error.error?.message || 'Unknown error'}`);
            }
        } catch (error) {
            console.error('Verification error:', error);
            alert(`✗ Verification Failed\n${error.message}`);
        } finally {
            if (verifyBtn) {
                verifyBtn.disabled = false;
                verifyBtn.textContent = 'Verify';
            }
        }
    }

    async handleClearApiKey() {
        if (!this.currentSession) return;

        if (confirm('Are you sure you want to remove the current API key?')) {
            this.currentSession.apiKey = null;
            this.currentSession.apiKeyInfo = null;
            this.currentSession.expiresAt = null;

            await chatDB.saveSession(this.currentSession);

            this.apiKey = null;
            this.apiKeyInfo = null;
            this.expiresAt = null;

            if (this.timerInterval) {
                clearInterval(this.timerInterval);
                this.timerInterval = null;
            }

            this.renderTopSectionOnly();
            this.updateStatusIndicator(); // Ensure dot updates
        }
    }

    handleRenewApiKey() {
        this.handleClearApiKey();
        setTimeout(() => this.handleRequestApiKey(), 100);
    }

    async handleClearActivityTimeline() {
        if (window.networkLogger) {
            await window.networkLogger.clearAllLogs();
            this.networkLogs = [];
            this.previousLogCount = 0;
            this.renderLogsOnly(false); // Re-render logs only (empty state)
        }
    }

    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    maskApiKey(key) {
        if (!key) return '';
        // Show sk-or-v1-xxxx...yyyy (first 4 chars after prefix, last 4 chars)
        return `${key.slice(0, 13)}...${key.slice(-4)}`;
    }

    toggleLogExpand(logId) {
        if (this.expandedLogIds.has(logId)) {
            this.expandedLogIds.delete(logId);
        } else {
            // Only allow one log to be expanded at a time
            this.expandedLogIds.clear();
            this.expandedLogIds.add(logId);
        }
        // Use incremental update to preserve scroll position
        this.renderLogsOnly(true);
    }

    scrollToBottom() {
        // Scroll the network logs container to bottom to show newest activity
        requestAnimationFrame(() => {
            const container = document.getElementById('network-logs-container');
            if (container) {
                container.scrollTo({
                    top: container.scrollHeight,
                    behavior: 'smooth'
                });
            }
        });
    }

    scrollToBottomInstant() {
        // Instantly scroll to bottom (no animation delay)
        const container = document.getElementById('network-logs-container');
        if (container) {
            container.scrollTop = container.scrollHeight;
        }
    }

    formatTimestamp(timestamp) {
        const date = new Date(timestamp);
        return date.toLocaleTimeString('en-US', { hour12: false });
    }

    formatDestinationUrl(url) {
        try {
            const urlObj = new URL(url);
            return `${urlObj.protocol}//${urlObj.host}${urlObj.pathname}`;
        } catch {
            return url;
        }
    }

    getHostFromUrl(url) {
        try {
            const urlObj = new URL(url);
            return urlObj.host;
        } catch {
            return 'unknown';
        }
    }

    getTypeBadge(type) {
        const badges = {
            'openrouter': { text: 'API', class: 'bg-blue-500 text-white' },
            'ticket': { text: 'Ticket', class: 'bg-purple-500 text-white' },
            'api-key': { text: 'Key', class: 'bg-green-500 text-white' }
        };
        return badges[type] || { text: type, class: 'bg-gray-500 text-white' };
    }

    getStatusIcon(status) {
        if (status >= 200 && status < 300) {
            return '✓';
        } else if (status === 0) {
            return '✗';
        } else if (status >= 400) {
            return '!';
        }
        return '•';
    }

    getStatusClass(status) {
        if (status >= 200 && status < 300) {
            return 'text-green-600';
        } else if (status === 0) {
            return 'text-red-600';
        } else if (status >= 400) {
            return 'text-orange-600';
        }
        return 'text-gray-600';
    }

    getSessionInfo(sessionId) {
        if (!this.app || !sessionId) return null;
        const session = this.app.state.sessions.find(s => s.id === sessionId);
        return session;
    }

    getSessionTitle(sessionId) {
        const session = this.getSessionInfo(sessionId);
        if (!session) return 'Unknown Session';
        return session.title;
    }

    isCurrentSession(sessionId) {
        return this.currentSession && this.currentSession.id === sessionId;
    }

    getSessionKey(sessionId) {
        const session = this.getSessionInfo(sessionId);
        if (!session) return null;
        return session.apiKey;
    }

    /**
     * Generates HTML for the top section (tickets and API key) only.
     */
    generateTopSectionHTML() {
        const hasTickets = this.ticketCount > 0;
        const hasApiKey = !!this.apiKey;

        return `
                <!-- Invitation Code Section -->
                <div class="p-3">
                <div class="flex items-center justify-between">
                    <div class="flex items-center gap-1.5">
                        <svg class="w-3.5 h-3.5 text-muted-foreground" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 5v2m0 4v2m0 4v2M5 5a2 2 0 00-2 2v3a2 2 0 110 4v3a2 2 0 002 2h14a2 2 0 002-2v-3a2 2 0 110-4V7a2 2 0 00-2-2H5z"></path>
                        </svg>
                        <span class="text-xs font-medium">Inference Tickets: <span class="font-semibold">${this.ticketCount}</span></span>
                    </div>
                    <button
                        id="toggle-invitation-form-btn"
                        class="inline-flex items-center gap-1 px-2 py-1 text-[10px] rounded-md border border-border bg-background hover:bg-accent transition-all duration-200 shadow-sm hover:shadow"
                    >
                        <span>${this.showInvitationForm || this.ticketCount === 0 ? 'Hide' : 'Add'}</span>
                        <svg class="w-2.5 h-2.5 transition-transform ${this.showInvitationForm || this.ticketCount === 0 ? 'rotate-180' : ''}" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"></path>
                        </svg>
                    </button>
                </div>

                ${this.showInvitationForm || this.ticketCount === 0 ? `
                    <form id="invitation-code-form" class="space-y-2 mt-3 p-3 bg-muted/20 rounded-lg">
                        <input
                            id="invitation-code-input"
                            type="text"
                            placeholder="Enter 24-char invitation code"
                            maxlength="24"
                            class="w-full px-3 py-2 text-xs border border-border rounded-md bg-background text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent transition-all"
                            ${this.isRegistering ? 'disabled' : ''}
                        />
                        <button
                            type="submit"
                            class="w-full inline-flex items-center justify-center rounded-md text-xs font-medium transition-all duration-200 focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50 bg-accent text-accent-foreground hover:bg-accent/70 h-8 px-3 shadow-sm hover:shadow border border-border"
                            ${this.isRegistering ? 'disabled' : ''}
                        >
                            ${this.isRegistering ? 'Registering...' : 'Register Code'}
                        </button>
                        <p class="text-[10px] text-muted-foreground leading-relaxed">Register with an invitation code to obtain inference tickets. Each ticket can be used to request a temporary OpenRouter API key.</p>
                    </form>

                    ${this.registrationProgress ? `
                        <div class="mt-2 text-[10px] space-y-1">
                            <div class="text-foreground">${this.escapeHtml(this.registrationProgress.message)}</div>
                            <div class="w-full bg-muted rounded-full h-1.5">
                                <div class="bg-primary h-1.5 rounded-full transition-all" style="width: ${this.registrationProgress.percent}%"></div>
                            </div>
                        </div>
                    ` : ''}

                    ${this.registrationError ? `
                        <div class="mt-2 text-[10px] text-destructive">
                            ${this.escapeHtml(this.registrationError)}
                        </div>
                    ` : ''}
                ` : ''}
            </div>

            <!-- Ticket Visualization Section -->
            ${hasTickets && !hasApiKey && this.currentTicket ? `
                <div class="mx-3 mb-3 p-3 bg-muted/10 rounded-lg border border-border">
                    <div class="mb-3">
                        <div class="flex items-center justify-between">
                            <span class="text-xs font-semibold text-foreground">Next Inference Ticket</span>
                            <span class="text-[10px] text-foreground font-medium px-1.5 py-0.5 bg-primary/10 border border-border/30 rounded-full">#${this.ticketIndex + 1} of ${this.ticketCount}</span>
                        </div>
                    </div>

                    <div class="space-y-2">
                        <!-- Ticket Data Display -->
                        <div class="relative min-h-[60px]">
                            ${!this.showFinalized ? `
                                <div class="space-y-1 transition-all duration-500 ${
                                    this.isTransitioning ? 'opacity-50 scale-95' : 'opacity-100 scale-100'
                                }">
                                    <div class="text-[10px] text-muted-foreground mb-1">
                                        Signed Response (from server):
                                    </div>
                                    <div class="ticket-data-display bg-background border border-dashed border-border rounded p-1.5 text-[10px] font-mono break-all text-muted-foreground cursor-pointer hover:bg-accent/30 transition-colors" data-full="${this.escapeHtml(this.currentTicket.signed_response)}" data-expanded="false">
                                        ${this.formatTicketData(this.currentTicket.signed_response)}
                                    </div>
                                </div>
                            ` : `
                                <div class="space-y-1 transition-all duration-500 ${
                                    this.showFinalized ? 'opacity-100 scale-100' : 'opacity-0 scale-110'
                                }">
                                    <div class="text-[10px] text-foreground mb-1 flex items-center gap-1">
                                        <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"></path>
                                        </svg>
                                        Finalized Token (ready to use):
                                    </div>
                                    <div class="ticket-data-display bg-accent/50 border border-primary rounded p-1.5 text-[10px] font-mono break-all text-foreground animate-pulse cursor-pointer hover:bg-accent/70 transition-colors" data-full="${this.escapeHtml(this.currentTicket.finalized_ticket)}" data-expanded="false">
                                        ${this.formatTicketData(this.currentTicket.finalized_ticket)}
                                    </div>
                                </div>
                            `}
                        </div>

                        <!-- Use Ticket Button -->
                        <button
                            id="use-ticket-btn"
                            class="w-full inline-flex items-center justify-center gap-1.5 rounded-md text-xs font-medium transition-all focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50 h-7 px-3 ${
                                this.isTransitioning
                                    ? 'bg-accent text-accent-foreground border border-border'
                                    : 'bg-accent text-accent-foreground hover:bg-accent/70 border border-border'
                            }"
                            ${this.isRequestingKey || this.isTransitioning ? 'disabled' : ''}
                        >
                            <svg class="w-3.5 h-3.5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
                                <path stroke-linecap="round" stroke-linejoin="round" d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z"></path>
                            </svg>
                            <span>${this.isRequestingKey ? 'Requesting...' : this.isTransitioning ? 'Transforming...' : 'Use This Ticket'}</span>
                        </button>

                        <!-- Ticket Status -->
                        <div class="flex items-center justify-between text-xs">
                            <span class="text-muted-foreground">Status:</span>
                            <span class="${this.currentTicket.used ? 'text-destructive' : 'text-foreground'}">
                                ${this.currentTicket.used ? 'Used' : 'Available'}
                            </span>
                        </div>
                    </div>
                </div>
            ` : hasTickets && !hasApiKey && !this.currentTicket ? `
                <div class="mx-3 mb-3 p-4">
                    <div class="text-center text-xs text-muted-foreground">
                        <svg class="w-8 h-8 mx-auto mb-2 text-muted-foreground/30" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"></path>
                        </svg>
                        No tickets available
                    </div>
                </div>
            ` : ''}

            <!-- API Key Panel -->
            ${hasApiKey ? `
                <div class="p-3">
                    <div class="mb-3">
                        <div class="flex items-center gap-1.5 mb-2">
                            <svg class="w-4 h-4 text-muted-foreground" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z"></path>
                            </svg>
                            <span class="text-xs font-medium">Untraceable OpenRouter API Key</span>
                        </div>
                        <div class="flex items-center justify-between text-[10px] font-mono bg-muted/20 p-2 rounded-md border border-border break-all text-foreground">
                            <span>${this.maskApiKey(this.apiKey)}</span>
                            <span id="api-key-expiry" class="font-medium px-2 py-0.5 rounded-full text-[10px] flex-shrink-0 ml-2 ${
                                this.isExpired ? 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400' : 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'
                            }">
                                ${this.timeRemaining || 'Loading...'}
                            </span>
                        </div>
                    </div>

                    <div class="space-y-2 mb-3">

                        ${this.apiKeyInfo?.station_name ? `
                            <div class="flex items-center justify-between p-2 bg-background rounded-md border border-border">
                                <span class="text-[10px] text-muted-foreground">Station</span>
                                <span class="text-[10px] font-medium">${this.escapeHtml(this.apiKeyInfo.station_name)}</span>
                            </div>
                        ` : ''}
                    </div>

                    <div class="grid grid-cols-3 gap-1.5">
                        <button
                            id="verify-key-btn"
                            class="text-[10px] px-2 py-1.5 rounded-md border border-border bg-background text-foreground hover:bg-accent/50 hover:border-border transition-all duration-200 hover:shadow-sm"
                            ${this.isExpired ? 'disabled' : ''}
                        >
                            Verify
                        </button>
                        <button
                            id="renew-key-btn"
                            class="text-[10px] px-2 py-1.5 rounded-md border border-border bg-background text-foreground hover:bg-accent/50 hover:border-border transition-all duration-200 hover:shadow-sm"
                        >
                            Renew
                        </button>
                        <button
                            id="clear-key-btn"
                            class="text-[10px] px-2 py-1.5 rounded-md border border-destructive/30 text-destructive bg-destructive/10 hover:bg-destructive/30 hover:border-destructive/60 transition-all duration-200"
                        >
                            Remove
                        </button>
                    </div>
                </div>
            ` : ''}
        `;
    }

    /**
     * Attaches event listeners to the top section elements only.
     */
    attachTopSectionEventListeners() {
        // Toggle invitation form button
        const toggleFormBtn = document.getElementById('toggle-invitation-form-btn');
        if (toggleFormBtn) {
            toggleFormBtn.onclick = () => {
                this.showInvitationForm = !this.showInvitationForm;
                this.renderTopSectionOnly();
            };
        }

        // Invitation code form
        const form = document.getElementById('invitation-code-form');
        if (form) {
            form.onsubmit = (e) => {
                e.preventDefault();
                const input = document.getElementById('invitation-code-input');
                if (input) {
                    this.handleRegister(input.value.trim());
                }
            };
        }

        // Use ticket button
        const useTicketBtn = document.getElementById('use-ticket-btn');
        if (useTicketBtn) {
            useTicketBtn.onclick = () => this.handleRequestApiKey();
        }

        // Ticket data click handler - toggle between truncated and full view
        const ticketDataDisplays = document.querySelectorAll('.ticket-data-display');
        ticketDataDisplays.forEach(display => {
            display.onclick = () => {
                const fullData = display.getAttribute('data-full');
                const isExpanded = display.getAttribute('data-expanded') === 'true';

                if (isExpanded) {
                    // Show truncated version
                    display.textContent = this.formatTicketData(fullData);
                    display.setAttribute('data-expanded', 'false');
                } else {
                    // Show full version
                    display.textContent = fullData;
                    display.setAttribute('data-expanded', 'true');
                }
            };
        });

        // API key management buttons
        const verifyBtn = document.getElementById('verify-key-btn');
        if (verifyBtn) {
            verifyBtn.onclick = () => this.handleVerifyApiKey();
        }

        const renewBtn = document.getElementById('renew-key-btn');
        if (renewBtn) {
            renewBtn.onclick = () => this.handleRenewApiKey();
        }

        const clearBtn = document.getElementById('clear-key-btn');
        if (clearBtn) {
            clearBtn.onclick = () => this.handleClearApiKey();
        }
    }

    /**
     * Re-renders only the top section (tickets/API key) without re-rendering logs.
     */
    renderTopSectionOnly() {
        const panel = document.getElementById('right-panel-content');
        if (!panel) return;

        // Find the top section container
        const topSection = panel.querySelector('.flex-shrink-0');
        if (!topSection) {
            // If top section doesn't exist yet, do a full render
            this.render();
            return;
        }

        // Generate and update only the top section HTML
        topSection.innerHTML = this.generateTopSectionHTML();

        // Re-attach event listeners for the top section only
        this.attachTopSectionEventListeners();
    }

    /**
     * Re-renders only the network logs container without re-rendering the entire panel.
     * @param {boolean} preserveScroll - Whether to preserve scroll position
     * @param {number} previousLogCount - Previous count of logs (to mark new entries)
     */
    renderLogsOnly(preserveScroll = true, previousLogCount = 0) {
        const container = document.getElementById('network-logs-container');
        if (!container) return;

        // Capture current scroll position
        const scrollTop = preserveScroll ? container.scrollTop : 0;

        // Re-render the logs
        container.innerHTML = this.renderNetworkLogs(previousLogCount);

        // Restore scroll position if requested
        if (preserveScroll) {
            container.scrollTop = scrollTop;
        }

        // Re-attach event handlers to log rows
        this.attachLogRowHandlers();
    }

    /**
     * Attaches click handlers to activity log headers for expand/collapse.
     */
    attachLogRowHandlers() {
        document.querySelectorAll('.activity-log-header').forEach(header => {
            header.onclick = (e) => {
                const logId = e.currentTarget.dataset.logId;
                this.toggleLogExpand(logId);
            };
        });
    }

    /**
     * Attaches click handler to the clear activity timeline button.
     */
    attachClearActivityButtonHandler() {
        const clearActivityBtn = document.getElementById('clear-activity-timeline-btn');
        if (clearActivityBtn) {
            clearActivityBtn.onclick = () => this.handleClearActivityTimeline();
        }
    }

    renderNetworkLogs(previousLogCount = 0) {
        if (this.networkLogs.length === 0) {
            return `
                <div class="p-8 text-center">
                    <svg class="w-12 h-12 mx-auto mb-3 text-muted-foreground/30" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"></path>
                    </svg>
                    <p class="text-xs text-muted-foreground">No activity yet</p>
                </div>
            `;
        }

        // Reverse order: oldest first, newest last
        const logsToShow = [...this.networkLogs].reverse();

        // Calculate how many new logs were added
        const newLogsCount = this.networkLogs.length - previousLogCount;

        // Track session changes for separators
        let lastSessionId = null;

        return logsToShow.map((log, index) => {
            const isExpanded = this.expandedLogIds.has(log.id);
            const description = getActivityDescription(log);
            const icon = getActivityIcon(log);
            const dotClass = getStatusDotClass(log.status);
            const isFirst = index === 0;
            const isLast = index === logsToShow.length - 1;
            // Highlight the latest (last in reversed array) with a more visible background
            const highlightClass = isLast ? 'bg-accent' : '';
            const hoverClass = isLast ? 'hover:brightness-125' : 'hover:bg-muted/30';
            // Only animate items that are truly new (last N items where N = newLogsCount)
            const isNewEntry = newLogsCount > 0 && index >= logsToShow.length - newLogsCount;
            const animationClass = isNewEntry ? 'new-entry' : '';

            // Check if this is a system-level event (tickets/privacy pass)
            const isSystemEvent = (log.type === 'local' && log.method === 'LOCAL') || log.type === 'ticket';

            // For grouping purposes, treat system events as a special "system" session
            const effectiveSessionId = isSystemEvent ? 'system' : log.sessionId;

            // Check if we need a session separator
            const needsSeparator = effectiveSessionId !== lastSessionId;
            const sessionTitle = this.getSessionTitle(log.sessionId);
            const isCurrentSess = this.isCurrentSession(log.sessionId);
            const sessionKey = this.getSessionKey(log.sessionId);
            lastSessionId = effectiveSessionId;

            let sessionSeparator = '';
            if (needsSeparator) {
                if (isSystemEvent) {
                    // System-level separator for ticket/privacy operations
                    sessionSeparator = `
                        <div class="session-separator mb-2 mt-2">
                            <div class="flex items-center gap-2 px-2 py-1.5 rounded-md border whitespace-nowrap border-border">
                                <svg class="w-3 h-3 text-muted-foreground flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12.75L11.25 15 15 9.75m-3-7.036A11.959 11.959 0 013.598 6 11.99 11.99 0 003 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285z"></path>
                                </svg>
                                <span class="text-[10px] font-medium whitespace-nowrap text-muted-foreground">
                                    System
                                </span>
                            </div>
                        </div>
                    `;
                } else if (log.sessionId) {
                    // Chat session separator
                    const keyDisplay = sessionKey ? `<span class="text-[10px] font-mono whitespace-nowrap ${isCurrentSess ? 'text-foreground' : 'text-muted-foreground'} ml-auto">${this.maskApiKey(sessionKey)}</span>` : '';
                    sessionSeparator = `
                        <div class="session-separator mb-2 mt-2">
                            <div class="flex items-center gap-2 px-2 py-1.5 rounded-md border whitespace-nowrap ${isCurrentSess ? 'border-foreground bg-primary/10' : 'border-border'}">
                                <svg class="w-3 h-3 ${isCurrentSess ? 'text-foreground' : 'text-muted-foreground'} flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z"></path>
                                </svg>
                                <span class="text-[10px] font-medium whitespace-nowrap ${isCurrentSess ? 'text-foreground' : 'text-muted-foreground'}" title="${sessionTitle}">
                                    ${sessionTitle.length > 14 ? sessionTitle.substring(0, 14) + '...' : sessionTitle}
                                </span>
                                ${keyDisplay}
                            </div>
                        </div>
                    `;
                }
            }

            return `${sessionSeparator}
                <div class="activity-log-entry ${animationClass} relative flex" data-log-id="${log.id}">
                    <!-- Timeline visualization column -->
                    <div class="flex flex-col items-center" style="width: 24px; flex-shrink: 0;">
                        <!-- Top line -->
                        ${!isFirst ? `<div class="w-0.5 bg-border" style="height: 6px;"></div>` : '<div style="height: 6px;"></div>'}

                        <!-- Activity node -->
                        <div class="relative flex items-center justify-center" style="width: 16px; height: 16px; flex-shrink: 0;">
                            <div class="${dotClass} activity-node rounded-full transition-all duration-200" style="width: 8px; height: 8px;"></div>
                            </div>

                        <!-- Bottom line (extends to next entry) -->
                        ${!isLast ? `<div class="w-0.5 bg-border" style="height: 12px;"></div>` : ''}
                    </div>

                    <!-- Content column -->
                    <div class="flex-1 min-w-0" style="margin-top: 2px;">
                        <!-- Compact one-line view -->
                        <div class="activity-log-header cursor-pointer ${hoverClass} pl-1 pr-2 py-1 rounded transition-all duration-150 text-[10px] ${highlightClass}" data-log-id="${log.id}">
                            <div class="flex items-center gap-1.5">
                                <span class="flex-shrink-0 text-muted-foreground">
                                    ${icon}
                                </span>
                                <span class="truncate flex-1 font-medium" title="${description}">
                                    ${description}
                                </span>
                                <span class="text-muted-foreground font-mono ml-auto" style="font-size: 10px;">
                                    ${formatTimestamp(log.timestamp)}
                                </span>
                            </div>
                        </div>

                        <!-- Expanded details -->
                        ${isExpanded ? `
                            <div class="activity-log-details mt-2 text-xs bg-muted/10 rounded-lg border border-border/50 overflow-hidden" style="animation: slideDown 0.2s ease-out;">
                                    <!-- Detailed description -->
                                    <div class="px-3 pt-2.5 pb-2 bg-muted/5 border-b border-border/50">
                                        <div class="text-foreground leading-relaxed">${getActivityDescription(log, true)}</div>
                                    </div>

                                <!-- Technical Details -->
                                <div class="p-3 space-y-2.5">
                                    <!-- Status and Method -->
                                    <div class="flex items-center gap-3">
                                        <div class="flex items-center gap-1.5">
                                            <span class="text-[10px] text-muted-foreground">Status:</span>
                                            <span class="text-[10px] font-medium px-1.5 py-0.5 rounded ${
                                                log.status >= 200 && log.status < 300 ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400' :
                                                log.status === 0 ? 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400' :
                                                'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400'
                                            }">
                                                ${log.status || 'ERROR'}
                                            </span>
                                        </div>
                                        <div class="flex items-center gap-1.5">
                                            <span class="text-[10px] text-muted-foreground">Method:</span>
                                            <span class="text-[10px] font-medium px-1.5 py-0.5 bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400 rounded">${log.method}</span>
                                        </div>
                                    </div>

                                    <!-- URL -->
                                    <div class="space-y-1">
                                        <div class="text-[10px] text-muted-foreground font-medium">Destination</div>
                                        <div class="text-[10px] font-mono bg-background p-2 rounded border border-border/50 break-all">
                                            ${log.url}
                                        </div>
                                    </div>

                                    <!-- Key Headers (if any) -->
                                    ${log.request?.headers && Object.keys(log.request.headers).length > 0 ? `
                                        <div class="space-y-1">
                                            <div class="text-[10px] text-muted-foreground font-medium">Key Headers</div>
                                            <div class="space-y-1">
                                                ${log.request.headers.Authorization && log.method === 'POST' ? `
                                                    <div class="flex text-[10px]">
                                                        <span class="text-muted-foreground" style="min-width: 96px;">Authorization:</span>
                                                        <span class="font-mono text-muted-foreground">${networkLogger.sanitizeHeaders({ Authorization: log.request.headers.Authorization }).Authorization}</span>
                                                    </div>
                                                ` : ''}
                                                ${log.request.headers['X-Title'] ? `
                                                    <div class="flex text-[10px]">
                                                        <span class="text-muted-foreground" style="min-width: 96px;">Application:</span>
                                                        <span class="font-mono">${log.request.headers['X-Title']}</span>
                                                    </div>
                                                ` : ''}
                                                ${log.request.headers['Content-Type'] ? `
                                                    <div class="flex text-[10px]">
                                                        <span class="text-muted-foreground" style="min-width: 96px;">Content Type:</span>
                                                        <span class="font-mono">${log.request.headers['Content-Type']}</span>
                                                    </div>
                                                ` : ''}
                                            </div>
                                        </div>
                                    ` : ''}

                                    <!-- Error or Success Message -->
                                    ${log.error ? `
                                        <div class="space-y-1">
                                            <div class="text-[10px] text-red-600 font-medium">Error Details</div>
                                            <div class="text-[10px] text-red-600 bg-red-50/50 p-2 rounded border border-red-200/50">
                                                ${this.escapeHtml(log.error)}
                                            </div>
                                        </div>
                                    ` : log.response ? `
                                        <div class="space-y-1">
                                            <div class="text-[10px] text-muted-foreground font-medium">Response Summary</div>
                                            <div class="text-[10px] text-muted-foreground bg-background p-2 rounded border border-border/50">
                                                ${networkLogger.getResponseSummary(log.response, log.status) || 'Request completed successfully'}
                                            </div>
                                        </div>
                                    ` : ''}
                                </div>
                            </div>
                        ` : ''}
                    </div>
                </div>
            `;
        }).join('');
    }

    render() {
        const panel = document.getElementById('right-panel-content');
        if (!panel) return;

        const hasApiKey = !!this.apiKey;

        panel.innerHTML = `
            <!-- Header -->
            <div class="p-3 bg-muted/10 border-b border-border">
                <div class="flex items-center justify-between">
                    <h2 class="text-xs font-semibold text-foreground">System Panel</h2>
                    <button id="close-right-panel" class="text-muted-foreground hover:text-foreground transition-colors p-0.5 rounded-lg hover:bg-accent">
                        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M6 18L18 6M6 6l12 12"></path>
                        </svg>
                    </button>
                </div>
            </div>

            <div class="flex flex-col h-full overflow-hidden">
            <!-- Top Section: Tickets and API Key (non-scrollable) -->
            <div class="flex-shrink-0">
                ${this.generateTopSectionHTML()}
            </div>
            <!-- End of Top Section -->

            <!-- Activity Timeline (scrollable) -->
            <div class="border-t border-border flex flex-col bg-background flex-1 min-h-0">
                <div class="p-3 border-b border-border bg-muted/10">
                    <div class="flex items-center justify-between gap-1.5">
                        <div class="flex items-center gap-1.5">
                            <svg class="w-3.5 h-3.5 text-muted-foreground" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"></path>
                            </svg>
                            <h3 class="text-xs font-medium text-foreground">Activity Timeline</h3>
                        </div>
                        <button id="clear-activity-timeline-btn" class="inline-flex items-center justify-center rounded-md transition-colors hover:bg-accent/30 text-muted-foreground hover:text-foreground h-6 w-6" title="Clear activity timeline">
                            <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
                                <path stroke-linecap="round" stroke-linejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path>
                            </svg>
                        </button>
                    </div>
                </div>
                <div id="network-logs-container" class="flex-1 overflow-y-auto px-3 pt-2 pb-4">
                    ${this.renderNetworkLogs()}
                </div>

            </div>
            </div>
        `;

        // Attach event listeners
        this.attachEventListeners();

        // Start timer if we have an API key
        if (hasApiKey) {
            this.startExpirationTimer();
        }
    }

    attachEventListeners() {
        // Close panel button
        const closeBtn = document.getElementById('close-right-panel');
        if (closeBtn) {
            closeBtn.onclick = () => this.closeRightPanel();
        }

        // Attach top section event listeners (tickets/API key)
        this.attachTopSectionEventListeners();

        // Clear activity timeline button
        this.attachClearActivityButtonHandler();

        // Activity log expand/collapse - handled by attachLogRowHandlers
        this.attachLogRowHandlers();
    }

    mount() {
        // Initial render
        this.render();

        // Set initial visibility
        this.updatePanelVisibility();

        // Set initial state for app container
        const appContainer = document.getElementById('app');
        if (appContainer && this.isDesktop && this.isVisible) {
            appContainer.classList.add('right-panel-open');
        }

        // Hide legacy toggle button
        const oldToggleBtn = document.getElementById('toggle-right-panel-btn');
        if (oldToggleBtn) {
            oldToggleBtn.style.display = 'none';
        }

        // Initialize log count tracking
        this.previousLogCount = this.networkLogs.length;

        // Ensure initial scroll is at bottom
        requestAnimationFrame(() => {
            this.scrollToBottomInstant();
        });
    }

    destroy() {
        if (this.timerInterval) {
            clearInterval(this.timerInterval);
        }
    }
}

export default RightPanel;

