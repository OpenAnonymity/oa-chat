import { motionDuration, setDisclosure } from '../ui/uiMotion.js';
/**
 * Right Panel Component
 * Manages the ticket system UI panel
 */

import tlsSecurityModal from './TLSSecurityModal.js';
import proxyInfoModal from './ProxyInfoModal.js';
import verifierAttestationModal from './VerifierAttestationModal.js';
import { getActivityDescription, getActivityIcon, getStatusIconClass, formatTimestamp } from '../services/networkLogRenderer.js';
import { getTicketCost } from '../services/modelTiers.js';
import preferencesStore, { PREF_KEYS } from '../services/preferencesStore.js';
import SmoothProgress from '../services/smoothProgress.js';
import { COUNCIL_OUTPUT_SYNTHESIS } from '../domain/councilConfig.js';
import { SLOT_NAMES } from '../extensions/extensionHost.js';

// Layout constant for toolbar overlay prediction
const RIGHT_PANEL_WIDTH = 288; // 18rem = 288px
// The panel shares the row with the chat from 768px up (a wallet side panel
// narrows a laptop window into this range and the chat must still be usable
// beside it). Below that it is a sheet over the chat, with a scrim. It is
// open by default only where the chat keeps a wide column: from 1024px.
const INLINE_PANEL_MIN_WIDTH = 768;
const DEFAULT_OPEN_MIN_WIDTH = 1024;

// Feature flag for showing underlying implementation on hover
const SHOW_UNDERLYING_KEY_DETAILS = true;

class RightPanel {
    constructor(app) {
        this.app = app; // Reference to main app
        tlsSecurityModal.configureServices?.(this.app.services);
        verifierAttestationModal.configureServices?.(this.app.services);
        this.currentSession = null;
        this.showAccessKeyInfo = false;
        this.showProxyInfo = false;

        // Responsive behavior: isDesktop = the panel is inline, beside the chat
        this.isDesktop = window.innerWidth >= INLINE_PANEL_MIN_WIDTH;
        this.defaultOpen = window.innerWidth >= DEFAULT_OPEN_MIN_WIDTH;

        // Panel visibility - check localStorage snapshot first to avoid flash
        const savedPanelVisible = localStorage.getItem('oa-right-panel-visible');
        this.isVisible = savedPanelVisible === 'true' ? true : savedPanelVisible === 'false' ? false : this.defaultOpen;

        this.ticketCount = 0;
        this.apiKey = null;
        this.apiKeyInfo = null;
        this.expiresAt = null;
        this.timeRemaining = null;
        this.isExpired = false;
        this.isRegistering = false;
        this.isRequestingKey = false;
        this.isRenewingKey = false;
        this.registrationProgress = null;
        this.registrationError = null;
        this.smoothProgress = new SmoothProgress({
            barSelector: '[data-smooth-progress="right-panel"]',
            textSelector: '[data-smooth-progress-text="right-panel"]',
        });
        this.isImporting = false;
        this.importStatus = null;
        this.isSplitting = false;
        this.timerInterval = null;
        this.lastLaneExpiryRenderAt = 0;
        this.pendingInvitationCode = null;
        this.pendingInvitationTickets = null;
        this.pendingInvitationSource = null;

        // Split controls state
        this.showSplitControls = false;
        this.splitCount = 1;
        this.splitResult = null; // { code, ticketsConsumed, expiresAt }

        // Ticket animation state
        this.currentTicket = null;
        this.ticketIndex = 0;
        this.showFinalized = false;
        this.isTransitioning = false;

        // Network logs state
        this.networkLogs = [];
        this.expandedLogIds = new Set();
        this.previousLogCount = 0;

        // Proxy state
        this.proxySettings = this.app.services.networkProxy.getSettings();
        this.proxyStatus = this.app.services.networkProxy.getStatus();
        this.proxyActionPending = false;
        this.proxyAnimating = false; // Flag to skip re-render during toggle animation
        this.lastProxyToggleTime = 0; // Rate limit for rapid toggles
        this.proxyUnsubscribe = this.app.services.networkProxy.onChange(({ settings, status }) => {
            const hadError = this.proxyStatus?.lastError;
            this.proxySettings = settings;
            this.proxyStatus = status;

            // Auto-disable proxy when it fails (new error detected while enabled)
            if (!hadError && status?.lastError && settings?.enabled && !this.proxyActionPending) {
                this.app.services.networkProxy.updateSettings({ enabled: false });
                return; // Will trigger another onChange with disabled state
            }

            // Skip re-render if animation is in progress (will re-render after animation)
            if (!this.proxyAnimating) {
                this.renderTopSectionOnly();
            }
        });
        this.accountUnsubscribe = this.app.services.account?.subscribe?.(() => {
            if (this.hasMounted) this.renderTopSectionOnly();
        }) || null;

        // Invitation code dropdown state - check localStorage snapshot first to avoid flash
        const savedFormVisible = localStorage.getItem('oa-invitation-form-visible');
        this.invitationFormPreference = savedFormVisible === 'true' ? true : savedFormVisible === 'false' ? false : null;
        this.showInvitationForm = this.invitationFormPreference ?? false;

        // Ticket info panel state - check localStorage snapshot first to avoid flash
        const savedTicketInfoVisible = localStorage.getItem('oa-ticket-info-visible');
        this.showTicketInfo = savedTicketInfoVisible === 'false' ? false : true;
        this.showExternalTicketInfo = false;
        this.lastAppliedVisibility = null;
        this.panelFadeCleanupTimer = null;
        this.panelFadeAnimation = null;
        this.hasMounted = false;

        this.initializeState();
        this.setupEventListeners();
        this.setupResponsive();

        this.loadPreferences();
    }

    loadPreferences() {
        preferencesStore.getPreference(PREF_KEYS.rightPanelVisible, { isDesktop: this.defaultOpen })
            .then((isVisible) => {
                if (typeof isVisible === 'boolean') {
                    this.isVisible = isVisible;
                    this.updatePanelVisibility();
                }
            });

        preferencesStore.getPreference(PREF_KEYS.ticketInfoVisible)
            .then((showTicketInfo) => {
                if (typeof showTicketInfo === 'boolean') {
                    this.showTicketInfo = showTicketInfo;
                    this.updateTicketInfoVisibility();
                    this.updateTicketInfoToggleButton();
                }
            });

        preferencesStore.getPreference(PREF_KEYS.invitationFormVisible)
            .then((invitationFormVisible) => {
                // Only apply saved preference if it's an explicit boolean
                // null means "auto" - use ticket count to determine visibility
                if (typeof invitationFormVisible === 'boolean') {
                    this.showInvitationForm = invitationFormVisible;
                    this.invitationFormPreference = invitationFormVisible;
                    this.renderTopSectionOnly();
                }
            });

        preferencesStore.onChange((key, value) => {
            if (key === PREF_KEYS.rightPanelVisible && typeof value === 'boolean') {
                this.isVisible = value;
                this.updatePanelVisibility();
            }
            if (key === PREF_KEYS.ticketInfoVisible && typeof value === 'boolean') {
                this.showTicketInfo = value;
                this.updateTicketInfoVisibility();
                this.updateTicketInfoToggleButton();
            }
            if (key === PREF_KEYS.invitationFormVisible && typeof value === 'boolean') {
                this.showInvitationForm = value;
                this.invitationFormPreference = value;
                this.renderTopSectionOnly();
            }
        });
    }

    initializeState() {
        // Load initial ticket count
        this.ticketCount = this.app.services.tickets.getTicketCount();
        // Only auto-show form when no tickets if user hasn't explicitly set a preference
        if (this.ticketCount === 0 && this.invitationFormPreference === null) {
            this.showInvitationForm = true;
        }

        // Load current ticket for animation
        this.loadNextTicket();

        // Get current session from app
        if (this.app) {
            this.currentSession = this.app.getCurrentSession();
            this.loadSessionData();
        }
    }

    loadSessionData() {
        if (!this.currentSession) {
            // No session selected - clear session data and show next ticket
            this.apiKey = null;
            this.apiKeyInfo = null;
            this.expiresAt = null;

            // Load next available ticket
            this.loadNextTicket();

            // Render to show ticket panel instead of API key panel
            this.renderTopSectionOnly();

            return;
        }

        // Load API key from current session
        this.app.services.inference.ensureSessionBackend(this.currentSession);
        const accessInfo = this.app.services.inference.getAccessInfo(this.currentSession);
        this.apiKey = accessInfo?.token || null;
        this.apiKeyInfo = accessInfo?.info || null;
        this.expiresAt = accessInfo?.expiresAt || null;

        // Load ALL network logs globally (not just for this session)
        this.networkLogs = this.app.services.networkLogger.getAllLogs();
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
        const tickets = this.app.services.tickets.getTickets();
        if (tickets && tickets.length > 0) {
            this.currentTicket = tickets[0];
            this.ticketIndex = 0;
        } else {
            this.currentTicket = null;
            this.ticketIndex = 0;
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

    normalizeInvitationCode(code) {
        if (!code) return '';
        return code.trim().replace(/[\s-]+/g, '');
    }

    getInvitationTicketCount(code) {
        const normalized = this.normalizeInvitationCode(code);
        if (normalized.length !== 24) return null;
        const suffix = normalized.slice(20, 24);
        const count = parseInt(suffix, 16);
        if (!Number.isFinite(count) || count <= 0) return null;
        return count;
    }

    getMaxSplitCount() {
        return Math.min(50, this.ticketCount);
    }

    getMembershipTicketToolsSnapshot() {
        const ticketCount = Number(this.app.services.tickets.getTicketCount?.() || 0);
        this.ticketCount = ticketCount;
        return Object.freeze({
            ticketCount,
            maxShareCount: Math.min(50, ticketCount),
            busy: Boolean(this.isImporting || this.isSplitting || this.isRegistering)
        });
    }

    getTicketCodeShareUrl(code, location = window.location) {
        const normalizedCode = this.normalizeInvitationCode(code);
        if (normalizedCode.length !== 24) return '';

        try {
            const origin = String(location?.origin || '').trim();
            if (!origin) return '';

            // One-time ticket codes must be redeemed in the environment that
            // issued them. Commercial and preview builds mount chat at /chat/;
            // the public client is also supported at the origin root.
            const pathname = String(location?.pathname || '/');
            const appPath = /^\/chat(?:\/|$)/i.test(pathname) ? '/chat/' : '/';
            const url = new URL(appPath, origin);
            url.searchParams.set('tickets', normalizedCode);
            return url.toString();
        } catch {
            return '';
        }
    }

    getTicketCodeRegistrationError(error) {
        const message = String(error?.message || '').trim();
        if (/already used|already redeemed/i.test(message)) {
            return 'This ticket code was already redeemed.';
        }
        if (/not found|expired/i.test(message)) {
            return 'This ticket code is unavailable. It may have expired or come from a different OA environment.';
        }
        return message || 'Unable to redeem this ticket code.';
    }

    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    escapeHtmlAttribute(text) {
        return String(text == null ? '' : text)
            .replace(/&/g, '&amp;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/\n/g, '&#10;');
    }

    updateTicketInfoVisibility() {
        const panel = document.getElementById('ticket-info-panel');
        if (!panel) return;

        const show = this.showTicketInfo;
        panel.classList.toggle('mb-3', show);
        panel.classList.toggle('mb-0', !show);
        panel.classList.toggle('max-h-[480px]', show);
        panel.classList.toggle('max-h-0', !show);
        panel.classList.toggle('opacity-100', show);
        panel.classList.toggle('opacity-0', !show);
        panel.classList.toggle('translate-y-0', show);
        panel.classList.toggle('-translate-y-1', !show);
        panel.classList.toggle('pointer-events-none', !show);
        panel.setAttribute('aria-hidden', show ? 'false' : 'true');
    }

    updateTicketInfoToggleButton() {
        const toggleInfoBtn = document.getElementById('toggle-ticket-info-btn');
        if (!toggleInfoBtn) return;

        toggleInfoBtn.title = this.showTicketInfo ? 'Hide ticket info' : 'Show ticket info';
        toggleInfoBtn.setAttribute('aria-pressed', this.showTicketInfo ? 'true' : 'false');
    }

    updateExternalTicketInfoVisibility() {
        const panel = document.getElementById('external-ticket-info-panel');
        const toggle = document.getElementById('toggle-external-ticket-info-btn');
        if (!panel || !toggle) return;

        const show = !!this.showExternalTicketInfo;
        this.updateHelpDisclosure(panel, toggle, show);
        toggle.title = show ? 'Hide inference ticket description' : 'What is an inference ticket?';
        toggle.setAttribute('aria-label', toggle.title);
    }

    getHelpDisclosures() {
        return [
            ['showExternalTicketInfo', 'external-ticket-info-panel', 'toggle-external-ticket-info-btn'],
            ['showAccessKeyInfo', 'ephemeral-key-info-panel', 'verifier-attestation-btn'],
            ['showProxyInfo', 'proxy-info-panel', 'proxy-info-btn']
        ];
    }

    updateHelpDisclosure(panel, button, open) {
        if (!panel || !button) return;
        panel.dataset.open = String(open);
        panel.setAttribute('aria-hidden', String(!open));
        panel.inert = !open;
        button.setAttribute('aria-expanded', String(open));
    }

    setOpenHelp(property = null) {
        for (const [name, panelId, buttonId] of this.getHelpDisclosures()) {
            this[name] = name === property;
            this.updateHelpDisclosure(document.getElementById(panelId), document.getElementById(buttonId), this[name]);
        }
        this.updateExternalTicketInfoVisibility();
    }

    togglePanelHelp(property) {
        const entry = this.getHelpDisclosures().find(([name]) => name === property);
        if (!entry) return;
        const button = document.getElementById(entry[2]);
        this.preserveHelpAnchor(button);
        this.setOpenHelp(this[property] ? null : property);
    }

    preserveHelpAnchor(button) {
        this.helpAnchorCleanup?.();
        const scroller = button?.closest('.oa-system-panel-body');
        if (!scroller) return;
        const top = button.getBoundingClientRect().top;
        const previousAnchor = scroller.style.overflowAnchor;
        scroller.style.overflowAnchor = 'none';
        const duration = Math.max(motionDuration(scroller, '--acc-expand', 250), motionDuration(scroller, '--acc-collapse', 250));
        const start = performance.now();
        let frame;
        const stop = () => {
            cancelAnimationFrame(frame);
            scroller.style.overflowAnchor = previousAnchor;
            scroller.removeEventListener('wheel', stop);
            scroller.removeEventListener('touchstart', stop);
            this.helpAnchorCleanup = null;
        };
        const keepPosition = () => {
            if (!button.isConnected) { stop(); return; }
            // Counter movement from another explanation closing above this one.
            // At the scroll boundary the accordion still collapses smoothly.
            scroller.scrollTop += button.getBoundingClientRect().top - top;
            if (performance.now() - start <= duration + 50) frame = requestAnimationFrame(keepPosition);
            else stop();
        };
        scroller.addEventListener('wheel', stop, { passive: true });
        scroller.addEventListener('touchstart', stop, { passive: true });
        this.helpAnchorCleanup = stop;
        frame = requestAnimationFrame(keepPosition);
    }

    attachHelpDismissal() {
        if (this.helpDismissClick) return;
        this.helpDismissClick = event => {
            const root = document.getElementById('right-panel-content');
            if (!root) return;
            const insideHelp = this.getHelpDisclosures().some(([, panelId, buttonId]) =>
                document.getElementById(panelId)?.contains(event.target) || document.getElementById(buttonId)?.contains(event.target));
            if (insideHelp) return;
            this.helpAnchorCleanup?.();
            this.setOpenHelp();
        };
        this.helpDismissKey = event => {
            if (event.key !== 'Escape' || event.defaultPrevented) return;
            const entry = this.getHelpDisclosures().find(([name]) => this[name]);
            if (!entry) return;
            const panel = document.getElementById(entry[1]);
            const button = document.getElementById(entry[2]);
            // Let a foreground modal handle its own Escape without moving focus.
            if (!document.getElementById('right-panel-content')?.contains(event.target)) return;
            event.preventDefault();
            const restoreFocus = panel?.contains(document.activeElement);
            this.preserveHelpAnchor(button);
            this.setOpenHelp();
            if (restoreFocus) button?.focus({ preventScroll: true });
        };
        document.addEventListener('click', this.helpDismissClick);
        document.addEventListener('keydown', this.helpDismissKey);
    }

    setupEventListeners() {
        // Listen for ticket updates
        window.addEventListener('tickets-updated', () => {
            const previousTicketCount = this.ticketCount;
            this.ticketCount = this.app.services.tickets.getTicketCount();
            // Only auto-show form when tickets run out if user hasn't explicitly set a preference
            if (this.ticketCount === 0 && previousTicketCount > 0 && this.invitationFormPreference === null) {
                this.showInvitationForm = true;
            }
            // Auto-collapse form when tickets are added (e.g. via WelcomePanel redemption)
            if (this.ticketCount > 0 && previousTicketCount === 0 && this.invitationFormPreference === null) {
                this.showInvitationForm = false;
            }
            this.loadNextTicket();
            this.renderTopSectionOnly(); // Only update top section, not logs
            this.updateStatusIndicator();
        });

        // Subscribe to network logger
        this.app.services.networkLogger.subscribe(() => {
            // Reload ALL logs globally
            // DON'T clear expandedLogIds - preserve expansion state
            const previousCount = this.previousLogCount;
            this.networkLogs = this.app.services.networkLogger.getAllLogs();
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
        // The sheet's scrim (phones only, by CSS) closes it like a tap outside.
        document.getElementById('right-panel-scrim')?.addEventListener('click', () => this.closeRightPanel());

        // Handle window resize - only update layout mode, NOT visibility
        // User's panel visibility choice is preserved across all screen sizes
        window.addEventListener('resize', () => {
            const wasDesktop = this.isDesktop;
            this.isDesktop = window.innerWidth >= INLINE_PANEL_MIN_WIDTH;

            // Only update panel rendering if we crossed the desktop threshold
            // DO NOT change isVisible - respect user's explicit open/close choice
            if (wasDesktop !== this.isDesktop) {
                this.updatePanelVisibility();
            }
        });

        // Initial status update
        this.updateStatusIndicator();
    }



    updateStatusIndicator() {
        const dot = document.getElementById('breathing-dot');

        if (!dot) return;

        const hasActiveKey = this.hasAnyActiveAccessKey();

        // Remove all status classes first
        dot.classList.remove('status-active', 'status-inactive');

        if (hasActiveKey) {
            dot.classList.add('status-active');
            dot.title = 'Key active';
        } else {
            dot.classList.add('status-inactive');
            dot.title = 'No active key';
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
            this.ensureLaneExpirationTimer();
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
                this.refreshLaneExpiryPanelIfNeeded(true);
                this.ensureLaneExpirationTimer();
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
                // Show share icon if: 1) owner shared their key, or 2) key was received from a share
                const isKeyShared = this.currentSession?.shareInfo?.apiKeyShared || this.currentSession?.apiKeyInfo?.isShared;
                const shareIcon = isKeyShared
                    ? `<span class="inline-flex w-3 h-3 items-center justify-center"><svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8.684 13.342C8.886 12.938 9 12.482 9 12c0-.482-.114-.938-.316-1.342m0 2.684a3 3 0 110-2.684m0 2.684l6.632 3.316m-6.632-6l6.632-3.316m0 0a3 3 0 105.367-2.684 3 3 0 00-5.367 2.684zm0 9.316a3 3 0 105.368 2.684 3 3 0 00-5.368-2.684z"/></svg></span>`
                    : '';
                timeRemainingEl.innerHTML = shareIcon + (this.timeRemaining || 'Loading...');
                timeRemainingEl.className = `font-medium px-1 py-0.5 rounded-full text-[10px] flex-shrink-0 ${this.getExpiryWidthClass(isKeyShared)} flex items-center ${this.getExpiryAlignmentClass(isKeyShared)} gap-0.5 tabular-nums whitespace-nowrap ${this.getTimerClasses(isKeyShared)}`;
            } else if (this.getCouncilAccessRows().length > 0) {
                this.refreshLaneExpiryPanelIfNeeded();
            }
        };

        updateTimeRemaining();
        this.timerInterval = setInterval(updateTimeRemaining, 1000);
    }

    show() {
        this.isVisible = true;
        preferencesStore.savePreference(PREF_KEYS.rightPanelVisible, true);
        this.updatePanelVisibility();
        // Predict final width: panel is opening, main area will be NARROWER
        // Only affects width while the panel is inline (>=768px); the sheet overlays
        // Grace period in updateToolbarDivider blocks intermediate updates during animation
        this.app?.updateToolbarDivider(this.isDesktop ? -RIGHT_PANEL_WIDTH : 0);
    }

    hide() {
        this.isVisible = false;
        preferencesStore.savePreference(PREF_KEYS.rightPanelVisible, false);
        this.updatePanelVisibility();
        // Predict final width: panel is closing, main area will be WIDER
        // Only affects width while the panel is inline (>=768px); the sheet overlays
        this.app?.updateToolbarDivider(this.isDesktop ? RIGHT_PANEL_WIDTH : 0);
    }

    toggle() {
        // Toggle the right panel visibility
        const wasVisible = this.isVisible;
        this.isVisible = !this.isVisible;
        preferencesStore.savePreference(PREF_KEYS.rightPanelVisible, this.isVisible);
        this.updatePanelVisibility();
        // Predict final width based on toggle direction
        // Only affects width while the panel is inline (>=768px); the sheet overlays
        this.app?.updateToolbarDivider(this.isDesktop ? (wasVisible ? RIGHT_PANEL_WIDTH : -RIGHT_PANEL_WIDTH) : 0);
    }

    closeRightPanel() {
        // Close the right panel (works in both desktop and mobile)
        this.isVisible = false;
        preferencesStore.savePreference(PREF_KEYS.rightPanelVisible, false);
        this.updatePanelVisibility();
        // Predict final width: panel is closing, main area will be WIDER
        // Only affects width while the panel is inline (>=768px); the sheet overlays
        this.app?.updateToolbarDivider(this.isDesktop ? RIGHT_PANEL_WIDTH : 0);
    }

    /**
     * Updates right panel visibility based on isDesktop and isVisible state.
     *
     * Behavior:
     * - Inline (>= 768px): panel reserves layout width and content slides out while width collapses
     * - Sheet (< 768px): panel slides in over the chat behind a scrim
     */
    updatePanelVisibility() {
        const panel = document.getElementById('right-panel');
        const showBtn = document.getElementById('show-right-panel-btn');
        const appContainer = document.getElementById('app');
        if (!panel) return;

        // Data attribute for CSS initial load protection
        if (this.isVisible) {
            document.documentElement.removeAttribute('data-right-panel-hidden');
        } else {
            document.documentElement.setAttribute('data-right-panel-hidden', 'true');
        }

        // Clear legacy inline styles. Visibility/layout is now entirely CSS-driven.
        panel.style.visibility = '';
        panel.style.overflow = '';
        panel.style.width = '';
        panel.style.borderLeftWidth = '';
        panel.style.transform = '';

        if (showBtn) {
            showBtn.classList.add('system-panel-toggle-visible');
            showBtn.setAttribute('aria-expanded', String(this.isVisible));
            showBtn.setAttribute('aria-label', this.isVisible ? 'Close system panel' : 'Open system panel');
            showBtn.setAttribute('data-tooltip', this.isVisible ? 'Close panel' : 'Open panel');
            if (!this.isVisible && panel.contains(document.activeElement)) showBtn.focus();
        }

        if (appContainer) {
            if (this.isDesktop && this.isVisible) {
                appContainer.classList.add('right-panel-open');
            } else {
                appContainer.classList.remove('right-panel-open');
            }
        }

        panel.inert = !this.isVisible;
        this.lastAppliedVisibility = this.isVisible;
    }

    playContentFadeIn() {
        const content = document.getElementById('right-panel-content');
        if (!content) return;

        if (this.panelFadeAnimation) {
            this.panelFadeAnimation.cancel();
            this.panelFadeAnimation = null;
        }

        content.classList.remove('system-panel-fade-prepare');
        content.classList.remove('system-panel-fade-in');
        content.style.willChange = 'opacity, transform, filter';

        this.panelFadeAnimation = content.animate(
            [
                { opacity: 0, transform: 'translateY(8px)', filter: 'blur(2px)' },
                { opacity: 1, transform: 'translateY(0)', filter: 'blur(0)' }
            ],
            {
                duration: 440,
                easing: 'cubic-bezier(0.22, 0.61, 0.36, 1)',
                fill: 'none'
            }
        );

        if (this.panelFadeCleanupTimer) {
            clearTimeout(this.panelFadeCleanupTimer);
        }
        this.panelFadeCleanupTimer = setTimeout(() => {
            if (this.panelFadeAnimation) {
                this.panelFadeAnimation.cancel();
                this.panelFadeAnimation = null;
            }
            content.style.willChange = '';
            this.panelFadeCleanupTimer = null;
        }, 500);
    }

    async handleRegister(invitationCode, options = {}) {
        if (!invitationCode || invitationCode.length !== 24) {
            this.registrationError = 'Invalid ticket code (must be 24 characters)';
            this.renderTopSectionOnly();
            const error = new Error(this.registrationError);
            if (options.throwOnError) throw error;
            return null;
        }

        this.isRegistering = true;
        this.registrationError = null;
        this.registrationProgress = { message: 'Starting...', percent: 0 };
        this.smoothProgress.start();
        this.renderTopSectionOnly();

        // Set current session for network logging
        if (this.currentSession && this.app.services.networkLogger) {
            this.app.services.networkLogger.setCurrentSession(this.currentSession.id);
        }

        try {
            await this.app.services.tickets.alphaRegister(invitationCode, (message, percent) => {
                this.smoothProgress.set(percent);
                this.registrationProgress = { message, percent };
                options.onProgress?.({ message, percent });
                // Update message text directly to avoid innerHTML replacement
                const msgEl = document.querySelector('[data-smooth-progress-msg="right-panel"]');
                if (msgEl) msgEl.textContent = message;
            });

            this.smoothProgress.stop();
            this.registrationProgress = null;
            this.ticketCount = this.app.services.tickets.getTicketCount();

            if (this.pendingInvitationSource) {
                const ticketCount = this.getInvitationTicketCount(invitationCode) ?? this.pendingInvitationTickets;
                const countLabel = Number.isFinite(ticketCount)
                    ? `${ticketCount} ticket${ticketCount === 1 ? '' : 's'}`
                    : 'tickets';
                this.app?.showToast?.(
                    `Ticket code redeemed for ${countLabel}`,
                    'success',
                    5000
                );
            }

            // Clear form
            const input = document.getElementById('invitation-code-input');
            if (input) input.value = '';

            // Auto-close progress and form after success
            setTimeout(() => {
                this.registrationProgress = null;
                this.showInvitationForm = false;
                this.invitationFormPreference = false;
                preferencesStore.savePreference(PREF_KEYS.invitationFormVisible, false);
                this.pendingInvitationCode = null;
                this.pendingInvitationTickets = null;
                this.pendingInvitationSource = null;
                this.renderTopSectionOnly();
                this.updateTicketInfoVisibility();
                this.updateTicketInfoToggleButton();
            }, 2000);
            return Object.freeze({ ticketCount: this.ticketCount });
        } catch (error) {
            console.warn('Ticket code redemption failed:', error);
            this.registrationError = this.getTicketCodeRegistrationError(error);
            this.smoothProgress.stop();
            this.registrationProgress = null;
            if (options.throwOnError) throw new Error(this.registrationError);
            return null;
        } finally {
            this.isRegistering = false;
            this.renderTopSectionOnly();
        }
    }

    applyInvitationCodeFromLink(code, { autoRedeem = false, source = null } = {}) {
        const normalizedCode = this.normalizeInvitationCode(code);
        if (!normalizedCode) return;

        this.pendingInvitationCode = normalizedCode;
        this.pendingInvitationTickets = this.getInvitationTicketCount(normalizedCode);
        this.pendingInvitationSource = source;

        // Force form open without persisting preference
        this.showInvitationForm = true;
        this.renderTopSectionOnly();

        requestAnimationFrame(() => {
            const input = document.getElementById('invitation-code-input');
            if (input) {
                input.value = normalizedCode;
            }
            if (autoRedeem && !this.isRegistering) {
                requestAnimationFrame(() => this.handleRegister(normalizedCode));
            }
        });
    }

    async handleImportTickets(file, inputEl = null, options = {}) {
        if (!file || this.isImporting) return;

        this.isImporting = true;
        this.importStatus = null;
        this.renderTopSectionOnly();

        try {
            const rawText = await file.text();
            const payload = JSON.parse(rawText);
            const result = await this.app.services.tickets.importTickets(payload);

            this.ticketCount = this.app.services.tickets.getTicketCount();
            this.loadNextTicket();

            const totalAdded = result.addedActive + result.addedArchived;
            if (totalAdded === 0) {
                this.importStatus = {
                    type: 'info',
                    message: 'No new tickets found in that file.'
                };
            } else {
                this.importStatus = {
                    type: 'success',
                    message: `Imported ${totalAdded} ticket${totalAdded !== 1 ? 's' : ''} (${result.addedActive} active, ${result.addedArchived} used).`
                };
            }
            return Object.freeze({
                addedActive: Number(result.addedActive || 0),
                addedArchived: Number(result.addedArchived || 0),
                ticketCount: this.ticketCount
            });
        } catch (error) {
            this.importStatus = {
                type: 'error',
                message: error.message || 'Failed to import tickets.'
            };
            if (options.throwOnError) throw error;
            return null;
        } finally {
            this.isImporting = false;
            if (inputEl) {
                inputEl.value = '';
            }
            this.renderTopSectionOnly();

            // Auto-clear success/info messages after a delay
            if (this.importStatus?.type === 'success' || this.importStatus?.type === 'info') {
                setTimeout(() => {
                    if (this.importStatus?.type === 'success' || this.importStatus?.type === 'info') {
                        this.importStatus = null;
                        this.renderTopSectionOnly();
                    }
                }, 2500);
            }
        }
    }

    handleSplitToggle() {
        // Don't allow opening split controls if there's already a result
        if (this.splitResult) {
            this.app?.showToast?.('Please dismiss the current code first', 'error');
            return;
        }

        this.showSplitControls = !this.showSplitControls;
        if (this.showSplitControls) {
            // Default to 1 ticket, max 50
            this.splitCount = Math.min(1, this.getMaxSplitCount());
        }
        this.renderTopSectionOnly();
    }

    handleSplitCountChange(delta) {
        const maxSplitCount = this.getMaxSplitCount();
        const newCount = this.splitCount + delta;
        if (newCount >= 1 && newCount <= maxSplitCount) {
            this.splitCount = newCount;
            // Update UI elements directly without full re-render
            const input = document.getElementById('split-count-input');
            const confirmBtn = document.getElementById('split-confirm-btn');
            const decreaseBtn = document.getElementById('split-decrease-btn');
            const increaseBtn = document.getElementById('split-increase-btn');
            if (input) input.value = this.splitCount;
            if (confirmBtn) confirmBtn.querySelector('span').textContent = `Split ${this.splitCount}`;
            if (decreaseBtn) decreaseBtn.disabled = this.splitCount <= 1;
            if (increaseBtn) increaseBtn.disabled = this.splitCount >= maxSplitCount;
        }
    }

    handleSplitCountInput(value) {
        const parsed = parseInt(value, 10);
        const maxSplitCount = this.getMaxSplitCount();
        if (!isNaN(parsed) && parsed >= 1 && parsed <= maxSplitCount) {
            this.splitCount = parsed;
            // Update confirm button text without full re-render to avoid losing focus
            const confirmBtn = document.getElementById('split-confirm-btn');
            if (confirmBtn) {
                confirmBtn.querySelector('span').textContent = `Split ${this.splitCount}`;
            }
        } else if (!isNaN(parsed)) {
            // Clamp to valid range
            this.splitCount = Math.max(1, Math.min(parsed, maxSplitCount));
            const confirmBtn = document.getElementById('split-confirm-btn');
            if (confirmBtn) {
                confirmBtn.querySelector('span').textContent = `Split ${this.splitCount}`;
            }
        }
    }

    async handleSplitConfirm() {
        const result = await this.performTicketSplit(this.splitCount, { autoCopy: true });
        if (result) {
            this.showSplitControls = false;
            this.splitResult = result;
        }
        this.renderTopSectionOnly();
    }

    async performTicketSplit(count, options = {}) {
        if (this.isSplitting) return null;
        const maxSplitCount = this.getMaxSplitCount();
        const normalizedCount = Number(count);
        if (!Number.isInteger(normalizedCount) || normalizedCount <= 0 || normalizedCount > maxSplitCount) {
            const error = new Error(`You can share at most ${maxSplitCount} tickets at a time.`);
            if (options.throwOnError) throw error;
            this.app?.showToast?.(error.message, 'error');
            return null;
        }

        this.isSplitting = true;
        this.renderTopSectionOnly();

        try {
            const result = await this.app.services.tickets.splitTickets(normalizedCount);
            this.ticketCount = this.app.services.tickets.getTicketCount();
            this.loadNextTicket();
            const splitResult = Object.freeze({
                code: result.code,
                ticketsConsumed: result.ticketsConsumed || normalizedCount,
                expiresAt: result.expiresAt || null,
                shareUrl: this.getTicketCodeShareUrl(result.code)
            });

            // Auto-copy the code to clipboard
            if (options.autoCopy) {
                try {
                    await navigator.clipboard.writeText(result.code);
                    this.app?.showToast?.('Code copied to clipboard!', 'success');
                } catch (copyError) {
                    console.error('Failed to auto-copy code:', copyError);
                    // Don't show error toast, user can still manually copy
                }
            }
            return splitResult;
        } catch (error) {
            if (options.throwOnError) throw error;
            this.app?.showToast?.(error.message || 'Failed to split tickets.', 'error');
            return null;
        } finally {
            this.isSplitting = false;
            this.renderTopSectionOnly();
        }
    }

    splitTicketsForMembership(count) {
        return this.performTicketSplit(count, { autoCopy: false, throwOnError: true });
    }

    handleSplitCancel() {
        this.showSplitControls = false;
        this.splitResult = null;
        this.renderTopSectionOnly();
    }

    handleSplitResultDismiss() {
        if (!this.splitResult) return;
        const splitShareUrl = this.getTicketCodeShareUrl(this.splitResult.code);

        this.app?.openSplitCodeDismissWarning?.(() => {
            this.splitResult = null;
            this.renderTopSectionOnly();
        }, {
            code: this.splitResult.code,
            ticketsConsumed: this.splitResult.ticketsConsumed || 1,
            shareUrl: splitShareUrl || ''
        });
    }

    async handleSplitResultCopy() {
        if (!this.splitResult?.code) return;

        try {
            await navigator.clipboard.writeText(this.splitResult.code);
            this.app?.showToast?.('Code copied!', 'success');
        } catch (error) {
            console.error('Failed to copy ticket code:', error);
            this.app?.showToast?.('Failed to copy code', 'error');
        }
    }

    async handleSplitResultCopyLink() {
        const splitShareUrl = this.getTicketCodeShareUrl(this.splitResult?.code);
        if (!splitShareUrl) return;

        try {
            await navigator.clipboard.writeText(splitShareUrl);
            this.app?.showToast?.('Ticket share link copied!', 'success');
        } catch (error) {
            console.error('Failed to copy ticket share link:', error);
            this.app?.showToast?.('Failed to copy ticket share link', 'error');
        }
    }

    async handleRequestApiKey() {
        if (!this.currentTicket || this.isRequestingKey) return;
        let session = this.currentSession;
        const backendId = session
            ? this.app.services.inference.ensureSessionBackend(session)
            : this.app.services.inference.getDefaultBackendId();
        let reservation = session ? this.app.beginSessionMutation(session.id, { exclusive: true }) : null;
        if (session && !reservation) return;
        this.isRequestingKey = true;
        const ownsView = () => session && this.currentSession?.id === session.id;
        try {
            // Capture the created session directly: a delayed creation must not
            // redeem against whichever historical chat was selected meanwhile.
            if (!session) {
                session = await this.app.createSession('New Chat', {
                    inferenceBackend: backendId,
                    onCreated: created => {
                        session = created;
                        reservation = this.app.beginSessionMutation(created.id, { exclusive: true });
                    }
                });
                if (!session || !reservation) return;
            }
            if (session.inferenceBackend !== backendId || this.app.isSessionDeleted(session.id)) return;
            this.app.services.networkLogger?.setCurrentSession(session.id);
            if (ownsView()) {
                this.isTransitioning = true;
                this.renderTopSectionOnly();
            }
            await new Promise(resolve => setTimeout(resolve, 500));
            if (ownsView()) {
                this.showFinalized = true;
                this.renderTopSectionOnly();
            }
            await new Promise(resolve => setTimeout(resolve, 1000));
            if (this.app.isSessionDeleted(session.id)) return;
            await this.app.acquireAndSetAccess(session);
            if (ownsView()) {
                const accessInfo = this.app.services.inference.getAccessInfo(session);
                this.apiKey = accessInfo?.token || null;
                this.apiKeyInfo = accessInfo?.info || null;
                this.expiresAt = accessInfo?.expiresAt || null;
                this.startExpirationTimer();
                this.updateStatusIndicator();
                this.app.floatingPanel?.render();
            }
        } catch (error) {
            if (!error?.isCancelled && error?.name !== 'AbortError') {
                const accessLabel = this.app.services.inference.getAccessLabel(session);
                this.app.showToast?.(`Failed to request ${accessLabel}: ${error.message}`, 'error');
            }
        } finally {
            this.isRequestingKey = false;
            this.isTransitioning = false;
            this.showFinalized = false;
            if (reservation) this.app.endSessionMutation(session.id, reservation);
            if (ownsView()) {
                this.loadNextTicket();
                this.renderTopSectionOnly();
            }
        }
    }

    async handleVerifyApiKey() {
        if (!this.apiKey || !this.currentSession) {
            const accessLabel = this.app.services.inference.getAccessLabel(this.currentSession);
            alert(`No ${accessLabel} available to verify`);
            return;
        }

        this.openVerifyKeyModal();
    }

    async handleClearApiKey() {
        const session = this.currentSession;
        if (!session) return;
        const reservation = this.app.beginSessionMutation(session.id, { exclusive: true });
        if (!reservation) return;
        try {
            this.app.services.inference.clearAccessInfo(session);
            await this.app.data.saveSession(session);
            if (this.currentSession?.id !== session.id) return;
            this.apiKey = null;
            this.apiKeyInfo = null;
            this.expiresAt = null;
            if (this.timerInterval) {
                clearInterval(this.timerInterval);
                this.timerInterval = null;
            }
            this.renderTopSectionOnly();
            this.updateStatusIndicator();
        } finally {
            this.app.endSessionMutation(session.id, reservation);
        }
    }

    async handleRenewApiKey() {
        if (this.isRenewingKey) return;
        this.isRenewingKey = true;
        this.renderTopSectionOnly();
        try {
            await this.handleRequestApiKey();
        } finally {
            this.isRenewingKey = false;
            this.renderTopSectionOnly();
        }
    }

    openVerifyKeyModal() {
        const modal = document.getElementById('verify-key-modal');
        if (!modal) return;

        // Store return focus element
        this.verifyModalReturnFocusEl = document.activeElement;

        const accessLabel = this.app.services.inference.getAccessLabel(this.currentSession);
        const accessLabelTitle = accessLabel.replace(/\b\w/g, (char) => char.toUpperCase());
        const modelIdForTest = (this.app && typeof this.app.getDefaultModelId === 'function')
            ? this.app.getDefaultModelId()
            : this.app.services.inference.getDefaultModelId(this.currentSession);

        // Generate curl command with actual key and output truncation
        const curlCommand = this.app.services.inference.buildCurlCommand(this.currentSession, this.apiKey, modelIdForTest);

        // Generate simplified modal content
        modal.innerHTML = `
            <div role="dialog" aria-modal="true" class="w-full max-w-2xl rounded-2xl border border-border bg-background shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">
                <!-- Header -->
                <div class="p-5 border-b border-border flex items-center justify-between">
                    <div class="flex items-center gap-2.5">
                        <div class="flex h-9 w-9 items-center justify-center rounded-lg bg-blue-100 dark:bg-blue-500/20">
                            <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5 text-blue-600 dark:text-blue-400" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor">
                                <path stroke-linecap="round" stroke-linejoin="round" d="M9 12.75L11.25 15 15 9.75m-3-7.036A11.959 11.959 0 013.598 6 11.99 11.99 0 003 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285z" />
                            </svg>
                        </div>
                        <h2 class="text-lg font-semibold text-foreground">Verify ${accessLabelTitle}</h2>
                    </div>
                    <button id="close-verify-modal" class="text-muted-foreground hover:text-foreground transition-colors p-1.5 rounded-lg hover:bg-accent">
                        <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"></path>
                        </svg>
                    </button>
                </div>

                <!-- Content -->
                <div class="overflow-y-auto flex-1 p-5 space-y-5">
                    <!-- Key Display -->
                    <div class="space-y-3">
                        <h3 class="text-sm font-semibold text-foreground">Active Ephemeral ${accessLabelTitle}</h3>
                        <div class="rounded-lg border border-border bg-card p-4">
                            <div class="flex items-center gap-2">
                                <code class="text-xs font-mono text-foreground flex-1 bg-muted/20 dark:bg-muted/30 px-3 py-2 rounded border border-border">${this.maskApiKey(this.apiKey)}</code>
                                <button id="copy-full-key-btn" class="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs rounded-md border border-border bg-background hover:bg-accent transition-all flex-shrink-0" data-key="${this.escapeHtml(this.apiKey)}">
                                    <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
                                        <path stroke-linecap="round" stroke-linejoin="round" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"></path>
                                    </svg>
                                    Copy
                                </button>
                            </div>
                            <p class="text-xs text-muted-foreground mt-2.5 flex items-center gap-1.5">
                                <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
                                    <path stroke-linecap="round" stroke-linejoin="round" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"></path>
                                </svg>
                                Obtained via blind signature - untraceable to your identity
                            </p>
                        </div>
                    </div>

                    <!-- Test with curl -->
                    <div class="space-y-3">
                        <div class="flex items-center justify-between">
                            <h3 class="text-sm font-semibold text-foreground">Test with curl</h3>
                            <button id="copy-curl-btn" class="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs rounded-md border border-border bg-background hover:bg-accent transition-all">
                                <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
                                    <path stroke-linecap="round" stroke-linejoin="round" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"></path>
                                </svg>
                                Copy
                            </button>
                        </div>
                        <div class="rounded-lg border border-border bg-card p-4">
                            <pre id="curl-code" class="text-xs font-mono text-foreground overflow-x-auto whitespace-pre-wrap break-all">${this.escapeHtml(curlCommand)}</pre>
                        </div>
                        <div class="text-xs text-muted-foreground">
                            <div class="font-medium mb-1">Expected output:</div>
                        </div>
                        <div class="rounded-lg border border-border bg-card p-4">
                            <pre class="text-xs font-mono text-foreground">"content":"Hello! How can I help you?"</pre>
                        </div>
                    </div>

                    <!-- Live Test -->
                    <div class="space-y-3">
                        <h3 class="text-sm font-semibold text-foreground">Test in Browser</h3>
                        <div class="rounded-lg border border-border bg-card p-4">
                            <div id="test-result">
                                <div class="flex items-center gap-2 text-sm text-muted-foreground">
                                    <svg class="animate-spin h-4 w-4" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                                        <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                                        <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                                    </svg>
                                    <span>Testing ${accessLabel}...</span>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        `;

        // Show modal
        modal.classList.remove('hidden');

        // Attach event listeners
        this.attachVerifyModalListeners();

        // Auto-run the test
        this.runApiKeyTest();
    }

    closeVerifyKeyModal() {
        const modal = document.getElementById('verify-key-modal');
        if (!modal) return;
        modal.classList.add('hidden');

        // Restore focus
        if (this.verifyModalReturnFocusEl && typeof this.verifyModalReturnFocusEl.focus === 'function') {
            this.verifyModalReturnFocusEl.focus();
        }
        this.verifyModalReturnFocusEl = null;
    }

    attachVerifyModalListeners() {
        // Close buttons
        const closeBtn = document.getElementById('close-verify-modal');
        const closeFooterBtn = document.getElementById('close-verify-modal-footer');
        if (closeBtn) closeBtn.onclick = () => this.closeVerifyKeyModal();
        if (closeFooterBtn) closeFooterBtn.onclick = () => this.closeVerifyKeyModal();

        // Click outside to close
        const modal = document.getElementById('verify-key-modal');
        if (modal) {
            modal.onclick = (e) => {
                if (e.target === modal) {
                    this.closeVerifyKeyModal();
                }
            };
        }

        // ESC key to close
        const handleEsc = (e) => {
            if (e.key === 'Escape') {
                this.closeVerifyKeyModal();
                document.removeEventListener('keydown', handleEsc);
            }
        };
        document.addEventListener('keydown', handleEsc);

        // Copy full key button
        const copyKeyBtn = document.getElementById('copy-full-key-btn');
        if (copyKeyBtn) {
            copyKeyBtn.onclick = async () => {
                const key = copyKeyBtn.dataset.key;
                try {
                    await navigator.clipboard.writeText(key);
                    const originalHTML = copyKeyBtn.innerHTML;
                    copyKeyBtn.innerHTML = `
                        <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
                            <path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"></path>
                        </svg>
                        Copied!
                    `;
                    setTimeout(() => {
                        copyKeyBtn.innerHTML = originalHTML;
                    }, 2000);
                } catch (error) {
                    console.error('Failed to copy:', error);
                }
            };
        }

        // Copy curl button
        const copyCurlBtn = document.getElementById('copy-curl-btn');
        if (copyCurlBtn) {
            copyCurlBtn.onclick = async () => {
                const curlCode = document.getElementById('curl-code');
                if (curlCode) {
                    try {
                        await navigator.clipboard.writeText(curlCode.textContent);
                        const originalHTML = copyCurlBtn.innerHTML;
                        copyCurlBtn.innerHTML = `
                            <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
                                <path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"></path>
                            </svg>
                            Copied!
                        `;
                        setTimeout(() => {
                            copyCurlBtn.innerHTML = originalHTML;
                        }, 2000);
                    } catch (error) {
                        console.error('Failed to copy:', error);
                    }
                }
            };
        }
    }

    async runApiKeyTest() {
        const testResult = document.getElementById('test-result');
        if (!testResult) return;

        try {
            const accessLabel = this.app.services.inference.getAccessLabel(this.currentSession);
            const accessLabelTitle = accessLabel.replace(/\b\w/g, (char) => char.toUpperCase());

            // Tag this request with session ID
            if (this.currentSession && this.app.services.networkLogger) {
                this.app.services.networkLogger.setCurrentSession(this.currentSession.id);
            }

            const modelIdForTest = (this.app && typeof this.app.getDefaultModelId === 'function')
                ? this.app.getDefaultModelId()
                : this.app.services.inference.getDefaultModelId(this.currentSession);

            const response = await this.app.services.inference.testAccessToken(this.currentSession, this.apiKey, modelIdForTest);

            if (response.ok) {
                const data = await response.json();
                const content = data.choices[0].message.content;
                const truncatedContent = content.length > 50 ? content.substring(0, 50) + '...' : content;
                testResult.innerHTML = `
                    <div class="flex items-center gap-2 text-sm font-semibold text-status-success mb-3">
                        <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
                            <path stroke-linecap="round" stroke-linejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"></path>
                        </svg>
                        <span>${accessLabelTitle} is Valid</span>
                    </div>
                    <div class="bg-status-success/10 border border-status-success/30 rounded-lg p-3">
                        <div class="text-xs space-y-1.5">
                            <div class="text-foreground"><strong class="text-status-success">Response:</strong> ${this.escapeHtml(truncatedContent)}</div>
                            <div class="text-foreground"><strong class="text-status-success">Tokens:</strong> ${data.usage.total_tokens}</div>
                        </div>
                    </div>
                `;
            } else {
                const error = await response.json();
                testResult.innerHTML = `
                    <div class="flex items-start gap-2 text-sm text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-500/10 border border-red-200 dark:border-red-500/30 rounded-lg p-3">
                        <svg class="w-5 h-5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
                            <path stroke-linecap="round" stroke-linejoin="round" d="M10 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2m7-2a9 9 0 11-18 0 9 9 0 0118 0z"></path>
                        </svg>
                        <div>
                            <p class="font-semibold">Verification Failed</p>
                            <p class="text-xs mt-1">${accessLabelTitle} expired or ${this.escapeHtml(error.error?.message || 'Unknown error')}</p>
                        </div>
                    </div>
                `;
            }
        } catch (error) {
            console.error('Verification error:', error);
            testResult.innerHTML = `
                <div class="flex items-start gap-2 text-sm text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-500/10 border border-red-200 dark:border-red-500/30 rounded-lg p-3">
                    <svg class="w-5 h-5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
                        <path stroke-linecap="round" stroke-linejoin="round" d="M10 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2m7-2a9 9 0 11-18 0 9 9 0 0118 0z"></path>
                    </svg>
                    <div>
                        <p class="font-semibold">Network Error</p>
                        <p class="text-xs mt-1">${this.escapeHtml(error.message)}</p>
                    </div>
                </div>
            `;
        }
    }

    async handleClearActivityTimeline() {
        if (this.app.services.networkLogger) {
            await this.app.services.networkLogger.clearAllLogs();
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
        return this.app.services.inference.maskAccessToken(this.currentSession, key);
    }

    getKeyDisplayInfo() {
        const displayMask = this.app.services.inference.maskAccessToken(this.currentSession, this.apiKey);

        if (!SHOW_UNDERLYING_KEY_DETAILS) {
            return { displayMask, hoverContentHtml: null };
        }

        // Disable hover tooltip for shared keys (only the sharer should see underlying key details)
        if (this.currentSession?.apiKeyInfo?.isShared) {
            return { displayMask, hoverContentHtml: null };
        }

        const underlyingInfo = this.app.services.inference.getUnderlyingKeyInfo(this.currentSession);
        if (!underlyingInfo) {
            return { displayMask, hoverContentHtml: null };
        }

        // HTML content with monospace keys
        const hoverContentHtml = `
            <div>This Ephemeral Access Key is implemented as:</div>
            <div class="mt-2 pt-2 border-t border-border/50">
            <b>Short-lived ${this.escapeHtml(underlyingInfo.backendLabel)} ${this.escapeHtml(underlyingInfo.accessType)}</b><br><code class="font-mono bg-muted/30 px-1 rounded text-[11px]">${this.escapeHtml(underlyingInfo.underlyingMask)}</code></div>
        `;

        return { displayMask, hoverContentHtml };
    }

    showKeyTooltip(targetEl, htmlContent) {
        this.hideKeyTooltip();

        const tooltip = document.createElement('div');
        tooltip.id = 'ephemeral-key-tooltip';
        tooltip.className = 'bg-popover text-popover-foreground border border-border rounded-lg shadow-lg p-3 text-xs pointer-events-none';
        // Use inline styles to avoid Tailwind class generation issues
        Object.assign(tooltip.style, {
            position: 'fixed',
            zIndex: '99999',
            maxWidth: '225px',
            opacity: '0' // Start invisible to calculate position first
        });
        tooltip.innerHTML = htmlContent;

        document.body.appendChild(tooltip);

        // Position tooltip below and right-aligned to target
        const rect = targetEl.getBoundingClientRect();
        const tooltipRect = tooltip.getBoundingClientRect();

        let top = rect.bottom + 8;
        let left = rect.right - tooltipRect.width;

        // Keep within viewport
        if (left < 8) left = 8;
        if (top + tooltipRect.height > window.innerHeight - 8) {
            top = rect.top - tooltipRect.height - 8;
        }

        // Set position and fade in
        Object.assign(tooltip.style, {
            top: `${top}px`,
            left: `${left}px`,
            opacity: '1',
            transition: 'opacity 0.15s ease-out'
        });
    }

    hideKeyTooltip() {
        const existing = document.getElementById('ephemeral-key-tooltip');
        if (existing) existing.remove();
    }

    getTimerClasses(isKeyShared = null) {
        if (this.isExpired) return 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400';
        // Check passed param, or check session for shared status
        const shared = isKeyShared ?? (this.currentSession?.shareInfo?.apiKeyShared || this.currentSession?.apiKeyInfo?.isShared);
        if (shared) return 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400';
        return 'badge-status-success';
    }

    getExpiryWidthClass(isKeyShared = null) {
        const shared = isKeyShared ?? (this.currentSession?.shareInfo?.apiKeyShared || this.currentSession?.apiKeyInfo?.isShared);
        return shared ? 'w-[11ch]' : 'w-[9ch]';
    }

    getExpiryAlignmentClass(isKeyShared = null) {
        const shared = isKeyShared ?? (this.currentSession?.shareInfo?.apiKeyShared || this.currentSession?.apiKeyInfo?.isShared);
        return shared ? 'justify-start' : 'justify-center';
    }

    /**
     * Generate the expanded details HTML for a log entry
     */
    generateExpandedDetailsHTML(log) {
        return `
            <div class="activity-log-details mt-2 text-xs bg-muted/10 rounded-lg border border-border/50 overflow-hidden" style="animation: slideDown 0.2s ease-out;">
                    <!-- Detailed description -->
                    <div class="px-3 pt-2.5 pb-2 bg-muted/5 border-b border-border/50">
                        <div class="text-foreground leading-relaxed">${log.status === 'pending' || log.status === 'queued' ? getActivityDescription(log, true) : this.escapeHtml(getActivityDescription(log, true))}</div>
                    </div>

                <!-- Technical Details -->
                <div class="p-3 space-y-2.5">
                    <!-- Status and Method -->
                    <div class="flex items-center gap-3">
                        <div class="flex items-center gap-1.5">
                            <span class="text-[10px] text-muted-foreground">Status:</span>
                            <span class="text-[10px] font-medium px-1.5 py-0.5 rounded ${
                                log.isAborted ? 'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400' :
                                log.status >= 200 && log.status < 300 ? 'badge-status-success' :
                                log.status === 0 ? 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400' :
                                'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400'
                            }">
                                ${log.isAborted ? 'INTERRUPTED' : (log.status || 'ERROR')}
                            </span>
                        </div>
                        <div class="flex items-center gap-1.5">
                            <span class="text-[10px] text-muted-foreground">Method:</span>
                            <span class="text-[10px] font-medium px-1.5 py-0.5 bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400 rounded">${this.escapeHtml(log.method)}</span>
                        </div>
                    </div>

                    <!-- URL -->
                    <div class="space-y-1">
                        <div class="text-[10px] text-muted-foreground font-medium">Destination</div>
                        <div class="text-[10px] font-mono bg-background p-2 rounded border border-border/50 break-all">
                            ${this.escapeHtml(log.url)}
                        </div>
                    </div>

                    <!-- Key Headers (if any) -->
                    ${log.request?.headers && Object.keys(log.request.headers).length > 0 ? `
                        <div class="space-y-2">
                            ${log.request.headers.Authorization && (log.method === 'POST' || log.type === 'api-key') ? `
                                <div class="space-y-1">
                                    <div class="text-[10px] text-muted-foreground font-medium">Authorization</div>
                                    <div class="text-[10px] font-mono text-muted-foreground bg-background p-2 rounded border border-border/50 break-words">
                                        ${this.escapeHtml(this.app.services.networkLogger.sanitizeHeaders({ Authorization: log.request.headers.Authorization }).Authorization)}
                                    </div>
                                </div>
                            ` : ''}
                            ${log.request.headers['X-Title'] ? `
                                <div class="space-y-1">
                                    <div class="text-[10px] text-muted-foreground font-medium">Application</div>
                                    <div class="text-[10px] font-mono text-muted-foreground bg-background p-2 rounded border border-border/50">
                                        ${this.escapeHtml(log.request.headers['X-Title'])}
                                    </div>
                                </div>
                            ` : ''}
                            ${log.request.headers['Content-Type'] ? `
                                <div class="space-y-1">
                                    <div class="text-[10px] text-muted-foreground font-medium">Content Type</div>
                                    <div class="text-[10px] font-mono text-muted-foreground bg-background p-2 rounded border border-border/50">
                                        ${this.escapeHtml(log.request.headers['Content-Type'])}
                                    </div>
                                </div>
                            ` : ''}
                        </div>
                    ` : ''}

                    <!-- Error or Success Message -->
                    ${log.error ? `
                        <div class="space-y-1">
                            <div class="text-[10px] text-red-600 dark:text-red-400 font-medium">Error Details</div>
                            <div class="text-[10px] text-red-600 dark:text-red-400 bg-red-50/50 dark:bg-red-900/30 p-2 rounded border border-red-200/50 dark:border-red-800/50">
                                ${this.escapeHtml(log.error)}
                            </div>
                        </div>
                    ` : log.response ? `
                        <div class="space-y-1">
                            <div class="text-[10px] text-muted-foreground font-medium">Response Summary</div>
                            <div class="text-[10px] text-muted-foreground bg-background p-2 rounded border border-border/50 break-words">
                                ${this.escapeHtml(this.app.services.networkLogger.getResponseSummary(log.response, log.status, {
                                    type: log.type,
                                    method: log.method,
                                    url: log.url
                                }) || 'Request completed successfully')}
                            </div>
                        </div>
                    ` : ''}
                </div>
            </div>
        `;
    }

    toggleLogExpand(logId) {
        const wasExpanded = this.expandedLogIds.has(logId);

        // Close all currently expanded logs first
        if (!wasExpanded) {
            // Remove all existing expanded details
            document.querySelectorAll('.activity-log-details').forEach(details => {
                setDisclosure(details, false, { remove: true });
            });
            this.expandedLogIds.clear();
        }

        // Find the log entry element
        const logEntry = document.querySelector(`.activity-log-entry[data-log-id="${logId}"]`);
        if (!logEntry) return;

        if (wasExpanded) {
            // Collapse: remove the details element
            const details = logEntry.querySelector('.activity-log-details');
            if (details) {
                setDisclosure(details, false, { remove: true });
            }
            this.expandedLogIds.delete(logId);
        } else {
            // Expand: find the log data and insert the details HTML
            const log = this.networkLogs.find(l => l.id === logId);
            if (!log) return;

            // Generate and insert the expanded details HTML
            const detailsHTML = this.generateExpandedDetailsHTML(log);
            const contentColumn = logEntry.querySelector('.flex-1.min-w-0');
            if (contentColumn) {
                // A rapid reopen reverses one existing detail instead of duplicating it.
                if (!contentColumn.querySelector('.activity-log-details')) contentColumn.insertAdjacentHTML('beforeend', detailsHTML);
                setDisclosure(contentColumn.querySelector('.activity-log-details'), true);
            }

            this.expandedLogIds.add(logId);
        }
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
        const inferenceBadge = {
            text: this.app.services.inference.getAccessShortLabel(this.currentSession),
            class: 'bg-blue-500 text-white'
        };
        const badges = {
            'openrouter': inferenceBadge,
            'inference': inferenceBadge,
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
            return 'text-status-success';
        } else if (status === 0) {
            return 'text-red-600';
        } else if (status >= 400) {
            return 'text-orange-600';
        }
        return 'text-gray-600';
    }

    getSessionInfo(sessionId) {
        if (!this.app || !sessionId) return null;
        const session = this.app.state.sessionsById?.get(sessionId) || this.app.state.sessions.find(s => s.id === sessionId);
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
        return this.app.services.inference.getAccessInfo(session)?.token || null;
    }

    /**
     * Counts how many sessions share the current API key
     * @returns {number} Number of sessions with matching API key
     */
    getSharedKeyCount() {
        if (!this.apiKey || !this.app) return 0;

        return this.app.state.sessions.filter(s => this.app.services.inference.getAccessInfo(s)?.token === this.apiKey).length;
    }

    hasAnyAccessKey() {
        return !!this.apiKey || this.getCouncilAccessRows().some((row) => !!row.access?.apiKey);
    }

    hasAnyActiveAccessKey() {
        if (this.apiKey && !this.isExpired) return true;
        return this.getCouncilAccessRows().some((row) => (
            !!row.access?.apiKey && this.getAccessExpiryLabel(row.access) !== 'Expired'
        ));
    }

    getCouncilAccessRows() {
        const session = this.currentSession;
        if (this.app.supportsFeature?.('council', session) === false) return [];
        const access = session?.councilAccess || null;
        const config = session
            ? (session.councilConfig || {})
            : this.getPendingCouncilAccessConfig();
        const isParallelMode = session
            ? session.responseMode === 'council' && config.enabled === true
            : config?.enabled === true;
        if (!isParallelMode) return [];

        const rows = [
            {
                id: 'primary',
                label: 'Model 1',
                access: access?.primary || null
            },
            {
                id: 'secondary',
                label: 'Model 2',
                access: access?.secondary || null
            }
        ];

        if (config.outputMode === COUNCIL_OUTPUT_SYNTHESIS) {
            rows.push({
                id: 'synthesis',
                label: 'Council',
                access: access?.synthesis || null
            });
        }

        return rows;
    }

    getPendingCouncilAccessConfig() {
        const pendingConfig = this.app.getPendingCouncilConfig?.();
        if (pendingConfig) return pendingConfig;
        return this.app.buildPersistedParallelCouncilConfig?.() || null;
    }

    getAccessExpiryLabel(access) {
        if (!access?.apiKey) return 'Pending';
        const expiresAt = access.expiresAt || access.apiKeyInfo?.expiresAt || access.apiKeyInfo?.expires_at || null;
        if (!expiresAt) return 'Active';

        const diffMs = new Date(expiresAt).getTime() - Date.now();
        if (!Number.isFinite(diffMs)) return 'Active';
        if (diffMs <= 0) return 'Expired';

        const hours = Math.floor(diffMs / 3600000);
        const minutes = Math.floor((diffMs % 3600000) / 60000);
        if (hours > 0) return `${hours}h ${minutes}m`;
        if (minutes > 0) return `${minutes}m`;
        return '<1m';
    }

    getAccessExpiryClasses(access) {
        if (!access?.apiKey) return 'bg-muted/30 text-muted-foreground';
        return this.getAccessExpiryLabel(access) === 'Expired'
            ? 'bg-red-500/10 text-red-600 dark:text-red-400'
            : 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400';
    }

    hasCouncilAccessKeys() {
        return this.getCouncilAccessRows().some((row) => !!row.access?.apiKey);
    }

    maskCouncilAccessToken(access) {
        if (!access?.apiKey) return '';
        const laneDisplaySession = {
            ...this.currentSession,
            currentEphemeralKeyId: null,
            ephemeralKeyMappings: null
        };
        return this.app.services.inference.maskAccessToken(laneDisplaySession, access.apiKey);
    }

    getLaneAttestationAccessInfo(access) {
        if (!access?.apiKey) return null;
        return {
            ...(access.apiKeyInfo || {}),
            key: access.apiKey,
            token: access.apiKey,
            expiresAt: access.expiresAt || access.apiKeyInfo?.expiresAt || access.apiKeyInfo?.expires_at || null
        };
    }

    ensureLaneExpirationTimer() {
        if ((this.expiresAt && !this.isExpired) || this.timerInterval || !this.hasCouncilAccessKeys()) return;

        this.timerInterval = setInterval(() => {
            if ((this.expiresAt && !this.isExpired) || !this.hasCouncilAccessKeys()) {
                clearInterval(this.timerInterval);
                this.timerInterval = null;
                return;
            }
            this.renderTopSectionOnly();
            this.updateStatusIndicator();
        }, 30000);
    }

    refreshLaneExpiryPanelIfNeeded(force = false) {
        if (this.getCouncilAccessRows().length === 0) return;
        const now = Date.now();
        if (!force && now - this.lastLaneExpiryRenderAt < 30000) return;
        this.lastLaneExpiryRenderAt = now;
        this.renderTopSectionOnly();
        this.updateStatusIndicator();
    }

    generateCouncilAccessKeyPanelHTML(rows, { embedded = false } = {}) {
        const rowHtml = rows.map((row) => {
            const access = row.access || null;
            const hasKey = !!access?.apiKey;
            const displayMask = hasKey
                ? this.maskCouncilAccessToken(access)
                : 'Requested on message send';
            const station = access?.apiKeyInfo?.stationId || access?.apiKeyInfo?.station_name || null;
            return `
                <div class="oa-lane-key-card rounded-md border ${hasKey ? 'border-border bg-muted/20' : 'border-dashed border-border bg-muted/10'} p-2">
                    <div class="flex items-center justify-between gap-2 mb-1.5">
                        <div class="min-w-0">
                            <div class="text-[10px] font-semibold text-foreground">${this.escapeHtml(row.label)}</div>
                        </div>
                        <div class="oa-lane-key-badges flex items-center gap-1 flex-shrink-0">
                            <span class="font-medium px-1.5 py-0.5 rounded-full text-[10px] tabular-nums whitespace-nowrap ${this.getAccessExpiryClasses(access)}">
                                ${this.escapeHtml(this.getAccessExpiryLabel(access))}
                            </span>
                        </div>
                    </div>
                    <div class="text-[10px] font-mono break-all ${hasKey ? 'text-foreground' : 'text-muted-foreground'}">${this.escapeHtml(displayMask)}</div>
                    ${station ? `
                        <div class="flex items-center justify-between mt-1.5 pt-1.5 border-t border-border/60">
                            <span class="text-[10px] text-muted-foreground">Issuing Station</span>
                            <span class="text-[10px] font-medium">${this.escapeHtml(station)}</span>
                        </div>
                    ` : ''}
                </div>
            `;
        }).join('');

        return `
            <div class="${embedded ? 'oa-right-panel-access-key min-w-0' : 'p-3'}">
                <div class="${embedded ? '' : 'mb-3'}">
                    <div class="flex items-center gap-1.5 mb-2">
                        <svg class="w-4 h-4 text-muted-foreground" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z"></path>
                        </svg>
                        <span class="text-xs font-medium">Ephemeral Access Keys</span>
                        ${this.generateAccessKeyInfoButtonHTML()}
                    </div>
                    ${this.generateAccessKeyInfoHTML()}
                    <div class="space-y-2">
                        ${rowHtml}
                    </div>
                </div>
            </div>
        `;
    }

    getMissingApiKeyStatus() {
        return {
            label: 'Requested on message send',
            badge: 'Pending',
            badgeClass: 'bg-muted/30 text-muted-foreground'
        };
    }

    generateAccessKeyInfoButtonHTML() {
        return `<button id="verifier-attestation-btn" type="button"
            class="inline-flex h-3.5 w-3.5 flex-shrink-0 items-center justify-center rounded-full border border-border text-[8px] text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
            title="What is an ephemeral key?" aria-label="What is an ephemeral key?"
            aria-controls="ephemeral-key-info-panel" aria-expanded="${!!this.showAccessKeyInfo}">?</button>`;
    }

    generateAccessKeyInfoHTML() {
        return `
            <div id="ephemeral-key-info-panel" class="oa-panel-disclosure t-acc" data-open="${!!this.showAccessKeyInfo}" aria-hidden="${!this.showAccessKeyInfo}"${this.showAccessKeyInfo ? '' : ' inert'}>
                <div class="t-acc-panel"><div class="oa-panel-disclosure-inner t-acc-panel-inner">
                    <div class="oa-panel-help">
                        <p>An ephemeral key is a temporary API key your device requests when you send a message. It lets you make multiple queries until its time or usage limit is reached.</p>
                        <p>The issuing station provides the key, and the verifier checks its ownership and limits. Shared keys keep their existing expiry and remaining allowance.</p>
                        ${this.getCouncilAccessRows().length ? this.getCouncilAccessRows().filter(row => row.access?.apiKey).map(row => `<button type="button" data-council-attestation-lane="${this.escapeHtmlAttribute(row.id)}" class="oa-panel-learn-more">Learn more: ${this.escapeHtml(row.label)}</button>`).join('') || '<p>Key details appear after you send a message.</p>' : '<button type="button" id="verifier-attestation-learn-more" class="oa-panel-learn-more">Learn more</button>'}
                    </div>
                </div></div>
            </div>`;
    }

    toggleAccessKeyInfo() {
        this.togglePanelHelp('showAccessKeyInfo');
    }

    generateSingleAccessKeyPanelHTML(hasApiKey, { embedded = false } = {}) {
        const missingAccess = this.getMissingApiKeyStatus();
        return hasApiKey ? `
            <div class="${embedded ? 'oa-right-panel-access-key min-w-0' : 'p-3'}">
                <div class="${embedded ? 'mb-2' : 'mb-3'}">
                    <div class="flex items-center gap-1.5 mb-2">
                        <svg class="w-4 h-4 text-muted-foreground" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z"></path>
                        </svg>
                        <span class="text-xs font-medium">Ephemeral Access Key</span>
                        ${this.generateAccessKeyInfoButtonHTML()}
                    </div>
                    ${this.generateAccessKeyInfoHTML()}
                    <div class="oa-key-detail-row flex items-center justify-between text-[10px] font-mono bg-muted/20 p-2 rounded-md border border-border break-all text-foreground">
                        ${(() => {
                            const keyInfo = this.getKeyDisplayInfo();
                            const hoverClasses = keyInfo.hoverContentHtml ? 'cursor-help hover:bg-muted/40 rounded px-1 -mx-1' : '';
                            return `<span id="ephemeral-key-display" class="flex-1 min-w-0 transition-colors ${this.isRenewingKey ? 'text-muted-foreground opacity-70' : ''} ${hoverClasses}"
                                ${keyInfo.hoverContentHtml ? 'data-has-tooltip="true"' : ''}>${keyInfo.displayMask}</span>`;
                        })()}
                        <div class="oa-key-badges flex items-center flex-shrink-0">
                            <button
                                id="renew-key-btn"
                                class="inline-flex items-center justify-center w-4 h-4 rounded-sm text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors disabled:opacity-60 disabled:pointer-events-none"
                                aria-label="Regenerate key"
                                title="Regenerate key"
                                ${this.isRenewingKey ? 'disabled' : ''}
                            >
                                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="w-3 h-3 ${this.isRenewingKey ? 'animate-spin' : ''}">
                                    <path stroke-linecap="round" stroke-linejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0 3.181 3.183a8.25 8.25 0 0 0 13.803-3.7M4.031 9.865a8.25 8.25 0 0 1 13.803-3.7l3.181 3.182m0-4.991v4.99" />
                                </svg>
                            </button>
                            <span id="api-key-expiry" class="font-medium px-1 py-0.5 rounded-full text-[10px] flex-shrink-0 ${this.getExpiryWidthClass()} flex items-center ${this.getExpiryAlignmentClass()} gap-0.5 tabular-nums whitespace-nowrap ${this.getTimerClasses()}">
                                ${(this.currentSession?.shareInfo?.apiKeyShared || this.currentSession?.apiKeyInfo?.isShared)
                                    ? `<span class="inline-flex w-3 h-3 items-center justify-center"><svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8.684 13.342C8.886 12.938 9 12.482 9 12c0-.482-.114-.938-.316-1.342m0 2.684a3 3 0 110-2.684m0 2.684l6.632 3.316m-6.632-6l6.632-3.316m0 0a3 3 0 105.367-2.684 3 3 0 00-5.367 2.684zm0 9.316a3 3 0 105.368 2.684 3 3 0 00-5.368-2.684z"/></svg></span>`
                                    : ''}${this.timeRemaining || 'Loading...'}
                            </span>
                        </div>
                    </div>
                </div>

                <div class="space-y-2 ${embedded ? '' : 'mb-3'}">

                    ${(this.apiKeyInfo?.stationId || this.apiKeyInfo?.station_name) ? `
                        <div class="oa-key-detail-row flex items-center justify-between p-2 bg-background rounded-md border border-border">
                            <span class="text-[10px] text-muted-foreground">Issuing Station</span>
                            <span class="text-[10px] font-medium">${this.escapeHtml(this.apiKeyInfo.stationId || this.apiKeyInfo.station_name)}</span>
                        </div>
                    ` : ''}

                    ${this.getSharedKeyCount() > 1 ? `
                        <div class="oa-key-detail-row flex items-center justify-between p-2 bg-primary/5 rounded-md border border-primary/20">
                            <span class="text-[10px] text-muted-foreground">Shared across</span>
                            <span class="text-[10px] font-medium text-primary">${this.getSharedKeyCount()} sessions</span>
                        </div>
                    ` : ''}
                </div>

            </div>
        ` : `
            <div class="${embedded ? 'oa-right-panel-access-key min-w-0' : 'p-3'}">
                <div class="${embedded ? 'mb-2' : 'mb-3'}">
                    <div class="flex items-center gap-1.5 mb-2">
                        <svg class="w-4 h-4 text-muted-foreground" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z"></path>
                        </svg>
                        <span class="text-xs font-medium">Ephemeral Access Key</span>
                        ${this.generateAccessKeyInfoButtonHTML()}
                    </div>
                    ${this.generateAccessKeyInfoHTML()}
                    <div class="oa-key-detail-row flex items-center justify-between text-[10px] bg-muted/10 p-2 rounded-md border border-dashed border-border text-muted-foreground">
                        <span class="flex-1 min-w-0">${this.escapeHtml(missingAccess.label)}</span>
                        <span class="font-medium px-1 py-0.5 rounded-full text-[10px] flex-shrink-0 ${this.escapeHtmlAttribute(missingAccess.badgeClass)}">${this.escapeHtml(missingAccess.badge)}</span>
                    </div>
                </div>
                <div class="space-y-2 ${embedded ? '' : 'mb-3'}">
                    <div class="oa-key-detail-row flex items-center justify-between p-2 bg-background rounded-md border border-dashed border-border">
                        <span class="text-[10px] text-muted-foreground">Issuing Station</span>
                        <span class="text-[10px] font-medium text-muted-foreground">To be assigned</span>
                    </div>
                </div>
            </div>
        `;
    }

    generateAccessKeyPanelHTML(hasApiKey, options = {}) {
        const councilAccessRows = this.getCouncilAccessRows();
        return councilAccessRows.length > 0
            ? this.generateCouncilAccessKeyPanelHTML(councilAccessRows, options)
            : this.generateSingleAccessKeyPanelHTML(hasApiKey, options);
    }

    /**
     * Generates HTML for the top section (tickets and API key) only.
     */
    getExternalTicketSummary(accountState = {}) {
        const ticketCount = Math.max(0, Number(this.ticketCount || 0));
        const hasUnlockedAccount = Boolean(
            accountState.accountId &&
            accountState.sessionVerified &&
            accountState.status === 'unlocked'
        );
        // Signed out there is nothing to count: the summary is the way in,
        // and it leads to sign-in (tickets need an account), not to billing.
        const needsSignIn = !hasUnlockedAccount && ticketCount === 0;
        const showGetTickets = ticketCount === 0;
        return {
            hasUnlockedAccount,
            needsSignIn,
            showGetTickets,
            ticketCount,
            ariaLabel: needsSignIn
                ? 'Sign in to get inference tickets'
                : showGetTickets
                    ? 'Get inference tickets'
                    : `Manage inference tickets, ${ticketCount} available`
        };
    }

    generateTopSectionHTML() {
        const hasApiKey = this.hasAnyAccessKey();
        return `${this.generateFundingSectionHTML()}
            ${this.fundingSectionIncludesAccessKey() ? '' : this.generateAccessKeyPanelHTML(hasApiKey)}
            ${this.generateProxySectionHTML()}`;
    }

    // The commercial ticket layout embeds access below its ticket summary.
    // Funding replacements must describe their own layout independently of
    // whether the host also offers ticket management.
    fundingSectionIncludesAccessKey() {
        return this.app.hasTicketManagementAction?.() === true;
    }

    // Compositions may replace funding while sharing the access, proxy and
    // activity UI. The default remains the standalone/commercial ticket flow.
    generateFundingSectionHTML() {
        const hasTickets = this.ticketCount > 0;
        const hasApiKey = this.hasAnyAccessKey();
        const fallbackTicketValue = 'Not stored';
        const previewTicket = this.currentTicket?.finalized_ticket
            || this.currentTicket?.signed_response
            || fallbackTicketValue;
        const blindedRequest = this.currentTicket?.blinded_request || fallbackTicketValue;
        const signedResponse = this.currentTicket?.signed_response || fallbackTicketValue;
        const finalizedTicket = this.currentTicket?.finalized_ticket || fallbackTicketValue;
        const pendingTickets = Number.isFinite(this.pendingInvitationTickets) ? this.pendingInvitationTickets : null;
        const maxSplitCount = this.getMaxSplitCount();
        const splitShareUrl = this.getTicketCodeShareUrl(this.splitResult?.code);
        const splitShareUrlEscaped = splitShareUrl ? this.escapeHtml(splitShareUrl) : '';
        const splitShareUrlAttribute = splitShareUrl ? this.escapeHtmlAttribute(splitShareUrl) : '';
        const accountState = this.app.services.account?.getState?.() || {};
        const ticketSummary = this.getExternalTicketSummary(accountState);
        const showGuestAccessCode = !ticketSummary.hasUnlockedAccount;
        const showLegacyTicketTools = false;
        const hasExternalTicketManager = this.app.hasTicketManagementAction?.() === true;

        return `
                ${hasExternalTicketManager ? `
                <div class="oa-right-panel-access-stack grid gap-6 p-3">
                    <div class="oa-right-panel-ticket-summary min-w-0">
                    <div class="flex items-center gap-1.5">
                        <button
                            id="open-ticket-manager-btn"
                            type="button"
                            class="btn-ghost-hover inline-flex min-w-0 items-center gap-1.5 rounded-md text-left text-xs font-medium text-foreground transition-all duration-150"
                            aria-label="${ticketSummary.ariaLabel}"
                        >
                            <svg class="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 5v2m0 4v2m0 4v2M5 5a2 2 0 00-2 2v3a2 2 0 110 4v3a2 2 0 002 2h14a2 2 0 002-2v-3a2 2 0 110-4V7a2 2 0 00-2-2H5z"></path>
                            </svg>
                            <span>${ticketSummary.showGetTickets ? 'Get tickets' : `Inference Tickets: <span class="font-semibold">${ticketSummary.ticketCount}</span>`}</span>
                        </button>
                        <button
                            id="toggle-external-ticket-info-btn"
                            type="button"
                            class="inline-flex h-3.5 w-3.5 flex-shrink-0 items-center justify-center rounded-full border border-border text-[8px] text-muted-foreground transition-all hover:border-foreground/20 hover:bg-accent hover:text-foreground"
                            title="${this.showExternalTicketInfo ? 'Hide inference ticket description' : 'What is an inference ticket?'}"
                            aria-label="${this.showExternalTicketInfo ? 'Hide inference ticket description' : 'What is an inference ticket?'}"
                            aria-controls="external-ticket-info-panel"
                            aria-expanded="${this.showExternalTicketInfo ? 'true' : 'false'}"
                        >?</button>
                    </div>
                    <div
                        id="external-ticket-info-panel"
                        class="oa-panel-disclosure t-acc" data-open="${!!this.showExternalTicketInfo}"${this.showExternalTicketInfo ? '' : ' inert'}
                        aria-hidden="${this.showExternalTicketInfo ? 'false' : 'true'}"
                    >
                        <div class="t-acc-panel"><div class="oa-panel-disclosure-inner t-acc-panel-inner"><div class="oa-panel-help">
                            <p>Redeem inference tickets for a temporary API key with up to 20 minutes of model access. Each key supports multiple queries, until its time or usage limit is reached.</p>
                            <p class="mt-2">Blind signatures prevent redeemed tickets from being linked to your purchase. Your queries go directly to the model provider, not The Open Anonymity Project.</p>
                        </div></div></div>
                    </div>
                    <div data-oa-extension-slot="${SLOT_NAMES.RIGHT_PANEL_TICKET_STATUS}" hidden></div>
                    <div class="system-panel-divider" aria-hidden="true"></div>
                    </div>
                    ${this.generateAccessKeyPanelHTML(hasApiKey, { embedded: true })}
                </div>
                ` : `
                <!-- Invitation Code Section -->
                <div class="p-3">
                <div class="flex items-center justify-between">
                    <div class="flex items-center gap-1.5">
                        <svg class="w-3.5 h-3.5 text-muted-foreground" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 5v2m0 4v2m0 4v2M5 5a2 2 0 00-2 2v3a2 2 0 110 4v3a2 2 0 002 2h14a2 2 0 002-2v-3a2 2 0 110-4V7a2 2 0 00-2-2H5z"></path>
                        </svg>
                        <span class="text-xs font-medium">Inference Tickets: <span class="font-semibold">${this.ticketCount}</span></span>
                        <button
                            id="toggle-ticket-info-btn"
                            class="inline-flex h-3.5 w-3.5 items-center justify-center rounded-full border border-border text-[8px] text-muted-foreground hover:text-foreground hover:bg-accent hover:border-foreground/20 transition-all"
                            title="${this.showTicketInfo ? 'Hide ticket info' : 'Show ticket info'}"
                            aria-pressed="${this.showTicketInfo ? 'true' : 'false'}"
                            type="button"
                        >
                            ?
                        </button>
                    </div>
                    ${showGuestAccessCode ? `<button
                        id="toggle-invitation-form-btn"
                        class="btn-ghost-hover inline-flex items-center gap-1 px-2 py-1 text-[10px] rounded-md border border-border bg-background transition-all duration-200 shadow-sm"
                    >
                        <span>${this.showInvitationForm ? 'Hide' : 'Add'}</span>
                        <svg class="w-2.5 h-2.5 transition-transform ${this.showInvitationForm ? 'rotate-180' : ''}" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"></path>
                        </svg>
                    </button>` : ''}
                </div>

                ${showLegacyTicketTools ? `<div class="mt-2 flex items-center gap-1.5">
                    <input
                        id="import-tickets-input"
                        type="file"
                        accept="application/json,.json"
                        class="hidden"
                    />
                    <button
                        id="import-tickets-btn"
                        class="btn-ghost-hover inline-flex items-center justify-center gap-1 px-2 py-1 text-[10px] rounded-md border border-border bg-background transition-all duration-200 shadow-sm flex-1"
                        ${this.isImporting ? 'disabled' : ''}
                    >
                        <span>Import</span>
                    </button>
                    <button
                        id="split-tickets-btn"
                        class="btn-ghost-hover inline-flex items-center justify-center gap-1 px-2 py-1 text-[10px] rounded-md border border-border bg-background transition-all duration-200 shadow-sm flex-1"
                        title="${this.splitResult ? 'Dismiss current code first' : 'Split tickets into a ticket code (max 50)'}"
                        ${this.ticketCount === 0 || this.splitResult ? 'disabled' : ''}
                    >
                        <span>Split</span>
                    </button>
                </div>

                ${this.showSplitControls ? `
                <div id="split-controls" class="mt-2 flex items-center gap-1.5">
                    <button
                        id="split-decrease-btn"
                        class="btn-ghost-hover inline-flex items-center justify-center w-6 h-6 text-[10px] rounded border border-border bg-background transition-all duration-200 shadow-sm"
                        ${this.splitCount <= 1 || this.isSplitting ? 'disabled' : ''}
                    >−</button>
                    <input
                        id="split-count-input"
                        type="text"
                        inputmode="numeric"
                        pattern="[0-9]*"
                        value="${this.splitCount}"
                        class="input-focus-clean w-12 px-1 py-1 text-[10px] text-center border border-border rounded bg-background text-foreground"
                        ${this.isSplitting ? 'disabled' : ''}
                    />
                    <button
                        id="split-increase-btn"
                        class="btn-ghost-hover inline-flex items-center justify-center w-6 h-6 text-[10px] rounded border border-border bg-background transition-all duration-200 shadow-sm"
                        ${this.splitCount >= maxSplitCount || this.isSplitting ? 'disabled' : ''}
                    >+</button>
                    <button
                        id="split-confirm-btn"
                        class="btn-ghost-hover inline-flex items-center justify-center gap-1 px-2 py-1 text-[10px] rounded-md border border-border bg-background transition-all duration-200 shadow-sm flex-1"
                        ${this.isSplitting ? 'disabled' : ''}
                    >
                        <span>${this.isSplitting ? 'Splitting...' : `Split ${this.splitCount}`}</span>
                    </button>
                    <button
                        id="split-cancel-btn"
                        class="btn-ghost-hover inline-flex items-center justify-center px-2 py-1 text-[10px] rounded-md border border-border bg-background transition-all duration-200 shadow-sm text-muted-foreground"
                        ${this.isSplitting ? 'disabled' : ''}
                    >
                        <span>Cancel</span>
                    </button>
                </div>
                ` : ''}

                ${this.splitResult ? `
                <div id="split-result" class="split-result-card">
                    <div class="split-result-header">
                        <span class="split-result-title">Ticket code created for ${this.splitResult.ticketsConsumed || 1} valid ticket${(this.splitResult.ticketsConsumed || 1) === 1 ? '' : 's'}</span>
                        <button
                            id="split-result-dismiss"
                            class="split-result-icon-btn split-result-dismiss-btn"
                            title="Dismiss"
                            type="button"
                        >
                            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <path d="M18 6L6 18M6 6l12 12"/>
                            </svg>
                        </button>
                    </div>
                    <div class="split-result-field-row">
                        <code class="split-result-field-value">${this.escapeHtml(this.splitResult.code)}</code>
                        <button
                            id="split-result-copy"
                            class="split-result-icon-btn"
                            type="button"
                            title="Copy ticket code"
                        >
                            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <rect width="14" height="14" x="8" y="8" rx="2"/>
                                <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>
                            </svg>
                        </button>
                    </div>
                    ${this.splitResult.expiresAt ? `
                    <div class="split-result-share-label">
                        Usable until ${this.escapeHtml(this.formatUTCtoLocal(this.splitResult.expiresAt))}
                    </div>
                    ` : ''}
                    ${splitShareUrl ? `
                    <div class="split-result-share">
                        <div class="split-result-share-label">
                            You can share the tickets with this link:
                        </div>
                        <div class="split-result-field-row">
                            <a
                                id="split-result-share-link"
                                class="split-result-field-value split-result-share-link"
                                href="${splitShareUrlAttribute}"
                                target="_blank"
                                rel="noopener noreferrer"
                                title="${splitShareUrlAttribute}"
                            >${splitShareUrlEscaped}</a>
                            <button
                                id="split-result-copy-link"
                                class="split-result-icon-btn"
                                type="button"
                                title="Copy ticket share link"
                            >
                                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                    <rect width="14" height="14" x="8" y="8" rx="2"/>
                                    <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>
                                </svg>
                            </button>
                        </div>
                    </div>
                    ` : ''}
                </div>
                ` : ''}
                ` : ''}

                ${showGuestAccessCode && this.showInvitationForm ? `
                    <form id="invitation-code-form" class="space-y-2 mt-3 p-3 bg-muted/10 rounded-lg">
                        <div class="invitation-code-input-shell flex items-center w-full h-8 border border-border rounded-md bg-background transition-all">
                            <input
                                id="invitation-code-input"
                                type="text"
                                placeholder="Enter 24-char ticket code"
                                maxlength="24"
                                class="flex-1 h-full px-3 text-xs bg-transparent text-foreground placeholder:text-muted-foreground/70 focus:outline-none"
                                value="${this.pendingInvitationCode ? this.escapeHtml(this.pendingInvitationCode) : ''}"
                                ${this.isRegistering ? 'disabled' : ''}
                            />
                            <button
                                type="submit"
                                class="flex-shrink-0 w-6 h-6 m-1 rounded-md border border-border bg-background text-muted-foreground hover:text-foreground hover:bg-accent transition-colors flex items-center justify-center disabled:opacity-50 disabled:pointer-events-none"
                                aria-label="${this.isRegistering ? 'Redeeming ticket code' : 'Redeem ticket code'}"
                                ${this.isRegistering ? 'disabled' : ''}
                            >
                                <svg class="w-3 h-3" width="12" height="12" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
                                    <path stroke-linecap="round" stroke-linejoin="round" d="M13.5 4.5L21 12m0 0l-7.5 7.5M21 12H3" />
                                </svg>
                            </button>
                        </div>
                        <a
                            href="https://openanonymity.ai/beta"
                            target="_blank"
                            rel="noopener noreferrer"
                            class="btn-ghost-hover w-full inline-flex items-center justify-center gap-1.5 rounded-md text-xs font-medium transition-all duration-200 focus-visible:outline-none bg-background text-foreground h-8 px-3 shadow-sm border border-border"
                        >
                            <svg class="w-3 h-3 flex-shrink-0" width="12" height="12" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
                                <path stroke-linecap="round" stroke-linejoin="round" d="M13.5 6H5.25A2.25 2.25 0 003 8.25v10.5A2.25 2.25 0 005.25 21h10.5A2.25 2.25 0 0018 18.75V10.5m-10.5 6L21 3m0 0h-5.25M21 3v5.25"></path>
                            </svg>
                            <span>Request invite code</span>
                        </a>
                    </form>

                    ${this.registrationProgress ? `
                        <div class="mt-2 text-[10px] space-y-1">
                            <div class="text-foreground" data-smooth-progress-msg="right-panel">${this.escapeHtml(this.registrationProgress.message)}</div>
                            <div class="w-full bg-muted rounded-full h-1.5">
                                <div class="bg-primary h-1.5 rounded-full" data-smooth-progress="right-panel" style="width: ${this.smoothProgress.getDisplayed()}%"></div>
                            </div>
                        </div>
                    ` : ''}

                    ${this.registrationError ? `
                        <div class="mt-2 text-[10px] text-destructive">
                            ${this.escapeHtml(this.registrationError)}
                        </div>
                    ` : ''}
                ` : ''}

                ${this.importStatus ? `
                    <div class="mt-2 px-3 text-[10px] leading-relaxed ${
                        this.importStatus.type === 'error'
                            ? 'text-destructive opacity-80'
                            : 'text-muted-foreground'
                    }">
                        ${this.escapeHtml(this.importStatus.message)}
                    </div>
                ` : ''}

            </div>
            `}

            <!-- Ticket Visualization Section -->
            ${hasExternalTicketManager ? '' : `
            <div id="ticket-info-panel" class="mx-3 ${this.showTicketInfo ? 'mb-3 max-h-[480px] opacity-100 translate-y-0' : 'mb-0 max-h-0 opacity-0 -translate-y-1 pointer-events-none'} overflow-hidden transition-all duration-200 ease-in-out" aria-hidden="${this.showTicketInfo ? 'false' : 'true'}">
                <div class="p-2 bg-muted/5 rounded-lg border border-border">
                        <div id="ticket-info-header" class="flex items-center gap-2 cursor-pointer group">
                            <button
                                id="ticket-info-question-btn"
                                class="inline-flex h-4 w-4 items-center justify-center rounded-full border border-border text-[9px] text-muted-foreground hover:text-foreground hover:bg-accent hover:border-foreground/20 transition-all"
                                title="Collapse ticket info"
                                type="button"
                            >?</button>
                            <span class="text-xs font-semibold text-foreground flex-1">How Inference Tickets Work</span>
                            <button
                                id="ticket-info-collapse-btn"
                                class="inline-flex h-4 w-4 items-center justify-center rounded-full border border-border text-muted-foreground hover:text-foreground hover:bg-accent hover:border-foreground/20 transition-all"
                                title="Collapse ticket info"
                                type="button"
                            >
                                <svg class="w-2.5 h-2.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M5 15l7-7 7 7"></path>
                                </svg>
                            </button>
                        </div>
                    <p class="oa-ticket-help-copy text-[10px] text-muted-foreground leading-snug mt-1">
                    Inference tickets are privacy-preserving payment tokens that are detached from your identity (think cash or casino chips).
                    When you start a new chat session, your device auto-redeems tickets for a short-lived, credit-limited access key just for this session (think prepaid SIM cards), making your inference traffic unlinkable to you.<br><br>
                    Cryptographically, tickets are implemented with <a href="https://en.wikipedia.org/wiki/Blind_signature" class="underline hover:text-foreground transition-colors" target="_blank" rel="noopener noreferrer">blind signatures</a>: your device generates and blinds them, the OA server blind-signs them to make them valid, and you unblind them for later use.
                    </p>

                    <div class="ticket-details mt-2" data-expanded="false">
                        <div class="ticket-preview-toggle cursor-pointer rounded-md border border-dashed border-border bg-background/70 p-2 transition-colors hover-highlight ${
                            this.isTransitioning ? 'opacity-70' : ''
                        }">
                            <div class="flex items-center justify-between text-[10px] text-muted-foreground">
                                <span>Next ticket</span>
                                <span class="ticket-expand-hint">Click to expand</span>
                            </div>
                            <div class="mt-1 text-[10px] font-mono break-all text-foreground">
                                ${this.formatTicketData(previewTicket)}
                            </div>
                        </div>

                        <div class="ticket-details-full hidden mt-2 space-y-2 max-h-[160px] overflow-y-auto pr-1">
                            <div>
                                <div class="text-[10px] text-muted-foreground">Locally blinded</div>
                                <div class="ticket-data-display bg-background border border-dashed border-border rounded p-1.5 text-[10px] font-mono break-all text-muted-foreground cursor-pointer hover-highlight transition-colors max-h-24 overflow-y-auto" data-full="${this.escapeHtml(blindedRequest)}" data-expanded="false">
                                    ${this.formatTicketData(blindedRequest)}
                                </div>
                            </div>
                            <div>
                                <div class="text-[10px] text-muted-foreground">OA signed</div>
                                <div class="ticket-data-display bg-background border border-dashed border-border rounded p-1.5 text-[10px] font-mono break-all text-muted-foreground cursor-pointer hover-highlight transition-colors max-h-24 overflow-y-auto" data-full="${this.escapeHtml(signedResponse)}" data-expanded="false">
                                    ${this.formatTicketData(signedResponse)}
                                </div>
                            </div>
                            <div>
                                <div class="text-[10px] text-muted-foreground">Locally unblinded (ready)</div>
                                <div class="ticket-data-display bg-accent/50 border border-primary rounded p-1.5 text-[10px] font-mono break-all text-foreground cursor-pointer hover:bg-accent/70 transition-colors max-h-24 overflow-y-auto" data-full="${this.escapeHtml(finalizedTicket)}" data-expanded="false">
                                    ${this.formatTicketData(finalizedTicket)}
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
            `}

            ${hasTickets && !hasApiKey && !this.currentTicket ? `
                <div class="mx-3 mb-3 p-4">
                    <div class="text-center text-xs text-muted-foreground">
                        <svg class="w-8 h-8 mx-auto mb-2 text-muted-foreground/30" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"></path>
                        </svg>
                        No tickets available
                    </div>
                </div>
            ` : ''}

        `;
    }

    formatUTCtoLocal(utcTimestamp) {
        const date = new Date(utcTimestamp);
        return date.toLocaleString(undefined, {
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit'
        });
    }

    formatVerificationTime(timestamp) {
        const date = new Date(timestamp);
        const now = new Date();
        const diffMs = now - date;
        const diffMins = Math.floor(diffMs / 60000);

        if (diffMins < 1) return 'Just now';
        if (diffMins < 60) return `${diffMins}m ago`;

        const diffHours = Math.floor(diffMins / 60);
        if (diffHours < 24) return `${diffHours}h ago`;

        return date.toLocaleDateString();
    }

    getProxyStatusMeta(settings = this.proxySettings, status = this.proxyStatus) {
        if (this.proxyActionPending) {
            return this.proxyPendingEnabled
                ? { state: 'connecting', label: 'Connecting to proxy…', textClass: 'text-muted-foreground' }
                : { state: 'off', label: 'Direct connection', textClass: 'text-muted-foreground' };
        }
        if (!settings?.enabled && this.proxyFailureDismissed) {
            return { state: 'off', label: 'Direct connection', textClass: 'text-muted-foreground' };
        }
        // A failed connection may have automatically switched off. Keep the
        // warning visible until the user retries or explicitly disables it.
        if (status?.fallbackActive || status?.lastError || this.proxyActionError) {
            return { state: 'unavailable', label: 'Unavailable', textClass: 'text-amber-600 dark:text-amber-400' };
        }
        if (!settings?.enabled) {
            return { state: 'off', label: 'Direct connection', textClass: 'text-muted-foreground' };
        }
        if (status?.connectionVerified && status?.usingProxy) {
            return { state: 'connected', label: 'Connected through proxy', textClass: 'text-status-success' };
        }
        if (status?.ready) {
            return { state: 'ready', label: 'Proxy ready; connection verified on the next request', textClass: 'text-blue-600 dark:text-blue-400' };
        }
        return { state: 'connecting', label: 'Connecting to proxy…', textClass: 'text-muted-foreground' };
    }

    generateProxyStatusIconHTML(meta) {
        return `<span class="oa-proxy-status-icon ${meta.textClass}" data-proxy-state="${meta.state}" tabindex="0" role="img" aria-label="${this.escapeHtmlAttribute(meta.label)}">
            <span class="t-skel-skeleton ${meta.state === 'connecting' ? 'is-pulsing' : ''}">
                <svg aria-hidden="true" class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
                    <circle cx="12" cy="9" r="8"/><path d="M4 9h16M12 1a12 12 0 0 1 3.5 8 12 12 0 0 1-3.5 8 12 12 0 0 1-3.5-8A12 12 0 0 1 12 1zM12 17v4M4 22h6m4 0h6"/><circle cx="12" cy="22" r="1.5" fill="currentColor"/>
                </svg>
            </span>
            <span class="oa-proxy-status-tooltip" aria-hidden="true">${this.escapeHtml(meta.label)}</span>
        </span>`;
    }

    generateProxyInfoHTML() {
        return `<div id="proxy-info-panel" class="oa-panel-disclosure t-acc" data-open="${!!this.showProxyInfo}" aria-hidden="${!this.showProxyInfo}"${this.showProxyInfo ? '' : ' inert'}>
            <div class="t-acc-panel"><div class="oa-panel-disclosure-inner t-acc-panel-inner"><div class="oa-panel-help">
                <p>The network proxy routes supported requests through a relay to help hide your IP address from the destination. It may add latency.</p>
                <button type="button" id="proxy-info-learn-more" class="oa-panel-learn-more">Learn more</button>
            </div></div></div>
        </div>`;
    }

    generateProxySectionHTML() {
        const settings = this.proxySettings || this.app.services.networkProxy.getSettings();
        const status = this.proxyStatus || this.app.services.networkProxy.getStatus();
        const statusMeta = this.getProxyStatusMeta(settings, status);
        const pending = this.proxyActionPending;
        const tlsInfo = this.app.services.networkProxy.getTlsInfo();
        const hasTlsInfo = tlsInfo.version !== null;

        return `<div class="p-3 space-y-2">
                <!-- Header Row: Title + Toggle -->
                <div class="flex items-center justify-between">
                    <div class="flex items-center gap-1.5">
                        ${this.generateProxyStatusIconHTML(statusMeta)}
                        <span class="text-xs font-medium text-foreground">Network Proxy</span>
                        <button id="proxy-info-btn" class="inline-flex h-3.5 w-3.5 items-center justify-center rounded-full border border-border text-[8px] text-muted-foreground hover:text-foreground hover:bg-accent hover:border-foreground/20 transition-all" title="What is the network proxy?" aria-label="What is the network proxy?" aria-controls="proxy-info-panel" aria-expanded="${!!this.showProxyInfo}" type="button">
                            ?
                        </button>
                    </div>
                    <button
                        id="proxy-toggle-btn"
                        class="switch-toggle t-toggle ${settings.enabled ? 'switch-active' : 'switch-inactive'}"
                        role="switch" aria-label="Network proxy" aria-checked="${!!settings.enabled}" data-on="${!!settings.enabled}"
                        ${pending ? 'disabled' : ''}
                        title="${settings.enabled ? 'Disable relay' : 'Enable relay'}"
                    >
                        <span class="switch-toggle-indicator t-toggle-thumb"></span>
                    </button>
                </div>

                <div id="proxy-failure-notice" class="oa-proxy-failure" data-state="unavailable"${statusMeta.state === 'unavailable' ? '' : ' hidden'}>
                    <button type="button" id="proxy-retry-btn" class="oa-proxy-retry" aria-label="Retry proxy connection" aria-disabled="${!!pending}" data-tooltip="Retry" data-tooltip-position="end">
                        <span class="t-icon-swap" data-state="a" aria-hidden="true">
                            <span class="t-icon" data-icon="a"><span class="oa-proxy-retry-turns"><svg class="oa-proxy-retry-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/></svg></span></span>
                            <span class="t-icon" data-icon="b"><span class="t-success-check" data-state="out"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12 4 4 10-10"/></svg></span></span>
                        </span>
                    </button>
                    <span class="oa-proxy-feedback-text t-text-swap" role="status">Unavailable</span>
                </div>
                ${this.generateProxyInfoHTML()}

                <!-- Security Details Button -->
                ${settings.enabled ? `
                    <button id="proxy-security-details-btn" class="btn-ghost-hover w-full flex items-center justify-center gap-1.5 px-2 py-1.5 text-[10px] font-medium rounded-md border border-border bg-background text-foreground transition-all duration-200 hover:shadow-sm">
                        <svg class="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
                            ${hasTlsInfo ? '<path d="M9 12l2 2 4-4"/>' : ''}
                        </svg>
                        Security Details
                    </button>
                ` : ''}
            </div>
        `;
    }

    clearProxyFeedbackTimers() {
        clearTimeout(this.proxyFeedbackTextTimer);
        clearTimeout(this.proxyFeedbackSettleTimer);
        clearTimeout(this.proxyFeedbackHideTimer);
    }

    /** One more full turn of the retry arrow. A CSS transition, not a
     *  keyframe: a second press mid-turn continues from where it is. */
    turnProxyRetryArrow() {
        const turns = document.getElementById('proxy-retry-btn')?.querySelector?.('.oa-proxy-retry-turns');
        if (!turns) return;
        this.proxyRetryTurns = (this.proxyRetryTurns || 0) + 1;
        this.proxyRetryTurning = true;
        turns.style.setProperty('--proxy-turns', `${this.proxyRetryTurns}turn`);
    }

    /** A turn ended. The outcome, if it arrived mid-turn, shows now; if the
     *  proxy is still answering, take another turn so the pace stays even. */
    onProxyRetryTurnEnd() {
        this.proxyRetryTurning = false;
        if (this.proxyFeedbackDeferred) {
            this.proxyFeedbackDeferred = false;
            this.updateProxyFeedback();
            return;
        }
        const row = document.getElementById('proxy-failure-notice');
        if (row?.dataset.state === 'connecting' && !row.hidden) this.turnProxyRetryArrow();
    }

    updateProxyFeedback() {
        const row = document.getElementById('proxy-failure-notice');
        if (!row || this.destroyed) return;
        const meta = this.getProxyStatusMeta();
        const visible = meta.state === 'unavailable' || (this.proxyRetryFeedbackActive && meta.state !== 'off');
        const state = visible ? meta.state : 'hidden';
        if (row.dataset.feedbackState === state) return;
        // The answer waits for the motion: an outcome that lands mid-turn
        // shows when the arrow completes the turn it is on, never before.
        const confirmed = meta.state === 'ready' || meta.state === 'connected';
        if (confirmed && this.proxyRetryTurning) { this.proxyFeedbackDeferred = true; return; }
        this.proxyFeedbackDeferred = false;
        this.clearProxyFeedbackTimers();
        row.dataset.feedbackState = state;
        row.dataset.state = meta.state;
        row.classList.remove('is-settled');
        row.inert = !visible;
        const button = row.querySelector('#proxy-retry-btn');
        const label = row.querySelector('.oa-proxy-feedback-text');
        const swap = row.querySelector('.t-icon-swap');
        const check = row.querySelector('.t-success-check');
        if (!visible) {
            if (row.contains(document.activeElement)) document.querySelector('.oa-proxy-status-icon')?.focus();
            row.hidden = true;
            return;
        }
        const wasHidden = row.hidden;
        row.hidden = false;
        // While the arrow turns the word stays: the motion already says
        // "trying". Success is one moment of change — check and word together.
        const text = { unavailable: 'Unavailable', connecting: 'Unavailable', ready: 'Connected', connected: 'Connected' }[state];
        button.setAttribute('aria-disabled', String(state !== 'unavailable'));
        button.setAttribute('aria-label', state === 'unavailable' ? 'Retry proxy connection' : meta.label);
        swap.dataset.state = confirmed ? 'b' : 'a';
        check.dataset.state = 'out';
        if (confirmed) {
            const path = check.querySelector('path');
            const length = Math.ceil(path.getTotalLength()) + 1;
            check.style.setProperty('--proxy-check-length', String(length));
            void check.offsetWidth;
            check.dataset.state = 'in';
        }
        label.classList.remove('is-exit', 'is-enter-start');
        const duration = motionDuration(label, '--text-swap-dur', 150);
        if (wasHidden || !duration || label.textContent === text) label.textContent = text;
        else {
            label.classList.add('is-exit');
            this.proxyFeedbackTextTimer = setTimeout(() => {
                label.textContent = text;
                label.classList.remove('is-exit');
                label.classList.add('is-enter-start');
                void label.offsetHeight;
                label.classList.remove('is-enter-start');
            }, duration);
        }
        if (confirmed) {
            this.proxyFeedbackSettleTimer = setTimeout(() => {
                this.proxyRetryFeedbackActive = false;
                if (row.contains(document.activeElement)) document.querySelector('.oa-proxy-status-icon')?.focus();
                row.inert = true;
                row.classList.add('is-settled');
                this.proxyFeedbackHideTimer = setTimeout(() => {
                    row.hidden = true;
                    row.dataset.feedbackState = 'hidden';
                }, motionDuration(row, '--proxy-feedback-fade', 280));
            }, 1800 + duration);
        }
    }

    async handleProxyToggle({ retry = false } = {}) {
        if (this.destroyed || this.proxyActionPending) return;

        // Block toggle when there are active proxy requests (e.g., streaming response)
        if (this.app.services.networkProxy.hasActiveRequests()) {
            console.warn('[RightPanel] Cannot toggle proxy - requests in progress');
            this.app?.showToast?.('Cannot turn proxy off while data is transmitting', 'error');
            return;
        }

        // Rate limit: minimum 500ms between toggles to let libcurl WASM fully clean up
        const now = Date.now();
        if (this.lastProxyToggleTime && now - this.lastProxyToggleTime < 500) {
            return;
        }
        this.lastProxyToggleTime = now;

        const nextEnabled = retry || !this.proxySettings.enabled;
        this.proxyFailureDismissed = !nextEnabled;
        this.clearProxyFeedbackTimers();
        this.proxyRetryFeedbackActive = retry;
        this.proxyActionError = null;
        this.proxyPendingEnabled = nextEnabled;
        this.proxyActionPending = true;
        this.proxyAnimating = true; // Prevent onChange callback from re-rendering during animation

        // Update toggle visually BEFORE re-render to trigger CSS animation
        const toggle = document.getElementById('proxy-toggle-btn');
        if (toggle) {
            const newEnabled = nextEnabled;
            toggle.classList.add('is-init');
            toggle.dataset.on = String(newEnabled);
            toggle.setAttribute('aria-checked', String(newEnabled));
            toggle.classList.toggle('switch-active', newEnabled);
            toggle.classList.toggle('switch-inactive', !newEnabled);
            toggle.disabled = true;
        }

        const icon = document.querySelector('.oa-proxy-status-icon');
        if (icon) icon.outerHTML = this.generateProxyStatusIconHTML(this.getProxyStatusMeta());
        this.updateProxyFeedback();
        try {
            if (retry && this.proxySettings.enabled) await this.app.services.networkProxy.reconnect();
            else await this.app.services.networkProxy.updateSettings({ enabled: nextEnabled });
        } catch (error) {
            // Show toast for active request errors (race condition protection)
            if (error.message?.includes('requests are in progress')) {
                this.app?.showToast?.('Cannot change proxy while data is streaming', 'error');
            }
            this.proxyActionError = error.message;
            this.proxyFailureDismissed = false;
        } finally {
            this.proxyActionPending = false;
            if (this.destroyed) return;
            this.proxySettings = this.app.services.networkProxy.getSettings();
            this.proxyStatus = this.app.services.networkProxy.getStatus();
            this.updateProxyFeedback();
            this.lastProxyToggleTime = Date.now(); // Update after completion too
            // Finish the switch animation before replacing its DOM.
            this.proxyRenderTimer = setTimeout(() => {
                this.proxyAnimating = false;
                this.renderTopSectionOnly();
            }, motionDuration(toggle, '--toggle-dur', 350));
        }
    }

    /**
     * Attaches event listeners to the top section elements only.
     */
    attachTopSectionEventListeners() {
        this.attachHelpDismissal();
        this.updateProxyFeedback();
        const ticketManagerButton = document.getElementById('open-ticket-manager-btn');
        if (ticketManagerButton) {
            ticketManagerButton.onclick = event => {
                const accountState = this.app.services.account?.getState?.() || {};
                if (this.getExternalTicketSummary(accountState).needsSignIn && this.app.accountModal?.open) {
                    this.app.accountModal.open(event.currentTarget);
                    return;
                }
                this.app.openTicketManagement?.(event.currentTarget);
            };
        }

        const toggleExternalTicketInfo = document.getElementById('toggle-external-ticket-info-btn');
        if (toggleExternalTicketInfo) {
            toggleExternalTicketInfo.onclick = () => {
                this.togglePanelHelp('showExternalTicketInfo');
            };
        }

        // Toggle invitation form button
        const toggleFormBtn = document.getElementById('toggle-invitation-form-btn');
        if (toggleFormBtn) {
            toggleFormBtn.onclick = () => {
                this.showInvitationForm = !this.showInvitationForm;
                this.invitationFormPreference = this.showInvitationForm;
                preferencesStore.savePreference(PREF_KEYS.invitationFormVisible, this.showInvitationForm);
                this.renderTopSectionOnly();
            };
        }

        const toggleInfoBtn = document.getElementById('toggle-ticket-info-btn');
        if (toggleInfoBtn) {
            toggleInfoBtn.onclick = () => {
                this.showTicketInfo = !this.showTicketInfo;
                preferencesStore.savePreference(PREF_KEYS.ticketInfoVisible, this.showTicketInfo);
                this.updateTicketInfoVisibility();
                this.updateTicketInfoToggleButton();
            };
        }

        // Ticket info panel header toggle buttons (inside the panel)
        const ticketInfoHeader = document.getElementById('ticket-info-header');
        const ticketInfoQuestionBtn = document.getElementById('ticket-info-question-btn');
        const ticketInfoCollapseBtn = document.getElementById('ticket-info-collapse-btn');

        const handleTicketInfoCollapse = (e) => {
            e.stopPropagation();
            this.showTicketInfo = false;
            preferencesStore.savePreference(PREF_KEYS.ticketInfoVisible, false);
            this.updateTicketInfoVisibility();
            this.updateTicketInfoToggleButton();
        };

        if (ticketInfoQuestionBtn) {
            ticketInfoQuestionBtn.onclick = handleTicketInfoCollapse;
        }
        if (ticketInfoCollapseBtn) {
            ticketInfoCollapseBtn.onclick = handleTicketInfoCollapse;
        }
        // Make the whole header row clickable too
        if (ticketInfoHeader) {
            ticketInfoHeader.onclick = handleTicketInfoCollapse;
        }

        // Invitation code form
        const form = document.getElementById('invitation-code-form');
        if (form) {
            form.onsubmit = (e) => {
                e.preventDefault();
                const input = document.getElementById('invitation-code-input');
                if (input) {
                    const rawValue = input.value.trim();
                    const normalized = this.normalizeInvitationCode(rawValue);
                    if (this.pendingInvitationCode !== null) {
                        this.pendingInvitationCode = normalized;
                        this.pendingInvitationTickets = this.getInvitationTicketCount(normalized);
                    }
                    this.handleRegister(this.pendingInvitationCode !== null ? normalized : rawValue);
                }
            };
        }
        const invitationInput = document.getElementById('invitation-code-input');
        if (invitationInput && this.pendingInvitationCode !== null) {
            invitationInput.oninput = () => {
                this.pendingInvitationCode = invitationInput.value;
                this.pendingInvitationTickets = this.getInvitationTicketCount(invitationInput.value);
            };
        }

        // Import tickets
        const importBtn = document.getElementById('import-tickets-btn');
        const importInput = document.getElementById('import-tickets-input');
        if (importBtn && importInput) {
            importBtn.onclick = () => importInput.click();
            importInput.onchange = () => {
                const file = importInput.files && importInput.files[0];
                if (file) {
                    this.handleImportTickets(file, importInput);
                }
            };
        }

        // Split tickets controls
        const splitBtn = document.getElementById('split-tickets-btn');
        if (splitBtn) {
            splitBtn.onclick = () => this.handleSplitToggle();
        }

        const splitDecreaseBtn = document.getElementById('split-decrease-btn');
        if (splitDecreaseBtn) {
            splitDecreaseBtn.onclick = () => this.handleSplitCountChange(-1);
        }

        const splitIncreaseBtn = document.getElementById('split-increase-btn');
        if (splitIncreaseBtn) {
            splitIncreaseBtn.onclick = () => this.handleSplitCountChange(1);
        }

        const splitCountInput = document.getElementById('split-count-input');
        if (splitCountInput) {
            // Stop propagation to prevent keys from going to chat input
            splitCountInput.onkeydown = (e) => {
                e.stopPropagation();
                // Handle Enter key to submit
                if (e.key === 'Enter') {
                    e.preventDefault();
                    this.handleSplitConfirm();
                }
            };
            splitCountInput.onkeyup = (e) => e.stopPropagation();
            splitCountInput.onkeypress = (e) => e.stopPropagation();
            splitCountInput.oninput = (e) => {
                e.stopPropagation();
                // Only allow digits
                const cleaned = e.target.value.replace(/\D/g, '');
                if (cleaned !== e.target.value) {
                    e.target.value = cleaned;
                }
                this.handleSplitCountInput(cleaned);
            };
            splitCountInput.onchange = (e) => {
                e.stopPropagation();
                this.handleSplitCountInput(e.target.value);
            };
        }

        const splitConfirmBtn = document.getElementById('split-confirm-btn');
        if (splitConfirmBtn) {
            splitConfirmBtn.onclick = () => this.handleSplitConfirm();
        }

        const splitCancelBtn = document.getElementById('split-cancel-btn');
        if (splitCancelBtn) {
            splitCancelBtn.onclick = () => this.handleSplitCancel();
        }

        // Split result handlers
        const splitResultCopy = document.getElementById('split-result-copy');
        if (splitResultCopy) {
            splitResultCopy.onclick = () => this.handleSplitResultCopy();
        }

        const splitResultDismiss = document.getElementById('split-result-dismiss');
        if (splitResultDismiss) {
            splitResultDismiss.onclick = () => this.handleSplitResultDismiss();
        }

        const splitResultCopyLink = document.getElementById('split-result-copy-link');
        if (splitResultCopyLink) {
            splitResultCopyLink.onclick = () => this.handleSplitResultCopyLink();
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

        const ticketToggles = document.querySelectorAll('.ticket-preview-toggle');
        ticketToggles.forEach(toggle => {
            toggle.onclick = () => {
                const container = toggle.closest('.ticket-details');
                if (!container) return;

                const isExpanded = container.getAttribute('data-expanded') === 'true';
                container.setAttribute('data-expanded', isExpanded ? 'false' : 'true');

                const details = container.querySelector('.ticket-details-full');
                if (details) {
                    details.classList.toggle('hidden', isExpanded);
                }

                const hint = container.querySelector('.ticket-expand-hint');
                if (hint) {
                    hint.textContent = isExpanded ? 'Click to expand' : 'Click to collapse';
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

        // Ephemeral key tooltip (JS-based for HTML content with monospace keys)
        const keyDisplay = document.getElementById('ephemeral-key-display');
        if (keyDisplay && keyDisplay.dataset.hasTooltip === 'true') {
            const keyInfo = this.getKeyDisplayInfo();
            if (keyInfo.hoverContentHtml) {
                keyDisplay.onmouseenter = () => this.showKeyTooltip(keyDisplay, keyInfo.hoverContentHtml);
                keyDisplay.onmouseleave = () => this.hideKeyTooltip();
            }
        }

        const clearBtn = document.getElementById('clear-key-btn');
        if (clearBtn) {
            clearBtn.onclick = () => this.handleClearApiKey();
        }

        const proxyToggleBtn = document.getElementById('proxy-toggle-btn');
        if (proxyToggleBtn) {
            proxyToggleBtn.onclick = () => this.handleProxyToggle();
        }

        const proxySecurityBtn = document.getElementById('proxy-security-details-btn');
        if (proxySecurityBtn) {
            proxySecurityBtn.onclick = () => tlsSecurityModal.open();
        }

        const proxyInfoBtn = document.getElementById('proxy-info-btn');
        if (proxyInfoBtn) {
            proxyInfoBtn.onclick = () => this.togglePanelHelp('showProxyInfo');
        }

        const proxyLearnMore = document.getElementById('proxy-info-learn-more');
        if (proxyLearnMore) proxyLearnMore.onclick = () => proxyInfoModal.open();
        const proxyRetry = document.getElementById('proxy-retry-btn');
        if (proxyRetry) {
            proxyRetry.onclick = () => {
                if (proxyRetry.getAttribute('aria-disabled') === 'true') return;
                this.turnProxyRetryArrow();
                this.handleProxyToggle({ retry: true });
            };
            // While still connecting when a turn ends, take another: the
            // motion is continuous, and always ends on a whole turn.
            proxyRetry.querySelector('.oa-proxy-retry-turns')?.addEventListener('transitionend', event => {
                if (event.propertyName === 'transform') this.onProxyRetryTurnEnd();
            });
        }

        const verifierAttestationBtn = document.getElementById('verifier-attestation-btn');
        if (verifierAttestationBtn) {
            verifierAttestationBtn.onclick = () => this.toggleAccessKeyInfo();
        }
        const learnMore = document.getElementById('verifier-attestation-learn-more');
        if (learnMore) {
            learnMore.onclick = () => verifierAttestationModal.open({
                session: this.currentSession || null,
                accessInfo: this.apiKeyInfo || null,
                stationId: this.apiKeyInfo?.stationId || this.apiKeyInfo?.station_name || null
            });
        }

        document.querySelectorAll('[data-council-attestation-lane]').forEach((button) => {
            button.onclick = () => {
                const laneId = button.dataset.councilAttestationLane || '';
                const row = this.getCouncilAccessRows().find((entry) => entry.id === laneId);
                const accessInfo = this.getLaneAttestationAccessInfo(row?.access);
                if (!accessInfo) return;
                verifierAttestationModal.open({
                    session: this.currentSession || null,
                    accessInfo,
                    stationId: accessInfo.stationId || accessInfo.station_id || accessInfo.station_name || null
                });
            };
        });
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
        const proxyFeedback = topSection.querySelector('#proxy-failure-notice');
        const proxyRetryFocused = proxyFeedback?.contains(document.activeElement);
        topSection.innerHTML = this.generateTopSectionHTML();
        // Keep the retry animation and its timers alive across unrelated updates.
        if (proxyFeedback) {
            topSection.querySelector('#proxy-failure-notice')?.replaceWith(proxyFeedback);
            if (proxyRetryFocused) proxyFeedback.querySelector('#proxy-retry-btn')?.focus();
        }
        this.app.refreshExtensionSlot?.(SLOT_NAMES.RIGHT_PANEL_TICKET_STATUS);

        // Re-attach event listeners for the top section only
        this.attachTopSectionEventListeners();
        this.ensureLaneExpirationTimer();
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
        document.querySelectorAll('.activity-log-entry').forEach(row => {
            const check = row.querySelector('.verifier-status-icon .t-success-check');
            if (!check) return;
            const path = check.querySelector('path');
            check.style.setProperty('--verifier-check-length', String(Math.ceil(path.getTotalLength()) + 1));
            row.onpointerenter = () => {
                check.setAttribute('data-state', 'out');
                void check.offsetWidth;
                check.setAttribute('data-state', 'in');
            };
        });
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
            const descriptionRaw = getActivityDescription(log);
            const description = this.escapeHtml(descriptionRaw);
            const descriptionAttr = this.escapeHtmlAttribute(descriptionRaw);
            const icon = getActivityIcon(log);
            const iconClass = getStatusIconClass(log.status, log.isAborted, log.detail || log.response?.detail || '');
            const isFirst = index === 0;
            const isLast = index === logsToShow.length - 1;
            // Highlight the latest (last in reversed array) with a more visible background
            const highlightClass = isLast ? 'bg-accent' : '';
            const hoverClass = isLast ? 'hover:brightness-125' : 'hover:bg-muted/30';
            // Only animate items that are truly new (last N items where N = newLogsCount)
            const isNewEntry = newLogsCount > 0 && index >= logsToShow.length - newLogsCount;
            const animationClass = isNewEntry ? 'new-entry' : '';

            // Check if this is a system-level event (tickets/privacy pass/api-key requests)
            const isSystemEvent = (log.type === 'local' && log.method === 'LOCAL') || log.type === 'ticket' || log.type === 'api-key';

            // For grouping purposes, treat system events as a special "system" session
            const effectiveSessionId = isSystemEvent ? 'system' : log.sessionId;

            // Check if we need a session separator
            const needsSeparator = effectiveSessionId !== lastSessionId;
            const sessionTitleRaw = this.getSessionTitle(log.sessionId);
            const sessionTitleAttr = this.escapeHtmlAttribute(sessionTitleRaw);
            const sessionTitleDisplayRaw = sessionTitleRaw.length > 14 ? sessionTitleRaw.substring(0, 14) + '...' : sessionTitleRaw;
            const sessionTitleDisplay = this.escapeHtml(sessionTitleDisplayRaw);
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
                    const keyDisplay = sessionKey ? `<span class="text-[10px] font-mono whitespace-nowrap ${isCurrentSess ? 'text-foreground' : 'text-muted-foreground'} ml-auto">${this.escapeHtml(this.maskApiKey(sessionKey))}</span>` : '';
                    sessionSeparator = `
                        <div class="session-separator mb-2 mt-2">
                            <div class="flex items-center gap-2 px-2 py-1.5 rounded-md border whitespace-nowrap ${isCurrentSess ? 'border-foreground bg-primary/10' : 'border-border'}">
                                <svg class="w-3 h-3 ${isCurrentSess ? 'text-foreground' : 'text-muted-foreground'} flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z"></path>
                                </svg>
                                <span class="text-[10px] font-medium whitespace-nowrap ${isCurrentSess ? 'text-foreground' : 'text-muted-foreground'}" title="${sessionTitleAttr}">
                                    ${sessionTitleDisplay}
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
                        <div class="activity-status-icon relative flex items-center justify-center ${iconClass}" aria-hidden="true" style="width: 16px; height: 16px; flex-shrink: 0;">
                            ${icon}
                        </div>

                        <!-- Bottom line (extends to next entry) -->
                        ${!isLast ? `<div class="w-0.5 bg-border" style="height: 12px;"></div>` : ''}
                    </div>

                    <!-- Content column -->
                    <div class="flex-1 min-w-0" style="margin-top: 3px;">
                        <!-- Compact one-line view -->
                        <div class="activity-log-header cursor-pointer ${hoverClass} pl-1 pr-2 py-1 rounded transition-all duration-150 text-[10px] ${highlightClass}" data-log-id="${log.id}">
                            <div class="flex items-center gap-1.5">
                                <span class="truncate flex-1 font-medium" title="${descriptionAttr}">
                                    ${description}
                                </span>
                                <span class="text-muted-foreground font-mono ml-auto" style="font-size: 10px;">
                                    ${formatTimestamp(log.timestamp)}
                                </span>
                            </div>
                        </div>

                        <!-- Expanded details -->
                        ${isExpanded ? this.generateExpandedDetailsHTML(log) : ''}
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
            <!-- Header - matches chat-toolbar height (3rem + 1px for border alignment) -->
            <div style="min-height: calc(3rem + 1px);" class="oa-system-panel-header px-3 bg-muted/10 flex items-center">
                <div class="flex items-center justify-between w-full">
                    <h2 class="text-sm font-semibold text-foreground">System Panel</h2>

                </div>
            </div>

            <div class="oa-system-panel-body flex flex-col flex-1 min-h-0">
            <!-- Top Section: Tickets and API Key (non-scrollable) -->
            <div class="flex-shrink-0">
                ${this.generateTopSectionHTML()}
            </div>
            <!-- End of Top Section -->

            <!-- Activity Timeline (scrollable) -->
            <div class="oa-system-timeline border-t border-border flex flex-col bg-background flex-1 min-h-0">
                <div class="p-3 border-b border-border bg-muted/10">
                    <div class="flex items-center justify-between gap-1.5">
                        <div class="flex items-center gap-1.5">
                            <svg class="w-3.5 h-3.5 text-muted-foreground" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5" aria-hidden="true">
                                <path stroke-linecap="round" stroke-linejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z"></path>
                            </svg>
                            <h3 class="text-xs font-medium text-foreground">Activity Timeline</h3>
                        </div>
                        <button id="clear-activity-timeline-btn" type="button" class="oa-panel-icon-btn oa-panel-icon-btn--destructive oa-panel-icon-btn--tight inline-flex items-center justify-center h-7 w-7" aria-label="Clear activity timeline" data-tooltip="Clear timeline" data-tooltip-position="start">
                            <svg class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                                <path d="M4 6h16M9 6V4.5A1.5 1.5 0 0 1 10.5 3h3A1.5 1.5 0 0 1 15 4.5V6M18.5 6l-.9 13.1a2 2 0 0 1-2 1.9H8.4a2 2 0 0 1-2-1.9L5.5 6M10 10.5v6M14 10.5v6"/>
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

        this.app.refreshExtensionSlot?.(SLOT_NAMES.RIGHT_PANEL_TICKET_STATUS);

        // Attach event listeners
        this.attachEventListeners();

        // Start timer if we have an API key
        if (hasApiKey) {
            this.startExpirationTimer();
        }
    }

    attachEventListeners() {
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

        this.hasMounted = true;

        // On first page load, if panel starts open, animate content after first paint.
        if (this.isVisible) {
            this.playContentFadeIn();
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
        this.destroyed = true;
        this.clearProxyFeedbackTimers();
        this.helpAnchorCleanup?.();
        if (this.proxyRenderTimer) clearTimeout(this.proxyRenderTimer);
        if (this.helpDismissClick) document.removeEventListener('click', this.helpDismissClick);
        if (this.helpDismissKey) document.removeEventListener('keydown', this.helpDismissKey);
        this.helpDismissClick = null;
        this.helpDismissKey = null;
        this.smoothProgress.stop();
        this.hasMounted = false;
        if (this.timerInterval) {
            clearInterval(this.timerInterval);
        }
        if (this.panelFadeCleanupTimer) {
            clearTimeout(this.panelFadeCleanupTimer);
            this.panelFadeCleanupTimer = null;
        }
        if (this.panelFadeAnimation) {
            this.panelFadeAnimation.cancel();
            this.panelFadeAnimation = null;
        }
        if (this.proxyUnsubscribe) {
            this.proxyUnsubscribe();
            this.proxyUnsubscribe = null;
        }
        if (this.accountUnsubscribe) {
            this.accountUnsubscribe();
            this.accountUnsubscribe = null;
        }
    }
}

export default RightPanel;
