/**
 * Welcome Panel Component
 * First-run welcome modal for new users, invitation code redemption, and account creation prompt.
 */

import ticketClient from '../services/ticketClient.js';
import preferencesStore, { PREF_KEYS } from '../services/preferencesStore.js';

// localStorage key for synchronous pre-hydration check (matches preferencesStore snapshot)
const STORAGE_KEY_DISMISSED = 'oa-welcome-dismissed';
const MODAL_CLASSES = 'w-full max-w-md rounded-2xl border border-border shadow-lg mx-4 flex flex-col welcome-modal-enter welcome-modal-glass';

class WelcomePanel {
    constructor(app) {
        this.app = app;
        this.isOpen = false;
        this.overlay = document.getElementById('welcome-panel');

        // Flow state
        this.step = 'welcome'; // 'welcome' | 'redeeming' | 'success'
        this.invitationCode = '';
        this.isRedeeming = false;
        this.redeemProgress = null;
        this.redeemError = null;
        this.ticketsRedeemed = 0;
        this.dontShowAgain = false;

        // UI state
        this.returnFocusEl = null;
        this.escapeHandler = null;
        this.importCloseHandler = null;
    }

    async init() {
        if (!this.overlay) return;
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

        // Reset state on open
        this.step = 'welcome';
        this.invitationCode = '';
        this.isRedeeming = false;
        this.redeemProgress = null;
        this.redeemError = null;
        this.ticketsRedeemed = 0;

        this.render();
        this.overlay.classList.remove('hidden');

        // Attach close handlers
        this.overlay.onclick = (e) => { if (e.target === this.overlay) this.handleCloseAttempt(); };
        this.escapeHandler = (e) => { if (e.key === 'Escape') this.handleCloseAttempt(); };
        document.addEventListener('keydown', this.escapeHandler);
    }

    handleCloseAttempt() {
        // Don't allow closing during active redemption
        if (this.isRedeeming) return;
        // Don't allow closing without tickets
        if (ticketClient.getTicketCount() === 0) return;
        this.close();
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

    // =========================================================================
    // Flow Handlers
    // =========================================================================

    async handleInviteSubmit(e) {
        if (e) e.preventDefault();

        const code = this.invitationCode.trim();
        if (!code || code.length !== 24) {
            this.redeemError = 'Please enter a valid 24-character invitation code';
            this.render();
            return;
        }

        this.step = 'redeeming';
        this.isRedeeming = true;
        this.redeemError = null;
        this.redeemProgress = { message: 'Starting...', percent: 0 };
        this.render();

        try {
            const result = await ticketClient.alphaRegister(code, (message, percent) => {
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
            this.step = 'welcome';
            this.isRedeeming = false;
            this.redeemError = error.message || 'Failed to redeem invitation code';
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

        this.attachEventListeners();
    }

    renderWelcomeStep() {
        const hasError = !!this.redeemError;

        return `
            <!-- DEBUG: temp theme toggle, remove later -->
            <button id="debug-theme-toggle" style="position:fixed;top:12px;right:12px;z-index:9999;padding:6px 12px;border-radius:8px;font-size:11px;font-weight:500;cursor:pointer;background:rgba(0,0,0,0.5);color:#fff;border:1px solid rgba(255,255,255,0.2);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px)">Toggle theme</button>
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
                    }
                    .welcome-guarantee-title {
                        font-size: 12px;
                        line-height: 1.2;
                    }
                    .welcome-guarantee-body {
                        font-size: 11px;
                        line-height: 1.35;
                    }
                    :root:not(.dark) .welcome-guarantee-body {
                        color: hsl(215 16% 38%) !important;
                    }
                    :root:not(.dark) .welcome-modal-glass .text-muted-foreground {
                        color: hsl(215 16% 38%) !important;
                    }
                </style>

                <!-- Header -->
                <div class="flex items-center justify-between mb-1">
                    <h2 class="text-lg font-semibold text-foreground">Welcome to oa-fastchat!</h2>
                    ${ticketClient.getTicketCount() > 0 ? `
                    <button id="close-welcome-btn" class="text-muted-foreground hover:text-foreground transition-colors p-1 -mr-1 rounded-lg hover:bg-accent" aria-label="Close">
                        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5">
                            <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"></path>
                        </svg>
                    </button>` : ''}
                </div>

                <p class="text-sm text-muted-foreground mb-4">A simple, very fast, <a href="https://github.com/openanonymity/oa-fastchat" target="_blank" rel="noopener noreferrer" class="text-foreground hover:underline hover:underline-offset-2 hover:decoration-foreground/50 transition-colors">open-source</a>, and <a href="https://openanonymity.ai/blog/unlinkable-inference/" target="_blank" rel="noopener noreferrer" class="text-foreground hover:underline hover:underline-offset-2 hover:decoration-foreground/50 transition-colors">provably unlinkable</a> chat client by <a href="https://openanonymity.ai/" target="_blank" rel="noopener noreferrer" class="text-foreground hover:underline hover:underline-offset-2 hover:decoration-foreground/50 transition-colors">The Open Anonymity Project</a>.</p>

                <!-- Guarantees -->
                <div class="welcome-guarantees" style="margin-top:6px;margin-bottom:22px">
                        <!-- --------------------Unlinkable Inference via Blind Signatures-------------------- -->
                        <div class="welcome-icon-box">
                            <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.8">
                                <path stroke-linecap="round" stroke-linejoin="round" d="M15 5v2m0 4v2m0 4v2M5 5a2 2 0 00-2 2v3a2 2 0 110 4v3a2 2 0 002 2h14a2 2 0 002-2v-3a2 2 0 110-4V7a2 2 0 00-2-2H5z" />
                            </svg>
                        </div>
                        <div>
                            <p class="welcome-guarantee-title font-medium text-foreground">Provably Unlinkable Chats with Remote Models</p>
                            <p class="welcome-guarantee-body text-muted-foreground">Every chat requests a proxied, ephemeral key via <a href="https://en.wikipedia.org/wiki/Blind_signature" target="_blank" rel="noopener noreferrer" class="text-foreground hover:underline hover:underline-offset-2 hover:decoration-foreground/50 transition-colors">blind signatures</a></p>
                        </div>
                        <!-- --------------------Query sanitization-------------------- -->
                        <div class="welcome-icon-box">
                            <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.8">
                                <path stroke-linecap="round" stroke-linejoin="round" d="M18.364 18.364L9.879 9.879m0 0L5.636 5.636m4.243 4.243L5.636 13.12m4.243-3.243l3.243-3.243" />
                                <path stroke-linecap="round" stroke-linejoin="round" d="M20.25 7.5l-.625 10.632a2.25 2.25 0 01-2.247 2.118H6.622a2.25 2.25 0 01-2.247-2.118L3.75 7.5" />
                            </svg>
                        </div>
                        <div>
                            <p class="welcome-guarantee-title font-medium text-foreground">Query Sanitization via Confidential Models</p>
                            <p class="welcome-guarantee-body text-muted-foreground">Built-in PII removal and privacy-preserving prompt rewriting by gpt-oss-120b hosted on an <a href="https://www.nvidia.com/en-us/data-center/solutions/confidential-computing/" target="_blank" rel="noopener noreferrer" class="text-foreground hover:underline hover:underline-offset-2 hover:decoration-foreground/50 transition-colors">GPU enclave</a>.</p>
                        </div>
                        <!-- --------------------Local data storage-------------------- -->
                        <div class="welcome-icon-box">
                            <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.8">
                                <path stroke-linecap="round" stroke-linejoin="round" d="M12 6.75c3.314 0 6-1.007 6-2.25S15.314 2.25 12 2.25 6 3.257 6 4.5s2.686 2.25 6 2.25z" />
                                <path stroke-linecap="round" stroke-linejoin="round" d="M6 4.5v3.75c0 1.243 2.686 2.25 6 2.25s6-1.007 6-2.25V4.5" />
                                <path stroke-linecap="round" stroke-linejoin="round" d="M6 8.25V12c0 1.243 2.686 2.25 6 2.25s6-1.007 6-2.25V8.25" />
                                <path stroke-linecap="round" stroke-linejoin="round" d="M6 12v3.75c0 1.243 2.686 2.25 6 2.25s6-1.007 6-2.25V12" />
                            </svg>
                        </div>
                        <div>
                            <p class="welcome-guarantee-title font-medium text-foreground">Local Storage</p>
                            <p class="welcome-guarantee-body text-muted-foreground">All data is stored locally in your browser and exportable in JSON. This also makes the chat client self-contained and extremely fast.</p>
                        </div>
                        <!-- --------------------Encrypted sync-------------------- -->
                        <div class="welcome-icon-box">
                            <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.8">
                                <path stroke-linecap="round" stroke-linejoin="round" d="M16.5 10.5V6.75a4.5 4.5 0 10-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 002.25-2.25v-6.75a2.25 2.25 0 00-2.25-2.25H6.75a2.25 2.25 0 00-2.25 2.25v6.75a2.25 2.25 0 002.25 2.25z" />
                            </svg>
                        </div>
                        <div>
                            <p class="welcome-guarantee-title font-medium text-foreground">Encrypted Sync with Passkeys</p>
                            <p class="welcome-guarantee-body text-muted-foreground">You can optionally encrypt all of your data locally with Passkeys (e.g., using Apple touch ID), and sync across devices.</p>
                        </div>
                </div>

                <!-- Invitation code form -->
                <form id="invite-form" class="w-full">
                    <div class="invite-input-wrapper invite-input-glass flex items-center w-full h-10 border rounded-lg transition-all ${hasError ? 'input-error' : ''}">
                        <input
                            id="invite-code-input"
                            type="text"
                            maxlength="24"
                            placeholder="Invitation code"
                            class="flex-1 h-full px-3 text-sm bg-transparent text-foreground placeholder:text-muted-foreground/50 focus:outline-none"
                            value="${this.escapeHtml(this.invitationCode)}"
                            autocomplete="off"
                            autocorrect="off"
                            autocapitalize="off"
                            spellcheck="false"
                        />
                        <button
                            type="submit"
                            class="flex-shrink-0 w-8 h-8 m-1 rounded-md bg-blue-600 text-white hover:bg-blue-700 transition-colors flex items-center justify-center disabled:opacity-50"
                            aria-label="Redeem invitation"
                        >
                            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
                                <path stroke-linecap="round" stroke-linejoin="round" d="M13.5 4.5L21 12m0 0l-7.5 7.5M21 12H3" />
                            </svg>
                        </button>
                    </div>
                    ${hasError ? `<p class="text-xs text-red-500 mt-1.5">${this.escapeHtml(this.redeemError)}</p>` : ''}
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
                        href="https://openanonymity.ai/"
                        target="_blank"
                        rel="noopener noreferrer"
                        class="welcome-btn-glass btn-ghost-hover flex-1 h-10 px-4 rounded-lg text-sm border border-border text-foreground shadow-sm transition-colors flex items-center justify-center gap-2"
                    >
                        <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
                            <path stroke-linecap="round" stroke-linejoin="round" d="M13.5 6H5.25A2.25 2.25 0 003 8.25v10.5A2.25 2.25 0 005.25 21h10.5A2.25 2.25 0 0018 18.75V10.5m-10.5 6L21 3m0 0h-5.25M21 3v5.25"></path>
                        </svg>
                        <span>Request beta access</span>
                    </a>
                    <button
                        id="import-data-btn"
                        class="welcome-btn-blue-glass flex-1 h-10 px-4 rounded-lg text-sm text-white transition-colors flex items-center justify-center gap-2"
                    >
                        <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
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
                        href="https://openanonymity.ai/terms"
                        target="_blank"
                        rel="noopener noreferrer"
                        class="text-xs text-muted-foreground hover:text-foreground hover:underline transition-colors"
                    >
                        Terms of Service
                    </a>
                    <a
                        href="https://openanonymity.ai/privacy"
                        target="_blank"
                        rel="noopener noreferrer"
                        class="text-xs text-muted-foreground hover:text-foreground hover:underline transition-colors"
                    >
                        Privacy Policy
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
            <div role="dialog" aria-modal="true" class="${MODAL_CLASSES}" style="padding:28px">
                <!-- Success header -->
                <div class="flex flex-col items-center justify-center pt-4 pb-6">
                    <div class="w-14 h-14 bg-emerald-100 dark:bg-emerald-500/20 rounded-full flex items-center justify-center mb-4">
                        <svg class="w-7 h-7 text-emerald-600 dark:text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2.5">
                            <path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"></path>
                        </svg>
                    </div>
                    <h2 class="text-lg font-semibold text-foreground mb-1">You're all set!</h2>
                    <p class="text-sm text-muted-foreground">
                        ${this.ticketsRedeemed} ticket${this.ticketsRedeemed !== 1 ? 's' : ''} added to your wallet
                    </p>
                </div>

                <!-- Account creation prompt -->
                <div class="rounded-xl border border-border bg-muted/30 p-4 mb-4">
                    <div class="flex items-start gap-3">
                        <div class="w-8 h-8 rounded-lg bg-blue-500/10 flex items-center justify-center flex-shrink-0 mt-0.5">
                            <svg class="w-4 h-4 text-blue-600 dark:text-blue-400" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5">
                                <path stroke-linecap="round" stroke-linejoin="round" d="M16.5 10.5V6.75a4.5 4.5 0 10-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 002.25-2.25v-6.75a2.25 2.25 0 00-2.25-2.25H6.75a2.25 2.25 0 00-2.25 2.25v6.75a2.25 2.25 0 002.25 2.25z" />
                            </svg>
                        </div>
                        <div class="flex-1 min-w-0">
                            <h3 class="text-sm font-medium text-foreground mb-1">Create an Account (Optional)</h3>
                            <p class="text-xs text-muted-foreground mb-3">Sync your tickets across devices with encrypted backup. No email or personal info required.</p>
                            <button
                                id="create-account-btn"
                                class="h-8 px-4 rounded-lg text-xs font-medium bg-blue-600 text-white hover:bg-blue-700 transition-colors"
                            >
                                Create Account
                            </button>
                        </div>
                    </div>
                </div>

                <!-- Start chatting button -->
                <div class="flex justify-center">
                    <button
                        id="start-chatting-btn"
                        class="btn-ghost-hover h-10 px-6 rounded-lg text-sm border border-border bg-background text-foreground shadow-sm transition-colors"
                    >
                        Start Chatting
                    </button>
                </div>
            </div>
        `;
    }

    // =========================================================================
    // Event Listeners
    // =========================================================================

    attachEventListeners() {
        // DEBUG: temp theme toggle, remove later
        const debugToggle = document.getElementById('debug-theme-toggle');
        if (debugToggle) debugToggle.onclick = () => document.documentElement.classList.toggle('dark');

        const closeBtn = document.getElementById('close-welcome-btn');
        if (closeBtn) closeBtn.onclick = () => this.handleCloseAttempt();

        const inviteForm = document.getElementById('invite-form');
        if (inviteForm) {
            inviteForm.onsubmit = (e) => this.handleInviteSubmit(e);
        }

        const inviteInput = document.getElementById('invite-code-input');
        if (inviteInput) {
            inviteInput.oninput = (e) => {
                this.invitationCode = e.target.value;
                // Clear error when user starts typing
                if (this.redeemError) {
                    this.redeemError = null;
                    this.render();
                }
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

    destroy() {
        if (this.escapeHandler) {
            document.removeEventListener('keydown', this.escapeHandler);
            this.escapeHandler = null;
        }
    }
}

export default WelcomePanel;
