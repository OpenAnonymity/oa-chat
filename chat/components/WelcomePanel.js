/**
 * Welcome Panel Component
 * First-run welcome modal for new users, invitation code redemption, and account creation prompt.
 */

import ticketClient from '../services/ticketClient.js';

const STORAGE_KEY_DISMISSED = 'oa-welcome-dismissed';
const MODAL_CLASSES = 'w-full max-w-md rounded-2xl border border-border bg-background shadow-2xl p-6 mx-4 flex flex-col';

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
        this.close();
    }

    close() {
        if (!this.isOpen || !this.overlay) return;
        this.isOpen = false;

        // Save dismissal preference if checked
        if (this.dontShowAgain) {
            localStorage.setItem(STORAGE_KEY_DISMISSED, 'true');
        }

        this.overlay.classList.add('hidden');
        this.overlay.innerHTML = '';

        if (this.escapeHandler) {
            document.removeEventListener('keydown', this.escapeHandler);
            this.escapeHandler = null;
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
            <div role="dialog" aria-modal="true" class="${MODAL_CLASSES}">
                <!-- Header with logo -->
                <div class="flex items-center justify-between mb-2">
                    <div class="flex items-center gap-3">
                        <div class="w-10 h-10 rounded-xl bg-gradient-to-br from-blue-500/10 to-purple-500/10 flex items-center justify-center">
                            <svg class="w-5 h-5 text-blue-600 dark:text-blue-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                                <path stroke-linecap="round" stroke-linejoin="round" d="M9 12.75L11.25 15 15 9.75m-3-7.036A11.959 11.959 0 013.598 6 11.99 11.99 0 003 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285z" />
                            </svg>
                        </div>
                        <div>
                            <h2 class="text-lg font-semibold text-foreground">Welcome to Open Anonymity</h2>
                        </div>
                    </div>
                    <button id="close-welcome-btn" class="text-muted-foreground hover:text-foreground transition-colors p-1 -mr-1 rounded-lg hover:bg-accent" aria-label="Close">
                        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5">
                            <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"></path>
                        </svg>
                    </button>
                </div>

                <p class="text-sm text-muted-foreground mb-5">Private, anonymous AI chat with no accounts, no tracking, and end-to-end encryption.</p>

                <!-- Invitation code form - compact design with embedded button -->
                <style>
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
                </style>
                <form id="invite-form" class="w-full">
                    <div class="invite-input-wrapper flex items-center w-full h-10 border rounded-lg bg-background transition-all ${hasError ? 'input-error' : ''}">
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
                <div class="flex items-center gap-3 my-4">
                    <div class="flex-1 h-px bg-border"></div>
                    <span class="text-xs text-muted-foreground">or</span>
                    <div class="flex-1 h-px bg-border"></div>
                </div>

                <!-- Link to homepage -->
                <a
                    href="https://openanonymity.ai/"
                    target="_blank"
                    rel="noopener noreferrer"
                    class="btn-ghost-hover w-full h-10 rounded-lg text-sm border border-border bg-background text-foreground shadow-sm transition-colors flex items-center justify-center gap-2"
                >
                    <span>Get an invitation</span>
                    <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
                        <path stroke-linecap="round" stroke-linejoin="round" d="M13.5 6H5.25A2.25 2.25 0 003 8.25v10.5A2.25 2.25 0 005.25 21h10.5A2.25 2.25 0 0018 18.75V10.5m-10.5 6L21 3m0 0h-5.25M21 3v5.25"></path>
                    </svg>
                </a>

                <!-- Footer -->
                <div class="mt-6 flex items-center justify-between">
                    <label class="flex items-center gap-2 cursor-pointer select-none">
                        <input
                            type="checkbox"
                            id="dont-show-again"
                            class="w-4 h-4 rounded border-border text-blue-600 focus:ring-blue-500/20"
                            ${this.dontShowAgain ? 'checked' : ''}
                        />
                        <span class="text-xs text-muted-foreground">Don't show this again</span>
                    </label>
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
            <div role="dialog" aria-modal="true" class="${MODAL_CLASSES}">
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
            <div role="dialog" aria-modal="true" class="${MODAL_CLASSES}">
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
                <button
                    id="start-chatting-btn"
                    class="btn-ghost-hover w-full h-10 rounded-lg text-sm border border-border bg-background text-foreground shadow-sm transition-colors"
                >
                    Start Chatting
                </button>
            </div>
        `;
    }

    // =========================================================================
    // Event Listeners
    // =========================================================================

    attachEventListeners() {
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
