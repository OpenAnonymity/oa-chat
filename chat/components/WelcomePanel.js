/**
 * Welcome Panel Component
 * First-run welcome modal for new users, invite code redemption, and account creation prompt.
 */

import ticketClient from '../services/ticketClient.js';
import preferencesStore, { PREF_KEYS } from '../services/preferencesStore.js';
import themeManager from '../services/themeManager.js';

// localStorage key for synchronous pre-hydration check (matches preferencesStore snapshot)
const STORAGE_KEY_DISMISSED = 'oa-welcome-dismissed';
const MODAL_CLASSES = 'w-full max-w-md rounded-2xl border border-border shadow-lg mx-4 flex flex-col welcome-modal-enter welcome-modal-glass';
const BETA_SIGNUP_URL = 'https://openanonymity.ai/beta';
const FREE_ACCESS_EMAIL_HINT_HTML = `You can get limited experimental access by entering an email (collected only to prevent spam). We encourage you to <a href="${BETA_SIGNUP_URL}" target="_blank" rel="noopener noreferrer" class="underline hover:text-foreground transition-colors">sign up</a> for full beta access.`;
const FREE_ACCESS_UNAVAILABLE_HINT = 'Experimental access is unavailable right now. Please sign up for full beta access.';
const FREE_ACCESS_UNAVAILABLE_HINT_HTML = `Experimental access is unavailable right now. Please <a href="${BETA_SIGNUP_URL}" target="_blank" rel="noopener noreferrer" class="underline hover:text-foreground transition-colors">sign up</a> for full beta access.`;

class WelcomePanel {
    constructor(app) {
        this.app = app;
        this.isOpen = false;
        this.overlay = document.getElementById('welcome-panel');

        // Flow state
        this.step = 'welcome'; // 'welcome' | 'redeeming' | 'success'
        this.accessMode = 'preview'; // 'preview' | 'beta'
        this.previewEmail = '';
        this.inviteCode = '';
        this.isRedeeming = false;
        this.redeemProgress = null;
        this.redeemError = null;
        this.ticketsRedeemed = 0;
        this.dontShowAgain = false;
        this.freeAccessRequested = false;
        this.freeAccessAvailable = false;
        this.freeAccessAvailability = null;
        this.canUseEmailForFreeAccess = false;
        this.allowManualClose = false;

        // UI state
        this.returnFocusEl = null;
        this.escapeHandler = null;
        this.importCloseHandler = null;
        this.themeUnsubscribe = null;
        this.ticketsUpdatedHandler = null;
        this.welcomeAnchorTop = null;
        this.animateOnNextRender = false;
    }

    async init() {
        if (!this.overlay) return;
        this.ensureTicketsUpdatedListener();
        if (!this.shouldShow()) return;
        await this.refreshFreeAccessEligibility({ renderIfOpen: false });
        if (!this.shouldShow()) return;
        this.open();
    }

    shouldShow() {
        // Don't show if dismissed
        if (localStorage.getItem(STORAGE_KEY_DISMISSED) === 'true') return false;
        // Don't show if user already has tickets
        if (ticketClient.getTicketCount() > 0) return false;
        return true;
    }

    open() {
        if (this.isOpen || !this.overlay) return;
        this.isOpen = true;
        this.returnFocusEl = document.activeElement;
        this.allowManualClose = this.isCloseAllowedByLinkContext();

        // Reset state on open
        this.step = 'welcome';
        this.accessMode = this.canUseEmailForFreeAccess ? 'preview' : 'beta';
        this.previewEmail = '';
        this.inviteCode = '';
        this.isRedeeming = false;
        this.redeemProgress = null;
        this.redeemError = null;
        this.ticketsRedeemed = 0;
        this.welcomeAnchorTop = null;
        this.animateOnNextRender = true;

        this.render();
        this.overlay.classList.remove('hidden');
        document.documentElement.removeAttribute('data-welcome-hidden');

        // Attach close handlers
        this.overlay.onclick = (e) => { if (e.target === this.overlay) this.handleCloseAttempt(); };
        this.escapeHandler = (e) => { if (e.key === 'Escape') this.handleCloseAttempt(); };
        document.addEventListener('keydown', this.escapeHandler);
    }

    handleCloseAttempt() {
        // Don't allow closing during active redemption
        if (this.isRedeeming) return;
        if (!this.allowManualClose) return;
        this.close();
    }

    isCloseAllowedByLinkContext() {
        if (this.app?.hasInitialLinkContext) {
            return true;
        }
        if (this.app?.pendingTicketCode?.code) {
            return true;
        }
        if (this.app?.rightPanel?.pendingInvitationSource) {
            return true;
        }
        return false;
    }

    close() {
        if (!this.isOpen || !this.overlay) return;
        this.isOpen = false;

        // Save dismissal preference if checked
        if (this.dontShowAgain) {
            preferencesStore.savePreference(PREF_KEYS.welcomeDismissed, true);
        }

        this.overlay.classList.add('hidden');
        this.overlay.innerHTML = '';
        document.documentElement.setAttribute('data-welcome-hidden', 'true');
        this.overlay.style.alignItems = '';
        this.overlay.style.paddingTop = '';
        this.welcomeAnchorTop = null;

        this.themeUnsubscribe?.();
        this.themeUnsubscribe = null;

        if (this.escapeHandler) {
            document.removeEventListener('keydown', this.escapeHandler);
            this.escapeHandler = null;
        }
        if (this.importCloseHandler) {
            const input = document.getElementById('global-import-input');
            if (input) input.removeEventListener('change', this.importCloseHandler, true);
            this.importCloseHandler = null;
        }
        if (this.returnFocusEl?.focus) this.returnFocusEl.focus();
        this.returnFocusEl = null;
    }

    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    isEmailInput(value) {
        const trimmed = (value || '').trim();
        if (!trimmed || trimmed.length > 254) return false;
        return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed);
    }

    isPreviewMode() {
        return this.accessMode === 'preview';
    }

    ensureValidAccessMode() {
        if (!this.canUseEmailForFreeAccess && this.isPreviewMode()) {
            this.accessMode = 'beta';
            return;
        }
        if (!this.accessMode) {
            this.accessMode = this.canUseEmailForFreeAccess ? 'preview' : 'beta';
        }
    }

    getCurrentAccessValue() {
        return this.isPreviewMode() ? this.previewEmail : this.inviteCode;
    }

    setCurrentAccessValue(value) {
        if (this.isPreviewMode()) {
            this.previewEmail = value;
            return;
        }
        this.inviteCode = value;
    }

    ensureTicketsUpdatedListener() {
        if (this.ticketsUpdatedHandler) return;

        this.ticketsUpdatedHandler = () => {
            if (this.isOpen && this.step === 'welcome') {
                this.render();
            }
        };

        window.addEventListener('tickets-updated', this.ticketsUpdatedHandler);
    }

    async refreshFreeAccessEligibility(options = {}) {
        const renderIfOpen = options.renderIfOpen !== false;

        try {
            this.freeAccessRequested = !!await preferencesStore.getPreference(PREF_KEYS.freeAccessRequested);
        } catch (error) {
            this.freeAccessRequested = false;
        }

        if (this.freeAccessRequested) {
            const hasAnyTicketHistory =
                ticketClient.getTicketCount() > 0 ||
                ticketClient.getArchivedTicketCount() > 0;

            if (!hasAnyTicketHistory) {
                try {
                    await preferencesStore.savePreference(PREF_KEYS.freeAccessRequested, false);
                } catch (error) {
                    console.warn('Failed to clear stale free access requested state:', error);
                }
                this.freeAccessRequested = false;
            }
        }

        if (this.freeAccessRequested) {
            this.freeAccessAvailable = false;
            this.freeAccessAvailability = {
                available: false,
                reasonCode: 'FREE_ACCESS_ALREADY_REQUESTED',
                retryAfterSeconds: null,
                issuanceEnabled: null
            };
            this.canUseEmailForFreeAccess = false;
            if (renderIfOpen && this.isOpen && this.step === 'welcome') {
                this.render();
            }
            return this.canUseEmailForFreeAccess;
        }

        const availability = await ticketClient.isFreeAccessAvailable();
        this.freeAccessAvailability = availability;
        this.freeAccessAvailable = availability?.available === true;
        const reasonCode = typeof availability?.reasonCode === 'string'
            ? availability.reasonCode.toUpperCase()
            : '';
        const explicitlyUnavailable =
            reasonCode === 'FREE_ACCESS_DISABLED' ||
            reasonCode === 'FREE_ACCESS_LIMITED';
        this.canUseEmailForFreeAccess = !explicitlyUnavailable;
        this.ensureValidAccessMode();

        if (renderIfOpen && this.isOpen && this.step === 'welcome') {
            this.render();
        }

        return this.canUseEmailForFreeAccess;
    }

    updateInlineInviteFeedback() {
        if (this.step !== 'welcome') return;

        const feedbackEl = document.getElementById('invite-feedback-text');
        if (!feedbackEl) return;

        const showHint = this.isPreviewMode() && !this.redeemError && this.previewEmail.trim().length > 0;
        const feedbackHtml = this.redeemError
            ? (this.redeemError === FREE_ACCESS_UNAVAILABLE_HINT
                ? FREE_ACCESS_UNAVAILABLE_HINT_HTML
                : this.escapeHtml(this.redeemError))
            : (showHint ? FREE_ACCESS_EMAIL_HINT_HTML : '');
        if (!feedbackHtml) {
            feedbackEl.innerHTML = '';
            feedbackEl.classList.remove('text-red-500', 'text-muted-foreground');
            feedbackEl.classList.add('hidden');
            this.resetWelcomeDialogAnchor();
            return;
        }

        this.anchorWelcomeDialogFromCurrentPosition();
        feedbackEl.innerHTML = feedbackHtml;
        feedbackEl.classList.remove('hidden', 'text-red-500', 'text-muted-foreground');
        feedbackEl.classList.add(this.redeemError ? 'text-red-500' : 'text-muted-foreground');
    }

    anchorWelcomeDialogFromCurrentPosition() {
        if (!this.overlay) return;

        const dialog = this.overlay.querySelector('[role="dialog"]');
        if (!dialog) return;

        if (this.welcomeAnchorTop === null) {
            const rect = dialog.getBoundingClientRect();
            this.welcomeAnchorTop = Math.max(16, Math.round(rect.top));
        }

        this.overlay.style.alignItems = 'flex-start';
        this.overlay.style.paddingTop = `${this.welcomeAnchorTop}px`;
    }

    resetWelcomeDialogAnchor() {
        if (!this.overlay) return;
        this.overlay.style.alignItems = '';
        this.overlay.style.paddingTop = '';
        this.welcomeAnchorTop = null;
    }

    // =========================================================================
    // Flow Handlers
    // =========================================================================

    async handleInviteSubmit(e) {
        if (e) e.preventDefault();

        this.ensureValidAccessMode();
        const isEmailSubmission = this.isPreviewMode();

        if (isEmailSubmission) {
            if (!this.canUseEmailForFreeAccess) {
                this.redeemError = FREE_ACCESS_UNAVAILABLE_HINT;
                this.render();
                return;
            }

            const emailValue = this.previewEmail.trim();
            if (!emailValue) {
                this.redeemError = 'Please enter your email';
                this.render();
                return;
            }

            if (!this.isEmailInput(emailValue)) {
                this.redeemError = 'Please enter a valid email format (xxx@xxx.xxx).';
                this.render();
                return;
            }
        } else {
            const rawInviteCode = this.inviteCode.trim();
            if (!rawInviteCode) {
                this.redeemError = 'Please enter an invite code';
                this.render();
                return;
            }

            const inviteCode = rawInviteCode.replace(/[\s-]+/g, '');
            if (inviteCode.length !== 24) {
                this.redeemError = 'Please enter a valid 24-character invite code';
                this.render();
                return;
            }
        }

        this.step = 'redeeming';
        this.isRedeeming = true;
        this.redeemError = null;
        this.redeemProgress = isEmailSubmission
            ? { message: 'Requesting free access...', percent: 20 }
            : { message: 'Starting...', percent: 0 };
        this.render();

        try {
            if (isEmailSubmission) {
                const freeAccessResult = await ticketClient.requestFreeAccess(this.previewEmail.trim());

                const accessCode = typeof freeAccessResult.accessCode === 'string'
                    ? freeAccessResult.accessCode.trim()
                    : '';

                if (accessCode) {
                    await preferencesStore.savePreference(PREF_KEYS.freeAccessRequested, true);
                    this.freeAccessRequested = true;
                    this.freeAccessAvailable = false;
                    this.freeAccessAvailability = {
                        available: false,
                        reasonCode: 'FREE_ACCESS_ALREADY_REQUESTED',
                        retryAfterSeconds: null,
                        issuanceEnabled: null
                    };
                    this.canUseEmailForFreeAccess = false;

                    const ingested = this.app?.ingestTicketCode?.(accessCode, {
                        autoRedeem: true,
                        source: 'free_access'
                    });

                    this.isRedeeming = false;
                    if (!ingested) {
                        this.step = 'welcome';
                        this.redeemError = 'Free access code issued, but automatic redemption failed. Please redeem it in the ticket panel.';
                        this.render();
                        return;
                    }

                    this.app?.showToast?.('Free access granted. Redeeming tickets automatically...', 'success');
                    this.close();
                    return;
                }

                await preferencesStore.savePreference(PREF_KEYS.freeAccessRequested, false);
                this.freeAccessRequested = false;
                await this.refreshFreeAccessEligibility({ renderIfOpen: false });

                this.step = 'welcome';
                this.isRedeeming = false;
                this.redeemError = FREE_ACCESS_UNAVAILABLE_HINT;
                this.render();
                return;
            }

            const result = await ticketClient.alphaRegister(this.inviteCode.trim().replace(/[\s-]+/g, ''), (message, percent) => {
                this.redeemProgress = { message, percent };
                this.render();
            });

            this.ticketsRedeemed = result.tickets_issued;
            this.step = 'success';
            this.isRedeeming = false;
            this.render();

            // Dispatch event for RightPanel sync
            window.dispatchEvent(new CustomEvent('tickets-updated'));

        } catch (error) {
            console.error('Welcome panel invite error:', error);
            if (isEmailSubmission) {
                try {
                    await preferencesStore.savePreference(PREF_KEYS.freeAccessRequested, false);
                    this.freeAccessRequested = false;
                    await this.refreshFreeAccessEligibility({ renderIfOpen: false });
                } catch (saveError) {
                    console.warn('Failed to persist free access requested state:', saveError);
                }
                this.redeemError = FREE_ACCESS_UNAVAILABLE_HINT;
            }
            this.step = 'welcome';
            this.isRedeeming = false;
            if (!isEmailSubmission) {
                this.redeemError = error.message || 'Failed to redeem invite code';
            }
            this.render();
        }
    }

    handleCreateAccount() {
        this.close();
        setTimeout(() => this.app.accountModal?.open(), 150);
    }

    handleStartChatting() {
        this.close();
        setTimeout(() => this.app.elements.messageInput?.focus(), 150);
    }

    handleImportData() {
        const input = document.getElementById('global-import-input');
        if (!input) return;

        if (this.importCloseHandler) {
            input.removeEventListener('change', this.importCloseHandler, true);
            this.importCloseHandler = null;
        }

        this.importCloseHandler = (e) => {
            const file = e.target.files?.[0];
            if (!file) return;
            this.close();
        };

        input.addEventListener('change', this.importCloseHandler, true);
        input.click();
    }

    handleDontShowAgainChange(checked) {
        this.dontShowAgain = checked;
    }

    // =========================================================================
    // Render
    // =========================================================================

    render() {
        if (!this.overlay) return;

        switch (this.step) {
            case 'welcome':
                this.overlay.innerHTML = this.renderWelcomeStep();
                break;
            case 'redeeming':
                this.overlay.innerHTML = this.renderRedeemingStep();
                break;
            case 'success':
                this.overlay.innerHTML = this.renderSuccessStep();
                break;
        }

        const dialog = this.overlay.querySelector('[role="dialog"]');
        if (dialog && !this.animateOnNextRender) {
            dialog.classList.remove('welcome-modal-enter');
        }
        this.animateOnNextRender = false;

        if (this.step !== 'welcome') {
            this.resetWelcomeDialogAnchor();
        }
        this.attachEventListeners();
    }

    renderWelcomeStep() {
        this.ensureValidAccessMode();
        const hasError = !!this.redeemError;
        const isPreviewMode = this.isPreviewMode();
        const isPreviewDisabled = !this.canUseEmailForFreeAccess;
        const inputPlaceholder = isPreviewMode ? 'Email' : 'Invite Code';
        const inputMaxLength = isPreviewMode ? 254 : 24;
        const inputValue = this.getCurrentAccessValue();
        const showPreviewHint = isPreviewMode && !hasError && this.previewEmail.trim().length > 0;
        const feedbackHtml = hasError
            ? (this.redeemError === FREE_ACCESS_UNAVAILABLE_HINT
                ? FREE_ACCESS_UNAVAILABLE_HINT_HTML
                : this.escapeHtml(this.redeemError))
            : (showPreviewHint ? FREE_ACCESS_EMAIL_HINT_HTML : '');
        const feedbackClass = hasError ? 'text-red-500' : 'text-muted-foreground';

        return `
            <div id="welcome-theme-toggle" class="theme-toggle-container" role="radiogroup" aria-label="Theme selection" data-theme="${themeManager.getPreference()}" style="position:fixed;top:12px;right:12px;z-index:9999">
                <div class="theme-toggle-indicator"></div>
                <button type="button" class="theme-toggle-btn" data-theme-option="light" aria-checked="${themeManager.getPreference() === 'light'}" title="Light">
                    <svg class="w-[18px] h-[18px]" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5">
                        <path stroke-linecap="round" stroke-linejoin="round" d="M12 3v1.5m0 15V21m9-9h-1.5M4.5 12H3m15.364-6.364-1.06 1.06M6.697 17.303l-1.06 1.06m0-12.728 1.06 1.06m9.607 9.607 1.06 1.06M12 8.25a3.75 3.75 0 1 1 0 7.5 3.75 3.75 0 0 1 0-7.5z"></path>
                    </svg>
                </button>
                <button type="button" class="theme-toggle-btn" data-theme-option="dark" aria-checked="${themeManager.getPreference() === 'dark'}" title="Dark">
                    <svg class="w-[18px] h-[18px]" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5">
                        <path stroke-linecap="round" stroke-linejoin="round" d="M21 12.79A9 9 0 0 1 11.21 3 7.5 7.5 0 1 0 21 12.79z"></path>
                    </svg>
                </button>
                <button type="button" class="theme-toggle-btn" data-theme-option="system" aria-checked="${themeManager.getPreference() === 'system'}" title="System">
                    <svg class="w-[18px] h-[18px]" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5">
                        <path stroke-linecap="round" stroke-linejoin="round" d="M9 17v2h6v-2m2 0h.75A2.25 2.25 0 0 0 20 14.75V7.25A2.25 2.25 0 0 0 17.75 5H6.25A2.25 2.25 0 0 0 4 7.25v7.5A2.25 2.25 0 0 0 6.25 17H7.5"></path>
                    </svg>
                </button>
            </div>
            <div role="dialog" aria-modal="true" class="${MODAL_CLASSES}" style="padding:28px 28px 20px">
                <style>
                    /* Entrance animation matching app's subtle motion language */
                    @keyframes welcomeModalIn {
                        from { opacity: 0; transform: scale(0.97) translateY(6px); }
                        to { opacity: 1; transform: scale(1) translateY(0); }
                    }
                    .welcome-modal-enter {
                        animation: welcomeModalIn 0.2s ease-out;
                    }
                    .welcome-modal-glass {
                        background: hsl(var(--color-background) / 0.72);
                        backdrop-filter: blur(20px) saturate(1.2);
                        -webkit-backdrop-filter: blur(20px) saturate(1.2);
                    }
                    #welcome-panel {
                        background: rgba(0,0,0,0.35) !important;
                        backdrop-filter: blur(4px) !important;
                        -webkit-backdrop-filter: blur(4px) !important;
                    }
                    /* Noise texture for frosted glass tactility */
                    .invite-input-glass,
                    .welcome-btn-glass,
                    .welcome-btn-blue-glass {
                        position: relative;
                        overflow: hidden;
                    }
                    .invite-input-glass::after,
                    .welcome-btn-glass::after,
                    .welcome-btn-blue-glass::after {
                        content: "";
                        position: absolute;
                        inset: 0;
                        border-radius: inherit;
                        opacity: 0.035;
                        pointer-events: none;
                        background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.8' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E");
                    }
                    .invite-input-glass {
                        background: hsl(var(--color-background) / 0.45);
                        border: 1px solid rgba(255,255,255,0.2) !important;
                    }
                    .welcome-btn-glass {
                        background: hsl(var(--color-background) / 0.45) !important;
                        border: 1px solid rgba(255,255,255,0.2) !important;
                    }
                    .welcome-btn-glass:hover {
                        background: hsl(var(--color-background) / 0.6) !important;
                    }
                    .welcome-btn-blue-glass {
                        background: hsl(var(--blue-600));
                        border: 1px solid rgba(255,255,255,0.12);
                    }
                    .welcome-btn-blue-glass:hover {
                        background: hsl(var(--blue-700));
                    }
                    .dark .invite-input-glass {
                        background: rgba(255,255,255,0.07);
                        border-color: rgba(255,255,255,0.08) !important;
                    }
                    .dark .welcome-btn-glass {
                        background: rgba(255,255,255,0.07) !important;
                        border-color: rgba(255,255,255,0.08) !important;
                    }
                    .dark .welcome-btn-glass:hover {
                        background: rgba(255,255,255,0.12) !important;
                    }
                    .invite-input-wrapper {
                        border-color: hsl(var(--color-border));
                    }
                    .invite-input-wrapper:focus-within {
                        border-color: hsl(var(--color-muted-foreground));
                    }
                    .invite-input-wrapper.input-error {
                        border-color: #ef4444;
                    }
                    .invite-input-wrapper.input-error:focus-within {
                        border-color: #ef4444;
                    }
                    .welcome-guarantees {
                        display: grid;
                        grid-template-columns: 28px 1fr;
                        column-gap: 10px;
                        row-gap: 14px;
                        grid-auto-rows: auto;
                    }
                    .welcome-icon-box {
                        width: 28px;
                        height: 28px;
                        border-radius: 6px;
                        border: 1px solid hsl(var(--color-border));
                        background: hsl(var(--color-muted) / 0.4);
                        color: hsl(var(--color-muted-foreground));
                        display: flex;
                        align-items: center;
                        justify-content: center;
                    }
                    :root:not(.dark) .welcome-icon-box {
                        color: hsl(215 16% 36%);
                        border-color: hsl(214 20% 84%);
                        background: hsl(214 20% 96% / 0.5);
                    }
                    .welcome-guarantee-title {
                        font-size: 12px;
                        line-height: 1.2;
                    }
                    .welcome-guarantee-body {
                        font-size: 11px;
                        line-height: 1.25;
                        margin-top: 2px;
                    }
                    :root:not(.dark) .welcome-guarantee-body {
                        color: hsl(215 16% 38%) !important;
                    }
                    :root:not(.dark) .welcome-modal-glass .text-muted-foreground {
                        color: hsl(215 16% 38%) !important;
                    }
                    .welcome-link {
                        text-decoration: underline transparent;
                        text-underline-offset: 2px;
                        transition: text-decoration-color 0.15s, color 0.15s;
                    }
                    .welcome-link:hover {
                        text-decoration-color: hsl(var(--color-foreground) / 0.5);
                    }
                    .encryption-mode-btn:disabled {
                        opacity: 0.45;
                        cursor: not-allowed;
                    }
                </style>

                <!-- Header -->
                <div class="relative flex items-center mb-1">
                    <h2 class="text-lg font-semibold text-foreground">Welcome to oa-fastchat!</h2>
                    ${this.allowManualClose ? `
                    <button id="close-welcome-btn" class="text-muted-foreground hover:text-foreground transition-colors p-1 rounded-lg hover:bg-accent" style="position:absolute;top:-10px;right:-8px" aria-label="Close">
                        <svg class="w-4 h-4" width="16" height="16" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5">
                            <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"></path>
                        </svg>
                    </button>
                    ` : ''}
                </div>

                <p class="text-sm text-muted-foreground mb-4">A simple, fast, <a href="https://github.com/openanonymity/oa-fastchat" target="_blank" rel="noopener noreferrer" class="text-foreground welcome-link">open-source</a>, and <a href="https://openanonymity.ai/blog/unlinkable-inference/" target="_blank" rel="noopener noreferrer" class="text-foreground welcome-link">provably unlinkable</a> chat client by <a href="https://openanonymity.ai/" target="_blank" rel="noopener noreferrer" class="text-foreground welcome-link">The Open Anonymity Project</a>.</p>

                <!-- Guarantees -->
                <div class="welcome-guarantees" style="margin-top:6px;margin-bottom:22px">
                        <!-- --------------------Unlinkable Inference via Blind Signatures-------------------- -->
                        <div class="welcome-icon-box">
                            <svg class="w-3.5 h-3.5" width="14" height="14" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.8">
                                <path stroke-linecap="round" stroke-linejoin="round" d="m18.84 12.25 1.72-1.71a5.004 5.004 0 0 0-.12-7.07 5.006 5.006 0 0 0-6.95 0l-1.72 1.71" />
                                <path stroke-linecap="round" stroke-linejoin="round" d="m5.17 11.75-1.71 1.71a5.004 5.004 0 0 0 .12 7.07 5.006 5.006 0 0 0 6.95 0l1.71-1.71" />
                                <path stroke-linecap="round" stroke-linejoin="round" d="M8 2v3M2 8h3M16 22v-3M22 16h-3" />
                            </svg>
                        </div>
                        <div>
                            <p class="welcome-guarantee-title font-medium text-foreground">Unlinkable Chats with Frontier Models</p>
                            <p class="welcome-guarantee-body text-muted-foreground">Every session uses <a href="https://en.wikipedia.org/wiki/Blind_signature" target="_blank" rel="noopener noreferrer" class="text-foreground welcome-link">blind signatures</a> to request a distinct ephemeral key, so sessions are unlinkable. <a href="https://openanonymity.ai/blog/unlinkable-inference/#2-secure-inference-proxies" target="_blank" rel="noopener noreferrer" class="text-foreground welcome-link">Secure inference proxies</a> ensure we have no access to your prompts or responses.</p>
                        </div>
                        <!-- --------------------Query sanitization-------------------- -->
                        <div class="welcome-icon-box">
                            <svg class="w-3.5 h-3.5" width="14" height="14" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.8">
                                <path stroke-linecap="round" stroke-linejoin="round" d="m7 21-4.3-4.3c-1-1-1-2.5 0-3.4l9.9-9.9c.9-.9 2.5-.9 3.4 0l2.6 2.6c1 1 1 2.5 0 3.4L8.4 20.6c-1 1-2.5 1-3.4 0Z" />
                                <path stroke-linecap="round" stroke-linejoin="round" d="M5.7 10.3 12 16.65" />
                                <path stroke-linecap="round" stroke-linejoin="round" d="M22 21H7" />
                            </svg>
                        </div>
                        <div>
                            <p class="welcome-guarantee-title font-medium text-foreground">Sanitize Prompts via Confidential Models</p>
                            <p class="welcome-guarantee-body text-muted-foreground">Built-in PII removal and prompt re-writing by gpt-oss-120b on an <a href="https://www.nvidia.com/en-us/data-center/solutions/confidential-computing/" target="_blank" rel="noopener noreferrer" class="text-foreground welcome-link">GPU enclave</a>. Try it with tab-tab!</p>
                        </div>
                        <!-- --------------------Local data storage-------------------- -->
                        <div class="welcome-icon-box">
                            <svg class="w-3.5 h-3.5" width="14" height="14" fill="none" stroke="currentColor" viewBox="0 -1.875 24 24" stroke-width="1.8">
                                <path stroke-linecap="round" stroke-linejoin="round" d="M12 6.75c3.314 0 6-1.007 6-2.25S15.314 2.25 12 2.25 6 3.257 6 4.5s2.686 2.25 6 2.25z" />
                                <path stroke-linecap="round" stroke-linejoin="round" d="M6 4.5v3.75c0 1.243 2.686 2.25 6 2.25s6-1.007 6-2.25V4.5" />
                                <path stroke-linecap="round" stroke-linejoin="round" d="M6 8.25V12c0 1.243 2.686 2.25 6 2.25s6-1.007 6-2.25V8.25" />
                                <path stroke-linecap="round" stroke-linejoin="round" d="M6 12v3.75c0 1.243 2.686 2.25 6 2.25s6-1.007 6-2.25V12" />
                            </svg>
                        </div>
                        <div>
                            <p class="welcome-guarantee-title font-medium text-foreground">The Entire App is Local</p>
                            <p class="welcome-guarantee-body text-muted-foreground">All data and features are stored (IndexedDB) and implemented (JS) locally in browser. This makes it very fast!</p>
                        </div>
                        <!-- --------------------Encrypted sync-------------------- -->
                        <div class="welcome-icon-box">
                            <svg class="w-3.5 h-3.5" width="14" height="14" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.8">
                                <path stroke-linecap="round" stroke-linejoin="round" d="M16.5 10.5V6.75a4.5 4.5 0 10-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 002.25-2.25v-6.75a2.25 2.25 0 00-2.25-2.25H6.75a2.25 2.25 0 00-2.25 2.25v6.75a2.25 2.25 0 002.25 2.25z" />
                            </svg>
                        </div>
                        <div>
                            <p class="welcome-guarantee-title font-medium text-foreground">Encrypted Sync with Passkeys</p>
                            <p class="welcome-guarantee-body text-muted-foreground">You can optionally create an account to encrypted-sync your local data with Passkeys (e.g., with Apple touch ID).</p>
                        </div>
                </div>

                <div class="mb-2 flex justify-start">
                    <div id="welcome-access-mode-toggle" class="encryption-mode-toggle" role="radiogroup" aria-label="Welcome access mode">
                        <button
                            type="button"
                            class="encryption-mode-btn ${isPreviewMode ? 'active' : ''}"
                            data-access-mode="preview"
                            ${isPreviewDisabled ? 'disabled' : ''}
                        >Limited Preview</button>
                        <button
                            type="button"
                            class="encryption-mode-btn ${!isPreviewMode ? 'active' : ''}"
                            data-access-mode="beta"
                        >Beta Access</button>
                        <div class="encryption-mode-indicator"></div>
                    </div>
                </div>

                <form id="invite-form" class="w-full">
                    <div class="invite-input-wrapper invite-input-glass flex items-center w-full h-10 border rounded-lg transition-all ${hasError ? 'input-error' : ''}">
                        <input
                            id="invite-code-input"
                            type="text"
                            maxlength="${inputMaxLength}"
                            placeholder="${inputPlaceholder}"
                            class="flex-1 h-full px-3 text-sm bg-transparent text-foreground placeholder:text-muted-foreground/50 focus:outline-none"
                            value="${this.escapeHtml(inputValue)}"
                            autocomplete="off"
                            autocorrect="off"
                            autocapitalize="off"
                            spellcheck="false"
                        />
                        <button
                            type="submit"
                            class="flex-shrink-0 w-8 h-8 m-1 rounded-md bg-blue-600 text-white hover:bg-blue-700 transition-colors flex items-center justify-center disabled:opacity-50"
                            aria-label="${isPreviewMode ? 'Request limited preview' : 'Redeem invite code'}"
                        >
                            <svg class="w-4 h-4" width="16" height="16" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
                                <path stroke-linecap="round" stroke-linejoin="round" d="M13.5 4.5L21 12m0 0l-7.5 7.5M21 12H3" />
                            </svg>
                        </button>
                    </div>
                    <p id="invite-feedback-text" class="text-xs leading-4 mt-1.5 ${feedbackClass} ${feedbackHtml ? '' : 'hidden'}">${feedbackHtml}</p>
                </form>

                <!-- Divider -->
                <div class="flex items-center gap-3" style="margin-top:10px;margin-bottom:10px">
                    <div class="flex-1 h-px bg-border"></div>
                    <span class="text-xs text-muted-foreground">or</span>
                    <div class="flex-1 h-px bg-border"></div>
                </div>

                <!-- Action buttons -->
                <div class="flex items-stretch gap-2">
                    <a
                        href="https://openanonymity.ai/beta"
                        target="_blank"
                        rel="noopener noreferrer"
                        class="welcome-btn-glass btn-ghost-hover flex-1 h-10 px-3 rounded-lg text-sm border border-border text-foreground shadow-sm transition-colors flex items-center justify-center gap-1.5"
                    >
                        <svg class="w-4 h-4 flex-shrink-0" width="16" height="16" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
                            <path stroke-linecap="round" stroke-linejoin="round" d="M13.5 6H5.25A2.25 2.25 0 003 8.25v10.5A2.25 2.25 0 005.25 21h10.5A2.25 2.25 0 0018 18.75V10.5m-10.5 6L21 3m0 0h-5.25M21 3v5.25"></path>
                        </svg>
                        <span>Request beta access</span>
                    </a>
                    <button
                        id="import-data-btn"
                        class="welcome-btn-blue-glass flex-1 h-10 px-3 rounded-lg text-sm text-white transition-colors flex items-center justify-center gap-1.5"
                    >
                        <svg class="w-4 h-4 flex-shrink-0" width="16" height="16" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
                            <path stroke-linecap="round" stroke-linejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                        </svg>
                        <span>Alpha user import</span>
                    </button>
                </div>

                <!-- Footer -->
                ${ticketClient.getTicketCount() > 0 ? `
                <div class="flex items-center justify-center" style="margin-top:10px">
                    <label class="flex items-center gap-2 cursor-pointer select-none">
                        <input
                            type="checkbox"
                            id="dont-show-again"
                            class="w-4 h-4 rounded border-border text-blue-600 focus:ring-blue-500/20"
                            ${this.dontShowAgain ? 'checked' : ''}
                        />
                        <span class="text-xs text-muted-foreground">Don't show this again</span>
                    </label>
                </div>` : ''}
                <div class="flex items-center justify-between" style="margin-top:${ticketClient.getTicketCount() > 0 ? '6' : '22'}px">
                    <a
                        href="https://openanonymity.ai/blog/unlinkable-inference/"
                        target="_blank"
                        rel="noopener noreferrer"
                        class="text-xs text-muted-foreground hover:text-foreground hover:underline transition-colors"
                    >
                        Technical Details
                    </a>
                    <a
                        href="https://openanonymity.ai/beta#desktop"
                        target="_blank"
                        rel="noopener noreferrer"
                        class="text-xs text-muted-foreground hover:text-foreground hover:underline transition-colors"
                    >
                        Download Desktop App
                    </a>
                    <a
                        href="https://openanonymity.ai/beta/privacy"
                        target="_blank"
                        rel="noopener noreferrer"
                        class="text-xs text-muted-foreground hover:text-foreground hover:underline transition-colors"
                    >
                        Privacy Notice
                    </a>
                </div>
            </div>
        `;
    }

    renderRedeemingStep() {
        const progress = this.redeemProgress || { message: 'Processing...', percent: 0 };

        return `
            <div role="dialog" aria-modal="true" class="${MODAL_CLASSES}" style="padding:28px">
                <div class="flex flex-col items-center justify-center py-8">
                    <!-- Spinner -->
                    <div class="w-12 h-12 border-2 border-blue-600 border-t-transparent rounded-full animate-spin mb-4"></div>

                    <!-- Progress message -->
                    <p class="text-sm font-medium text-foreground mb-2">${this.escapeHtml(progress.message)}</p>

                    <!-- Progress bar -->
                    <div class="w-full max-w-xs h-2 bg-muted rounded-full overflow-hidden">
                        <div
                            class="h-full bg-blue-600 transition-all duration-300 ease-out"
                            style="width: ${progress.percent}%"
                        ></div>
                    </div>
                    <p class="text-xs text-muted-foreground mt-2">${progress.percent}% complete</p>
                </div>
            </div>
        `;
    }

    renderSuccessStep() {
        return `
            <div role="dialog" aria-modal="true" class="${MODAL_CLASSES} welcome-modal-glass welcome-success-surface" style="padding:28px 28px 20px">
                <style>
                    .welcome-success-surface {
                        background: hsl(var(--color-background) / 0.72);
                        backdrop-filter: blur(20px) saturate(1.2);
                        -webkit-backdrop-filter: blur(20px) saturate(1.2);
                    }
                    .success-tick {
                        width: 22px; height: 22px;
                        border-radius: 50%;
                        background: hsl(152 60% 48%);
                        display: inline-flex; align-items: center; justify-content: center;
                        flex-shrink: 0;
                    }
                    .dark .success-tick { background: hsl(152 50% 40%); }
                </style>

                <!-- Header -->
                <div class="flex items-center gap-2" style="margin-bottom:10px">
                    <div class="success-tick">
                        <svg class="w-3 h-3 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="3">
                            <path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"></path>
                        </svg>
                    </div>
                    <h2 class="text-lg font-semibold text-foreground">You're all set!</h2>
                </div>

                <p class="text-sm text-muted-foreground" style="margin-bottom:14px">
                    ${this.ticketsRedeemed} ticket${this.ticketsRedeemed !== 1 ? 's' : ''} added. Tickets authenticate chat sessions, and costs vary by model tier (see model picker).
                </p>

                <!-- Action buttons -->
                <div class="flex items-stretch gap-3">
                    <button
                        id="create-account-btn"
                        class="btn-ghost-hover flex-1 h-9 rounded-lg text-sm border border-border bg-background text-foreground shadow-sm transition-colors flex items-center justify-center gap-1.5"
                    >
                        <svg class="w-3.5 h-3.5 opacity-60" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5">
                            <path stroke-linecap="round" stroke-linejoin="round" d="M16.5 10.5V6.75a4.5 4.5 0 10-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 002.25-2.25v-6.75a2.25 2.25 0 00-2.25-2.25H6.75a2.25 2.25 0 00-2.25 2.25v6.75a2.25 2.25 0 002.25 2.25z" />
                        </svg>
                        Create Account
                    </button>
                    <button
                        id="start-chatting-btn"
                        class="flex-1 h-9 rounded-lg text-sm font-medium bg-blue-600 text-white hover:bg-blue-700 shadow-sm transition-colors flex items-center justify-center gap-1.5"
                    >
                        Start Chatting
                        <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
                            <path stroke-linecap="round" stroke-linejoin="round" d="M13.5 4.5L21 12m0 0l-7.5 7.5M21 12H3" />
                        </svg>
                    </button>
                </div>
                <p class="text-muted-foreground" style="margin-top:16px;font-size:11px;line-height:1.3">
                    Account is optional and enables encrypted-sync of your data (tickets, preferences, and soon chat sessions) with Passkeys.
                </p>
            </div>
        `;
    }

    // =========================================================================
    // Event Listeners
    // =========================================================================

    attachEventListeners() {
        // Theme toggle (3-way segmented control)
        const welcomeThemeToggle = document.getElementById('welcome-theme-toggle');
        if (welcomeThemeToggle) {
            welcomeThemeToggle.onclick = (e) => {
                const btn = e.target.closest('.theme-toggle-btn');
                if (!btn) return;
                const preference = btn.dataset.themeOption;
                if (preference) {
                    themeManager.setPreference(preference);
                    this.updateWelcomeThemeToggle(preference);
                }
            };
        }

        // Subscribe to cross-component theme changes (e.g. settings menu)
        this.themeUnsubscribe?.();
        this.themeUnsubscribe = themeManager.onChange((preference) => {
            this.updateWelcomeThemeToggle(preference);
        });

        const closeBtn = document.getElementById('close-welcome-btn');
        if (closeBtn) closeBtn.onclick = () => this.handleCloseAttempt();

        const accessModeToggle = document.getElementById('welcome-access-mode-toggle');
        if (accessModeToggle) {
            const modeButtons = accessModeToggle.querySelectorAll('.encryption-mode-btn[data-access-mode]');
            const modeIndicator = accessModeToggle.querySelector('.encryption-mode-indicator');

            const updateModeIndicator = (activeBtn) => {
                if (!modeIndicator || !activeBtn) return;
                const containerRect = accessModeToggle.getBoundingClientRect();
                const btnRect = activeBtn.getBoundingClientRect();
                modeIndicator.style.width = `${btnRect.width}px`;
                modeIndicator.style.transform = `translateX(${btnRect.left - containerRect.left - 2}px)`;
            };

            modeButtons.forEach((btn) => {
                btn.onclick = () => {
                    const mode = btn.dataset.accessMode;
                    if (!mode || btn.disabled || mode === this.accessMode) return;
                    this.accessMode = mode;
                    this.redeemError = null;
                    this.render();
                };
            });

            const activeModeButton = accessModeToggle.querySelector('.encryption-mode-btn.active');
            if (activeModeButton && modeIndicator) {
                requestAnimationFrame(() => {
                    modeIndicator.style.transition = 'none';
                    updateModeIndicator(activeModeButton);
                    requestAnimationFrame(() => {
                        modeIndicator.style.transition = '';
                    });
                });
            }
        }

        const inviteForm = document.getElementById('invite-form');
        if (inviteForm) {
            inviteForm.onsubmit = (e) => this.handleInviteSubmit(e);
        }

        const inviteInput = document.getElementById('invite-code-input');
        if (inviteInput) {
            inviteInput.oninput = (e) => {
                this.setCurrentAccessValue(e.target.value);
                // Clear error when user starts typing
                if (this.redeemError) {
                    this.redeemError = null;
                    const wrapper = inviteInput.closest('.invite-input-wrapper');
                    if (wrapper) wrapper.classList.remove('input-error');
                    this.updateInlineInviteFeedback();
                    return;
                }

                this.updateInlineInviteFeedback();
            };
            // Focus the input when on welcome step
            if (this.step === 'welcome') {
                setTimeout(() => inviteInput.focus(), 100);
            }
        }

        const dontShowAgainCheckbox = document.getElementById('dont-show-again');
        if (dontShowAgainCheckbox) {
            dontShowAgainCheckbox.onchange = (e) => this.handleDontShowAgainChange(e.target.checked);
        }

        const importDataBtn = document.getElementById('import-data-btn');
        if (importDataBtn) {
            importDataBtn.onclick = () => this.handleImportData();
        }

        const createAccountBtn = document.getElementById('create-account-btn');
        if (createAccountBtn) {
            createAccountBtn.onclick = () => this.handleCreateAccount();
        }

        const startChattingBtn = document.getElementById('start-chatting-btn');
        if (startChattingBtn) {
            startChattingBtn.onclick = () => this.handleStartChatting();
        }
    }

    updateWelcomeThemeToggle(preference) {
        const container = document.getElementById('welcome-theme-toggle');
        if (!container) return;

        container.dataset.theme = preference;

        container.querySelectorAll('.theme-toggle-btn').forEach((btn) => {
            btn.setAttribute('aria-checked', String(btn.dataset.themeOption === preference));
        });
    }

    destroy() {
        this.themeUnsubscribe?.();
        this.themeUnsubscribe = null;
        if (this.ticketsUpdatedHandler) {
            window.removeEventListener('tickets-updated', this.ticketsUpdatedHandler);
            this.ticketsUpdatedHandler = null;
        }
        if (this.escapeHandler) {
            document.removeEventListener('keydown', this.escapeHandler);
            this.escapeHandler = null;
        }
    }
}

export default WelcomePanel;
