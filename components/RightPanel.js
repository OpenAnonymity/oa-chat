/**
 * Right Panel Component
 * Manages the ticket system UI panel
 */

import stationClient from '../services/station.js';
import networkLogger from '../services/networkLogger.js';

class RightPanel {
    constructor(app) {
        this.app = app; // Reference to main app
        this.currentSession = null;
        
        // Responsive behavior
        this.isDesktop = window.innerWidth >= 1024;
        this.isVisible = this.isDesktop; // Show by default on desktop
        
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
        
        // Load network logs for this session
        this.networkLogs = networkLogger.getLogsBySession(this.currentSession.id);
        
        this.render();
        this.startExpirationTimer();
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
        // Show first and last 20 characters
        if (data.length > 50) {
            return `${data.substring(0, 20)}...${data.substring(data.length - 20)}`;
        }
        return data;
    }

    setupEventListeners() {
        // Listen for ticket updates
        window.addEventListener('tickets-updated', () => {
            this.ticketCount = stationClient.getTicketCount();
            this.loadNextTicket();
            this.render();
            this.updateStatusIndicator();
        });

        // Subscribe to network logger
        networkLogger.subscribe(() => {
            // Reload logs for current session
            if (this.currentSession) {
                this.networkLogs = networkLogger.getLogsBySession(this.currentSession.id);
                this.render();
                
                // Notify app about new log for floating panel
                if (this.app.floatingPanel && this.networkLogs.length > 0) {
                    const latestLog = [...this.networkLogs].reverse()[0];
                    this.app.floatingPanel.updateWithLog(latestLog);
                }
                
                // Auto-scroll to bottom to show newest log
                setTimeout(() => {
                    const container = document.getElementById('network-logs-container');
                    if (container) {
                        container.scrollTop = container.scrollHeight;
                    }
                }, 100);
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
                    // Switched to desktop
                    this.isVisible = true;
                } else {
                    // Switched to mobile - hide panel
                    this.isVisible = false;
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
                timeRemainingEl.className = `text-xs font-medium px-2 py-0.5 rounded ${
                    this.isExpired ? 'bg-red-500 text-white' : 'bg-green-500 text-black'
                }`;
            }
        };

        updateTimeRemaining();
        this.timerInterval = setInterval(updateTimeRemaining, 1000);
    }

    show() {
        if (this.isDesktop) {
            this.isVisible = true;
            this.updatePanelVisibility();
        }
    }

    toggle() {
        // Toggle the right panel visibility
        this.isVisible = !this.isVisible;
        this.updatePanelVisibility();
    }
    
    closeRightPanel() {
        // Close the desktop right panel
        if (this.isDesktop) {
            this.isVisible = false;
            this.updatePanelVisibility();
        }
    }

    updatePanelVisibility() {
        const panel = document.getElementById('right-panel');
        const showBtn = document.getElementById('show-right-panel-btn');
        if (!panel) return;

        if (this.isDesktop) {
            if (this.isVisible) {
                panel.style.width = '20rem';
                panel.style.borderLeftWidth = '1px';
                if (showBtn) showBtn.classList.add('hidden');
            } else {
                panel.style.width = '0';
                panel.style.borderLeftWidth = '0';
                if (showBtn) showBtn.classList.remove('hidden');
            }
        } else {
            // Mobile mode, remove inline styles to let classes take over
            panel.style.width = '';
            panel.style.borderLeftWidth = '';
            panel.style.transform = 'translateX(100%)';
            if (showBtn) showBtn.classList.add('hidden');
        }
    }

    async handleRegister(invitationCode) {
        if (!invitationCode || invitationCode.length !== 24) {
            this.registrationError = 'Invalid invitation code (must be 24 characters)';
            this.render();
            return;
        }

        this.isRegistering = true;
        this.registrationError = null;
        this.registrationProgress = { message: 'Starting...', percent: 0 };
        this.render();

        try {
            await stationClient.alphaRegister(invitationCode, (message, percent) => {
                this.registrationProgress = { message, percent };
                this.render();
            });

            this.ticketCount = stationClient.getTicketCount();
            
            // Clear form
            const input = document.getElementById('invitation-code-input');
            if (input) input.value = '';

            // Auto-close progress after success
            setTimeout(() => {
                this.registrationProgress = null;
                this.render();
            }, 2000);
        } catch (error) {
            this.registrationError = error.message;
        } finally {
            this.isRegistering = false;
            this.render();
        }
    }

    async handleRequestApiKey() {
        if (!this.currentTicket || this.isRequestingKey || !this.currentSession) return;

        try {
            // Start the animation
            this.isTransitioning = true;
            this.render();
            
            // Wait a bit for the animation to start
            await new Promise(resolve => setTimeout(resolve, 500));
            
            // Show the finalized version
            this.showFinalized = true;
            this.render();
            
            // Wait for the transformation animation
            await new Promise(resolve => setTimeout(resolve, 1000));
            
            // Actually request the API key
            this.isRequestingKey = true;
            this.render();
            
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
                this.render();
                this.startExpirationTimer();
                this.updateStatusIndicator();
            }, 500);
        } catch (error) {
            console.error('Error requesting API key:', error);
            alert(`Failed to request API key: ${error.message}`);
            
            // Reset state even on error
            setTimeout(() => {
                this.loadNextTicket();
                this.render();
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
            
            this.render();
            this.updateStatusIndicator(); // Ensure dot updates
        }
    }

    handleRenewApiKey() {
        this.handleClearApiKey();
        setTimeout(() => this.handleRequestApiKey(), 100);
    }

    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    maskApiKey(key) {
        if (!key) return '';
        return `${key.slice(0, 12)}...${key.slice(-8)}`;
    }

    toggleLogExpand(logId) {
        if (this.expandedLogIds.has(logId)) {
            this.expandedLogIds.delete(logId);
        } else {
            this.expandedLogIds.add(logId);
        }
        this.render();
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

    renderNetworkLogs() {
        if (this.networkLogs.length === 0) {
            return `
                <div class="p-8 text-center">
                    <svg class="w-12 h-12 mx-auto mb-3 text-muted-foreground/20" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"></path>
                    </svg>
                    <p class="text-xs text-muted-foreground">No network activity for this session yet</p>
                </div>
            `;
        }

        // Reverse to show oldest first, newest last
        const logsToShow = [...this.networkLogs].reverse().slice(0, 50);
        
        return logsToShow.map((log, index) => {
            const isExpanded = this.expandedLogIds.has(log.id);
            const badge = this.getTypeBadge(log.type);
            const statusIcon = this.getStatusIcon(log.status);
            const statusClass = this.getStatusClass(log.status);
            const endpoint = networkLogger.getEndpointName(log.url);
            
            // Dim all except the last one (most recent)
            const isLatest = index === logsToShow.length - 1;
            const opacityClass = isLatest ? '' : 'opacity-50';

            return `
                <div class="network-log-entry border-b border-border/50 last:border-b-0 ${opacityClass}">
                    <div class="network-log-header px-4 py-3 hover:bg-muted/50 cursor-pointer transition-all duration-200 text-xs" data-log-id="${log.id}">
                        <div class="space-y-1.5">
                            <div class="flex items-center gap-2">
                                <span class="text-muted-foreground font-mono text-[10px]">${this.formatTimestamp(log.timestamp)}</span>
                                <span class="px-1.5 py-0.5 rounded text-[10px] font-semibold ${badge.class}">${badge.text}</span>
                                <span class="${statusClass} font-bold">${statusIcon}</span>
                                <span class="font-medium">${log.method}</span>
                                <span class="text-muted-foreground">(${log.status || 'ERR'})</span>
                                <svg class="w-3 h-3 transition-transform ${isExpanded ? 'rotate-180' : ''} ml-auto" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"></path>
                                </svg>
                            </div>
                            <div class="flex items-center gap-2 text-[10px]">
                                <svg class="w-3 h-3 text-muted-foreground" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H3m9 9a9 9 0 01-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9m-9 9a9 9 0 019-9"></path>
                                </svg>
                                <span class="font-mono text-foreground font-medium truncate flex-1" title="${log.url}">
                                    ${this.getHostFromUrl(log.url)}
                                </span>
                                <span class="text-muted-foreground">→</span>
                                <span class="text-muted-foreground truncate">
                                    /${endpoint}
                                </span>
                            </div>
                        </div>
                    </div>
                    ${isExpanded ? `
                        <div class="network-log-details bg-muted/20 text-xs border-t border-border/50">
                            <div class="grid grid-cols-2 divide-x divide-border/50">
                                <!-- Request Section -->
                                <div class="p-3 space-y-2">
                                    <div class="flex items-center gap-1.5">
                                        <svg class="w-3 h-3 text-blue-600" fill="currentColor" viewBox="0 0 20 20">
                                            <path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm1-11V6a1 1 0 10-2 0v1H6a1 1 0 100 2h3v3a1 1 0 102 0V9h3a1 1 0 100-2h-3z" clip-rule="evenodd"></path>
                                        </svg>
                                        <span class="font-semibold text-[11px]">Request</span>
                                    </div>
                                    
                    <!-- URL and Method Display -->
                    <div class="space-y-2">
                        <div class="flex items-center gap-2">
                            <span class="text-[10px] font-medium px-1.5 py-0.5 bg-blue-100 text-blue-700 rounded">${log.method}</span>
                            <span class="text-[10px] text-muted-foreground">
                                ${networkLogger.getEndpointName(log.url)}
                            </span>
                        </div>
                        <div class="space-y-1">
                            <div class="text-[10px] text-muted-foreground font-medium">Destination</div>
                            <div class="text-[10px] font-mono bg-blue-50 p-1.5 rounded border border-blue-200/50">
                                <div class="truncate" title="${log.url}">${this.formatDestinationUrl(log.url)}</div>
                            </div>
                        </div>
                    </div>
                                    
                                    <!-- Headers Summary -->
                                    ${log.request?.headers ? `
                                        <div class="space-y-1">
                                            <div class="text-[10px] text-muted-foreground font-medium">Headers</div>
                                            ${Object.entries(log.request.headers).slice(0, 3).map(([key, value]) => `
                                                <div class="flex text-[10px] gap-1">
                                                    <span class="text-muted-foreground">${key}:</span>
                                                    <span class="font-mono truncate flex-1" title="${value}">${value}</span>
                                                </div>
                                            `).join('')}
                                            ${Object.keys(log.request.headers).length > 3 ? `
                                                <div class="text-[10px] text-muted-foreground">+${Object.keys(log.request.headers).length - 3} more</div>
                                            ` : ''}
                                        </div>
                                    ` : ''}
                                    
                                    <!-- Body Preview -->
                                    ${log.request?.body ? `
                                        <div class="space-y-1">
                                            <div class="text-[10px] text-muted-foreground font-medium">Body</div>
                                            <div class="text-[10px] font-mono text-muted-foreground bg-background/50 p-1.5 rounded border border-border/50 truncate">
                                                ${networkLogger.getRequestSummary(log.request)}
                                            </div>
                                        </div>
                                    ` : ''}
                                </div>
                                
                                <!-- Response Section -->
                                <div class="p-3 space-y-2">
                                    <div class="flex items-center gap-1.5">
                                        <svg class="w-3 h-3 ${log.error ? 'text-red-600' : 'text-green-600'}" fill="currentColor" viewBox="0 0 20 20">
                                            <path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clip-rule="evenodd"></path>
                                        </svg>
                                        <span class="font-semibold text-[11px]">Response</span>
                                    </div>
                                    
                                    <!-- Status -->
                                    <div class="flex items-center gap-2">
                                        <span class="text-[10px] font-medium px-1.5 py-0.5 rounded ${
                                            log.status >= 200 && log.status < 300 ? 'bg-green-100 text-green-700' : 
                                            log.status === 0 ? 'bg-red-100 text-red-700' : 
                                            'bg-orange-100 text-orange-700'
                                        }">
                                            ${log.status || 'ERROR'}
                                        </span>
                                        <span class="text-[10px] text-muted-foreground">
                                            ${log.status >= 200 && log.status < 300 ? 'Success' : 
                                              log.status === 0 ? 'Failed' : 
                                              'Warning'}
                                        </span>
                                    </div>
                                    
                                    <!-- Response Data -->
                                    ${log.error ? `
                                        <div class="text-[10px] text-red-600 bg-red-50/50 p-1.5 rounded border border-red-200/50">
                                            ${this.escapeHtml(log.error)}
                                        </div>
                                    ` : `
                                        <div class="space-y-1">
                                            <div class="text-[10px] text-muted-foreground font-medium">Data</div>
                                            <div class="text-[10px] font-mono text-muted-foreground bg-background/50 p-1.5 rounded border border-border/50">
                                                ${networkLogger.getResponseSummary(log.response, log.status) || 'Empty response'}
                                            </div>
                                        </div>
                                    `}
                                    
                                    <!-- Note about IP -->
                                    <div class="mt-2 pt-2 border-t border-border/30">
                                        <div class="text-[9px] text-muted-foreground/70 italic">
                                            Note: IP addresses are not accessible from browser JavaScript for security reasons
                                        </div>
                                    </div>
                                </div>
                            </div>
                        </div>
                    ` : ''}
                </div>
            `;
        }).join('');
    }

    render() {
        const panel = document.getElementById('right-panel-content');
        if (!panel) return;

        const hasTickets = this.ticketCount > 0;
        const hasApiKey = !!this.apiKey;

        panel.innerHTML = `
            <!-- Header -->
            <div class="p-5 bg-muted/30 border-b border-border">
                <div class="flex items-center justify-between">
                    <h2 class="text-sm font-semibold text-foreground">Ticket System</h2>
                    <button id="close-right-panel" class="text-muted-foreground hover:text-foreground transition-colors p-1 rounded-lg hover:bg-background">
                        <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M6 18L18 6M6 6l12 12"></path>
                        </svg>
                    </button>
                </div>
            </div>

            <!-- Invitation Code Section -->
            <div class="p-5">
                <div class="flex items-center justify-between">
                    <div class="flex items-center gap-2">
                        <svg class="w-4 h-4 text-muted-foreground" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 5v2m0 4v2m0 4v2M5 5a2 2 0 00-2 2v3a2 2 0 110 4v3a2 2 0 002 2h14a2 2 0 002-2v-3a2 2 0 110-4V7a2 2 0 00-2-2H5z"></path>
                        </svg>
                        <span class="text-sm font-medium">Inference Tickets: <span class="font-semibold">${this.ticketCount}</span></span>
                    </div>
                    <button 
                        id="toggle-invitation-form-btn"
                        class="inline-flex items-center gap-1 px-3 py-1.5 text-xs rounded-lg border border-border bg-background hover:bg-accent transition-all duration-200 shadow-sm hover:shadow"
                    >
                        <span>${this.showInvitationForm || this.ticketCount === 0 ? 'Hide' : 'Add'}</span>
                        <svg class="w-3 h-3 transition-transform ${this.showInvitationForm || this.ticketCount === 0 ? 'rotate-180' : ''}" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"></path>
                        </svg>
                    </button>
                </div>

                ${this.showInvitationForm || this.ticketCount === 0 ? `
                    <form id="invitation-code-form" class="space-y-3 mt-4 p-4 bg-muted/20 rounded-lg">
                        <input
                            id="invitation-code-input"
                            type="text"
                            placeholder="Enter 24-char invitation code"
                            maxlength="24"
                            class="w-full px-4 py-2.5 text-sm border border-border rounded-lg bg-background focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent transition-all"
                            ${this.isRegistering ? 'disabled' : ''}
                        />
                        <button
                            type="submit"
                            class="w-full inline-flex items-center justify-center rounded-lg text-sm font-medium transition-all duration-200 focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50 bg-primary text-primary-foreground hover:bg-primary/90 h-10 px-4 shadow-sm hover:shadow"
                            ${this.isRegistering ? 'disabled' : ''}
                        >
                            ${this.isRegistering ? 'Registering...' : 'Register Code'}
                        </button>
                        <p class="text-xs text-muted-foreground leading-relaxed">Register with an invitation code to obtain inference tickets. Each ticket can be used to request a temporary OpenRouter API key.</p>
                    </form>

                    ${this.registrationProgress ? `
                        <div class="mt-3 text-xs text-blue-600 space-y-1">
                            <div>${this.escapeHtml(this.registrationProgress.message)}</div>
                            <div class="w-full bg-gray-200 rounded-full h-2">
                                <div class="bg-blue-600 h-2 rounded-full transition-all" style="width: ${this.registrationProgress.percent}%"></div>
                            </div>
                        </div>
                    ` : ''}

                    ${this.registrationError ? `
                        <div class="mt-3 text-xs text-red-600">
                            ${this.escapeHtml(this.registrationError)}
                        </div>
                    ` : ''}
                ` : ''}
            </div>

            <!-- Ticket Visualization Section -->
            ${hasTickets && !hasApiKey && this.currentTicket ? `
                <div class="mx-5 mb-5 p-5 bg-gradient-to-br from-purple-50 to-blue-50 rounded-xl border border-purple-200/50">
                    <div class="mb-4">
                        <div class="flex items-center justify-between">
                            <span class="text-sm font-semibold text-purple-900">Next Inference Ticket</span>
                            <span class="text-xs text-purple-600 font-medium px-2 py-1 bg-purple-100 rounded-full">#${this.ticketIndex + 1} of ${this.ticketCount}</span>
                        </div>
                    </div>

                    <div class="space-y-3">
                        <!-- Ticket Data Display -->
                        <div class="relative min-h-[100px]">
                            ${!this.showFinalized ? `
                                <div class="space-y-2 transition-all duration-500 ${
                                    this.isTransitioning ? 'opacity-50 scale-95' : 'opacity-100 scale-100'
                                }">
                                    <div class="text-xs text-muted-foreground mb-1">
                                        Signed Response (from server):
                                    </div>
                                    <div class="bg-white border-2 border-dashed border-gray-300 rounded p-2 text-xs font-mono break-all text-gray-700">
                                        ${this.formatTicketData(this.currentTicket.signed_response)}
                                    </div>
                                </div>
                            ` : `
                                <div class="space-y-2 transition-all duration-500 ${
                                    this.showFinalized ? 'opacity-100 scale-100' : 'opacity-0 scale-110'
                                }">
                                    <div class="text-xs text-green-600 mb-1 flex items-center gap-1">
                                        <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"></path>
                                        </svg>
                                        Finalized Token (ready to use):
                                    </div>
                                    <div class="bg-green-50 border-2 border-green-500 rounded p-2 text-xs font-mono break-all text-green-700 animate-pulse">
                                        ${this.formatTicketData(this.currentTicket.finalized_ticket)}
                                    </div>
                                </div>
                            `}
                        </div>

                        <!-- Use Ticket Button -->
                        <button
                            id="use-ticket-btn"
                            class="w-full inline-flex items-center justify-center gap-2 rounded-md text-sm font-medium transition-all focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50 h-9 px-4 ${
                                this.isTransitioning 
                                    ? 'bg-blue-500 text-white border-2 border-blue-600' 
                                    : 'bg-primary text-primary-foreground hover:bg-primary/90'
                            }"
                            ${this.isRequestingKey || this.isTransitioning ? 'disabled' : ''}
                        >
                            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z"></path>
                            </svg>
                            ${this.isRequestingKey ? 'Requesting...' : this.isTransitioning ? 'Transforming...' : 'Use This Ticket'}
                        </button>

                        <!-- Ticket Status -->
                        <div class="flex items-center justify-between text-xs">
                            <span class="text-muted-foreground">Status:</span>
                            <span class="${this.currentTicket.used ? 'text-red-500' : 'text-green-500'}">
                                ${this.currentTicket.used ? 'Used' : 'Available'}
                            </span>
                        </div>
                    </div>
                </div>
            ` : hasTickets && !hasApiKey && !this.currentTicket ? `
                <div class="mx-5 mb-5 p-8">
                    <div class="text-center text-sm text-muted-foreground">
                        <svg class="w-12 h-12 mx-auto mb-3 text-muted-foreground/30" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"></path>
                        </svg>
                        No tickets available
                    </div>
                </div>
            ` : ''}

            <!-- API Key Panel -->
            ${hasApiKey ? `
                <div class="p-5">
                    <div class="mb-4">
                        <div class="flex items-center gap-2 mb-3">
                            <svg class="w-4 h-4 text-muted-foreground" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z"></path>
                            </svg>
                            <span class="text-sm font-medium">OpenRouter API Key</span>
                        </div>
                        <div class="text-xs font-mono bg-muted/50 p-3 rounded-lg border border-border break-all">
                            ${this.maskApiKey(this.apiKey)}
                        </div>
                    </div>

                    <div class="space-y-3 mb-4">
                        <div class="flex items-center justify-between p-3 bg-background rounded-lg border border-border">
                            <span class="text-xs text-muted-foreground">Expires in:</span>
                            <span id="api-key-expiry" class="font-medium px-2.5 py-1 rounded-full text-xs ${
                                this.isExpired ? 'bg-red-100 text-red-700' : 'bg-green-100 text-green-700'
                            }">
                                ${this.timeRemaining || 'Loading...'}
                            </span>
                        </div>

                        ${this.apiKeyInfo?.station_name ? `
                            <div class="flex items-center justify-between p-3 bg-background rounded-lg border border-border">
                                <span class="text-xs text-muted-foreground">Station</span>
                                <span class="text-xs font-medium">${this.escapeHtml(this.apiKeyInfo.station_name)}</span>
                            </div>
                        ` : ''}
                    </div>

                    <div class="grid grid-cols-3 gap-2">
                        <button
                            id="verify-key-btn"
                            class="text-xs px-3 py-2 rounded-lg border border-border bg-background hover:bg-accent transition-all duration-200 hover:shadow-sm"
                            ${this.isExpired ? 'disabled' : ''}
                        >
                            Verify
                        </button>
                        <button
                            id="renew-key-btn"
                            class="text-xs px-3 py-2 rounded-lg border border-border bg-background hover:bg-accent transition-all duration-200 hover:shadow-sm"
                        >
                            Renew
                        </button>
                        <button
                            id="clear-key-btn"
                            class="text-xs px-3 py-2 rounded-lg border border-red-200 text-red-600 bg-red-50 hover:bg-red-100 hover:border-red-300 transition-all duration-200"
                        >
                            Remove
                        </button>
                    </div>
                </div>
            ` : ''}

            <!-- Network Activity Log -->
            <div class="border-t border-border flex flex-col bg-muted/10" style="flex: 1; min-height: 0;">
                <div class="p-5 border-b border-border bg-muted/20">
                    <div class="flex items-center gap-2">
                        <svg class="w-4 h-4 text-muted-foreground" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z"></path>
                        </svg>
                        <h3 class="text-sm font-medium">Network Activity</h3>
                    </div>
                </div>
                <div id="network-logs-container" class="flex-1 overflow-y-auto" style="max-height: 300px;">
                    ${this.renderNetworkLogs()}
                </div>
                
                <!-- Divider between sections -->
                <div class="h-px bg-border"></div>
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

        // Toggle invitation form button
        const toggleFormBtn = document.getElementById('toggle-invitation-form-btn');
        if (toggleFormBtn) {
            toggleFormBtn.onclick = () => {
                this.showInvitationForm = !this.showInvitationForm;
                this.render();
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

        // Network log expand/collapse
        document.querySelectorAll('.network-log-header').forEach(header => {
            header.onclick = () => {
                const logId = header.dataset.logId;
                this.toggleLogExpand(logId);
            };
        });
    }

    mount() {
        // Initial render
        this.render();
        
        // Set initial visibility
        this.updatePanelVisibility();
        
        // Hide legacy toggle button
        const oldToggleBtn = document.getElementById('toggle-right-panel-btn');
        if (oldToggleBtn) {
            oldToggleBtn.style.display = 'none';
        }
    }

    destroy() {
        if (this.timerInterval) {
            clearInterval(this.timerInterval);
        }
    }
}

export default RightPanel;

